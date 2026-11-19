import { Hono, type Context } from "hono";
import { mayChange } from "../users";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, open, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isPhoneSession, type AuthVars } from "../auth";
import { env } from "../lib/env";
import { appendBody, freeBytes, sha256File } from "../lib/uploads";
import { hasMembers, mayReceive, mayServe, REFUSED_COMPUTER_OFF, uploadFor, type Received } from "./upload-gate";
import { readerOf } from "./reader";
import { ensureLibrary, givenLibrary, homeOf, inAskedWorkspace, librariesHere, libraryChanged, libraryRole, mayAdd, mayWrite, mediaReady } from "./access";
import { uploadTarget } from "./upload-target";
import { currentWorkspaceId } from "../lib/workspace-scope";
import { sharedHere, workspaceScope } from "../lib/workshop/workspace";
import { expandCollection } from "./collections";
import { blobs, finalsUpload, keepsOnlyOriginals, libraryDb, librarySetting, libraryStore, libraryUpload, meter, newLibrarySettings, proxiesInCloud, SETTING_DEFAULTS, uploadOf } from "./db";
import { estimate, libraryStatus, progress } from "./estimate";
import { sendFile } from "../lib/send-file";
import { notifyLibraryChanges } from "../lib/events";
import { hostsNone, hostsProxies, LIBRARY_UPLOADS, LOOK_BUDGET_DEFAULT, LOOK_LEVELS, lookLevelOf, PROXY_QUALITIES, SOUNDS, WATCH_MODELS, watchModelOf, type AssetCard, type LibrarySettings, type LibrarySummary, type LibraryUpload, type Sound, type WhereAnswer } from "../../contracts/library";
import type { LibraryViewer } from "../../contracts/library-source";
import { releaseBudget } from "./shots";
import { enqueueJob, prepareFirst } from "./jobs";
import { fileUnfiled, organizeOf } from "./organize";
import { needsProxy, wantsProxy } from "./media/proxy";
import type { ProbeSummary } from "./media/probe";
import { spaceApp } from "./space";
import { locateApp } from "./locate";
import { folderStatesFor, placesApp } from "./places";
import { whereIsMany } from "./whereis";
import { PLACES_MAX, placeWordOf } from "../../contracts/places";
import { emptyTrash, inReview, setTrashedAt } from "./trash";
import { copiesWake } from "./copies";
import { similar } from "./similar";
import { assetRef, canSee, sourceById, SourceRefusal, sourcesVisibleTo } from "./sources";
import { externalAssetRef, externalRefById } from "./refs";
import { offlineApp } from "../work/offline";
import { buildAssetQuery, indexAsset, macPlace, markHere, pageOf, parseSearch, type CardRow } from "./query";
import { fileRoll, rollFolder } from "./roll";
// watch.ts imports from this file too: its functions are only called inside handlers, never while the files load
import { IMPORT_WAIT_MS, takeFile, watchAllowed } from "./watch";
import { indexOnMac, parseOnMac } from "./on-mac";
import { type Made, parseMade, recordMade, sendLater, sendsFromComputer, UPLOAD_TAKES } from "./derived";
import { deviceOf } from "../lib/devices";
import { FOLDER_LABELS, finalsDirName } from "../../contracts/storage";
import { quickPrint } from "../work/files";
import { libraryWorkspace, serverKind } from "../work/server-work";
import { WORK_MIN } from "../../contracts/work";

/**
 * Media Library routes (tasks/media-library-plan.md, sections 4 and 7). Mounted at /api/library.
 * Uploads use the offset protocol: the staged file is the truth for Upload-Offset, so a dropped connection
 * resumes with HEAD, then PATCH from that offset. Only the uploader may touch an upload, and only while still
 * a member of the library's workspace; everyone else gets 404.
 */

export const libraryApp = new Hono<{ Variables: AuthVars }>();
libraryApp.use("*", notifyLibraryChanges);
libraryApp.route("/", spaceApp); // GET /:id/space, POST /:id/space/clear
libraryApp.route("/offline", offlineApp); // GET/POST /offline: Available offline (api/work/offline.ts)
libraryApp.route("/", locateApp); // GET, POST /:id/locate
libraryApp.route("/", placesApp); // GET, POST /:id/places, GET /:id/places/gone, /:id/places/moves

const CHUNK_BYTES = 32 * 1024 * 1024;

/** Told each finished upload's id and the version it became (a duplicate's current version): an edit waiting on it starts. */
export const onUploadDone: ((uploadId: string, versionId: string) => void)[] = [];
const uploadDone = (uploadId: string, versionId: string | null | undefined) => {
  if (versionId) for (const f of onUploadDone) f(uploadId, versionId);
};
const STAGE_DAYS = 7;
const OPEN_PER_USER = 4;
/** The expires_at of an upload started or sent to within the last hour (each start and part sets it STAGE_DAYS ahead). */
const active = () => Date.now() + STAGE_DAYS * 86_400_000 - 3_600_000;
const GiB = 1024 ** 3;
const stagingDir = () => path.join(env.dataDir, "library", "staging");
// one writer per upload in this process; the finish also claims it in the database (state finishing), across processes
const busy = new Set<string>();

/** Read per call (AGENTS: process.env at the point of use). */
function gbSetting(name: string, fallback: number): number {
  const raw = process.env[name];
  const v = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** Bytes as people read them: "12.4 GB", "8 GB", "300 MB". */
const gb = (bytes: number) => (bytes >= GiB ? `${Number((bytes / GiB).toFixed(1))} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`);

const KIND_OF: [RegExp, "video" | "image" | "audio"][] = [
  [/\.(mp4|mov|m4v|webm|mkv|avi)$/i, "video"],
  [/\.(mp3|m4a|wav|aac|ogg|opus|flac)$/i, "audio"],
  [/\.(jpe?g|png|heic|webp|gif|tiff?)$/i, "image"],
];
export const kindOf = (filename: string) => KIND_OF.find(([re]) => re.test(filename))?.[1] ?? "doc";

const MIME: [RegExp, string][] = [
  [/\.(mp4|m4v)$/i, "video/mp4"],
  [/\.mov$/i, "video/quicktime"],
  [/\.webm$/i, "video/webm"],
  [/\.mkv$/i, "video/x-matroska"],
  [/\.avi$/i, "video/x-msvideo"],
  [/\.(m4a|aac)$/i, "audio/mp4"],
  [/\.mp3$/i, "audio/mpeg"],
  [/\.wav$/i, "audio/wav"],
  [/\.(ogg|opus)$/i, "audio/ogg"],
  [/\.flac$/i, "audio/flac"],
  [/\.(jpe?g)$/i, "image/jpeg"],
  [/\.png$/i, "image/png"],
  [/\.webp$/i, "image/webp"],
  [/\.gif$/i, "image/gif"],
];
export const mimeOf = (filename: string) => MIME.find(([re]) => re.test(filename))?.[1] ?? "application/octet-stream";
const EXT: Record<string, string> = { "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm", "video/x-matroska": ".mkv", "video/x-msvideo": ".avi",
  "audio/mp4": ".m4a", "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/ogg": ".ogg", "audio/flac": ".flac", "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" };

/**
 * The library's read videos (or `versionId` alone) that want a proxy (media/proxy.ts wantsProxy) and have none, nor one
 * on its way. `hosted`: the switch was just turned on under Hosted proxies, so every video wants one (UNIFIED-PRD §4.1).
 */
export function unproxied(libraryId: string, versionId?: string, hosted = false): { id: string; created_by: string }[] {
  // a library that keeps only originals gets none (UNIFIED-PRD §4.2)
  const keeps = keepsOnlyOriginals(libraryId);
  const want = { cloud: !keeps && (proxiesInCloud(libraryId) || hosted), on: librarySetting(libraryId, "proxy") && !keeps };
  if (!want.cloud && !want.on) return [];
  const rows = db()
    .prepare(
      `SELECT v.id, v.created_by, v.probe FROM asset_versions v JOIN assets a ON a.id = v.asset_id
       WHERE a.library_id = ? AND (? IS NULL OR v.id = ?) AND v.probe IS NOT NULL AND v.state != 'missing' AND a.kind != 'image'
         AND NOT EXISTS (SELECT 1 FROM derivatives d WHERE d.version_id = v.id AND d.kind = 'proxy')
         AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.version_id = v.id AND j.kind = 'proxy' AND j.state IN ('queued', 'running', 'failed'))`,
    )
    .all(libraryId, versionId ?? null, versionId ?? null) as { id: string; created_by: string; probe: string }[];
  return rows.filter((r) => wantsProxy(JSON.parse(r.probe) as ProbeSummary, want));
}

/** The name an original downloads as: the file's own name when it is read where it is, else its title with its type's extension. */
export function downloadName(versionId: string): string {
  const v = db().prepare("SELECT a.title, v.source_path, v.mime FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(versionId) as
    | { title: string; source_path: string | null; mime: string | null }
    | undefined;
  if (!v) return "download";
  const name = v.source_path ? path.basename(v.source_path) : `${v.title}${EXT[v.mime ?? ""] ?? ""}`;
  return name.replace(/[\\/:\x00-\x1f]/g, "_") || "download";
}

/**
 * One new version's rows, inside the caller's transaction: a new asset titled after the file (or version n+1 of
 * `assetId`), made current, indexed, its probe queued, and put in `collectionId` while that is a manual collection
 * here (any member may add items). Returns the asset id. Uploads, watch folders and saved exports all come in here.
 */
export function recordVersion(
  d: DatabaseSync,
  o: {
    libraryId: string;
    assetId?: string | null;
    versionId: string;
    sourceKey: string;
    sourcePath?: string | null;
    filename: string;
    size: number;
    sha256: string;
    by: string;
    collectionId?: string | null;
    /** where an uploaded file is on the computer it came from (uploads.from_path, from_device) */
    fromPath?: string | null;
    fromDevice?: string | null;
    /** the upload's origin (uploads.origin): "phone" for the iPhone app's own file */
    origin?: string | null;
  },
): string {
  const now = Date.now();
  const assetId = o.assetId ?? randomUUID();
  if (!o.assetId) {
    d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?)").run(
      assetId,
      o.libraryId,
      kindOf(o.filename),
      path.parse(o.filename).name.slice(0, 160) || "Untitled",
      o.by,
      now,
    );
  }
  const { n } = d.prepare("SELECT COALESCE(MAX(n), 0) + 1 AS n FROM asset_versions WHERE asset_id = ?").get(assetId) as { n: number };
  d.prepare(
    `INSERT INTO asset_versions (id, asset_id, n, source_key, source_path, bytes, sha256, mime, state, created_by, created_at, from_path, from_device, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?, ?)`,
  ).run(o.versionId, assetId, n, o.sourceKey, o.sourcePath ?? null, o.size, o.sha256, mimeOf(o.filename), o.by, now, o.fromPath ?? null, o.fromDevice ?? null, o.origin ?? null);
  d.prepare("UPDATE assets SET current_version_id = ? WHERE id = ?").run(o.versionId, assetId);
  if (o.collectionId && d.prepare("SELECT 1 FROM collections WHERE id = ? AND library_id = ? AND kind = 'manual'").get(o.collectionId, o.libraryId)) {
    d.prepare(
      `INSERT OR IGNORE INTO collection_items (collection_id, asset_id, position, added_by)
       SELECT ?, ?, COALESCE(MAX(position), 0) + 1, ? FROM collection_items WHERE collection_id = ?`,
    ).run(o.collectionId, assetId, o.by, o.collectionId);
  }
  const roll = o.collectionId ? rollFolder(d, o.libraryId, o.collectionId) : null; // uploaded into the A-roll folder: filed as A-roll
  if (roll) fileRoll(d, assetId, roll);
  // uploaded into Finals (a project's final, AddFinalDialog): finished from the start, never footage in the Media Library
  else if (o.collectionId && d.prepare("SELECT 1 FROM collections WHERE id = ? AND parent_id IS NULL AND kind = 'manual' AND name = 'Finals'").get(o.collectionId))
    fileRoll(d, assetId, "none");
  indexAsset(d, assetId);
  enqueueJob(d, o.libraryId, o.versionId, "probe", o.by);
  // the library's copies take it as soon as the caller's transaction is in (copies.ts)
  setImmediate(() => copiesWake(o.versionId));
  return assetId;
}

