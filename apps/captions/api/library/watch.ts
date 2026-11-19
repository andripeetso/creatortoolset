import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants, copyFile, link, mkdir, readdir, readFile, realpath, rename, rm, stat, symlink, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AuthVars } from "../auth";
import { LIBRARY_WORDS, type WatchFolder, type WatchStatus } from "../../contracts/library";
import { env, hostedMode } from "../lib/env";
import { freeBytes, sha256File } from "../lib/uploads";
import { ensureLibrary, librariesHere, libraryChanged, libraryRole } from "./access";
import { blobs, libraryDb } from "./db";
import { enqueueJob, folderWalks, takingClips, watchedFolders } from "./jobs";
import { kindOf, recordVersion } from "./routes";
import { librariesOf } from "./report";
import { pointSource } from "./locate";
import { findUser } from "../users";
import { isThisMachine, listDevices } from "../lib/devices";
import { parseStorageFile, storageFilePath } from "../lib/storage";
import { changeStorage } from "../devices-storage";
import { editorDirsOf, LIBRARY_NAME, LIBRARY_SUBFOLDERS, notFootage, sourcesOf, THIS_COMPUTER, type StorageFolder } from "../../contracts/storage";

// shortcut: copying files into Source media (copyTo) is not read from the rows yet; it refuses until the copy task lands
const IN_PLACE_ONLY = "Only folders read where they are can be added for now: copying into Source media is not on yet";

/**
 * Watch folders (tasks/media-library-plan.md, section 4): folders on the server's own disk whose new files join a
 * library. Only where the server runs on the user's own computer: a hosted server cannot see the user's folders
 * (watchAllowed). A folder is a Source media row of the account's computer (its storage file, the one folder list);
 * files come in as that owner's. Finals watches stay in `settings.watch`.
 *
 * Every 30 s (fs.watch misses changes on external drives) each folder is walked, and at once when a folder is added
 * (scanSoon). A file is imported once its size and mtime have stayed the same across scans: for 60 s when it was
 * written in the last minute (a camera card still copying), for 5 s when it is older (footage already in a folder the
 * person just chose; mtime alone lies, a copy keeps the original's, so the size is still watched). Each file shows on
 * the open pages as it is taken, not when the whole pass ends, and the status says how many are still to come. While
 * a pass takes files the library's slower steps wait (worker.ts), so every clip is in, with its picture, before them.
 * `watch_seen` remembers each path's size and mtime, so an unchanged file is never imported twice, even after it is trashed.
 * `reference` leaves the file where it is (the blob key is a link to it, `source_path` names it); with `copyTo` each file
 * is first copied into that folder on this disk (subfolders kept, never over another file) and the copy is read in place
 * (copyInto); `copy` stores a copy like an upload (a library whose originals are in a bucket). A referenced file that disappears marks its version `missing`; nothing is deleted, and the
 * version comes back when the file does (an external drive plugged in again).
 */

export const watchApp = new Hono<{ Variables: AuthVars }>();

const SCAN_MS = 30_000;
export const SETTLE_MS = 60_000;
/** The wait for a file last written more than SETTLE_MS ago: long enough to see a copy still growing. */
export const QUICK_SETTLE_MS = 5_000;
const MAX_FOLDERS = 20;
const GiB = 1024 ** 3;
const db = () => libraryDb();
const stagingDir = () => path.join(env.dataDir, "library", "staging");

/**
 * Whether this server may watch folders: LIBRARY_WATCH_FOLDERS=1 or 0, else only on one person's own machine, never
 * hosted: a local server with no APP_SECRET, or the Mac app's server (CT_LOCAL=1, which always has an APP_SECRET) for
 * the computer's own account (its admin). Another account on that Mac never reads its disk. No `username`: the
 * machine-level answer, for display.
 */
export function watchAllowed(username?: string): boolean {
  const v = process.env.LIBRARY_WATCH_FOLDERS?.trim();
  if (v === "1" || v === "0") return v === "1";
  if (hostedMode()) return false;
  if (!process.env.APP_SECRET) return true;
  return process.env.CT_LOCAL === "1" && (username === undefined || findUser(username)?.role === "admin");
}

const foldersOf = (libraryId: string): WatchFolder[] => {
  const row = db().prepare("SELECT json_extract(settings, '$.watch') AS w FROM libraries WHERE id = ?").get(libraryId) as { w: string | null } | undefined;
  const list = JSON.parse(row?.w ?? "[]") as unknown;
  return Array.isArray(list) ? (list as WatchFolder[]) : [];
};

/** The Finals folders of a library (settings.watch entries with projects, written by watchFinals): the only ones read from there. */
const finalsOf = (libraryId: string): WatchFolder[] => foldersOf(libraryId).filter((f) => f.projects);

const onThisComputer = (f: StorageFolder) => f.origin.host === THIS_COMPUTER || isThisMachine(f.origin.host);

/** The device id this computer's rows are stored under (as the storage routes write them), else THIS_COMPUTER. */
const hostHere = (username: string) => listDevices((d) => d.owner === username && isThisMachine(d.id))[0]?.id ?? THIS_COMPUTER;

/**
 * One account's Source media rows on this computer, by the library each one fills (a member's locate-only library gets
 * none). Read in place, as mode "reference". `make`: the scan may make a workspace's library; a read (a GET) does not.
 */
async function footageOf(username: string, make: boolean): Promise<Map<string, WatchFolder[]>> {
  const out = new Map<string, WatchFolder[]>();
  if (!watchAllowed(username)) return out;
  const st = parseStorageFile(await readFile(storageFilePath(env.dataDir, username), "utf-8").catch(() => "{}"));
  for (const f of st.folders) {
    if (f.role !== "footage" || !onThisComputer(f)) continue;
    for (const lib of await librariesOf(username, f, make)) {
      if (lib.locate) continue;
      out.set(lib.id, [...(out.get(lib.id) ?? []), { path: expandHome(f.origin.path), mode: "reference", addedBy: username }]);
    }
  }
  return out;
}

