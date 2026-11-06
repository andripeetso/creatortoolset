import { ffmpegCommand } from "../ffmpeg-runtime";
import { runFingerprintTool } from "./clean-fingerprints";

export async function detectCuts(
  input: string,
  duration: number,
  threshold: number,
  signal: AbortSignal,
) {
  // Scene comparison is decoded once at a bounded image size, never encoded.
  const output = await runFingerprintTool(
    ffmpegCommand(),
    [
      "-v",
      "error",
      "-nostdin",
      "-i",
      input,
      "-map",
      "0:V:0",
      "-an",
      "-vf",
      `scale=320:-2,select='gt(scene,${threshold})',metadata=print:file=-`,
      "-f",
      "null",
      "-",
    ],
    undefined,
    120_000,
    signal,
  );
  const boundaries = [0];
  for (const match of output.matchAll(/pts_time:([\d.]+)/g)) {
    const t = Number(match[1]);
    if (t - boundaries[boundaries.length - 1] >= 0.15 && duration - t >= 0.15)
      boundaries.push(t);
  }
  const truncated = boundaries.length > 64;
  boundaries.splice(64);
  return {
    cuts: boundaries.map((start, i) => ({
      start,
      end: boundaries[i + 1] ?? duration,
    })),
    threshold,
    truncated,
  };
}
