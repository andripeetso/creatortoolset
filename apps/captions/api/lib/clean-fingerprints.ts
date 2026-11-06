import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  copyFile,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  FingerprintReport,
  Measurement,
  PdqFrame,
} from "../../contracts/clean-fingerprints";
import { ffmpegCommand } from "../ffmpeg-runtime";
import { extendedScores } from "./clean-extended-scores";

import {
  sourceMoment,
  type TimelineSpan,
} from "../../contracts/clean-timeline";
export type Alignment = {
  start: number;
  speed: number;
  timeline?: TimelineSpan[];
};
const SAMPLE_COUNT = 8;
const QUALITY_MIN = 50;
const runtimeDir = () =>
  path.resolve(process.env.FINGERPRINT_BIN_DIR || "runtime/fingerprints");

/** Kill the whole process group, including FFmpeg started by upstream TMK. */
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

export function pdqDistance(a: string, b: string): number {
  if (![a, b].every((hash) => /^[a-f\d]{64}$/i.test(hash)))
    throw new Error("Invalid PDQ hash.");
  let bits = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let distance = 0;
  while (bits) {
    bits &= bits - 1n;
    distance++;
  }
  return distance;
}

export function parsePdq(output: string): { hash: string; quality: number } {
  const match = output.trim().match(/^([a-f\d]{64}),(\d{1,3}),[^\r\n]+$/i);
  if (!match || Number(match[2]) > 100)
    throw new Error("PDQ returned an invalid measurement.");
  return { hash: match[1].toLowerCase(), quality: Number(match[2]) };
}

export function parseTmk(output: string): { level1: number; level2: number } {
  const lines = output.trim().split(/\r?\n/);
  const fields = lines[0].trim().split(/\s+/);
  const [level1, level2] = fields.slice(0, 2).map(Number);
  if (
    lines.length !== 1 ||
    fields.length !== 4 ||
    !Number.isFinite(level1) ||
    !Number.isFinite(level2) ||
    level1 < -1.00001 ||
    level1 > 1.00001 ||
    level2 < -0.00001 ||
    level2 > 1.00001
  ) {
    throw new Error(
      "TMK returned no valid score (the clip may contain too little visual detail).",
    );
  }
  return {
    level1: Math.max(-1, Math.min(1, level1)),
    level2: Math.max(0, Math.min(1, level2)),
  };
}

export function summarizePdq(frames: PdqFrame[]) {
  const reliable = frames.filter((frame) => frame.reliable);
  return {
    frames,
    reliableFrames: reliable.length,
    meanDistance: reliable.length
      ? reliable.reduce((sum, f) => sum + f.distance, 0) / reliable.length
      : null,
    maxDistance: reliable.length
      ? Math.max(...reliable.map((f) => f.distance))
      : null,
  };
}

async function available(name: string): Promise<boolean> {
  return access(path.join(runtimeDir(), name), constants.X_OK).then(
    () => true,
    () => false,
  );
}

async function measure<T>(
  names: string[],
  work: () => Promise<T>,
): Promise<Measurement<T>> {
  if (!(await Promise.all(names.map(available))).every(Boolean)) {
    return {
      status: "unavailable",
      message: "Fingerprint tools are not installed on this server.",
    };
  }
  try {
    return { status: "ok", ...(await work()) };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Measurement failed.",
    };
  }
}