/** Every account's Source media rows on this server's computer, by library: what the scan reads. */
async function footageByLibrary(make: boolean): Promise<Map<string, WatchFolder[]>> {
  const out = new Map<string, WatchFolder[]>();
  const files = await readdir(path.join(env.dataDir, "storage")).catch(() => [] as string[]);
  for (const file of files.filter((n) => n.endsWith(".json"))) {
    for (const [id, list] of await footageOf(file.slice(0, -".json".length), make)) out.set(id, [...(out.get(id) ?? []), ...list]);
  }
  return out;
}

/** The library's folders read in place, of every account (usage.ts: a bucket can't keep them). */
export async function footageIn(libraryId: string): Promise<WatchFolder[]> {
  return (await footageByLibrary(false)).get(libraryId) ?? [];
}

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
  if (!real || !(await stat(real)).isDirectory()) return `Folder not found on the server: ${given}`;
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
  let copyTo: string | undefined;
  if (typeof r.copyTo === "string" && r.copyTo.trim() && mode === "reference") {
    const to = await copyTarget(real, r.copyTo, data);
    if (typeof to !== "string") return to.error;
    copyTo = to;
  }
  return { path: real, mode, ...(collectionId ? { collectionId } : {}), ...(copyTo ? { copyTo } : {}), addedBy: by };
}

/**
 * The folder a chosen folder's files are copied into, made now and as its real path; they go in a folder of the chosen
 * folder's own name there (copyInto). Refused: a copy into the folder itself or its own subfolders (it would copy itself forever), a folder already inside
 * `to` (its files are there already: keep them where they are), or the app's own data.
 */
export async function copyTarget(source: string, to: string, data: string): Promise<string | { error: string }> {
  const given = expandHome(to.trim());
  if (!path.isAbsolute(given)) return { error: `Not a full path: ${to}` };
  const made = await mkdir(given, { recursive: true }).then(
    () => null,
    (e: unknown) => ({ error: `Could not create the folder ${to}: ${e instanceof Error ? e.message : String(e)}` }),
  );
  if (made) return made;
  const dest = await realpath(given);
  if (inside(dest, source)) return { error: "The copy can't go inside the folder it copies" };
  if (inside(source, dest)) return { error: "Those files are in that folder already: keep them where they are" };
  if (inside(dest, data) || inside(data, dest)) return { error: `That folder holds the app's own data: ${to}` };
  return dest;
}

async function status(libraryId: string, username: string): Promise<WatchStatus> {
  // a Finals folder is not one of the library's footage folders (Settings → Folders has it): not listed here
  const folders = ((await footageOf(username, false)).get(libraryId) ?? []).map((f) => ({
    ...f,
    found: false,
    ...(walked.get(`${libraryId}\0${f.path}`) ?? { files: 0, adding: 0 }),
    imported: (
      db()
        .prepare("SELECT COUNT(*) AS n FROM watch_seen WHERE library_id = ? AND version_id IS NOT NULL AND substr(path, 1, ?) = ?")
        .get(libraryId, f.path.length + 1, f.path + path.sep) as { n: number }
    ).n,
  }));
  const missing = (
    db()
      .prepare("SELECT COUNT(*) AS n FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE a.library_id = ? AND v.state = 'missing' AND a.trashed_at IS NULL")
      .get(libraryId) as { n: number }
  ).n;
  return { allowed: watchAllowed(), folders, missing };
}

const isDir = async (p: string) => !!(await stat(p).catch(() => null))?.isDirectory();
// a copied folder is fine with its card out once its copies are in (a camera card is copied, then taken out)
const withFound = async (s: WatchStatus): Promise<WatchStatus> => ({
  ...s,
  folders: await Promise.all(s.folders.map(async (f) => ({ ...f, found: (await isDir(f.path)) || (!!f.copyTo && (await isDir(path.join(f.copyTo, path.basename(f.path))))) }))),
});

/**
 * Where a folder's files are copied by default: an older Exports folder's own Footage on this computer (a listed Media
 * folder since storage schema 3, with the id it had), else ~/Movies/Creator Toolset/Footage. "~/" stays as it is, for showing.
 */
export async function defaultCopyTo(username: string): Promise<string> {
  const st = parseStorageFile(await readFile(storageFilePath(env.dataDir, username), "utf-8").catch(() => "{}"));
  const here = sourcesOf(st.folders).find((f) => f.role === "footage" && f.id.endsWith(":footage") && (f.origin.host === THIS_COMPUTER || isThisMachine(f.origin.host)));
  return here?.origin.path ?? `~/Movies/${LIBRARY_NAME}/${LIBRARY_SUBFOLDERS.footage}`;
}

// GET /api/library/:id/watch → WatchStatus. The owner only: paths on the server are theirs to see.
watchApp.get("/:id/watch", async (c) => {
  const role = libraryRole(c.get("user").username, c.req.param("id"));
  if (!role) return c.json({ error: "Not found", code: "not_found" }, 404);
  const s = await withFound(await status(c.req.param("id"), c.get("user").username));
  // a copy goes in a folder on this computer: offered where the server reads it, to a library that keeps files here
  const local = (db().prepare("SELECT storage_kind FROM libraries WHERE id = ?").get(c.req.param("id")) as { storage_kind: string }).storage_kind === "local";
  return c.json(watchAllowed(c.get("user").username) && local ? { ...s, copyTo: await defaultCopyTo(c.get("user").username) } : s);
});

