import { ffmpegTo } from "./run";
import { browserPlayable, type ProbeSummary } from "./probe";

/** A proxy is made only when the browser cannot play the source, or the source is above 1080p. */
export function needsProxy(p: ProbeSummary): boolean {
  return !browserPlayable(p) || Math.min(p.width, p.height) > 1080;
}

/**
 * H.264 720p, CRF 26, AAC 128k, faststart. The short side is capped at 720 and never upscaled.
 * ponytail: one ffmpeg at a time is the caller's rule (the queue, S4+), not this function's.
 */
export function makeProxy(src: string, out: string): Promise<void> {
  return ffmpegTo(out, [
    "-i", src,
    "-map", "0:v:0", "-map", "0:a:0?",
    // short side to 720 at most, never upscaled, both sides kept even for libx264
    "-vf", "scale=w='trunc(min(iw,720*iw/min(iw,ih))/2)*2':h='trunc(min(ih,720*ih/min(iw,ih))/2)*2'",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart", "-f", "mp4",
  ]);
}
