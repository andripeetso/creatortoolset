import { ffmpegTo } from "./run";
import { browserPlayable, type ProbeSummary } from "./probe";

/** A proxy is made only when the browser cannot play the source, or the source is above 1080p. */
/** Browsers play these sounds as they are. */
const PLAYABLE_AUDIO = ["aac", "mp3", "opus", "vorbis"];

/** A song with album art plays as it is when its sound does (the play route then serves the file itself). */
export function needsProxy(p: ProbeSummary): boolean {
  if (p.cover) return !PLAYABLE_AUDIO.includes(p.acodec);
  return !browserPlayable(p) || Math.min(p.width, p.height) > 1080;
}

/**
 * H.264 720p, CRF 26, AAC 128k, faststart. The short side is capped at 720 and never upscaled.
 * ponytail: one ffmpeg at a time is the caller's rule (the queue, S4+), not this function's.
 */
export function makeProxy(src: string, out: string, cover = false): Promise<void> {
  // a song with album art: its sound only (the mp4 muxer refuses the cover picture as a video stream)
  if (cover) return ffmpegTo(out, ["-i", src, "-map", "0:a:0", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-f", "mp4"]);
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