// GET /api/library/:id/watch/size?path&to → { files, bytes, audio, audioBytes, free? }: the media files a folder holds (and how many are sound only), so the card can say what
// importing it takes before it is added (estimate.ts). The same checks as adding it: a server on the person's computer.
// `to`: a folder its files would be copied into; `free` is the room there, less the disk reserve a copy keeps.
watchApp.get("/:id/watch/size", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  if (!libraryRole(user.username, libraryId)) return c.json({ error: "Not found", code: "not_found" }, 404);
  if (!watchAllowed(user.username)) return c.json({ error: "This server cannot read your folders", code: "forbidden" }, 403);
  const f = await checkFolder(libraryId, { path: expandHome(c.req.query("path") ?? ""), mode: "reference" }, user.username);
  if (typeof f === "string") return c.json({ error: f, code: "invalid" }, 400);
  const files = await filesIn(f.path, await keepOutOf(user.username));
  let bytes = 0;
  let audio = 0;
  let audioBytes = 0;
  for (const file of files) {
    const size = (await stat(file).catch(() => null))?.size ?? 0;
    bytes += size;
    if (kindOf(file) === "audio") {
      audio++;
      audioBytes += size;
    }
  }
  const to = c.req.query("to");
  return c.json({ files: files.length, bytes, audio, audioBytes, ...(to ? { free: await roomAt(expandHome(to)) } : {}) });
});

/** The free space that may be filled at `dir` (or the nearest folder above it that exists), less the disk reserve. */
async function roomAt(dir: string): Promise<number> {
  for (let at = dir; ; at = path.dirname(at)) {
    const free = await freeBytes(at).catch(() => null);
    if (free !== null) return Math.max(0, free - diskReserve());
    if (path.dirname(at) === at) return 0;
  }
}

const diskReserve = () => {
  const raw = process.env.LIBRARY_DISK_RESERVE_GB?.trim();
  return (raw && Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Number(raw) : 20) * GiB; // as routes.ts reads it
};

