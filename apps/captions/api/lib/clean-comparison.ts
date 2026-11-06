import path from "node:path";
import { readdir, rm } from "node:fs/promises";
import { comparisonTimeline } from "../../contracts/clean-comparison";
import { parsePdq, runFingerprintTool } from "./clean-fingerprints";
/** Denser temporal search, separate from vPDQ's existing 64-frame measurement. */
export async function measureComparisonTimeline(
  before: string,
  after: string,
  durations: [number, number],
  dir: string,
  ffmpeg: string,
  hasher: string,
  signal?: AbortSignal,
) {
  const samples: ReturnType<typeof parsePdq>[][] = [],
    intervals: number[] = [];
  const run = (cmd: string, args: string[]) =>
    runFingerprintTool(cmd, args, dir, 120_000, signal);
  for (const [side, file] of [before, after].entries()) {
    const interval = Math.max(0.25, durations[side] / 256);
    intervals.push(interval);
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
      "256",
      "-pix_fmt",
      "rgb24",
      "-start_number",
      "0",
      `timeline-${side}-%03d.ppm`,
    ]);
    let names = (await readdir(dir))
      .filter((n) => n.startsWith(`timeline-${side}-`) && n.endsWith(".ppm"))
      .sort();
    if (!names.length) {
      const name = `timeline-${side}-000.ppm`;
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
    const hashes = (await run(hasher, names))
      .trim()
      .split(/\r?\n/)
      .map(parsePdq);
    if (hashes.length !== names.length)
      throw new Error("Incomplete comparison timeline hashes.");
    samples.push(hashes);
    await Promise.all(
      names.map((name) => rm(path.join(dir, name), { force: true })),
    );
  }
  return comparisonTimeline(
    samples[0],
    samples[1],
    durations,
    intervals as [number, number],
  );
}
