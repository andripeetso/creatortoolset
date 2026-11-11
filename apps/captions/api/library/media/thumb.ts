import { ffmpegTo } from "./run";

/**
 * A 480 px-wide JPEG from the frame at 10% of the duration (1 s in when that fails, then the first frame). A song's
 * album art (`cover`) is read without a seek: any -ss, even 0, skips that one picture and ffmpeg writes nothing.
 * ponytail: the plan's "first good frame" is just the three seeks above; no scene scoring.
 */
export async function makeThumb(src: string, out: string, duration: number, cover = false): Promise<void> {
  if (cover) return ffmpegTo(out, ["-i", src, "-map", "0:v:0", "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4"]);
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
