import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuthVars } from "../auth";
import { env } from "../lib/env";
import { appendBody, freeBytes, sha256File } from "../lib/uploads";
import { libraryRole } from "./access";
import { expandCollection } from "./collections";
import { blobs, libraryDb } from "./db";
import { canManage, ensureWorkspace, memberIn, workspaceOf } from "../lib/workspaces";
import { sendFile } from "../lib/send-file";
import type { LibrarySummary } from "../../contracts/library";
import { enqueueJob } from "./jobs";
import { buildAssetQuery, indexAsset, pageOf, parseSearch, type CardRow } from "./query";

/**
 * Media Library routes (tasks/media-library-plan.md, sections 4 and 7). Mounted at /api/library.
 * Uploads use the offset protocol: the staged file is the truth for Upload-Offset, so a dropped connection
 * resumes with HEAD, then PATCH from that offset. Only the uploader may touch an upload, and only while still
 * a member of the library's workspace; everyone else gets 404.
 */

export const libraryApp = new Hono<{ Variables: AuthVars }>();

const CHUNK_BYTES = 32 * 1024 * 1024;
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
}

const db = () => libraryDb();

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
    .prepare("SELECT id, staging_path FROM uploads WHERE state = 'open' AND expires_at < ?")
    .all(Date.now()) as { id: string; staging_path: string }[];
  for (const r of stale) {
    if (busy.has(r.id)) continue;
    await rm(r.staging_path, { force: true });
    db().prepare("UPDATE uploads SET state = 'failed' WHERE id = ?").run(r.id);
  }
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
  if (size > gbSetting("LIBRARY_MAX_UPLOAD_GB", 8) * GiB) return c.json({ error: "Too large", code: "too_large" }, 413);
  const replaces = typeof body?.replacesAssetId === "string" ? body.replacesAssetId : null;
  if (replaces) {
    const target = db().prepare("SELECT created_by FROM assets WHERE id = ? AND library_id = ? AND trashed_at IS NULL").get(replaces, libraryId) as
      | { created_by: string }
      | undefined;
    if (!target) return c.json({ error: "Not found", code: "not_found" }, 404);
    // a member replaces only their own assets (plan section 9); the owner any
    if (!canManage(role) && target.created_by !== user.username) return c.json({ error: "Only the uploader or the owner can replace it", code: "forbidden" }, 403);
  }
  const collection = typeof body?.collectionId === "string" ? body.collectionId : null;
  if (collection) {
    const col = db().prepare("SELECT kind FROM collections WHERE id = ? AND library_id = ?").get(collection, libraryId) as { kind: string } | undefined;
    if (!col) return c.json({ error: "Not found", code: "not_found" }, 404);
    if (col.kind !== "manual") return c.json({ error: "A smart collection takes its items from its query", code: "conflict" }, 409);
  }
  await sweepStale();
  await mkdir(stagingDir(), { recursive: true });
  // bytes the open uploads may still write count too, or several large uploads would each pass alone
  const pending = (db().prepare("SELECT COALESCE(SUM(size - received), 0) AS n FROM uploads WHERE state = 'open'").get() as { n: number }).n;
  if ((await freeBytes(stagingDir())) - pending - size < gbSetting("LIBRARY_DISK_RESERVE_GB", 20) * GiB) {
    return c.json({ error: "Not enough free disk space for this upload", code: "disk_reserve" }, 507);
  }
  const id = randomUUID();
  const staging = path.join(stagingDir(), id);
  await writeFile(staging, "");
  db()
    .prepare(
      `INSERT INTO uploads (id, library_id, created_by, filename, size, received, staging_path, replaces_asset_id, collection_id, expires_at, state)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'open')`,
    )
    .run(
      id,
      libraryId,
      user.username,
      String(body?.filename ?? "").trim().slice(0, 255) || "Untitled",
      size,
      staging,
      replaces,
      collection,
      Date.now() + STAGE_DAYS * 86_400_000,
    );
  return c.json({ id, offset: 0, chunkSize: CHUNK_BYTES }, 201);
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
    const got = await stagedBytes(row.staging_path);
    if (got !== row.size) return c.json({ error: "The upload is incomplete", code: "conflict", offset: got }, 409);
    const sha256 = await sha256File(row.staging_path);
    if (!row.replaces_asset_id) {
      const dup = db()
        .prepare(
          `SELECT a.id FROM asset_versions v JOIN assets a ON a.id = v.asset_id
           WHERE a.library_id = ? AND v.sha256 = ? AND a.trashed_at IS NULL LIMIT 1`,
        )
        .get(row.library_id, sha256) as { id: string } | undefined;
      if (dup) {
        await rm(row.staging_path, { force: true });
        db().prepare("UPDATE uploads SET state = 'done' WHERE id = ?").run(row.id);
        return c.json({ duplicateOf: dup.id });
      }
    }
    const versionId = randomUUID();
    const sourceKey = `libraries/${row.library_id}/v/${versionId}/source`;
    await blobs.put(sourceKey, row.staging_path); // same disk: a rename, the file moves into the library
    const now = Date.now();
    const assetId = row.replaces_asset_id ?? randomUUID();
    const d = db();
    d.exec("BEGIN");
    try {
      if (!row.replaces_asset_id) {
        const title = path.parse(row.filename).name.slice(0, 160) || "Untitled";
        d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?)")
          .run(assetId, row.library_id, kindOf(row.filename), title, row.created_by, now);
      }
      const { n } = d.prepare("SELECT COALESCE(MAX(n), 0) + 1 AS n FROM asset_versions WHERE asset_id = ?").get(assetId) as { n: number };
      d.prepare(
        `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, mime, state, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?)`,
      ).run(versionId, assetId, n, sourceKey, row.size, sha256, mimeOf(row.filename), row.created_by, now);
      d.prepare("UPDATE assets SET current_version_id = ? WHERE id = ?").run(versionId, assetId);
      d.prepare("UPDATE uploads SET state = 'done', received = size WHERE id = ?").run(row.id);
      // into the folder it was dropped in, while that is still a manual collection here (any member may add items)
      if (row.collection_id && d.prepare("SELECT 1 FROM collections WHERE id = ? AND library_id = ? AND kind = 'manual'").get(row.collection_id, row.library_id)) {
        d.prepare(
          `INSERT OR IGNORE INTO collection_items (collection_id, asset_id, position, added_by)
           SELECT ?, ?, COALESCE(MAX(position), 0) + 1, ? FROM collection_items WHERE collection_id = ?`,
        ).run(row.collection_id, assetId, row.created_by, row.collection_id);
      }
      indexAsset(d, assetId);
      enqueueJob(d, row.library_id, versionId, "probe", row.created_by);
      d.exec("COMMIT");
    } catch (e) {
      d.exec("ROLLBACK");
      throw e;
    }
    return c.json({ assetId, versionId });
  } catch (e) {
    db().prepare("UPDATE uploads SET state = 'failed' WHERE id = ?").run(row.id);
    return c.json({ error: e instanceof Error ? e.message : String(e), code: "conflict" }, 500);
  } finally {
    busy.delete(row.id);
  }
});

