import { Hono } from "hono";
import type { AuthVars } from "../auth";
import type { LibrarySource, LibraryViewer } from "../../contracts/library-source";
import { derivedMove, joinRoot, PLACES_MAX, rootKey, type GoneVersion, type PathMove, type PlaceMove, type PlaceOn, type PlacesAnswer, type PlacesReportAnswer, type RootLabel, type VersionPlaces } from "../../contracts/places";
import type { Device } from "../../contracts/providers";
import type { Disk, StorageFolder } from "../../contracts/storage";
import { deviceOf, listDevices } from "../lib/devices";
import { hostPath, rootAt } from "../lib/storage";
import { libraryChanged } from "./access";
import { libraryDb } from "./db";
import { enqueueJob } from "./jobs";
import { needsProxy } from "./media/proxy";
import type { ProbeSummary } from "./media/probe";
import { mergeSamePath } from "./place-rows";
import { readerOf } from "./reader";
import { externalCanSee, externalRefById } from "./refs";
import { assetRef, canSee, sourceById } from "./sources";
import { isId } from "../lib/ids";

/**
 * Here or away (contracts/places.ts): where each computer reads a version's original. The version keeps its root and root
 * path (the same for everybody); version_places keeps each computer's own last word (read there, or gone). The server
 * lists the paths to try on a computer; the computer that reads the disk says what is there (POST …/places).
 */

export const placesApp = new Hono<{ Variables: AuthVars }>();

/** What placesFor needs of a version. */
export interface PlaceVersion {
  root: string | null;
  root_rel: string | null;
  mac_path: string | null;
  mac_device: string | null;
}

/**
 * The paths computer `c` tries for a version, best first: its own place (`own`, not gone), the root path on each of its
 * disks with the version's root (not away), the Settings → Folders translation of the origin path, and the origin path on
 * the origin computer. Empty when it has no way: its root is away or not connected there, or not known.
 */
export function placesFor(v: PlaceVersion, c: { id: string; disks?: Disk[] }, own?: string | null, folders: StorageFolder[] = []): string[] {
  const tries = own ? [own] : [];
  if (v.root && v.root_rel !== null) for (const d of c.disks ?? []) if (!d.away && rootKey(d) === v.root) tries.push(joinRoot(d.path, v.root_rel));
  if (v.mac_path) {
    const there = (v.mac_device && hostPath(v.mac_path, folders, c.id, v.mac_device)) || hostPath(v.mac_path, folders, c.id);
    if (there) tries.push(there);
    if (v.mac_device === c.id) tries.push(v.mac_path);
  }
  return [...new Set(tries)];
}

const disksOf = (device: string): Disk[] => deviceOf(device)?.report?.machine?.disks ?? [];

/** The roots computer `device` has connected now (its last report; a share away is not). */
export const rootsOn = (device: string): string[] => disksOf(device).flatMap((d) => (d.away ? [] : (rootKey(d) ?? [])));

/**
 * Computer `?`'s own place for version `v` (version_places, whereis.ts): the path of its best original row that is not gone
 * (verified, then found, then not checked yet). A row not checked yet is still the path to try: "unknown there", never missing.
 */
export const OWN = `(SELECT op.path FROM version_places op WHERE op.version_id = v.id AND op.device = ? AND op.kind = 'original' AND op.state <> 'gone'
  ORDER BY CASE op.state WHEN 'verified' THEN 0 WHEN 'found' THEN 1 ELSE 2 END, op.checked_at DESC LIMIT 1)`;
/** When computer `?` last found version `v` gone, while it has no other place for it (else null). */
const GONE_AT = `(SELECT max(gp.gone_at) FROM version_places gp WHERE gp.version_id = v.id AND gp.device = ? AND gp.kind = 'original' AND gp.state = 'gone'
  AND NOT EXISTS (SELECT 1 FROM version_places hp WHERE hp.version_id = v.id AND hp.device = gp.device AND hp.kind = 'original' AND hp.state <> 'gone'))`;

/** The versions whose proxy is in computer `device`'s cache: its proxy place rows (kind 'proxy', written from its work claims). */
export const cachedOn = (device: string): string[] =>
  (libraryDb().prepare("SELECT version_id FROM version_places WHERE device = ? AND kind = 'proxy' AND state IN ('verified','found')").all(device) as { version_id: string }[]).map((r) => r.version_id);

