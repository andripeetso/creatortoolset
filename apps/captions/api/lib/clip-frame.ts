import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { ffmpegCommand } from "../ffmpeg-runtime";
import { safeMs } from "./clip-agent-context";

const FRAME_TIMEOUT_MS = 20_000;
const MAX_CONCURRENT = 2;
const MAX_CACHED_FRAMES = 64;
const STDERR_LIMIT = 16 * 1024;

export type FrameErrorCode =
  | "NO_VIDEO"
  | "FFMPEG_UNAVAILABLE"
  | "EXTRACTION_FAILED";

export class ClipFrameError extends Error {
  constructor(
    readonly code: FrameErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ClipFrameError";
  }
}

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

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let cmd: string;
    try {
      cmd = ffmpegCommand();
    } catch {
      reject(
        new ClipFrameError(
          "FFMPEG_UNAVAILABLE",
          "Frame extraction requires ffmpeg.",
        ),
      );
      return;
    }
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
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
        reject(
          new ClipFrameError(
            "FFMPEG_UNAVAILABLE",
            "Frame extraction requires ffmpeg.",
          ),
        );
        return;
      }
      reject(
        new ClipFrameError(
          "EXTRACTION_FAILED",
          `Failed to extract video frame: ${err.message}`,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      if (
        /matches no streams|does not contain any stream|video: none/i.test(
          stderr,
        )
      ) {
        reject(
          new ClipFrameError(
            "NO_VIDEO",
            "This recording does not contain a video track.",
          ),
        );
        return;
      }
      reject(
        new ClipFrameError(
          "EXTRACTION_FAILED",
          `Failed to extract video frame: ffmpeg exited ${code}`,
        ),
      );
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
  await Promise.all(
    extra.map((e) => rm(path.join(dir, e.name), { force: true }).catch(() => {})),
  );
}

export async function extractClipJpegFrame({
  src,
  cacheDir,
  atMs,
}: {
  src: string;
  cacheDir: string;
  atMs: number;
}): Promise<Buffer> {
  if (!existsSync(src)) {
    throw new ClipFrameError("NO_VIDEO", "Recording media is missing.");
  }
  const ms = safeMs(atMs);
  await mkdir(cacheDir, { recursive: true });
  const outPath = path.join(cacheDir, `${ms}.jpg`);
  if (existsSync(outPath)) {
    const cached = await readFile(outPath);
    if (cached.length) return cached;
  }

  return withSlot(async () => {
    const seconds = ms / 1000;
    try {
      await runFfmpeg([
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-ss",
        String(seconds),
        "-i",
        src,
        "-frames:v",
        "1",
        "-vf",
        "scale='min(1280,iw)':-2",
        "-q:v",
        "3",
        outPath,
      ]);
    } catch (err) {
      if (err instanceof ClipFrameError && err.code === "NO_VIDEO" && ms > 0) {
        await runFfmpeg([
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-y",
          "-ss",
          "0",
          "-i",
          src,
          "-frames:v",
          "1",
          "-vf",
          "scale='min(1280,iw)':-2",
          "-q:v",
          "3",
          outPath,
        ]);
      } else {
        throw err;
      }
    }

    let info;
    try {
      info = await stat(outPath);
    } catch {
      throw new ClipFrameError(
        "NO_VIDEO",
        "No frame was available at that timestamp.",
      );
    }
    if (!info.size) {
      throw new ClipFrameError(
        "NO_VIDEO",
        "No frame was available at that timestamp.",
      );
    }
    await pruneFrameCache(cacheDir);
    return readFile(outPath);
  });
}