// PUT /api/library/:id/watch { folders: [{ path, mode, collectionId? }] } → WatchStatus. Replaces the list; refused on a hosted server.
watchApp.put("/:id/watch", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  const role = libraryRole(user.username, libraryId);
  if (!role) return c.json({ error: "Not found", code: "not_found" }, 404);
  if (!watchAllowed(user.username)) {
    return c.json({ error: "This server is not on your computer, so it cannot watch your folders. Upload the files instead.", code: "forbidden" }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as { folders?: unknown } | null;
  if (!Array.isArray(body?.folders) || body.folders.length > MAX_FOLDERS) return c.json({ error: `A list of up to ${MAX_FOLDERS} folders`, code: "invalid" }, 400);
  const current = (await footageOf(user.username, false)).get(libraryId) ?? [];
  const want: WatchFolder[] = [];
  for (const raw of body.folders) {
    // a folder already listed stays as it is: a copied camera card that was taken out is not refused
    const r = (raw ?? {}) as Partial<WatchFolder> & { copyTo?: unknown; collectionId?: unknown };
    const same = current.find((g) => g.path === r.path);
    if (same) {
      if (!want.some((g) => g.path === same.path)) want.push(same);
      continue;
    }
    if (r.mode === "copy" || r.copyTo || r.collectionId) return c.json({ error: IN_PLACE_ONLY, code: "invalid" }, 400);
    const f = await checkFolder(libraryId, raw, user.username);
    if (typeof f === "string") return c.json({ error: f, code: "invalid" }, 400);
    if (!want.some((g) => g.path === f.path)) want.push(f);
  }
  for (const g of want) if (!current.some((o) => o.path === g.path)) await addSourceRow(user.username, g.path, libraryId);
  await dropRows(user.username, current.filter((g) => !want.some((w) => w.path === g.path)).map((g) => g.path), (ids) => ids.some((id) => id !== libraryId));
  scanSoon();
  return c.json(await withFound(await status(libraryId, user.username)));
});

// POST /api/library/watch/folder { path, libraryId? } → { ok }. Adds one folder to a watch list: the "Where are your
// videos?" card (Media Library, AI Editor) and the Mac app's folder picker land here, on the library the card is for
// (default: the account's own). The same checks as the list.
watchApp.post("/watch/folder", async (c) => {
  const user = c.get("user");
  if (user.role === "visitor") return c.json({ error: "Not for guests", code: "forbidden" }, 403);
  const body = (await c.req.json().catch(() => null)) as { path?: unknown; libraryId?: unknown; copyTo?: unknown } | null;
  const folder = typeof body?.path === "string" ? body.path.trim() : "";
  if (!folder) return c.json({ error: "Choose a folder", code: "invalid" }, 400);
  const libraryId = typeof body?.libraryId === "string" ? body.libraryId : undefined;
  const copyTo = typeof body?.copyTo === "string" && body.copyTo.trim() ? body.copyTo : undefined;
  const refused = await addWatchFolder(user.username, folder, libraryId, copyTo);
  if (refused) return c.json({ error: refused, code: "invalid" }, 400);
  const target = libraryId ?? (await ensureLibrary(user.username));
  if (target) {
    await addSourceRow(user.username, await realpath(expandHome(folder)).catch(() => folder), target);
    libraryChanged(target);
    scanSoon();
  }
  return c.json({ ok: true });
});

const SCRIPT_RE = /\.(txt|md|markdown|fountain|rtf|docx?|pages)$/i;
const SCRIPT_MAX = 100_000;
const IMPORT_MAX = 200;

/** A script file's text: plain text read as is; Word, RTF and Pages through macOS's textutil. Null when unreadable. */
async function scriptText(file: string): Promise<string | null> {
  if (/\.(txt|md|markdown|fountain)$/i.test(file)) return (await readFile(file, "utf-8").catch(() => null))?.slice(0, SCRIPT_MAX) ?? null;
  if (process.platform !== "darwin") return null;
  return new Promise((resolve) =>
    execFile("textutil", ["-convert", "txt", "-stdout", file], { maxBuffer: 8 * 1024 * 1024, timeout: 20_000 }, (err, out) =>
      resolve(err ? null : String(out).slice(0, SCRIPT_MAX)),
    ),
  );
}

/** One import at a time per library (the scan and the AI's imports alike): a check-then-insert never races another. */
const queues = new Map<string, Promise<unknown>>();
function serial<T>(libraryId: string, job: () => Promise<T>): Promise<T> {
  const run = (queues.get(libraryId) ?? Promise.resolve()).then(job, job);
  const tail = run.catch(() => {});
  queues.set(libraryId, tail);
  void tail.then(() => queues.get(libraryId) === tail && queues.delete(libraryId));
  return run;
}

/**
 * A file into the library once: one already taken at this size and mtime gives its version again (null when it was
 * never taken), anything else is ingested and remembered in `watch_seen`. `fresh` = whether it was ingested now.
 */
export function takeFile(libraryId: string, f: WatchFolder, file: string, size: number, mtime: number): Promise<{ versionId: string | null; fresh: boolean }> {
  return serial(libraryId, async () => {
    const seen = db().prepare("SELECT size, mtime, version_id FROM watch_seen WHERE library_id = ? AND path = ?").get(libraryId, file) as
      | { size: number; mtime: number; version_id: string | null }
      | undefined;
    if (seen && seen.size === size && seen.mtime === mtime) return { versionId: seen.version_id, fresh: false };
    const versionId = await ingest(libraryId, f, file, size, seen?.version_id ?? null);
    db()
      .prepare(
        `INSERT INTO watch_seen (library_id, path, size, mtime, version_id) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (library_id, path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, version_id = excluded.version_id`,
      )
      .run(libraryId, file, size, mtime, versionId);
    return { versionId, fresh: true };
  });
}

/** The AI's tool call gives up after about a minute: an import still going answers with what is in so far. */
export const IMPORT_WAIT_MS = 40_000;

// POST /api/library/import-folder { path, since?, libraryId?, collectionId? } → { libraryId, imported, scripts, working }. The
// media files in a folder on this computer (changed on or after `since`, epoch ms) go into the library now, read in
// place, and are remembered as seen, so neither a watch of the folder nor a second call takes them twice; the script
// files directly in that folder come back as text. For the AI ("take what I put in this folder today and edit it").
// The same checks as adding a watch folder, and never a whole disk or home folder. A file still being copied is left
// for the next call; files still hashing after IMPORT_WAIT_MS go on in the background (`working`: call again).
watchApp.post("/import-folder", async (c) => {
  const user = c.get("user");
  if (user.role === "visitor") return c.json({ error: "Not for guests", code: "forbidden" }, 403);
  if (!watchAllowed(user.username)) return c.json({ error: "This server is not on your computer, so it cannot read your folders. Upload the files instead.", code: "forbidden" }, 403);
  const body = ((await c.req.json().catch(() => null)) ?? {}) as { path?: unknown; since?: unknown; libraryId?: unknown; collectionId?: unknown };
  const libraryId = typeof body.libraryId === "string" ? body.libraryId : await ensureLibrary(user.username);
  if (!libraryId || !libraryRole(user.username, libraryId)) return c.json({ error: "Not found", code: "not_found" }, 404);
  const f = await checkFolder(libraryId, { path: expandHome(typeof body.path === "string" ? body.path.trim() : ""), mode: "reference", collectionId: body.collectionId }, user.username);
  if (typeof f === "string") return c.json({ error: f, code: "invalid" }, 400);
  if (await wholeDisk(f.path)) {
    return c.json({ error: `${f.path} is a whole disk or home folder: name the folder the files are in`, code: "invalid" }, 400);
  }
  const keep = await keepOutOf(user.username);
  if (keep.some((k) => inside(f.path, k))) return c.json({ error: LIBRARY_WORDS.notFootage, code: "invalid" }, 400);
  const since = typeof body.since === "number" && Number.isFinite(body.since) ? body.since : 0;
  const all = await readdir(f.path, { recursive: true, withFileTypes: true });
  const seen = all
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name))
    .filter((p) => !path.relative(f.path, p).split(path.sep).some((s) => s.startsWith(".")));
  const editorDirs = editorDirsOf(seen.map((p) => path.relative(f.path, p)));
  const files = seen.filter((p) => !notFootage(path.relative(f.path, p), editorDirs) && !keep.some((k) => inside(p, k)));
  const fresh: { file: string; size: number; mtime: number; changed: number }[] = [];
  for (const file of files) {
    const s = await stat(file).catch(() => null);
    // a file copied in keeps its old mtime: the time it arrived here (birthtime, ctime) counts too
    const changed = s ? Math.max(s.mtimeMs, s.birthtimeMs, s.ctimeMs) : 0;
    if (s && s.size > 0 && changed >= since) fresh.push({ file, size: s.size, mtime: Math.floor(s.mtimeMs), changed });
  }
  const media = fresh.filter((x) => kindOf(x.file) !== "doc");
  if (media.length > IMPORT_MAX) return c.json({ error: `${media.length} files: import at most ${IMPORT_MAX} at a time (a narrower folder or a later since)`, code: "invalid" }, 400);
  // a file that changed in the last few seconds may still be copying: it counts once its size holds for 2 s
  const recent = media.filter((m) => Date.now() - m.changed < 10_000);
  const copying = new Set<string>();
  if (recent.length) {
    await new Promise((r) => setTimeout(r, 2000));
    for (const m of recent) if ((await stat(m.file).catch(() => null))?.size !== m.size) copying.add(m.file);
  }
  const imported: { file: string; versionId?: string; error?: string }[] = [];
  const work = (async () => {
    for (const m of media.filter((x) => !copying.has(x.file))) {
      try {
        const { versionId, fresh: isNew } = await takeFile(libraryId, f, m.file, m.size, m.mtime);
        const live = versionId
          ? db().prepare("SELECT 1 FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ? AND a.trashed_at IS NULL").get(versionId)
          : null;
        imported.push(live ? { file: m.file, versionId: versionId! } : { file: m.file, error: "In the trash in the Media Library: restore it there to use it" });
        if (isNew) libraryChanged(libraryId);
      } catch (e) {
        imported.push({ file: m.file, error: e instanceof Error ? e.message : String(e) });
      }
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work, new Promise((r) => (timer = setTimeout(r, IMPORT_WAIT_MS)))]);
  clearTimeout(timer);
  const working = media.length - copying.size - imported.length;
  const scripts: { file: string; text: string }[] = [];
  // only the folder's own script files, never ones further down (a folder of footage holds its script at the top)
  for (const d of fresh.filter((x) => SCRIPT_RE.test(x.file) && path.dirname(x.file) === f.path).slice(0, 10)) {
    const text = await scriptText(d.file);
    if (text?.trim()) scripts.push({ file: d.file, text });
  }
  return c.json({ libraryId, imported: [...imported], scripts, working, copying: [...copying] });
});

