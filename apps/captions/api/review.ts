import { Hono, type Context } from "hono";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { AuthVars } from "./auth";
import { sendFile } from "./lib/send-file";

import { ffmpegCommand } from "./ffmpeg-runtime";
import {
  assembleParts,
  MAX_UPLOAD_BYTES,
  PART_SIZE,
  readUploadState,
  receivedParts,
  receivePart,
  sha256File,
  startUpload,
  writeBody,
  type UploadState,
} from "./lib/uploads";
import { env } from "./lib/env";
import { clipReadyToEdit, createProjectFromFile, linkOrCopy } from "./projects";
import { findUser, USERNAME_RE, type SessionUser } from "./users";
import { homeOf } from "./library/access";
import { blobs, libraryDb } from "./library/db";
import { enqueueJob } from "./library/jobs";
import { probe as probeSummary } from "./library/media/probe";
import { indexAsset } from "./library/query";
import { deleteAssets } from "./library/trash";

export { sendFile };

/**
 * Review — Frame.io-style video review. Upload a video (and new versions
 * of it), share one link, and reviewers leave comments on a timecode or a
 * range, with drawings on the frame, replies and an approval.
 *
 * Owner routes live under /assets/:id (login). The same read/comment
 * routes are mounted again under /s/:token for a video's share link and
 * under /p/:token/a/:id for a project's share link (any video filed in it).
 *
 * $DATA_DIR/review/
 *   <id>/meta.json       asset, versions, share + approval
 *   <id>/comments.json   every comment on every version
 *   <id>/v<n>/source     the upload as-is
 *   <id>/v<n>/proxy.mp4  H.264 copy when browsers can't play the source
 *   <id>/v<n>/thumb.jpg
 *   <id>/v<n>/refs/<ref>  a reference attached to a comment, with <ref>.json
 *                         and <ref>.jpg (what an AI reads of it)
 *   uploads/<uploadId>/  chunked upload parts (resumable; swept after UPLOAD_DAYS)
 *   links/<token>        share token -> asset id, or "project:<id>" for a project link
 *   projects.json        every user's projects (folders); a video points at one with projectId
 *   trash/<id>/          a deleted video, as it was, for TRASH_DAYS
 *   notifications/<user>.json  that user's inbox, newest first
 */

export const reviewApp = new Hono<{ Variables: AuthVars }>();

const ROOT = path.join(env.dataDir, "review");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const assetDir = (id: string) => path.join(ROOT, id);
const metaPath = (id: string) => path.join(assetDir(id), "meta.json");
const commentsPath = (id: string) => path.join(assetDir(id), "comments.json");
const versionDir = (id: string, n: number) => path.join(assetDir(id), `v${n}`);
export const sourcePath = (id: string, n: number) => path.join(versionDir(id, n), "source");
const proxyPath = (id: string, n: number) => path.join(versionDir(id, n), "proxy.mp4");
const thumbPath = (id: string, n: number) => path.join(versionDir(id, n), "thumb.jpg");
const refsDir = (id: string, n: number) => path.join(versionDir(id, n), "refs");
const uploadDir = (uid: string) => path.join(ROOT, "uploads", uid);
const linkPath = (token: string) => path.join(ROOT, "links", token);
const projectsPath = path.join(ROOT, "projects.json");
const trashDir = (id: string) => path.join(ROOT, "trash", id);
const inboxPath = (user: string) => path.join(ROOT, "notifications", `${user}.json`);
const PROJECT_LINK = "project:";
const TRASH_DAYS = 30;
const UPLOAD_DAYS = 7;

export const APPROVALS = ["none", "in_progress", "needs_review", "changes", "approved"] as const;
type Approval = (typeof APPROVALS)[number];
/** What a reviewer on the share link may set. */
const REVIEWER_APPROVALS: Approval[] = ["changes", "approved"];

interface Version {
  n: number;
  /** Its Media Library version (toLibrary): stable while `n` changes with order, stack and unstack. */
  versionId?: string;
  name: string;
  mime: string;
  bytes: number;
  duration: number;
  fps: number;
  width: number;
  height: number;
  status: "processing" | "ready" | "error";
  progress: number;
  error?: string;
  proxy?: boolean;
  captions?: CaptionsLink;
  /** Captions are burned into this file (it skipped Caption Studio). */
  captioned?: boolean;
  /** The version in this stack it was made from: the same cut without captions. */
  madeFrom?: number;
  /** When its video files were deleted to save space (a later version went on
   *  to Caption Studio); its comments and thumbnail stay. */
  removed?: number;
  createdAt: number;
}

type Share = { token: string; enabled: boolean; download: boolean };

interface Meta {
  id: string;
  name: string;
  owner: string;
  /** The project (folder) it's filed in; absent = top level. */
  projectId?: string;
  versions: Version[];
  share?: Share;
  approval: { status: Approval; by?: string; at?: number };
  /** In the trash since. */
  deletedAt?: number;
  /** Marked Finished or In progress by hand (Review's tabs), until a newer version comes in. */
  done?: { finished: boolean; at: number };
  /** Owner last looked; later comments from others count as new. */
  seenAt?: number;
  createdAt: number;
  updatedAt: number;
}

interface Stroke {
  color: string;
  points: [number, number][];
}

interface Comment {
  id: string;
  version: number;
  parentId?: string;
  /** Seconds. Absent = a general comment (and on every reply). */
  t?: number;
  tEnd?: number;
  text: string;
  author: string;
  /** Logged-in author. */
  user?: string;
  /** Guest author's browser secret; never sent back out. */
  guestKey?: string;
  drawing?: Stroke[];
  /** Images and videos attached to show what's meant. */
  refs?: Ref[];
  resolved?: boolean;
  createdAt: number;
  editedAt?: number;
}


/** A reference on a comment: the file as uploaded, `kind` video for anything
 *  that moves (a GIF too). Lives in its version's folder, so it moves with it. */
type Ref = { id: string; name: string; mime: string; bytes: number; kind: "image" | "video" };
const REFS_PER_VERSION = 100;

type UploadInit = UploadState & { assetId?: string; projectId?: string };

interface Project {
  id: string;
  name: string;
  owner: string;
  share?: Share;
  createdAt: number;
}
/** The Caption Studio clip that works on this version's file. */
type CaptionsLink = { projectId: string; clipId: string };

// ---------- storage ----------

const locks = new Map<string, Promise<unknown>>();

/** Serialize every read-modify-write of one asset. */
function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const next = (locks.get(id) ?? Promise.resolve()).then(fn, fn);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  locks.set(id, settled);
  void settled.then(() => {
    if (locks.get(id) === settled) locks.delete(id);
  });
  return next;
}