/**
 * A work claim's cache list (api/work/routes.ts) as computer `device`'s proxy places: one 'proxy' row per version it holds,
 * the rows of versions it no longer lists removed. Versions the server does not know are skipped.
 */
export function noteProxyCache(device: string, versions: string[], now = Date.now()): void {
  const d = libraryDb();
  const ids = JSON.stringify([...new Set(versions)]);
  d.exec("BEGIN IMMEDIATE");
  try {
    d.prepare("DELETE FROM version_places WHERE device = ? AND kind = 'proxy' AND source = 'work-claim' AND version_id NOT IN (SELECT value FROM json_each(?))").run(device, ids);
    d.prepare(
      `INSERT INTO version_places (version_id, device, kind, folder_id, path, state, source, confirmed_at, checked_at)
       SELECT id, ?, 'proxy', '', '', 'verified', 'work-claim', ?, ? FROM asset_versions WHERE id IN (SELECT value FROM json_each(?))
       ON CONFLICT (version_id, device, kind, folder_id) DO UPDATE SET state = 'verified', checked_at = excluded.checked_at`,
    ).run(device, now, now, ids);
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

/** The paths `host` tries for version row `r` (reach.ts fileFor: its first is where a step reads the file there). */
export function triesOn(r: { id: string; mac_path: string | null; mac_device: string | null }, host: string, folders: StorageFolder[]): string[] {
  const v = libraryDb()
    .prepare(`SELECT v.root, v.root_rel, ${OWN} AS own FROM asset_versions v WHERE v.id = ?`)
    .get(host, r.id) as { root: string | null; root_rel: string | null; own: string | null } | undefined;
  return placesFor({ root: v?.root ?? null, root_rel: v?.root_rel ?? null, mac_path: r.mac_path, mac_device: r.mac_device }, { id: host, disks: disksOf(host) }, v?.own, folders);
}

/** A root as people read it: from a disk that has it (the asker's, then the origin computer's), else from a share's key. */
function labelOf(key: string, ...lists: Disk[][]): RootLabel {
  const d = lists.flat().find((x) => rootKey(x) === key);
  if (d) return { key, name: d.share?.replace(/^\/+|\/+$/g, "") || d.name, ...(d.server ? { server: d.server } : {}) };
  const m = /^[a-z]+:\/\/([^/]+)\/(.+)$/.exec(key);
  return m ? { key, name: m[2]!, server: m[1]! } : { key, name: "Disk" };
}

/** The account's computers' folders (reach.ts foldersOf), loaded when asked: a static import would close a loop (reach → work → library worker → here). */
const foldersOf = async (owner: string): Promise<StorageFolder[]> => (await import("../editor/reach")).foldersOf(owner);

/**
 * The folder states the place rows of `versionIds` point at (whereis.ts whereIsMany's folderStateOf): each row's folder,
 * from its computer's owner's Settings → Folders (StorageFolder.folderState, written from that computer's reports). "ok"
 * and a folder not known read as nothing to say.
 */
export async function folderStatesFor(versionIds: string[]): Promise<(device: string, folder: string) => PlaceOn["folderState"]> {
  const devices = libraryDb()
    .prepare("SELECT DISTINCT device FROM version_places WHERE folder_id <> '' AND version_id IN (SELECT value FROM json_each(?))")
    .all(JSON.stringify(versionIds)) as { device: string }[];
  const owners = [...new Set(devices.flatMap((r) => deviceOf(r.device)?.owner ?? []))];
  const states = new Map<string, PlaceOn["folderState"]>();
  for (const owner of owners) for (const f of await foldersOf(owner)) if (f.folderState && f.folderState !== "ok") states.set(f.id, f.folderState);
  return (_device, folder) => states.get(folder);
}

type Row = PlaceVersion & { id: string; asset_id: string; bytes: number; quick: string | null; own: string | null; gone_at: number | null; gone_path: string | null; title: string };

/** The library's versions among `ids`, out of the trash, each with `device`'s place; only the ones `viewer` may see. */
async function versionsOf(libraryId: string, viewer: LibraryViewer, device: string, ids: string[]): Promise<Row[]> {
  const rows = libraryDb()
    .prepare(
      `SELECT v.id, v.asset_id, v.bytes, v.quick, v.root, v.root_rel, v.mac_path, v.mac_device, a.title, ${OWN} AS own, ${GONE_AT} AS gone_at,
         (SELECT gp.path FROM version_places gp WHERE gp.version_id = v.id AND gp.device = ? AND gp.kind = 'original' AND gp.state = 'gone' ORDER BY gp.gone_at DESC LIMIT 1) AS gone_path
       FROM asset_versions v JOIN assets a ON a.id = v.asset_id
       WHERE a.library_id = ? AND a.trashed_at IS NULL AND v.id IN (SELECT value FROM json_each(?))`,
    )
    .all(device, device, device, libraryId, JSON.stringify(ids)) as unknown as Row[];
  const out: Row[] = [];
  for (const r of rows) if (await canSee(viewer, assetRef(libraryId, r.asset_id, r.id))) out.push(r);
  return out;
}

const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
const dir = (p: string) => p.slice(0, Math.max(0, p.length - base(p).length - 1));
/** The folder change from `a` to `b` (derivedMove); a file that moved at the top, or was renamed, as its own line. */
const moveOf = (a: string, b: string): PathMove => derivedMove(a, b) ?? (base(a) === base(b) ? { from: dir(a), to: dir(b) } : { from: a, to: b });

/**
 * What computer `c` (the caller's) read: each confirmed file becomes its place, and the version learns from it. A file at
 * a path the server did not list for that computer is taken only with a fingerprint equal to the version's; one with
 * another fingerprint is another file. Verified that way: a version with no root gets the one the file is on, and a file
 * at a new root path on its own root moved there for everybody (a move, logged). Otherwise a copy found on another disk
 * is that computer's alone (logged as found). Only the library's owner moves a clip for everybody (changing what is
 * there stays with libraryRole, access.ts): a member's verified move is that member's own place, logged as found. The
 * origin computer's place is the version's mac_path too.
 */
export async function confirmPlaces(
  libraryId: string,
  viewer: LibraryViewer,
  c: Pick<Device, "id" | "owner"> & { disks?: Disk[] },
  confirmed: { versionId: string; path: string; quick?: string }[],
  gone: string[] = [],
  now = Date.now(),
): Promise<PlacesReportAnswer> {
  const d = libraryDb();
  const disks = c.disks ?? disksOf(c.id);
  const folders = confirmed.length || gone.length ? await foldersOf(c.owner) : [];
  const rows = new Map((await versionsOf(libraryId, viewer, c.id, [...confirmed.map((x) => x.versionId), ...gone])).map((r) => [r.id, r]));
  const answer: PlacesReportAnswer = { confirmed: [], refused: [] };
  const moves = new Map<string, Omit<PlaceMove, "at"> & { device: string }>();
  const log = (kind: PlaceMove["kind"], m: PathMove, root: RootLabel, device: string) => {
    const k = JSON.stringify([kind, device, root.key, m.from, m.to]);
    const had = moves.get(k);
    moves.set(k, { kind, ...m, root, device, count: (had?.count ?? 0) + 1 });
  };
  let changed = false;
  const shared = viewer.role === "owner";
  for (const x of confirmed) {
    const v = rows.get(x.versionId);
    const tries = v ? placesFor(v, { id: c.id, disks }, v.gone_at ? null : v.own, folders) : [];
    // the paths compared as text in NFC (a Mac may have sent one in NFD); x.path is NFC already (the route)
    const listed = [...tries, v?.own ?? ""].some((t) => t.normalize("NFC") === x.path);
    const verified = !!v?.quick && x.quick === v.quick;
    if (!v || (x.quick && v.quick && x.quick !== v.quick) || (!listed && !verified)) {
      answer.refused.push(x.versionId);
      continue;
    }
    d.prepare(
      `INSERT INTO version_places (version_id, device, path, confirmed_at, checked_at, state, source, quick, verified_at) VALUES (?, ?, ?, ?, ?, ?, 'locate', ?, ?)
       ON CONFLICT (version_id, device, kind, folder_id) DO UPDATE SET path = excluded.path, confirmed_at = excluded.confirmed_at, checked_at = excluded.checked_at, gone_at = NULL,
         state = CASE WHEN excluded.state = 'found' AND version_places.state = 'verified' AND version_places.path = excluded.path THEN 'verified' ELSE excluded.state END,
         quick = COALESCE(excluded.quick, quick), verified_at = COALESCE(excluded.verified_at, verified_at)`,
    ).run(v.id, c.id, x.path, now, now, verified ? "verified" : "found", x.quick ?? null, verified ? now : null);
    // the scan's row for this file (in its folder) and this one are one place: "found" never downgrades its "verified"
    mergeSamePath(v.id, c.id);
    answer.confirmed.push(v.id);
    // its own recorded try read: the fingerprint it never had
    if (x.quick && !v.quick) d.prepare("UPDATE asset_versions SET quick = ? WHERE id = ? AND (quick IS NULL OR quick = '')").run(x.quick, v.id);
    if (v.mac_device === c.id && v.mac_path?.normalize("NFC") !== x.path) {
      d.prepare("UPDATE asset_versions SET mac_path = ? WHERE id = ?").run(x.path, v.id);
      changed = true;
    }
    const at = rootAt(x.path, disks);
    const onRoot = !!at && at.key === v.root;
    if (at && !v.root && (verified || listed)) {
      d.prepare("UPDATE asset_versions SET root = ?, root_rel = ? WHERE id = ? AND root IS NULL").run(at.key, at.rel, v.id);
    } else if (shared && at && onRoot && verified && at.rel !== v.root_rel?.normalize("NFC")) {
      // moved on its own root: the same for every computer
      d.prepare("UPDATE asset_versions SET root_rel = ? WHERE id = ?").run(at.rel, v.id);
      if (v.root_rel !== null) log("moved", moveOf(v.root_rel, at.rel), labelOf(at.key, disks, disksOf(v.mac_device ?? "")), "");
      changed = true;
    } else if (!listed && (!onRoot || !shared)) {
      // a copy somewhere else, this computer's alone: from where it looked before, else where it was indexed
      const was = v.own ?? tries[0] ?? v.mac_path;
      if (was) log("found", moveOf(was, x.path), at ? labelOf(at.key, disks) : { key: "", name: base(dir(x.path)) || x.path }, c.id);
    }
  }
  for (const id of gone) {
    const v = rows.get(id);
    const was = v && (v.own ?? placesFor(v, { id: c.id, disks }, null, folders)[0]);
    if (!v || !was) continue;
    d.prepare(
      `INSERT INTO version_places (version_id, device, path, confirmed_at, gone_at, checked_at, state, source) VALUES (?, ?, ?, ?, ?, ?, 'gone', 'locate')
       ON CONFLICT (version_id, device, kind, folder_id) DO UPDATE SET gone_at = excluded.gone_at, checked_at = excluded.checked_at, state = 'gone'`,
    ).run(v.id, c.id, was, now, now, now);
    mergeSamePath(v.id, c.id);
  }
  for (const m of moves.values()) {
    d.prepare(
      `INSERT INTO library_moves (library_id, kind, device, root_key, root, from_prefix, to_prefix, count, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (library_id, kind, device, root_key, from_prefix, to_prefix) DO UPDATE SET count = count + excluded.count, at = excluded.at`,
    ).run(libraryId, m.kind, m.device, m.root?.key ?? "", JSON.stringify(m.root), m.from, m.to, m.count, now);
  }
  if (moves.size) {
    d.prepare("DELETE FROM library_moves WHERE library_id = ? AND rowid NOT IN (SELECT rowid FROM library_moves WHERE library_id = ? ORDER BY at DESC, rowid DESC LIMIT 50)").run(libraryId, libraryId);
  }
  if (changed || moves.size) libraryChanged(libraryId);
  return answer;
}

/**
 * Lazily, while the library's files lane is idle (worker.ts): versions indexed on a computer, or uploaded from one, with no
 * root yet get the one their origin computer's last reported disks put them on, so every computer that has the same share
 * connected finds the file there by itself (no folder to add first). An upload whose computer was not named takes the
 * root from its uploader's computers that hold that path. 500 a turn, through every such version and round again (one
 * whose computer never said its disks, or whose disk names no root, waits for that). True when it set any.
 */
// ponytail: a version that never gets a root is read again every round (500 a turn); mark it tried per report if that shows
let rootsAfter = 0;
export function backfillRoots(): boolean {
  const d = libraryDb();
  const rows = d
    .prepare(
      `SELECT rowid, id, COALESCE(mac_path, from_path) AS path, COALESCE(mac_device, from_device) AS device, created_by FROM asset_versions
       WHERE root IS NULL AND COALESCE(mac_path, from_path) IS NOT NULL AND rowid > ? ORDER BY rowid LIMIT 500`,
    )
    .all(rootsAfter) as { rowid: number; id: string; path: string; device: string | null; created_by: string }[];
  rootsAfter = rows.at(-1)?.rowid ?? 0;
  let n = 0;
  for (const r of rows) {
    // the root key is the same from every computer that has the share (rootKey), so any of theirs that holds the path names it
    const disks = r.device ? disksOf(r.device) : listDevices((x) => x.owner === r.created_by).flatMap((x) => disksOf(x.id).filter((k) => k.network));
    const at = rootAt(r.path, disks);
    if (at) n += Number(d.prepare("UPDATE asset_versions SET root = ?, root_rel = ? WHERE id = ? AND root IS NULL").run(at.key, at.rel, r.id).changes);
  }
  return n > 0;
}

const isPath = (p: unknown): p is string =>
  typeof p === "string" && p.length <= 2048 && (p.startsWith("/") || /^[A-Za-z]:\\|^\\\\/.test(p)) && !p.split(/[\\/]/).includes("..") && !p.includes("\0");

/** The library and the caller's own computer the request names, or the answer to give. */
async function asked(user: { username: string }, libraryId: string, device: unknown) {
  const viewer = await readerOf(user.username, libraryId);
  if (!viewer) return { error: { error: "Not found", code: "not_found" }, status: 404 as const };
  const dev = isId(device) ? deviceOf(device) : undefined;
  if (!dev || dev.owner !== user.username) return { error: { error: "Not your computer", code: "forbidden" }, status: 403 as const };
  return { libraryId, viewer, dev };
}

/** GET /api/library/:id/places?device&versions=a,b → PlacesAnswer: the paths that computer tries for each version. */
placesApp.get("/:id/places", async (c) => {
  const a = await asked(c.get("user"), c.req.param("id"), c.req.query("device"));
  if ("error" in a) return c.json(a.error, a.status);
  const ids = (c.req.query("versions") ?? "").split(",").filter(isId);
  if (ids.length > PLACES_MAX) return c.json({ error: `At most ${PLACES_MAX} versions`, code: "invalid" }, 400);
  const disks = a.dev.report?.machine?.disks ?? [];
  const folders = await foldersOf(a.dev.owner);
  const cached = new Set(cachedOn(a.dev.id));
  const proxies = new Map(
    (libraryDb()
      .prepare("SELECT v.id, v.source_key, v.bytes, d.bytes AS proxy FROM asset_versions v LEFT JOIN derivatives d ON d.version_id = v.id AND d.kind = 'proxy' AND d.storage_key IS NOT NULL WHERE v.id IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify(ids)) as { id: string; source_key: string; bytes: number; proxy: number | null }[]).map((r) => [r.id, r]),
  );
  const out: PlacesAnswer = { versions: {} };
  for (const v of await versionsOf(a.libraryId, a.viewer, a.dev.id, ids)) {
    const p = proxies.get(v.id)!;
    // what /play serves when the original is not here (routes.ts mediaFile): the proxy, else a stored original
    const play = p.proxy ?? (v.mac_path || p.source_key.startsWith("mac:") ? null : p.bytes);
    const answer: VersionPlaces = {
      tries: placesFor(v, { id: a.dev.id, disks }, v.gone_at ? null : v.own, folders),
      bytes: v.bytes,
      quick: v.quick || null,
      proxy: play === null ? null : { bytes: play },
      ...(v.root ? { root: labelOf(v.root, disks, disksOf(v.mac_device ?? "")) } : {}),
      ...(cached.has(v.id) ? { cached: true as const } : {}),
    };
    out.versions[v.id] = answer;
  }
  Object.assign(out.versions, await sourcePlaces(a.libraryId, a.viewer, c.req.raw, ids));
  return c.json(out);
});

/**
 * The ids among `ids` that are a source's items (ext_ refs the viewer may see): the paths to try come from the source
 * itself (LibrarySource.places), checked as the routes check a computer's paths. Nothing is kept here: a computer's
 * report on one of them is refused (versionsOf finds no version).
 */
async function sourcePlaces(libraryId: string, viewer: LibraryViewer, req: Request, ids: string[]): Promise<Record<string, VersionPlaces>> {
  const asked = new Map<LibrarySource, Map<string, string>>();
  for (const id of ids) {
    const ref = id.startsWith("ext_") ? externalRefById(id) : null;
    const source = ref ? sourceById(ref.source) : undefined;
    if (!ref || !source?.places || !(await externalCanSee(viewer, ref, libraryId))) continue;
    asked.set(source, (asked.get(source) ?? new Map<string, string>()).set(ref.externalId, ref.id));
  }
  const out: Record<string, VersionPlaces> = {};
  for (const [source, refs] of asked) {
    const got = await source.places!(viewer, req, [...refs.keys()]).catch(() => ({}));
    for (const [ext, p] of Object.entries(got)) {
      const id = refs.get(ext);
      if (id && Array.isArray(p?.tries) && p.tries.every(isPath) && Number.isSafeInteger(p.bytes) && p.bytes > 0)
        out[id] = { tries: p.tries, bytes: p.bytes, quick: null, proxy: null };
    }
  }
  return out;
}

/** POST /api/library/:id/places PlacesReport → PlacesReportAnswer (confirmPlaces). At most PLACES_MAX of each list. */
placesApp.post("/:id/places", async (c) => {
  const b = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const a = await asked(c.get("user"), c.req.param("id"), b.device);
  if ("error" in a) return c.json(a.error, a.status);
  const confirmed = Array.isArray(b.confirmed) ? (b.confirmed as Record<string, unknown>[]) : [];
  const gone = Array.isArray(b.gone) ? b.gone : [];
  if (confirmed.length > PLACES_MAX || gone.length > PLACES_MAX) return c.json({ error: `At most ${PLACES_MAX} versions`, code: "invalid" }, 400);
  if (!gone.every(isId) || !confirmed.every((x) => x && isId(x.versionId) && isPath(x.path) && (x.quick === undefined || (typeof x.quick === "string" && /^[0-9a-f]{64}$/.test(x.quick)))))
    return c.json({ error: "Invalid entry", code: "invalid" }, 400);
  // a file in a folder a Media folder leaves out is no place of a clip (report.ts mediaForLibrary: the person's and the owner's lists)
  const out = await (await import("./report")).leftOutFor(c.get("user").username, a.libraryId, a.dev.id);
  const list = confirmed
    .map((x) => ({ versionId: x.versionId as string, path: (x.path as string).normalize("NFC"), ...(x.quick ? { quick: x.quick as string } : {}) }))
    .filter((x) => !out(x.path));
  return c.json(await confirmPlaces(a.libraryId, a.viewer, a.dev, list, gone));
});

/**
 * GET /api/library/:id/places/gone?device[&away=1] → GoneAnswer: what that computer last found gone, with a fingerprint to
 * search by; `away=1` (Find missing files pressed) also the clips whose root isn't connected there (copies on another disk).
 */
placesApp.get("/:id/places/gone", async (c) => {
  const a = await asked(c.get("user"), c.req.param("id"), c.req.query("device"));
  if ("error" in a) return c.json(a.error, a.status);
  const ids = (libraryDb()
    .prepare(
      `SELECT DISTINCT p.version_id AS id FROM version_places p JOIN asset_versions v ON v.id = p.version_id JOIN assets a ON a.id = v.asset_id
       WHERE p.device = ? AND p.kind = 'original' AND p.state = 'gone' AND a.library_id = ? AND v.quick IS NOT NULL AND v.quick != ''`,
    )
    .all(a.dev.id, a.libraryId) as { id: string }[]).map((r) => r.id);
  // ponytail: the newest 20,000 away; a bigger library away from its share lists the rest after those are found
  const away =
    c.req.query("away") === "1"
      ? (libraryDb()
          .prepare(
            `SELECT v.id FROM asset_versions v JOIN assets a ON a.id = v.asset_id
             WHERE a.library_id = ? AND a.trashed_at IS NULL AND v.root IS NOT NULL AND v.root NOT IN (SELECT value FROM json_each(?))
               AND v.quick IS NOT NULL AND v.quick != '' ORDER BY v.created_at DESC LIMIT 20000`,
          )
          .all(a.libraryId, JSON.stringify(rootsOn(a.dev.id))) as { id: string }[]).map((r) => r.id)
      : [];
  const gone: GoneVersion[] = (await versionsOf(a.libraryId, a.viewer, a.dev.id, [...new Set([...ids, ...away])])).map((v) => {
    const path = v.own ?? v.gone_path ?? (v.mac_device === a.dev.id ? v.mac_path : null) ?? "";
    return { versionId: v.id, bytes: v.bytes, quick: v.quick!, root: v.root, rootRel: v.root_rel, path, name: path ? base(path) : v.title };
  });
  return c.json({ gone });
});

/** GET /api/library/:id/places/moves → MovesAnswer: moves on a root (everybody's), and copies the caller's computers found. */
placesApp.get("/:id/places/moves", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  if (!(await readerOf(user.username, libraryId))) return c.json({ error: "Not found", code: "not_found" }, 404);
  const mine = listDevices((x) => x.owner === user.username).map((x) => x.id);
  const rows = libraryDb()
    .prepare(
      `SELECT kind, root, from_prefix, to_prefix, count, at FROM library_moves WHERE library_id = ? AND (device = '' OR device IN (SELECT value FROM json_each(?)))
       ORDER BY at DESC, rowid DESC LIMIT 50`,
    )
    .all(libraryId, JSON.stringify(mine)) as { kind: PlaceMove["kind"]; root: string | null; from_prefix: string; to_prefix: string; count: number; at: number }[];
  const moves: PlaceMove[] = rows.map((r) => {
    const root = r.root ? (JSON.parse(r.root) as RootLabel) : undefined;
    return { at: r.at, kind: r.kind, from: r.from_prefix, to: r.to_prefix, count: r.count, ...(root?.key ? { root } : {}) };
  });
  return c.json({ moves });
});

/**
 * POST /api/library/:id/proxies {versions} → { queued }: an edit opened in the editor. Each of its videos that plays
 * slowly as it is (above 1080p, or a file the browser can't play: a phone's 4K HEVC; media/proxy.ts needsProxy) and has
 * no proxy on the server or on any computer gets a proxy job. The job takes the usual road (library-package.ts): the
 * server, or the computer that has the file; where the server hosts no proxies that computer keeps it and sends nothing.
 * The proxy is a derivative of the same version, so whatever the original carries (a "not blurred yet" mark) holds for it.
 */
placesApp.post("/:id/proxies", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  const viewer = await readerOf(user.username, libraryId);
  if (!viewer) return c.json({ error: "Not found", code: "not_found" }, 404);
  const b = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const ids = Array.isArray(b.versions) ? b.versions.filter(isId) : [];
  if (ids.length > PLACES_MAX) return c.json({ error: `At most ${PLACES_MAX} versions`, code: "invalid" }, 400);
  const d = libraryDb();
  const none = d.prepare(
    `SELECT v.probe FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ? AND a.kind = 'video' AND a.current_version_id = v.id
       AND NOT EXISTS (SELECT 1 FROM derivatives x WHERE x.version_id = v.id AND x.kind = 'proxy' AND x.storage_key IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM version_places p WHERE p.version_id = v.id AND p.kind = 'proxy' AND p.state IN ('verified','found'))
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.version_id = v.id AND j.kind = 'proxy' AND j.state IN ('queued','running'))`,
  );
  const queued: string[] = [];
  for (const v of await versionsOf(libraryId, viewer, "", ids)) {
    const r = none.get(v.id) as { probe: string | null } | undefined;
    const p = r?.probe ? (JSON.parse(r.probe) as ProbeSummary) : null;
    if (!p?.width || !p.height) continue;
    // a file indexed on a Mac carries no codec (on-mac.ts): its size alone says it is heavy
    if (!(p.vcodec === "mac" ? Math.min(p.width, p.height) > 1080 : needsProxy(p))) continue;
    enqueueJob(d, libraryId, v.id, "proxy", user.username, true);
    queued.push(v.id);
  }
  if (queued.length) libraryChanged(libraryId);
  return c.json({ queued });
});
