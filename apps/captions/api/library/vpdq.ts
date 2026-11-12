import { spawn } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";

/**
 * The PDQ tool (runtime/fingerprints/pdq-photo-hasher, scripts/install-fingerprint-runtime.sh) and a video's vPDQ frame
 * hashes made with it. The Media Library's fingerprint job reads them (library/fingerprint.ts); a plug-in that measures
 * videos can use the same three functions.
 */

/** Runs one measuring program and returns what it printed. A timeout or an abort kills its whole process group, so a decoder it started goes too. */
export function runFingerprintTool(
  cmd: string,
  args: string[],
  cwd?: string,
  timeoutMs = 120_000,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(cmd, args, {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let failure: Error | undefined;
    const stop = (message: string) => {
      failure = new Error(message);
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    };
    const abort = () => {
      stop("Measurement cancelled.");
      failure = new DOMException("Measurement cancelled.", "AbortError");
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => stop(`${path.basename(cmd)} timed out. Try a shorter clip.`),
      timeoutMs,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 1024 * 1024)
        stop(`${path.basename(cmd)} returned too much data.`);
    });
    // Drain progress output without retaining file paths or metadata.
    child.stderr.resume();
    child.on("error", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new Error(`${path.basename(cmd)} could not start.`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new Error(`${path.basename(cmd)} failed to measure this video.`),
        );
      else resolve(output);
    });
  });
}

export function parsePdq(output: string): { hash: string; quality: number } {
  const match = output.trim().match(/^([a-f\d]{64}),(\d{1,3}),[^\r\n]+$/i);
  if (!match || Number(match[2]) > 100)
    throw new Error("PDQ returned an invalid measurement.");
  return { hash: match[1].toLowerCase(), quality: Number(match[2]) };
}

/**
 * One video's vPDQ frame hashes: up to 64 frames evenly sampled (1 s or wider apart) from zero, decoded once into
 * `dir` as `<prefix>-NNN.ppm`, hashed by the PDQ tool, then deleted.
 */
export async function vpdqHashes(
  file: string,
  duration: number,
  dir: string,
  ffmpeg: string,
  hasher: string,
  prefix: string,
  signal?: AbortSignal,
  timeoutMs = 120_000,
): Promise<{ interval: number; frames: ReturnType<typeof parsePdq>[] }> {
  const run = (cmd: string, args: string[]) =>
    runFingerprintTool(cmd, args, dir, timeoutMs, signal);
  const interval = Math.max(1, duration / 64);
  // Decode once; each video has its own sampling timeline and denominator.
  await run(ffmpeg, [
    "-v",
    "error",
    "-nostdin",
    "-y",
    "-i",
    file,
    "-map",
    "0:V:0",
    "-vf",
    `fps=1/${interval}:start_time=0,scale=512:512:flags=bicubic`,
    "-frames:v",
    "64",
    "-pix_fmt",
    "rgb24",
    "-start_number",
    "0",
    `${prefix}-%03d.ppm`,
  ]);
  let names = (await readdir(dir))
    .filter((name) => name.startsWith(`${prefix}-`) && name.endsWith(".ppm"))
    .sort();
  // Clips shorter than half a sampling interval can be dropped by the fps filter.
  if (!names.length) {
    const name = `${prefix}-000.ppm`;
    await run(ffmpeg, [
      "-v",
      "error",
      "-nostdin",
      "-y",
      "-i",
      file,
      "-map",
      "0:V:0",
      "-frames:v",
      "1",
      "-vf",
      "scale=512:512:flags=bicubic",
      "-pix_fmt",
      "rgb24",
      "-update",
      "1",
      name,
    ]);
    names = [name];
  }
  try {
    const frames = (await run(hasher, names)).trim().split(/\r?\n/).map(parsePdq);
    if (frames.length !== names.length)
      throw new Error("Incomplete vPDQ frame hashes.");
    return { interval, frames };
  } finally {
    await Promise.all(
      names.map((name) => rm(path.join(dir, name), { force: true })),
    );
  }
}