async function writeJson(p: string, data: unknown): Promise<void> {
  const tmp = `${p}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, p);
}

export async function readMeta(id: string): Promise<Meta | null> {
  if (!UUID.test(id)) return null;
  try {
    return JSON.parse(await readFile(metaPath(id), "utf-8")) as Meta;
  } catch {
    return null;
  }
}

export async function readComments(id: string): Promise<Comment[]> {
  try {
    return JSON.parse(await readFile(commentsPath(id), "utf-8")) as Comment[];
  } catch {
    return [];
  }
}

/** Mutate meta under the lock; `null` when the asset is gone. */
function updateMeta(id: string, fn: (m: Meta) => void): Promise<Meta | null> {
  return withLock(id, async () => {
    const meta = await readMeta(id);
    if (!meta) return null;
    fn(meta);
    meta.updatedAt = Date.now();
    await writeJson(metaPath(id), meta);
    return meta;
  });
}

function updateComments<T>(id: string, fn: (list: Comment[]) => T): Promise<T> {
  return withLock(id, async () => {
    const list = await readComments(id);
    const out = fn(list);
    if (existsSync(assetDir(id))) await writeJson(commentsPath(id), list);
    return out;
  });
}

/** The Review video (and its project) whose version a Caption Studio project captions. */
export async function reviewOrigin(captionsProjectId: string) {
  for (const m of await allMetas()) {
    const version = m.versions.find((x) => x.captions?.projectId === captionsProjectId);
    if (version) {
      const project = m.projectId ? (await readProjects()).find((p) => p.id === m.projectId) : undefined;
      return { meta: m, version, project: project && { id: project.id, name: project.name } };
    }
  }
  return null;
}

/** Where a Caption Studio project came from (its owner or an admin): the Review version it captions. */
reviewApp.get("/origin/:projectId", async (c) => {
  const user = c.get("user");
  const o = await reviewOrigin(c.req.param("projectId"));
  if (!o || (o.meta.owner !== user.username && user.role !== "admin")) return c.json({});
  return c.json({ review: { asset: o.meta.id, n: o.version.n, name: o.meta.name } });
});

async function allMetas(): Promise<Meta[]> {
  const ids = (await readdir(ROOT).catch(() => [] as string[])).filter((d) => UUID.test(d));
  return (await Promise.all(ids.map(readMeta))).filter((m): m is Meta => !!m);
}

async function readProjects(): Promise<Project[]> {
  try {
    return JSON.parse(await readFile(projectsPath, "utf-8")) as Project[];
  } catch {
    return [];
  }
}

function updateProjects<T>(fn: (list: Project[]) => T): Promise<T> {
  return withLock("projects", async () => {
    const list = await readProjects();
    const out = fn(list);
    await writeJson(projectsPath, list);
    return out;
  });
}

const ownsProject = async (owner: string, pid: unknown) =>
  typeof pid === "string" && (await readProjects()).some((p) => p.id === pid && p.owner === owner);

// ---------- media processing ----------

interface Probe {
  duration: number;
  fps: number;
  width: number;
  height: number;
  format: string;
  vcodec: string;
  pixFmt: string;
  acodec: string;
}

function probe(file: string): Promise<Probe | null> {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", [
      "-v", "error",
      "-show_entries",
      "format=duration,format_name:stream=codec_type,codec_name,pix_fmt,width,height,avg_frame_rate,r_frame_rate",
      "-of", "json",
      file,
    ]);
    let out = "";
    const kill = setTimeout(() => p.kill("SIGKILL"), 30_000);
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("error", () => resolve(null));
    p.on("close", () => {
      clearTimeout(kill);
      try {
        resolve(parseProbe(JSON.parse(out)));
      } catch {
        resolve(null);
      }
    });
  });
}

const rate = (r: unknown) => {
  const [a, b] = String(r ?? "").split("/").map(Number);
  const fps = b ? a / b : a;
  return Number.isFinite(fps) && fps >= 1 && fps <= 240 ? Math.round(fps * 1000) / 1000 : 0;
};

export function parseProbe(json: {
  format?: { duration?: string; format_name?: string };
  streams?: Record<string, unknown>[];
}): Probe {
  const v = json.streams?.find((s) => s.codec_type === "video");
  const a = json.streams?.find((s) => s.codec_type === "audio");
  return {
    duration: Number(json.format?.duration) || 0,
    fps: v ? rate(v.avg_frame_rate) || rate(v.r_frame_rate) : 0,
    width: Number(v?.width) || 0,
    height: Number(v?.height) || 0,
    format: json.format?.format_name ?? "",
    vcodec: String(v?.codec_name ?? ""),
    pixFmt: String(v?.pix_fmt ?? ""),
    acodec: String(a?.codec_name ?? ""),
  };
}

/** Plays in every current browser without a proxy. */
export function browserPlayable(p: Probe): boolean {
  const audioOk = !p.acodec || ["aac", "mp3", "opus", "vorbis"].includes(p.acodec);
  const pixOk = !p.vcodec || ["yuv420p", "yuvj420p"].includes(p.pixFmt);
  const mp4 = p.format.includes("mp4") && ["h264", "av1", ""].includes(p.vcodec);
  const webm = p.format.includes("webm") && ["vp8", "vp9", "av1"].includes(p.vcodec);
  return audioOk && pixOk && (mp4 || webm);
}

const children = new Map<string, ChildProcess>();

function ffmpeg(key: string, args: string[], duration = 0, onProgress?: (f: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-y", ...args]);
    children.set(key, p);
    let err = "";
    p.stderr.on("data", (d) => (err = (err + d.toString()).slice(-4000)));
    p.stdout.on("data", (d) => {
      const m = /out_time_us=(\d+)/.exec(d.toString());
      if (m && duration && onProgress) onProgress(Math.min(1, Number(m[1]) / 1e6 / duration));
    });
    p.on("error", (e) => {
      children.delete(key);
      reject(e);
    });
    p.on("close", (code) => {
      children.delete(key);
      if (code === 0) resolve();
      else reject(new Error(err.trim() || `ffmpeg exited ${code}`));
    });
  });
}

function setVersion(id: string, n: number, patch: Partial<Version>) {
  return updateMeta(id, (m) => {
    const v = m.versions.find((x) => x.n === n);
    if (v) Object.assign(v, patch);
  });
}

async function processVersion(id: string, n: number): Promise<void> {
  const key = `${id}/${n}`;
  const src = sourcePath(id, n);
  try {
    const info = await probe(src);
    if (!info || (!info.vcodec && !info.acodec)) throw new Error("Not a video file ffmpeg can read");
    await setVersion(id, n, {
      duration: info.duration,
      fps: info.fps,
      width: info.width,
      height: info.height,
      progress: 0.1,
    });
    if (info.vcodec) {
      await ffmpeg(key, [
        "-ss", String(Math.min(1, info.duration / 2)),
        "-i", src,
        "-frames:v", "1",
        "-vf", "scale='min(640,iw)':-2",
        "-q:v", "4",
        thumbPath(id, n),
      ]).catch(() => {});
    }
    if (!browserPlayable(info)) {
      let last = 0;
      // ponytail: one transcode at a time on the web server; move to a worker if uploads queue up
      await ffmpeg(
        key,
        [
          "-i", src,
          "-map", "0:v:0?", "-map", "0:a:0?",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
          "-vf", "scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(iw,ih),-2,min(1920,ih))',format=yuv420p",
          "-c:a", "aac", "-b:a", "192k",
          "-movflags", "+faststart",
          "-progress", "pipe:1", "-nostats",
          proxyPath(id, n),
        ],
        info.duration,
        (f) => {
          if (Date.now() - last < 1500) return;
          last = Date.now();
          void setVersion(id, n, { progress: 0.1 + f * 0.9 });
        },
      );
    }
    await setVersion(id, n, {
      status: "ready",
      progress: 1,
      proxy: existsSync(proxyPath(id, n)),
      error: undefined,
    });
  } catch (e) {
    await rm(proxyPath(id, n), { force: true }).catch(() => {});
    await setVersion(id, n, {
      status: "error",
      error: e instanceof Error ? e.message.slice(0, 400) : String(e),
    });
  }
  await syncLibrary(id);
}

const queued = new Set<string>();
let chain = Promise.resolve();

function enqueue(id: string, n: number): void {
  const key = `${id}/${n}`;
  if (queued.has(key)) return;
  queued.add(key);
  chain = chain.then(() => processVersion(id, n).finally(() => queued.delete(key)));
}

/** A restart mid-transcode leaves versions "processing": pick them up again. */
async function resumePending(): Promise<void> {
  const ids = await readdir(ROOT).catch(() => [] as string[]);
  for (const id of ids) {
    const meta = await readMeta(id);
    for (const v of meta?.versions ?? []) {
      if (v.status === "processing") {
        enqueue(id, v.n);
      }
    }
  }
}
// ---------- the Media Library (tasks/media-library-plan.md, section 10) ----------

/**
 * Every Review video is also a Media Library asset with the same id, and each of its versions a library version
 * (`versionId` in the meta). Review stays the source of truth: toLibrary(id) makes the library's rows match the meta
 * and the files on disk, whatever just changed. The library's files are hard links to Review's, so Review's renames
 * (order, stack, unstack, trash) never break them. Comments, drawings, approvals and share links stay in Review,
 * keyed by version. No AI runs on the way in: transcribe and describe
 * wait until someone asks for them in the library (they spend that person's key).
 */

/** The library a Review owner's videos go in: their first, made when there is none. */
function libraryFor(owner: string): string | null {
  const home = homeOf(owner);
  const d = libraryDb();
  const found = d.prepare("SELECT id FROM libraries WHERE workspace_id = ? ORDER BY created_at, id LIMIT 1").get(home) as { id: string } | undefined;
  if (found) return found.id;
  const id = `lib_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES (?, ?, 'Library', 'local', ?)").run(id, home, Date.now());
  return id;
}

/**
 * The video as Review has it, live or in the trash, read under one lock (a restore in between would read as gone).
 * A live version's id is given once and kept in the meta; a video in the trash gets its ids when restored.
 */
async function withVersionIds(id: string): Promise<{ m: Meta | null; live: boolean }> {
  return withLock(id, async () => {
    const m = await readMeta(id);
    if (!m) return { m: await readTrashed(id), live: false };
    if (m.versions.every((x) => x.versionId)) return { m, live: true };
    for (const x of m.versions) x.versionId ??= randomUUID();
    await writeJson(metaPath(id), m); // updatedAt stays: an id is not a change retention should see
    return { m, live: true };
  });
}

/** A hard link to one of Review's files, stored in the library under `key`. */
async function linkInto(key: string, file: string): Promise<void> {
  const staged = path.join(env.dataDir, "library", "staging", `review-${randomUUID()}`);
  await linkOrCopy(file, staged);
  await blobs.put(key, staged);
}

/** Removes the library's links to a version's video files (Review deleted them, to save space). */
async function unlinkFromLibrary(versionId: string): Promise<void> {
  const d = libraryDb();
  const keys = [
    ...(d.prepare("SELECT source_key AS k FROM asset_versions WHERE id = ?").all(versionId) as { k: string }[]),
    ...(d.prepare("SELECT storage_key AS k FROM derivatives WHERE version_id = ? AND kind = 'proxy' AND storage_key IS NOT NULL").all(versionId) as { k: string }[]),
  ];
  for (const { k } of keys) await blobs.delete(k);
  d.prepare("DELETE FROM derivatives WHERE version_id = ? AND kind = 'proxy'").run(versionId);
}