// GET /api/library → the libraries in the caller's workspace (none without one)
libraryApp.get("/", (c) => {
  const user = c.get("user");
  const w = workspaceOf(user.username);
  if (!w) return c.json({ libraries: [] as LibrarySummary[] });
  const manage = canManage(memberIn(w, user.username)?.role);
  const rows = db()
    .prepare("SELECT id, name, storage_kind FROM libraries WHERE workspace_id = ? ORDER BY created_at, id")
    .all(w.id) as { id: string; name: string; storage_kind: LibrarySummary["storage"] }[];
  const libraries: LibrarySummary[] = rows.map((r) => ({ id: r.id, name: r.name, storage: r.storage_kind, canManage: manage }));
  return c.json({ libraries });
});

// POST /api/library { name } → a local library in the caller's workspace; the owner only
libraryApp.post("/", async (c) => {
  const user = c.get("user");
  // an account in no workspace gets one of its own here (guests and demo visitors never reach a POST: boot.ts)
  const w = ensureWorkspace(user.username);
  if (!w) return c.json({ error: "There is no workspace to put a library in", code: "conflict" }, 409);
  if (!canManage(memberIn(w, user.username)?.role)) return c.json({ error: "Only the owner creates a library", code: "forbidden" }, 403);
  const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
  const name = (typeof body?.name === "string" ? body.name.trim().slice(0, 80) : "") || "Library";
  const id = `lib_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  db().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES (?, ?, ?, 'local', ?)").run(id, w.id, name, Date.now());
  const created: LibrarySummary = { id, name, storage: "local", canManage: true };
  return c.json(created, 201);
});

// GET /api/library/:id/assets?q&kind&tag&from&to&cursor&limit → one page of AssetCards (query.ts)
libraryApp.get("/:id/assets", (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  if (!libraryRole(user.username, libraryId)) return c.json({ error: "Not found", code: "not_found" }, 404);
  const query = expandCollection(libraryId, parseSearch(c.req.query()));
  if (!query) return c.json({ error: "Not found", code: "not_found" }, 404);
  const { sql, params, limit } = buildAssetQuery(libraryId, query);
  return c.json(pageOf(db().prepare(sql).all(...params) as unknown as CardRow[], limit));
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

// GET /api/library/media/:versionId/:kind: thumb | play (the proxy when there is one, else the source) | source
libraryApp.get("/media/:versionId/:kind", async (c) => {
  const user = c.get("user");
  const versionId = c.req.param("versionId");
  const v = db()
    .prepare("SELECT a.library_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?")
    .get(versionId) as { library_id: string } | undefined;
  if (!v || !libraryRole(user.username, v.library_id)) return c.json({ error: "Not found", code: "not_found" }, 404);
  const file = mediaFile(versionId, c.req.param("kind"));
  if (!file) return c.json({ error: "Not found", code: "not_found" }, 404);
  if (!file.key) return c.json({ error: "Not ready", code: "conflict" }, 409);
  try {
    return await sendFile(c, await blobs.localCopy(file.key), file.type);
  } catch {
    return c.json({ error: "Not ready", code: "conflict" }, 409);
  }
});

/** Into the trash, or back out of it: the uploader or the owner. Other members of the library get 403; outsiders 404. */
function setTrashed(c: Context<{ Variables: AuthVars }>, trash: boolean) {
  const user = c.get("user");
  const libraryId = c.req.param("id") ?? "";
  const assetId = c.req.param("assetId") ?? "";
  const role = libraryRole(user.username, libraryId);
  const a = role
    ? (db().prepare("SELECT created_by, trashed_at FROM assets WHERE id = ? AND library_id = ?").get(assetId, libraryId) as
        | { created_by: string; trashed_at: number | null }
        | undefined)
    : undefined;
  if (!a || (trash ? a.trashed_at !== null : a.trashed_at === null)) return c.json({ error: "Not found", code: "not_found" }, 404);
  if (!canManage(role ?? undefined) && a.created_by !== user.username) return c.json({ error: "Only the uploader or the owner can do that", code: "forbidden" }, 403);
  db().prepare("UPDATE assets SET trashed_at = ? WHERE id = ?").run(trash ? Date.now() : null, assetId);
  return c.json({ ok: true });
}

// DELETE /api/library/:id/assets/:assetId → the trash; its share links stop working until it is restored
libraryApp.delete("/:id/assets/:assetId", (c) => setTrashed(c, true));
// POST /api/library/:id/assets/:assetId/restore → out of the trash
libraryApp.post("/:id/assets/:assetId/restore", (c) => setTrashed(c, false));
