import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, realpath, rm, stat, symlink } from "node:fs/promises";
import path from "node:path";
import type { AuthVars } from "../auth";
import type { WatchFolder, WatchStatus } from "../../contracts/library";
import { env } from "../lib/env";
import { freeBytes, sha256File } from "../lib/uploads";
import { libraryRole } from "./access";
import { blobs, libraryDb } from "./db";
import { enqueueJob } from "./jobs";
import { kindOf, recordVersion } from "./routes";

/**
 * Watch folders (tasks/media-library-plan.md, section 4): folders on the server's own disk whose new files join a
 * library. Only where the server runs on the user's own computer: a hosted server cannot see the user's folders
 * (watchAllowed). The workspace owner sets them in `settings.watch`; files come in as that owner's.
 *
 * Every 30 s (fs.watch misses changes on external drives) each folder is walked. A file is imported once its size
 * and mtime have stayed the same for 60 s across scans (mtime alone lies: a copy keeps the original's). `watch_seen`
 * remembers each path's size and mtime, so an unchanged file is never imported twice, even after it is trashed.
 * `reference` leaves the file where it is (the blob key is a link to it, `source_path` names it); `copy` stores a
 * copy like an upload. A referenced file that disappears marks its version `missing`; nothing is deleted, and the
 * version comes back when the file does (an external drive plugged in again).
 */

export const watchApp = new Hono<{ Variables: AuthVars }>();

const SCAN_MS = 30_000;
export const SETTLE_MS = 60_000;
const MAX_FOLDERS = 20;
const GiB = 1024 ** 3;
const db = () => libraryDb();
const stagingDir = () => path.join(env.dataDir, "library", "staging");

/** Whether this server may watch folders: LIBRARY_WATCH_FOLDERS=1 or 0, else only an open server (no APP_SECRET), one person's own machine. */
export function watchAllowed(): boolean {
  const v = process.env.LIBRARY_WATCH_FOLDERS?.trim();
  return v === "1" ? true : v === "0" ? false : !process.env.APP_SECRET;
}

const foldersOf = (libraryId: string): WatchFolder[] => {
  const row = db().prepare("SELECT json_extract(settings, '$.watch') AS w FROM libraries WHERE id = ?").get(libraryId) as { w: string | null } | undefined;
  const list = JSON.parse(row?.w ?? "[]") as unknown;
  return Array.isArray(list) ? (list as WatchFolder[]) : [];
};

const inside = (child: string, parent: string) => {
  const r = path.relative(parent, child);
  return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
};

/** A folder as stored, or the reason it is refused: an existing directory on this disk, outside the app's own data. */
async function checkFolder(libraryId: string, raw: unknown, by: string): Promise<WatchFolder | string> {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const given = typeof r.path === "string" ? r.path.trim() : "";
  if (!path.isAbsolute(given)) return `Not a full path: ${given || "(empty)"}`;
  const real = await realpath(given).catch(() => null);
  if (!real || !(await stat(real)).isDirectory()) return `No such folder on the server: ${given}`;
  const data = await realpath(env.dataDir).catch(() => path.resolve(env.dataDir));
  if (inside(real, data) || inside(data, real)) return `That folder holds the app's own data: ${given}`;
  const mode = r.mode === "copy" ? "copy" : r.mode === "reference" || r.mode === undefined ? "reference" : null;
  if (!mode) return "Mode is reference or copy";
  // a bucket can't hold a link to a file on this disk (usage.ts refuses the switch the other way round)
  if (mode === "reference" && (db().prepare("SELECT storage_kind FROM libraries WHERE id = ?").get(libraryId) as { storage_kind: string }).storage_kind !== "local") {
    return "This library keeps its files in a bucket: choose copy";
  }
  const collectionId = typeof r.collectionId === "string" && r.collectionId ? r.collectionId : undefined;
  if (collectionId && !db().prepare("SELECT 1 FROM collections WHERE id = ? AND library_id = ? AND kind = 'manual'").get(collectionId, libraryId)) {
    return "That folder is not in this library";
  }
  return { path: real, mode, ...(collectionId ? { collectionId } : {}), addedBy: by };
}

function status(libraryId: string): WatchStatus {
  const folders = foldersOf(libraryId).map((f) => ({
    ...f,
    found: false,
    imported: (
      db()
        .prepare("SELECT COUNT(*) AS n FROM watch_seen WHERE library_id = ? AND version_id IS NOT NULL AND substr(path, 1, ?) = ?")
        .get(libraryId, f.path.length + 1, f.path + path.sep) as { n: number }
    ).n,
  }));
  const missing = (
    db()
      .prepare("SELECT COUNT(*) AS n FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE a.library_id = ? AND v.state = 'missing'")
      .get(libraryId) as { n: number }
  ).n;
  return { allowed: watchAllowed(), folders, missing };
}

