import { randomUUID } from "node:crypto";
import path from "node:path";
import { Hono } from "hono";
import type { AuthVars } from "../auth";
import { COPY_KIND, type DeviceJob } from "../../contracts/devices";
import type { CopyItem, LibraryCopy } from "../../contracts/library";
import { deviceOf, isOnline } from "../lib/devices";
import { walkOnMac } from "../lib/folder-list";
import { wakeEditorPolls } from "../lib/mac-claude";
import { pluginCopySources, type DeviceJobSlot } from "../lib/plugin";
import { libraryChanged, libraryRole } from "./access";
import { libraryDb } from "./db";
import { triesOn } from "./places";
import { downloadName } from "./routes";

/**
 * Copies of a Media Library in folders on its owner's computers (Settings → Media Library → Copies;
 * tasks/library-copies). Every clip's current version goes to every copy, from the server's stored original or from a
 * path on the copy's own computer; a newer version moves the older one into the folder's .versions/; nothing is ever
 * deleted from a copy. There is no queue: what a copy lacks is the clips' current versions minus copy_files, so a new
 * file, a new version and a new copy all show up on the next claim. The copy's computer claims it on the device job
 * road (contracts/devices.ts COPY_KIND), one file at a time, and checks the folder's files once a day.
 * The server holds a stored original until every copy has it (copiesLack: worker.ts dropOriginal, trash.ts purgeTrash).
 */

/** How long a computer holds a job without a word (it beats every 30 s while it copies). */
const LEASE_MS = 180_000;
/** A file that failed is tried again after this; a folder that was not there or a full disk, after STATE_RETRY_MS. */
const RETRY_MS = 3_600_000;
const STATE_RETRY_MS = 600_000;
/** How often a copy's computer checks the files are still there. */
const CHECK_MS = 86_400_000;

type CopyRow = { id: string; library_id: string; device: string; path: string; state: LibraryCopy["state"]; last_seen: number | null; checked_at: number | null; retry_at: number | null; created_at: number };
type Held = { id: number; device: string; copy: string; key: string | null; at: number; item?: CopyItem };
const held = new Map<number, Held>();
let lastId = 0;

const db = () => libraryDb();

/** The original is on the server's store (not a computer's, not a proxy standing in for it). */
const STORED = `(v.source_key NOT LIKE 'mac:%' AND NOT EXISTS (SELECT 1 FROM derivatives d WHERE d.version_id = v.id AND d.kind = 'proxy' AND d.storage_key = v.source_key))`;
/** What goes to a copy: each clip's current version, once it is ready (trashed ones too, until the trash is emptied). */
const WANTED = `FROM assets a JOIN asset_versions v ON v.id = a.current_version_id WHERE a.library_id = ? AND v.state = 'ready'`;

type VersionRow = { id: string; asset_id: string; n: number; bytes: number; sha256: string; mac_path: string | null; mac_device: string | null; stored: number };

/** The versions copy `c` lacks: not copied, and not tried in the last hour. `limit` rows, oldest clips first. */
function lacking(c: CopyRow, now: number, limit: number): VersionRow[] {
  return db()
    .prepare(
      `SELECT v.id, v.asset_id, v.n, v.bytes, v.sha256, v.mac_path, v.mac_device, ${STORED} AS stored ${WANTED}
         AND NOT EXISTS (SELECT 1 FROM copy_files f WHERE f.copy_id = ? AND f.version_id = v.id AND (f.copied_at IS NOT NULL OR f.tried_at > ?))
       ORDER BY a.created_at, a.id LIMIT ?`,
    )
    .all(c.library_id, c.id, now - RETRY_MS, limit) as VersionRow[];
}