/**
 * Whether a folder (its real path) would be read whole: a disk's own top folder (/, /Users, a drive mounted at
 * /Volumes/<name>) or the home folder. `drive`: a drive's own top folder is fine (a workspace's own Storage folder).
 */
export async function wholeDisk(real: string, drive = false): Promise<boolean> {
  const home = await realpath(os.homedir()).catch(() => os.homedir());
  const root = path.parse(real).root;
  if (real === root || real === home || path.dirname(real) === root) return true;
  return !drive && (await stat(real)).dev !== (await stat(path.dirname(real))).dev;
}

/**
 * Adds a folder to this account's Source media rows on this computer, in the library's workspace (the one folder list the
 * scan reads). A row already there for that workspace is kept as it is; the same folder in another workspace is its own row.
 */
async function addSourceRow(username: string, folderPath: string, libraryId: string): Promise<void> {
  // the path as the storage routes keep it (not resolved): Projects and Exports rows are compared with it
  const real = expandHome(folderPath).replace(/(.)\/+$/, "$1");
  const ws = (db().prepare("SELECT json_extract(settings, '$.projectId') AS ws FROM libraries WHERE id = ?").get(libraryId) as { ws: string | null } | undefined)?.ws ?? undefined;
  await changeStorage(username, (st) => {
    if (st.folders.some((g) => g.role === "footage" && onThisComputer(g) && g.origin.path === real && g.workspace === ws)) return "keep";
    st.folders.push({ id: randomUUID(), role: "footage", name: path.basename(real), origin: { host: hostHere(username), path: real }, make: false, createdAt: Date.now(), reach: {}, ...(ws ? { workspace: ws } : {}) });
  });
}

/**
 * Takes this account's Source media rows on this computer at `paths` out of storage, unless `keepRow` says a library the
 * row fills still needs it (a row fills the libraries of its workspace, so it goes only when none of them keeps it).
 */
async function dropRows(username: string, paths: string[], keepRow: (libraryIds: string[]) => boolean): Promise<void> {
  const st = parseStorageFile(await readFile(storageFilePath(env.dataDir, username), "utf-8").catch(() => "{}"));
  const gone = new Set<string>();
  for (const f of st.folders) {
    if (f.role !== "footage" || !onThisComputer(f) || !paths.includes(expandHome(f.origin.path))) continue;
    if (!keepRow((await librariesOf(username, f, false)).map((l) => l.id))) gone.add(f.id);
  }
  if (gone.size) {
    await changeStorage(username, (s) => {
      s.folders = s.folders.filter((f) => !gone.has(f.id));
    });
  }
}

/** Only the watch key: other settings (transcription and the rest) are written by other code. */
const writeWatch = (libraryId: string, folders: WatchFolder[]) => {
  db().prepare("UPDATE libraries SET settings = json_set(settings, '$.watch', json(?)) WHERE id = ?").run(JSON.stringify(folders), libraryId);
};

const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);

/**
 * Checks a folder for the account's Library footage list, read in place, and says why it is refused (null when it may be
 * added). It writes no row: the caller adds the Source media row (the Settings route writes it itself; the Library card
 * route calls addSourceRow). The Library card and setup's Folders step both come through here.
 */
export async function addWatchFolder(username: string, folderPath: string, libraryId?: string, copyTo?: string): Promise<string | null> {
  if (!watchAllowed(username)) return "This server is not on your computer, so it cannot read your folders. Upload the files instead.";
  const target = libraryId ?? (await ensureLibrary(username));
  if (!target) return "No library: try again later";
  if (!libraryRole(username, target)) return "Only the library's owner can add a folder";
  if (copyTo) return IN_PLACE_ONLY;
  const f = await checkFolder(target, { path: expandHome(folderPath), mode: "reference" }, username);
  if (typeof f === "string") return f;
  const current = (await footageOf(username, false)).get(target) ?? [];
  if (current.some((g) => g.path === f.path)) return null;
  if (current.length >= MAX_FOLDERS) return `A library has up to ${MAX_FOLDERS} footage folders: remove one first`;
  return null;
}

