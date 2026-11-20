import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import type { Device } from "../../contracts/providers";
import type { ComputerProxy, WorkOffline } from "../../contracts/work";
import { pluginComputerProxies } from "../lib/plugin";
import { hostsOriginals, hostsProxies, LIBRARY_WORDS } from "../../contracts/library";
import { actionDone, goOnFor } from "../lib/action-done";
import type { AuthVars } from "../auth";
import { env } from "../lib/env";
import { deviceOf, listDevices, setDeviceWork } from "../lib/devices";
import { libraryDb, libraryUpload } from "../library/db";
import { readerOf } from "../library/reader";
import { assetRef, canSee } from "../library/sources";

/**
 * The proxies a person keeps on their computers (design 6.3, PRD 4.4).
 *
 * Available offline, per person: `$DATA_DIR/offline/<user>.json { versions, collections, libraries }`, a clip's version, a
 * folder, or a whole library (Library settings → Keep on this computer). Each of their computers is sent the list on its
 * claim (offlineFor) and keeps those proxies, never removed by its size limit; it downloads them while nothing else runs
 * (the offline route in routes.ts). Mounted at /api/library/offline:
 *   GET  /   → OfflineList
 *   POST /   { version | collection | library, on } → OfflineList    only what the person can see
 *
 * Settings → Storage counts each computer's cache from its last claim (api/kept.ts) and Empty tells it on the next one.
 */

export interface Downloads {
  mode: "none" | "needed" | "all";
  proxies?: boolean;
  originals?: boolean;
}

export interface OfflineList {
  versions: string[];
  collections: string[];
  libraries?: string[];
  /** Downloads per library (UNIFIED-PRD M13); read through downloadsOf. */
  downloads?: Record<string, Downloads>;
}

const fileOf = (user: string) => path.join(env.dataDir, "offline", `${encodeURIComponent(user)}.json`);

export function offlineOf(user: string): OfflineList {
  try {
    const v = JSON.parse(readFileSync(fileOf(user), "utf8")) as Partial<OfflineList>;
    return {
      versions: Array.isArray(v.versions) ? v.versions : [],
      collections: Array.isArray(v.collections) ? v.collections : [],
      ...(Array.isArray(v.libraries) && v.libraries.length ? { libraries: v.libraries } : {}),
      ...(v.downloads && typeof v.downloads === "object" ? { downloads: v.downloads } : {}),
    };
  } catch {
    return { versions: [], collections: [] };
  }
}

/**
 * A library's downloads for the person (UNIFIED-PRD M13): its stored entry; an old "Keep on this computer" library reads
 * as all with proxies; with no entry, Automatic downloads is on (needed).
 */
export function downloadsOf(list: OfflineList, libraryId: string): Downloads {
  const d = list.downloads?.[libraryId];
  if (d) return d;
  return list.libraries?.includes(libraryId) ? { mode: "all", proxies: true } : { mode: "needed" };
}

/** Whether a computer of `owner` may fetch the server's copies of this library's files (Automatic downloads on). */
export const downloadsAllow = (owner: string, libraryId: string | undefined): boolean => downloadsAllowFor(owner)(libraryId);

/** The same, reading the owner's offline file once for many files (a claim checks every file of every queued step). */
export function downloadsAllowFor(owner: string): (libraryId: string | undefined) => boolean {
  const list = offlineOf(owner);
  return (libraryId) => !!libraryId && downloadsOf(list, libraryId).mode !== "none";
}

function saveOffline(user: string, list: OfflineList): void {
  mkdirSync(path.dirname(fileOf(user)), { recursive: true });
  writeFileSync(fileOf(user), JSON.stringify(list));
}

const db = () => libraryDb();

/** The person may see this clip: they read its library, and its source's policies let them (as the media route checks). */
export async function mayRead(user: string, libraryId: string, assetId: string, versionId: string): Promise<boolean> {
  const viewer = await readerOf(user, libraryId);
  return !!viewer && (await canSee(viewer, assetRef(libraryId, assetId, versionId)));
}

/**
 * The proxies `d` keeps for its owner: the clips set offline and the current clips of the folders set offline, in
 * libraries the owner can still read, that have a proxy and whose file is not already on that computer.
 * ponytail: a folder's own clips, not its subfolders' or a smart folder's query; read on every claim
 */