const withFound = async (s: WatchStatus): Promise<WatchStatus> => ({
  ...s,
  folders: await Promise.all(s.folders.map(async (f) => ({ ...f, found: !!(await stat(f.path).catch(() => null))?.isDirectory() }))),
});

// GET /api/library/:id/watch → WatchStatus. The owner only: paths on the server are theirs to see.
watchApp.get("/:id/watch", async (c) => {
  const role = libraryRole(c.get("user").username, c.req.param("id"));
  if (!role) return c.json({ error: "Not found", code: "not_found" }, 404);
  return c.json(await withFound(status(c.req.param("id"))));
});

// PUT /api/library/:id/watch { folders: [{ path, mode, collectionId? }] } → WatchStatus. Replaces the list; refused on a hosted server.
watchApp.put("/:id/watch", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  const role = libraryRole(user.username, libraryId);
  if (!role) return c.json({ error: "Not found", code: "not_found" }, 404);
  if (!watchAllowed()) {
    return c.json({ error: "This server is not on your computer, so it cannot watch your folders. Upload the files instead.", code: "forbidden" }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as { folders?: unknown } | null;
  if (!Array.isArray(body?.folders) || body.folders.length > MAX_FOLDERS) return c.json({ error: `A list of up to ${MAX_FOLDERS} folders`, code: "invalid" }, 400);
  const folders: WatchFolder[] = [];
  for (const raw of body.folders) {
    const f = await checkFolder(libraryId, raw, user.username);
    if (typeof f === "string") return c.json({ error: f, code: "invalid" }, 400);
    if (!folders.some((g) => g.path === f.path)) folders.push(f);
  }
  // only this key: other settings (transcription and the rest) are written by other code
  db().prepare("UPDATE libraries SET settings = json_set(settings, '$.watch', json(?)) WHERE id = ?").run(JSON.stringify(folders), libraryId);
  return c.json(await withFound(status(libraryId)));
});

// ---- the scan ----------------------------------------------------------------------------------------------------

// files seen changing, by library and path: imported once unchanged for SETTLE_MS. In memory: a restart waits again.
const pending = new Map<string, { size: number; mtime: number; since: number }>();

/** Media files under a folder: no hidden files or folders (.DS_Store, ._ files on external drives), no links. */
async function filesIn(root: string): Promise<string[]> {
  const all = await readdir(root, { recursive: true, withFileTypes: true });
  return all
    .filter((e) => e.isFile() && kindOf(e.name) !== "doc")
    .map((e) => path.join(e.parentPath, e.name))
    .filter((p) => !path.relative(root, p).split(path.sep).some((s) => s.startsWith(".")));
}

/** One file into the library: a new asset, or version n+1 of the asset this path made before. Returns the version id. */
async function ingest(libraryId: string, f: WatchFolder, file: string, size: number, priorVersion: string | null): Promise<string> {
  await mkdir(stagingDir(), { recursive: true });
  const staged = path.join(stagingDir(), `watch-${randomUUID()}`);
  try {
    let sha256: string;
    if (f.mode === "copy") {
      const raw = process.env.LIBRARY_DISK_RESERVE_GB?.trim();
      const reserve = raw && Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Number(raw) : 20; // as routes.ts reads it
      if ((await freeBytes(stagingDir())) - size < reserve * GiB) throw new Error("Not enough free disk space to copy it");
      await copyFile(file, staged);
      sha256 = await sha256File(staged);
    } else {
      sha256 = await sha256File(file);
    }
    const dup = db()
      .prepare(
        `SELECT v.id FROM asset_versions v JOIN assets a ON a.id = v.asset_id
         WHERE a.library_id = ? AND v.sha256 = ? AND a.trashed_at IS NULL ORDER BY v.created_at LIMIT 1`,
      )
      .get(libraryId, sha256) as { id: string } | undefined;
    if (dup) return dup.id; // already in the library (a browser upload of it, or the same file in another folder)

    const prior = priorVersion
      ? (db()
          .prepare("SELECT a.id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ? AND a.library_id = ? AND a.trashed_at IS NULL")
          .get(priorVersion, libraryId) as { id: string } | undefined)
      : undefined;
    const versionId = randomUUID();
    const sourceKey = `libraries/${libraryId}/v/${versionId}/source`;
    // ponytail: reference = a link under the blob key, so the worker and media routes read it like any blob; a remote
    // store (S3) can't hold a link, and hosted servers don't watch folders
    if (f.mode === "reference") await symlink(file, staged);
    await blobs.put(sourceKey, staged); // a rename: same disk as the blobs
    const d = db();
    d.exec("BEGIN");
    try {
      recordVersion(d, {
        libraryId,
        assetId: prior?.id,
        versionId,
        sourceKey,
        sourcePath: f.mode === "reference" ? file : null,
        filename: file,
        size,
        sha256,
        by: f.addedBy,
        collectionId: prior ? null : f.collectionId, // a new version stays where the asset is
      });
      d.exec("COMMIT");
    } catch (e) {
      d.exec("ROLLBACK");
      await blobs.delete(sourceKey);
      throw e;
    }
    return versionId;
  } finally {
    await rm(staged, { force: true });
  }
}

/** One pass over a library's watch folders. Returns how many files it took in (new versions or known duplicates). */
async function scanLibrary(libraryId: string, now: number): Promise<number> {
  let took = 0;
  for (const f of foldersOf(libraryId)) {
    // files come in as the owner who added the folder, while the library is still theirs; never as anyone else
    if (!libraryRole(f.addedBy, libraryId)) continue;
    let files: string[];
    try {
      files = await filesIn(f.path);
    } catch {
      continue; // unplugged or unreadable: its referenced files turn missing in refreshMissing
    }
    for (const file of files) {
      const s = await stat(file).catch(() => null);
      if (!s) continue;
      const size = s.size;
      const mtime = Math.floor(s.mtimeMs);
      const seen = db().prepare("SELECT size, mtime, version_id FROM watch_seen WHERE library_id = ? AND path = ?").get(libraryId, file) as
        | { size: number; mtime: number; version_id: string | null }
        | undefined;
      const key = `${libraryId}\0${file}`;
      if (seen && seen.size === size && seen.mtime === mtime) {
        pending.delete(key);
        continue;
      }
      const p = pending.get(key);
      if (!p || p.size !== size || p.mtime !== mtime) {
        pending.set(key, { size, mtime, since: now });
        continue;
      }
      if (now - p.since < SETTLE_MS || size === 0) continue;
      pending.delete(key);
      try {
        const versionId = await ingest(libraryId, f, file, size, seen?.version_id ?? null);
        db()
          .prepare(
            `INSERT INTO watch_seen (library_id, path, size, mtime, version_id) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (library_id, path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, version_id = excluded.version_id`,
          )
          .run(libraryId, file, size, mtime, versionId);
        took++;
      } catch (e) {
        console.error("[library] watch:", file, e instanceof Error ? e.message : e); // tried again once it settles again
      }
    }
  }
  return took;
}

/**
 * Referenced originals that went away turn `missing`; ones that came back return to `ready`, or to `processing` with
 * their failed jobs queued again (the worker fails a job whose file is gone). Rows and files are never deleted here.
 */
async function refreshMissing(): Promise<void> {
  const refs = db()
    .prepare("SELECT v.id, v.state, v.source_path, v.created_by, a.library_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.source_path IS NOT NULL")
    .all() as { id: string; state: string; source_path: string; created_by: string; library_id: string }[];
  for (const v of refs) {
    const there = !!(await stat(v.source_path).catch(() => null));
    if (!there && v.state !== "missing") db().prepare("UPDATE asset_versions SET state = 'missing' WHERE id = ?").run(v.id);
    if (there && v.state === "missing") {
      const jobs = db().prepare("SELECT kind, state, actor FROM jobs WHERE version_id = ?").all(v.id) as { kind: string; state: string; actor: string | null }[];
      for (const j of jobs) if (j.state === "failed") enqueueJob(db(), v.library_id, v.id, j.kind, j.actor);
      if (!jobs.length) enqueueJob(db(), v.library_id, v.id, "probe", v.created_by);
      // done and needs_key jobs don't hold a version back; the worker sets `ready` when the rest are through
      const open = !jobs.length || jobs.some((j) => j.state === "failed" || j.state === "queued" || j.state === "running");
      db().prepare("UPDATE asset_versions SET state = ? WHERE id = ?").run(open ? "processing" : "ready", v.id);
    }
  }
}

/** One scan of every library's watch folders, then the missing check. Returns how many files came in. */
export async function scanWatchFolders(now = Date.now()): Promise<number> {
  if (!watchAllowed()) return 0;
  const libs = db().prepare("SELECT id FROM libraries WHERE json_array_length(settings, '$.watch') > 0").all() as { id: string }[];
  let took = 0;
  // ponytail: one file at a time, outside the job queue (an ingest has no version yet); per-library workers if it lags
  for (const l of libs) took += await scanLibrary(l.id, now);
  // ponytail: stats every referenced file each pass; fine to tens of thousands, batch by folder past that
  await refreshMissing();
  return took;
}

/** Scans now and every 30 s after the last scan ends (never two at once). Does nothing on a server that may not watch. */
export function startWatchFolders(): void {
  if (!watchAllowed()) return;
  const loop = async () => {
    try {
      await scanWatchFolders();
    } catch (e) {
      console.error("[library] watch:", e);
    }
    setTimeout(loop, SCAN_MS).unref();
  };
  void loop();
}