/** The Workshop project a file in a Finals folder belongs to: the one whose subfolder holds it; null when none does. */
const finalsProjectIn = (f: WatchFolder, file: string): string | null => {
  const [dir, ...rest] = path.relative(f.path, file).split(path.sep);
  return f.projects && dir && rest.length && Object.hasOwn(f.projects, dir) ? f.projects[dir]! : null;
};

/** The Workshop project a library file came in for from a Finals folder (its version's place on this disk); null for any other. */
export function finalsProjectOf(libraryId: string, file: string): string | null {
  for (const f of foldersOf(libraryId)) {
    const id = f.projects ? finalsProjectIn(f, file) : null;
    if (id) return id;
  }
  return null;
}

/**
 * A Workshop project's folder in the Finals folder `root` on this disk: made when missing, and read from now on, its
 * files into the library's Finals (`collectionId`). One watch entry per Finals folder, listing its projects'
 * subfolders; the 20-folder limit is for footage folders. The subfolder's real path, or null when it can't be read here
 * (the reason is logged).
 */
export async function watchFinals(username: string, libraryId: string, root: string, dir: string, session: string, collectionId: string): Promise<string | null> {
  const refused = (why: string) => (console.warn(`[library] finals folder ${root}: ${why}`), null);
  if (!watchAllowed(username)) return null;
  try {
    await mkdir(path.join(expandHome(root), dir), { recursive: true });
  } catch (e) {
    return refused(e instanceof Error ? e.message : String(e));
  }
  const real = await realpath(expandHome(root));
  const current = foldersOf(libraryId);
  const had = current.find((g) => g.path === real);
  if (had && !had.projects) return refused("it is a footage folder of this library");
  if ((await footageOf(username, false)).get(libraryId)?.some((g) => g.path === real)) return refused("it is a footage folder of this library");
  if (had?.projects?.[dir] !== session) {
    let entry = had;
    if (!entry) {
      const f = await checkFolder(libraryId, { path: real, mode: "reference", collectionId }, username);
      if (typeof f === "string") return refused(f);
      entry = f;
    }
    writeWatch(libraryId, [...current.filter((g) => g !== had), { ...entry, projects: { ...entry.projects, [dir]: session } }]);
    scanSoon();
  }
  return path.join(real, dir);
}

/** Stops watching a folder in any of the account's libraries (Settings → Devices: forget). The files already in the Library stay. */
export async function removeWatchFolder(username: string, folderPath: string, keep?: ReadonlySet<string>): Promise<void> {
  const p = expandHome(folderPath);
  const real = await realpath(p).catch(() => p);
  // a Library that still lists the folder keeps its row (the row fills it too)
  await dropRows(username, [real, p], (ids) => ids.some((id) => !!keep?.has(id)));
}

// ---- the scan ----------------------------------------------------------------------------------------------------

// files seen changing, by library and path: imported once unchanged for SETTLE_MS. In memory: a restart waits again.
const pending = new Map<string, { size: number; mtime: number; since: number }>();
// what the last walk of each folder found, by library and folder path: its media files, and how many are still to be
// taken (the status reads it; a walk per status read would be a walk per file taken). In memory: a restart walks again.
const walked = folderWalks;
// files that failed to come in: tried again, but not counted as still to come (the count would never reach zero)
const stuck = new Set<string>();
/** The wait before a file is taken: short when it was already old the first time it was seen (or seen changed). */
const settleFor = (p: { mtime: number; since: number }) => (p.since - p.mtime > SETTLE_MS ? QUICK_SETTLE_MS : SETTLE_MS);

// the open pages hear of each file taken, at most once a second (a folder of thousands of small files)
const told = new Map<string, number>();
const tell = (libraryId: string) => {
  if (Date.now() - (told.get(libraryId) ?? 0) < 1000) return;
  told.set(libraryId, Date.now());
  libraryChanged(libraryId);
};

/** Media files under a folder: no hidden files or folders (.DS_Store, ._ files on external drives), no links. */
/**
 * The Projects and Exports folders on this account's computers: never footage, wherever they sit (a Projects folder inside a
 * Media folder included). The same list report.ts keeps out (its role, not its name).
 */
export async function keepOutOf(user: string): Promise<string[]> {
  const st = parseStorageFile(await readFile(storageFilePath(env.dataDir, user), "utf-8").catch(() => "{}"));
  return st.folders.filter((f) => f.role !== "footage" && (f.origin.host === THIS_COMPUTER || isThisMachine(f.origin.host))).map((f) => f.origin.path);
}

export async function filesIn(root: string, keepOut: string[] = []): Promise<string[]> {
  const all = await readdir(root, { recursive: true, withFileTypes: true });
  const seen = all
    .filter((e) => e.isFile() && kindOf(e.name) !== "doc")
    .map((e) => path.join(e.parentPath, e.name))
    .filter((p) => !path.relative(root, p).split(path.sep).some((s) => s.startsWith(".")));
  const editorDirs = editorDirsOf(seen.map((p) => path.relative(root, p)));
  return seen.filter((p) => !notFootage(path.relative(root, p), editorDirs) && !keepOut.some((k) => inside(p, k)));
}

/** A file of a copied folder: copied into place first, then read in place there like any referenced file. */
async function ingestCopy(libraryId: string, f: WatchFolder & { copyTo?: string }, file: string, size: number, priorVersion: string | null): Promise<string> {
  const copy = await copyInto(f.path, f.copyTo!, file, size);
  return ingest(libraryId, { ...f, copyTo: undefined }, copy, size, priorVersion);
}