/**
 * A finished file saved into a library as a new asset (a Caption Studio export): copied, so the file stays where it
 * is. `sources` are the library versions it was made from; each one the caller may read gets a `derived_from` row.
 * Without `libraryId`, the library of the first source the caller may use, else the first library of the workspace this
 * request works in. Null: no library the caller may use.
 */
export function soundFolder(d: DatabaseSync, lib: string, sound: Sound, by: string): string {
  const name = SOUNDS[sound].folder;
  const found = d.prepare("SELECT id FROM collections WHERE library_id = ? AND parent_id IS NULL AND kind = 'manual' AND name = ? ORDER BY created_at, id LIMIT 1").get(lib, name) as { id: string } | undefined;
  if (found) return found.id;
  const id = `col_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  d.prepare("INSERT INTO collections (id, library_id, parent_id, name, kind, created_at, created_by) VALUES (?, ?, NULL, ?, 'manual', ?, ?)").run(id, lib, name, Date.now(), by);
  return id;
}

export async function saveToLibrary(
  username: string,
  file: string,
  filename: string,
  sources: string[],
  libraryId?: string,
  footage = false,
  sound?: Sound,
  /** a final (Finals): it follows the library's Finals setting, not its Upload */
  finals = false,
): Promise<SavedTo | null> {
  const lib =
    libraryId ??
    sources
      .map((v) => (db().prepare("SELECT a.library_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(v) as { library_id: string } | undefined)?.library_id)
      .find((l) => l && libraryRole(username, l)) ??
    (await librariesHere(username))[0]?.id;
  if (!lib || !libraryRole(username, lib)) return null;
  const { size } = await stat(file);
  await mkdir(stagingDir(), { recursive: true });
  if ((await freeBytes(stagingDir())) - size < gbSetting("LIBRARY_DISK_RESERVE_GB", 20) * GiB) {
    return { error: "Not enough free disk space for this file", code: "disk_reserve" };
  }
  // Upload none: the file goes to the asker's computer and is indexed there, never kept here
  if (serverKind() !== "local" && hostsNone(finals ? finalsUpload(lib) : libraryUpload(lib))) return saveOnComputer(username, lib, file, filename, sources, footage, sound);
  const staged = path.join(stagingDir(), `save-${randomUUID()}`);
  try {
    await copyFile(file, staged);
    const sha256 = await sha256File(staged);
    const dup = db()
      .prepare("SELECT a.id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE a.library_id = ? AND v.sha256 = ? AND a.trashed_at IS NULL LIMIT 1")
      .get(lib, sha256) as { id: string } | undefined;
    if (dup) return { duplicateOf: dup.id };
    const versionId = randomUUID();
    const sourceKey = `libraries/${lib}/v/${versionId}/source`;
    await blobs.put(sourceKey, staged);
    const d = db();
    d.exec("BEGIN");
    try {
      const collectionId = sound ? soundFolder(d, lib, sound, username) : undefined;
      const assetId = recordVersion(d, { libraryId: lib, versionId, sourceKey, filename, size, sha256, by: username, collectionId });
      // before the probe runs (same commit): the tag is what keeps the worker's AI steps off it
      fileSaved(d, assetId, versionId, username, { footage, sound, sources });
      d.exec("COMMIT");
      return { assetId, versionId };
    } catch (e) {
      d.exec("ROLLBACK");
      await blobs.delete(sourceKey);
      throw e;
    }
  } finally {
    await rm(staged, { force: true });
  }
}

export type SavedTo =
  | { assetId: string; versionId: string }
  | { duplicateOf: string }
  | { error: string; code: "disk_reserve" | "no_folder" | "failed" }
  /** Upload none and the asker's computer not online (or not done yet): the one line to say; it lands when it is back */
  | { waiting: string };

/** What a saved file gets with its new version: its sound tag, no A-roll or B-roll for a finished file, what it was made from. */
export function fileSaved(d: DatabaseSync, assetId: string, versionId: string, username: string, o: { footage: boolean; sound?: Sound; sources: string[] }): void {
  if (o.sound) d.prepare("INSERT OR IGNORE INTO asset_tags (asset_id, tag, source) VALUES (?, ?, 'user')").run(assetId, SOUNDS[o.sound].tag);
  if (!o.footage) fileRoll(d, assetId, "none"); // a finished file (an export, a Finals file) is never A-roll or B-roll
  for (const from of new Set(o.sources)) {
    const src = d.prepare("SELECT a.library_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(from) as { library_id: string } | undefined;
    if (src && libraryRole(username, src.library_id)) {
      d.prepare("INSERT OR IGNORE INTO derived_from (version_id, source_version_id, note) VALUES (?, ?, 'export')").run(versionId, from);
    }
  }
}

/** How long a save under Upload none waits for an online computer to have it indexed before answering (a test shortens it). */
export const COMPUTER_SAVE = { ms: 30_000 };

/**
 * A save under Upload none (owner, 2026-11-19): the file goes to the workspace's first Source media folder (a finished
 * file: its Final exports folder) on whichever of the asker's computers takes the task (work/tasks/library-save.ts), which
 * indexes it there in place. With none online it waits for one, and the answer is the one line naming the folder.
 */
async function saveOnComputer(username: string, lib: string, file: string, filename: string, sources: string[], footage: boolean, sound?: Sound): Promise<SavedTo> {
  const { librariesOf, useOf } = await import("./report");
  const { storageOf } = await import("../devices-storage");
  const { awaitTask, startTask, taskOf } = await import("../work/tasks");
  const use = footage || sound ? "media" : "exports";
  const label = FOLDER_LABELS[use === "media" ? "footage" : "library"];
  const folders: Record<string, { id: string; path: string }> = {};
  for (const f of (await storageOf(username)).folders) {
    if (useOf(f) !== use || folders[f.origin.host] || deviceOf(f.origin.host)?.owner !== username) continue;
    if ((await librariesOf(username, f, false)).some((l) => l.id === lib)) folders[f.origin.host] = { id: f.id, path: f.origin.path };
  }
  const first = Object.entries(folders)[0];
  if (!first) return { error: `Upload is off for this workspace, so files stay on your computer, and none of yours has a ${label} folder for it: add one in Settings → Folders.`, code: "no_folder" };
  const size = (await stat(file)).size;
  const quick = await quickPrint(file);
  if (!quick) return { error: "The file could not be read", code: "failed" };
  const dup = db()
    .prepare("SELECT a.id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE a.library_id = ? AND a.trashed_at IS NULL AND ((v.quick = ? AND v.bytes = ?) OR v.sha256 = ?) LIMIT 1")
    .get(lib, quick, size, `mac:${quick}`) as { id: string } | undefined;
  if (dup) return { duplicateOf: dup.id };
  // held here only until a computer has fetched it (the task removes it)
  const staged = path.join(stagingDir(), `computer-${lib}-${quick}`);
  await copyFile(file, staged);
  const started = await startTask("library-save", `${lib}:${quick}`, username, libraryWorkspace(lib), { lib, filename: finalsDirName(filename), staged, folders, footage, ...(sound ? { sound } : {}), sources });
  const name = (id: string) => deviceOf(id)?.name ?? "Your computer";
  const where = (id: string) => `${label} (${folders[id]!.path})`;
  if (started.state === "queued" && started.line) return { waiting: `${name(first[0])} is offline. I'll save it to ${where(first[0])} when it's back.` };
  if (started.state === "queued" && (await awaitTask(started.id, COMPUTER_SAVE.ms)) === "failed") return { error: taskOf(started.id)?.error ?? "Your computer could not save it", code: "failed" };
  const got = db()
    .prepare("SELECT a.id AS assetId, v.id AS versionId FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE a.library_id = ? AND a.trashed_at IS NULL AND v.quick = ? AND v.bytes = ? LIMIT 1")
    .get(lib, quick, size) as { assetId: string; versionId: string } | undefined;
  if (got) return got;
  // a computer has it but is not done yet: it lands there in a moment
  const held = started.state === "queued" ? taskOf(started.id)?.held_by : null;
  const on = held && folders[held] ? held : first[0];
  return { waiting: `Saving it to ${where(on)} on ${name(on)}.` };
}

interface UploadRow {
  id: string;
  library_id: string;
  created_by: string;
  filename: string;
  size: number;
  staging_path: string;
  replaces_asset_id: string | null;
  collection_id: string | null;
  state: string;
  direct_upload_id: string | null;
  from_path: string | null;
  from_device: string | null;
  /** what the phone made of the file itself (derived.ts Made), JSON; cleared once filed */
  made: string | null;
  /** "phone" when the iPhone app sent it to the person's computers (x-ct-origin); null otherwise */
  origin: string | null;
}

const db = () => libraryDb();

const madeOf = (row: UploadRow): Made | null => (row.made ? (JSON.parse(row.made) as Made) : null);

/** The library's copy of this upload's file: by its checksum, or by the original's quick fingerprint and size (a 720p copy's checksum is its own). */
function duplicateOf(row: UploadRow, sha256: string): { id: string; current: string | null } | undefined {
  if (row.replaces_asset_id) return undefined;
  const made = madeOf(row);
  return db()
    .prepare(
      `SELECT a.id, a.current_version_id AS current FROM asset_versions v JOIN assets a ON a.id = v.asset_id
       WHERE a.library_id = ? AND a.trashed_at IS NULL AND (v.sha256 = ? OR (v.quick = ? AND v.bytes = ?)) LIMIT 1`,
    )
    .get(row.library_id, sha256, made?.quick ?? null, made?.proxy?.size ?? row.size) as { id: string; current: string | null } | undefined;
}

/**
 * After the version of an upload with what the phone made was recorded (its probe job held back): files the card picture,
 * the quick fingerprint and, for a 720p copy, the original's probe (derived.ts recordMade). Whatever fails here, the
 * version is probed by this server as any upload is: it never waits on a picture.
 */
async function fileMade(row: UploadRow, versionId: string): Promise<void> {
  const made = madeOf(row);
  if (!made) return;
  const thumb = made.thumb ? path.join(stagingDir(), `${row.id}.thumb.jpg`) : null;
  try {
    if (thumb) {
      await mkdir(stagingDir(), { recursive: true });
      await writeFile(thumb, Buffer.from(made.thumb!, "base64"));
    }
    await recordMade(versionId, made, row.size, thumb, row.created_by);
  } catch (e) {
    console.error("[library] what the phone made:", e);
    enqueueJob(db(), row.library_id, versionId, "probe", row.created_by);
  } finally {
    if (thumb) await rm(thumb, { force: true });
    db().prepare("UPDATE uploads SET made = NULL WHERE id = ?").run(row.id);
  }
}

// a Review video: Review owns its versions and its trash, so the library refuses to add a version or trash it
const IN_REVIEW = { error: "This video is in Review: change it there", code: "conflict" } as const;

/**
 * The upload gate for an upload under way: a file a computer sends (its place named) or one a person sent; the phone's
 * 720p copy as a proxy. `got`: at the finish, what the received bytes hash to (the proxy proof).
 */
const receives = (row: UploadRow, got?: string) => {
  const made = madeOf(row)?.proxy;
  const sender = row.from_device ? deviceOf(row.from_device) : undefined;
  const into = { id: row.library_id, collectionId: row.collection_id };
  const origin = row.from_path ? "computer" : row.origin === "phone" ? "phone" : "person";
  if (!made) return mayReceive("original", into, origin, { sender });
  // the size check runs for every sender, a computer without the proof included (UNIFIED-PRD §4.1 rule 4)
  return mayReceive("proxy", into, origin, { sender, proof: { ...(made.sha256 ? { sha256: made.sha256 } : {}), ...(got ? { got } : {}), bytes: row.size, original: made.size } });
};

/** The caller's upload, if they started it and still may use its library; otherwise null (404). */

async function ownUpload(c: Context<{ Variables: AuthVars }>): Promise<UploadRow | null> {
  const user = c.get("user");
  const row = db().prepare("SELECT * FROM uploads WHERE id = ?").get(c.req.param("uploadId") ?? "") as UploadRow | undefined;
  if (!row || row.created_by !== user.username || !(await mayAdd(user, row.library_id))) return null;
  return row;
}

const stagedBytes = (file: string) => stat(file).then((s) => s.size, () => -1);

/** Uploads nobody resumed within STAGE_DAYS: staging file removed, row marked failed. Runs when a new upload starts. */
async function sweepStale(): Promise<void> {
  const stale = db()
    .prepare("SELECT id, library_id, staging_path, direct_upload_id FROM uploads WHERE state IN ('open', 'finishing') AND expires_at < ?")
    .all(Date.now()) as { id: string; library_id: string; staging_path: string; direct_upload_id: string | null }[];
  for (const r of stale) if (!busy.has(r.id)) await dropUpload(r);
}

/** An open upload given up: its staged bytes or its bucket parts go, and it can't be resumed. */
async function dropUpload(r: { id: string; library_id: string; staging_path: string; direct_upload_id: string | null }): Promise<void> {
  if (r.direct_upload_id) {
    // a bucket that is no longer set up must not stop every new upload: its parts are left for the bucket to expire
    try {
      await libraryStore(r.library_id).direct?.abort(sourceKeyOf(r.library_id, r.id), r.direct_upload_id);
    } catch {}
  } else await rm(r.staging_path, { force: true });
  db().prepare("UPDATE uploads SET state = 'failed' WHERE id = ?").run(r.id);
}

/** The bucket key of a library's file for one version (the same key the local store uses). */
function sourceKeyOf(libraryId: string, versionId: string): string {
  return `libraries/${libraryId}/v/${versionId}/source`;
}

/** The parts a browser reports from the bucket: part numbers 1 to 10 000 and their ETags. Null when any is malformed. */
function partsFrom(body: unknown): { number: number; etag: string }[] | null {
  const list = (body as { parts?: unknown } | null)?.parts;
  if (!Array.isArray(list) || !list.length) return null;
  const parts = (list as { number?: unknown; etag?: unknown }[]).map((p) => ({
    number: Number(p?.number),
    etag: typeof p?.etag === "string" ? p.etag : "",
  }));
  return parts.every((p) => Number.isSafeInteger(p.number) && p.number >= 1 && p.number <= 10_000 && p.etag) ? parts : null;
}

/**
 * Finishes a direct upload: the bucket joins the parts the browser PUT to their presigned URLs. The server checks the
 * size and hashes the object (for duplicates) before the version is recorded. A duplicate's object is removed.
 */
async function finishDirect(c: Context<{ Variables: AuthVars }>, row: UploadRow): Promise<Response> {
  const parts = partsFrom(await c.req.json().catch(() => null));
  if (!parts || !row.direct_upload_id) return c.json({ error: "Send the part ETags the bucket returned", code: "invalid" }, 400);
  const store = libraryStore(row.library_id);
  const key = sourceKeyOf(row.library_id, row.id);
  try {
    await store.direct!.complete(key, row.direct_upload_id, parts);
  } catch (e) {
    await store.direct!.abort(key, row.direct_upload_id);
    throw e;
  }
  if ((await store.stat(key))?.bytes !== row.size) {
    await store.delete(key);
    throw new Error("The bucket's copy is not the size that was declared");
  }
  const sha256 = await sha256File(await store.localCopy(key));
  const proof = receives(row, sha256);
  if (!proof.ok) {
    await store.delete(key); // not the copy it said it was: nothing of it is kept
    db().prepare("UPDATE uploads SET state = 'failed', made = NULL WHERE id = ?").run(row.id);
    return c.json(proof.body, proof.status);
  }
  const dup = duplicateOf(row, sha256);
  if (dup) {
    await store.delete(key); // not metered yet, so no usage to take back
    db().prepare("UPDATE uploads SET state = 'done', made = NULL WHERE id = ?").run(row.id);
    uploadDone(row.id, dup.current);
    return c.json({ duplicateOf: dup.id });
  }
  meter(row.library_id, row.size); // the bytes went to the bucket around blobs.put, so the usage is counted here
  const d = db();
  d.exec("BEGIN");
  let assetId: string;
  try {
    assetId = recordVersion(d, {
      libraryId: row.library_id,
      assetId: row.replaces_asset_id,
      versionId: row.id,
      sourceKey: key,
      filename: row.filename,
      size: madeOf(row)?.proxy?.size ?? row.size, // a 720p copy: the version is the original's size, as one kept on a computer
      sha256,
      by: row.created_by,
      collectionId: row.collection_id,
      fromPath: row.from_path,
      fromDevice: row.from_device,
      origin: row.origin,
    });
    if (row.made) d.prepare("DELETE FROM jobs WHERE version_id = ? AND kind = 'probe'").run(row.id); // fileMade queues what it needs
    d.prepare("UPDATE uploads SET state = 'done', received = size WHERE id = ?").run(row.id);
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    await blobs.delete(key); // metered above, so the delete takes the usage back
    throw e;
  }
  await fileMade(row, row.id);
  uploadDone(row.id, row.id);
  return c.json({ assetId, versionId: row.id });
}

// POST /api/library/:id/uploads/check { size, sha256?, quick? } → { maybe } | { duplicateOf?, versionId? }: whether a file is
// in this library already, before any of it is sent. With only the size: whether a clip of that size is there (the page
// hashes the file only then). With the sha256: the clip it is, by the same check an upload's finish makes; with the quick
// fingerprint too (Look for new files), also a version of that size and fingerprint, an upload's included.
libraryApp.post("/:id/uploads/check", async (c) => {
  const libraryId = c.req.param("id");
  const user = c.get("user");
  if (!(await mayAdd(user, libraryId)) || !(await inAskedWorkspace(user, libraryId))) return c.json({ error: "Not found", code: "not_found" }, 404);
  const b = (await c.req.json().catch(() => null)) as { size?: unknown; sha256?: unknown; quick?: unknown } | null;
  const size = Number(b?.size);
  if (!Number.isSafeInteger(size) || size <= 0) return c.json({ error: "Invalid size", code: "invalid" }, 400);
  const live = "FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE a.library_id = ? AND a.trashed_at IS NULL";
  if (typeof b?.sha256 !== "string") return c.json({ maybe: !!db().prepare(`SELECT 1 ${live} AND v.bytes = ? LIMIT 1`).get(libraryId, size) });
  const quick = typeof b.quick === "string" && /^[0-9a-f]{64}$/.test(b.quick) ? b.quick : null;
  const dup = db()
    .prepare(`SELECT a.id, v.id AS version ${live} AND (v.sha256 = ?${quick ? " OR (v.quick = ? AND v.bytes = ?)" : ""}) ORDER BY v.id = a.current_version_id DESC LIMIT 1`)
    .get(libraryId, b.sha256.toLowerCase(), ...(quick ? [quick, size] : [])) as { id: string; version: string } | undefined;
  return c.json(dup ? { duplicateOf: dup.id, ...(quick ? { versionId: dup.version } : {}) } : {});
});

/**
 * POST /api/library/here/uploads { filename, size } → the same as /:id/uploads, into the own library of the workspace this
 * request works in (upload-target.ts): the phone's upload, which never names a library. The rest of it is the same
 * upload at /uploads/:uploadId (PATCH, finish), which asks mayAdd again. 409 where a plug-in keeps the workspace's uploads.
 */
libraryApp.post("/here/uploads", async (c) => {
  const t = await uploadTarget(c.get("user"));
  if ("error" in t) return c.json({ ...t, code: "forbidden" }, 403);
  if (!t.libraryId) return c.json({ error: "This workspace's uploads go somewhere else", code: "conflict", target: t.target }, 409);
  return startUpload(c, t.libraryId);
});
// POST /api/library/:id/uploads: { filename, size, replacesAssetId?, collectionId?, fromPath?, fromDevice?, quick?, send? } → 201 { id, offset, chunkSize }
// fromPath / fromDevice: where the file is on the Mac it is sent from (a library that keeps only proxies keeps that place)
// send (with quick, the Mac's quickPrint): a video on the caller's own computer (registered, an app that reads WORK_MIN; not
// only one that already claimed library work, so a freshly paired Mac's file stays on it too) is not
// uploaded by the page: 200 { assetId, versionId, sent: true } | { duplicateOf }, and that computer makes the proxy and
// the small files and sends them, the original too only to a library that keeps originals (derived.ts sendLater)
libraryApp.post("/:id/uploads", (c) => startUpload(c, c.req.param("id")));

async function startUpload(c: Context<{ Variables: AuthVars }>, libraryId: string): Promise<Response> {
  const user = c.get("user");
  // with a workspace named, only that workspace's libraries (a cross-brand id is refused); with none, as before
  if (!(await mayAdd(user, libraryId)) || !(await inAskedWorkspace(user, libraryId))) return c.json({ error: "Not found", code: "not_found" }, 404);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  // a member's add is an upload, taken only where Hosted media takes it (UNIFIED-PRD §4.3, the §3.2 line under Off)
  const collectionOf = typeof body?.collectionId === "string" ? body.collectionId : null;
  if (!libraryRole(user.username, libraryId) && hostsNone(uploadFor({ id: libraryId, collectionId: collectionOf }))) {
    return c.json({ error: REFUSED_COMPUTER_OFF, code: "upload_refused", message: REFUSED_COMPUTER_OFF }, 409);
  }
  const size = Number(body?.size);
  if (!Number.isSafeInteger(size) || size <= 0) return c.json({ error: "Invalid size", code: "invalid" }, 400);
  // the largest upload holds only where an upload is the only way in: on the person's own computer the disk is the limit.
  // A server its operator opened to folders (LIBRARY_WATCH_FOLDERS=1) is not that: every account there keeps the limit
  const own = process.env.LIBRARY_WATCH_FOLDERS?.trim() !== "1" && watchAllowed(user.username);
  const max = gbSetting("LIBRARY_MAX_UPLOAD_GB", 8) * GiB;
  if (size > max && !own) {
    return c.json({ error: `This file is ${gb(size)}. This server takes files up to ${gb(max)}. Export a smaller copy and upload that.`, code: "too_large" }, 413);
  }
  const replaces = typeof body?.replacesAssetId === "string" ? body.replacesAssetId : null;
  if (replaces) {
    const target = db().prepare("SELECT created_by, current_version_id FROM assets WHERE id = ? AND library_id = ? AND trashed_at IS NULL").get(replaces, libraryId) as
      | { created_by: string; current_version_id: string }
      | undefined;
    if (!target || !(await mayWrite(user.username, libraryId, replaces, target.current_version_id))) return c.json({ error: "Not found", code: "not_found" }, 404);
    if (inReview(replaces)) return c.json(IN_REVIEW, 409);
  }
  const collection = collectionOf;
  if (collection) {
    const col = db().prepare("SELECT kind FROM collections WHERE id = ? AND library_id = ?").get(collection, libraryId) as { kind: string } | undefined;
    if (!col) return c.json({ error: "Not found", code: "not_found" }, 404);
    if (col.kind !== "manual" && !rollFolder(db(), libraryId, collection)) return c.json({ error: "Clips cannot be moved into a saved search", code: "conflict" }, 409);
  }
  const id = randomUUID();
  const filename = String(body?.filename ?? "").trim().slice(0, 255) || "Untitled";
  const from = typeof body?.fromPath === "string" && body.fromPath.startsWith("/") && body.fromPath.length <= 2048 && !body.fromPath.split("/").includes("..") ? body.fromPath : null;
  const fromDevice = from && typeof body?.fromDevice === "string" && body.fromDevice ? body.fromDevice.slice(0, 100) : null;
  const sender = fromDevice ? deviceOf(fromDevice) : undefined;
  if (
    body?.send === true && from && !replaces && sender?.owner === user.username && (sender.work?.v ?? 0) >= WORK_MIN &&
    typeof body.quick === "string" && /^[0-9a-f]{64}$/.test(body.quick) && sendsFromComputer(libraryId, filename, collection)
  ) {
    const r = sendLater(libraryId, user.username, { filename, size, fromPath: from, device: sender.id, quick: body.quick, collectionId: collection });
    return c.json("versionId" in r ? { ...r, sent: true } : r);
  }
  // what the phone made of the file itself (derived.ts Made): only to a library this server files it for
  const made = await parseMade(body);
  if (typeof made === "string") return c.json({ error: made, code: "invalid" }, 400);
  const into = { id: libraryId, collectionId: collection };
  // the iPhone app's own send (UploadEngine.swift): the person's file to their computers, taken under Upload none too
  // the header only names the phone's file: the session must be the iPhone app's own (auth.ts isPhoneSession), never a browser's or a Mac's
  const phone = !from && c.req.header("x-ct-origin") === "phone" && isPhoneSession(c, user.username);
  const origin = from ? "computer" : phone ? "phone" : "person";
  const gate = made?.proxy
    ? mayReceive("proxy", into, origin, { sender, proof: { ...(made.proxy.sha256 ? { sha256: made.proxy.sha256 } : {}), bytes: size, original: made.proxy.size } })
    : mayReceive("original", into, origin, { sender });
  if (!gate.ok) return c.json(gate.body, gate.status);
  await sweepStale();
  const staging = path.join(stagingDir(), id);
  // a bucket library takes the bytes straight from the browser (presigned part PUTs); the server only starts and finishes
  const direct = libraryStore(libraryId).direct;
  const started = direct ? await direct.start(sourceKeyOf(libraryId, id), size, { contentType: mimeOf(filename) }) : null;
  if (!started) {
    await mkdir(stagingDir(), { recursive: true });
    // bytes the open uploads may still write count too, or several large uploads would each pass alone; only those sent
    // to in the last hour (expires_at moves on with each part), so empty or abandoned ones hold no space, and of each
    // other person's only the OPEN_PER_USER largest, so one person's many uploads never hold everyone else's; the
    // starter's own all count, or ten of theirs sent a byte each would together write past the reserve
    const pending = (db().prepare(
      `SELECT COALESCE(SUM(n), 0) AS n FROM (SELECT created_by, size - received AS n, ROW_NUMBER() OVER (PARTITION BY created_by ORDER BY size - received DESC) AS k
       FROM uploads WHERE state = 'open' AND direct_upload_id IS NULL AND received > 0 AND expires_at > ?) WHERE k <= ? OR created_by = ?`,
    ).get(active(), OPEN_PER_USER, user.username) as { n: number }).n;
    if ((await freeBytes(stagingDir())) - pending - size < gbSetting("LIBRARY_DISK_RESERVE_GB", 20) * GiB) {
      return c.json({ error: "Not enough free disk space for this upload", code: "disk_reserve" }, 507);
    }
    await writeFile(staging, "");
  }
  db()
    .prepare(
      `INSERT INTO uploads (id, library_id, created_by, filename, size, received, staging_path, replaces_asset_id, collection_id, expires_at, state, direct_upload_id, from_path, from_device, made, origin)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      libraryId,
      user.username,
      filename,
      size,
      started ? "" : staging,
      replaces,
      collection,
      Date.now() + STAGE_DAYS * 86_400_000,
      started?.uploadId ?? null,
      from,
      fromDevice,
      made ? JSON.stringify(made) : null,
      phone ? "phone" : null,
    );
  if (started) return c.json({ id, offset: 0, chunkSize: started.partSize, direct: { partSize: started.partSize, urls: started.urls } }, 201);
  return c.json({ id, offset: 0, chunkSize: CHUNK_BYTES }, 201);
}