export async function offlineFor(d: Pick<Device, "id" | "owner">): Promise<WorkOffline[]> {
  const list = offlineOf(d.owner);
  const all = [...new Set([...(list.libraries ?? []), ...Object.keys(list.downloads ?? {})])].filter((id) => downloadsOf(list, id).mode === "all");
  const libraries = all.filter((id) => !!downloadsOf(list, id).proxies);
  // Originals (UNIFIED-PRD §4.1): only in a library that hosts them; a computer gets none of a proxies-only library
  const originals = all.filter((id) => !!downloadsOf(list, id).originals && hostsOriginals(libraryUpload(id)));
  if (!list.versions.length && !list.collections.length && !libraries.length && !originals.length) return [];
  const rows = db()
    .prepare(
      `SELECT v.id, a.id AS asset_id, a.title, a.library_id, p.bytes FROM asset_versions v JOIN assets a ON a.id = v.asset_id
       JOIN derivatives p ON p.version_id = v.id AND p.kind = 'proxy'
       WHERE a.trashed_at IS NULL AND v.mac_device IS NOT ?
         AND NOT EXISTS (SELECT 1 FROM version_places vp WHERE vp.version_id = v.id AND vp.device = ? AND vp.kind = 'original' AND vp.state IN ('verified', 'found'))
         AND (v.id IN (SELECT value FROM json_each(?))
           OR (v.id = a.current_version_id AND (a.library_id IN (SELECT value FROM json_each(?))
             OR a.id IN (SELECT asset_id FROM collection_items WHERE collection_id IN (SELECT value FROM json_each(?))))))`,
    )
    .all(d.id, d.id, JSON.stringify(list.versions), JSON.stringify(libraries), JSON.stringify(list.collections)) as { id: string; asset_id: string; title: string; library_id: string; bytes: number }[];
  const out: WorkOffline[] = [];
  for (const r of rows) if (await mayRead(d.owner, r.library_id, r.asset_id, r.id)) out.push({ id: r.id, title: r.title, bytes: r.bytes });
  if (originals.length) {
    const files = db()
      .prepare(
        `SELECT v.id, a.id AS asset_id, a.title, a.library_id, v.bytes FROM asset_versions v JOIN assets a ON a.id = v.asset_id
         WHERE a.trashed_at IS NULL AND v.id = a.current_version_id AND v.bytes > 0 AND v.mac_path IS NULL AND v.source_key NOT LIKE 'mac:%'
           AND a.library_id IN (SELECT value FROM json_each(?))
           AND NOT EXISTS (SELECT 1 FROM version_places vp WHERE vp.version_id = v.id AND vp.device = ? AND vp.kind = 'original' AND vp.state IN ('verified', 'found'))`,
      )
      .all(JSON.stringify(originals), d.id) as { id: string; asset_id: string; title: string; library_id: string; bytes: number }[];
    for (const r of files) if (await mayRead(d.owner, r.library_id, r.asset_id, r.id)) out.push({ id: r.id, title: r.title, bytes: r.bytes, kind: "original" });
  }
  return out;
}

/** Settings → Storage → Empty: `owner`'s computer (or every one of theirs) empties its proxy cache on its next claim. */
export function emptyProxies(owner: string, device?: string): void {
  for (const d of listDevices((x) => x.owner === owner && (!device || x.id === device) && !!x.work?.cache)) {
    const w = d.work!;
    setDeviceWork(d.id, { ...w, cache: { ...w.cache!, bytes: 0, versions: [] }, empty: true });
  }
}

/**
 * Of the versions `owner`'s computer caches, the ones it must delete: gone, in the trash, or no longer theirs to see (a
 * library policy refused them since it downloaded, say). Asked again on every claim, as the media route would.
 * ponytail: one policy check per cached version per claim; remember the answers per claim window if a cache grows huge
 */