/** One file into the library: a new asset, or version n+1 of the asset this path made before. Returns the version id. */
async function ingest(libraryId: string, f: WatchFolder, file: string, size: number, priorVersion: string | null): Promise<string> {
  if (f.mode === "reference" && f.copyTo) return ingestCopy(libraryId, f, file, size, priorVersion);
  await mkdir(stagingDir(), { recursive: true });
  const staged = path.join(stagingDir(), `watch-${randomUUID()}`);
  try {
    let sha256: string;
    if (f.mode === "copy") {
      if ((await freeBytes(stagingDir())) - size < diskReserve()) throw new Error("Not enough free disk space to copy it");
      await copyFile(file, staged);
      sha256 = await sha256File(staged);
    } else {
      sha256 = await sha256File(file);
    }
    const dup = db()
      .prepare(
        `SELECT v.id, v.state, v.source_key, v.source_path FROM asset_versions v JOIN assets a ON a.id = v.asset_id
         WHERE a.library_id = ? AND v.sha256 = ? AND a.trashed_at IS NULL ORDER BY v.state = 'missing' DESC, v.created_at LIMIT 1`,
      )
      .get(libraryId, sha256) as { id: string; state: string; source_key: string; source_path: string | null } | undefined;
    // a referenced file gone from its path, here now (moved or renamed): it reads it here, and refreshMissing brings it back
    if (dup?.state === "missing" && dup.source_path && f.mode === "reference") await pointSource(dup.id, dup.source_key, file);
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

/**
 * One file of a copied folder into its place: `<copyTo>/<root's own name>/<its path below root>`. Never over
 * another file: a name in use gets " 2", " 3"... The copy keeps the original's dates. It is written under a hidden name
 * (the scan skips those, and the Library's Footage folder may itself be watched) and gets its own name when whole. A file
 * already there with the same size and date is this one, copied before a restart. Returns the copy's path.
 */
export async function copyInto(root: string, copyTo: string, file: string, size: number): Promise<string> {
  const want = path.join(copyTo, path.basename(root), path.relative(root, file));
  const { dir, name, ext } = path.parse(want);
  const nth = (n: number) => (n === 1 ? want : path.join(dir, `${name} ${n}${ext}`));
  const src = await stat(file);
  await mkdir(dir, { recursive: true });
  for (let n = 1; ; n++) {
    const there = await stat(nth(n)).catch(() => null);
    if (!there) break;
    // dates come back a little off (a millisecond on Linux, two seconds on an exFAT card)
    if (there.size === size && Math.abs(there.mtimeMs - src.mtimeMs) < 2000) return nth(n);
  }
  if ((await freeBytes(dir)) - size < diskReserve()) throw new Error("Not enough free disk space to copy it");
  const tmp = path.join(dir, `.${name}${ext}.copying`);
  try {
    await copyFile(file, tmp, constants.COPYFILE_FICLONE); // a clone where the disk can (same APFS volume), else a copy
    await utimes(tmp, src.atime, src.mtime);
    for (let n = 1; ; n++) {
      try {
        await link(tmp, nth(n)); // fails on a name in use: nothing is overwritten
        return nth(n);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
        // ponytail: a drive with no hard links (exFAT): a rename after a look, which a file landing in between would lose to
        if (await stat(nth(n)).catch(() => null)) continue;
        await rename(tmp, nth(n));
        return nth(n);
      }
    }
  } finally {
    await rm(tmp, { force: true });
  }
}

/** One pass over a library's watch folders. Returns how many files it took in (new versions or known duplicates). */
async function scanLibrary(libraryId: string, now: number, folders: WatchFolder[]): Promise<number> {
  try {
    return await scanFolders(libraryId, now, folders);
  } finally {
    takingClips.delete(libraryId);
  }
}

async function scanFolders(libraryId: string, now: number, folders: WatchFolder[]): Promise<number> {
  let took = 0;
  for (const f of folders) {
    // files come in as the owner who added the folder, while the library is still theirs; never as anyone else
    if (!libraryRole(f.addedBy, libraryId)) continue;
    let files: string[];
    const folderKey = `${libraryId}\0${f.path}`;
    try {
      // a Finals folder (f.projects) is read in its projects' subfolders, which may sit in an Exports folder: nothing is kept out there
      files = await filesIn(f.path, f.projects ? [] : await keepOutOf(f.addedBy));
      // a Finals folder: only the files in its projects' subfolders (renders and downloads beside them are not finals)
      if (f.projects) files = files.filter((p) => !!finalsProjectIn(f, p));
    } catch {
      walked.delete(folderKey);
      continue; // unplugged or unreadable: its referenced files turn missing in refreshMissing
    }
    // how many of this folder's files are still to be taken, counted down as each comes in
    const before = walked.get(folderKey);
    let adding = 0;
    const count = (n: number) => {
      adding = n;
      walked.set(folderKey, { files: files.length, adding });
    };
    const waiting = new Set<string>();
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
        stuck.delete(key);
        continue;
      }
      if (size > 0 && !stuck.has(key)) waiting.add(file);
      const p = pending.get(key);
      if (!p || p.size !== size || p.mtime !== mtime) pending.set(key, { size, mtime, since: now });
    }
    count(waiting.size);
    // the count first (a folder just chosen says at once how many clips it holds), then the files one by one
    if (!before || before.files !== files.length || before.adding !== adding) tell(libraryId);
    for (const file of waiting) {
      const key = `${libraryId}\0${file}`;
      const p = pending.get(key);
      if (!p || now - p.since < settleFor(p)) continue;
      pending.delete(key);
      takingClips.add(libraryId);
      try {
        // through the same queue as the AI's imports, which may have taken this file meanwhile
        if ((await takeFile(libraryId, f, file, p.size, p.mtime)).fresh) took++;
      } catch (e) {
        stuck.add(key);
        console.error("[library] watch:", file, e instanceof Error ? e.message : e); // tried again once it settles again
      }
      count(adding - 1);
      tell(libraryId);
    }
  }
  if (took) libraryChanged(libraryId);
  return took;
}