async function measurePdq(
  before: string,
  after: string,
  dir: string,
  ffmpeg: string,
  alignment?: Alignment,
  signal?: AbortSignal,
) {
  const runTool = (cmd: string, args: string[], cwd?: string) =>
    runFingerprintTool(cmd, args, cwd, 120_000, signal);
  const durations = await Promise.all(
    (alignment ? [after] : [before, after]).map(async (file) => {
      const probe = JSON.parse(
        await runTool("ffprobe", [
          "-v",
          "error",
          "-select_streams",
          "V:0",
          "-show_entries",
          "stream=duration:format=duration",
          "-of",
          "json",
          file,
        ]),
      ) as {
        format?: { duration?: string };
        streams?: { duration?: string }[];
      };
      const duration = Number(
        probe.streams?.[0]?.duration || probe.format?.duration,
      );
      if (!Number.isFinite(duration) || duration <= 0)
        throw new Error("Could not determine video duration for PDQ sampling.");
      return duration;
    }),
  );
  // Independently uploaded videos can differ in length. Compare only timestamps
  // present in both; TMK still measures each complete video.
  const duration = Math.min(...durations);
  const count = Math.min(SAMPLE_COUNT, Math.max(1, Math.ceil(duration)));
  const frames: PdqFrame[] = [];
  for (let index = 0; index < count; index++) {
    const seconds = (duration * index) / count;
    const originalSeconds = alignment
      ? alignment.timeline
        ? sourceMoment(alignment.timeline, seconds, alignment.speed)
        : alignment.start + seconds * alignment.speed
      : seconds;
    const hashes = [];
    for (const [side, file] of [
      ["before", before],
      ["after", after],
    ]) {
      const frame = `${side}-${index}.ppm`;
      await rm(path.join(dir, frame), { force: true });
      await runTool(
        ffmpeg,
        [
          "-v",
          "error",
          "-nostdin",
          "-y",
          "-ss",
          String(side === "before" ? originalSeconds : seconds),
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
          frame,
        ],
        dir,
      );
      hashes.push(
        parsePdq(
          await runTool(
            path.join(runtimeDir(), "pdq-photo-hasher"),
            [frame],
            dir,
          ),
        ),
      );
    }
    const [a, b] = hashes;
    frames.push({
      seconds,
      ...(alignment ? { originalSeconds } : {}),
      before: a.hash,
      after: b.hash,
      qualityBefore: a.quality,
      qualityAfter: b.quality,
      distance: pdqDistance(a.hash, b.hash),
      reliable: a.quality >= QUALITY_MIN && b.quality >= QUALITY_MIN,
    });
  }
  return summarizePdq(frames);
}

