import { spawn } from "node:child_process";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { ffmpegCommand } from "../../ffmpeg-runtime";
import { ClipFrameError, framed, type FrameInput, type PictureInput } from "../../lib/clip-frame";
import { safeMs } from "../../lib/clip-agent-context";
import { ffmpeg } from "../../library/media/run";
import { keep, taskKind } from "../tasks";

/**
 * One frame of a video (or a still) as a JPEG, for every tool that shows one: a clip's frame for an agent, a guide's
 * step pictures, a design's video moment, a Finals piece's cover, the Analyzer's vision frames (lib/clip-frame.ts
 * frameAt starts it). And `picture`: a still made smaller or turned into another format (lib/small-jpeg.ts). The frame
 * reads footage, so it runs on a computer unless the server's video work is on; a picture is a picture (decision 14).
 */

const FRAME_TIMEOUT_MS = 20_000;
const MAX_CONCURRENT = 2;
const MAX_CACHED_FRAMES = 64;
const STDERR_LIMIT = 16 * 1024;

let active = 0;
const waiters: Array<() => void> = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  active += 1;
  try {
    return await fn();
  } finally {
    active = Math.max(0, active - 1);
    waiters.shift()?.();
  }
}

function runFrame(args: string[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let cmd: string;
    try {
      cmd = ffmpegCommand();
    } catch {
      reject(new ClipFrameError("FFMPEG_UNAVAILABLE", "Frame extraction requires ffmpeg."));
      return;
    }
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"], signal });
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new ClipFrameError("EXTRACTION_FAILED", "ffmpeg timed out"));
    }, FRAME_TIMEOUT_MS);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_LIMIT);
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      if (/enoent|not found|eacces|enoexec/i.test(err.message)) {
        reject(new ClipFrameError("FFMPEG_UNAVAILABLE", "Frame extraction requires ffmpeg."));
        return;
      }
      reject(new ClipFrameError("EXTRACTION_FAILED", `Failed to extract video frame: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      if (/matches no streams|does not contain any stream|video: none/i.test(stderr)) {
        reject(new ClipFrameError("NO_VIDEO", "This recording does not contain a video track."));
        return;
      }
      reject(new ClipFrameError("EXTRACTION_FAILED", `Failed to extract video frame: ffmpeg exited ${code}`));
    });
  });
}

async function pruneFrameCache(dir: string): Promise<void> {
  let entries: { name: string; mtime: number }[] = [];
  try {
    const names = await readdir(dir);
    entries = await Promise.all(
      names
        .filter((name) => name.endsWith(".jpg"))
        .map(async (name) => {
          const info = await stat(path.join(dir, name)).catch(() => null);
          return { name, mtime: info?.mtimeMs ?? 0 };
        }),
    );
  } catch {
    return;
  }
  if (entries.length <= MAX_CACHED_FRAMES) return;
  entries.sort((a, b) => a.mtime - b.mtime);
  const extra = entries.slice(0, entries.length - MAX_CACHED_FRAMES);
  await Promise.all(extra.map((e) => rm(path.join(dir, e.name), { force: true }).catch(() => {})));
}

/** The frame at `ms` of `src` into `out`; a moment past the video's end that has no frame falls back to its first. */
export async function frameInto(src: string, ms: number, out: string, o: { still?: boolean; vf?: string; q?: number } = {}, signal = new AbortController().signal): Promise<void> {
  const args = (at: number) => [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    ...(o.still ? [] : ["-ss", String(at / 1000)]),
    "-i", src, "-frames:v", "1", "-vf", o.vf ?? "scale='min(1280,iw)':-2", "-q:v", String(o.q ?? 3), out,
  ];
  await withSlot(async () => {
    try {
      await runFrame(args(ms), signal);
    } catch (err) {
      if (err instanceof ClipFrameError && err.code === "NO_VIDEO" && ms > 0 && !o.still) await runFrame(args(0), signal);
      else throw err;
    }
  });
  const info = await stat(out).catch(() => null);
  if (!info?.size) throw new ClipFrameError("NO_VIDEO", "No frame was available at that timestamp.");
}

taskKind<FrameInput, Record<string, never>>("frame", {
  serve: (t, name) => (name === "src" ? (t.input as FrameInput).files.src : undefined),
  // a computer that has neither the server's copy to download nor the file itself cannot make it
  can: (d, t) => !!t.input.files.src || d.id === t.input.device,
  async run(input, ctx) {
    const src = await ctx.file("src");
    await frameInto(src, safeMs(input.atMs), path.join(ctx.dir, "frame.jpg"), input, ctx.signal);
    return { result: {}, files: ["frame.jpg"] };
  },
  async apply(t, _r, files) {
    await keep(files["frame.jpg"]!, t.input.to);
    if (t.input.prune) await pruneFrameCache(t.input.prune);
    await framed(t.input);
  },
});

taskKind<PictureInput, Record<string, never>>("picture", {
  reads: false,
  serve: (t, name) => (name === "src" ? (t.input as PictureInput).files.src : undefined),
  async run(input, ctx) {
    const out = path.join(ctx.dir, `picture.${input.ext}`);
    await ffmpeg(["-y", "-i", await ctx.file("src"), "-frames:v", "1", ...(input.vf ? ["-vf", input.vf] : []), ...input.out, out], true);
    return { result: {}, files: [`picture.${input.ext}`] };
  },
  apply: (t, _r, files) => keep(files[`picture.${t.input.ext}`]!, t.input.to),
});
