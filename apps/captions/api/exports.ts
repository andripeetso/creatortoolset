import { Hono } from "hono";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createReadStream, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { CaptionRenderSpec } from "../src/lib/types";
import type { AuthVars } from "./auth";
import { emitEvent } from "./lib/events";
import { assertMovHasTransparency } from "./alpha-video";
import { createCaptionFrameRenderer } from "./caption-frames";
import { filterEscape, requireFontsDir } from "./export";
import { ffmpegCommand } from "./ffmpeg-runtime";
import { env } from "./lib/env";
import { ensureProjectOriginal, projectOriginalExists, readProjectClip } from "./media-store";
import { saveToLibrary } from "./library/routes";
import { addToFinals, belowHd, libraryOf, type FinalsOutcome } from "./library/finals";
import { type SessionUser, bumpUsage } from "./users";
import type { ExportStatus } from "../contracts/exports";
import { type Moves, canMove, move } from "./lib/transition";

/**
 * Background export jobs (Canva-style). POST creates a job and returns
 * immediately; ffmpeg renders server-side while the client polls for
 * progress. Finished files live under $DATA_DIR/exports/<id>/ so they
 * stay downloadable after a reload — or after the tab was closed
 * mid-render — until the retention sweep removes them.
 */
export const exportsApp = new Hono<{ Variables: AuthVars }>();

const EXPORTS_DIR = path.join(env.dataDir, "exports");
const KEEP_HOURS = Number(process.env.EXPORTS_KEEP_HOURS || 24);
const MAX_CONCURRENT = Math.max(1, Number(process.env.EXPORT_CONCURRENCY || 1));

const okId = (id: string) => /^[a-z0-9-]{6,40}$/.test(id);
const jobDir = (id: string) => path.join(EXPORTS_DIR, id);
const outPath = (job: Job) => path.join(jobDir(job.id), `out.${job.ext}`);
const projectOriginal = (id: string, clipId?: string) =>
  clipId
    ? path.join(env.dataDir, "projects", id, "clips", clipId, "original")
    : path.join(env.dataDir, "projects", id, "original"); // legacy single-clip layout

type JobStatus = ExportStatus;
/** A job renders from queued to running, then ends done or error; nothing leaves those. */
export const EXPORT_MOVES: Moves<ExportStatus> = {
  queued: ["running", "error"],
  running: ["done", "error"],
  done: [],
  error: [],
};

interface JobParams {
  projectId?: string;
  clipId?: string;
  width?: number;
  height?: number;
  fps?: number;
  duration: number;
  crf?: number;
  /** burn only: send the render to the owner's Finals when it is done */
  finals?: boolean;
  finalsLabel?: string;
}

interface Job {
  id: string;
  kind: "burn" | "overlay";
  /**
   * native: ffmpeg/libass renders the client-built ASS — no browser,
   * faster than realtime. wysiwyg: headless Chromium screenshots the
   * DOM render surface per frame (pixel-exact, slower, needs Chromium).
   */
  engine: "native" | "wysiwyg";
  format: string; // h264 | h265 | mov | webm | png
  ext: string; // mp4 | mov | webm | zip
  filename: string; // download name shown to the user
  status: JobStatus;
  progress: number; // 0..1
  /** what a running job is doing besides rendering (the first export's browser download) */
  note?: string;
  error?: string;
  bytes?: number;
  createdAt: number;
  finishedAt?: number;
  owner?: string; // account username; absent on pre-account jobs
  /** One-click Send to Finals: where it is (the tray shows it; a closed tab doesn't matter). */
  finals?: { status: "waiting" | "sending" | "sent" | "refused" | "error"; pieceId?: string; error?: string };
  params: JobParams;
}

const canSee = (job: Job, user: SessionUser) =>
  user.role === "admin" || job.owner === user.username;

/** Client-facing shape (params stay server-side). */
function publicJob(j: Job): Omit<Job, "params"> {
  const pub: Partial<Job> = { ...j };
  delete pub.params;
  return pub as Omit<Job, "params">;
}