async function executablePath(command: string): Promise<string> {
  if (path.isAbsolute(command) || command.includes(path.sep))
    return path.resolve(command);
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const candidate = path.resolve(dir, command);
    if (
      await access(candidate, constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return candidate;
  }
  throw new Error("FFmpeg is unavailable.");
}

async function measureTmk(
  before: string,
  after: string,
  dir: string,
  ffmpeg: string,
  signal?: AbortSignal,
  baselineCache?: string,
) {
  const runTool = (cmd: string, args: string[], cwd?: string) =>
    runFingerprintTool(cmd, args, cwd, 120_000, signal);
  // Upstream invokes a shell internally. Only fixed relative names enter that shell;
  // user filenames, DATA_DIR and configured FFmpeg paths never enter command text.
  await symlink(await executablePath(ffmpeg), path.join(dir, "ffmpeg"));
  for (const [side, file] of [
    ["before", before],
    ["after", after],
  ]) {
    if (
      side === "before" &&
      baselineCache &&
      (await copyFile(baselineCache, path.join(dir, "before.tmk")).then(
        () => true,
        () => false,
      ))
    )
      continue;
    await symlink(file, path.join(dir, `${side}.video`));
    await runTool(
      path.join(runtimeDir(), "tmk-hash-video"),
      ["-f", "./ffmpeg", "-i", `${side}.video`, "-o", `${side}.tmk`],
      dir,
    );
    if (side === "before" && baselineCache) {
      await copyFile(path.join(dir, "before.tmk"), baselineCache + ".tmp");
      await rename(baselineCache + ".tmp", baselineCache);
    }
  }
  const scores = parseTmk(
    await runTool(
      path.join(runtimeDir(), "tmk-two-level-score"),
      ["--c1", "-1.01", "--c2", "0", "before.tmk", "after.tmk"],
      dir,
    ),
  );
  const [a, b] = await Promise.all([
    readFile(path.join(dir, "before.tmk")),
    readFile(path.join(dir, "after.tmk")),
  ]);
  return {
    ...scores,
    signatureIdentical: a.equals(b),
    signatureSha256: {
      before: createHash("sha256").update(a).digest("hex"),
      after: createHash("sha256").update(b).digest("hex"),
    },
  };
}

/** Measurements are independent of cleaning: one unavailable algorithm must not hide the other. */
export async function measureFingerprints(
  before: string,
  after: string,
  alignment?: Alignment,
  signal?: AbortSignal,
  baselineCache?: string,
): Promise<FingerprintReport> {
  const report: FingerprintReport = {
    implementation:
      "Meta PDQ/TMK reference, Meta SSCD ONNX model, vPDQ matching method and Creator Toolset visual diagnostics",
    revision: null,
    ffmpeg: null,
    scope:
      "PDQ: up to 8 evenly spaced matching timestamps from zero through the shared duration (the shorter video), on the first non-cover video track; no automatic trim or content alignment, decoded to 512×512 RGB with FFmpeg bicubic scaling; distances summarize pairs with both quality scores ≥50. TMK+PDQF: full video at the reference 15 fps, FFmpeg default video track. Audio is not measured. Scores describe this pair only, not platform detection decisions.",
    pdq: { status: "error", message: "Measurement did not finish." },
    tmk: { status: "error", message: "Measurement did not finish." },
  };
  if (alignment)
    report.scope =
      "PDQ: up to 8 frames at matching source moments, accounting for scene order, cuts, trim and playback speed. Target time is in the edited output; originalSeconds records the corresponding source time. Both frames use 512×512 RGB bicubic preprocessing and the quality threshold of 50. TMK compares the entire original with the entire edit, including trim and timing changes. Audio is not measured.";
  let dir: string | undefined;
  try {
    const [pdqInstalled, tmkInstalled] = await Promise.all([
      available("pdq-photo-hasher"),
      Promise.all([
        available("tmk-hash-video"),
        available("tmk-two-level-score"),
      ]).then((tools) => tools.every(Boolean)),
    ]);
    if (!pdqInstalled)
      report.pdq = {
        status: "unavailable",
        message: "Fingerprint tools are not installed on this server.",
      };
    if (!tmkInstalled)
      report.tmk = {
        status: "unavailable",
        message: "Fingerprint tools are not installed on this server.",
      };
    const manifest = await readFile(
      path.join(runtimeDir(), "manifest.json"),
      "utf8",
    ).catch(() => "{}");
    const revision = (JSON.parse(manifest) as { revision?: string }).revision;
    report.revision = typeof revision === "string" ? revision : null;
    const ffmpeg = await executablePath(ffmpegCommand());
    report.ffmpeg = (
      await runFingerprintTool(ffmpeg, ["-version"], undefined, 120_000, signal)
    ).split("\n")[0];
    dir = await mkdtemp(path.join(tmpdir(), "clean-fingerprints-"));
    report.pdq = await measure(["pdq-photo-hasher"], () =>
      measurePdq(
        path.resolve(before),
        path.resolve(after),
        dir!,
        ffmpeg,
        alignment,
        signal,
      ),
    );
    report.tmk = await measure(["tmk-hash-video", "tmk-two-level-score"], () =>
      measureTmk(
        path.resolve(before),
        path.resolve(after),
        dir!,
        ffmpeg,
        signal,
        baselineCache,
      ),
    );
    report.scope +=
      " SSCD and color/contrast use up to 8 aligned frames; vPDQ samples each whole video independently (up to 64 frames, 1 second or wider intervals), ignoring order. The comparison timeline separately searches up to 256 frames per video at 0.25-second or wider intervals across all timestamps; matches are approximate and repeated/static frames can have ambiguous source locations. Motion uses up to three 1.25-second windows at 8 fps on a 64×64 grid and estimates global translation changes; it cannot isolate camera shake.";
    Object.assign(
      report,
      await extendedScores(
        path.resolve(before),
        path.resolve(after),
        dir,
        ffmpeg,
        alignment,
        signal,
      ),
    );
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    const message =
      error instanceof Error ? error.message : "Fingerprint analysis failed.";
    if (report.pdq.status === "error")
      report.pdq = { status: "error", message };
    if (report.tmk.status === "error")
      report.tmk = { status: "error", message };
    for (const key of [
      "sscd",
      "visual",
      "vpdq",
      "motion",
      "comparison",
    ] as const)
      report[key] ??= { status: "error", message };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
  return report;
}
