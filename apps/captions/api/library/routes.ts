import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, open, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AuthVars } from "../auth";
import { env } from "../lib/env";
import { appendBody, freeBytes, sha256File } from "../lib/uploads";
import { ensureLibrary, homeOf, libraryChanged, libraryRole, mayWrite } from "./access";
import { expandCollection } from "./collections";
import { blobs, libraryDb, librarySetting, libraryStore, meter, SETTING_DEFAULTS } from "./db";
import { estimate, progress } from "./estimate";
import { sendFile } from "../lib/send-file";
import { notifyLibraryChanges } from "../lib/events";
import type { AssetCard, LibrarySettings, LibrarySummary } from "../../contracts/library";
import type { LibraryViewer } from "../../contracts/library-source";
import { enqueueJob, prepareFirst } from "./jobs";
import { needsProxy } from "./media/proxy";
import type { ProbeSummary } from "./media/probe";
import { spaceApp } from "./space";
import { inReview } from "./trash";
import { similar } from "./similar";
import { assetRef, canSee, sourceById, SourceRefusal, sourcesVisibleTo } from "./sources";
import { externalAssetRef, externalRefById } from "./refs";
import { buildAssetQuery, indexAsset, pageOf, parseSearch, type CardRow } from "./query";
import { fileRoll, rollFolder } from "./roll";
// watch.ts imports from this file too: its functions are only called inside handlers, never while the files load
import { IMPORT_WAIT_MS, takeFile, watchAllowed } from "./watch";

/**
 * Media Library routes (tasks/media-library-plan.md, sections 4 and 7). Mounted at /api/library.
 * Uploads use the offset protocol: the staged file is the truth for Upload-Offset, so a dropped connection
 * resumes with HEAD, then PATCH from that offset. Only the uploader may touch an upload, and only while still
 * a member of the library's workspace; everyone else gets 404.
 */

export const libraryApp = new Hono<{ Variables: AuthVars }>();
libraryApp.use("*", notifyLibraryChanges);
libraryApp.route("/", spaceApp); // GET /:id/space, POST /:id/space/clear

const CHUNK_BYTES = 32 * 1024 * 1024;

/** Told each finished upload's id and the version it became (a duplicate's current version): an edit waiting on it starts. */
export const onUploadDone: ((uploadId: string, versionId: string) => void)[] = [];
const uploadDone = (uploadId: string, versionId: string | null | undefined) => {
  if (versionId) for (const f of onUploadDone) f(uploadId, versionId);
};
const STAGE_DAYS = 7;
const GiB = 1024 ** 3;
const stagingDir = () => path.join(env.dataDir, "library", "staging");
// ponytail: one writer per upload, in-process only; a second server process would need a DB lock
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
 * The library's read videos (or `versionId` alone) that need a proxy and have none, nor one on its way, while the
 * library makes proxies (its settings).
 */
function unproxied(libraryId: string, versionId?: string): { id: string; created_by: string }[] {
  if (!librarySetting(libraryId, "proxy")) return [];
  const rows = db()
    .prepare(
      `SELECT v.id, v.created_by, v.probe FROM asset_versions v JOIN assets a ON a.id = v.asset_id
       WHERE a.library_id = ? AND (? IS NULL OR v.id = ?) AND v.probe IS NOT NULL AND v.state != 'missing'
         AND NOT EXISTS (SELECT 1 FROM derivatives d WHERE d.version_id = v.id AND d.kind = 'proxy')
         AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.version_id = v.id AND j.kind = 'proxy' AND j.state IN ('queued', 'running', 'failed'))`,
    )
    .all(libraryId, versionId ?? null, versionId ?? null) as { id: string; created_by: string; probe: string }[];
  return rows.filter((r) => needsProxy(JSON.parse(r.probe) as ProbeSummary));
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
    `INSERT INTO asset_versions (id, asset_id, n, source_key, source_path, bytes, sha256, mime, state, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?)`,
  ).run(o.versionId, assetId, n, o.sourceKey, o.sourcePath ?? null, o.size, o.sha256, mimeOf(o.filename), o.by, now);
  d.prepare("UPDATE assets SET current_version_id = ? WHERE id = ?").run(o.versionId, assetId);
  if (o.collectionId && d.prepare("SELECT 1 FROM collections WHERE id = ? AND library_id = ? AND kind = 'manual'").get(o.collectionId, o.libraryId)) {
    d.prepare(
      `INSERT OR IGNORE INTO collection_items (collection_id, asset_id, position, added_by)
       SELECT ?, ?, COALESCE(MAX(position), 0) + 1, ? FROM collection_items WHERE collection_id = ?`,
    ).run(o.collectionId, assetId, o.by, o.collectionId);
  }
  const roll = o.collectionId ? rollFolder(d, o.libraryId, o.collectionId) : null; // uploaded into the A-roll folder: filed as A-roll
  if (roll) fileRoll(d, assetId, roll);
  indexAsset(d, assetId);
  enqueueJob(d, o.libraryId, o.versionId, "probe", o.by);
  return assetId;
}