/**
 * POST /api/library/:id/in-place { path, size, collectionId?, again? } → { assetId, versionId } | { duplicateOf } |
 * 202 { working } (still hashing after IMPORT_WAIT_MS: ask again with `again`). A file the person picked on their own
 * computer (the Mac app's open panel says where it is) joins the library where it is, through a watch folder's door:
 * taken once, the duplicate check, a link under the blob key, `missing` while its drive is away. No copy, so no size
 * limit. The checks of a watch folder, for one file: this server is on the caller's computer (watchAllowed), a media
 * file on this disk outside the app's data, the declared size, a library that keeps its files on this disk.
 * 400 or 403: not here, upload it instead (the page does).
 */
libraryApp.post("/:id/in-place", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  if (!libraryRole(user.username, libraryId) || !(await inAskedWorkspace(user, libraryId))) return c.json({ error: "Not found", code: "not_found" }, 404);
  if (!watchAllowed(user.username)) return c.json({ error: "This server is not on your computer: upload the file", code: "forbidden" }, 403);
  const body = ((await c.req.json().catch(() => null)) ?? {}) as { path?: unknown; size?: unknown; collectionId?: unknown; again?: unknown };
  const given = typeof body.path === "string" ? body.path : "";
  const refuse = (error: string) => c.json({ error, code: "invalid" }, 400);
  if (!path.isAbsolute(given)) return refuse("Not a full path");
  const real = await realpath(given).catch(() => null);
  const s = real ? await stat(real).catch(() => null) : null;
  if (!real || !s?.isFile()) return refuse(`File not found on this computer: ${given}`);
  if (s.size !== Number(body.size)) return refuse("The file changed since it was picked");
  if (kindOf(real) === "doc") return refuse("Only videos, sound and pictures are added in place");
  // macOS may keep this server out of a folder the app itself may read (Desktop, Downloads): the page uploads it then
  const readable = await open(real, "r").catch(() => null);
  if (!readable) return refuse("This server may not read that file");
  await readable.close();
  const data = await realpath(env.dataDir).catch(() => path.resolve(env.dataDir));
  const fromData = path.relative(data, real);
  if (fromData.split(path.sep)[0] !== ".." && !path.isAbsolute(fromData)) return refuse("That file is in the app's own data");
  if ((db().prepare("SELECT storage_kind FROM libraries WHERE id = ?").get(libraryId) as { storage_kind: string }).storage_kind !== "local") {
    return refuse("This library keeps its files in a bucket");
  }
  const collectionId = typeof body.collectionId === "string" && body.collectionId ? body.collectionId : undefined;
  if (collectionId && !db().prepare("SELECT 1 FROM collections WHERE id = ? AND library_id = ? AND kind = 'manual'").get(collectionId, libraryId)) {
    return c.json({ error: "Not found", code: "not_found" }, 404);
  }
  const folder = { path: path.dirname(real), mode: "reference" as const, collectionId, addedBy: user.username };
  const taking = takeFile(libraryId, folder, real, s.size, Math.floor(s.mtimeMs));
  taking.catch((e) => console.error("[library] in place:", real, e instanceof Error ? e.message : e));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const got = await Promise.race([taking, new Promise<null>((r) => (timer = setTimeout(() => r(null), IMPORT_WAIT_MS)))]).catch(
    (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
  );
  clearTimeout(timer);
  if (got instanceof Error) return c.json({ error: got.message, code: "conflict" }, 500);
  if (!got) return c.json({ working: true }, 202);
  const v = got.versionId
    ? (db()
        .prepare("SELECT v.source_path, a.id, a.trashed_at FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?")
        .get(got.versionId) as { source_path: string | null; id: string; trashed_at: number | null } | undefined)
    : undefined;
  if (!v) return c.json({ error: "Could not add the file", code: "conflict" }, 409);
  if (v.trashed_at) return c.json({ error: "In the trash in the Media Library: restore it there to use it", code: "conflict" }, 409);
  // this very file, taken now (or by the call this one asks again for); anything else was in the library already
  if (v.source_path === real && (got.fresh || body.again === true)) return c.json({ assetId: v.id, versionId: got.versionId });
  return c.json({ duplicateOf: v.id });
});