/** Makes the library match Review for one video id: added, changed, in the trash, or gone. */
export async function toLibrary(id: string): Promise<void> {
  const { m, live } = await withVersionIds(id);
  const d = libraryDb();
  const row = d.prepare("SELECT library_id FROM assets WHERE id = ?").get(id) as { library_id: string } | undefined;
  if (!m) {
    if (row) await deleteAssets([id]);
    return;
  }
  if (m.versions.some((x) => !x.versionId)) return;
  const libraryId = row?.library_id ?? libraryFor(m.owner);
  if (!libraryId) return;
  const dir = live ? assetDir(id) : trashDir(id);
  const file = (n: number, name: string) => path.join(dir, `v${n}`, name);
  const shown = m.versions.filter((x) => x.status !== "processing");
  if (!shown.length && !row) return; // nothing to show yet: it comes in when its first version is processed

  // the files first (async); then every row in one transaction
  const added: { x: Version; key: string; sha256: string; probe: string | null }[] = [];
  const derived: { versionId: string; kind: "thumb" | "proxy"; key: string; bytes: number }[] = [];
  for (const x of shown) {
    const vid = x.versionId!;
    const base = `libraries/${libraryId}/v/${vid}`;
    if (x.removed) await unlinkFromLibrary(vid);
    if (!d.prepare("SELECT 1 FROM asset_versions WHERE id = ?").get(vid)) {
      const src = file(x.n, "source");
      const there = !x.removed && existsSync(src);
      if (there) await linkInto(`${base}/source`, src);
      const p = there ? await probeSummary(src).catch(() => null) : null;
      added.push({ x, key: `${base}/source`, sha256: there ? await sha256File(src) : "", probe: p && JSON.stringify(p) });
    }
    for (const [kind, name] of [["thumb", "thumb.jpg"], ["proxy", "proxy.mp4"]] as const) {
      const f = file(x.n, name);
      if (!existsSync(f) || d.prepare("SELECT 1 FROM derivatives WHERE version_id = ? AND kind = ?").get(vid, kind)) continue;
      const key = `${base}/${name}`;
      await linkInto(key, f);
      derived.push({ versionId: vid, kind, key, bytes: (await stat(f)).size });
    }
  }
  const state = (x: Version) => (x.removed ? "missing" : x.status === "ready" ? "ready" : "failed");
  d.exec("BEGIN");
  try {
    d.prepare(
      `INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at, trashed_at)
       VALUES (?, ?, 'video', ?, NULL, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET title = excluded.title, trashed_at = excluded.trashed_at`,
    ).run(id, libraryId, m.name, m.owner, m.createdAt, live ? null : (m.deletedAt ?? Date.now()));
    // out of the way first: a version's number changes with order, stack and unstack, and (asset, n) is unique
    d.prepare("UPDATE asset_versions SET n = -rowid WHERE asset_id = ?").run(id);
    for (const a of added) {
      d.prepare(
        `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, mime, probe, state, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(a.x.versionId!, id, a.x.n, a.key, a.x.bytes, a.sha256, a.x.mime, a.probe, state(a.x), m.owner, a.x.createdAt);
      // the local, keyless extras: a waveform and the fingerprint the duplicate check reads
      if (state(a.x) === "ready" && a.probe) {
        enqueueJob(d, libraryId, a.x.versionId!, "wave", m.owner);
        if (a.x.width) enqueueJob(d, libraryId, a.x.versionId!, "fingerprint", m.owner);
      }
    }
    for (const x of shown) d.prepare("UPDATE asset_versions SET asset_id = ?, n = ?, state = ? WHERE id = ?").run(id, x.n, state(x), x.versionId!);
    for (const r of derived) {
      d.prepare("INSERT OR REPLACE INTO derivatives (version_id, kind, storage_key, bytes) VALUES (?, ?, ?, ?)").run(r.versionId, r.kind, r.key, r.bytes);
    }
    d.prepare("UPDATE assets SET current_version_id = ? WHERE id = ?").run(shown.at(-1)?.versionId ?? null, id);
    indexAsset(d, id);
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

/** toLibrary for each id in turn; a library error is logged, never Review's answer. */
async function syncLibrary(...ids: string[]): Promise<void> {
  for (const id of ids) await toLibrary(id).catch((e) => console.error(`[review] library ${id}:`, e));
}

/** At start: every Review video, the trash too, into the library. Unchanged ones cost a read of their meta. */
export async function reviewToLibrary(): Promise<void> {
  const trashed = await readdir(path.join(ROOT, "trash")).catch(() => [] as string[]);
  await syncLibrary(...(await allMetas()).map((m) => m.id), ...trashed.filter((t) => UUID.test(t)));
}

void mkdir(path.join(ROOT, "links"), { recursive: true })
  .then(resumePending)
  .then(reviewToLibrary)
  .catch(() => {});

// ---------- validation ----------

const COLOR = /^#[0-9a-f]{6}$/i;
const round4 = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 1e4) / 1e4;

export function cleanDrawing(raw: unknown): Stroke[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  let budget = 4000;
  const out: Stroke[] = [];
  for (const s of raw.slice(0, 50)) {
    const color = typeof s?.color === "string" && COLOR.test(s.color) ? s.color : "#ff3b30";
    const points: [number, number][] = [];
    for (const p of Array.isArray(s?.points) ? s.points : []) {
      if (budget-- <= 0) break;
      if (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) {
        points.push([round4(p[0]), round4(p[1])]);
      }
    }
    if (points.length) out.push({ color, points });
  }
  return out.length ? out : undefined;
}

/** Paint strokes (0–1 points) onto an RGBA frame, about as thick as the page draws them. */
export function paintStrokes(rgba: Buffer, w: number, h: number, strokes: Stroke[]): void {
  const r = Math.max(2, Math.round(w / 200));
  const dot = (cx: number, cy: number, rgb: number[]) => {
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) rgba.set([...rgb, 255], (y * w + x) * 4);
      }
    }
  };
  for (const s of strokes) {
    const rgb = [1, 3, 5].map((i) => parseInt(s.color.slice(i, i + 2), 16));
    const pts = s.points.map(([x, y]) => [x * (w - 1), y * (h - 1)]);
    pts.forEach(([x, y], i) => {
      const [px, py] = pts[i - 1] ?? [x, y];
      const steps = Math.max(1, Math.ceil(Math.hypot(x - px, y - py) / (r / 2)));
      for (let k = 1; k <= steps; k++) dot(px + ((x - px) * k) / steps, py + ((y - py) * k) / steps, rgb);
    });
  }
}

/** ffmpeg with an optional stdin, its stdout as one buffer. */
function ffmpegPipe(args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", ...args]);
    const out: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.stderr.on("data", (d) => (err = (err + d.toString()).slice(-2000)));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(err || `ffmpeg ${code}`))));
    p.stdin.on("error", () => {}); // ffmpeg may exit before reading it all
    p.stdin.end(input);
  });
}

// frames decode on request and share links are public: a few at a time
let framesBusy = 0;
const FRAMES_AT_ONCE = 3;

/** The frame at t as a JPEG `width` wide, with a comment's drawing painted on it. */
export async function frameJpeg(file: string, t: number, width: number, strokes?: Stroke[]): Promise<Buffer> {
  // decoded (so rotated like the player) and scaled; its height follows from the bytes
  const rgba = await ffmpegPipe([
    "-ss", String(t), "-i", file, "-frames:v", "1",
    "-vf", `scale=${width}:-2`, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1",
  ]);
  const height = rgba.length / (width * 4);
  if (!Number.isInteger(height) || height < 1) throw new Error("No frame there");
  if (strokes) paintStrokes(rgba, width, height, strokes);
  return ffmpegPipe([
    "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-i", "pipe:0",
    "-frames:v", "1", "-q:v", "3", "-f", "image2", "-c:v", "mjpeg", "pipe:1",
  ], rgba);
}

/** What an AI reads of a reference: a still at most 1568 px, or one that
 *  moves as 9 frames spread across it in a 3×3 sheet. */
async function refLook(file: string, kind: Ref["kind"]): Promise<Buffer> {
  const fit = (px: number) => `scale=w='min(${px},iw)':h='min(${px},ih)':force_original_aspect_ratio=decrease`;
  const duration = kind === "video" ? ((await probe(file))?.duration ?? 0) : 0;
  const vf = kind === "image" ? fit(1568) : `fps=${duration > 0 ? 9 / duration : 1},${fit(512)},tile=3x3`;
  return ffmpegPipe(["-i", file, "-vf", vf, "-frames:v", "1", "-q:v", "3", "-c:v", "mjpeg", "-f", "image2", "pipe:1"]);
}

/** The references a new comment names: ones uploaded to this version. */
async function cleanRefs(assetId: string, n: number, raw: unknown): Promise<Ref[]> {
  const ids = Array.isArray(raw) ? [...new Set(raw.filter((x): x is string => typeof x === "string" && UUID.test(x)))] : [];
  const refs = await Promise.all(
    ids.slice(0, 10).map((rid) =>
      readFile(path.join(refsDir(assetId, n), `${rid}.json`), "utf-8").then((s) => [JSON.parse(s) as Ref], () => []),
    ),
  );
  return refs.flat();
}

const cleanText = (raw: unknown, max: number) =>
  typeof raw === "string" ? raw.replace(/\r\n/g, "\n").trim().slice(0, max) : "";

const cleanTime = (raw: unknown, duration: number) => {
  const t = Number(raw);
  if (raw == null || raw === "" || !Number.isFinite(t) || t < 0) return undefined;
  return Math.round(Math.min(t, duration || t) * 1000) / 1000;
};

// ---------- access ----------

interface Viewer {
  meta: Meta;
  /** Owner (or admin) on /assets: rename, share, delete anything. */
  manage: boolean;
  /** May download originals: the owner, or a link that allows it. */
  download: boolean;
  user?: string;
  guestKey?: string;
}

const realUser = (u: SessionUser | undefined) =>
  u && u.role !== "visitor" ? u.username : undefined;

async function viewer(c: Context<{ Variables: AuthVars }>): Promise<Viewer | null> {
  const user = c.get("user");
  const token = c.req.param("token");
  const guestKey = c.req.header("x-review-key")?.slice(0, 80) || undefined;
  if (token !== undefined) {
    const reviewer = { manage: false, user: realUser(user), guestKey };
    const id = c.req.param("id");
    if (id !== undefined) {
      const project = await sharedProject(token);
      const meta = project && (await readMeta(id));
      if (!meta || meta.projectId !== project.id || meta.owner !== project.owner) return null;
      return { meta, ...reviewer, download: project.share!.download };
    }
    const meta = await readMeta(await linkTarget(token));
    if (!meta?.share?.enabled || meta.share.token !== token) return null;
    return { meta, ...reviewer, download: meta.share.download };
  }
  const meta = await readMeta(c.req.param("id") ?? "");
  if (!meta || (meta.owner !== user.username && user.role !== "admin")) return null;
  return { meta, manage: true, download: true, user: user.username, guestKey };
}

const linkTarget = async (token: string) =>
  UUID.test(token) ? (await readFile(linkPath(token), "utf-8").catch(() => "")).trim() : "";

/** The project behind a project share link, while that link is on. */
async function sharedProject(token: string): Promise<Project | null> {
  const target = await linkTarget(token);
  if (!target.startsWith(PROJECT_LINK)) return null;
  const p = (await readProjects()).find((x) => x.id === target.slice(PROJECT_LINK.length));
  return p?.share?.enabled && p.share.token === token ? p : null;
}

/** Turn a share on/off, allow downloads, or reset its token (the old one stops working). */
function patchShare(cur: Share | undefined, patch: { enabled?: unknown; download?: unknown; reset?: unknown }) {
  const share = cur ?? { token: randomUUID(), enabled: false, download: false };
  let oldToken: string | undefined;
  if (patch.reset === true) {
    oldToken = share.token;
    share.token = randomUUID();
  }
  if (typeof patch.enabled === "boolean") share.enabled = patch.enabled;
  if (typeof patch.download === "boolean") share.download = patch.download;
  return { share, oldToken };
}


const isAuthor = (v: Viewer, cm: Comment) =>
  (!!v.user && cm.user === v.user) || (!!v.guestKey && cm.guestKey === v.guestKey);

function publicAsset(m: Meta, manage: boolean, download = manage || !!m.share?.download) {
  return {
    id: m.id,
    name: m.name,
    approval: m.approval,
    versions: m.versions.map((v) => ({
      n: v.n,
      name: v.name,
      duration: v.duration,
      fps: v.fps,
      width: v.width,
      height: v.height,
      status: v.status,
      progress: v.progress,
      error: v.error,
      captioned: !!v.captioned,
      madeFrom: v.madeFrom,
      bytes: v.bytes,
      removed: !!v.removed,
      createdAt: v.createdAt,
    })),
    download,
    ...(manage
      ? { owner: m.owner, share: m.share ?? null, projectId: m.projectId ?? null, done: m.done ?? null }
      : {}),
    createdAt: m.createdAt,
  };
}

// guestKey: undefined drops the secret from the JSON
const publicComment = (v: Viewer, cm: Comment) => ({ ...cm, guestKey: undefined, mine: isAuthor(v, cm) });

const safeName = (s: string) => s.replace(/[^\w.\- ]+/g, "").trim() || "video";
/** A new video is named after its file. */
const assetName = (file: string) => file.replace(/\.[a-z0-9]{2,4}$/i, "") || "Untitled";

// ---------- owner routes ----------

reviewApp.get("/", async (c) => {
  const user = c.get("user");
  const metas = (await allMetas()).filter((m) => m.owner === user.username);
  metas.sort((a, b) => b.updatedAt - a.updatedAt);
  const out = await Promise.all(
    metas.map(async (m) => {
      const comments = await readComments(m.id);
      const latest = m.versions.at(-1);
      return {
        ...publicAsset(m, true),
        comments: comments.filter((x) => x.version === latest?.n).length,
        newComments: comments.filter(
          (x) => x.user !== m.owner && x.createdAt > (m.seenAt ?? 0),
        ).length,
        updatedAt: m.updatedAt,
      };
    }),
  );
  return c.json(out);
});

/** What an upload will be and where it goes, checked for both ways in
  *  (/uploads through this server). */
async function uploadInit(c: Context<{ Variables: AuthVars }>): Promise<Response | UploadInit> {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const size = Number(body?.size);
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_UPLOAD_BYTES) {
    return c.json({ error: "Invalid size" }, 400);
  }
  const user = c.get("user");
  const assetId = typeof body?.assetId === "string" ? body.assetId : undefined;
  if (assetId) {
    const meta = await readMeta(assetId);
    if (!meta || (meta.owner !== user.username && user.role !== "admin")) {
      return c.json({ error: "Not found" }, 404);
    }
  }
  const projectId = !assetId && body?.projectId ? body.projectId : undefined;
  if (projectId && !(await ownsProject(user.username, projectId))) {
    return c.json({ error: "That project is gone" }, 404);
  }
  return {
    total: size,
    partSize: PART_SIZE,
    name: cleanText(body?.name, 160) || "Untitled",
    mime: cleanText(body?.mime, 80) || "video/mp4",
    owner: user.username,
    assetId,
    projectId: projectId as string | undefined,
  };
}

reviewApp.post("/uploads", async (c) => {
  const init = await uploadInit(c);
  if (init instanceof Response) return init;
  const uid = randomUUID();
  await startUpload<UploadInit>(uploadDir(uid), init);
  return c.json({ id: uid, partSize: PART_SIZE });
});

/** What a browser resuming this upload can skip. */
reviewApp.get("/uploads/:uid/parts", async (c) => {
  const uid = c.req.param("uid");
  const user = c.get("user");
  const state = UUID.test(uid) ? await readUploadState<UploadInit>(uploadDir(uid)) : null;
  if (!state || (state.owner !== user.username && user.role !== "admin")) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json({ partSize: state.partSize, parts: await receivedParts(uploadDir(uid), state) });
});

reviewApp.post("/uploads/:uid/parts/:partNumber", (c) => {
  const uid = c.req.param("uid");
  if (!UUID.test(uid)) return c.json({ error: "Invalid part" }, 400);
  return receivePart(c, uploadDir(uid), c.get("user"));
});

/**
 * Add a version (a new video when `assetId` is absent) and fill its source
 * with `place` (an upload assembles its parts into it).
 */
/** File a loose video in a project (one filed by hand stays where it is). */
export function fileVideo(id: string, projectId: string): Promise<Meta | null> {
  return updateMeta(id, (m) => {
    m.projectId ??= projectId;
  });
}

export async function addVersion(
  assetId: string | undefined,
  v: { owner: string; name: string; mime: string; bytes: number; projectId?: string },
  place: (dest: string) => Promise<void>,
): Promise<{ meta: Meta; n: number } | null> {
  const id = assetId ?? randomUUID();
  const now = Date.now();
  if (!assetId) {
    await mkdir(assetDir(id), { recursive: true });
    await writeJson(metaPath(id), {
      id,
      name: assetName(v.name),
      owner: v.owner,
      ...(v.projectId ? { projectId: v.projectId } : {}),
      versions: [],
      approval: { status: "none" },
      createdAt: now,
      updatedAt: now,
    } satisfies Meta);
  }
  // Reserve the version number under the lock, then fill it.
  let n = 0;
  const reserved = await updateMeta(id, (m) => {
    n = Math.max(0, ...m.versions.map((x) => x.n)) + 1;
    // the video is named after its newest file, unless it was renamed by hand
    const top = m.versions.at(-1);
    if (top && m.name === assetName(top.name)) m.name = assetName(v.name);
    m.versions.push({
      n,
      name: v.name,
      mime: v.mime,
      bytes: v.bytes,
      duration: 0,
      fps: 0,
      width: 0,
      height: 0,
      status: "processing",
      progress: 0.02,
      createdAt: now,
    });
  });
  if (!reserved) return null;
  try {
    await mkdir(versionDir(id, n), { recursive: true });
    await place(sourcePath(id, n));
  } catch (e) {
    await setVersion(id, n, { status: "error", error: "Upload incomplete — upload it again" });
    throw e;
  }
  enqueue(id, n);
  const meta = await readMeta(id);
  return meta ? { meta, n } : null;
}

reviewApp.post("/uploads/:uid/complete", async (c) => {
  const uid = c.req.param("uid");
  const state = UUID.test(uid) ? await readUploadState<UploadInit>(uploadDir(uid)) : null;
  if (!state) return c.json({ error: "No upload in progress" }, 409);
  return finishUpload(c, state, (dest) => assembleParts(uploadDir(uid), dest, state));
});

/** The upload is in: a new video, or the next version of one (with a notice). */
async function finishUpload(
  c: Context<{ Variables: AuthVars }>,
  state: UploadInit,
  place: (dest: string) => Promise<void>,
) {
  const user = c.get("user");
  if (state.owner !== user.username && user.role !== "admin") {
    return c.json({ error: "Not found" }, 404);
  }
  try {
    const added = await addVersion(
      state.assetId,
      {
        owner: state.owner,
        name: state.name,
        mime: state.mime,
        bytes: state.total,
        projectId: state.projectId,
      },
      place,
    );
    if (!added) return c.json({ error: "Not found" }, 404);
    if (state.assetId) {
      await notify(added.meta, { name: user.username, user: user.username }, {
        kind: "version",
        text: `V${added.n}`,
        query: `?v=${added.n}`,
      });
    }
    return c.json(publicAsset(added.meta, true));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
}

// ---------- Caption Studio ----------

const opening = new Map<string, Promise<string>>();

/** Open a version in Caption Studio: its linked project, or a new one on the
 *  same file. Waits for the editing proxy, so the editor opens ready. */
reviewApp.post("/assets/:id/v/:n/captions", async (c) => {
  const v = await viewer(c);
  const n = Number(c.req.param("n"));
  const version = v?.meta.versions.find((x) => x.n === n);
  if (!v || !version) return c.json({ error: "Not found" }, 404);
  const user = c.get("user");
  const id = v.meta.id;
  if (version.removed) return c.json(REMOVED, 410);
  if (!existsSync(sourcePath(id, n))) return c.json({ error: "This version is still uploading" }, 409);
  const key = `${id}/${n}/${user.username}`;
  let job = opening.get(key);
  if (!job) {
    job = (async () => {
      const link = version.captions;
      if (link && (await clipReadyToEdit(link.projectId, link.clipId, user))) return link.projectId;
      const created = await createProjectFromFile({
        owner: user.username,
        // the file's own name (the video's may be an older version's)
        name: assetName(version.name),
        clipName: version.name,
        file: sourcePath(id, n),
        duration: version.duration,
      });
      await setVersion(id, n, { captions: created });
      return created.projectId;
    })().finally(() => opening.delete(key));
    opening.set(key, job);
  }
  try {
    return c.json({ projectId: await job });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

reviewApp.patch("/assets/:id", async (c) => {
  const v = await viewer(c);
  if (!v) return c.json({ error: "Not found" }, 404);
  const body = (await c.req.json().catch(() => null)) as {
    name?: unknown;
    projectId?: unknown;
    share?: { enabled?: unknown; download?: unknown; reset?: unknown };
    finished?: unknown;
  } | null;
  const name = cleanText(body?.name, 160);
  const share = body?.share;
  const projectId = body?.projectId;
  if (projectId != null && !(await ownsProject(v.meta.owner, projectId))) {
    return c.json({ error: "That project is gone" }, 404);
  }
  let oldToken: string | undefined;
  const meta = await updateMeta(v.meta.id, (m) => {
    if (name) m.name = name;
    if (projectId === null) delete m.projectId;
    else if (typeof projectId === "string") m.projectId = projectId;
    if (share) ({ share: m.share, oldToken } = patchShare(m.share, share));
    if (typeof body?.finished === "boolean") m.done = { finished: body.finished, at: Date.now() };
  });
  if (!meta) return c.json({ error: "Not found" }, 404);
  if (oldToken) await rm(linkPath(oldToken), { force: true });
  if (meta.share) await writeFile(linkPath(meta.share.token), meta.id);
  if (name) await syncLibrary(meta.id);
  return c.json(publicAsset(meta, true));
});

reviewApp.delete("/assets/:id", async (c) => {
  const v = await viewer(c);
  if (!v) return c.json({ error: "Not found" }, 404);
  await trashAsset(v.meta.id);
  return c.json({ ok: true });
});

/** Into the trash as it is; its share link stops working until it's restored. */
async function trashAsset(id: string): Promise<void> {
  for (const [key, child] of children) if (key.startsWith(`${id}/`)) child.kill("SIGKILL");
  await withLock(id, async () => {
    const meta = await readMeta(id);
    if (!meta) return;
    if (meta.share) await rm(linkPath(meta.share.token), { force: true });
    await mkdir(path.join(ROOT, "trash"), { recursive: true });
    await rename(assetDir(id), trashDir(id));
    await writeJson(path.join(trashDir(id), "meta.json"), { ...meta, deletedAt: Date.now() });
  });
  await syncLibrary(id);
}

// ---------- trash ----------

async function readTrashed(id: string): Promise<Meta | null> {
  if (!UUID.test(id)) return null;
  try {
    return JSON.parse(await readFile(path.join(trashDir(id), "meta.json"), "utf-8")) as Meta;
  } catch {
    return null;
  }
}

async function trashedFor(c: Context<{ Variables: AuthVars }>): Promise<Meta | null> {
  const m = await readTrashed(c.req.param("id") ?? "");
  const user = c.get("user");
  return m && (m.owner === user.username || user.role === "admin") ? m : null;
}

reviewApp.get("/trash", async (c) => {
  const user = c.get("user");
  const ids = await readdir(path.join(ROOT, "trash")).catch(() => [] as string[]);
  const metas = (await Promise.all(ids.map(readTrashed))).filter(
    (m): m is Meta => !!m && m.owner === user.username,
  );
  metas.sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
  return c.json(metas.map((m) => ({ ...publicAsset(m, true), deletedAt: m.deletedAt })));
});

reviewApp.get("/trash/:id/thumb", async (c) => {
  const m = await trashedFor(c);
  const v = m?.versions.at(-1);
  if (!m || !v) return c.json({ error: "Not found" }, 404);
  return sendFile(c, path.join(trashDir(m.id), `v${v.n}`, "thumb.jpg"), "image/jpeg");
});

reviewApp.post("/trash/:id/restore", async (c) => {
  const m = await trashedFor(c);
  if (!m) return c.json({ error: "Not found" }, 404);
  const restored = await withLock(m.id, async () => {
    if (existsSync(assetDir(m.id))) return false;
    await rename(trashDir(m.id), assetDir(m.id));
    delete m.deletedAt;
    m.updatedAt = Date.now();
    await writeJson(metaPath(m.id), m);
    if (m.share) await writeFile(linkPath(m.share.token), m.id);
    for (const x of m.versions) if (x.status === "processing") enqueue(m.id, x.n);
    return true;
  });
  if (!restored) return c.json({ error: "Already restored" }, 409);
  await syncLibrary(m.id);
  return c.json(publicAsset(m, true));
});

reviewApp.delete("/trash/:id", async (c) => {
  const m = await trashedFor(c);
  if (!m) return c.json({ error: "Not found" }, 404);
  await withLock(m.id, () => rm(trashDir(m.id), { recursive: true, force: true }));
  await syncLibrary(m.id);
  return c.json({ ok: true });
});

/** The trash empties itself after TRASH_DAYS; an upload nobody resumed goes after UPLOAD_DAYS. */
async function purgeTrash(): Promise<void> {
  const cutoff = Date.now() - TRASH_DAYS * 86_400_000;
  for (const id of await readdir(path.join(ROOT, "trash")).catch(() => [] as string[])) {
    const m = await readTrashed(id);
    if (m && (m.deletedAt ?? 0) < cutoff) {
      await withLock(id, () => rm(trashDir(id), { recursive: true, force: true }));
      await syncLibrary(id);
    }
  }
  const stale = Date.now() - UPLOAD_DAYS * 86_400_000;
  for (const uid of await readdir(path.join(ROOT, "uploads")).catch(() => [] as string[])) {
    const st = await stat(uploadDir(uid)).catch(() => null);
    if (UUID.test(uid) && st && st.mtimeMs < stale) await rm(uploadDir(uid), { recursive: true, force: true });
  }
}
void purgeTrash().catch(() => {});
setInterval(() => void purgeTrash().catch(() => {}), 6 * 3600_000).unref();

// ---------- stacks: drop a video on another, or break one apart ----------

/** Files are moving or being read: no stacking until it's done. */
const processing = (m: Meta) =>
  m.versions.some((x) => x.status === "processing");

/** Two assets' locks, always in id order so crossing moves can't deadlock. */
function withLocks<T>(a: string, b: string, fn: () => Promise<T>): Promise<T> {
  const [x, y] = [a, b].sort();
  return withLock(x, () => withLock(y, fn));
}

/** Rename folders in order; on failure the ones already moved go back. */
async function moveDirs(moves: [string, string][]): Promise<void> {
  const done: [string, string][] = [];
  try {
    for (const [a, b] of moves) {
      await rename(a, b);
      done.push([a, b]);
    }
  } catch (e) {
    for (const [a, b] of done.reverse()) await rename(b, a).catch(() => {});
    throw e;
  }
}

/** `from`'s versions go on top of this stack, comments and Caption Studio
 *  links with them, and the stack takes its name (the top one leads, like
 *  Frame.io); `from` (and its share link) is gone after. */
reviewApp.post("/assets/:id/stack", async (c) => {
  const v = await viewer(c);
  const body = (await c.req.json().catch(() => null)) as { from?: unknown } | null;
  const fromId = typeof body?.from === "string" ? body.from : "";
  if (!v || !UUID.test(fromId) || fromId === v.meta.id) return c.json({ error: "Not found" }, 404);
  const toId = v.meta.id;
  // Both locks are held: read and write the files directly, never updateMeta.
  const result = await withLocks(toId, fromId, async () => {
    const [to, from] = await Promise.all([readMeta(toId), readMeta(fromId)]);
    if (!to || !from || from.owner !== to.owner) return 404 as const;
    if (processing(to) || processing(from)) return 409 as const;
    let top = Math.max(0, ...to.versions.map((x) => x.n));
    const renumber = new Map(from.versions.map((x) => [x.n, ++top]));
    await moveDirs(from.versions.map((x) => [versionDir(fromId, x.n), versionDir(toId, renumber.get(x.n)!)]));
    const moved = (await readComments(fromId)).flatMap((cm) =>
      renumber.has(cm.version) ? [{ ...cm, version: renumber.get(cm.version)! }] : [],
    );
    await writeJson(commentsPath(toId), [...(await readComments(toId)), ...moved]);
    to.versions.push(
      ...from.versions.map((x) => ({
        ...x,
        n: renumber.get(x.n)!,
        madeFrom: x.madeFrom && renumber.get(x.madeFrom),
      })),
    );
    to.name = from.name;
    to.updatedAt = Date.now();
    await writeJson(metaPath(toId), to);
    if (from.share) await rm(linkPath(from.share.token), { force: true });
    await rm(assetDir(fromId), { recursive: true, force: true });
    return to;
  });
  if (result === 404) return c.json({ error: "Not found" }, 404);
  if (result === 409) return c.json({ error: "Wait until both videos are ready" }, 409);
  await syncLibrary(toId, fromId); // the versions move over first, then the emptied video goes
  return c.json(publicAsset(result, true));
});

/** Folder moves that put `order` (version numbers, V1 first) at V1..Vk,
 *  through temporary names so a swap can't land on a folder still in use. */
function renumberMoves(id: string, order: number[]): [string, string][] {
  const moving = order.flatMap((n, i) => (n === i + 1 ? [] : [[n, i + 1]]));
  return [
    ...moving.map(([n]): [string, string] => [versionDir(id, n), `${versionDir(id, n)}.moving`]),
    ...moving.map(([n, to]): [string, string] => [`${versionDir(id, n)}.moving`, versionDir(id, to)]),
  ];
}

/** Write a stack back as `order` (version numbers, V1 first), its folders
 *  already moved by renumberMoves. Comments on versions that left are
 *  dropped here. The top one leads: when it changes, so does the name. */
async function saveOrder(meta: Meta, comments: Comment[], order: number[]): Promise<Meta> {
  const to = new Map(order.map((n, i) => [n, i + 1]));
  const top = meta.versions.find((x) => x.n === order.at(-1))!;
  if (top !== meta.versions.at(-1)) meta.name = assetName(top.name);
  meta.versions = order.map((n) => {
    const x = meta.versions.find((y) => y.n === n)!;
    return { ...x, n: to.get(n)!, madeFrom: x.madeFrom && to.get(x.madeFrom) };
  });
  meta.updatedAt = Date.now();
  const kept = comments.flatMap((cm) => (to.has(cm.version) ? [{ ...cm, version: to.get(cm.version)! }] : []));
  await writeJson(commentsPath(meta.id), kept);
  await writeJson(metaPath(meta.id), meta);
  return meta;
}

/** Reorder a stack: `order` is every version number, V1 first. */
reviewApp.post("/assets/:id/order", async (c) => {
  const v = await viewer(c);
  const body = (await c.req.json().catch(() => null)) as { order?: unknown } | null;
  if (!v) return c.json({ error: "Not found" }, 404);
  const order = Array.isArray(body?.order) ? body.order.map(Number) : [];
  const id = v.meta.id;
  const result = await withLock(id, async () => {
    const meta = await readMeta(id);
    if (!meta) return 404 as const;
    const have = new Set(meta.versions.map((x) => x.n));
    if (order.length !== have.size || new Set(order).size !== order.length || !order.every((n) => have.has(n))) {
      return 400 as const;
    }
    if (processing(meta)) return 409 as const;
    await moveDirs(renumberMoves(id, order));
    return saveOrder(meta, await readComments(id), order);
  });
  if (result === 404) return c.json({ error: "Not found" }, 404);
  if (result === 400) return c.json({ error: "Send every version once" }, 400);
  if (result === 409) return c.json({ error: "Wait until every version is ready" }, 409);
  await syncLibrary(id);
  return c.json(publicAsset(result, true));
});

/** Take version `n` out of the stack as its own video, or without `n` break
 *  the whole stack apart. The stack keeps its status and share link; each
 *  video that leaves is named after its file, comments and all. */
reviewApp.post("/assets/:id/unstack", async (c) => {
  const v = await viewer(c);
  const body = (await c.req.json().catch(() => null)) as { n?: unknown } | null;
  if (!v) return c.json({ error: "Not found" }, 404);
  const id = v.meta.id;
  let made: string[] = [];
  const result = await withLock(id, async () => {
    const meta = await readMeta(id);
    if (!meta) return 404 as const;
    if (processing(meta)) return 409 as const;
    const out = body?.n == null ? meta.versions.slice(1) : meta.versions.filter((x) => x.n === Number(body.n));
    const order = meta.versions.filter((x) => !out.includes(x)).map((x) => x.n);
    if (!out.length || !order.length) return meta;
    const split = out.map((x) => ({ version: x, id: randomUUID() }));
    made = split.map((s) => s.id);
    try {
      for (const s of split) await mkdir(assetDir(s.id));
      await moveDirs([
        ...split.map((s): [string, string] => [versionDir(id, s.version.n), versionDir(s.id, 1)]),
        ...renumberMoves(id, order),
      ]);
    } catch (e) {
      for (const s of split) await rm(assetDir(s.id), { recursive: true, force: true });
      throw e;
    }
    const comments = await readComments(id);
    const now = Date.now();
    for (const s of split) {
      await writeJson(
        commentsPath(s.id),
        comments.filter((cm) => cm.version === s.version.n).map((cm) => ({ ...cm, version: 1 })),
      );
      await writeJson(metaPath(s.id), {
        id: s.id,
        name: assetName(s.version.name),
        owner: meta.owner,
        ...(meta.projectId ? { projectId: meta.projectId } : {}),
        versions: [{ ...s.version, n: 1, madeFrom: undefined }],
        approval: { status: "none" },
        createdAt: now,
        updatedAt: now,
      } satisfies Meta);
    }
    return saveOrder(meta, comments, order);
  });
  if (result === 404) return c.json({ error: "Not found" }, 404);
  if (result === 409) return c.json({ error: "Wait until every version is ready" }, 409);
  await syncLibrary(...made, id);
  return c.json(publicAsset(result, true));
});

// ---------- captioned versions ----------

/** Mark a version as captioned (burned in) and link the version without captions it was made from. */
reviewApp.patch("/assets/:id/v/:n", async (c) => {
  const v = await viewer(c);
  if (!v?.manage) return c.json({ error: "Not found" }, 404);
  const n = Number(c.req.param("n"));
  const body = (await c.req.json().catch(() => null)) as { captioned?: unknown; madeFrom?: unknown } | null;
  let error = "";
  const meta = await updateMeta(v.meta.id, (m) => {
    const ver = m.versions.find((x) => x.n === n);
    if (!ver) return void (error = "Not found");
    const from = body?.madeFrom == null ? undefined : m.versions.find((x) => x.n === Number(body.madeFrom));
    if (body?.madeFrom != null && (!from || from.n === n || from.captioned)) {
      return void (error = "Pick a version without captions");
    }
    if (typeof body?.captioned === "boolean") ver.captioned = body.captioned || undefined;
    ver.madeFrom = ver.captioned ? from?.n : undefined;
    // a captioned version can't be another's version without captions
    if (ver.captioned) for (const x of m.versions) if (x.madeFrom === n) x.madeFrom = undefined;
  });
  if (error || !meta) return c.json({ error: error || "Not found" }, error === "Not found" || !meta ? 404 : 400);
  return c.json(publicAsset(meta, true));
});

const REMOVED = { error: "This version's video was deleted to save space" } as const;

/** Versions before n whose files can go once n is the one being captioned:
 *  not the version without captions a kept version was made from, not still
 *  processing, not already cleared. */
export function clearableBefore(versions: Version[], n: number): Version[] {
  const kept = new Set(versions.filter((x) => x.n >= n).map((x) => x.madeFrom));
  return versions.filter((x) => x.n < n && !x.removed && x.status !== "processing" && !kept.has(x.n));
}

/** Delete the video files of the versions before n (their thumbnails and
 *  comments stay): after a round of review, the earlier renders aren't needed. */
reviewApp.post("/assets/:id/v/:n/clear-earlier", async (c) => {
  const v = await viewer(c);
  const n = Number(c.req.param("n"));
  if (!v?.manage || !v.meta.versions.some((x) => x.n === n)) return c.json({ error: "Not found" }, 404);
  let freed = 0;
  const meta = await withLock(v.meta.id, async () => {
    const m = await readMeta(v.meta.id);
    if (!m) return null;
    for (const x of clearableBefore(m.versions, n)) {
      // the library's links go first, or the files would stay on disk through them
      if (x.versionId) await unlinkFromLibrary(x.versionId).catch((e) => console.error(`[review] library ${m.id}:`, e));
      for (const f of [sourcePath(m.id, x.n), proxyPath(m.id, x.n)]) {
        const st = await stat(f).catch(() => null);
        // a file hard-linked into Caption Studio stays there, so it frees nothing
        if (st?.nlink === 1) freed += st.size;
        await rm(f, { force: true });
      }
      x.removed = Date.now();
    }
    m.updatedAt = Date.now();
    await writeJson(metaPath(m.id), m);
    return m;
  });
  if (!meta) return c.json({ error: "Not found" }, 404);
  await syncLibrary(meta.id);
  return c.json({ asset: publicAsset(meta, true), freed });
});

// ---------- projects (folders) ----------

reviewApp.get("/projects", async (c) => {
  const user = c.get("user");
  return c.json((await readProjects()).filter((p) => p.owner === user.username));
});

reviewApp.post("/projects", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
  const name = cleanText(body?.name, 160);
  if (!name) return c.json({ error: "Name the project first" }, 400);
  const project: Project = { id: randomUUID(), name, owner: c.get("user").username, createdAt: Date.now() };
  await updateProjects((list) => list.push(project));
  return c.json(project);
});

reviewApp.patch("/projects/:pid", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    name?: unknown;
    share?: { enabled?: unknown; download?: unknown; reset?: unknown };
  } | null;
  const name = cleanText(body?.name, 160);
  const user = c.get("user");
  let oldToken: string | undefined;
  const project = await updateProjects((list) => {
    const p = list.find((x) => x.id === c.req.param("pid") && x.owner === user.username);
    if (p && name) p.name = name;
    if (p && body?.share) ({ share: p.share, oldToken } = patchShare(p.share, body.share));
    return p;
  });
  if (!project) return c.json({ error: "Not found" }, 404);
  if (oldToken) await rm(linkPath(oldToken), { force: true });
  if (project.share) await writeFile(linkPath(project.share.token), PROJECT_LINK + project.id);
  return c.json(project);
});

/** Deleting a project takes its videos to the trash with it. */
reviewApp.delete("/projects/:pid", async (c) => {
  const pid = c.req.param("pid");
  const user = c.get("user");
  const gone = await updateProjects((list) => {
    const i = list.findIndex((x) => x.id === pid && x.owner === user.username);
    return i >= 0 ? list.splice(i, 1)[0] : null;
  });
  if (!gone) return c.json({ error: "Not found" }, 404);
  if (gone.share) await rm(linkPath(gone.share.token), { force: true });
  for (const m of await allMetas()) {
    if (m.projectId === pid && m.owner === user.username) await trashAsset(m.id);
  }
  return c.json({ ok: true });
});

// ---------- notifications ----------

interface Note {
  id: string;
  /** producing / delivered: a freelancer on a Workshop share link; workshop: a Content Workshop reply finished */
  kind: "comment" | "reply" | "approved" | "changes" | "version" | "producing" | "delivered" | "workshop" | "failed";
  /** Who did it, as shown. */
  by: string;
  assetId: string;
  name: string;
  text?: string;
  /** Where this user opens it: their library, else a share link. */
  href: string;
  at: number;
  read?: boolean;
}

const INBOX_CAP = 100;

async function readInbox(user: string): Promise<Note[]> {
  try {
    return JSON.parse(await readFile(inboxPath(user), "utf-8")) as Note[];
  } catch {
    return [];
  }
}

function updateInbox(user: string, fn: (list: Note[]) => void): Promise<void> {
  return withLock(`inbox:${user}`, async () => {
    const list = await readInbox(user);
    fn(list);
    await mkdir(path.dirname(inboxPath(user)), { recursive: true });
    await writeJson(inboxPath(user), list.slice(0, INBOX_CAP));
  });
}

async function openPath(user: string, m: Meta): Promise<string | null> {
  if (user === m.owner || findUser(user)?.role === "admin") return `/review/${m.id}`;
  if (m.share?.enabled) return `/r/${m.share.token}`;
  const p = m.projectId ? (await readProjects()).find((x) => x.id === m.projectId) : undefined;
  return p?.share?.enabled ? `/rp/${p.share.token}/${m.id}` : null;
}

/** Tell the owner and every signed-in person who commented on this video,
 *  except whoever did it. Never fails the request that triggered it. */
async function notify(
  m: Meta,
  actor: { name: string; user?: string },
  note: { kind: Note["kind"]; text?: string; query?: string },
): Promise<void> {
  try {
    const people = new Set([m.owner, ...(await readComments(m.id)).flatMap((x) => (x.user ? [x.user] : []))]);
    if (actor.user) people.delete(actor.user);
    for (const user of people) {
      const href = USERNAME_RE.test(user) ? await openPath(user, m) : null;
      if (!href) continue;
      await updateInbox(user, (list) => {
        list.unshift({
          id: randomUUID(),
          kind: note.kind,
          by: actor.name,
          assetId: m.id,
          name: m.name,
          ...(note.text ? { text: note.text.slice(0, 140) } : {}),
          href: href + (note.query ?? ""),
          at: Date.now(),
        });
      });
    }
  } catch {
    /* a missed notification is not worth a failed comment */
  }
}

/** A freelancer on a Content Workshop share link started or delivered, a Workshop reply finished, or a job failed: tell the owner. */
export async function notifyWorkshopOwner(owner: string, note: { kind: "producing" | "delivered" | "workshop" | "failed"; by: string; name: string; text?: string; href: string; ref: string }): Promise<void> {
  if (!USERNAME_RE.test(owner)) return;
  await updateInbox(owner, (list) => {
    list.unshift({ id: randomUUID(), kind: note.kind, by: note.by, assetId: note.ref, name: note.name, ...(note.text ? { text: note.text.slice(0, 140) } : {}), href: note.href, at: Date.now() });
  }).catch(() => {});
}

reviewApp.get("/notifications", async (c) => {
  const list = await readInbox(c.get("user").username);
  return c.json(
    { items: list.slice(0, 50), unread: list.filter((x) => !x.read).length },
    200,
    { "Cache-Control": "no-store" },
  );
});

/** Mark `ids` read, or everything when no ids are given. */
reviewApp.post("/notifications/read", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { ids?: unknown } | null;
  const ids = Array.isArray(body?.ids) ? new Set(body.ids) : null;
  await updateInbox(c.get("user").username, (list) => {
    for (const x of list) if (!ids || ids.has(x.id)) x.read = true;
  });
  return c.json({ ok: true });
});

// ---------- a project's share link: every video filed in it ----------

reviewApp.get("/p/:token", async (c) => {
  const project = await sharedProject(c.req.param("token"));
  if (!project) return c.json({ error: "Not found" }, 404);
  const metas = (await allMetas()).filter((m) => m.projectId === project.id && m.owner === project.owner);
  metas.sort((a, b) => b.updatedAt - a.updatedAt);
  return c.json(
    { name: project.name, assets: metas.map((m) => publicAsset(m, false, project.share!.download)) },
    200,
    { "Cache-Control": "no-store" },
  );
});

// ---------- shared routes: owner (/assets/:id), a video's link (/s/:token),
// a project's link (/p/:token/a/:id) ----------

for (const base of ["/assets/:id", "/s/:token", "/p/:token/a/:id"]) {
  reviewApp.get(base, async (c) => {
    const v = await viewer(c);
    if (!v) return c.json({ error: "Not found" }, 404);
    const comments = await readComments(v.meta.id);
    // an AI reading with the access key (Authorization) doesn't mark comments seen
    const owner = v.manage && v.user === v.meta.owner && !c.req.header("authorization");
    const newest = Math.max(0, ...comments.map((x) => x.createdAt));
    if (owner && newest > (v.meta.seenAt ?? 0)) {
      await updateMeta(v.meta.id, (m) => {
        m.seenAt = newest;
      });
    }
    return c.json(
      {
        asset: publicAsset(v.meta, v.manage, v.download),
        comments: comments.map((cm) => publicComment(v, cm)),
        manage: v.manage,
        user: v.user ?? null,
      },
      200,
      { "Cache-Control": "no-store" },
    );
  });

  reviewApp.get(`${base}/v/:n/:file{play|thumb|download}`, async (c) => {
    const v = await viewer(c);
    const n = Number(c.req.param("n"));
    const version = v?.meta.versions.find((x) => x.n === n);
    if (!v || !version) return c.json({ error: "Not found" }, 404);
    const id = v.meta.id;
    const file = c.req.param("file");
    if (file === "thumb") return sendFile(c, thumbPath(id, n), "image/jpeg");
    if (version.removed) return c.json(REMOVED, 410);
    if (file === "download") {
      if (!v.download) return c.json({ error: "Downloads are off" }, 403);
      const ext = path.extname(version.name).slice(0, 6) || ".mp4";
      const base = safeName(path.basename(version.name, path.extname(version.name)));
      return sendFile(c, sourcePath(id, n), version.mime, `${base}${ext}`);
    }
    if (version.status !== "ready") return c.json({ error: "Not ready" }, 409);
    return version.proxy
      ? sendFile(c, proxyPath(id, n), "video/mp4")
      : sendFile(c, sourcePath(id, n), version.mime);
  });

  /** The frame a comment is on (?c=<comment>, its drawing painted in) or at ?t=
   *  seconds, as a JPEG ?w= wide: how an AI sees what the feedback points at. */
  reviewApp.get(`${base}/v/:n/frame`, async (c) => {
    const v = await viewer(c);
    const n = Number(c.req.param("n"));
    const version = v?.meta.versions.find((x) => x.n === n);
    if (!v || !version) return c.json({ error: "Not found" }, 404);
    if (version.removed) return c.json(REMOVED, 410);
    if (version.status !== "ready") return c.json({ error: "Not ready" }, 409);
    const cid = c.req.query("c");
    const cm = cid ? (await readComments(v.meta.id)).find((x) => x.id === cid && x.version === n) : undefined;
    if (cid && !cm) return c.json({ error: "No such comment on this version" }, 404);
    const t = cleanTime(cm ? cm.t : c.req.query("t"), version.duration);
    if (t === undefined) return c.json({ error: "Which moment? Give c= a timed comment, or t= seconds" }, 400);
    const w = Math.round(Math.min(1080, Math.max(160, Number(c.req.query("w")) || 540)) / 2) * 2;
    // a frame or so before the end: seeking past the last frame yields nothing
    const at = Math.max(0, Math.min(t, version.duration - 1 / (version.fps || 25)));
    if (framesBusy >= FRAMES_AT_ONCE) return c.json({ error: "Busy, try again in a moment" }, 503);
    framesBusy++;
    try {
      const jpeg = await frameJpeg(sourcePath(v.meta.id, n), at, w, cm?.drawing);
      return c.body(new Uint8Array(jpeg), 200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=60" });
    } catch (e) {
      return c.json({ error: `Couldn't read that frame: ${(e as Error).message.slice(0, 200)}` }, 500);
    } finally {
      framesBusy--;
    }
  });

  /** A reference (an image or a video, ≤ 50 MB: boot.ts's body cap) for the
   *  comment being written, raw body, ?name= its file name; the comment
   *  names it when it's sent. */
  reviewApp.post(`${base}/v/:n/refs`, async (c) => {
    const v = await viewer(c);
    const n = Number(c.req.param("n"));
    if (!v || !v.meta.versions.some((x) => x.n === n)) return c.json({ error: "Not found" }, 404);
    const mime = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
    // never SVG: it would run scripts when opened from this origin
    const kind = mime.includes("svg") ? null : mime.startsWith("video/") || mime === "image/gif" ? "video" : mime.startsWith("image/") ? "image" : null;
    if (!kind) return c.json({ error: "Attach an image or a video" }, 415);
    const dir = refsDir(v.meta.id, n);
    await mkdir(dir, { recursive: true });
    if ((await readdir(dir)).filter((f) => f.endsWith(".json")).length >= REFS_PER_VERSION) {
      return c.json({ error: "This version has too many references" }, 400);
    }
    const ref: Ref = { id: randomUUID(), name: cleanText(c.req.query("name"), 120) || "reference", mime, bytes: 0, kind };
    const file = path.join(dir, ref.id);
    try {
      await writeBody(c, file);
      ref.bytes = (await stat(file)).size;
      await writeFile(`${file}.jpg`, await refLook(file, kind));
    } catch {
      await rm(file, { force: true });
      return c.json({ error: "Couldn't read that as an image or a video" }, 400);
    }
    await writeJson(`${file}.json`, ref);
    return c.json(ref, 201);
  });

  /** A reference as uploaded (`file`) or as an AI reads it (`look`, a JPEG). */
  reviewApp.get(`${base}/v/:n/refs/:rid/:file{file|look}`, async (c) => {
    const v = await viewer(c);
    const n = Number(c.req.param("n"));
    const rid = c.req.param("rid");
    if (!v || !Number.isInteger(n) || !UUID.test(rid)) return c.json({ error: "Not found" }, 404);
    const file = path.join(refsDir(v.meta.id, n), rid);
    if (c.req.param("file") === "look") return sendFile(c, `${file}.jpg`, "image/jpeg");
    const ref = await readFile(`${file}.json`, "utf-8").then((s) => JSON.parse(s) as Ref, () => null);
    return ref ? sendFile(c, file, ref.mime) : c.json({ error: "Not found" }, 404);
  });

  reviewApp.post(`${base}/comments`, async (c) => {
    const v = await viewer(c);
    if (!v) return c.json({ error: "Not found" }, 404);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const text = cleanText(body?.text, 4000);
    const drawing = cleanDrawing(body?.drawing);
    const parentId = typeof body?.parentId === "string" ? body.parentId : undefined;
    const version = v.meta.versions.find((x) => x.n === Number(body?.version));
    if (!version) return c.json({ error: "Unknown version" }, 400);
    const refs = parentId ? [] : await cleanRefs(v.meta.id, version.n, body?.refs);
    if (!text && !drawing && !refs.length) return c.json({ error: "Write a comment first" }, 400);
    const author = v.user ?? cleanText(body?.author, 60);
    if (!author) return c.json({ error: "Add your name first" }, 400);
    if (!v.user && (!v.guestKey || v.guestKey.length < 16)) {
      return c.json({ error: "Missing reviewer key" }, 400);
    }
    const t = parentId ? undefined : cleanTime(body?.t, version.duration);
    const tEnd = t === undefined ? undefined : cleanTime(body?.tEnd, version.duration);
    const cm: Comment = {
      id: randomUUID(),
      version: version.n,
      ...(parentId ? { parentId } : {}),
      ...(t !== undefined ? { t } : {}),
      ...(tEnd !== undefined && tEnd > t! ? { tEnd } : {}),
      text,
      author,
      ...(v.user ? { user: v.user } : { guestKey: v.guestKey }),
      ...(drawing && !parentId ? { drawing } : {}),
      ...(refs.length ? { refs } : {}),
      createdAt: Date.now(),
    };
    const error = await updateComments(v.meta.id, (list) => {
      if (list.length >= 5000) return "This video has too many comments";
      if (parentId && !list.some((x) => x.id === parentId && !x.parentId)) {
        return "That comment is gone";
      }
      list.push(cm);
      return null;
    });
    if (error) return c.json({ error }, 400);
    await notify(v.meta, { name: author, user: v.user }, {
      kind: parentId ? "reply" : "comment",
      text: text || (drawing ? "Drew on the frame" : "Added a reference"),
      query: `?v=${version.n}&c=${parentId ?? cm.id}`,
    });
    return c.json(publicComment(v, cm));
  });

  reviewApp.patch(`${base}/comments/:cid`, async (c) => {
    const v = await viewer(c);
    if (!v) return c.json({ error: "Not found" }, 404);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    // the AI access key (Authorization) may mark feedback done, never rewrite it
    if (c.req.header("authorization") && body?.text !== undefined) {
      return c.json({ error: "The AI access key can only resolve comments" }, 403);
    }
    const cid = c.req.param("cid");
    const result = await updateComments(v.meta.id, (list) => {
      const cm = list.find((x) => x.id === cid);
      if (!cm) return 404 as const;
      const mine = isAuthor(v, cm);
      if (typeof body?.resolved === "boolean") {
        if (!v.manage && !mine) return 403 as const;
        cm.resolved = body.resolved;
      }
      const text = cleanText(body?.text, 4000);
      if (text && text !== cm.text) {
        if (!mine) return 403 as const;
        cm.text = text;
        cm.editedAt = Date.now();
      }
      return cm;
    });
    if (result === 404) return c.json({ error: "Not found" }, 404);
    if (result === 403) return c.json({ error: "Not your comment" }, 403);
    return c.json(publicComment(v, result));
  });

  reviewApp.delete(`${base}/comments/:cid`, async (c) => {
    const v = await viewer(c);
    if (!v) return c.json({ error: "Not found" }, 404);
    const cid = c.req.param("cid");
    const gone: Comment[] = [];
    const status = await updateComments(v.meta.id, (list): 200 | 403 | 404 => {
      const cm = list.find((x) => x.id === cid);
      if (!cm) return 404;
      if (!v.manage && !isAuthor(v, cm)) return 403;
      // a thread goes with its first comment
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].id === cid || list[i].parentId === cid) gone.push(...list.splice(i, 1));
      }
      return 200;
    });
    if (status !== 200) {
      return c.json({ error: status === 403 ? "Not your comment" : "Not found" }, status);
    }
    // its references go with it
    for (const cm of gone) {
      for (const r of cm.refs ?? []) {
        for (const f of [r.id, `${r.id}.jpg`, `${r.id}.json`]) await rm(path.join(refsDir(v.meta.id, cm.version), f), { force: true });
      }
    }
    return c.json({ ok: true });
  });

  reviewApp.post(`${base}/approval`, async (c) => {
    const v = await viewer(c);
    if (!v) return c.json({ error: "Not found" }, 404);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const status = APPROVALS.find((a) => a === body?.status);
    const by = v.user ?? cleanText(body?.author, 60);
    if (!status || (!v.manage && !REVIEWER_APPROVALS.includes(status)) || !by) {
      return c.json({ error: "Invalid status" }, 400);
    }
    const meta = await updateMeta(v.meta.id, (m) => {
      m.approval = { status, by, at: Date.now() };
    });
    if (!meta) return c.json({ error: "Not found" }, 404);
    if (status === "approved" || status === "changes") {
      await notify(meta, { name: by, user: v.user }, { kind: status });
    }
    return c.json(publicAsset(meta, v.manage, v.download));
  });
}
