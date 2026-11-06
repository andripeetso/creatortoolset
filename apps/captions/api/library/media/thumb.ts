import { ffmpegTo } from "./run";

/**
 * A 480 px-wide JPEG from the frame at 10% of the duration (1 s in when that fails, then the first frame).
 * ponytail: the plan's "first good frame" is just the three seeks above; no scene scoring.
 */
export async function makeThumb(src: string, out: string, duration: number): Promise<void> {
  const seeks = [duration * 0.1, 1, 0];
  let lastErr: unknown;
  for (const t of [...new Set(seeks)]) {
    try {
      await ffmpegTo(out, ["-ss", String(Math.max(0, t)), "-i", src, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4"]);
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}