/**
 * POST /api/library/:id/on-mac OnMacIndex → { assetId, versionId } | { duplicateOf }. A file on the caller's Mac, for a
 * server that is not on it (the Mac app's drop): indexed where it is, with what the Mac made; its bytes never come here
 * (on-mac.ts). Any member may add, as with an upload; a manual folder or the A-roll folder may take it.
 */
const MEMBER_NOT_INDEXED = "Footage on a member's computer is added by upload, not read from its folders.";
libraryApp.post("/:id/on-mac", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  if (!(await mayAdd(user, libraryId)) || !(await inAskedWorkspace(user, libraryId))) return c.json({ error: "Not found", code: "not_found" }, 404);
  // a member's rows only locate (UNIFIED-PRD §4.3): what a member adds from a folder is uploaded, never indexed from it
  if (!libraryRole(user.username, libraryId)) {
    if (hostsNone(uploadFor({ id: libraryId }))) return c.json({ error: REFUSED_COMPUTER_OFF, code: "upload_refused", message: REFUSED_COMPUTER_OFF }, 409);
    // the app sends a member's file by upload where Hosted media takes it; this path is never a member's folder
    return c.json({ error: MEMBER_NOT_INDEXED, code: "forbidden" }, 403);
  }
  const x = parseOnMac(await c.req.json().catch(() => null));
  if (typeof x === "string") return c.json({ error: x, code: "invalid" }, 400);
  if (x.collectionId) {
    const col = db().prepare("SELECT kind FROM collections WHERE id = ? AND library_id = ?").get(x.collectionId, libraryId) as { kind: string } | undefined;
    if (!col) return c.json({ error: "Not found", code: "not_found" }, 404);
    if (col.kind !== "manual" && !rollFolder(db(), libraryId, x.collectionId)) return c.json({ error: "Clips cannot be moved into a saved search", code: "conflict" }, 409);
  }
  return c.json(await indexOnMac(libraryId, user.username, x));
});