/**
 * A finished file saved into a library as a new asset (a Caption Studio export): copied, so the file stays where it
 * is. `sources` are the library versions it was made from; each one the caller may read gets a `derived_from` row.
 * Without `libraryId`, the first library of the caller's workspace. Null: no library the caller may use.
 */
export async function saveToLibrary(
  username: string,
  file: string,
  filename: string,
  sources: string[],
  libraryId?: string,
  footage = false,
): Promise<{ assetId: string; versionId: string } | { duplicateOf: string } | { error: string; code: "disk_reserve" } | null> {
  const lib =
    libraryId ??
    (db().prepare("SELECT id FROM libraries WHERE workspace_id = ? ORDER BY created_at, id LIMIT 1").get(homeOf(username)) as { id: string } | undefined)?.id;
  if (!lib || !libraryRole(username, lib)) return null;
  const { size } = await stat(file);
  await mkdir(stagingDir(), { recursive: true });
  if ((await freeBytes(stagingDir())) - size < gbSetting("LIBRARY_DISK_RESERVE_GB", 20) * GiB) {
    return { error: "Not enough free disk space for this file", code: "disk_reserve" };
  }
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
      const assetId = recordVersion(d, { libraryId: lib, versionId, sourceKey, filename, size, sha256, by: username });
      if (!footage) fileRoll(d, assetId, "none"); // a finished file (an export, a Finals file) is never A-roll or B-roll
      for (const from of new Set(sources)) {
        const src = d.prepare("SELECT a.library_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(from) as
          | { library_id: string }
          | undefined;
        if (src && libraryRole(username, src.library_id)) {
          d.prepare("INSERT OR IGNORE INTO derived_from (version_id, source_version_id, note) VALUES (?, ?, 'export')").run(versionId, from);
        }
      }
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
}

const db = () => libraryDb();

// a Review video: Review owns its versions and its trash, so the library refuses to add a version or trash it
const IN_REVIEW = { error: "This video lives in Review: change it there", code: "conflict" } as const;

/** The caller's upload, if they started it and still may use its library; otherwise null (404). */
function ownUpload(c: Context<{ Variables: AuthVars }>): UploadRow | null {
  const user = c.get("user");
  const row = db().prepare("SELECT * FROM uploads WHERE id = ?").get(c.req.param("uploadId") ?? "") as UploadRow | undefined;
  if (!row || row.created_by !== user.username || !libraryRole(user.username, row.library_id)) return null;
  return row;
}

const stagedBytes = (file: string) => stat(file).then((s) => s.size, () => -1);

/** Uploads nobody resumed within STAGE_DAYS: staging file removed, row marked failed. Runs when a new upload starts. */
async function sweepStale(): Promise<void> {
  const stale = db()
    .prepare("SELECT id, library_id, staging_path, direct_upload_id FROM uploads WHERE state = 'open' AND expires_at < ?")
    .all(Date.now()) as { id: string; library_id: string; staging_path: string; direct_upload_id: string | null }[];
  for (const r of stale) {
    if (busy.has(r.id)) continue;
    if (r.direct_upload_id) {
      // a bucket that is no longer set up must not stop every new upload: its parts are left for the bucket to expire
      try {
        await libraryStore(r.library_id).direct?.abort(sourceKeyOf(r.library_id, r.id), r.direct_upload_id);
      } catch {}
    } else await rm(r.staging_path, { force: true });
    db().prepare("UPDATE uploads SET state = 'failed' WHERE id = ?").run(r.id);
  }
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
  if (!row.replaces_asset_id) {
    const dup = db()
      .prepare(
        `SELECT a.id, a.current_version_id AS current FROM asset_versions v JOIN assets a ON a.id = v.asset_id
         WHERE a.library_id = ? AND v.sha256 = ? AND a.trashed_at IS NULL LIMIT 1`,
      )
      .get(row.library_id, sha256) as { id: string; current: string | null } | undefined;
    if (dup) {
      await store.delete(key); // not metered yet, so no usage to take back
      db().prepare("UPDATE uploads SET state = 'done' WHERE id = ?").run(row.id);
      uploadDone(row.id, dup.current);
      return c.json({ duplicateOf: dup.id });
    }
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
      size: row.size,
      sha256,
      by: row.created_by,
      collectionId: row.collection_id,
    });
    d.prepare("UPDATE uploads SET state = 'done', received = size WHERE id = ?").run(row.id);
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    await blobs.delete(key); // metered above, so the delete takes the usage back
    throw e;
  }
  uploadDone(row.id, row.id);
  return c.json({ assetId, versionId: row.id });
}