const jobs = new Map<string, Job>();
const children = new Map<string, ChildProcess>();

async function persist(job: Job): Promise<void> {
  try {
    await writeFile(path.join(jobDir(job.id), "job.json"), JSON.stringify(job));
  } catch {
    /* dir may already be deleted (cancel) */
  }
}

/** Load persisted jobs once at boot; renders killed by a restart → error. */
const loaded = (async () => {
  await mkdir(EXPORTS_DIR, { recursive: true }).catch(() => {});
  let ids: string[] = [];
  try {
    ids = (await readdir(EXPORTS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter(okId);
  } catch {
    return;
  }
  for (const id of ids) {
    try {
      const job: Job = JSON.parse(
        await readFile(path.join(jobDir(id), "job.json"), "utf-8"),
      );
      if (job.status === "queued" || job.status === "running") {
        job.status = move(EXPORT_MOVES, job.status, "error", "export job");
        job.error = "Interrupted by a server restart — export again.";
        job.finishedAt = Date.now();
        await persist(job);
      }
      // jobs persisted before the engine field existed are DOM renders
      if (!job.engine) job.engine = "wysiwyg";
      jobs.set(id, job);
    } catch {
      await rm(jobDir(id), { recursive: true, force: true }).catch(() => {});
    }
  }
})();

/** Cancel a job if still rendering and remove its files. */
async function removeJob(id: string): Promise<void> {
  jobs.delete(id); // runJob checks this before writing results
  const qi = queue.indexOf(id);
  if (qi >= 0) queue.splice(qi, 1);
  children.get(id)?.kill("SIGKILL");
  children.delete(id);
  await rm(jobDir(id), { recursive: true, force: true }).catch(() => {});
}

/** Deleting a project also deletes every export made from it. */
export async function deleteExportsForProject(
  projectId: string,
): Promise<void> {
  await loaded;
  for (const job of [...jobs.values()]) {
    if (job.params.projectId === projectId) await removeJob(job.id);
  }
}

async function sweepExports(): Promise<void> {
  await loaded;
  const cutoff = Date.now() - KEEP_HOURS * 3600 * 1000;
  for (const job of [...jobs.values()]) {
    const ts = job.finishedAt ?? job.createdAt;
    if (job.status !== "queued" && job.status !== "running" && ts < cutoff) {
      jobs.delete(job.id);
      await rm(jobDir(job.id), { recursive: true, force: true }).catch(
        () => {},
      );
    }
  }
}
void sweepExports();
setInterval(() => void sweepExports(), 3600 * 1000).unref();

/* ---- render queue (renders are CPU-bound: run a few at most) ---- */

const queue: string[] = [];
let running = 0;

function pump(): void {
  while (running < MAX_CONCURRENT && queue.length > 0) {
    const id = queue.shift()!;
    const job = jobs.get(id);
    if (!job) continue;
    running++;
    void runJob(job)
      .catch(() => {})
      .finally(() => {
        running--;
        pump();
      });
  }
}

/**
 * Capture the editor's transparent React/CSS surface and stream the PNGs to
 * FFmpeg in display order. FFmpeg never lays out or rasterizes caption text.
 */
async function runRenderedFfmpeg(
  job: Job,
  spec: CaptionRenderSpec,
  args: string[],
): Promise<void> {
  const renderer = await createCaptionFrameRenderer(spec, () => {
    job.note = "Downloading the export browser (196 MB)…";
    void persist(job);
  });
  if (job.note) {
    delete job.note;
    await persist(job);
  }
  const fps = job.params.fps ?? 30;
  const total = Math.max(1, Math.ceil(job.params.duration * fps));
  const p = spawn(
    ffmpegCommand(),
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostats",
      "-y",
      ...args,
      "-progress",
      "pipe:1",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  children.set(job.id, p);
  let err = "";
  let lastWrite = 0;
  p.stderr!.on("data", (d) => {
    err += d.toString();
    if (err.length > 8000) err = err.slice(-8000);
  });
  // Consume progress output even though capture progress is the user-facing
  // number; an unread pipe can otherwise block FFmpeg at the end.
  p.stdout!.resume();
  const closed = new Promise<void>((resolve, reject) => {
    p.on("close", (code) => {
      children.delete(job.id);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${err}`));
    });
    p.on("error", (error) => {
      children.delete(job.id);
      reject(error);
    });
  });
  // FFmpeg can reject before the current screenshot batch finishes. Mark the
  // promise handled immediately; the awaited original below still propagates.
  void closed.catch(() => {});

  try {
    const batchSize = renderer.capacity;
    for (let start = 0; start < total; start += batchSize) {
      if (!jobs.has(job.id)) throw new Error("Export cancelled");
      const end = Math.min(total, start + batchSize);
      const times = Array.from(
        { length: end - start },
        (_, i) => (start + i) / fps,
      );
      const frames = await renderer.render(times);
      for (const frame of frames) {
        if (!p.stdin!.write(frame)) await once(p.stdin!, "drain");
      }
      job.progress = Math.min(end / total, 0.99);
      if (Date.now() - lastWrite > 500) {
        lastWrite = Date.now();
        await persist(job);
      }
    }
    p.stdin!.end();
    await closed;
  } catch (error) {
    p.stdin?.destroy();
    if (p.exitCode === null) p.kill("SIGKILL");
    await closed.catch(() => {});
    throw error;
  } finally {
    await renderer.close();
    children.delete(job.id);
  }
}

/**
 * Native export: a single ffmpeg pass over the client-built ASS file
 * (libass renders text + the drawn pill; no browser involved). Progress
 * comes from ffmpeg's own -progress stream against the clip duration.
 */
async function runNativeFfmpeg(job: Job, args: string[]): Promise<void> {
  const p = spawn(ffmpegCommand(), [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostats",
    "-y",
    ...args,
    "-progress",
    "pipe:1",
  ]);
  children.set(job.id, p);
  let err = "";
  let lastWrite = 0;
  p.stderr!.on("data", (d) => {
    err += d.toString();
    if (err.length > 8000) err = err.slice(-8000);
  });
  p.stdout!.on("data", (d) => {
    // out_time_ms is actually microseconds in ffmpeg's progress stream
    const m = /out_time_ms=(\d+)/.exec(d.toString());
    if (!m) return;
    job.progress = Math.min(Number(m[1]) / 1e6 / job.params.duration, 0.99);
    if (Date.now() - lastWrite > 500) {
      lastWrite = Date.now();
      void persist(job);
    }
  });
  await new Promise<void>((resolve, reject) => {
    p.on("close", (code) => {
      children.delete(job.id);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${err}`));
    });
    p.on("error", (error) => {
      children.delete(job.id);
      reject(error);
    });
  });
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

async function runJob(job: Job): Promise<void> {
  const dir = jobDir(job.id);
  job.status = move(EXPORT_MOVES, job.status, "running", "export job");
  await persist(job);
  try {
    const { fps = 30, duration, crf, projectId, clipId } = job.params;

    if (job.engine === "native") {
      const assPath = path.join(dir, "captions.ass");
      const fontsOpt = `:fontsdir='${filterEscape(requireFontsDir())}'`;
      const vf = `ass='${filterEscape(assPath)}'${fontsOpt}`;
      const W = job.params.width ?? 1920;
      const H = job.params.height ?? 1080;
      if (job.kind === "burn") {
        const src = await ensureProjectOriginal(
          projectId!,
          clipId!,
          projectOriginal(projectId!, clipId),
        );
        if (!src) throw new Error("Source video is not on the server");
        const codec =
          job.format === "h265"
            ? [
                "-c:v",
                "libx265",
                "-preset",
                "medium",
                "-crf",
                String(crf ?? 22),
                "-tag:v",
                "hvc1",
              ]
            : [
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                String(crf ?? 19),
              ];
        await runNativeFfmpeg(job, [
          "-i",
          src,
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
          outPath(job),
        ]);
      } else {
        // transparent base; libass draws text + pill with real alpha
        // (alpha=1: the ass filter drops the alpha channel by default)
        const base = `color=c=black@0.0:size=${W}x${H}:rate=${fps}:d=${duration},format=rgba`;
        const vfAlpha = `${vf}:alpha=1`;
        if (job.format === "mov") {
          await runNativeFfmpeg(job, [
            "-f",
            "lavfi",
            "-i",
            base,
            "-vf",
            `${vfAlpha},format=yuva444p10le`,
            "-c:v",
            "prores_ks",
            "-profile:v",
            "4",
            "-pix_fmt",
            "yuva444p10le",
            "-alpha_bits",
            "16",
            "-tag:v",
            "ap4h",
            "-an",
            "-vendor",
            "apl0",
            "-movflags",
            "+faststart",
            outPath(job),
          ]);
        } else if (job.format === "webm") {
          await runNativeFfmpeg(job, [
            "-f",
            "lavfi",
            "-i",
            base,
            "-vf",
            vfAlpha,
            "-c:v",
            "libvpx-vp9",
            "-pix_fmt",
            "yuva420p",
            "-auto-alt-ref",
            "0",
            "-crf",
            "24",
            "-b:v",
            "2M",
            "-cpu-used",
            "5",
            "-row-mt",
            "1",
            "-deadline",
            "good",
            "-an",
            outPath(job),
          ]);
        } else {
          const framesDir = path.join(dir, "frames");
          await mkdir(framesDir, { recursive: true });
          await runNativeFfmpeg(job, [
            "-f",
            "lavfi",
            "-i",
            base,
            "-vf",
            vfAlpha,
            "-c:v",
            "png",
            "-pix_fmt",
            "rgba",
            "-start_number",
            "0",
            path.join(framesDir, "%05d.png"),
          ]);
          const frames = await readdir(framesDir);
          if (frames.length === 0) throw new Error("No frames rendered");
          await run("zip", [
            "-j",
            "-q",
            "-X",
            outPath(job),
            ...frames.map((f) => path.join(framesDir, f)),
          ]);
          await rm(framesDir, { recursive: true, force: true }).catch(() => {});
        }
      }
    } else {
      const renderPath = path.join(dir, "render.json");
      const spec: CaptionRenderSpec = JSON.parse(
        await readFile(renderPath, "utf-8"),
      );
      const frameInput = [
        "-f",
        "image2pipe",
        "-framerate",
        String(fps),
        "-i",
        "pipe:0",
      ];

      if (job.kind === "burn") {
        const src = await ensureProjectOriginal(
          projectId!,
          clipId!,
          projectOriginal(projectId!, clipId),
        );
        if (!src) throw new Error("Source video is not on the server");
        const codec =
          job.format === "h265"
            ? [
                "-c:v",
                "libx265",
                "-preset",
                "medium",
                "-crf",
                String(crf ?? 22),
                "-tag:v",
                "hvc1",
              ]
            : [
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                String(crf ?? 19),
              ];
        await runRenderedFfmpeg(job, spec, [
          "-i",
          src,
          ...frameInput,
          "-filter_complex",
          "[0:v][1:v]overlay=0:0:format=auto:eof_action=pass[v]",
          "-map",
          "[v]",
          "-map",
          "0:a?",
          "-t",
          String(duration),
          ...codec,
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-b:a",
          "192k",
          "-movflags",
          "+faststart",
          outPath(job),
        ]);
      } else {
        if (job.format === "mov") {
          await runRenderedFfmpeg(job, spec, [
            ...frameInput,
            "-vf",
            "format=yuva444p10le",
            "-c:v",
            "prores_ks",
            "-profile:v",
            "4",
            "-pix_fmt",
            "yuva444p10le",
            "-alpha_bits",
            "16",
            "-tag:v",
            "ap4h",
            "-an",
            "-vendor",
            "apl0",
            "-movflags",
            "+faststart",
            outPath(job),
          ]);
        } else if (job.format === "webm") {
          await runRenderedFfmpeg(job, spec, [
            ...frameInput,
            "-c:v",
            "libvpx-vp9",
            "-pix_fmt",
            "yuva420p",
            "-auto-alt-ref",
            "0",
            "-crf",
            "24",
            "-b:v",
            "2M",
            "-cpu-used",
            "5",
            "-row-mt",
            "1",
            "-deadline",
            "good",
            "-an",
            outPath(job),
          ]);
        } else {
          const framesDir = path.join(dir, "frames");
          await mkdir(framesDir, { recursive: true });
          await runRenderedFfmpeg(job, spec, [
            ...frameInput,
            "-c:v",
            "png",
            "-pix_fmt",
            "rgba",
            "-start_number",
            "0",
            path.join(framesDir, "%05d.png"),
          ]);
          const frames = await readdir(framesDir);
          if (frames.length === 0) throw new Error("No frames rendered");
          await run("zip", [
            "-j",
            "-q",
            "-X",
            outPath(job),
            ...frames.map((f) => path.join(framesDir, f)),
          ]);
          await rm(framesDir, { recursive: true, force: true }).catch(() => {});
        }
      }
    }

    if (!jobs.has(job.id)) return; // cancelled mid-render
    if (job.kind === "overlay" && job.format === "mov") {
      await assertMovHasTransparency(outPath(job));
    }
    const st = await stat(outPath(job));
    if (!jobs.has(job.id)) return; // cancelled while the checks above ran
    job.status = move(EXPORT_MOVES, job.status, "done", "export job");
    job.progress = 1;
    job.bytes = st.size;
    job.finishedAt = Date.now();
    await rm(path.join(dir, "render.json"), { force: true }).catch(() => {});
    await rm(path.join(dir, "captions.ass"), { force: true }).catch(() => {});
    await persist(job);
    // success only: an error, a cancel and the restart recovery (which marks jobs as failed) do not emit
    emitEvent("export.finished", { id: job.id, owner: job.owner, kind: job.kind, format: job.format, bytes: st.size });
    if (job.params.finals && job.owner) await sendToFinals(job);
  } catch (e) {
    // cancelled — dir is gone, don't resurrect; a job already done keeps its file
    if (!jobs.has(job.id) || !canMove(EXPORT_MOVES, job.status, "error")) return;
    job.status = "error";
    job.error = e instanceof Error ? e.message : String(e);
    job.finishedAt = Date.now();
    await persist(job);
  }
}

/** One-click Send to Finals: the finished render goes into the owner's library and its Finals piece. Never throws; the outcome is on the job. */
async function sendToFinals(job: Job): Promise<void> {
  job.finals = { status: "sending" };
  let out: FinalsOutcome;
  try {
    out = await addToFinals(
      {
        owner: job.owner!,
        libraryId: libraryOf(job.owner!),
        label: job.params.finalsLabel ?? job.filename,
        item: null,
        kind: "export",
        width: job.params.width ?? 0,
        height: job.params.height ?? 0,
      },
      { file: outPath(job), filename: job.filename },
    );
  } catch (e) {
    out = { ok: false, code: "failed", error: e instanceof Error ? e.message : String(e) };
  }
  job.finals = out.ok
    ? { status: "sent", pieceId: out.pieceId }
    : { status: out.code === "refused" ? "refused" : "error", error: out.error };
  await persist(job);
}

/* ---- routes ---- */

interface CreateBody {
  kind: "burn" | "overlay";
  engine?: "native" | "wysiwyg";
  renderSpec?: CaptionRenderSpec;
  /** Client-built ASS document (required for the native engine). */
  ass?: string;
  format: string;
  name?: string;
  duration: number;
  projectId?: string;
  clipId?: string;
  crf?: number;
  width?: number;
  height?: number;
  fps?: number;
  /** burn only: send the render to the owner's Finals when it is done */
  finals?: boolean;
}

const OVERLAY_FORMATS: Record<string, string> = {
  mov: "mov",
  webm: "webm",
  png: "zip",
};

function sanitizeName(name: unknown): string {
  if (typeof name !== "string") return "captions";
  const clean = name
    .replace(/[^\w.\- ]+/g, "")
    .trim()
    .slice(0, 80);
  return clean || "captions";
}

function validRenderSpec(
  value: unknown,
  width: number,
  height: number,
): value is CaptionRenderSpec {
  if (!value || typeof value !== "object") return false;
  const spec = value as Partial<CaptionRenderSpec>;
  if (
    spec.width !== width ||
    spec.height !== height ||
    !Array.isArray(spec.cues) ||
    !Array.isArray(spec.posSegments) ||
    !Array.isArray(spec.texts) ||
    !spec.style ||
    typeof spec.style !== "object"
  ) {
    return false;
  }
  if (spec.cues.length > 100_000 || spec.texts.length > 10_000) return false;
  return spec.cues.every(
    (cue) =>
      Number.isFinite(cue?.start) &&
      Number.isFinite(cue?.end) &&
      Array.isArray(cue?.words) &&
      cue.words.every(
        (word) =>
          typeof word?.text === "string" &&
          word.text.length <= 10_000 &&
          Number.isFinite(word.start) &&
          Number.isFinite(word.end),
      ),
  );
}

exportsApp.post("/", async (c) => {
  await loaded;
  let body: CreateBody;
  try {
    body = await c.req.json<CreateBody>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const { kind, format } = body;
  const duration = Number(body.duration);
  if (!(duration > 0 && duration <= 3600)) {
    return c.json({ error: "Invalid duration" }, 400);
  }
  const W = Math.round(Number(body.width));
  const H = Math.round(Number(body.height));
  const FPS = Number(body.fps);
  if (!(W >= 16 && W <= 4096 && H >= 16 && H <= 4096)) {
    return c.json({ error: "Invalid resolution" }, 400);
  }
  if (!(FPS >= 1 && FPS <= 120)) {
    return c.json({ error: "Invalid fps" }, 400);
  }
  const engine = body.engine === "wysiwyg" ? "wysiwyg" : "native";
  if (engine === "native") {
    if (
      typeof body.ass !== "string" ||
      !body.ass.length ||
      body.ass.length > 5_000_000
    ) {
      return c.json({ error: "Invalid ASS payload" }, 400);
    }
  } else if (!validRenderSpec(body.renderSpec, W, H)) {
    return c.json(
      {
        error:
          "Invalid visual render payload — reload the editor and export again.",
      },
      400,
    );
  }
  const base = sanitizeName(body.name);
  // Finals is 1080p or more, checked here and again on the file's size when it is in
  if (body.finals && kind === "burn" && belowHd(W, H)) return c.json({ error: belowHd(W, H) }, 409);

  let job: Job;
  if (kind === "burn") {
    if (format !== "h264" && format !== "h265") {
      return c.json({ error: "Unsupported format" }, 400);
    }
    const projectId = body.projectId ?? "";
    if (!okId(projectId)) return c.json({ error: "Invalid project" }, 400);
    const clipId = body.clipId ?? "";
    if (!okId(clipId)) return c.json({ error: "Invalid clip" }, 400);
    const user = c.get("user");
    if (user.role !== "admin") {
      let owner = "";
      try {
        const meta = JSON.parse(
          await readFile(
            path.join(env.dataDir, "projects", projectId, "meta.json"),
            "utf-8",
          ),
        );
        if (typeof meta.owner === "string") owner = meta.owner;
      } catch {
        /* unreadable meta → treat as not yours */
      }
      if (owner !== user.username)
        return c.json({ error: "Invalid project" }, 400);
    }
    if (
      !(await projectOriginalExists(
        projectId,
        clipId,
        projectOriginal(projectId, clipId),
      ))
    ) {
      return c.json(
        { error: "Source video is not on the server", code: "NO_ORIGINAL" },
        409,
      );
    }
    job = {
      id: randomUUID(),
      kind,
      engine,
      format,
      ext: "mp4",
      filename: `${base}-captioned.mp4`,
      status: "queued",
      progress: 0,
      createdAt: Date.now(),
      params: {
        projectId,
        clipId,
        width: W,
        height: H,
        fps: FPS,
        duration,
        crf: body.crf,
        ...(body.finals ? { finals: true, finalsLabel: base } : {}),
      },
    };
  } else if (kind === "overlay") {
    const ext = OVERLAY_FORMATS[format];
    if (!ext) return c.json({ error: "Unsupported format" }, 400);
    job = {
      id: randomUUID(),
      kind,
      engine,
      format,
      ext,
      filename: `${base}-captions-alpha.${ext === "zip" ? "png.zip" : ext}`,
      status: "queued",
      progress: 0,
      createdAt: Date.now(),
      params: {
        width: W,
        height: H,
        fps: FPS,
        duration,
        // overlay renders don't read project files, but tagging the source
        // project lets project deletion clean these up too
        projectId: okId(body.projectId ?? "") ? body.projectId : undefined,
      },
    };
  } else {
    return c.json({ error: "Unknown export kind" }, 400);
  }

  try {
    job.owner = c.get("user")?.username;
    if (job.params.finals) job.finals = { status: "waiting" };
    if (job.owner) bumpUsage(job.owner, { renders: 1 });
    await mkdir(jobDir(job.id), { recursive: true });
    if (engine === "native") {
      await writeFile(
        path.join(jobDir(job.id), "captions.ass"),
        body.ass!,
        "utf-8",
      );
    } else {
      await writeFile(
        path.join(jobDir(job.id), "render.json"),
        JSON.stringify(body.renderSpec),
        "utf-8",
      );
    }
    jobs.set(job.id, job);
    await persist(job);
    queue.push(job.id);
    pump();
    return c.json(publicJob(job));
  } catch (e) {
    jobs.delete(job.id);
    await rm(jobDir(job.id), { recursive: true, force: true }).catch(() => {});
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

/* own jobs, newest first — the client tray polls this. Personal like
   the project list: admins keep only ownerless legacy jobs, not other
   users' (by-id routes still allow admin access). */
exportsApp.get("/", async (c) => {
  await loaded;
  const user = c.get("user");
  const all = [...jobs.values()]
    .filter(
      (j) => j.owner === user.username || (user.role === "admin" && !j.owner),
    )
    .sort((a, b) => b.createdAt - a.createdAt);
  return c.json(all.map(publicJob));
});

/* several finished exports as one ZIP. Stored, not compressed (videos don't shrink), streamed
   as zip writes it; entries carry each export's own file name. */
exportsApp.get("/zip", async (c) => {
  await loaded;
  const user = c.get("user");
  const ready = (c.req.query("ids") ?? "")
    .split(",")
    .map((id) => jobs.get(id))
    .filter((j): j is Job => !!j && canSee(j, user) && j.status === "done" && existsSync(outPath(j)));
  if (!ready.length) return c.json({ error: "Nothing to download" }, 404);
  const name = (c.req.query("name") || "exports").replace(/[^\w.-]+/g, "_").slice(0, 80);
  // links named as the files should be inside the ZIP (zip stores what they point at)
  const dir = await mkdtemp(path.join(tmpdir(), "exports-zip-"));
  const used = new Set<string>();
  const entries: string[] = [];
  for (const j of ready) {
    let entry = j.filename;
    for (let k = 2; used.has(entry); k++) entry = j.filename.replace(/(\.[^.]+)?$/, `-${k}$1`);
    used.add(entry);
    await symlink(outPath(j), path.join(dir, entry));
    entries.push(entry);
  }
  const zip = spawn("zip", ["-0", "-q", "-", ...entries], { cwd: dir });
  zip.on("close", () => void rm(dir, { recursive: true, force: true }));
  zip.on("error", () => void rm(dir, { recursive: true, force: true }));
  return new Response(Readable.toWeb(zip.stdout) as unknown as ReadableStream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${name}.zip"`,
    },
  });
});

exportsApp.get("/:id", async (c) => {
  await loaded;
  const job = jobs.get(c.req.param("id"));
  if (!job || !canSee(job, c.get("user")))
    return c.json({ error: "Not found" }, 404);
  return c.json(publicJob(job));
});

/* download a finished export (works across reloads / new tabs) */
exportsApp.get("/:id/file", async (c) => {
  await loaded;
  const job = jobs.get(c.req.param("id"));
  if (!job || !canSee(job, c.get("user")))
    return c.json({ error: "Not found" }, 404);
  if (job.status !== "done") return c.json({ error: "Not ready" }, 409);
  const p = outPath(job);
  if (!existsSync(p)) return c.json({ error: "File expired" }, 410);
  const st = await stat(p);
  const type =
    job.ext === "mp4"
      ? "video/mp4"
      : job.ext === "mov"
        ? "video/quicktime"
        : job.ext === "webm"
          ? "video/webm"
          : "application/zip";
  return new Response(
    Readable.toWeb(createReadStream(p)) as unknown as ReadableStream,
    {
      headers: {
        "Content-Type": type,
        "Content-Length": String(st.size),
        "Content-Disposition": `attachment; filename="${job.filename}"`,
      },
    },
  );
});

/* a finished export into the Media Library ({ libraryId? }: else the workspace's first): a new asset, made from the
   library version its clip came from (derived_from) */
exportsApp.post("/:id/library", async (c) => {
  await loaded;
  const user = c.get("user");
  const job = jobs.get(c.req.param("id"));
  if (!job || !canSee(job, user)) return c.json({ error: "Not found" }, 404);
  if (job.status !== "done") return c.json({ error: "Not ready" }, 409);
  if (user.role !== "admin" && user.off.includes("media")) return c.json({ error: "Not found" }, 404); // as boot.ts TOOL_GATES
  if (job.ext === "zip") return c.json({ error: "A PNG sequence can't go in the library" }, 400);
  const p = outPath(job);
  if (!existsSync(p)) return c.json({ error: "File expired" }, 410);
  const body = (await c.req.json().catch(() => null)) as { libraryId?: unknown } | null;
  const clip = job.params.projectId && job.params.clipId ? await readProjectClip(job.params.projectId, job.params.clipId) : null;
  const saved = await saveToLibrary(
    user.username,
    p,
    job.filename,
    clip?.libraryVersionId ? [clip.libraryVersionId] : [],
    typeof body?.libraryId === "string" ? body.libraryId : undefined,
  );
  if (!saved) return c.json({ error: "There is no Media Library to save into", code: "not_found" }, 404);
  if ("error" in saved) return c.json(saved, 507);
  return c.json(saved);
});

/* Save to Content, an older path kept for older clients: a finished captioned export goes to
   Finals, exactly as a Send to Finals does (sendToFinals). Never below 1080p. */
exportsApp.post("/:id/content", async (c) => {
  await loaded;
  const user = c.get("user");
  const job = jobs.get(c.req.param("id"));
  if (!job || !canSee(job, user)) return c.json({ error: "Not found" }, 404);
  if (user.role !== "admin") return c.json({ error: "Only admins can save to Content" }, 403);
  if (job.kind !== "burn" || job.status !== "done" || !job.owner) return c.json({ error: "Only a finished captioned export can be saved" }, 409);
  if (!existsSync(outPath(job))) return c.json({ error: "File expired" }, 410);
  const small = belowHd(job.params.width, job.params.height);
  if (small) return c.json({ error: small }, 409);
  await sendToFinals(job);
  return c.json({ finals: job.finals }, job.finals?.status === "sent" ? 201 : 409);
});

/* cancel a running job, or delete a finished one */
exportsApp.delete("/:id", async (c) => {
  await loaded;
  const id = c.req.param("id");
  const job = jobs.get(id);
  if (!job || !canSee(job, c.get("user")))
    return c.json({ error: "Not found" }, 404);
  await removeJob(id);
  return c.json({ ok: true });
});
