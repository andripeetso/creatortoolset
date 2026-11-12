import { HTTPException } from "hono/http-exception";
import { Hono } from "hono";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  statSync,
} from "node:fs";
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { filterEscape, requireFontsDir } from "./export";
import { deleteExportsForProject } from "./exports";
import { env, hostedMode } from "./lib/env";
import {
  abortSourceMultipart,
  completeSourceMultipart,
  createSourceMultipart,
  deleteStoredSource,
  downloadStoredSource,
  ensureProjectOriginal,
  listSourceParts,
  objectStorageEnabled,
  presignSourcePart,
  sourceObjectKey,
} from "./media-store";
import { copyProjectName, mediaOwnerProjectId } from "./lib/project-copy";
import { MAX_SCRIPT_CHARS } from "../src/lib/script-check";
import type { AuthVars } from "./auth";
import type { Expired } from "./retention";
import { type SessionUser, bumpUsage } from "./users";
import { announceSoon } from "./lib/announce-soon";

/**
 * File-based project persistence. A project is a POOL of clips: one
 * project holds any number of clips that share project-level settings
 * (fps, transcription model) while each clip keeps its own video,
 * transcript, captions and style.
 *
 * Layout: $DATA_DIR/projects/<id>/
 *   meta.json                 project meta + clip registry
 *   data.json                 project settings (fps, model)
 *   clips/<clipId>/
 *     proxy.mp4               compressed editing proxy
 *     original                uploaded source (optional, for burn-in)
 *     data.json               words, cues, style, peaks
 *
 * Projects saved before the clips layout existed have proxy.mp4 /
 * original / data.json at the project root; those are migrated into
 * clips/<id>/ lazily on first access (and in a sweep at boot).
 *
 * Projects belong to the account that created them. The list endpoint
 * is personal — everyone (admins included) sees only their own there.
 * By-id routes also let admins in. Projects saved before accounts existed
 * have no owner; those stay in the admin's personal list so legacy
 * saves (and local no-auth use) keep working.
 */
export const projectsApp = new Hono<{ Variables: AuthVars }>();

const DATA_DIR =
  process.env.DATA_DIR || path.join(homedir(), ".caption-studio");
const PROJECTS_DIR = path.join(DATA_DIR, "projects");
const TRASH_KEEP_DAYS = 5;
const TRASH_KEEP_MS = TRASH_KEEP_DAYS * 24 * 3600 * 1000;

const okId = (id: string) => /^[a-z0-9-]{6,40}$/.test(id);
const projDir = (id: string) => path.join(PROJECTS_DIR, id);
const clipDir = (id: string, clipId: string) =>
  path.join(projDir(id), "clips", clipId);
const clipOriginalPath = (id: string, clipId: string) =>
  path.join(clipDir(id, clipId), "original");
const clipProxyPath = (id: string, clipId: string) =>
  path.join(clipDir(id, clipId), "proxy.mp4");
const clipDataPath = (id: string, clipId: string) =>
  path.join(clipDir(id, clipId), "data.json");
const clipUploadPath = (id: string, clipId: string) =>
  path.join(clipDir(id, clipId), "original.upload");
const clipPartsDir = (id: string, clipId: string) =>
  path.join(clipDir(id, clipId), "original.parts");
const clipPartsStatePath = (id: string, clipId: string) =>
  path.join(clipPartsDir(id, clipId), "upload.json");

interface PartsUploadState {
  total: number;
  partSize: number;
}

const partCount = (total: number, partSize: number) =>
  Math.ceil(total / partSize);
const expectedPartSize = (
  total: number,
  partSize: number,
  partNumber: number,
) => Math.min(partSize, total - (partNumber - 1) * partSize);

async function readPartsUploadState(
  id: string,
  clipId: string,
): Promise<PartsUploadState | null> {
  try {
    const raw = JSON.parse(
      await readFile(clipPartsStatePath(id, clipId), "utf-8"),
    );
    if (
      !Number.isSafeInteger(raw?.total) ||
      !Number.isSafeInteger(raw?.partSize)
    )
      return null;
    return { total: raw.total, partSize: raw.partSize };
  } catch {
    return null;
  }
}

const proxyBuilds = new Map<string, Promise<void>>();

/**
 * Originals are only needed for burned-in exports — the proxy carries
 * editing forever, and a missing original can be re-attached anytime.
 * ORIGINALS_KEEP_DAYS > 0 auto-deletes originals not touched in N days.
 */
const KEEP_DAYS = Number(process.env.ORIGINALS_KEEP_DAYS || 0);

async function sweepOriginals(): Promise<void> {
  if (!KEEP_DAYS) return;
  let ids: string[] = [];
  try {
    ids = (await readdir(PROJECTS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter(okId);
  } catch {
    return;
  }
  const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
  for (const id of ids) {
    for (const clipId of await clipIds(id)) {
      try {
        const p = clipOriginalPath(id, clipId);
        const st = await stat(p);
        if (st.mtimeMs < cutoff) {
          await rm(p, { force: true });
          console.log(
            `[projects] retention: removed original of ${id}/${clipId}`,
          );
        }
      } catch {
        /* no original — nothing to do */
      }
    }
  }
}

if (KEEP_DAYS > 0) {
  void sweepOriginals();
  setInterval(() => void sweepOriginals(), 12 * 3600 * 1000).unref();
}

interface ClipMeta {
  /** set on a clip that addEditedClip made: the hand-over it came from, and the clip it is an edit of */
  transferId?: string;
  transferOrigin?: { projectId: string; clipId: string; scenes: number };
  id: string;
  name: string;
  duration: number;
  createdAt: number;
  /** Original clip resolution — the proxy is downscaled, UI math isn't. */
  srcWidth?: number;
  srcHeight?: number;
  /** Source frame rate (ffprobe, snapped to standard rates). */
  srcFps?: number;
  /** Canonical source in private S3-compatible object storage. */
  originalObjectKey?: string;
  /** Another project already holds this clip's proxy/original on disk. */
  mediaProjectId?: string;
  /** Came from the Media Library: a missing original is read from that version again (media-store.ts). */
  libraryVersionId?: string;
  originalBytes?: number;
  objectUpload?: {
    id: string;
    key: string;
    size: number;
    contentType: string;
    partSize: number;
  };
}

interface Meta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Sum of clip durations — for the session list / admin panel. */
  duration: number;
  owner?: string; // account username; absent on pre-account projects
  clips: ClipMeta[];
  /** Disk-only orphan reconstructed without ownership or a saved transcript. */
  incompleteRecovery?: boolean;
  /** Monotonic editor-document revision (media processing is independent). */
  revision?: number;
  /** Last idempotent sync mutation accepted for this project. */
  lastMutationId?: string;
  /** Soft-deleted projects remain recoverable until the trash sweep. */
  deletedAt?: number;
  // legacy flat single-clip fields, only present pre-migration
  srcWidth?: number;
  srcHeight?: number;
  srcFps?: number;
}

/** Project-level settings (data.json next to meta.json). */
interface ProjectData {
  fps?: number;
  model?: string;
  autoCadence?: boolean;
  /** The script the video was filmed from, for the AI script check. */
  script?: string;
}

interface ProjectUpdate {
  name?: unknown;
  fps?: unknown;
  model?: unknown;
  autoCadence?: unknown;
  script?: unknown;
  clipOrder?: unknown;
  clip?: { id?: unknown; name?: unknown; duration?: unknown } & Record<
    string,
    unknown
  >;
}

/** Probe the first audio stream's codec ("" when none / ffprobe fails). */
function probeAudioCodec(file: string): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=codec_name",
      "-of",
      "csv=p=0",
      file,
    ]);
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("close", () => resolve(out.trim().toLowerCase()));
    p.on("error", () => resolve(""));
  });
}

/**
 * Probe a video's size as it is shown (0×0 when ffprobe fails). A phone clip filmed upright is stored lying down
 * with a quarter turn beside it: every player, the editing copy and a render show it turned, so that is its size.
 */
function probeDims(file: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const p = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height:stream_side_data=rotation:stream_tags=rotate",
        "-of",
        "default=noprint_wrappers=1",
        file,
        // a wedged file must never hang a project load — kill after 10s
      ],
      { timeout: 10_000 },
    );
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("close", () => {
      const n = (key: string) => Number(new RegExp(`^${key}=(-?[\\d.]+)`, "m").exec(out)?.[1]) || 0;
      const [w, h] = [n("width"), n("height")];
      // the turn is side data on today's ffprobe, a `rotate` tag on older ones
      const turned = Math.abs(n("rotation") || n("TAG:rotate")) % 180 === 90;
      resolve(turned ? { width: h, height: w } : { width: w, height: h });
    });
    p.on("error", () => resolve({ width: 0, height: 0 }));
  });
}

/** Nearest standard frame rate within 2%, else the raw value rounded. */
const STD_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 120];
function snapFps(raw: number): number {
  let best = STD_FPS[0];
  for (const s of STD_FPS) {
    if (Math.abs(raw - s) < Math.abs(raw - best)) best = s;
  }
  return Math.abs(raw - best) / best < 0.02
    ? best
    : Math.round(raw * 100) / 100;
}

/** Probe a video's frame rate (0 when unknown / ffprobe fails). */
function probeFps(file: string): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=r_frame_rate,avg_frame_rate",
        "-of",
        "default=noprint_wrappers=1",
        file,
      ],
      { timeout: 10_000 },
    );
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("close", () => {
      const rates: Record<string, number> = {};
      for (const line of out.trim().split("\n")) {
        const [k, v] = line.split("=");
        if (!k || !v) continue;
        const [num, den] = v.split("/").map(Number);
        rates[k] = den ? num / den : Number(v) || 0;
      }
      // avg is the truth for variable-rate phone clips; r_ is the fallback
      const raw = [rates.avg_frame_rate, rates.r_frame_rate].find(
        (v) => typeof v === "number" && v > 0 && v <= 480,
      );
      resolve(raw ? snapFps(raw) : 0);
    });
    p.on("error", () => resolve(0));
  });
}

const canAccess = (meta: Meta, user: SessionUser) =>
  user.role === "admin" || meta.owner === user.username;

/**
 * Atomic JSON write: tmp file + rename, so a crash mid-write can never
 * leave a truncated file behind (readers only ever see whole JSON).
 */
async function writeJson(file: string, value: unknown): Promise<void> {
  // Multiple autosaves/uploads can finish in the same process at once. A
  // unique temp name keeps one atomic write from renaming another's file.
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, file);
}