// POST /api/library/:id/uploads: { filename, size, replacesAssetId?, collectionId? } → 201 { id, offset, chunkSize }
libraryApp.post("/:id/uploads", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  const role = libraryRole(user.username, libraryId);
  if (!role) return c.json({ error: "Not found", code: "not_found" }, 404);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
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
  const collection = typeof body?.collectionId === "string" ? body.collectionId : null;
  if (collection) {
    const col = db().prepare("SELECT kind FROM collections WHERE id = ? AND library_id = ?").get(collection, libraryId) as { kind: string } | undefined;
    if (!col) return c.json({ error: "Not found", code: "not_found" }, 404);
    if (col.kind !== "manual" && !rollFolder(db(), libraryId, collection)) return c.json({ error: "A smart collection takes its items from its query", code: "conflict" }, 409);
  }
  await sweepStale();
  const id = randomUUID();
  const filename = String(body?.filename ?? "").trim().slice(0, 255) || "Untitled";
  const staging = path.join(stagingDir(), id);
  // a bucket library takes the bytes straight from the browser (presigned part PUTs); the server only starts and finishes
  const direct = libraryStore(libraryId).direct;
  const started = direct ? await direct.start(sourceKeyOf(libraryId, id), size, { contentType: mimeOf(filename) }) : null;
  if (!started) {
    await mkdir(stagingDir(), { recursive: true });
    // bytes the open uploads may still write count too, or several large uploads would each pass alone
    const pending = (db().prepare("SELECT COALESCE(SUM(size - received), 0) AS n FROM uploads WHERE state = 'open' AND direct_upload_id IS NULL").get() as { n: number }).n;
    if ((await freeBytes(stagingDir())) - pending - size < gbSetting("LIBRARY_DISK_RESERVE_GB", 20) * GiB) {
      return c.json({ error: "Not enough free disk space for this upload", code: "disk_reserve" }, 507);
    }
    await writeFile(staging, "");
  }
  db()
    .prepare(
      `INSERT INTO uploads (id, library_id, created_by, filename, size, received, staging_path, replaces_asset_id, collection_id, expires_at, state, direct_upload_id)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'open', ?)`,
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
    );
  if (started) return c.json({ id, offset: 0, chunkSize: started.partSize, direct: { partSize: started.partSize, urls: started.urls } }, 201);
  return c.json({ id, offset: 0, chunkSize: CHUNK_BYTES }, 201);
});

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
  if (!libraryRole(user.username, libraryId)) return c.json({ error: "Not found", code: "not_found" }, 404);
  if (!watchAllowed(user.username)) return c.json({ error: "This server is not on your computer: upload the file", code: "forbidden" }, 403);
  const body = ((await c.req.json().catch(() => null)) ?? {}) as { path?: unknown; size?: unknown; collectionId?: unknown; again?: unknown };
  const given = typeof body.path === "string" ? body.path : "";
  const refuse = (error: string) => c.json({ error, code: "invalid" }, 400);
  if (!path.isAbsolute(given)) return refuse("Not a full path");
  const real = await realpath(given).catch(() => null);
  const s = real ? await stat(real).catch(() => null) : null;
  if (!real || !s?.isFile()) return refuse(`No such file on this computer: ${given}`);
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
  if (!v) return c.json({ error: "It could not be added", code: "conflict" }, 409);
  if (v.trashed_at) return c.json({ error: "In the trash in the Media Library: restore it there to use it", code: "conflict" }, 409);
  // this very file, taken now (or by the call this one asks again for); anything else was in the library already
  if (v.source_path === real && (got.fresh || body.again === true)) return c.json({ assetId: v.id, versionId: got.versionId });
  return c.json({ duplicateOf: v.id });
});

