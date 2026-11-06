import { spawn } from "node:child_process";
import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ffmpegCommand } from "../../ffmpeg-runtime";

/** One ffmpeg run; stderr's tail is the error. Callers pass the arguments after the global flags. */
export function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args]);
    let err = "";
    p.stderr.on("data", (d) => (err = (err + d.toString()).slice(-2000)));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `ffmpeg exited ${code}`))));
  });
}

/** Writes a derivative under its final name only when complete: a temp file, then a rename over the old one. */
export async function atomically(out: string, write: (tmp: string) => Promise<void>): Promise<void> {
  const tmp = `${out}.part${path.extname(out)}`; // the extension keeps ffmpeg's muxer guess right
  try {
    await write(tmp);
    await rename(tmp, out);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** ffmpeg writes `out` through a temp file (see atomically). `args` are the inputs and options, without the output. */
export function ffmpegTo(out: string, args: string[]): Promise<void> {
  return atomically(out, (tmp) => ffmpeg([...args, tmp]));
}

export const writeJsonAtomic = (out: string, value: unknown) =>
  atomically(out, (tmp) => writeFile(tmp, JSON.stringify(value)));