interface DraftRequest {
  name?: unknown;
  clips?: { id?: unknown; name?: unknown }[];
}

function parseDraftClips(body: DraftRequest): ClipMeta[] | null {
  const requested = Array.isArray(body.clips) ? body.clips.slice(0, 100) : [];
  if (!requested.length) return null;
  const seen = new Set<string>();
  const clips: ClipMeta[] = [];
  for (const entry of requested) {
    const clipId = typeof entry.id === "string" ? entry.id : "";
    if (!okId(clipId) || seen.has(clipId)) return null;
    seen.add(clipId);
    clips.push({
      id: clipId,
      name:
        typeof entry.name === "string" && entry.name.trim()
          ? entry.name.trim().slice(0, 120)
          : `Clip ${clips.length + 1}`,
      duration: 0,
      createdAt: Date.now(),
    });
  }
  return clips;
}

function draftName(body: DraftRequest): string {
  return typeof body.name === "string" && body.name.trim()
    ? body.name.trim().slice(0, 120)
    : "untitled";
}

async function readMeta(id: string): Promise<Meta | null> {
  const dir = projDir(id);
  if (!existsSync(dir)) return null;
  let m: Meta | null = null;
  try {
    m = JSON.parse(await readFile(path.join(dir, "meta.json"), "utf-8"));
  } catch {
    // meta.json missing or corrupt — rebuilt from disk below
  }
  if (m && !m.owner && m.name === "recovered") {
    m.incompleteRecovery = true;
  }
  if (m && !Array.isArray(m.clips)) m.clips = [];
  // crash-safe repair: the registry (meta.json) can lose clips while the
  // clips themselves are fine on disk — rebuild the missing entries from
  // the clips/ directories instead of showing an empty project
  const disk = await clipIds(id);
  if (!m) {
    if (!disk.length) return null; // no meta and no clips — truly gone
    m = {
      id,
      name: "recovered",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      duration: 0,
      clips: [],
      incompleteRecovery: true,
    };
  }
  const known = new Set(m.clips.map((c) => c.id));
  const lost: { id: string; created: number }[] = [];
  for (const cid of disk) {
    if (known.has(cid) || !okId(cid)) continue;
    // a clip is real once it has content; a bare dir is a mid-upload stub
    if (
      !existsSync(clipProxyPath(id, cid)) &&
      !existsSync(clipOriginalPath(id, cid)) &&
      !existsSync(clipDataPath(id, cid))
    )
      continue;
    let created = Date.now();
    try {
      created = statSync(clipDir(id, cid)).birthtimeMs || Date.now();
    } catch {
      /* keep the fallback */
    }
    lost.push({ id: cid, created });
  }
  if (lost.length) {
    lost.sort((a, b) => a.created - b.created); // original import order
    for (const c of lost) {
      m.clips.push({
        id: c.id,
        name: `Clip ${m.clips.length + 1}`,
        duration: 0,
        createdAt: c.created,
      });
    }
    m.updatedAt = Date.now();
    await writeMeta(m).catch(() => {});
  } else if (!existsSync(path.join(dir, "meta.json"))) {
    await writeMeta(m).catch(() => {}); // persist the rebuilt skeleton
  }
  return m;
}

async function writeMeta(meta: Meta): Promise<void> {
  meta.duration = meta.clips.reduce((a, c) => a + (c.duration || 0), 0);
  await writeJson(path.join(projDir(meta.id), "meta.json"), meta);
}

async function readProjectData(id: string): Promise<ProjectData> {
  try {
    return JSON.parse(
      await readFile(path.join(projDir(id), "data.json"), "utf-8"),
    );
  } catch {
    return {};
  }
}

/** Apply one editor snapshot; meta.json is written last as the commit marker. */
async function applyProjectUpdate(
  id: string,
  meta: Meta,
  data: ProjectUpdate,
): Promise<void> {
  meta.updatedAt = Date.now();
  if (typeof data.name === "string" && data.name) {
    meta.name = data.name.slice(0, 120);
  }

  const projData = await readProjectData(id);
  if (typeof data.fps === "number" && data.fps > 0) projData.fps = data.fps;
  if (typeof data.model === "string" && data.model) projData.model = data.model;
  if (typeof data.autoCadence === "boolean") {
    projData.autoCadence = data.autoCadence;
  }
  if (typeof data.script === "string") {
    projData.script = data.script.slice(0, MAX_SCRIPT_CHARS);
  }
  await writeJson(path.join(projDir(id), "data.json"), projData);

  if (Array.isArray(data.clipOrder)) {
    const order = data.clipOrder.filter(
      (value): value is string => typeof value === "string",
    );
    const rank = new Map(order.map((clipId, index) => [clipId, index]));
    meta.clips = [...meta.clips].sort(
      (a, b) =>
        (rank.get(a.id) ?? order.length) - (rank.get(b.id) ?? order.length),
    );
  }

  if (data.clip && typeof data.clip.id === "string" && okId(data.clip.id)) {
    const cm = meta.clips.find((entry) => entry.id === data.clip!.id);
    if (cm) {
      if (typeof data.clip.name === "string" && data.clip.name) {
        cm.name = data.clip.name.slice(0, 120);
      }
      if (typeof data.clip.duration === "number") {
        cm.duration = data.clip.duration;
      }
      const clipData: Record<string, unknown> = { ...data.clip };
      delete clipData.id;
      delete clipData.name;
      await mkdir(clipDir(id, cm.id), { recursive: true });
      await writeJson(clipDataPath(id, cm.id), clipData);
    }
  }
}

const projectWrites = new Map<string, Promise<void>>();

function sourceMultipartPartSize(size: number): number {
  const minPartSize = 16 * 1024 * 1024;
  return Math.max(
    minPartSize,
    Math.ceil(size / 9_500 / (1024 * 1024)) * 1024 * 1024,
  );
}

/** Serialize revision checks and commits for a project within this process. */
async function withProjectWrite<T>(
  id: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = projectWrites.get(id) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  projectWrites.set(id, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (projectWrites.get(id) === tail) projectWrites.delete(id);
  }
}