// HEAD /api/library/uploads/:uploadId → Upload-Offset: what is on disk. Hono sends HEAD through GET, so this is a GET
// route (the body is empty for HEAD).
libraryApp.get("/uploads/:uploadId", async (c) => {
  const row = ownUpload(c);
  const received = row && (await stagedBytes(row.staging_path));
  if (!row || received === -1) return c.body(null, 404);
  c.header("Upload-Offset", String(received));
  return c.body(null, 200);
});

// PATCH /api/library/uploads/:uploadId, Upload-Offset: n, body from n → 204 Upload-Offset | 409 { offset }
libraryApp.patch("/uploads/:uploadId", async (c) => {
  const row = ownUpload(c);
  if (!row || row.state !== "open") return c.json({ error: "Not found", code: "not_found" }, 404);
  if (row.direct_upload_id) return c.json({ error: "This upload goes straight to the bucket", code: "conflict" }, 409);
  if (busy.has(row.id)) return c.json({ error: "Upload in progress", code: "conflict", offset: await stagedBytes(row.staging_path) }, 409);
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
  const row = ownUpload(c);
  if (!row) return c.json({ error: "Not found", code: "not_found" }, 404);
  if (row.state !== "open") return c.json({ error: "Already finished", code: "conflict" }, 409);
  if (busy.has(row.id)) return c.json({ error: "Upload in progress", code: "conflict", offset: await stagedBytes(row.staging_path) }, 409);
  busy.add(row.id);
  try {
    if (row.direct_upload_id) return await finishDirect(c, row);
    const got = await stagedBytes(row.staging_path);
    if (got !== row.size) return c.json({ error: "The upload is incomplete", code: "conflict", offset: got }, 409);
    const sha256 = await sha256File(row.staging_path);
    if (!row.replaces_asset_id) {
      const dup = db()
        .prepare(
          `SELECT a.id, a.current_version_id AS current FROM asset_versions v JOIN assets a ON a.id = v.asset_id
           WHERE a.library_id = ? AND v.sha256 = ? AND a.trashed_at IS NULL LIMIT 1`,
        )
        .get(row.library_id, sha256) as { id: string; current: string | null } | undefined;
      if (dup) {
        await rm(row.staging_path, { force: true });
        db().prepare("UPDATE uploads SET state = 'done' WHERE id = ?").run(row.id);
        uploadDone(row.id, dup.current);
        return c.json({ duplicateOf: dup.id });
      }
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
        size: row.size,
        sha256,
        by: row.created_by,
        collectionId: row.collection_id, // the folder it was dropped in
      });
      d.prepare("UPDATE uploads SET state = 'done', received = size WHERE id = ?").run(row.id);
      d.exec("COMMIT");
    } catch (e) {
      d.exec("ROLLBACK");
      throw e;
    }
    uploadDone(row.id, versionId);
    return c.json({ assetId, versionId });
  } catch (e) {
    db().prepare("UPDATE uploads SET state = 'failed' WHERE id = ?").run(row.id);
    return c.json({ error: e instanceof Error ? e.message : String(e), code: "conflict" }, 500);
  } finally {
    busy.delete(row.id);
  }
});

// GET /api/library → the caller's libraries
libraryApp.get("/", (c) => {
  const user = c.get("user");
  ensureLibrary(user.username);
  const rows = db()
    .prepare("SELECT id, name, storage_kind, settings FROM libraries WHERE workspace_id = ? ORDER BY created_at, id")
    .all(homeOf(user.username)) as { id: string; name: string; storage_kind: LibrarySummary["storage"]; settings: string }[];
  const libraries: LibrarySummary[] = rows.map((r) => ({ id: r.id, name: r.name, storage: r.storage_kind, settings: settingsOf(r.settings) }));
  return c.json({ libraries });
});

