import { createHash, randomInt, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import type { AuthVars } from "../auth";
import { COPY_KIND, type DeviceJob } from "../../contracts/devices";
import type { CopyItem, LibraryCopy } from "../../contracts/library";
import { deviceOf, isOnline } from "../lib/devices";
import { walkOnMac } from "../lib/folder-list";
import { wakeEditorPolls } from "../lib/mac-claude";
import { pluginCopySources, type DeviceJobSlot } from "../lib/plugin";
import { accountOf, libraryChanged, libraryRole } from "./access";
import { blobs, libraryDb, versionUpload } from "./db";
import { triesOn } from "./places";
import { downloadName } from "./routes";

/**
 * Copies of a Media Library in folders on its owner's computers (Settings → Media Library → Copies;
 * tasks/library-copies). Every version of every clip goes to every copy, from the server's stored original or from a
 * path on the copy's own computer; a newer version moves the older one into the folder's .versions/; nothing is ever
 * deleted from a copy. There is no queue: what a copy lacks is the clips' versions minus copy_files, so a new file, a
 * new version and a new copy all show up on the next claim. The copy's computer claims it on the device job road
 * (contracts/devices.ts COPY_KIND), one file at a time, and checks the folder's files once a day. A version only another
 * computer holds is sent here by that computer first (op "send", copy_sends) and kept until every copy has it, only where
 * the library's Upload to the server is "Video files and proxies" (all); with Off or Proxies only the server never keeps
 * an original for a copy: that copy waits ("Needs Upload to the server") and a Mac upload's original goes as before
 * (worker.ts dropOriginal). The trash purge leaves what the server has that a copy still lacks (assetsCopiesLack).
 */

/** How long a computer holds a job without a word (it beats every 30 s while it copies). */
const LEASE_MS = 180_000;
/** A job whose computer went quiet still takes its late answer for this long (it may have renamed the file already). */
const KEEP_HELD_MS = 86_400_000;
/** A file that failed is tried again after this; a folder that was not there or a full disk, after STATE_RETRY_MS. */
const RETRY_MS = 3_600_000;
const STATE_RETRY_MS = 600_000;
/** How often a copy's computer checks the files are still there. */
const CHECK_MS = 86_400_000;
/** A copy that has taken nothing this long while the server keeps files for it: its owner is told once. */
const NOTICE_MS = 14 * 86_400_000;

type CopyRow = { id: string; library_id: string; device: string; path: string; state: LibraryCopy["state"]; last_seen: number | null; checked_at: number | null; retry_at: number | null; created_at: number };
type Held = { id: number; device: string; copy: string; key: string | null; at: number; item?: CopyItem; send?: true };
const held = new Map<number, Held>();

const db = () => libraryDb();

/** The original is on the server's store (not a computer's, not a proxy standing in for it). */
const STORED = `(v.source_key NOT LIKE 'mac:%' AND NOT EXISTS (SELECT 1 FROM derivatives d WHERE d.version_id = v.id AND d.kind = 'proxy' AND d.storage_key = v.source_key))`;
/** A computer sent the original here for the copies (op "send"). */
const SENT = `EXISTS (SELECT 1 FROM copy_sends s WHERE s.version_id = v.id AND s.storage_key IS NOT NULL)`;
/** On this server for a copy to read. */
const HERE = `(${STORED} OR ${SENT})`;
/** What goes to a copy: every version of each clip once it is stored, before its own work runs (an older one still in
 *  work when a newer came too), one whose work failed, and a missing one whose file is still here; trashed ones too,
 *  until the trash is emptied. */
const WANTS = `(v.state IN ('processing', 'ready', 'failed') OR (v.state = 'missing' AND ${STORED}))`;
const WANTED = `FROM assets a JOIN asset_versions v ON v.asset_id = a.id WHERE a.library_id = ? AND ${WANTS}`;
/** Copy `copy` (an SQL expression) has version v. */
const has = (copy: string) => `EXISTS (SELECT 1 FROM copy_files f WHERE f.copy_id = ${copy} AND f.version_id = v.id AND f.copied_at IS NOT NULL)`;
/** Some copy of v's library lacks it. */
const SOME_LACK = `EXISTS (SELECT 1 FROM library_copies c WHERE c.library_id = a.library_id AND NOT ${has("c.id")})`;
/** Where computer ?1 may find the original itself (triesOn: its own place, a disk root, the computer it was indexed on). */
const MAY_REACH = `(v.mac_device = ? OR v.root IS NOT NULL OR EXISTS (SELECT 1 FROM version_places p WHERE p.version_id = v.id AND p.device = ? AND p.gone_at IS NULL))`;

type VersionRow = { id: string; asset_id: string; n: number; bytes: number; sha256: string; mac_path: string | null; mac_device: string | null; created_at: number; here: number };
const VERSION = "v.id, v.asset_id, v.n, v.bytes, v.sha256, v.mac_path, v.mac_device, a.created_at";

/**
 * The rows of `sql` (a SELECT that ends in its WHERE, with a.created_at, v.asset_id, v.n) in clip order, 200 at a time,
 * until `pick` takes one: what no computer can reach now never holds back what comes after it.
 */
function firstOf<R extends VersionRow, T>(sql: string, params: (string | number)[], pick: (r: R) => T | null): T | null {
  let after: (string | number)[] = [Number.MIN_SAFE_INTEGER, "", -1];
  for (;;) {
    const rows = db()
      .prepare(`${sql} AND (a.created_at, a.id, v.n) > (?, ?, ?) ORDER BY a.created_at, a.id, v.n LIMIT 200`)
      .all(...params, ...after) as R[];
    for (const r of rows) {
      const t = pick(r);
      if (t) return t;
    }
    if (rows.length < 200) return null;
    const last = rows[rows.length - 1]!;
    after = [last.created_at, last.asset_id, last.n];
  }
}

/** The next version copy `c` lacks that its computer can get (from here, or a path on it): not tried in the last hour. */
function nextCopy(c: CopyRow, now: number) {
  return firstOf(
    `SELECT ${VERSION}, ${HERE} AS here ${WANTED}
       AND NOT EXISTS (SELECT 1 FROM copy_files f WHERE f.copy_id = ? AND f.version_id = v.id AND (f.copied_at IS NOT NULL OR f.tried_at > ?))
       AND (${HERE} OR ${MAY_REACH})`,
    [c.library_id, c.id, now - RETRY_MS, c.device, c.device],
    (v) => {
      const paths = triesOn(v, c.device, []);
      return v.here || paths.length ? { v, paths } : null;
    },
  );
}

/**
 * The next version that computer `d` holds and a copy on another computer lacks and cannot reach: `d` sends it here
 * first. Only while that copy's computer is online, so the server keeps no file for a computer that is away.
 */
function nextSend(d: string, now: number) {
  return firstOf<VersionRow & { target: string; copy: string }, { v: VersionRow & { copy: string }; paths: string[] }>(
    `SELECT ${VERSION}, 0 AS here, c.id AS copy, c.device AS target
       FROM library_copies c JOIN assets a ON a.library_id = c.library_id JOIN asset_versions v ON v.asset_id = a.id
       WHERE c.device != ? AND ${WANTS} AND NOT ${HERE} AND NOT ${has("c.id")}
         AND (v.mac_device = ? OR EXISTS (SELECT 1 FROM version_places p WHERE p.version_id = v.id AND p.device = ? AND p.gone_at IS NULL))
         AND NOT (v.mac_device = c.device OR EXISTS (SELECT 1 FROM version_places p WHERE p.version_id = v.id AND p.device = c.device AND p.gone_at IS NULL))
         AND NOT EXISTS (SELECT 1 FROM copy_sends s WHERE s.version_id = v.id AND s.tried_at > ?)`,
    [d, d, d, now - RETRY_MS],
    (v) => {
      // an original goes through the server only where its library uploads them (owner, 11-17: originals stay on his computers)
      if (!isOnline(v.target) || versionUpload(v.id) !== "all" || triesOn(v, v.target, []).length || [...held.values()].some((h) => h.send && h.key === v.id && now - h.at <= LEASE_MS)) return null;
      const paths = triesOn(v, d, []);
      return paths.length ? { v, paths } : null;
    },
  );
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

/** The assets among `ids` with a version here (stored or sent) that some copy still lacks (the trash purge leaves them). */
export function assetsCopiesLack(ids: string[]): Set<string> {
  if (!ids.length) return new Set();
  const rows = db()
    .prepare(`SELECT DISTINCT a.id FROM assets a JOIN asset_versions v ON v.asset_id = a.id WHERE a.id IN (SELECT value FROM json_each(?)) AND ${WANTS} AND ${HERE} AND ${SOME_LACK}`)
    .all(JSON.stringify(ids)) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

/** Deletes the original a computer sent for version `versionId` once every copy has it. */
export async function dropSent(versionId: string): Promise<void> {
  const s = db()
    .prepare(`SELECT s.storage_key AS k FROM copy_sends s JOIN asset_versions v ON v.id = s.version_id JOIN assets a ON a.id = v.asset_id WHERE s.version_id = ? AND s.storage_key IS NOT NULL AND NOT ${SOME_LACK}`)
    .get(versionId) as { k: string } | undefined;
  if (!s) return;
  db().prepare("DELETE FROM copy_sends WHERE version_id = ?").run(versionId);
  await blobs.delete(s.k);
}

/** A name part as a copy's path takes it: NFC, no separators or control characters, not hidden. */
const part = (s: string) => s.normalize("NFC").replace(/[\\/:\x00-\x1f]/g, "_").replace(/^\.+/, "") || "_";

/** A clip's path in a copy at its first copy: its first plain folder's path (smart folders not), then its file name. */
function relFor(assetId: string, versionId: string): string {
  const parts: string[] = [];
  let at = (db()
    .prepare("SELECT c.id FROM collection_items ci JOIN collections c ON c.id = ci.collection_id WHERE ci.asset_id = ? AND c.kind = 'manual' AND c.rule IS NULL ORDER BY c.created_at, c.id LIMIT 1")
    .get(assetId) as { id: string } | undefined)?.id;
  for (let i = 0; at && i < 20; i++) {
    const c = db().prepare("SELECT name, parent_id FROM collections WHERE id = ?").get(at) as { name: string; parent_id: string | null } | undefined;
    if (!c) break;
    parts.unshift(part(c.name));
    at = c.parent_id ?? undefined;
  }
  return [...parts, part(downloadName(versionId))].join("/");
}

/** `.versions/<dir>/<stem> v<n><ext>` for version `n` of the clip at `rel` (the copiers' own rule). */
export const versionRel = (rel: string, n: number) => {
  const p = path.posix.parse(rel);
  return path.posix.join(".versions", p.dir, `${p.name} v${n}${p.ext}`);
};

/**
 * Where version `v` goes in copy `c`: an older version than one copied already goes straight into .versions/; else the
 * path of the newest one copied before it (that one moves into .versions/ first), else the clip's path at first copy.
 */
function placeIn(c: string, v: { id: string; asset_id: string; n: number }): { rel: string; prev?: string } {
  const top = db()
    .prepare("SELECT f.rel_path, v.n FROM copy_files f JOIN asset_versions v ON v.id = f.version_id WHERE f.copy_id = ? AND v.asset_id = ? AND f.copied_at IS NOT NULL ORDER BY v.n DESC LIMIT 1")
    .get(c, v.asset_id) as { rel_path: string; n: number } | undefined;
  if (!top) return { rel: relFor(v.asset_id, v.id) };
  return top.n > v.n ? { rel: versionRel(top.rel_path, v.n) } : { rel: top.rel_path, prev: top.rel_path };
}

/** The version's SHA-256: its own, else one a computer measured on the whole file (a file indexed on a Mac has a quick one). */
function shaOf(v: { id: string; sha256: string }): string | undefined {
  if (!v.sha256.startsWith("mac:")) return v.sha256;
  return (
    db()
      .prepare(
        `SELECT sha256 FROM copy_sends WHERE version_id = ? AND sha256 IS NOT NULL
         UNION ALL SELECT sha256 FROM copy_files WHERE version_id = ? AND copied_at IS NOT NULL AND sha256 IS NOT NULL LIMIT 1`,
      )
      .get(v.id, v.id) as { sha256: string } | undefined
  )?.sha256;
}

/** Whether computer `device` holds a job now (a quiet one's place is free; its late answer is still taken). */
const busy = (device: string, now = Date.now()) => {
  for (const [id, h] of held) {
    if (now - h.at > KEEP_HELD_MS) held.delete(id);
    else if (h.device === device && now - h.at <= LEASE_MS) return true;
  }
  return false;
};

const copiesOn = (device: string, now: number) =>
  db().prepare("SELECT * FROM library_copies WHERE device = ? AND (retry_at IS NULL OR retry_at <= ?) ORDER BY created_at, id").all(device, now) as CopyRow[];

type Next = Omit<Held, "id" | "at"> & { options: Record<string, string> };

/** The next job for computer `d`, without taking it: its own copies' first, then a file another computer's copy needs from it. */
function nextFor(d: { id: string; owner: string }, now = Date.now()): Next | null {
  if (busy(d.id, now)) return null;
  for (const c of copiesOn(d.id, now)) {
    if (libraryRole(d.owner, c.library_id) !== "owner") continue;
    const base = { device: d.id, copy: c.id, library: c.library_id, root: c.path, ...(c.state === "new" ? { init: "1" } : {}) };
    // a new copy writes its marker first; then once a day each file is checked to be there still
    if (c.state === "new" || (c.checked_at ?? 0) < now - CHECK_MS) return { device: d.id, copy: c.id, key: null, options: { op: "check", ...base } };
    const got = nextCopy(c, now);
    if (got) {
      const { v, paths } = got;
      const at = placeIn(c.id, v);
      const sha = shaOf(v);
      return {
        device: d.id,
        copy: c.id,
        key: v.id,
        options: {
          op: "copy",
          ...base,
          key: v.id,
          asset: v.asset_id,
          n: String(v.n),
          rel: at.rel,
          ...(at.prev ? { prev: at.prev } : {}),
          size: String(v.bytes),
          ...(sha ? { sha256: sha } : {}),
          paths: JSON.stringify(paths),
          ...(v.here ? { url: "" } : {}),
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
        options: { op: "copy", ...base, key: item.key, asset: item.asset, n: "1", rel: item.rel, size: String(item.size), ...(item.sha256 ? { sha256: item.sha256 } : {}), paths: "[]", url: "" },
      };
  }
  const s = nextSend(d.id, now);
  if (s) return { device: d.id, copy: s.v.copy, key: s.v.id, send: true, options: { op: "send", device: d.id, key: s.v.id, size: String(s.v.bytes), paths: JSON.stringify(s.paths), url: "" } };
  return null;
}

/** Tells the computers of the copies of a version's library that it waits (it came in, or is ready now). */
export function copiesWake(versionId: string): void {
  const any = db()
    .prepare("SELECT 1 FROM library_copies c JOIN assets a ON a.library_id = c.library_id JOIN asset_versions v ON v.asset_id = a.id WHERE v.id = ? LIMIT 1")
    .get(versionId);
  if (any) void wakeEditorPolls();
}

/** Job `id` of computer `device`, however long it was quiet: a late answer is still the truth about the folder. */
const heldBy = (device: string, id: number) => {
  const h = held.get(id);
  return h && h.device === device ? h : undefined;
};

/** Ends job `h`: the computer is heard from, its free space kept, and the copy's page told. */
function end(h: Held, set: { state?: LibraryCopy["state"]; free?: unknown; retry?: number; checked?: true }) {
  held.delete(h.id);
  const now = Date.now();
  const lib = (db().prepare("SELECT library_id FROM library_copies WHERE id = ?").get(h.copy) as { library_id: string } | undefined)?.library_id;
  if (!h.send) {
    const free = Number.isSafeInteger(set.free) && (set.free as number) >= 0 ? (set.free as number) : null;
    db()
      .prepare(
        `UPDATE library_copies SET last_seen = ?, notice_at = NULL, free_bytes = COALESCE(?, free_bytes), state = COALESCE(?, state), retry_at = ?,
           checked_at = CASE WHEN ? THEN ? ELSE checked_at END WHERE id = ?`,
      )
      .run(now, free, set.state ?? null, set.retry ? now + set.retry : null, set.checked ? 1 : 0, now, h.copy);
  }
  if (lib) libraryChanged(lib);
}

/** A path inside the copy's folder, as the computer sent it: relative, no `..`, no empty part. */
const isRel = (p: unknown): p is string =>
  typeof p === "string" && p.length > 0 && p.length <= 1000 && !/[\0\n\r\\]/.test(p) && !p.startsWith("/") && !p.split("/").some((s) => !s || s === "." || s === "..");

const sha256Of = (file: string) =>
  new Promise<string>((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (b) => h.update(b))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });

/** The device job road's side of it (api/devices.ts lists it with the app's own). */
export const copyJob: DeviceJobSlot = {
  kind: COPY_KIND,
  waits: (owner, device) => !!nextFor({ id: device, owner }),
  claim: (d): DeviceJob | null => {
    const next = nextFor(d);
    if (!next) return null;
    let id: number;
    do id = randomInt(1, 2 ** 31 - 1);
    while (held.has(id));
    const { options, ...h } = next;
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
      // a job that went quiet is the computer's again unless it took another meanwhile
      if (Date.now() - h.at > LEASE_MS && busy(device)) return { error: "Not found", status: 404 };
      h.at = Date.now();
      return { reply: {} };
    }
    if (h.send) return { error: "Send the original's bytes to the job's url", status: 400 };
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
    // a copy stopped meanwhile keeps no record
    if (!db().prepare("SELECT 1 FROM library_copies WHERE id = ?").get(h.copy)) {
      held.delete(h.id);
      return { error: "Not found", status: 404 };
    }
    const row = h.item ? undefined : (db().prepare("SELECT id, bytes, sha256 FROM asset_versions WHERE id = ?").get(h.key) as { id: string; bytes: number; sha256: string } | undefined);
    const v = h.item ? { bytes: h.item.size, sha256: h.item.sha256 } : row && { bytes: row.bytes, sha256: shaOf(row) };
    if (!v) return { error: "Not found", status: 404 };
    const sha = typeof done.sha256 === "string" ? done.sha256.toLowerCase() : "";
    // never a proxy or a part in place of the original: its size, and its hash where one is known
    if (done.size !== v.bytes || (v.sha256 && sha !== v.sha256)) return { error: "This is not the same file: copy it again.", status: 409 };
    const now = Date.now();
    db()
      .prepare(
        `INSERT INTO copy_files (copy_id, version_id, rel_path, size, sha256, copied_at, error, tried_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT (copy_id, version_id) DO UPDATE SET rel_path = excluded.rel_path, size = excluded.size, sha256 = excluded.sha256, copied_at = excluded.copied_at, error = NULL, tried_at = excluded.tried_at`,
      )
      .run(h.copy, h.key, done.rel, v.bytes, sha || null, now, now);
    const c = db().prepare("SELECT path FROM library_copies WHERE id = ?").get(h.copy) as { path: string } | undefined;
    // the copy is the clip on that computer too: On this computer, Show in Finder and playing the original there find
    // it (a place it has there already stays; one its last look found gone is the copy now)
    if (c && !h.item)
      db()
        .prepare(
          `INSERT INTO version_places (version_id, device, path, bytes, sha256, confirmed_at, checked_at, state, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'copy')
           ON CONFLICT (version_id, device, kind, folder_id) DO UPDATE SET path = excluded.path, bytes = excluded.bytes, sha256 = excluded.sha256, confirmed_at = excluded.confirmed_at,
             checked_at = excluded.checked_at, state = excluded.state, gone_at = NULL WHERE gone_at IS NOT NULL OR state <> 'verified'`,
        )
        // a copy the computer hashed as it wrote it is verified there; without its sha256 it is only found (whereis.ts)
        .run(h.key, device, path.posix.join(c.path, done.rel), v.bytes, sha || null, now, now, sha ? "verified" : "found");
    end(h, { state: "ok", free: b.free });
    // an original a computer sent that every copy has now goes
    if (!h.item) void dropSent(h.key).catch((e: unknown) => console.error("[library] copies:", e));
    void wakeEditorPolls();
    return { reply: {} };
  },
  // a send's answer: the original's bytes, checked against the version and kept until every copy has it
  file: async (device, id, file) => {
    const h = heldBy(device, id);
    if (!h?.send || !h.key) return { error: "Not found", status: 404 };
    const v = db().prepare("SELECT v.id, v.bytes, v.sha256, a.library_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(h.key) as
      | { id: string; bytes: number; sha256: string; library_id: string }
      | undefined;
    if (!v) {
      held.delete(h.id);
      return { error: "Not found", status: 404 };
    }
    const size = (await stat(file)).size;
    const sha = await sha256Of(file);
    const want = shaOf(v);
    if (size !== v.bytes || (want && sha !== want)) return { error: "This is not the same file: send it again.", status: 409 };
    const key = `libraries/${v.library_id}/v/${v.id}/copy-source`;
    await blobs.put(key, file);
    const now = Date.now();
    db()
      .prepare(
        `INSERT INTO copy_sends (version_id, storage_key, bytes, sha256, error, tried_at, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?)
         ON CONFLICT (version_id) DO UPDATE SET storage_key = excluded.storage_key, bytes = excluded.bytes, sha256 = excluded.sha256, error = NULL, tried_at = excluded.tried_at`,
      )
      .run(v.id, key, size, sha, now, now);
    end(h, {});
    void wakeEditorPolls();
    return { reply: {} };
  },
  fail: (device, id, why) => {
    const h = heldBy(device, id);
    if (!h) return false;
    const now = Date.now();
    if (h.send)
      db()
        .prepare(
          `INSERT INTO copy_sends (version_id, error, tried_at, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (version_id) DO UPDATE SET error = excluded.error, tried_at = excluded.tried_at`,
        )
        .run(h.key, why.slice(0, 300), now, now);
    else if (h.key !== null)
      db()
        .prepare(
          `INSERT INTO copy_files (copy_id, version_id, error, tried_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (copy_id, version_id) DO UPDATE SET error = excluded.error, tried_at = excluded.tried_at`,
        )
        .run(h.copy, h.key, why.slice(0, 300), now);
    end(h, h.key === null ? { retry: STATE_RETRY_MS } : {});
    return true;
  },
};

/**
 * The file of job `id` for the computer that holds it (GET /api/devices/relay/job/copy/:id/file): the version's stored
 * original or the one another computer sent, or a plug-in's file opened for the library's owner. Null when the computer
 * holds no such job.
 */
export async function copyFile(device: string, id: number): Promise<{ key: string } | { open: (req: Request) => Promise<Response | null> } | null> {
  const h = heldBy(device, id);
  if (!h || h.key === null || h.send) return null;
  if (h.item) {
    const c = db().prepare("SELECT library_id FROM library_copies WHERE id = ?").get(h.copy) as { library_id: string } | undefined;
    const owner = deviceOf(device)?.owner;
    const src = pluginCopySources().find((s) => s.items(c?.library_id ?? "").some((i) => i.key === h.key));
    if (!c || !owner || !src || libraryRole(owner, c.library_id) !== "owner") return null;
    return { open: (req) => src.open(owner, h.key!, req) };
  }
  const v = db()
    .prepare(`SELECT CASE WHEN ${STORED} THEN v.source_key ELSE (SELECT s.storage_key FROM copy_sends s WHERE s.version_id = v.id) END AS k FROM asset_versions v WHERE v.id = ?`)
    .get(h.key) as { k: string | null } | undefined;
  return v?.k ? { key: v.k } : null;
}

/** Tells a library's owner once when a copy has taken nothing for two weeks while the server keeps files for it (trash.ts, hourly). */
export async function copiesNotice(now = Date.now()): Promise<void> {
  const rows = db()
    .prepare("SELECT c.id, c.device, c.library_id, l.workspace_id FROM library_copies c JOIN libraries l ON l.id = c.library_id WHERE c.notice_at IS NULL AND COALESCE(c.last_seen, c.created_at) < ?")
    .all(now - NOTICE_MS) as { id: string; device: string; library_id: string; workspace_id: string }[];
  for (const c of rows) {
    if (!db().prepare(`SELECT 1 ${WANTED} AND ${HERE} AND NOT ${has("?")} LIMIT 1`).get(c.library_id, c.id)) continue;
    db().prepare("UPDATE library_copies SET notice_at = ? WHERE id = ?").run(now, c.id);
    const owner = accountOf(c.workspace_id);
    if (!owner) continue;
    const { notifyWorkshopOwner } = await import("../review");
    await notifyWorkshopOwner(owner, {
      kind: "waiting",
      by: "Media Library",
      name: "Copies",
      text: `Nothing copied to ${deviceOf(c.device)?.name ?? "a removed computer"} for 14 days: the server keeps those files until then, or until Stop copying.`,
      href: "/settings/library",
      ref: c.id,
    });
  }
}

/* ---- Settings → Media Library → Copies ---- */

export const copiesApp = new Hono<{ Variables: AuthVars }>();

/** A computer's name as `viewer` may read it: their own computer's, else "another computer" or "Removed computer". */
const nameFor = (device: string, viewer: string) => {
  const d = deviceOf(device);
  return !d ? "Removed computer" : d.owner === viewer ? d.name : "another computer";
};

/** The library's copies as the card lists them: the app's own, then any a plug-in's copier keeps. */
async function listCopies(libraryId: string, viewer: string): Promise<LibraryCopy[]> {
  const now = Date.now();
  const rows = db().prepare("SELECT * FROM library_copies WHERE library_id = ? ORDER BY created_at, id").all(libraryId) as CopyRow[];
  const own = rows.map((c): LibraryCopy => {
    const d = deviceOf(c.device);
    const lacks = `${WANTED} AND NOT ${has("?")}`;
    const pending = (db().prepare(`SELECT count(*) AS n ${lacks}`).get(libraryId, c.id) as { n: number }).n + lackingItems(c, Number.MAX_SAFE_INTEGER).length;
    let waitsFor: string | undefined;
    let needsUpload = false;
    let noOriginal = 0;
    if (pending) {
      // files whose original is nowhere: not here, on no computer, on no disk
      noOriginal = (
        db()
          .prepare(`SELECT count(*) AS n ${lacks} AND NOT ${HERE} AND v.mac_path IS NULL AND v.root IS NULL AND NOT EXISTS (SELECT 1 FROM version_places p WHERE p.version_id = v.id AND p.gone_at IS NULL)`)
          .get(libraryId, c.id) as { n: number }
      ).n;
      // files only another computer holds: while it is offline the first one is named; online, it sends them, where the
      // library uploads originals (else the copy needs Upload to the server)
      const holders = db()
        .prepare(
          `SELECT DISTINCT id, h FROM (SELECT v.id, v.mac_device AS h ${lacks} AND NOT ${HERE} AND v.mac_device IS NOT NULL
             UNION ALL SELECT p.version_id AS id, p.device AS h FROM version_places p WHERE p.gone_at IS NULL AND p.version_id IN (SELECT v.id ${lacks} AND NOT ${HERE})) WHERE h != ? LIMIT 50`,
        )
        .all(libraryId, c.id, libraryId, c.id, c.device) as { id: string; h: string }[];
      const away = holders.find((x) => !isOnline(x.h));
      if (away) waitsFor = nameFor(away.h, viewer);
      needsUpload = holders.some((x) => isOnline(x.h) && versionUpload(x.id) !== "all");
    }
    const online = isOnline(c.device);
    return {
      id: c.id,
      device: c.device,
      computer: d?.name ?? "Removed computer",
      path: c.path,
      pending,
      copying: [...held.values()].some((h) => h.copy === c.id && !h.send && h.key !== null && now - h.at <= LEASE_MS),
      state: c.state,
      ...(!online ? { offlineSince: d?.lastSeen ?? c.last_seen ?? c.created_at } : {}),
      ...(waitsFor ? { waitsFor } : {}),
      ...(needsUpload ? { needsUpload: true as const } : {}),
      ...(noOriginal ? { noOriginal } : {}),
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
  return c.json({ copies: await listCopies(id, c.get("user").username) });
});

// POST /api/library/:id/copies { device, path } → { copy }: a folder on one of the owner's computers
copiesApp.post("/:id/copies", async (c) => {
  const id = c.req.param("id");
  const { username } = c.get("user");
  if (!owned(username, id)) return c.json({ error: "Not found", code: "not_found" }, 404);
  const b = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const d = ownComputer(username, b.device);
  if (!d) return c.json({ error: "Not your computer", code: "forbidden" }, 403);
  const raw = typeof b.path === "string" ? b.path : "";
  if (!raw.startsWith("/") || raw.length > 1000 || /[\0\n\r]/.test(raw) || raw.split("/").includes("..")) return c.json({ error: "Pick a folder", code: "invalid" }, 400);
  // one spelling a folder: "/Volumes//A/" and "/Volumes/A" are the same copy
  const folder = path.posix.normalize(raw).replace(/\/+$/, "").normalize("NFC");
  if (!folder || folder === "/Volumes") return c.json({ error: "Pick a folder", code: "invalid" }, 400);
  if (db().prepare("SELECT 1 FROM library_copies WHERE device = ? AND path = ?").get(d.id, folder)) return c.json({ error: "That folder holds a copy already", code: "conflict" }, 409);
  const copyId = `cp_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  db().prepare("INSERT INTO library_copies (id, library_id, device, path, created_at) VALUES (?, ?, ?, ?, ?)").run(copyId, id, d.id, folder, Date.now());
  void wakeEditorPolls();
  return c.json({ copy: (await listCopies(id, username)).find((x) => x.id === copyId) });
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
  // the originals computers sent for it go now
  for (const v of db().prepare(`SELECT v.id ${WANTED} AND ${SENT}`).all(id) as { id: string }[]) await dropSent(v.id).catch(() => undefined);
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
    console.error("[library] copies folders:", e);
    return c.json({ error: "That computer did not answer. Try again.", code: "unavailable" }, 503);
  }
});