/** A plug-in's files copy `c` lacks (the same rule). */
function lackingItems(c: CopyRow, now: number): CopyItem[] {
  const sources = pluginCopySources();
  if (!sources.length) return [];
  const have = new Set(
    (db().prepare("SELECT version_id AS k FROM copy_files WHERE copy_id = ? AND (copied_at IS NOT NULL OR tried_at > ?)").all(c.id, now - RETRY_MS) as { k: string }[]).map((r) => r.k),
  );
  return sources.flatMap((s) => s.items(c.library_id)).filter((i) => !have.has(i.key));
}

/** Whether a version is copied to every copy of its library: a stored original is held until then. */
export function copiesLack(versionId: string): boolean {
  return !!db()
    .prepare(
      `SELECT 1 FROM library_copies c JOIN assets a ON a.library_id = c.library_id JOIN asset_versions v ON v.id = a.current_version_id
       WHERE v.id = ? AND v.state = 'ready' AND ${STORED}
         AND NOT EXISTS (SELECT 1 FROM copy_files f WHERE f.copy_id = c.id AND f.version_id = v.id AND f.copied_at IS NOT NULL) LIMIT 1`,
    )
    .get(versionId);
}

/** The assets among `ids` whose stored original some copy still lacks (the trash purge leaves them). */
export function assetsCopiesLack(ids: string[]): Set<string> {
  if (!ids.length) return new Set();
  const rows = db()
    .prepare(
      `SELECT DISTINCT a.id FROM assets a JOIN asset_versions v ON v.id = a.current_version_id JOIN library_copies c ON c.library_id = a.library_id
       WHERE a.id IN (SELECT value FROM json_each(?)) AND v.state = 'ready' AND ${STORED}
         AND NOT EXISTS (SELECT 1 FROM copy_files f WHERE f.copy_id = c.id AND f.version_id = v.id AND f.copied_at IS NOT NULL)`,
    )
    .all(JSON.stringify(ids)) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

/** A clip's path in a copy at its first copy: its first plain folder's path (smart folders not), then its file name. */
function relFor(assetId: string, versionId: string): string {
  const parts: string[] = [];
  let at = (db()
    .prepare("SELECT c.id FROM collection_items ci JOIN collections c ON c.id = ci.collection_id WHERE ci.asset_id = ? AND c.kind = 'manual' AND c.rule IS NULL ORDER BY c.created_at, c.id LIMIT 1")
    .get(assetId) as { id: string } | undefined)?.id;
  for (let i = 0; at && i < 20; i++) {
    const c = db().prepare("SELECT name, parent_id FROM collections WHERE id = ?").get(at) as { name: string; parent_id: string | null } | undefined;
    if (!c) break;
    parts.unshift(c.name.replace(/[\\/:\x00-\x1f]/g, "_").replace(/^\.+/, "") || "_");
    at = c.parent_id ?? undefined;
  }
  return [...parts, downloadName(versionId).replace(/^\.+/, "_")].join("/");
}

/** Where copy `c` put an older version of the clip, if it did. */
const prevRel = (c: string, assetId: string) =>
  (db()
    .prepare("SELECT f.rel_path FROM copy_files f JOIN asset_versions v ON v.id = f.version_id WHERE f.copy_id = ? AND v.asset_id = ? AND f.copied_at IS NOT NULL ORDER BY v.n DESC LIMIT 1")
    .get(c, assetId) as { rel_path: string } | undefined)?.rel_path;

const busy = (device: string, now = Date.now()) => {
  for (const [id, h] of held) {
    if (now - h.at > LEASE_MS) held.delete(id);
    else if (h.device === device) return true;
  }
  return false;
};

const copiesOn = (device: string, now: number) =>
  db().prepare("SELECT * FROM library_copies WHERE device = ? AND (retry_at IS NULL OR retry_at <= ?) ORDER BY created_at, id").all(device, now) as CopyRow[];

/** The next job for computer `d`, without taking it. */
function nextFor(d: { id: string; owner: string }, now = Date.now()): Omit<Held, "id" | "at"> & { op: "check" | "copy"; options: Record<string, string> } | null {
  if (busy(d.id, now)) return null;
  for (const c of copiesOn(d.id, now)) {
    if (libraryRole(d.owner, c.library_id) !== "owner") continue;
    const base = { copy: c.id, library: c.library_id, root: c.path, ...(c.state === "new" ? { init: "1" } : {}) };
    // a new copy writes its marker first; then once a day each file is checked to be there still
    if (c.state === "new" || (c.checked_at ?? 0) < now - CHECK_MS) return { device: d.id, copy: c.id, key: null, op: "check", options: { op: "check", ...base } };
    // ponytail: 200 a claim; a library with more than 200 files only another computer holds waits for the next claim's turn
    for (const v of lacking(c, now, 200)) {
      const paths = triesOn(v, d.id, []);
      if (!v.stored && !paths.length) continue;
      const prev = prevRel(c.id, v.asset_id);
      return {
        device: d.id,
        copy: c.id,
        key: v.id,
        op: "copy",
        options: {
          op: "copy",
          ...base,
          key: v.id,
          asset: v.asset_id,
          n: String(v.n),
          rel: prev ?? relFor(v.asset_id, v.id),
          ...(prev ? { prev } : {}),
          size: String(v.bytes),
          ...(v.sha256.startsWith("mac:") ? {} : { sha256: v.sha256 }),
          paths: JSON.stringify(paths),
          ...(v.stored ? { url: "" } : {}),
        },
      };
    }
    const item = lackingItems(c, now)[0];
    if (item)
      return {
        device: d.id,
        copy: c.id,
        key: item.key,
        item,
        op: "copy",
        options: { op: "copy", ...base, key: item.key, asset: item.asset, n: "1", rel: item.rel, size: String(item.size), ...(item.sha256 ? { sha256: item.sha256 } : {}), paths: "[]", url: "" },
      };
  }
  return null;
}

/** Tells the computers of the copies of a version's library that it waits (it is ready now). */
export function copiesWake(versionId: string): void {
  const any = db()
    .prepare("SELECT 1 FROM library_copies c JOIN assets a ON a.library_id = c.library_id JOIN asset_versions v ON v.asset_id = a.id WHERE v.id = ? LIMIT 1")
    .get(versionId);
  if (any) void wakeEditorPolls();
}

const heldBy = (device: string, id: number) => {
  const h = held.get(id);
  return h && h.device === device && Date.now() - h.at <= LEASE_MS ? h : undefined;
};
/** Ends job `h`: the computer is heard from, its free space kept, and the copy's page told. */
function end(h: Held, set: { state?: LibraryCopy["state"]; free?: unknown; retry?: number; checked?: true }) {
  held.delete(h.id);
  const now = Date.now();
  const free = Number.isSafeInteger(set.free) && (set.free as number) >= 0 ? (set.free as number) : null;
  db()
    .prepare(
      `UPDATE library_copies SET last_seen = ?, free_bytes = COALESCE(?, free_bytes), state = COALESCE(?, state), retry_at = ?,
         checked_at = CASE WHEN ? THEN ? ELSE checked_at END WHERE id = ?`,
    )
    .run(now, free, set.state ?? null, set.retry ? now + set.retry : null, set.checked ? 1 : 0, now, h.copy);
  const lib = (db().prepare("SELECT library_id FROM library_copies WHERE id = ?").get(h.copy) as { library_id: string } | undefined)?.library_id;
  if (lib) libraryChanged(lib);
}

/** A path inside the copy's folder, as the computer sent it: relative, no `..`, no hidden top folder but .versions. */
const isRel = (p: unknown): p is string =>
  typeof p === "string" && p.length > 0 && p.length <= 1000 && !/[\0\n\r\\]/.test(p) && !p.startsWith("/") && !p.split("/").some((s) => !s || s === "." || s === "..");

/** The device job road's side of it (api/devices.ts lists it with the app's own). */
export const copyJob: DeviceJobSlot = {
  kind: COPY_KIND,
  waits: (owner, device) => !!nextFor({ id: device, owner }),
  claim: (d): DeviceJob | null => {
    const next = nextFor(d);
    if (!next) return null;
    const id = ++lastId;
    const { op: _op, options, ...h } = next;
    held.set(id, { ...h, id, at: Date.now() });
    if ("url" in options) options.url = `/api/devices/relay/job/${COPY_KIND}/${id}/file`;
    return { id, kind: COPY_KIND, editId: "", variant: "", options };
  },
  input: async () => null,
  answer: async (device, id, body) => {
    const h = heldBy(device, id);
    if (!h) return { error: "Not found", status: 404 };
    const b = (body ?? {}) as Record<string, unknown>;
    if (b.beat === true) {
      h.at = Date.now();
      return { reply: {} };
    }
    if (b.state === "reconnect" || b.state === "full") {
      end(h, { state: b.state, free: b.free, retry: STATE_RETRY_MS });
      return { reply: {} };
    }
    if (Array.isArray(b.gone)) {
      if (h.key !== null) return { error: "Not a check", status: 400 };
      const gone = b.gone.filter((k): k is string => typeof k === "string" && k.length <= 200);
      // a file gone from the folder is copied again while its clip is in the library
      const drop = db().prepare("DELETE FROM copy_files WHERE copy_id = ? AND version_id = ?");
      for (const k of gone) drop.run(h.copy, k);
      end(h, { state: "ok", free: b.free, checked: true });
      void wakeEditorPolls();
      return { reply: {} };
    }
    const done = b.done as Record<string, unknown> | undefined;
    if (!done || h.key === null) return { error: "Send a beat, done, gone or state", status: 400 };
    if (!isRel(done.rel)) return { error: "rel: the file's path inside the folder", status: 400 };
    const v = h.item
      ? { bytes: h.item.size, sha256: h.item.sha256 ?? "" }
      : (db().prepare("SELECT bytes, sha256 FROM asset_versions WHERE id = ?").get(h.key) as { bytes: number; sha256: string } | undefined);
    if (!v) return { error: "Not found", status: 404 };
    const sha = typeof done.sha256 === "string" ? done.sha256.toLowerCase() : "";
    // never a proxy or a part in place of the original: its size, and its hash where the version has a real one
    if (done.size !== v.bytes || (v.sha256 && !v.sha256.startsWith("mac:") && sha !== v.sha256)) return { error: "This is not the same file: copy it again.", status: 409 };
    const now = Date.now();
    db()
      .prepare(
        `INSERT INTO copy_files (copy_id, version_id, rel_path, size, sha256, copied_at, error, tried_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT (copy_id, version_id) DO UPDATE SET rel_path = excluded.rel_path, size = excluded.size, sha256 = excluded.sha256, copied_at = excluded.copied_at, error = NULL, tried_at = excluded.tried_at`,
      )
      .run(h.copy, h.key, done.rel, v.bytes, sha || null, now, now);
    const c = db().prepare("SELECT path FROM library_copies WHERE id = ?").get(h.copy) as { path: string } | undefined;
    // the copy is the clip on that computer too: Show in Finder and playing there find it (a place it has already stays)
    if (c && !h.item)
      db().prepare("INSERT OR IGNORE INTO version_places (version_id, device, path, confirmed_at) VALUES (?, ?, ?, ?)").run(h.key, device, path.posix.join(c.path, done.rel), now);
    end(h, { state: "ok", free: b.free });
    // a stored original every copy has now may go where the library keeps proxies only
    if (!h.item) void import("./worker").then((w) => w.dropOriginal(h.key!)).catch((e: unknown) => console.error("[library] copies:", e));
    void wakeEditorPolls();
    return { reply: {} };
  },
  file: async () => ({ error: "Send the copy's answers as JSON.", status: 400 }),
  fail: (device, id, why) => {
    const h = heldBy(device, id);
    if (!h) return false;
    if (h.key !== null) {
      const now = Date.now();
      db()
        .prepare(
          `INSERT INTO copy_files (copy_id, version_id, error, tried_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (copy_id, version_id) DO UPDATE SET error = excluded.error, tried_at = excluded.tried_at`,
        )
        .run(h.copy, h.key, why.slice(0, 300), now);
    }
    end(h, h.key === null ? { retry: STATE_RETRY_MS } : {});
    return true;
  },
};

/**
 * The file of job `id` for the computer that holds it (GET /api/devices/relay/job/copy/:id/file): the version's stored
 * original, or a plug-in's file opened for the library's owner. Null when the computer holds no such job.
 */
export async function copyFile(device: string, id: number): Promise<{ key: string } | { open: (req: Request) => Promise<Response | null> } | null> {
  const h = heldBy(device, id);
  if (!h || h.key === null) return null;
  if (h.item) {
    const c = db().prepare("SELECT library_id FROM library_copies WHERE id = ?").get(h.copy) as { library_id: string } | undefined;
    const owner = deviceOf(device)?.owner;
    const src = pluginCopySources().find((s) => s.items(c?.library_id ?? "").some((i) => i.key === h.key));
    if (!c || !owner || !src || libraryRole(owner, c.library_id) !== "owner") return null;
    return { open: (req) => src.open(owner, h.key!, req) };
  }
  const v = db().prepare(`SELECT v.source_key FROM asset_versions v WHERE v.id = ? AND ${STORED}`).get(h.key) as { source_key: string } | undefined;
  return v ? { key: v.source_key } : null;
}

/* ---- Settings → Media Library → Copies ---- */

export const copiesApp = new Hono<{ Variables: AuthVars }>();

/** The library's copies as the card lists them: the app's own, then any a plug-in's copier keeps. */
async function listCopies(libraryId: string): Promise<LibraryCopy[]> {
  const now = Date.now();
  const rows = db().prepare("SELECT * FROM library_copies WHERE library_id = ? ORDER BY created_at, id").all(libraryId) as CopyRow[];
  const own = rows.map((c): LibraryCopy => {
    const d = deviceOf(c.device);
    const pending =
      (db().prepare(`SELECT count(*) AS n ${WANTED} AND NOT EXISTS (SELECT 1 FROM copy_files f WHERE f.copy_id = ? AND f.version_id = v.id AND f.copied_at IS NOT NULL)`).get(libraryId, c.id) as { n: number }).n +
      lackingItems(c, Number.MAX_SAFE_INTEGER).length;
    // files only another computer holds: the first one named
    const elsewhere = pending
      ? (db()
          .prepare(
            `SELECT v.mac_device ${WANTED} AND NOT ${STORED} AND v.mac_device IS NOT NULL AND v.mac_device != ?
               AND NOT EXISTS (SELECT 1 FROM copy_files f WHERE f.copy_id = ? AND f.version_id = v.id AND f.copied_at IS NOT NULL) LIMIT 1`,
          )
          .get(libraryId, c.device, c.id) as { mac_device: string } | undefined)
      : undefined;
    const online = isOnline(c.device);
    return {
      id: c.id,
      device: c.device,
      computer: d?.name ?? "Removed computer",
      path: c.path,
      pending,
      copying: [...held.values()].some((h) => h.copy === c.id && h.key !== null && now - h.at <= LEASE_MS),
      state: c.state,
      ...(!online ? { offlineSince: d?.lastSeen ?? c.last_seen ?? c.created_at } : {}),
      ...(elsewhere ? { waitsFor: deviceOf(elsewhere.mac_device)?.name ?? "Removed computer" } : {}),
    } as LibraryCopy;
  });
  const theirs = (await Promise.all(pluginCopySources().map((s) => s.rows?.(libraryId).catch(() => []) ?? []))).flat().map((r) => ({ ...r, readOnly: true as const }));
  return [...own, ...theirs];
}

/** The library when this account owns it: only its owner sees or changes its copies. */
const owned = (username: string, id: string) => libraryRole(username, id) === "owner";
/** A computer of the account's own. */
const ownComputer = (username: string, device: unknown) => {
  const d = typeof device === "string" ? deviceOf(device) : undefined;
  return d && d.owner === username ? d : undefined;
};

// GET /api/library/:id/copies → { copies: LibraryCopy[] }
copiesApp.get("/:id/copies", async (c) => {
  const id = c.req.param("id");
  if (!owned(c.get("user").username, id)) return c.json({ error: "Not found", code: "not_found" }, 404);
  return c.json({ copies: await listCopies(id) });
});

// POST /api/library/:id/copies { device, path } → { copy }: a folder on one of the owner's computers
copiesApp.post("/:id/copies", async (c) => {
  const id = c.req.param("id");
  const { username } = c.get("user");
  if (!owned(username, id)) return c.json({ error: "Not found", code: "not_found" }, 404);
  const b = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const d = ownComputer(username, b.device);
  if (!d) return c.json({ error: "Not your computer", code: "forbidden" }, 403);
  const folder = typeof b.path === "string" ? b.path.replace(/\/+$/, "") : "";
  if (!folder.startsWith("/") || folder.length > 1000 || /[\0\n\r]/.test(folder) || folder.split("/").includes("..")) return c.json({ error: "Pick a folder", code: "invalid" }, 400);
  if (db().prepare("SELECT 1 FROM library_copies WHERE device = ? AND path = ?").get(d.id, folder)) return c.json({ error: "That folder holds a copy already", code: "conflict" }, 409);
  const copyId = `cp_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  db().prepare("INSERT INTO library_copies (id, library_id, device, path, created_at) VALUES (?, ?, ?, ?, ?)").run(copyId, id, d.id, folder, Date.now());
  void wakeEditorPolls();
  return c.json({ copy: (await listCopies(id)).find((x) => x.id === copyId) });
});

// DELETE /api/library/:id/copies/:copyId: Stop copying. Nothing in the folder is deleted
copiesApp.delete("/:id/copies/:copyId", async (c) => {
  const id = c.req.param("id");
  if (!owned(c.get("user").username, id)) return c.json({ error: "Not found", code: "not_found" }, 404);
  const copyId = c.req.param("copyId");
  const gone = db().prepare("DELETE FROM library_copies WHERE id = ? AND library_id = ?").run(copyId, id).changes;
  if (!gone) return c.json({ error: "Not found", code: "not_found" }, 404);
  db().prepare("DELETE FROM copy_files WHERE copy_id = ?").run(copyId);
  for (const [k, h] of held) if (h.copy === copyId) held.delete(k);
  // the originals it held back may go now
  const { dropOriginal } = await import("./worker");
  for (const v of db().prepare(`SELECT v.id ${WANTED} AND ${STORED}`).all(id) as { id: string }[]) await dropOriginal(v.id).catch(() => false);
  return c.json({ ok: true });
});

// GET /api/library/:id/copies/folders?device&path → { path, folders }: the folders in `path` on that computer (Add copy)
copiesApp.get("/:id/copies/folders", async (c) => {
  const id = c.req.param("id");
  const { username } = c.get("user");
  if (!owned(username, id)) return c.json({ error: "Not found", code: "not_found" }, 404);
  const d = ownComputer(username, c.req.query("device"));
  if (!d) return c.json({ error: "Not your computer", code: "forbidden" }, 403);
  const at = c.req.query("path") || "/";
  if (!at.startsWith("/") || at.split("/").includes("..")) return c.json({ error: "Pick a folder", code: "invalid" }, 400);
  try {
    const walk = await walkOnMac(username, at, 1, true, d.id);
    return c.json({ path: at, folders: walk.entries.filter((e) => e.dir).map((e) => e.path) });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e), code: "unavailable" }, 503);
  }
});