const settingsOf = (json: string): LibrarySettings => {
  const s = JSON.parse(json || "{}") as Partial<LibrarySettings>;
  return { describe: s.describe ?? SETTING_DEFAULTS.describe, embed: s.embed ?? SETTING_DEFAULTS.embed, proxy: s.proxy ?? SETTING_DEFAULTS.proxy };
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

// PATCH /api/library/:id { name?, settings?: { describe?, embed?, proxy? } } → LibrarySummary; the owner only. Proxies
// off: the ones still queued are dropped; on: the clips that need one and have none get one
libraryApp.patch("/:id", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  const role = libraryRole(user.username, libraryId);
  if (!role) return c.json({ error: "Not found", code: "not_found" }, 404);
  const b = (await c.req.json().catch(() => null)) as { name?: unknown; settings?: Record<string, unknown> } | null;
  const name = typeof b?.name === "string" ? b.name.trim().slice(0, 80) : "";
  if (name) db().prepare("UPDATE libraries SET name = ? WHERE id = ?").run(name, libraryId);
  // one key at a time: other settings (watch folders) are written by other code
  for (const key of ["describe", "embed", "proxy"] as const) {
    const on = b?.settings?.[key];
    if (typeof on === "boolean") db().prepare(`UPDATE libraries SET settings = json_set(settings, '$.${key}', json(?)) WHERE id = ?`).run(String(on), libraryId);
  }
  const proxy = b?.settings?.proxy;
  if (proxy === false) db().prepare("DELETE FROM jobs WHERE library_id = ? AND kind = 'proxy' AND state IN ('queued', 'failed')").run(libraryId);
  if (proxy === true) for (const v of unproxied(libraryId)) enqueueJob(db(), libraryId, v.id, "proxy", v.created_by, true);
  if (typeof proxy === "boolean") libraryChanged(libraryId);
  const r = db().prepare("SELECT name, storage_kind, settings FROM libraries WHERE id = ?").get(libraryId) as {
    name: string;
    storage_kind: LibrarySummary["storage"];
    settings: string;
  };
  const updated: LibrarySummary = { id: libraryId, name: r.name, storage: r.storage_kind, settings: settingsOf(r.settings) };
  return c.json(updated);
});