async function clipIds(id: string): Promise<string[]> {
  try {
    return (
      await readdir(path.join(projDir(id), "clips"), { withFileTypes: true })
    )
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function mediaHome(projectId: string, clip: ClipMeta): string {
  return mediaOwnerProjectId(projectId, clip);
}

function clipOwnsStoredSource(projectId: string, clip: ClipMeta): boolean {
  if (mediaHome(projectId, clip) !== projectId) return false;
  if (!clip.originalObjectKey) return false;
  return clip.originalObjectKey === sourceObjectKey(projectId, clip.id);
}

function clipOriginalInfo(
  id: string,
  clipId: string,
  clip?: ClipMeta,
): { hasOriginal: boolean; originalBytes: number } {
  if (clip?.originalObjectKey) {
    return { hasOriginal: true, originalBytes: clip.originalBytes ?? 0 };
  }
  const home = clip ? mediaHome(id, clip) : id;
  try {
    const st = statSync(clipOriginalPath(home, clipId));
    return { hasOriginal: true, originalBytes: st.size };
  } catch {
    // ponytail: assumed still in the library; the render's own lookup (ensureProjectOriginal) answers NO_ORIGINAL if not
    return { hasOriginal: !!clip?.libraryVersionId, originalBytes: 0 };
  }
}

/**
 * Move a pre-clips project (proxy.mp4 / original / data.json at the
 * project root) into the clips/<id>/ layout. Idempotent.
 */
async function ensureMigrated(id: string): Promise<void> {
  if (!okId(id)) return;
  const dir = projDir(id);
  if (!existsSync(dir) || existsSync(path.join(dir, "clips"))) return;
  const legacyProxy = path.join(dir, "proxy.mp4");
  const legacyOriginal = path.join(dir, "original");
  const legacyData = path.join(dir, "data.json");
  const meta = await readMeta(id);
  if (!meta) return;
  if (
    !existsSync(legacyProxy) &&
    !existsSync(legacyOriginal) &&
    !existsSync(legacyData)
  ) {
    if (!existsSync(path.join(dir, "data.json"))) {
      // fresh-style project that simply has no clips dir yet
      await mkdir(path.join(dir, "clips"), { recursive: true }).catch(() => {});
    }
    return;
  }
  const clipId = randomUUID();
  const cdir = clipDir(id, clipId);
  try {
    await mkdir(cdir, { recursive: true });
    for (const f of ["proxy.mp4", "original", "data.json"]) {
      const p = path.join(dir, f);
      if (existsSync(p)) await rename(p, path.join(cdir, f));
    }
    // lift project settings out of the legacy flat data.json
    let legacy: Record<string, unknown> = {};
    try {
      legacy = JSON.parse(await readFile(clipDataPath(id, clipId), "utf-8"));
    } catch {
      /* no data — video-only save */
    }
    const projData: ProjectData = {};
    if (typeof legacy.fps === "number") projData.fps = legacy.fps;
    if (typeof legacy.model === "string") projData.model = legacy.model;
    await writeFile(path.join(dir, "data.json"), JSON.stringify(projData));
    meta.clips = [
      {
        id: clipId,
        name: typeof legacy.clipName === "string" ? legacy.clipName : meta.name,
        duration:
          typeof legacy.duration === "number" ? legacy.duration : meta.duration,
        createdAt: meta.createdAt,
        ...(meta.srcWidth
          ? { srcWidth: meta.srcWidth, srcHeight: meta.srcHeight }
          : {}),
        ...(meta.srcFps ? { srcFps: meta.srcFps } : {}),
      },
    ];
    delete meta.srcWidth;
    delete meta.srcHeight;
    delete meta.srcFps;
    await writeMeta(meta);
    console.log(`[projects] migrated ${id} to clips layout`);
  } catch (e) {
    console.error(`[projects] migration of ${id} failed:`, e);
    await rm(cdir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Load a project's meta only if `user` may touch it (else 404 upstream). */
async function ownedMeta(id: string, user: SessionUser): Promise<Meta | null> {
  if (!okId(id)) return null;
  await ensureMigrated(id);
  const meta = await readMeta(id);
  if (!meta || meta.deletedAt || !canAccess(meta, user)) return null;
  return meta;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => {
      err += d.toString();
      if (err.length > 4000) err = err.slice(-4000);
    });
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}: ${err}`));
    });
    p.on("error", reject);
  });
}

/** 320px JPEG for the project picker — 1s in, first frame as fallback. */
async function makeThumb(src: string, out: string): Promise<void> {
  const args = (seek: string[]) => [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...seek,
    "-i",
    src,
    "-frames:v",
    "1",
    "-vf",
    "scale=320:-2",
    "-q:v",
    "5",
    out,
  ];
  try {
    await run("ffmpeg", args(["-ss", "1"]));
    if (statSync(out).size === 0) throw new Error("empty thumb");
  } catch {
    await rm(out, { force: true }).catch(() => {});
    await run("ffmpeg", args([]));
  }
}

/**
 * Backfill thumbnails for clips that predate them (or whose generation
 * failed), sequentially in the background at boot. New clips generate
 * theirs during ingest; the /thumb route covers anything left over.
 */
async function backfillThumbs(): Promise<void> {
  let ids: string[] = [];
  try {
    ids = (await readdir(PROJECTS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter(okId);
  } catch {
    return;
  }
  for (const id of ids) {
    for (const clipId of await clipIds(id)) {
      const cdir = clipDir(id, clipId);
      const thumb = path.join(cdir, "thumb.jpg");
      if (existsSync(thumb)) continue;
      const src = existsSync(clipOriginalPath(id, clipId))
        ? clipOriginalPath(id, clipId)
        : clipProxyPath(id, clipId);
      if (!existsSync(src)) continue;
      await makeThumb(src, thumb).catch(() => {});
    }
  }
}
void backfillThumbs();

/**
 * Transcode an uploaded source into the editing proxy inside the clip
 * dir and keep the source next to it. Returns probed source metadata.
 */
async function ingestClip(
  src: string,
  cdir: string,
): Promise<{
  srcWidth: number;
  srcHeight: number;
  srcFps: number;
}> {
  // editing proxy: ≤720p CRF 25 — light enough to stream, close enough
  // to judge the picture. Audio is COPIED whenever mp4 allows it:
  // a bit-identical track can't drift out of sync the way a re-encode
  // can, and phone clips are AAC already.
  const audioCodec = await probeAudioCodec(src);
  const audioArgs = ["aac", "mp3"].includes(audioCodec)
    ? ["-c:a", "copy"]
    : ["-c:a", "aac", "-b:a", "128k", "-af", "aresample=async=1:first_pts=0"];
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    src,
    "-vf",
    "scale=-2:floor(min(720\\,ih)/2)*2",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "25",
    "-pix_fmt",
    "yuv420p",
    ...audioArgs,
    "-movflags",
    "+faststart",
    path.join(cdir, "proxy.mp4"),
  ]);
  // keep the source for burned-in exports (subject to retention sweep)
  const original = path.join(cdir, "original");
  await rename(src, original);
  const dims = await probeDims(original);
  const srcFps = await probeFps(original);
  // thumbnail for the project picker — fire and forget, a missing one
  // is generated lazily by the /thumb route or the boot backfill
  void makeThumb(original, path.join(cdir, "thumb.jpg")).catch(() => {});
  return { srcWidth: dims.width, srcHeight: dims.height, srcFps };
}

/**
 * Build the editing proxy after a resumable source upload has completed.
 * This runs independently of the upload request: proxy generation can take
 * minutes, but it must never hold the project id or transcript hostage.
 */
async function buildProxyFromOriginal(
  id: string,
  clipId: string,
): Promise<void> {
  const key = `${id}/${clipId}`;
  if (proxyBuilds.has(key)) return proxyBuilds.get(key)!;
  const task = (async () => {
    const src = clipOriginalPath(id, clipId);
    const cdir = clipDir(id, clipId);
    if (!existsSync(src) || existsSync(clipProxyPath(id, clipId))) return;
    const audioCodec = await probeAudioCodec(src);
    const audioArgs = ["aac", "mp3"].includes(audioCodec)
      ? ["-c:a", "copy"]
      : ["-c:a", "aac", "-b:a", "128k", "-af", "aresample=async=1:first_pts=0"];
    const proxyTmp = path.join(cdir, "proxy.mp4.tmp");
    try {
      await run("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        src,
        "-vf",
        "scale=-2:floor(min(720\\,ih)/2)*2",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "25",
        "-pix_fmt",
        "yuv420p",
        ...audioArgs,
        "-movflags",
        "+faststart",
        // The atomic temp suffix is not a recognized container extension.
        // Declare MP4 explicitly so completed uploads can always produce the
        // proxy before proxy.mp4.tmp is renamed to proxy.mp4.
        "-f",
        "mp4",
        proxyTmp,
      ]);
      await rename(proxyTmp, clipProxyPath(id, clipId));
      const dims = await probeDims(src);
      const srcFps = await probeFps(src);
      await withProjectWrite(id, async () => {
        // Re-read after probing: an autosave can commit while ffprobe runs,
        // and media metadata must never write an older editor revision back.
        const meta = await readMeta(id);
        const clip = meta?.clips.find((entry) => entry.id === clipId);
        if (meta && clip) {
          if (dims.width) {
            clip.srcWidth = dims.width;
            clip.srcHeight = dims.height;
          }
          if (srcFps) clip.srcFps = srcFps;
          meta.updatedAt = Date.now();
          await writeMeta(meta);
          announceSoon(meta.owner, "projects"); // the editor waiting for this proxy switches to it
        }
      });
      void makeThumb(src, path.join(cdir, "thumb.jpg")).catch(() => {});
    } finally {
      await rm(proxyTmp, { force: true }).catch(() => {});
    }
  })().finally(() => proxyBuilds.delete(key));
  proxyBuilds.set(key, task);
  return task;
}

async function cacheObjectSourceAndBuildProxy(
  id: string,
  clipId: string,
  key: string,
): Promise<void> {
  await downloadStoredSource(key, clipOriginalPath(id, clipId));
  await buildProxyFromOriginal(id, clipId);
}

async function resumeMissingProxies(): Promise<void> {
  let ids: string[] = [];
  try {
    ids = (await readdir(PROJECTS_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && okId(entry.name))
      .map((entry) => entry.name);
  } catch {
    return;
  }
  for (const id of ids) {
    const meta = await readMeta(id).catch(() => null);
    if (!meta || meta.deletedAt) continue;
    for (const clip of meta.clips) {
      if (mediaHome(id, clip) !== id) continue;
      if (existsSync(clipProxyPath(id, clip.id))) continue;
      if (existsSync(clipOriginalPath(id, clip.id))) {
        void buildProxyFromOriginal(id, clip.id).catch((error) =>
          console.error(
            `[projects] resume proxy ${id}/${clip.id} failed:`,
            error,
          ),
        );
      } else if (clip.originalObjectKey) {
        void cacheObjectSourceAndBuildProxy(
          id,
          clip.id,
          clip.originalObjectKey,
        ).catch((error) =>
          console.error(
            `[projects] resume object proxy ${id}/${clip.id} failed:`,
            error,
          ),
        );
      }
    }
  }
}

void resumeMissingProxies();

/* list sessions — personal: own projects only (admins keep ownerless
   pre-account projects so legacy saves stay reachable) */
projectsApp.get("/", async (c) => {
  const user = c.get("user");
  let ids: string[] = [];
  try {
    ids = (await readdir(PROJECTS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return c.json([]);
  }
  const metas = (
    await Promise.all(
      ids.filter(okId).map(async (id) => {
        await ensureMigrated(id);
        return readMeta(id);
      }),
    )
  ).filter(
    (m): m is Meta =>
      !!m &&
      !m.deletedAt &&
      !m.incompleteRecovery &&
      (m.owner === user.username || (user.role === "admin" && !m.owner)),
  );
  metas.sort((a, b) => b.updatedAt - a.updatedAt);
  return c.json(
    metas.map((m) => ({
      id: m.id,
      name: m.name,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      duration: m.duration,
      clipCount: m.clips.length,
      /** First clip — the client builds its thumbnail URL from this. */
      thumbClipId: m.clips[0]?.id ?? null,
    })),
  );
});

projectsApp.get("/trash", async (c) => {
  const user = c.get("user");
  let ids: string[] = [];
  try {
    ids = (await readdir(PROJECTS_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && okId(entry.name))
      .map((entry) => entry.name);
  } catch {
    return c.json([]);
  }
  const metas = (await Promise.all(ids.map(readMeta))).filter(
    (meta): meta is Meta =>
      !!meta?.deletedAt &&
      (meta.owner === user.username || (user.role === "admin" && !meta.owner)),
  );
  metas.sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
  return c.json(
    metas.map((meta) => ({
      id: meta.id,
      name: meta.name,
      deletedAt: meta.deletedAt,
      recoverableUntil: (meta.deletedAt ?? 0) + TRASH_KEEP_MS,
      clipCount: meta.clips.length,
    })),
  );
});

projectsApp.delete("/trash/:id", async (c) => {
  const id = c.req.param("id");
  if (!okId(id)) return c.json({ error: "Not found" }, 404);
  const meta = await readMeta(id);
  if (!meta?.deletedAt || !canAccess(meta, c.get("user"))) {
    return c.json({ error: "Not found" }, 404);
  }
  await purgeDeletedProject(id, meta);
  return c.json({ ok: true });
});

/* Create the durable project shell before any source-video bytes move. */
projectsApp.post("/draft", async (c) => {
  let body: DraftRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const clips = parseDraftClips(body);
  if (!clips) return c.json({ error: "Invalid or missing clips" }, 400);
  const id = randomUUID();
  const meta: Meta = {
    id,
    name: draftName(body),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    duration: 0,
    owner: c.get("user").username,
    clips,
    revision: 0,
  };
  try {
    await mkdir(path.join(projDir(id), "clips"), { recursive: true });
    // Ownership and the project id must reach disk before any clip setup. A
    // process crash can leave an incomplete owned shell, never an ownerless
    // fake "recovered" project that appears and then vanishes.
    await writeMeta(meta);
    for (const clip of clips) {
      await mkdir(clipDir(id, clip.id), { recursive: true });
      await writeJson(clipDataPath(id, clip.id), {});
    }
    await writeJson(path.join(projDir(id), "data.json"), {});
    bumpUsage(meta.owner!, { projectsCreated: 1 });
    return c.json({ id, revision: 0 });
  } catch (error) {
    await rm(projDir(id), { recursive: true, force: true }).catch(() => {});
    return c.json(
      { error: error instanceof Error ? error.message : String(error) },
      500,
    );
  }
});

/*
 * Idempotently create a project using the browser-generated id. The local
 * project exists before the network does, so retrying this request after a
 * timeout must converge on the same server project instead of making a copy.
 */
projectsApp.put("/:id/draft", async (c) => {
  const id = c.req.param("id");
  if (!okId(id)) return c.json({ error: "Invalid project id" }, 400);
  let body: DraftRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const requestedClips = parseDraftClips(body);
  if (!requestedClips) {
    return c.json({ error: "Invalid or missing clips" }, 400);
  }
  const user = c.get("user");
  try {
    return await withProjectWrite(id, async () => {
      let meta = await readMeta(id);
      let created = false;
      if (meta) {
        if (meta.deletedAt || !canAccess(meta, user)) {
          return c.json({ error: "Not found" }, 404);
        }
      } else {
        const now = Date.now();
        meta = {
          id,
          name: draftName(body),
          createdAt: now,
          updatedAt: now,
          duration: 0,
          owner: user.username,
          clips: [],
          revision: 0,
        };
        await mkdir(path.join(projDir(id), "clips"), { recursive: true });
        // Ownership is the first durable write. A crash can leave an owned,
        // retryable shell, never an anonymous recovered directory.
        await writeMeta(meta);
        created = true;
      }

      let dirty = false;
      for (const requested of requestedClips) {
        if (!meta.clips.some((clip) => clip.id === requested.id)) {
          meta.clips.push(requested);
          dirty = true;
        }
        await mkdir(clipDir(id, requested.id), { recursive: true });
        if (!existsSync(clipDataPath(id, requested.id))) {
          await writeJson(clipDataPath(id, requested.id), {});
        }
      }
      const projectDataPath = path.join(projDir(id), "data.json");
      if (!existsSync(projectDataPath)) await writeJson(projectDataPath, {});
      if (dirty) {
        meta.updatedAt = Date.now();
        await writeMeta(meta);
      }
      if (created) bumpUsage(user.username, { projectsCreated: 1 });
      return c.json({ id, revision: meta.revision ?? 0, created });
    });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : String(error) },
      500,
    );
  }
});

/* create project: raw video body → first clip's compressed proxy.
   The client may pre-assign the clip id (?clipId=) so its local state
   needs no remap when the upload lands. */
projectsApp.post("/", async (c) => {
  const body = c.req.raw.body;
  if (!body) return c.json({ error: "No video body" }, 400);
  const name = (c.req.query("name") || "untitled").slice(0, 120);
  const clipName = (c.req.query("clip") || name).slice(0, 120);
  const reqClipId = c.req.query("clipId") ?? "";
  const id = randomUUID();
  const clipId = okId(reqClipId) ? reqClipId : randomUUID();
  const dir = projDir(id);
  const cdir = clipDir(id, clipId);
  const src = path.join(cdir, "src.tmp");
  const meta: Meta = {
    id,
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    duration: 0,
    owner: c.get("user").username,
    clips: [{ id: clipId, name: clipName, duration: 0, createdAt: Date.now() }],
  };
  try {
    await mkdir(cdir, { recursive: true });
    // Older cached clients still use this one-shot endpoint. Register the
    // owned shell before reading the request body so a timeout cannot create
    // an anonymous directory that later shows up as "recovered".
    await writeJson(path.join(dir, "data.json"), {});
    await writeJson(clipDataPath(id, clipId), {});
    await writeMeta(meta);
    await pipeline(Readable.fromWeb(body as never), createWriteStream(src));
    // register the project before the transcode so it shows up in the
    // project list right away — big clips can take minutes to proxy
    const probe = await ingestClip(src, cdir);
    meta.clips[0].srcWidth = probe.srcWidth;
    meta.clips[0].srcHeight = probe.srcHeight;
    if (probe.srcFps) meta.clips[0].srcFps = probe.srcFps;
    await writeMeta(meta);
    bumpUsage(meta.owner!, { projectsCreated: 1 });
    return c.json({
      id,
      clipId,
      srcWidth: probe.srcWidth,
      srcHeight: probe.srcHeight,
      ...(probe.srcFps ? { srcFps: probe.srcFps } : {}),
    });
  } catch (e) {
    // Keep the registered shell. It is owned and visible, and any transcript
    // already written to it must survive even when this legacy upload fails.
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  } finally {
    await rm(src, { force: true }).catch(() => {});
  }
});

/* add a clip to an existing project's pool */
projectsApp.post("/:id/clips", async (c) => {
  const id = c.req.param("id");
  const meta = await ownedMeta(id, c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  const body = c.req.raw.body;
  if (!body) return c.json({ error: "No video body" }, 400);
  const clipName = (c.req.query("name") || "clip").slice(0, 120);
  const reqClipId = c.req.query("clipId") ?? "";
  const clipId = okId(reqClipId) ? reqClipId : randomUUID();
  if (meta.clips.some((x) => x.id === clipId)) {
    return c.json({ error: "Clip already exists" }, 409);
  }
  const cdir = clipDir(id, clipId);
  const src = path.join(cdir, "src.tmp");
  try {
    await mkdir(cdir, { recursive: true });
    await pipeline(Readable.fromWeb(body as never), createWriteStream(src));
    // register the clip before the transcode so the pool reflects it
    // immediately (proxy generation can take minutes on big clips)
    const cm: ClipMeta = {
      id: clipId,
      name: clipName,
      duration: 0,
      createdAt: Date.now(),
    };
    meta.clips.push(cm);
    meta.updatedAt = Date.now();
    await writeMeta(meta);
    const probe = await ingestClip(src, cdir);
    cm.srcWidth = probe.srcWidth;
    cm.srcHeight = probe.srcHeight;
    if (probe.srcFps) cm.srcFps = probe.srcFps;
    await writeMeta(meta);
    return c.json({
      clipId,
      srcWidth: probe.srcWidth,
      srcHeight: probe.srcHeight,
      ...(probe.srcFps ? { srcFps: probe.srcFps } : {}),
    });
  } catch (e) {
    // roll back both the files and the registry entry
    meta.clips = meta.clips.filter((x) => x.id !== clipId);
    await writeMeta(meta).catch(() => {});
    await rm(cdir, { recursive: true, force: true }).catch(() => {});
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  } finally {
    await rm(src, { force: true }).catch(() => {});
  }
});

/*
 * Versioned, idempotent editor sync. `mutationId` makes a response-lost retry
 * safe; `baseRevision` stops one tab/device silently overwriting another.
 */
projectsApp.put("/:id/sync", async (c) => {
  const id = c.req.param("id");
  if (!okId(id)) return c.json({ error: "Not found" }, 404);
  let body: {
    baseRevision?: unknown;
    mutationId?: unknown;
    snapshot?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const baseRevision = body.baseRevision;
  const mutationId = body.mutationId;
  if (
    !Number.isSafeInteger(baseRevision) ||
    (baseRevision as number) < 0 ||
    typeof mutationId !== "string" ||
    mutationId.length < 8 ||
    mutationId.length > 100 ||
    !body.snapshot ||
    typeof body.snapshot !== "object" ||
    Array.isArray(body.snapshot)
  ) {
    return c.json({ error: "Invalid sync request" }, 400);
  }
  const user = c.get("user");
  return withProjectWrite(id, async () => {
    const meta = await ownedMeta(id, user);
    if (!meta) return c.json({ error: "Not found" }, 404);
    const revision = meta.revision ?? 0;
    if (meta.lastMutationId === mutationId) {
      return c.json({ ok: true, revision, updatedAt: meta.updatedAt });
    }
    if (revision !== baseRevision) {
      return c.json(
        {
          error: "Project changed on another tab or device",
          code: "REVISION_CONFLICT",
          revision,
        },
        409,
      );
    }
    try {
      await applyProjectUpdate(id, meta, body.snapshot as ProjectUpdate);
      meta.revision = revision + 1;
      meta.lastMutationId = mutationId;
      await writeMeta(meta);
      return c.json({
        ok: true,
        revision: meta.revision,
        updatedAt: meta.updatedAt,
      });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  });
});

/* Compatibility autosave for older cached clients. New clients use /sync. */
projectsApp.put("/:id", async (c) => {
  const id = c.req.param("id");
  if (!okId(id)) return c.json({ error: "Not found" }, 404);
  let data: ProjectUpdate;
  try {
    data = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const user = c.get("user");
  return withProjectWrite(id, async () => {
    const meta = await ownedMeta(id, user);
    if (!meta) return c.json({ error: "Not found" }, 404);
    try {
      await applyProjectUpdate(id, meta, data);
      meta.revision = (meta.revision ?? 0) + 1;
      delete meta.lastMutationId;
      await writeMeta(meta);
      return c.json({ ok: true, revision: meta.revision });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  });
});

/* rename a project — touches meta.json only, data.json stays intact */
projectsApp.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const meta = await ownedMeta(id, c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  let body: { name?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  if (typeof body.name !== "string" || !body.name.trim()) {
    return c.json({ error: "Invalid name" }, 400);
  }
  meta.name = body.name.trim().slice(0, 120);
  meta.updatedAt = Date.now();
  await writeMeta(meta);
  return c.json({ ok: true, name: meta.name });
});

/* Duplicate editor state into the admin's library; video stays on the source. Hosted mode only. */
projectsApp.post("/:id/copy", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  if (!hostedMode() || user.role !== "admin") return c.json({ error: "Forbidden" }, 403);
  const meta = await ownedMeta(id, user);
  if (!meta) return c.json({ error: "Not found" }, 404);

  const newId = randomUUID();
  const now = Date.now();
  const name = copyProjectName(meta.name);
  try {
    await withProjectWrite(id, async () => {
      const current = await readMeta(id);
      if (!current || current.deletedAt) throw new Error("Not found");
      await mkdir(path.join(projDir(newId), "clips"), { recursive: true });
      await copyIfExists(path.join(projDir(id), "data.json"), path.join(projDir(newId), "data.json"));
      const clips: ClipMeta[] = [];
      for (const clip of current.clips) {
        await mkdir(clipDir(newId, clip.id), { recursive: true });
        await copyIfExists(clipDataPath(id, clip.id), clipDataPath(newId, clip.id));
        const { objectUpload: _ignored, ...rest } = clip;
        clips.push({ ...rest, mediaProjectId: mediaOwnerProjectId(id, clip) });
      }
      await writeMeta({
        ...current,
        id: newId,
        name,
        owner: user.username,
        createdAt: now,
        updatedAt: now,
        revision: 0,
        lastMutationId: undefined,
        deletedAt: undefined,
        incompleteRecovery: undefined,
        clips,
      });
    });
    bumpUsage(user.username, { projectsCreated: 1 });
    return c.json({ id: newId, name });
  } catch (error) {
    await rm(projDir(newId), { recursive: true, force: true }).catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    if (message === "Not found") return c.json({ error: "Not found" }, 404);
    return c.json({ error: message }, 500);
  }
});

/* load a session: project settings + every clip with its editor state */
projectsApp.get("/:id", async (c) => {
  const id = c.req.param("id");
  const meta = await ownedMeta(id, c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  const projData = await readProjectData(id);
  let metaDirty = false;
  const clips = await Promise.all(
    meta.clips.map(async (cm) => {
      let clipData: Record<string, unknown> = {};
      try {
        clipData = JSON.parse(await readFile(clipDataPath(id, cm.id), "utf-8"));
      } catch {
        // clip uploaded but never saved — still loadable (video only)
      }
      const home = mediaHome(id, cm);
      // older clips predate srcWidth/srcFps — backfill from what's kept
      if (!cm.srcWidth && existsSync(clipOriginalPath(home, cm.id))) {
        const dims = await probeDims(clipOriginalPath(home, cm.id));
        if (dims.width) {
          cm.srcWidth = dims.width;
          cm.srcHeight = dims.height;
          metaDirty = true;
        }
      }
      if (!cm.srcFps) {
        // the proxy transcode keeps the source timing, so it can stand in
        // for fps once the original has been freed from the server
        const src = existsSync(clipOriginalPath(home, cm.id))
          ? clipOriginalPath(home, cm.id)
          : clipProxyPath(home, cm.id);
        if (existsSync(src)) {
          const fps = await probeFps(src);
          if (fps) {
            cm.srcFps = fps;
            metaDirty = true;
          }
        }
      }
      return { ...cm, ...clipData, ...clipOriginalInfo(id, cm.id, cm) };
    }),
  );
  if (metaDirty) await writeMeta(meta);
  return c.json({
    id: meta.id,
    name: meta.name,
    revision: meta.revision ?? 0,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    duration: meta.duration,
    fps: projData.fps ?? null,
    model: projData.model ?? null,
    autoCadence: projData.autoCadence ?? null,
    script: projData.script ?? "",
    clips,
    ...(captioning.has(id) ? { captioning: captioning.get(id) } : {}),
  });
});

/* Register an added clip immediately, independently of its source upload. */
projectsApp.post("/:id/clips/draft", async (c) => {
  const id = c.req.param("id");
  let body: { id?: unknown; name?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const clipId = typeof body.id === "string" ? body.id : "";
  if (!okId(clipId)) return c.json({ error: "Invalid clip" }, 400);
  return withProjectWrite(id, async () => {
    const meta = await ownedMeta(id, c.get("user"));
    if (!meta) return c.json({ error: "Not found" }, 404);
    if (!meta.clips.some((entry) => entry.id === clipId)) {
      meta.clips.push({
        id: clipId,
        name:
          typeof body.name === "string" && body.name.trim()
            ? body.name.trim().slice(0, 120)
            : `Clip ${meta.clips.length + 1}`,
        duration: 0,
        createdAt: Date.now(),
      });
      meta.updatedAt = Date.now();
      await mkdir(clipDir(id, clipId), { recursive: true });
      await writeJson(clipDataPath(id, clipId), {});
      await writeMeta(meta);
    }
    return c.json({ ok: true, revision: meta.revision ?? 0 });
  });
});

/* remove a clip from the pool (its exports stay — they're job-bound) */
projectsApp.delete("/:id/clips/:clipId", async (c) => {
  const id = c.req.param("id");
  const clipId = c.req.param("clipId");
  if (!okId(clipId)) return c.json({ error: "Not found" }, 404);
  const meta = await ownedMeta(id, c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  const clip = meta.clips.find((entry) => entry.id === clipId);
  if (!clip) return c.json({ error: "Not found" }, 404);
  if (clip.objectUpload) {
    await abortSourceMultipart(
      clip.objectUpload.key,
      clip.objectUpload.id,
    ).catch(() => {});
  }
  if (clip.originalObjectKey && clipOwnsStoredSource(id, clip)) {
    await deleteStoredSource(clip.originalObjectKey).catch((error) =>
      console.error(`[projects] object delete ${id}/${clipId} failed:`, error),
    );
  }
  meta.clips = meta.clips.filter((x) => x.id !== clipId);
  meta.updatedAt = Date.now();
  await rm(clipDir(id, clipId), { recursive: true, force: true });
  await writeMeta(meta);
  return c.json({ ok: true });
});

/* Direct-to-object-storage multipart upload. The app server signs requests;
   video bytes go browser → object storage and never traverse Node/reverse proxy. */
projectsApp.post("/:id/clips/:clipId/original/multipart", async (c) => {
  const id = c.req.param("id");
  const clipId = c.req.param("clipId");
  if (!okId(id) || !okId(clipId)) return c.json({ error: "Not found" }, 404);
  let body: { size?: unknown; contentType?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const size = Number(body.size);
  if (!Number.isSafeInteger(size) || size <= 0 || size > 100 * 1024 ** 3) {
    return c.json({ error: "Invalid source size" }, 400);
  }
  const contentType =
    typeof body.contentType === "string" && body.contentType.length <= 200
      ? body.contentType
      : "application/octet-stream";
  const user = c.get("user");
  if (!objectStorageEnabled()) {
    const meta = await ownedMeta(id, user);
    if (!meta?.clips.some((entry) => entry.id === clipId)) {
      return c.json({ error: "Not found" }, 404);
    }
    return c.json({ mode: "legacy" });
  }
  return withProjectWrite(id, async () => {
    const meta = await ownedMeta(id, user);
    const clip = meta?.clips.find((entry) => entry.id === clipId);
    if (!meta || !clip) return c.json({ error: "Not found" }, 404);
    if (clip.originalObjectKey) {
      return c.json({
        mode: "object",
        complete: true,
        size: clip.originalBytes ?? size,
      });
    }
    const key = sourceObjectKey(id, clipId);
    const partSize = sourceMultipartPartSize(size);
    let upload = clip.objectUpload;
    if (upload && (upload.size !== size || upload.key !== key)) {
      await abortSourceMultipart(upload.key, upload.id).catch(() => {});
      upload = undefined;
    }
    let parts = [] as Awaited<ReturnType<typeof listSourceParts>>;
    if (upload) {
      try {
        parts = await listSourceParts(upload.key, upload.id);
      } catch {
        await abortSourceMultipart(upload.key, upload.id).catch(() => {});
        upload = undefined;
      }
    }
    if (!upload) {
      upload = {
        id: await createSourceMultipart(key, contentType),
        key,
        size,
        contentType,
        partSize,
      };
      clip.objectUpload = upload;
      meta.updatedAt = Date.now();
      await writeMeta(meta);
    }
    return c.json({
      mode: "object",
      complete: false,
      uploadId: upload.id,
      partSize: upload.partSize ?? partSize,
      uploadedParts: parts.map((part) => ({
        partNumber: part.partNumber,
        size: part.size,
      })),
    });
  });
});

projectsApp.post("/:id/clips/:clipId/original/multipart/part", async (c) => {
  const id = c.req.param("id");
  const clipId = c.req.param("clipId");
  let body: { uploadId?: unknown; partNumber?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const partNumber = Number(body.partNumber);
  const uploadId = typeof body.uploadId === "string" ? body.uploadId : "";
  if (
    !okId(id) ||
    !okId(clipId) ||
    !Number.isSafeInteger(partNumber) ||
    partNumber < 1 ||
    partNumber > 10_000
  ) {
    return c.json({ error: "Invalid upload part" }, 400);
  }
  const meta = await ownedMeta(id, c.get("user"));
  const upload = meta?.clips.find((entry) => entry.id === clipId)?.objectUpload;
  if (!upload || upload.id !== uploadId) {
    return c.json(
      { error: "Upload session expired", code: "UPLOAD_EXPIRED" },
      409,
    );
  }
  const partSize = upload.partSize ?? sourceMultipartPartSize(upload.size);
  if (partNumber > Math.ceil(upload.size / partSize)) {
    return c.json({ error: "Invalid upload part" }, 400);
  }
  try {
    return c.json({
      url: await presignSourcePart(upload.key, upload.id, partNumber),
    });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : String(error) },
      502,
    );
  }
});

projectsApp.post(
  "/:id/clips/:clipId/original/multipart/complete",
  async (c) => {
    const id = c.req.param("id");
    const clipId = c.req.param("clipId");
    let body: { uploadId?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const uploadId = typeof body.uploadId === "string" ? body.uploadId : "";
    if (!okId(id) || !okId(clipId) || !uploadId) {
      return c.json({ error: "Invalid upload" }, 400);
    }
    const user = c.get("user");
    return withProjectWrite(id, async () => {
      const meta = await ownedMeta(id, user);
      const clip = meta?.clips.find((entry) => entry.id === clipId);
      if (!meta || !clip) return c.json({ error: "Not found" }, 404);
      if (clip.originalObjectKey) {
        return c.json({
          complete: true,
          hasOriginal: true,
          originalBytes: clip.originalBytes ?? 0,
        });
      }
      const upload = clip.objectUpload;
      if (!upload || upload.id !== uploadId) {
        return c.json(
          { error: "Upload session expired", code: "UPLOAD_EXPIRED" },
          409,
        );
      }
      try {
        const parts = await listSourceParts(upload.key, upload.id);
        const uploadedBytes = parts.reduce(
          (total, part) => total + part.size,
          0,
        );
        if (!parts.length || uploadedBytes !== upload.size) {
          return c.json(
            {
              error: "Source upload is incomplete",
              uploadedBytes,
              expectedBytes: upload.size,
            },
            409,
          );
        }
        await completeSourceMultipart(upload.key, upload.id, parts);
        clip.originalObjectKey = upload.key;
        clip.originalBytes = upload.size;
        delete clip.objectUpload;
        meta.updatedAt = Date.now();
        await writeMeta(meta);
        void cacheObjectSourceAndBuildProxy(id, clipId, upload.key).catch(
          (error) =>
            console.error(
              `[projects] object proxy ${id}/${clipId} failed:`,
              error,
            ),
        );
        return c.json({
          complete: true,
          hasOriginal: true,
          originalBytes: upload.size,
          proxyReady: existsSync(clipProxyPath(id, clipId)),
        });
      } catch (error) {
        return c.json(
          { error: error instanceof Error ? error.message : String(error) },
          502,
        );
      }
    });
  },
);

/* Current resumable-upload position and source/proxy readiness. */
projectsApp.get("/:id/clips/:clipId/original/status", async (c) => {
  const id = c.req.param("id");
  const clipId = c.req.param("clipId");
  if (!okId(clipId)) return c.json({ error: "Not found" }, 404);
  const meta = await ownedMeta(id, c.get("user"));
  if (!meta || !meta.clips.some((entry) => entry.id === clipId)) {
    return c.json({ error: "Not found" }, 404);
  }
  const clip = meta.clips.find((entry) => entry.id === clipId)!;
  const original = clipOriginalInfo(id, clipId, clip);
  let offset = 0;
  try {
    offset = (await stat(clipUploadPath(id, clipId))).size;
  } catch {
    /* no partial upload */
  }
  return c.json({
    offset: original.hasOriginal ? original.originalBytes : offset,
    complete: original.hasOriginal,
    proxyReady: existsSync(clipProxyPath(id, clipId)),
    ...original,
    srcWidth: clip.srcWidth ?? 0,
    srcHeight: clip.srcHeight ?? 0,
    srcFps: clip.srcFps ?? 0,
  });
});

/*
 * Append one bounded chunk. Each request is short enough to survive reverse-
 * proxy timeouts; the .upload file remains on disk across retries/restarts.
 */
projectsApp.post("/:id/clips/:clipId/original/chunk", async (c) => {
  const id = c.req.param("id");
  const clipId = c.req.param("clipId");
  if (!okId(clipId)) return c.json({ error: "Not found" }, 404);
  const meta = await ownedMeta(id, c.get("user"));
  if (!meta || !meta.clips.some((entry) => entry.id === clipId)) {
    return c.json({ error: "Not found" }, 404);
  }
  const body = c.req.raw.body;
  if (!body) return c.json({ error: "No video body" }, 400);
  const requestedOffset = Number(c.req.header("upload-offset"));
  const total = Number(c.req.header("upload-length"));
  const contentLength = Number(c.req.header("content-length"));
  if (
    !Number.isSafeInteger(requestedOffset) ||
    requestedOffset < 0 ||
    !Number.isSafeInteger(total) ||
    total <= 0 ||
    total > 100 * 1024 ** 3 ||
    !Number.isSafeInteger(contentLength) ||
    contentLength <= 0 ||
    contentLength > 32 * 1024 ** 2
  ) {
    return c.json({ error: "Invalid upload range" }, 400);
  }
  const clip = meta.clips.find((entry) => entry.id === clipId)!;
  const original = clipOriginalInfo(id, clipId, clip);
  if (original.hasOriginal) {
    return c.json({
      offset: original.originalBytes,
      complete: true,
      ...original,
    });
  }
  const part = clipUploadPath(id, clipId);
  let offset = 0;
  try {
    offset = (await stat(part)).size;
  } catch {
    /* first chunk */
  }
  if (offset !== requestedOffset) {
    return c.json({ error: "Upload offset changed", offset }, 409);
  }
  if (offset + contentLength > total) {
    return c.json({ error: "Chunk exceeds upload length", offset }, 400);
  }
  try {
    await pipeline(
      Readable.fromWeb(body as never),
      createWriteStream(part, { flags: "a" }),
    );
    const nextOffset = (await stat(part)).size;
    if (nextOffset > total) {
      await rm(part, { force: true });
      return c.json({ error: "Upload length mismatch", offset: 0 }, 400);
    }
    if (nextOffset === total) {
      await rename(part, clipOriginalPath(id, clipId));
      // The transcript autosave may have updated meta.json while this chunk
      // was streaming. Re-read it now so upload completion never writes an
      // older project name/order/duration back over newer editor state.
      const latestMeta = await ownedMeta(id, c.get("user"));
      if (latestMeta) {
        latestMeta.updatedAt = Date.now();
        await writeMeta(latestMeta);
      }
      void buildProxyFromOriginal(id, clipId).catch((error) =>
        console.error(`[projects] proxy ${id}/${clipId} failed:`, error),
      );
      return c.json({
        offset: total,
        complete: true,
        ...clipOriginalInfo(
          id,
          clipId,
          latestMeta?.clips.find((entry) => entry.id === clipId),
        ),
      });
    }
    return c.json({ offset: nextOffset, complete: false });
  } catch (error) {
    let currentOffset = offset;
    try {
      currentOffset = (await stat(part)).size;
    } catch {
      /* retain the last known offset */
    }
    return c.json(
      {
        error: error instanceof Error ? error.message : String(error),
        offset: currentOffset,
      },
      500,
    );
  }
});

/*
 * Parallel multipart upload (offset-addressed parts). Unlike the sequential
 * append route above, each part is independently durable and idempotent, so
 * the browser can send several parts concurrently and resume after any
 * interruption by re-reading the part list.
 */
projectsApp.get("/:id/clips/:clipId/original/parts", async (c) => {
  const id = c.req.param("id");
  const clipId = c.req.param("clipId");
  if (!okId(clipId)) return c.json({ error: "Not found" }, 404);
  const meta = await ownedMeta(id, c.get("user"));
  if (!meta || !meta.clips.some((entry) => entry.id === clipId)) {
    return c.json({ error: "Not found" }, 404);
  }
  const clip = meta.clips.find((entry) => entry.id === clipId)!;
  const original = clipOriginalInfo(id, clipId, clip);
  const state = await readPartsUploadState(id, clipId);
  const received: { partNumber: number; size: number }[] = [];
  if (state) {
    const entries = await readdir(clipPartsDir(id, clipId)).catch(() => []);
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const st = await stat(path.join(clipPartsDir(id, clipId), entry));
        received.push({ partNumber: Number(entry), size: st.size });
      } catch {
        /* part vanished mid-listing — treated as not received */
      }
    }
  }
  return c.json({
    partSize: state?.partSize ?? null,
    total: state?.total ?? null,
    received,
    complete: original.hasOriginal,
    ...original,
  });
});

projectsApp.post("/:id/clips/:clipId/original/parts/:partNumber", async (c) => {
  const id = c.req.param("id");
  const clipId = c.req.param("clipId");
  const partNumber = Number(c.req.param("partNumber"));
  if (
    !okId(clipId) ||
    !Number.isSafeInteger(partNumber) ||
    partNumber < 1 ||
    partNumber > 10_000
  ) {
    return c.json({ error: "Invalid part" }, 400);
  }
  const meta = await ownedMeta(id, c.get("user"));
  if (!meta || !meta.clips.some((entry) => entry.id === clipId)) {
    return c.json({ error: "Not found" }, 404);
  }
  const clip = meta.clips.find((entry) => entry.id === clipId)!;
  const original = clipOriginalInfo(id, clipId, clip);
  if (original.hasOriginal) {
    return c.json({ ok: true, complete: true, ...original });
  }
  const body = c.req.raw.body;
  if (!body) return c.json({ error: "No body" }, 400);
  const total = Number(c.req.header("upload-length"));
  const partSize = Number(c.req.header("upload-part-size"));
  const contentLength = Number(c.req.header("content-length"));
  if (
    !Number.isSafeInteger(total) ||
    total <= 0 ||
    total > 100 * 1024 ** 3 ||
    !Number.isSafeInteger(partSize) ||
    partSize <= 0 ||
    partSize > 32 * 1024 ** 2 ||
    !Number.isSafeInteger(contentLength) ||
    contentLength <= 0 ||
    contentLength > 32 * 1024 ** 2
  ) {
    return c.json({ error: "Invalid upload range" }, 400);
  }
  if (partNumber > partCount(total, partSize)) {
    return c.json({ error: "Invalid part" }, 400);
  }
  if (contentLength !== expectedPartSize(total, partSize, partNumber)) {
    return c.json({ error: "Part size mismatch" }, 400);
  }
  const dir = clipPartsDir(id, clipId);
  await mkdir(dir, { recursive: true });
  const state = await readPartsUploadState(id, clipId);
  if (state && (state.total !== total || state.partSize !== partSize)) {
    return c.json(
      { error: "Upload layout changed", code: "UPLOAD_CHANGED" },
      409,
    );
  }
  if (!state) {
    await writeJson(clipPartsStatePath(id, clipId), { total, partSize });
  }
  const finalPath = path.join(dir, String(partNumber));
  const tmpPath = `${finalPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await pipeline(Readable.fromWeb(body as never), createWriteStream(tmpPath));
    const written = (await stat(tmpPath)).size;
    if (written !== contentLength) {
      await rm(tmpPath, { force: true });
      return c.json({ error: "Part length mismatch" }, 400);
    }
    // Atomic per-part commit: a re-sent part simply replaces the old one.
    await rename(tmpPath, finalPath);
    return c.json({ ok: true, partNumber, size: written });
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    return c.json(
      { error: error instanceof Error ? error.message : String(error) },
      500,
    );
  }
});

projectsApp.post("/:id/clips/:clipId/original/complete", async (c) => {
  const id = c.req.param("id");
  const clipId = c.req.param("clipId");
  if (!okId(clipId)) return c.json({ error: "Not found" }, 404);
  const meta = await ownedMeta(id, c.get("user"));
  if (!meta || !meta.clips.some((entry) => entry.id === clipId)) {
    return c.json({ error: "Not found" }, 404);
  }
  const clip = meta.clips.find((entry) => entry.id === clipId)!;
  const existing = clipOriginalInfo(id, clipId, clip);
  if (existing.hasOriginal) {
    return c.json({ ok: true, complete: true, ...existing });
  }
  const state = await readPartsUploadState(id, clipId);
  if (!state) {
    return c.json({ error: "No multipart upload in progress" }, 409);
  }
  const count = partCount(state.total, state.partSize);
  for (let n = 1; n <= count; n++) {
    const expected = expectedPartSize(state.total, state.partSize, n);
    const st = await stat(path.join(clipPartsDir(id, clipId), String(n))).catch(
      () => null,
    );
    if (!st || st.size !== expected) {
      return c.json({ error: `Part ${n} is missing or incomplete` }, 409);
    }
  }
  const dir = clipPartsDir(id, clipId);
  const outTmp = `${clipOriginalPath(id, clipId)}.assemble-${process.pid}-${randomUUID()}`;
  try {
    const out = createWriteStream(outTmp);
    for (let n = 1; n <= count; n++) {
      await pipeline(createReadStream(path.join(dir, String(n))), out, {
        end: false,
      });
    }
    await new Promise<void>((resolve, reject) =>
      out.end((error: Error | null | undefined) =>
        error ? reject(error) : resolve(),
      ),
    );
    const finalSize = (await stat(outTmp)).size;
    if (finalSize !== state.total) {
      throw new Error(`Assembled size ${finalSize} != ${state.total}`);
    }
    await rename(outTmp, clipOriginalPath(id, clipId));
    await rm(dir, { recursive: true, force: true });
    // Mirror the append route: re-read meta so concurrent autosaves win, and
    // build the editing proxy off the request path.
    const latestMeta = await ownedMeta(id, c.get("user"));
    if (latestMeta) {
      latestMeta.updatedAt = Date.now();
      await writeMeta(latestMeta);
    }
    void buildProxyFromOriginal(id, clipId).catch((error) =>
      console.error(`[projects] proxy ${id}/${clipId} failed:`, error),
    );
    return c.json({
      ok: true,
      complete: true,
      ...clipOriginalInfo(
        id,
        clipId,
        latestMeta?.clips.find((entry) => entry.id === clipId),
      ),
    });
  } catch (error) {
    await rm(outTmp, { force: true }).catch(() => {});
    return c.json(
      { error: error instanceof Error ? error.message : String(error) },
      500,
    );
  }
});

/* re-attach a clip's source video (enables burned-in export again) */
projectsApp.post("/:id/clips/:clipId/original", async (c) => {
  const id = c.req.param("id");
  const clipId = c.req.param("clipId");
  if (!okId(clipId)) return c.json({ error: "Not found" }, 404);
  const meta = await ownedMeta(id, c.get("user"));
  if (!meta || !meta.clips.some((x) => x.id === clipId)) {
    return c.json({ error: "Not found" }, 404);
  }
  const body = c.req.raw.body;
  if (!body) return c.json({ error: "No video body" }, 400);
  const tmp = clipOriginalPath(id, clipId) + ".part";
  try {
    await pipeline(Readable.fromWeb(body as never), createWriteStream(tmp));
    await rename(tmp, clipOriginalPath(id, clipId));
    return c.json({
      ok: true,
      ...clipOriginalInfo(
        id,
        clipId,
        meta.clips.find((entry) => entry.id === clipId),
      ),
    });
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

/* free up space: drop the source, keep the clip fully editable */
projectsApp.delete("/:id/clips/:clipId/original", async (c) => {
  const id = c.req.param("id");
  const clipId = c.req.param("clipId");
  if (!okId(clipId)) return c.json({ error: "Not found" }, 404);
  const meta = await ownedMeta(id, c.get("user"));
  const clip = meta?.clips.find((entry) => entry.id === clipId);
  if (!meta || !clip) {
    return c.json({ error: "Not found" }, 404);
  }
  if (clip.objectUpload) {
    await abortSourceMultipart(
      clip.objectUpload.key,
      clip.objectUpload.id,
    ).catch(() => {});
    delete clip.objectUpload;
  }
  if (clip.originalObjectKey && clipOwnsStoredSource(id, clip)) {
    await deleteStoredSource(clip.originalObjectKey);
  }
  if (clip.originalObjectKey) {
    delete clip.originalObjectKey;
    delete clip.originalBytes;
  }
  delete clip.mediaProjectId;
  await rm(clipOriginalPath(id, clipId), { force: true });
  await rm(clipUploadPath(id, clipId), { force: true });
  await rm(clipPartsDir(id, clipId), { recursive: true, force: true });
  meta.updatedAt = Date.now();
  await writeMeta(meta);
  return c.json({ ok: true });
});

/* burn captions into the clip's source video → social-ready MP4 */
projectsApp.post("/:id/clips/:clipId/render", async (c) => {
  const id = c.req.param("id");
  const clipId = c.req.param("clipId");
  if (!okId(clipId)) return c.json({ error: "Not found" }, 404);
  const user = c.get("user");
  const meta = await ownedMeta(id, user);
  const clip = meta?.clips.find((entry) => entry.id === clipId);
  if (!meta || !clip) {
    return c.json({ error: "Not found" }, 404);
  }
  const home = mediaHome(id, clip);
  const source = await ensureProjectOriginal(
    id,
    clipId,
    clipOriginalPath(home, clipId),
  );
  if (!source) {
    return c.json(
      { error: "Source video is not on the server", code: "NO_ORIGINAL" },
      409,
    );
  }
  let body: { ass?: string; format?: string; crf?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const { ass, format = "h264" } = body;
  if (typeof ass !== "string" || !ass.length || ass.length > 5_000_000) {
    return c.json({ error: "Invalid ASS payload" }, 400);
  }
  if (format !== "h264" && format !== "h265") {
    return c.json({ error: "Unsupported format" }, 400);
  }

  const dir = await mkdtemp(path.join(tmpdir(), "capburn-"));
  const assPath = path.join(dir, "captions.ass");
  const outPath = path.join(dir, "captioned.mp4");
  try {
    await writeFile(assPath, ass, "utf-8");
    const fontsOpt = `:fontsdir='${filterEscape(requireFontsDir())}'`;
    const vf = `ass='${filterEscape(assPath)}'${fontsOpt}`;
    const codec =
      format === "h265"
        ? [
            "-c:v",
            "libx265",
            "-preset",
            "medium",
            "-crf",
            String(body.crf ?? 22),
            "-tag:v",
            "hvc1",
          ]
        : [
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            String(body.crf ?? 19),
          ];
    await run("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      source,
      "-vf",
      vf,
      ...codec,
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      outPath,
    ]);
    const st = await stat(outPath);
    bumpUsage(user.username, { renders: 1 });
    const nodeStream = createReadStream(outPath);
    nodeStream.on("close", () => {
      rm(dir, { recursive: true, force: true }).catch(() => {});
    });
    return new Response(
      Readable.toWeb(nodeStream) as unknown as ReadableStream,
      {
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": String(st.size),
          "Content-Disposition": `attachment; filename="captioned.mp4"`,
        },
      },
    );
  } catch (e) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

/* clip thumbnail for the project picker — generated on ingest, lazily
   backfilled from the proxy for older projects */
projectsApp.get("/:id/clips/:clipId/thumb", async (c) => {
  const id = c.req.param("id");
  const clipId = c.req.param("clipId");
  if (!okId(clipId)) return c.json({ error: "Not found" }, 404);
  const meta = await ownedMeta(id, c.get("user"));
  if (!meta || !meta.clips.some((x) => x.id === clipId)) {
    return c.json({ error: "Not found" }, 404);
  }
  const clip = meta.clips.find((entry) => entry.id === clipId)!;
  const home = mediaHome(id, clip);
  const thumb = path.join(clipDir(id, clipId), "thumb.jpg");
  const sharedThumb = path.join(clipDir(home, clipId), "thumb.jpg");
  if (!existsSync(thumb) && home !== id && existsSync(sharedThumb)) {
    return new Response(new Uint8Array(await readFile(sharedThumb)), {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  }
  if (!existsSync(thumb)) {
    const src = existsSync(clipOriginalPath(home, clipId))
      ? clipOriginalPath(home, clipId)
      : clipProxyPath(home, clipId);
    if (existsSync(src)) await makeThumb(src, thumb).catch(() => {});
  }
  if (!existsSync(thumb)) return c.json({ error: "Not found" }, 404);
  const img = await readFile(thumb);
  return new Response(new Uint8Array(img), {
    headers: {
      "Content-Type": "image/jpeg",
      // a clip's thumbnail is generated once and never changes
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Length": String(img.length),
    },
  });
});

/* stream a clip's proxy video (range-aware so seeking works). Ranges are
   served as buffered slices, not piped streams — Chrome's media stack
   stalls at HAVE_METADATA on web-stream responses bridged through the
   dev server (bytes buffer but the first frame never decodes). Proxies
   are small 480p files, so slice reads are cheap. */
projectsApp.get("/:id/clips/:clipId/video", async (c) => {
  const id = c.req.param("id");
  const clipId = c.req.param("clipId");
  if (!okId(clipId)) return c.json({ error: "Not found" }, 404);
  const meta = await ownedMeta(id, c.get("user"));
  const clip = meta?.clips.find((x) => x.id === clipId);
  const p = clip ? clipProxyPath(mediaHome(id, clip), clipId) : "";
  if (!meta || !clip || !existsSync(p)) {
    return c.json({ error: "Not found" }, 404);
  }
  const st = statSync(p);
  const size = st.size;
  const range = c.req.header("range");
  // strong validators matter: Chrome's media cache stitches range
  // responses together only when it can validate them — without an
  // ETag/Last-Modified the demuxer can stall and never decode a frame
  const base = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    "Last-Modified": new Date(st.mtimeMs).toUTCString(),
    ETag: `"${size}-${Math.floor(st.mtimeMs)}"`,
  };
  const slice = (start: number, end: number): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      createReadStream(p, { start, end })
        .on("data", (d) => chunks.push(d as Buffer))
        .on("end", () => resolve(Buffer.concat(chunks)))
        .on("error", reject);
    });
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m?.[1] ? parseInt(m[1], 10) : 0;
    const end = Math.min(m?.[2] ? parseInt(m[2], 10) : size - 1, size - 1);
    if (start >= size || start > end) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }
    const body = await slice(start, end);
    return new Response(new Uint8Array(body), {
      status: 206,
      headers: {
        ...base,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }
  const body = await slice(0, size - 1);
  return new Response(new Uint8Array(body), {
    headers: { ...base, "Content-Length": String(size) },
  });
});

/* Move a project to recoverable trash; the sweep hard-deletes it after 5d. */
projectsApp.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const meta = await ownedMeta(id, c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  meta.deletedAt = Date.now();
  meta.updatedAt = meta.deletedAt;
  await writeMeta(meta);
  return c.json({
    ok: true,
    recoverableUntil: meta.deletedAt + TRASH_KEEP_MS,
  });
});

projectsApp.post("/:id/restore", async (c) => {
  const id = c.req.param("id");
  if (!okId(id)) return c.json({ error: "Not found" }, 404);
  const meta = await readMeta(id);
  if (!meta || !meta.deletedAt || !canAccess(meta, c.get("user"))) {
    return c.json({ error: "Not found" }, 404);
  }
  delete meta.deletedAt;
  meta.updatedAt = Date.now();
  await writeMeta(meta);
  return c.json({ ok: true });
});

async function projectIds(): Promise<string[]> {
  return (await readdir(PROJECTS_DIR, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && okId(entry.name))
    .map((entry) => entry.name);
}

/**
 * Admin copies borrow a project's video (mediaProjectId). Before that
 * project goes, each borrowed clip's files move to the first copy still
 * using it, and later copies point there. Returns the clips handed over.
 */
async function handOverMedia(id: string): Promise<Set<string>> {
  const newHome = new Map<string, string>();
  for (const otherId of await projectIds()) {
    if (otherId === id) continue;
    const peek = await readMeta(otherId).catch(() => null);
    if (!peek?.clips.some((clip) => clip.mediaProjectId === id)) continue;
    await withProjectWrite(otherId, async () => {
      const other = await readMeta(otherId);
      if (!other) return;
      for (const clip of other.clips) {
        if (clip.mediaProjectId !== id) continue;
        const home = newHome.get(clip.id);
        if (home) {
          clip.mediaProjectId = home;
          continue;
        }
        const from = clipDir(id, clip.id);
        await mkdir(clipDir(otherId, clip.id), { recursive: true });
        for (const name of await readdir(from).catch(() => [] as string[])) {
          if (name === "data.json") continue; // the copy has its own
          await rename(path.join(from, name), path.join(clipDir(otherId, clip.id), name));
        }
        delete clip.mediaProjectId;
        newHome.set(clip.id, otherId);
      }
      await writeMeta(other);
    });
  }
  return new Set(newHome.keys());
}

async function purgeDeletedProject(id: string, meta: Meta): Promise<void> {
  const handedOver = await handOverMedia(id);
  await Promise.all(
    meta.clips
      .flatMap((clip) => [
        ...(clip.objectUpload
          ? [abortSourceMultipart(clip.objectUpload.key, clip.objectUpload.id)]
          : []),
        // ponytail: a handed-over clip's stored source stays under this
        // project's key, so nothing deletes it later; rekey it if that adds up
        ...(clip.originalObjectKey &&
        clipOwnsStoredSource(id, clip) &&
        !handedOver.has(clip.id)
          ? [deleteStoredSource(clip.originalObjectKey)]
          : []),
      ])
      .map((operation) => operation.catch(() => {})),
  );
  await rm(projDir(id), { recursive: true, force: true });
  await deleteExportsForProject(id);
}

/** Retention (api/retention.ts): delete every project it picks, trash included. */
export async function purgeExpiredProjects(expired: Expired): Promise<void> {
  for (const id of await projectIds()) {
    const meta = await readMeta(id).catch(() => null);
    if (meta && expired(meta.owner, meta.updatedAt)) await purgeDeletedProject(id, meta);
  }
}

async function copyIfExists(from: string, to: string): Promise<void> {
  if (!existsSync(from)) return;
  await mkdir(path.dirname(to), { recursive: true });
  await copyFile(from, to);
}

/** How long a deleted project stays in the trash (Settings → Storage says it). */
export const PROJECT_TRASH_DAYS = TRASH_KEEP_DAYS;
/** Empty on Settings → Storage: the deleted projects in `ids` go for good now, the way the trash's own delete does it. */
export async function emptyProjectTrash(ids: string[]): Promise<void> {
  for (const id of ids) {
    const meta = okId(id) ? await readMeta(id).catch(() => null) : null;
    if (meta?.deletedAt) await purgeDeletedProject(id, meta);
  }
}

async function sweepDeletedProjects(): Promise<void> {
  let ids: string[] = [];
  try {
    ids = (await readdir(PROJECTS_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && okId(entry.name))
      .map((entry) => entry.name);
  } catch {
    return;
  }
  const cutoff = Date.now() - TRASH_KEEP_MS;
  for (const id of ids) {
    const meta = await readMeta(id).catch(() => null);
    if (!meta?.deletedAt || meta.deletedAt > cutoff) continue;
    await purgeDeletedProject(id, meta);
  }
}

// production only: dev servers share ~/.caption-studio with real trash
if (env.isProduction && env.appSecret) {
  void sweepDeletedProjects();
  setInterval(() => void sweepDeletedProjects(), 12 * 3600 * 1000).unref();
}

// ---------- shared with Review (api/review.ts) ----------

/** The same file under a second name: no copy, no extra disk. Falls back to
 *  a copy across filesystems. Both sides only ever replace files by rename,
 *  so one side can never change or delete the other's video. */
export async function linkOrCopy(from: string, to: string): Promise<void> {
  await mkdir(path.dirname(to), { recursive: true });
  await rm(to, { force: true });
  await link(from, to).catch(() => copyFile(from, to));
}

/** Local path of a clip's source, fetched from object storage when needed. */
export const clipSourceFile = (projectId: string, clipId: string) =>
  ensureProjectOriginal(projectId, clipId, clipOriginalPath(projectId, clipId));

/** A one-clip project on a file already on the server (a Review upload, or a Media Library version). */
export async function createProjectFromFile(o: {
  owner: string;
  name: string;
  clipName: string;
  file: string;
  duration: number;
  libraryVersionId?: string;
  /** Answer once the project is on disk: its editing copy is built behind it (clipReadyToEdit waits for that). */
  later?: boolean;
}): Promise<{ projectId: string; clipId: string }> {
  const id = randomUUID();
  const clipId = randomUUID();
  const now = Date.now();
  await mkdir(clipDir(id, clipId), { recursive: true });
  // ownership reaches disk first, as in the draft routes
  await writeMeta({
    id,
    name: o.name.slice(0, 120),
    createdAt: now,
    updatedAt: now,
    duration: 0,
    owner: o.owner,
    clips: [
      {
        id: clipId,
        name: o.clipName.slice(0, 120),
        duration: o.duration,
        createdAt: now,
        ...(o.libraryVersionId ? { libraryVersionId: o.libraryVersionId } : {}),
      },
    ],
    revision: 0,
  });
  await writeJson(path.join(projDir(id), "data.json"), {});
  await writeJson(clipDataPath(id, clipId), {});
  await linkOrCopy(o.file, clipOriginalPath(id, clipId));
  bumpUsage(o.owner, { projectsCreated: 1 });
  // later: a build that fails is tried once more, and reported, by whoever waits for it
  if (o.later) void buildProxyFromOriginal(id, clipId).catch(() => {});
  else await buildProxyFromOriginal(id, clipId);
  return { projectId: id, clipId };
}

/** What the server itself is doing to a project right now (api/captions-job.ts), by project id: in memory only. */
export type Captioning = "preparing" | "transcribing";
export const captioning = new Map<string, Captioning>();

/** Exists for this user with its editing proxy built (waits for a build). */
export async function clipReadyToEdit(
  projectId: string,
  clipId: string,
  user: SessionUser,
): Promise<boolean> {
  const meta = await ownedMeta(projectId, user);
  const clip = meta?.clips.find((entry) => entry.id === clipId);
  if (!meta || !clip) return false;
  const home = mediaHome(projectId, clip);
  await buildProxyFromOriginal(home, clipId);
  return existsSync(clipProxyPath(home, clipId));
}

/**
 * A clip's uncaptioned source with a snapshot of its captions, read under the project lock: for a tool that edits the
 * clip outside Caption Studio (a plug-in) and hands it back with addEditedClip.
 */
export async function clipWithCaptions(
  projectId: string,
  clipId: string,
  user: SessionUser,
) {
  return withProjectWrite(projectId, async () => {
    const meta = await ownedMeta(projectId, user);
    const clip = meta?.clips.find((c) => c.id === clipId);
    if (!meta || !clip)
      throw new HTTPException(404, { message: "Caption clip not found." });
    const home = mediaHome(projectId, clip);
    const file = await clipSourceFile(home, clipId);
    if (!file || !existsSync(file))
      throw new HTTPException(409, {
        message:
          "The original is not available yet. Finish uploading it in Caption Studio first.",
      });
    const data = await readFile(clipDataPath(projectId, clipId), "utf8").then(
      (s) => JSON.parse(s) as Record<string, unknown>,
      () => ({}),
    );
    return {
      file,
      name: clip.name,
      origin: { projectId, clipId, revision: meta.revision ?? 0 },
      data,
    };
  });
}

/**
 * Adds an edited clip without overwriting a project's existing media or annotations: to the project it came from
 * (`origin`, refused when that project changed since), or to a new project. The same `transferId` twice adds it once.
 */
export async function addEditedClip(o: {
  user: SessionUser;
  file: string;
  name: string;
  duration: number;
  width: number;
  height: number;
  data: Record<string, unknown>;
  transferId: string;
  origin?: { projectId: string; clipId: string; revision: number };
  scenes: number;
}) {
  // Stable identity also makes retries safe if proxy creation fails after commit.
  const digest = createHash("sha256")
    .update(o.user.username + ":" + o.transferId)
    .digest("hex");
  const projectId =
    o.origin?.projectId ??
    `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  const result = await withProjectWrite(projectId, async () => {
    let meta = await ownedMeta(projectId, o.user);
    if (o.origin && !meta)
      throw new HTTPException(404, {
        message: "The Caption Studio project is no longer available.",
      });
    const existing = meta?.clips.find(
      (c) => c.transferId === o.transferId,
    );
    if (existing) return { projectId, clipId: existing.id };
    if (o.origin && (meta!.revision ?? 0) !== o.origin.revision)
      throw new HTTPException(409, {
        message:
          "This project changed in Caption Studio. Send its current clip again to keep the latest caption edits.",
      });
    const clipId = randomUUID(),
      now = Date.now();
    if (!meta)
      meta = {
        id: projectId,
        name: o.name.slice(0, 120),
        owner: o.user.username,
        createdAt: now,
        updatedAt: now,
        duration: 0,
        clips: [],
        revision: 0,
      };
    const dir = clipDir(projectId, clipId);
    await mkdir(dir, { recursive: true });
    try {
      await linkOrCopy(o.file, clipOriginalPath(projectId, clipId));
      await writeJson(clipDataPath(projectId, clipId), o.data);
      if (!o.origin)
        await writeJson(path.join(projDir(projectId), "data.json"), {});
      meta.clips.push({
        id: clipId,
        name: o.name.slice(0, 120),
        duration: o.duration,
        createdAt: now,
        srcWidth: o.width,
        srcHeight: o.height,
        originalBytes: (await stat(o.file)).size,
        transferId: o.transferId,
        ...(o.origin
          ? {
              transferOrigin: {
                projectId,
                clipId: o.origin.clipId,
                scenes: o.scenes,
              },
            }
          : {}),
      });
      meta.revision = (meta.revision ?? 0) + 1;
      meta.updatedAt = now;
      await writeMeta(meta);
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
    if (!o.origin) bumpUsage(o.user.username, { projectsCreated: 1 });
    return { projectId, clipId };
  });
  await buildProxyFromOriginal(result.projectId, result.clipId);
  return result;
}
