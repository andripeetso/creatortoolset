import { rm, stat } from "node:fs/promises";
import { ffmpegTo } from "./run";
import { browserPlayable, type ProbeSummary } from "./probe";
import { PROXY_QUALITIES, type ProxyQuality } from "../../../contracts/library";

/** A proxy is made only when the browser cannot play the source, or the source is above 1080p. */
/** Browsers play these sounds as they are. */
const PLAYABLE_AUDIO = ["aac", "mp3", "opus", "vorbis"];

/** A sound file (a song, with album art or none) plays as it is when its sound does (the play route then serves the file itself). */
export function needsProxy(p: ProbeSummary): boolean {
  if (p.cover || !p.vcodec) return !PLAYABLE_AUDIO.includes(p.acodec);
  return !browserPlayable(p) || Math.min(p.width, p.height) > 1080;
}

/**
 * Whether a clip gets a proxy: when the library keeps its proxies in the cloud, every video (not a still, not a song)
 * so a server elsewhere and the AI can work from them, and anything else the browser needs one for; else only what the
 * browser needs, while the library makes proxies.
 */
export function wantsProxy(p: ProbeSummary, opts: { cloud: boolean; on: boolean }): boolean {
  if (opts.cloud) return (!!p.vcodec && !p.cover && p.duration > 0) || needsProxy(p);
  return opts.on && needsProxy(p);
}

/**
 * The Proxy quality's encode (UNIFIED-PRD §4.1): short side capped and never upscaled, libx264 veryfast, the quality's CRF,
 * a video rate capped at the quality's max and at 0.8 × the source's rate, every sound track kept (in order, with its
 * channels and flags, so a reader that picks a track the way ffmpeg does hears the same one in the proxy as in the
 * original). Returns false, with no file left, when the proxy is not smaller than its source (rule 3): the source then
 * serves as its own light copy. `duration` (seconds) gives the source's rate; 0 leaves only the quality's cap.
 * shortcut: the rate uses the whole file's bitrate, not the video stream's, and audio is always 128k, not the source's
 * audio rate; upgrade when the probe keeps both.
 * ponytail: one ffmpeg at a time is the caller's rule (the queue, S4+), not this function's.
 * Colour stays as filmed (a camera's log curve too): the editor's viewer applies the log curve itself unless the file it
 * plays says it is converted (NleFile.log). A proxy that ever converts colour (Rec.709) must say `log: false` wherever its
 * url goes (urlOf, the drafts' proxies answer), or log footage is converted twice.
 */
export async function makeProxy(src: string, out: string, soundOnly = false, quality: ProxyQuality = "standard", duration = 0): Promise<boolean> {
  const bytes = (await stat(src)).size;
  const q = PROXY_QUALITIES.find((x) => x.value === quality) ?? PROXY_QUALITIES[1]!;
  const kbps = Math.max(100, Math.floor(Math.min(q.maxKbps, duration > 0 ? (0.8 * bytes * 8) / duration / 1000 : q.maxKbps)));
  // a sound file, or a song with album art: its sound only (the mp4 muxer refuses the cover picture as a video stream)
  if (soundOnly) await ffmpegTo(out, ["-i", src, "-map", "0:a", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-f", "mp4"]);
  else
    await ffmpegTo(out, [
      "-i", src,
      "-map", "0:v:0", "-map", "0:a?",
      // short side to the quality's cap at most, never upscaled, both sides kept even for libx264
      "-vf", `scale=w='trunc(min(iw,${q.short}*iw/min(iw,ih))/2)*2':h='trunc(min(ih,${q.short}*ih/min(iw,ih))/2)*2'`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", String(q.crf), "-pix_fmt", "yuv420p",
      // a keyframe every second: the editor's cuts and scrubbing seek to one at most a second away
      "-force_key_frames", "expr:gte(t,n_forced*1)",
      "-maxrate", `${kbps}k`, "-bufsize", `${kbps * 2}k`,
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart", "-f", "mp4",
    ]);
  if ((await stat(out)).size < bytes) return true;
  await rm(out, { force: true });
  return false;
}
