import { measureComparisonTimeline } from "./clean-comparison";
import { access, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type {
  ExtendedScores,
  Measurement,
} from "../../contracts/clean-fingerprints";
import { sourceMoment } from "../../contracts/clean-timeline";
import {
  parsePdq,
  runFingerprintTool,
  type Alignment,
} from "./clean-fingerprints";
import {
  averageVisual,
  matchVpdq,
  motionWindow,
  readPpm,
  visualDifference,
} from "./clean-visual-math";
import { measureSscdPairs } from "./clean-sscd";

async function attempt<T>(
  work: () => Promise<T>,
  signal?: AbortSignal,
): Promise<Measurement<T>> {
  try {
    return { status: "ok", ...(await work()) };
  } catch (error) {
    signal?.throwIfAborted();
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Analysis failed.",
    };
  }
}

export async function extendedScores(
  before: string,
  after: string,
  dir: string,
  ffmpeg: string,
  alignment?: Alignment,
  signal?: AbortSignal,
): Promise<ExtendedScores> {
  const run = (cmd: string, args: string[]) =>
    runFingerprintTool(cmd, args, dir, 120_000, signal);
  const durations = await Promise.all(
    [before, after].map(async (file) => {
      const data = JSON.parse(
        await run("ffprobe", [
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
      );
      const seconds = Number(
        data.streams?.[0]?.duration || data.format?.duration,
      );
      if (!Number.isFinite(seconds) || seconds <= 0)
        throw new Error("Could not determine duration for visual analysis.");
      return seconds;
    }),
  );
  const report: ExtendedScores = {};
  const duration = alignment ? durations[1] : Math.min(...durations);
  const count = Math.min(8, Math.max(1, Math.ceil(duration)));
  const pairs = Array.from({ length: count }, (_, i) => ({
    before: path.join(dir, `before-${i}.ppm`),
    after: path.join(dir, `after-${i}.ppm`),
  }));
  const decoded = await attempt(async () => {
    for (let i = 0; i < count; i++) {
      const target = (duration * i) / count;
      const original = alignment
        ? alignment.timeline
          ? sourceMoment(alignment.timeline, target, alignment.speed)
          : alignment.start + target * alignment.speed
        : target;
      for (const [side, file, seconds] of [
        ["before", before, original],
        ["after", after, target],
      ] as const) {
        const frame = pairs[i][side];
        // Reuse the exact decoded PDQ frames, including their source-time alignment.
        if (
          await access(frame).then(
            () => true,
            () => false,
          )
        )
          continue;
        await run(ffmpeg, [
          "-v",
          "error",
          "-nostdin",
          "-y",
          "-ss",
          String(seconds),
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
        ]);
      }
    }
    return averageVisual(
      await Promise.all(
        pairs.map(async (pair) =>
          visualDifference(
            readPpm(await readFile(pair.before)),
            readPpm(await readFile(pair.after)),
          ),
        ),
      ),
    );
  }, signal);
  report.visual = decoded;
  report.sscd =
    decoded.status === "ok"
      ? await measureSscdPairs(pairs, signal)
      : { ...decoded };

  const hasher = path.resolve(
    process.env.FINGERPRINT_BIN_DIR || "runtime/fingerprints",
    "pdq-photo-hasher",
  );
  report.vpdq = !(await access(hasher).then(
    () => true,
    () => false,
  ))
    ? {
        status: "unavailable",
        message: "PDQ tools are not installed on this server.",
      }
    : await attempt(async () => {
        const samples: ReturnType<typeof parsePdq>[][] = [],
          intervals: number[] = [];
        for (const [side, file] of [before, after].entries()) {
          const interval = Math.max(1, durations[side] / 64);
          intervals.push(interval);
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
            `vpdq-${side}-%03d.ppm`,
          ]);
          let names = (await readdir(dir))
            .filter(
              (name) =>
                name.startsWith(`vpdq-${side}-`) && name.endsWith(".ppm"),
            )
            .sort();
          // Clips shorter than half a sampling interval can be dropped by the fps filter.
          if (!names.length) {
            const name = `vpdq-${side}-000.ppm`;
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
          samples.push(
            (await run(hasher, names)).trim().split(/\r?\n/).map(parsePdq),
          );
          if (samples[side].length !== names.length)
            throw new Error("Incomplete vPDQ frame hashes.");
          await Promise.all(
            names.map((name) => rm(path.join(dir, name), { force: true })),
          );
        }
        return matchVpdq(samples[0], samples[1], intervals);
      }, signal);

  report.comparison = await access(hasher).then(
    () =>
      attempt(
        () =>
          measureComparisonTimeline(
            before,
            after,
            durations as [number, number],
            dir,
            ffmpeg,
            hasher,
            signal,
          ),
        signal,
      ),
    () => ({
      status: "unavailable" as const,
      message: "PDQ tools are not installed on this server.",
    }),
  );

  report.motion = await attempt(async () => {
    const results = [];
    for (const [side, file] of [before, after].entries()) {
      let squaredAcceleration = 0,
        validTriples = 0,
        rejectedPairs = 0;
      const windows =
        durations[side] < 1.25
          ? 1
          : Math.min(3, Math.floor(durations[side] / 1.25));
      for (let i = 0; i < windows; i++) {
        const start =
          windows === 1 ? 0 : ((durations[side] - 1.25) * i) / (windows - 1);
        const raw = `motion-${side}-${i}.gray`;
        await run(ffmpeg, [
          "-v",
          "error",
          "-nostdin",
          "-y",
          "-ss",
          String(start),
          "-i",
          file,
          "-map",
          "0:V:0",
          "-t",
          "1.25",
          "-vf",
          "fps=8,scale=64:64:flags=area",
          "-frames:v",
          "10",
          "-pix_fmt",
          "gray",
          "-f",
          "rawvideo",
          raw,
        ]);
        const bytes = await readFile(path.join(dir, raw));
        if (bytes.length % 4096) throw new Error("Incomplete motion frames.");
        const frames = Array.from({ length: bytes.length / 4096 }, (_, n) =>
          bytes.subarray(n * 4096, (n + 1) * 4096),
        );
        const result = motionWindow(frames);
        squaredAcceleration += result.squaredAcceleration;
        validTriples += result.validTriples;
        rejectedPairs += result.rejectedPairs;
      }
      results.push({
        jitter: validTriples
          ? Math.sqrt(squaredAcceleration / validTriples)
          : null,
        validTriples,
        rejectedPairs,
      });
    }
    return { fps: 8, analysisSize: 64, before: results[0], after: results[1] };
  }, signal);
  return report;
}