// HEAD /api/library/uploads/:uploadId → Upload-Offset: what is on disk. Hono sends HEAD through GET, so this is a GET
// route (the body is empty for HEAD).
libraryApp.get("/uploads/:uploadId", async (c) => {
  const row = await ownUpload(c);
  const received = row && (await stagedBytes(row.staging_path));
  if (!row || received === -1) return c.body(null, 404);
  c.header("Upload-Offset", String(received));
  return c.body(null, 200);
});

// DELETE /api/library/uploads/:uploadId → 204: a cancelled upload; what reached the server goes now, not in STAGE_DAYS
libraryApp.delete("/uploads/:uploadId", async (c) => {
  const row = await ownUpload(c);
  if (!row || row.state !== "open") return c.json({ error: "Not found", code: "not_found" }, 404);
  // a chunk still being written ends with the connection the page closed; the file goes either way
  await dropUpload(row);
  return c.body(null, 204);
});

// PATCH /api/library/uploads/:uploadId, Upload-Offset: n, body from n → 204 Upload-Offset | 409 { offset }
libraryApp.patch("/uploads/:uploadId", async (c) => {
  const row = await ownUpload(c);
  if (!row || row.state !== "open") return c.json({ error: "Not found", code: "not_found" }, 404);
  if (row.direct_upload_id) return c.json({ error: "This upload goes straight to the bucket", code: "conflict" }, 409);
  if (busy.has(row.id)) return c.json({ error: "Upload in progress", code: "conflict", offset: await stagedBytes(row.staging_path) }, 409);
  // asked again on each part and at the finish: the setting may change while it runs (what arrived stays until it expires)
  const gate = receives(row);
  if (!gate.ok) return c.json(gate.body, gate.status);
  const offset = Number(c.req.header("upload-offset"));
  const length = Number(c.req.header("content-length"));
  if (!Number.isSafeInteger(length) || length < 0) return c.json({ error: "Length Required", code: "invalid" }, 411);
  busy.add(row.id);
  try {
    const current = await stagedBytes(row.staging_path);
    if (offset !== current) return c.json({ error: "Wrong offset", code: "conflict", offset: current }, 409);
    if (offset + length > row.size) return c.json({ error: "Past the declared size", code: "invalid" }, 400);
    try {
      await appendBody(c, row.staging_path);
    } catch {
      // the connection dropped mid-chunk: keep what arrived, the client resumes from the file's size
      return c.json({ error: "Upload interrupted", code: "conflict", offset: await stagedBytes(row.staging_path) }, 409);
    }
    const now = await stagedBytes(row.staging_path);
    db().prepare("UPDATE uploads SET received = ?, expires_at = ? WHERE id = ?").run(now, Date.now() + STAGE_DAYS * 86_400_000, row.id);
    c.header("Upload-Offset", String(now));
    return c.body(null, 204);
  } finally {
    busy.delete(row.id);
  }
});