/**
 * A referenced original's place on the computer this server runs on (version_places, source 'server-disk', folder ''):
 * found while the file is there, gone once it is not (the version turns `missing` too). Only where that computer is
 * paired (the person's device whose report names this machine); a server with none keeps the version state alone.
 */
function serverPlace(versionId: string, owner: string, file: string, st: { size: number; mtimeMs: number } | null, now = Date.now()): void {
  const device = listDevices((d) => d.owner === owner && isThisMachine(d.id))[0]?.id;
  if (!device) return;
  db()
    .prepare(
      `INSERT INTO version_places (version_id, device, kind, folder_id, path, bytes, mtime, state, source, confirmed_at, checked_at, gone_at)
       VALUES (?, ?, 'original', '', ?, ?, ?, ?, 'server-disk', ?, ?, ?)
       ON CONFLICT (version_id, device, kind, folder_id) DO UPDATE SET path = excluded.path, bytes = excluded.bytes, mtime = excluded.mtime,
         state = CASE WHEN excluded.state = 'gone' THEN 'gone' WHEN version_places.state = 'verified' AND version_places.mtime = excluded.mtime THEN 'verified' ELSE 'found' END,
         confirmed_at = COALESCE(excluded.confirmed_at, version_places.confirmed_at), checked_at = excluded.checked_at, gone_at = excluded.gone_at
       -- written when something changed: a scan of a big library is not a write per file
       WHERE (excluded.state = 'gone') <> (version_places.state = 'gone') OR version_places.mtime IS NOT excluded.mtime OR version_places.path <> excluded.path`,
    )
    .run(versionId, device, file, st?.size ?? null, st ? Math.round(st.mtimeMs) : null, st ? "found" : "gone", st ? now : null, now, st ? null : now);
}

/**
 * Referenced originals that went away turn `missing`; ones that came back return to `ready`, or to `processing` with
 * their failed jobs queued again (the worker fails a job whose file is gone). Rows and files are never deleted here.
 * A trashed clip is left as it is: its file may go with it, which is no fault; it is checked again once restored.
 */
async function refreshMissing(): Promise<void> {
  const refs = db()
    .prepare("SELECT v.id, v.state, v.source_path, v.created_by, a.library_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.source_path IS NOT NULL AND a.trashed_at IS NULL")
    .all() as { id: string; state: string; source_path: string; created_by: string; library_id: string }[];
  for (const v of refs) {
    const st = await stat(v.source_path).catch(() => null);
    const there = !!st;
    serverPlace(v.id, v.created_by, v.source_path, st);
    if (!there && v.state !== "missing") {
      db().prepare("UPDATE asset_versions SET state = 'missing' WHERE id = ?").run(v.id);
      libraryChanged(v.library_id);
    }
    if (there && v.state === "missing") {
      const jobs = db().prepare("SELECT kind, state, actor FROM jobs WHERE version_id = ?").all(v.id) as { kind: string; state: string; actor: string | null }[];
      for (const j of jobs) if (j.state === "failed") enqueueJob(db(), v.library_id, v.id, j.kind, j.actor);
      if (!jobs.length) enqueueJob(db(), v.library_id, v.id, "probe", v.created_by);
      // done and needs_key jobs don't hold a version back; the worker sets `ready` when the rest are through
      const open = !jobs.length || jobs.some((j) => j.state === "failed" || j.state === "queued" || j.state === "running");
      db().prepare("UPDATE asset_versions SET state = ? WHERE id = ?").run(open ? "processing" : "ready", v.id);
      libraryChanged(v.library_id);
    }
  }
}

/** One scan of every library's watch folders, then the missing check. Returns how many files came in. */
export async function scanWatchFolders(now = Date.now()): Promise<number> {
  if (!watchAllowed()) return 0;
  const footage = await footageByLibrary(true);
  const lists = new Map((db().prepare("SELECT id FROM libraries").all() as { id: string }[]).map((l) => [l.id, [...(footage.get(l.id) ?? []), ...finalsOf(l.id)]]));
  watchedFolders.clear();
  for (const [id, list] of lists) watchedFolders.set(id, new Set(list.map((f) => f.path)));
  let took = 0;
  // ponytail: one file at a time, outside the job queue (an ingest has no version yet); per-library workers if it lags
  for (const [id, list] of lists) took += await scanLibrary(id, now, list);
  // ponytail: stats every referenced file each pass; fine to tens of thousands, batch by folder past that
  await refreshMissing();
  return took;
}

let wake: (() => void) | undefined;
let asked = false;
/** Look at the folders now, not at the next half minute: a folder was just added. A scan under way is followed by another. */
export function scanSoon(): void {
  asked = true;
  wake?.();
}

/**
 * Scans now and again after the last scan ends (never two at once): at once when asked (scanSoon), after 5 s while a
 * file waits its short turn, else after 30 s. Does nothing on a server that may not watch.
 */
export function startWatchFolders(): void {
  if (!watchAllowed()) return;
  const loop = async () => {
    wake = undefined;
    asked = false;
    try {
      await scanWatchFolders();
    } catch (e) {
      console.error("[library] watch:", e);
    }
    const quick = [...pending.values()].some((p) => settleFor(p) === QUICK_SETTLE_MS);
    const timer = setTimeout(loop, asked ? 0 : quick ? QUICK_SETTLE_MS : SCAN_MS);
    timer.unref();
    wake = () => {
      clearTimeout(timer);
      void loop();
    };
  };
  void loop();
}