export async function dropFor(owner: string, cached: string[]): Promise<string[]> {
  if (!cached.length) return [];
  const rows = db()
    .prepare(
      `SELECT v.id, a.id AS asset_id, a.library_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id
       WHERE a.trashed_at IS NULL AND v.id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(cached)) as { id: string; asset_id: string; library_id: string }[];
  const keep = new Set<string>();
  for (const r of rows) if (await mayRead(owner, r.library_id, r.asset_id, r.id)) keep.add(r.id);
  return cached.filter((v) => !keep.has(v));
}

/**
 * The claim's answer, read once per claim: Empty (then forgotten), the offline list, sent when there is one or when the
 * computer still keeps one (`kept`, its claim's report), so it lets go of what was switched off, and the cached
 * versions (`cached`) it must delete.
 */
const someAsync = async <T>(xs: T[], f: (x: T) => Promise<boolean>) => {
  for (const x of xs) if (await f(x).catch(() => false)) return true;
  return false;
};

export async function claimExtras(deviceId: string, kept?: string[], cached?: string[]): Promise<{ empty?: true; offline?: WorkOffline[]; drop?: string[]; make?: ComputerProxy[] }> {
  const d = deviceOf(deviceId);
  if (!d) return {};
  const list = await offlineFor(d);
  // a plug-in's own proxies (lib/plugin.ts computerProxies) are no versions here: kept, and the ones it wants made asked for
  const slots = pluginComputerProxies();
  const gone: string[] = [];
  for (const id of await dropFor(d.owner, cached ?? [])) if (!(await someAsync(slots, (s) => s.keeps(d.owner, id)))) gone.push(id);
  const make = (await Promise.all(slots.map((s) => s.make(d).catch(() => [])))).flat().filter((m) => !cached?.includes(m.id));
  const extras = { ...(list.length || kept?.length ? { offline: list } : {}), ...(gone.length ? { drop: gone } : {}), ...(make.length ? { make } : {}) };
  if (!d.work?.empty) return extras;
  const { empty: _, ...work } = d.work;
  setDeviceWork(d.id, work);
  return { empty: true, ...extras };
}

export const offlineApp = new Hono<{ Variables: AuthVars }>();

offlineApp.get("/", (c) => c.json(offlineOf(c.get("user").username)));

/**
 * Library settings → Downloads (M13): the asker's own library entry, written only to their file. Automatic off = none;
 * Automatic on = needed; offline on = all with the kinds the library hosts (a kind it doesn't host is dropped).
 */
offlineApp.put("/downloads", async (c) => {
  const user = c.get("user").username;
  const b = (await c.req.json().catch(() => null)) as { library?: unknown; mode?: unknown; proxies?: unknown; originals?: unknown } | null;
  if (typeof b?.library !== "string" || (b.mode !== "none" && b.mode !== "needed" && b.mode !== "all"))
    return c.json({ error: "library: an id, mode: none, needed or all" }, 400);
  const libId = b.library;
  if (!(await readerOf(user, libId))) return c.json({ error: "Not found", code: "not_found" }, 404);
  const upload = libraryUpload(libId);
  if (b.mode === "all" && !hostsOriginals(upload) && !hostsProxies(upload)) return c.json({ error: "This library keeps its files on your computers; there is no proxy to keep.", code: "no_proxies" }, 409);
  const next: Downloads =
    b.mode === "all"
      ? { mode: "all", proxies: b.proxies === true && hostsProxies(upload), originals: b.originals === true && hostsOriginals(upload) }
      : { mode: b.mode };
  if (next.mode === "all" && !next.proxies && !next.originals) return c.json({ error: "Pick Proxies, Originals or both." }, 400);
  const list = offlineOf(user);
  // the old "Keep on this computer" entry is superseded by this one
  const libraries = list.libraries?.filter((x) => x !== libId);
  const saved: OfflineList = { ...list, downloads: { ...list.downloads, [libId]: next } };
  if (libraries?.length) saved.libraries = libraries;
  else delete saved.libraries;
  saveOffline(user, saved);
  // the chat's Downloads card for this library is answered: it goes, and the edit it stopped on carries on
  if (next.mode !== "none") actionDone(user, (a) => a.kind === "downloads" && a.libraryId === libId, goOnFor(c, LIBRARY_WORDS.downloadsDone));
  return c.json(saved);
});

offlineApp.post("/", async (c) => {
  const user = c.get("user").username;
  const b = (await c.req.json().catch(() => null)) as { version?: unknown; collection?: unknown; library?: unknown; on?: unknown } | null;
  const id = typeof b?.version === "string" ? b.version : typeof b?.collection === "string" ? b.collection : typeof b?.library === "string" ? b.library : null;
  if (!id || typeof b?.on !== "boolean") return c.json({ error: "version, collection or library: an id, on: true or false" }, 400);
  const key = typeof b.version === "string" ? "versions" : typeof b.collection === "string" ? "collections" : "libraries";
  const v = key === "versions" ? (db().prepare("SELECT a.library_id, a.id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(id) as { library_id: string; id: string } | undefined) : undefined;
  const libId = key === "versions" ? v?.library_id : key === "collections" ? (db().prepare("SELECT library_id FROM collections WHERE id = ?").get(id) as { library_id: string } | undefined)?.library_id : id;
  const ok = !!libId && (key === "versions" ? await mayRead(user, libId, v!.id, id) : !!(await readerOf(user, libId)));
  if (!ok) return c.json({ error: "Not found", code: "not_found" }, 404);
  if (key === "libraries" && b.on && !hostsOriginals(libraryUpload(id)) && !hostsProxies(libraryUpload(id)))
    return c.json({ error: "This library keeps its files on your computers; there is no proxy to keep.", code: "no_proxies" }, 409);
  const list = offlineOf(user);
  const next = [...(list[key] ?? []).filter((x) => x !== id), ...(b.on ? [id] : [])];
  const saved = { ...list, [key]: next };
  if (!saved.libraries?.length) delete saved.libraries;
  saveOffline(user, saved);
  return c.json(saved);
});