// POST /api/library/uploads/:uploadId/finish → { assetId, versionId } | { duplicateOf } | 409 { offset }
libraryApp.post("/uploads/:uploadId/finish", async (c) => {
  const row = await ownUpload(c);
  if (!row) return c.json({ error: "Not found", code: "not_found" }, 404);
  if (row.state !== "open" && row.state !== "finishing") return c.json({ error: "Already finished", code: "conflict" }, 409);
  if (busy.has(row.id)) return c.json({ error: "Upload in progress", code: "conflict", offset: await stagedBytes(row.staging_path) }, 409);
  const gate = receives(row);
  if (!gate.ok) return c.json(gate.body, gate.status);
  // claimed in the database, so a second server process (the no-downtime swap) never finishes it a second time; a claim
  // an hour old is a process that stopped mid-finish, and is taken over
  const claim = "UPDATE uploads SET state = 'finishing', expires_at = ? WHERE id = ? AND (state = 'open' OR (state = 'finishing' AND expires_at < ?))";
  if (!db().prepare(claim).run(Date.now() + STAGE_DAYS * 86_400_000, row.id, active()).changes) {
    return c.json({ error: "Upload in progress", code: "conflict", offset: await stagedBytes(row.staging_path) }, 409);
  }
  busy.add(row.id);
  try {
    if (row.direct_upload_id) return await finishDirect(c, row);
    const got = await stagedBytes(row.staging_path);
    if (got !== row.size) return c.json({ error: "The upload is incomplete", code: "conflict", offset: got }, 409);
    const sha256 = await sha256File(row.staging_path);
    const proof = receives(row, sha256);
    if (!proof.ok) {
      await rm(row.staging_path, { force: true }); // not the copy it said it was: nothing of it is kept
      db().prepare("UPDATE uploads SET state = 'failed', made = NULL WHERE id = ?").run(row.id);
      return c.json(proof.body, proof.status);
    }
    const dup = duplicateOf(row, sha256);
    if (dup) {
      await rm(row.staging_path, { force: true });
      db().prepare("UPDATE uploads SET state = 'done', made = NULL WHERE id = ?").run(row.id);
      uploadDone(row.id, dup.current);
      return c.json({ duplicateOf: dup.id });
    }
    const versionId = randomUUID();
    const sourceKey = `libraries/${row.library_id}/v/${versionId}/source`;
    await blobs.put(sourceKey, row.staging_path); // same disk: a rename, the file moves into the library
    const d = db();
    d.exec("BEGIN");
    let assetId: string;
    try {
      assetId = recordVersion(d, {
        libraryId: row.library_id,
        assetId: row.replaces_asset_id,
        versionId,
        sourceKey,
        filename: row.filename,
        size: madeOf(row)?.proxy?.size ?? row.size, // a 720p copy: the version is the original's size, as one kept on a computer
        sha256,
        by: row.created_by,
        collectionId: row.collection_id, // the folder it was dropped in
        fromPath: row.from_path,
        fromDevice: row.from_device,
        origin: row.origin,
      });
      if (row.made) d.prepare("DELETE FROM jobs WHERE version_id = ? AND kind = 'probe'").run(versionId); // fileMade queues what it needs
      d.prepare("UPDATE uploads SET state = 'done', received = size WHERE id = ?").run(row.id);
      d.exec("COMMIT");
    } catch (e) {
      d.exec("ROLLBACK");
      throw e;
    }
    await fileMade(row, versionId);
    uploadDone(row.id, versionId);
    return c.json({ assetId, versionId });
  } catch (e) {
    // only one still finishing: an upload whose file is already in the library stays done
    db().prepare("UPDATE uploads SET state = 'failed' WHERE id = ? AND state = 'finishing'").run(row.id);
    return c.json({ error: e instanceof Error ? e.message : String(e), code: "conflict" }, 500);
  } finally {
    // not done nor failed (the upload is incomplete): open again, to be resumed and finished
    db().prepare("UPDATE uploads SET state = 'open' WHERE id = ? AND state = 'finishing'").run(row.id);
    busy.delete(row.id);
  }
});

// GET /api/library → the caller's libraries in the workspace this request works in (each workspace has its own)
libraryApp.get("/", async (c) => {
  const user = c.get("user");
  // in a workspace the team's owner gave this person, the owner's libraries there (librariesHere): none is made for them
  const given = await sharedHere(user);
  if (!given) await ensureLibrary(user.username);
  // a workspace a plug-in serves (its catalog) is set up before the page reads it: no setup dialog over the catalog
  await mediaReady(user.username, workspaceScope.getStore()?.id);
  const rows = await librariesHere(user.username);
  const libraries: LibrarySummary[] = await Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      name: r.name,
      storage: r.storage_kind as LibrarySummary["storage"],
      settings: settingsOf(r.settings),
      ...(given ? { readOnly: true as const, ...(mayChange(user, "media") ? { canAdd: true as const } : {}) } : {}),
      ...((await hasMembers(r.id)) ? { shared: true as const } : {}),
    })),
  );
  // uploadTakes: an upload start here takes what a phone made of a video itself (derived.ts Made)
  return c.json({ libraries, uploadTakes: UPLOAD_TAKES });
});

const settingsOf = (json: string): LibrarySettings => {
  const s = JSON.parse(json || "{}") as Partial<LibrarySettings>;
  return {
    describe: s.describe ?? SETTING_DEFAULTS.describe,
    look: s.look ?? SETTING_DEFAULTS.look,
    timeline: s.timeline ?? SETTING_DEFAULTS.timeline,
    embed: s.embed ?? SETTING_DEFAULTS.embed,
    proxy: s.proxy ?? SETTING_DEFAULTS.proxy,
    pictures: s.pictures ?? SETTING_DEFAULTS.pictures,
    upload: uploadOf(s.upload),
    finalsUpload: s.finalsUpload === undefined || s.finalsUpload === null ? "all" : uploadOf(s.finalsUpload),
    ...(s.importMode === "in-place" || s.importMode === "copy" ? { importMode: s.importMode } : {}),
    ...(s.organize ? { organize: s.organize } : {}),
    ...(s.organizeOffered ? { organizeOffered: true } : {}),
    lookLevel: lookLevelOf(s.lookLevel),
    timelineModel: watchModelOf(s.timelineModel),
    lookBudget: s.lookBudget === undefined ? LOOK_BUDGET_DEFAULT : typeof s.lookBudget === "number" && s.lookBudget >= 0 ? s.lookBudget : null,
  };
};

// GET /api/library/:id/estimate?clips&bytes&audio&audioBytes&music → LibraryEstimate: what processing that many clips would take, for the caller
libraryApp.get("/:id/estimate", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  if (!libraryRole(user.username, libraryId)) return c.json({ error: "Not found", code: "not_found" }, 404);
  const n = (k: string) => Math.max(0, Number(c.req.query(k)) || 0);
  const clips = Math.min(1_000_000, Math.floor(n("clips")));
  return c.json(await estimate(libraryId, user.username, { clips, bytes: n("bytes"), audio: Math.floor(n("audio")), audioBytes: n("audioBytes"), music: c.req.query("music") === "1" }));
});

// GET /api/library/:id/progress → LibraryProgress: the processing still to do
libraryApp.get("/:id/progress", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  if (!libraryRole(user.username, libraryId)) return c.json({ error: "Not found", code: "not_found" }, 404);
  return c.json(await progress(libraryId, user.username));
});

// GET /api/library/:id/status → LibraryStatus: the whole library, step by step
libraryApp.get("/:id/status", (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  if (!libraryRole(user.username, libraryId)) return c.json({ error: "Not found", code: "not_found" }, 404);
  return c.json(libraryStatus(libraryId));
});