// POST /api/library { name } → a local library of the caller's own
libraryApp.post("/", async (c) => {
  const user = c.get("user");
  if (user.role === "visitor") return c.json({ error: "Sign in to make a library", code: "forbidden" }, 403);
  const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
  const name = (typeof body?.name === "string" ? body.name.trim().slice(0, 80) : "") || "Library";
  const id = `lib_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  db().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES (?, ?, ?, 'local', ?)").run(id, homeOf(user.username), name, Date.now());
  const created: LibrarySummary = { id, name, storage: "local", settings: { ...SETTING_DEFAULTS } };
  return c.json(created, 201);
});

/** Who is asking about a library: its role there (owner, or null for no access), for the policies in sources.ts. */
export function viewerOf(username: string, libraryId: string): LibraryViewer | null {
  const role = libraryRole(username, libraryId);
  return role ? { username, role } : null;
}

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
  const viewer = viewerOf(user.username, c.req.param("id"));
  if (!viewer) return c.json({ error: "Not found", code: "not_found" }, 404);
  const sources = await sourcesVisibleTo(viewer);
  return c.json({ sources: sources.map((s) => ({ id: s.id, label: s.label, ...(s.main ? { main: true } : {}) })) });
});

libraryApp.get("/:id/assets", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  const viewer = viewerOf(user.username, libraryId);
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
  const query = expandCollection(libraryId, parseSearch(c.req.query()));
  if (!query) return c.json({ error: "Not found", code: "not_found" }, 404);
  const { sql, params, limit } = buildAssetQuery(libraryId, query);
  const page = pageOf(db().prepare(sql).all(...params) as unknown as CardRow[], limit);
  return c.json({ ...page, items: await visibleCards(viewer, libraryId, page.items) });
});

/** The blob a media URL serves: thumb, play (the proxy when there is one, else the source) or source. Null: no such kind. */
export function mediaFile(versionId: string, kind: string): { key?: string; type: string } | null {
  const v = db().prepare("SELECT source_key, mime FROM asset_versions WHERE id = ?").get(versionId) as
    | { source_key: string; mime: string | null }
    | undefined;
  if (!v) return null;
  const derived = (k: string) =>
    (db().prepare("SELECT storage_key FROM derivatives WHERE version_id = ? AND kind = ?").get(versionId, k) as
      | { storage_key: string | null }
      | undefined)?.storage_key ?? undefined;
  const original = v.mime ?? "application/octet-stream";
  if (kind === "thumb") return { key: derived("thumb"), type: "image/jpeg" };
  if (kind === "play") {
    const proxy = derived("proxy");
    return { key: proxy ?? v.source_key, type: proxy ? "video/mp4" : original };
  }
  if (kind === "source") return { key: v.source_key, type: original };
  return null;
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

// GET /api/library/media/:versionId/:kind: thumb | play (the proxy when there is one, else the source) | source
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
    const viewer = home ? viewerOf(username, home) : null;
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
  const viewer = v ? viewerOf(username, v.library_id) : null;
  if (!v || !viewer || !(await canSee(viewer, assetRef(v.library_id, v.asset_id, versionId)))) {
    return c.json({ error: "Not found", code: "not_found" }, 404);
  }
  const file = mediaFile(versionId, kind);
  if (!file) return c.json({ error: "Not found", code: "not_found" }, 404);
  if (!file.key) return c.json({ error: "Not ready", code: "conflict" }, 409);
  // a clip whose proxy was cleared (Library settings → Storage) gets it again when it is opened
  if (kind === "play" && unproxied(v.library_id, versionId).length) {
    enqueueJob(db(), v.library_id, versionId, "proxy", username, true);
    prepareFirst(versionId);
    libraryChanged(v.library_id);
  }
  return serveBlob(c, file.key, file.type, kind === "source" ? downloadName(versionId) : undefined);
}

// GET /api/library/versions/:versionId/similar → the videos in the caller's libraries that share its pictures
libraryApp.get("/versions/:versionId/similar", async (c) => {
  const username = c.get("user").username;
  const found = similar(username, c.req.param("versionId"));
  if (!found) return c.json({ error: "Not fingerprinted yet", code: "not_found" }, 404);
  const matches = [];
  for (const m of found.matches) {
    const viewer = viewerOf(username, m.libraryId);
    if (viewer && (await canSee(viewer, assetRef(m.libraryId, m.assetId, m.versionId)))) matches.push(m);
  }
  return c.json({ ...found, matches });
});

/** Into the trash, or back out of it: the uploader or the owner. Other members of the library get 403; outsiders 404. */
async function setTrashed(c: Context<{ Variables: AuthVars }>, trash: boolean) {
  const user = c.get("user");
  const libraryId = c.req.param("id") ?? "";
  const assetId = c.req.param("assetId") ?? "";
  const role = libraryRole(user.username, libraryId);
  const a = role
    ? (db().prepare("SELECT created_by, trashed_at, current_version_id FROM assets WHERE id = ? AND library_id = ?").get(assetId, libraryId) as
        | { created_by: string; trashed_at: number | null; current_version_id: string }
        | undefined)
    : undefined;
  if (!a || (trash ? a.trashed_at !== null : a.trashed_at === null) || !(await mayWrite(user.username, libraryId, assetId, a.current_version_id))) {
    return c.json({ error: "Not found", code: "not_found" }, 404);
  }
  if (inReview(assetId)) return c.json(IN_REVIEW, 409);
  db().prepare("UPDATE assets SET trashed_at = ? WHERE id = ?").run(trash ? Date.now() : null, assetId);
  return c.json({ ok: true });
}

// DELETE /api/library/:id/assets/:assetId → the trash; its share links stop working until it is restored
libraryApp.delete("/:id/assets/:assetId", (c) => setTrashed(c, true));
// POST /api/library/:id/assets/:assetId/restore → out of the trash
libraryApp.post("/:id/assets/:assetId/restore", (c) => setTrashed(c, false));