// PATCH /api/library/:id { name?, settings?: { describe?, embed?, pictures?, proxy?, upload?, finalsUpload?, importMode?, organize?, … } } → LibrarySummary;
// the owner only. Proxies off: the ones still queued are dropped; on: the clips that need one (or all, when proxies are
// hosted) and have none get one. organize "ai" files what is in no folder yet (UNIFIED-PRD §4.9); it does not force describe.
// copyTo and places are read only by the one-time migration (§4.6), so nothing writes them.
libraryApp.patch("/:id", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  const role = libraryRole(user.username, libraryId);
  if (!role) return c.json({ error: "Not found", code: "not_found" }, 404);
  const b = (await c.req.json().catch(() => null)) as { name?: unknown; settings?: Record<string, unknown> } | null;
  const name = typeof b?.name === "string" ? b.name.trim().slice(0, 80) : "";
  if (name) db().prepare("UPDATE libraries SET name = ? WHERE id = ?").run(name, libraryId);
  // one key at a time: other settings (watch folders) are written by other code
  const put = (key: string, value: unknown) => db().prepare(`UPDATE libraries SET settings = json_set(settings, '$.${key}', json(?)) WHERE id = ?`).run(JSON.stringify(value), libraryId);
  for (const key of ["describe", "look", "timeline", "embed", "pictures", "transcribe", "lookTalking"] as const) {
    const on = b?.settings?.[key];
    if (typeof on === "boolean") put(key, on);
  }
  const s = b?.settings ?? {};
  // true/false: the upload switch's older values (db.ts uploadOf), kept so a stored boolean still maps the same way
  const upload = s.upload === true ? "all" : s.upload === false ? "none" : s.upload;
  if (LIBRARY_UPLOADS.includes(upload as LibraryUpload)) put("upload", upload);
  if (typeof s.defaultFolders === "boolean") put("defaultFolders", s.defaultFolders);
  if (PROXY_QUALITIES.some((q) => q.value === s.proxyQuality)) put("proxyQuality", s.proxyQuality);
  // the setup dialog's last answer (UNIFIED-PRD §4.8): the owner's, once; a setup done is never undone here
  if (typeof s.setupAt === "string" && s.setupAt.length < 40 && Number.isFinite(Date.parse(s.setupAt))) {
    db().prepare(`UPDATE libraries SET settings = json_set(settings, '$.setupAt', json(?)) WHERE id = ? AND json_extract(settings, '$.setupAt') IS NULL`).run(JSON.stringify(s.setupAt), libraryId);
  }
  // a new level describes the clips described from now on; the ones done keep their lines until the person asks again
  // (All clips → Shot descriptions), or an edit asks for its files
  if (LOOK_LEVELS.some((l) => l.value === s.lookLevel)) put("lookLevel", s.lookLevel);
  // a new model watches the videos watched from now on; the timelines made keep theirs
  if (WATCH_MODELS.some((m) => m.value === s.timelineModel)) put("timelineModel", s.timelineModel);
  if (s.lookBudget === null || (typeof s.lookBudget === "number" && Number.isFinite(s.lookBudget) && s.lookBudget >= 0 && s.lookBudget <= 1_000_000)) {
    put("lookBudget", s.lookBudget === null ? null : Math.round(s.lookBudget * 100) / 100);
    releaseBudget(db(), libraryId); // raised or off: the looks held for it ask again now (still over: they wait again, saying so)
    libraryChanged(libraryId);
  }
  if (LIBRARY_UPLOADS.includes(s.finalsUpload as LibraryUpload)) put("finalsUpload", s.finalsUpload);
  if (s.importMode === "in-place" || s.importMode === "copy") put("importMode", s.importMode);
  // Hosted proxies: the switch stays on and every video gets a proxy (UNIFIED-PRD §3.1, §4.1), whatever the request says
  const hosted = hostsProxies(libraryUpload(libraryId));
  const proxy = hosted ? true : b?.settings?.proxy;
  if (typeof proxy === "boolean") put("proxy", proxy);
  // proxies kept in the cloud are made for every video whatever the switch says (its row is hidden then)
  if (proxy === false && !proxiesInCloud(libraryId)) db().prepare("DELETE FROM jobs WHERE library_id = ? AND kind = 'proxy' AND state IN ('queued', 'failed')").run(libraryId);
  if (proxy === true) for (const v of unproxied(libraryId, undefined, hosted)) enqueueJob(db(), libraryId, v.id, "proxy", v.created_by, true);
  if (typeof proxy === "boolean") libraryChanged(libraryId);
  const organize = b?.settings?.organize;
  if (organize === "default" || organize === "ai" || organize === "own") {
    const was = organizeOf(libraryId, db());
    const set = (key: string, value: string) => db().prepare(`UPDATE libraries SET settings = json_set(settings, '$.${key}', json(?)) WHERE id = ?`).run(value, libraryId);
    set("organize", JSON.stringify(organize === "default" ? "own" : organize)); // Standard is gone (UNIFIED-PRD M4)
    if (organize === "ai" && was !== "ai") void fileUnfiled(db(), libraryId, user).catch((e) => console.error("[library] filing:", e));
    libraryChanged(libraryId); // the folders: other open pages read them again
  }
  if (b?.settings?.organizeOffered === true) db().prepare(`UPDATE libraries SET settings = json_set(settings, '$.organizeOffered', json('true')) WHERE id = ?`).run(libraryId);
  const r = db().prepare("SELECT name, storage_kind, settings FROM libraries WHERE id = ?").get(libraryId) as {
    name: string;
    storage_kind: LibrarySummary["storage"];
    settings: string;
  };
  const updated: LibrarySummary = { id: libraryId, name: r.name, storage: r.storage_kind, settings: settingsOf(r.settings) };
  return c.json(updated);
});

// POST /api/library { name } → a local library of the caller's own, in the workspace this request works in
libraryApp.post("/", async (c) => {
  const user = c.get("user");
  if (user.role === "visitor") return c.json({ error: "Sign in to create a library", code: "forbidden" }, 403);
  const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
  const name = (typeof body?.name === "string" ? body.name.trim().slice(0, 80) : "") || "Library";
  const id = `lib_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const ws = await currentWorkspaceId(user);
  db()
    .prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES (?, ?, ?, 'local', ?, ?)")
    .run(id, homeOf(user.username), name, newLibrarySettings(ws ? { projectId: ws } : {}), Date.now());
  const created: LibrarySummary = { id, name, storage: "local", settings: settingsOf("{}") };
  return c.json(created, 201);
});

/** Who is asking about a library: its role there (owner, or null for no access), for the policies in sources.ts. */
export function viewerOf(username: string, libraryId: string): LibraryViewer | null {
  const role = libraryRole(username, libraryId);
  return role ? { username, role } : null;
}
export { readerOf } from "./reader";

/** The cards the viewer may see, in order. Every read path that lists cards filters through here. */
export async function visibleCards(viewer: LibraryViewer | null, libraryId: string, cards: AssetCard[]): Promise<AssetCard[]> {
  if (!viewer) return [];
  const out: AssetCard[] = [];
  for (const card of cards) if (await canSee(viewer, assetRef(libraryId, card.id, card.versionId))) out.push(card);
  return out;
}

// GET /api/library/:id/assets?q&kind&tag&from&to&cursor&limit&f.<key> → one page of AssetCards (query.ts). A card the
// viewer may not see is left out (the page keeps its cursor, so it can come back shorter than the limit).
// GET /api/library/:id/sources → the plug-in sources this viewer may see (the Source picker; the built-in library is not listed)
libraryApp.get("/:id/sources", async (c) => {
  const user = c.get("user");
  const viewer = await readerOf(user.username, c.req.param("id"));
  if (!viewer) return c.json({ error: "Not found", code: "not_found" }, 404);
  const sources = await sourcesVisibleTo(viewer);
  return c.json({ sources: sources.map((s) => ({ id: s.id, label: s.label, ...(s.main ? { main: true } : {}) })) });
});

libraryApp.get("/:id/assets", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  const viewer = await readerOf(user.username, libraryId);
  if (!viewer) return c.json({ error: "Not found", code: "not_found" }, 404);
  // a plug-in source's cards (the Source picker): each card is an external ref, and each must pass its own policy
  const sourceId = c.req.query("source");
  if (sourceId) {
    const source = sourceById(sourceId);
    if (!source?.list || !(await sourcesVisibleTo(viewer)).some((s) => s.id === sourceId)) return c.json({ items: [] });
    let refused: string | undefined;
    const cards = (
      await source.list(viewer, c.req.raw).catch((e: unknown) => ((refused = e instanceof SourceRefusal ? e.message : undefined), [] as AssetCard[]))
    ).slice(0, 200);
    const items: AssetCard[] = [];
    for (const card of cards) {
      const ref = externalRefById(card.id);
      if (!ref || ref.source !== sourceId || !(await canSee(viewer, externalAssetRef(ref, libraryId)))) continue;
      items.push({ ...card, libraryId });
    }
    return c.json({ items, ...(refused ? { refused } : {}) });
  }
  const query = expandCollection(libraryId, parseSearch(c.req.query(), user.username));
  if (!query) return c.json({ error: "Not found", code: "not_found" }, 404);
  const { sql, params, limit } = buildAssetQuery(libraryId, query);
  const page = pageOf(db().prepare(sql).all(...params) as unknown as CardRow[], limit);
  return c.json({ ...page, items: await markHere(db(), await visibleCards(viewer, libraryId, page.items), query.device) });
});

/**
 * GET /api/library/:id/where?versions=a,b&device=<id> → WhereAnswer: where each version is, from the place rows only
 * (whereis.ts). At most PLACES_MAX ids, only the library's versions the caller may see; `device` counts only when it is the
 * caller's own computer (the word is then seen from it).
 */
libraryApp.get("/:id/where", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  const viewer = await readerOf(user.username, libraryId);
  if (!viewer) return c.json({ error: "Not found", code: "not_found" }, 404);
  const ids = [...new Set((c.req.query("versions") ?? "").split(",").filter((x) => x && x.length <= 100))];
  if (ids.length > PLACES_MAX) return c.json({ error: `At most ${PLACES_MAX} versions`, code: "invalid" }, 400);
  const asked = c.req.query("device");
  const device = asked && deviceOf(asked)?.owner === user.username ? asked : undefined;
  const rows = db()
    .prepare("SELECT v.id, v.asset_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE a.library_id = ? AND v.id IN (SELECT value FROM json_each(?))")
    .all(libraryId, JSON.stringify(ids)) as { id: string; asset_id: string }[];
  const seen: string[] = [];
  for (const r of rows) if (await canSee(viewer, assetRef(libraryId, r.asset_id, r.id))) seen.push(r.id);
  const where = whereIsMany(seen, await folderStatesFor(seen));
  const versions: WhereAnswer["versions"] = {};
  for (const [id, w] of where) versions[id] = { ...w, word: placeWordOf(w, device) };
  return c.json({ versions } satisfies WhereAnswer);
});

/**
 * The blob a media URL serves: thumb, play (the proxy when there is one, else the source), proxy (only the proxy: a
 * card's link, api/mcp-cards.ts) or source. A clip that plays as it is plays from this disk, not from its proxy in the
 * cloud. Null: no such kind.
 */
export function mediaFile(versionId: string, kind: string): { key?: string; type: string; onMac?: string; what?: "original" | "proxy" } | null {
  const v = db()
    .prepare("SELECT v.source_key, v.mime, v.probe, v.mac_path, v.mac_device, a.library_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?")
    .get(versionId) as { source_key: string; mime: string | null; probe: string | null; mac_path: string | null; mac_device: string | null; library_id: string } | undefined;
  if (!v) return null;
  const derived = (k: string) =>
    (db().prepare("SELECT storage_key FROM derivatives WHERE version_id = ? AND kind = ?").get(versionId, k) as
      | { storage_key: string | null }
      | undefined)?.storage_key ?? undefined;
  const original = v.mime ?? "application/octet-stream";
  if (kind === "thumb") return { key: derived("thumb"), type: "image/jpeg" };
  if (kind === "proxy") return { key: derived("proxy"), type: "video/mp4", what: "proxy" };
  if (kind === "sprite") return { key: derived("sprite"), type: "image/jpeg" };
  // the original is on a Mac (indexed there, or uploaded to a library that keeps only proxies): it plays from its proxy
  // when it has one, and a download says where the original is
  if (v.mac_path && kind === "source") return { type: original, onMac: macPlace(v.mac_path, v.mac_device) };
  if (v.mac_path && kind === "play") return { key: derived("proxy"), type: "video/mp4", what: "proxy" };
  if (kind === "play") {
    const p = JSON.parse(v.probe ?? "null") as ProbeSummary | null;
    const proxy = p && proxiesInCloud(v.library_id) && !needsProxy(p) ? undefined : derived("proxy");
    return { key: proxy ?? v.source_key, type: proxy ? "video/mp4" : original, what: proxy ? "proxy" : "original" };
  }
  if (kind === "source") return { key: v.source_key, type: original, what: "original" };
  return null;
}

/**
 * What the server may stream of a version to a viewer (local-first decision 5): the file mediaFile picked, asked of
 * mayServe as its original or its proxy (`what`, never a key comparison: a proxies library's proxy can share its key
 * with the source). Pictures pass. Review, Finals and team proxies are mayServe's own exceptions.
 */
export async function serveGate(versionId: string, kind: string, file: { key?: string; what?: "original" | "proxy" }): Promise<Received> {
  if (!["play", "proxy", "source"].includes(kind) || !file.key) return { ok: true };
  const v = db().prepare("SELECT a.id AS asset_id, a.library_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(versionId) as
    | { asset_id: string; library_id: string }
    | undefined;
  if (!v || inReview(v.asset_id)) return { ok: true }; // a Review video is Review's, served by it (R2)
  return mayServe({ id: v.library_id, versionId }, file.what ?? (kind === "proxy" ? "proxy" : "original"));
}

/** Whether the library made a playable copy of this version (its proxy). A card's video link is signed only for that copy, never for the original (api/mcp-cards.ts). */
export const hasProxy = (versionId: string): boolean =>
  !!(db().prepare("SELECT storage_key FROM derivatives WHERE version_id = ? AND kind = 'proxy'").get(versionId) as { storage_key: string | null } | undefined)?.storage_key;

/** A blob as a response: streamed with Range from local disk, or a 302 to a 15-minute signed URL on a bucket. */
export async function serveBlob(c: Context, key: string, type: string, download?: string): Promise<Response> {
  try {
    const at = await blobs.locate(key, 900, { contentType: type, download });
    return at.kind === "url" ? c.redirect(at.url, 302) : await sendFile(c, at.path, type, download);
  } catch {
    return c.json({ error: "Not ready", code: "conflict" }, 409);
  }
}

// GET /api/library/media/:versionId/:kind: thumb | sprite | play (the proxy when there is one, else the source) | source
libraryApp.get("/media/:versionId/:kind", (c) => libraryMedia(c, c.get("user").username, c.req.param("versionId"), c.req.param("kind")));

/**
 * One item's picture or file for an account: a version the account may see, or an external ref whose source's policies
 * allow it (its own stream answers). Every route that serves library media goes through here, the Finals old-path
 * router included, so the policies are checked in one place.
 */
export async function libraryMedia(c: Context, username: string, versionId: string, kind: string): Promise<Response> {
  // an external ref (a plug-in source's item): its source's policies decide, then its own stream answers
  if (versionId.startsWith("ext_")) {
    const ref = externalRefById(versionId);
    const source = ref ? sourceById(ref.source) : undefined;
    const home = (db().prepare("SELECT id FROM libraries WHERE workspace_id = ? ORDER BY created_at, id LIMIT 1").get(homeOf(username)) as { id: string } | undefined)?.id;
    const viewer = home ? await readerOf(username, home) : null;
    if (!ref || !source?.stream || !home || !viewer || !(await canSee(viewer, externalAssetRef(ref, home)))) {
      return c.json({ error: "Not found", code: "not_found" }, 404);
    }
    if (kind !== "thumb" && kind !== "play" && kind !== "source") return c.json({ error: "Not found", code: "not_found" }, 404);
    const res = await source.stream(viewer, c.req.raw, ref.externalId, kind).catch(() => null);
    return res ?? c.json({ error: "Not found", code: "not_found" }, 404);
  }
  const v = db()
    .prepare("SELECT a.library_id, a.id AS asset_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?")
    .get(versionId) as { library_id: string; asset_id: string } | undefined;
  const viewer = v ? await readerOf(username, v.library_id) : null;
  if (!v || !viewer || !(await canSee(viewer, assetRef(v.library_id, v.asset_id, versionId)))) {
    return c.json({ error: "Not found", code: "not_found" }, 404);
  }
  const file = mediaFile(versionId, kind);
  if (!file) return c.json({ error: "Not found", code: "not_found" }, 404);
  if (file.onMac) return c.json({ error: `The original is on ${file.onMac}, not on this server`, code: "on_mac" }, 409);
  if (!file.key) return c.json({ error: "Not ready", code: "conflict" }, 409);
  const gate = await serveGate(versionId, kind, file);
  if (!gate.ok) return c.json(gate.body, gate.status);
  // a clip whose proxy was cleared (Library settings → Storage) gets it again when it is opened
  if (kind === "play" && unproxied(v.library_id, versionId).length) {
    enqueueJob(db(), v.library_id, versionId, "proxy", username, true);
    prepareFirst(versionId);
    libraryChanged(v.library_id);
  }
  return serveBlob(c, file.key, file.type, kind === "source" ? downloadName(versionId) : undefined);
}

// GET /api/library/versions/:versionId/similar → the videos in the caller's libraries of this workspace that share its pictures
libraryApp.get("/versions/:versionId/similar", async (c) => {
  const username = c.get("user").username;
  const found = similar(username, c.req.param("versionId"), (await librariesHere(username)).map((l) => l.id));
  if (!found) return c.json({ error: "Not fingerprinted yet", code: "not_found" }, 404);
  const matches = [];
  for (const m of found.matches) {
    const viewer = await readerOf(username, m.libraryId);
    if (viewer && (await canSee(viewer, assetRef(m.libraryId, m.assetId, m.versionId)))) matches.push(m);
  }
  return c.json({ ...found, matches });
});

/** A member's answer on a route that removes footage: they see the library, so 403, never 404. */
const OWNER_ONLY = { error: "Only the library's owner deletes footage", code: "forbidden" } as const;

/**
 * Into the trash, or back out of it: the library's owner only. A team member the owner gave the workspace (an admin
 * account too) gets 403 (owner, 2026-11-15/17: members add footage, never delete it); outsiders 404.
 */
async function setTrashed(c: Context<{ Variables: AuthVars }>, trash: boolean) {
  const user = c.get("user");
  const libraryId = c.req.param("id") ?? "";
  const assetId = c.req.param("assetId") ?? "";
  if (!libraryRole(user.username, libraryId)) {
    return (await givenLibrary(user.username, libraryId)) ? c.json(OWNER_ONLY, 403) : c.json({ error: "Not found", code: "not_found" }, 404);
  }
  const a = db().prepare("SELECT created_by, trashed_at, current_version_id FROM assets WHERE id = ? AND library_id = ?").get(assetId, libraryId) as
    | { created_by: string; trashed_at: number | null; current_version_id: string }
    | undefined;
  if (!a || (trash ? a.trashed_at !== null : a.trashed_at === null) || !(await mayWrite(user.username, libraryId, assetId, a.current_version_id))) {
    return c.json({ error: "Not found", code: "not_found" }, 404);
  }
  if (inReview(assetId)) return c.json(IN_REVIEW, 409);
  setTrashedAt(assetId, trash ? Date.now() : null);
  return c.json({ ok: true });
}

// DELETE /api/library/:id/assets/:assetId → the trash; its share links stop working until it is restored
libraryApp.delete("/:id/assets/:assetId", (c) => setTrashed(c, true));
// POST /api/library/:id/assets/:assetId/restore → out of the trash
libraryApp.post("/:id/assets/:assetId/restore", (c) => setTrashed(c, false));
// POST /api/library/:id/trash/empty → { deleted }: the owner empties the trash; nothing leaves it for its age
libraryApp.post("/:id/trash/empty", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  if (libraryRole(user.username, libraryId) !== "owner" || !(await inAskedWorkspace(user, libraryId))) return c.json({ error: "Not found", code: "not_found" }, 404);
  const deleted = await emptyTrash(libraryId);
  if (deleted) libraryChanged(libraryId);
  return c.json({ deleted });
});
