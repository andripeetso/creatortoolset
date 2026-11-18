import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { ffmpegCommand } from "../../ffmpeg-runtime";
import { filePostMedia, postMediaFailed } from "../../instagram";
import { filePrints, type PrintsInput } from "../../lib/connectors/prints";
import { downloadToFile } from "../../lib/instagram/download";
import { dhashFromGray, fingerprintFrameTimes, HASH_H, HASH_W } from "../../lib/instagram/fingerprint";
import type { MediaFingerprint } from "../../lib/instagram/types";
import { frameSampleTimes } from "../../lib/instagram/vision";
import { phashPerSecond } from "../../library/fingerprint";
import { ffmpegTo } from "../../library/media/run";
import { soundArgs } from "../../library/transcribe";
import { taskKind } from "../tasks";
import { frameInto } from "./frames";

/**
 * Posts read from the internet, made ready to look at and compare, on one of the person's computers (or here where the
 * server's video work is on):
 * - `post-media`: a Content Analyzer post's slides as the server downloaded them: their length, sound and size, the
 *   preview pictures, the fingerprints that find the same media twice, and when its run asks for them the sound a
 *   transcript is heard from and the frames its slide text is read from. api/instagram.ts files what comes back.
 * - `posted-prints`: the person's own posted reels a login gives a media URL for (lib/connectors/prints.ts): each one's
 *   per-second pHashes, read from the URL, and its sound for the voice check. The server hears the sound on their key.
 */

const THUMB_MAX_BYTES = 8 * 1024 * 1024;

export interface PostMediaSlide {
  index: number;
  kind: "image" | "video";
  /** the input file's name (`files`) */
  file: string;
  durationS?: number;
  hasAudio?: boolean;
  /** the post's own cover picture (a fresh CDN address) for a video's preview */
  cover?: string;
  /** probe it and make its previews (`thumb`/`vision`: the server already has that one) */
  prepare?: boolean;
  thumb?: boolean;
  vision?: boolean;
  fingerprint?: boolean;
  wav?: boolean;
  frames?: boolean;
}
export interface PostMediaInput {
  post: string;
  slides: PostMediaSlide[];
  files: Record<string, string>;
  visionFrames: number;
}
export interface PostMediaDone {
  index: number;
  prepared?: true;
  durationS?: number;
  hasAudio?: boolean;
  width?: number;
  height?: number;
  fingerprint?: MediaFingerprint;
  /** the vision frames made, by their ms */
  frames?: number[];
}

const nn = (i: number) => String(i).padStart(2, "0");

function probe(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", ["-v", "error", ...args, file]);
    let out = "";
    const kill = setTimeout(() => {
      p.kill("SIGKILL");
      resolve(out.trim());
    }, 15_000);
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("close", () => {
      clearTimeout(kill);
      resolve(out.trim());
    });
    p.on("error", () => {
      clearTimeout(kill);
      resolve("");
    });
  });
}

const probeDuration = async (f: string) => Number(await probe(f, ["-show_entries", "format=duration", "-of", "csv=p=0"])) || 0;
const probeHasAudio = async (f: string) => (await probe(f, ["-select_streams", "a:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0"])).length > 0;
const probeSize = async (f: string): Promise<{ width: number; height: number }> => {
  const [w, h] = (await probe(f, ["-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0"])).split(",").map((n) => Number(n));
  return { width: w || 0, height: h || 0 };
};

function runFfmpeg(args: string[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args], { signal });
    let err = "";
    p.stderr.on("data", (d) => {
      err += d.toString();
      if (err.length > 4000) err = err.slice(-4000);
    });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `ffmpeg exited ${code}`))));
  });
}

/** Like runFfmpeg but returns what it writes to stdout (small outputs only). */
function ffmpegBytes(args: string[], signal: AbortSignal, maxBytes = 1 << 20): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], { signal });
    const chunks: Buffer[] = [];
    let size = 0;
    let err = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), 30_000);
    p.stdout.on("data", (d: Buffer) => {
      size += d.length;
      if (size <= maxBytes) chunks.push(d);
    });
    p.stderr.on("data", (d) => {
      err += d.toString();
      if (err.length > 2000) err = err.slice(-2000);
    });
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(err.trim() || `ffmpeg exited ${code}`));
    });
  });
}

const GRAY_TILE_ARGS = ["-frames:v", "1", "-vf", `scale=${HASH_W}:${HASH_H}:flags=area,format=gray`, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"];

async function grayTile(src: string, signal: AbortSignal, atS?: number): Promise<Uint8Array | null> {
  try {
    const seek = atS === undefined ? [] : ["-ss", atS.toFixed(2)];
    const buf = await ffmpegBytes([...seek, "-i", src, ...GRAY_TILE_ARGS], signal);
    const need = HASH_W * HASH_H;
    return buf.length >= need ? new Uint8Array(buf.subarray(0, need)) : null;
  } catch {
    return null;
  }
}

async function fingerprintOf(src: string, kind: "image" | "video", d: number, signal: AbortSignal): Promise<MediaFingerprint | undefined> {
  if (kind === "video") {
    const h: string[] = [];
    for (const t of fingerprintFrameTimes(d)) {
      const px = await grayTile(src, signal, t);
      if (px) h.push(dhashFromGray(px));
    }
    return h.length ? { h, d: Number(d.toFixed(2)) } : undefined;
  }
  const px = await grayTile(src, signal);
  return px ? { h: [dhashFromGray(px)] } : undefined;
}

taskKind<PostMediaInput, { slides: PostMediaDone[] }>("post-media", {
  serve: (t, name) => (t.input as PostMediaInput).files[name],
  async run(input, ctx) {
    const out: PostMediaDone[] = [];
    const files: string[] = [];
    for (const s of input.slides) {
      const src = await ctx.file(s.file);
      const r: PostMediaDone = { index: s.index };
      const n = nn(s.index);
      if (s.prepare) {
        r.prepared = true;
        if (s.kind === "video") {
          const [duration, hasAudio] = await Promise.all([probeDuration(src), probeHasAudio(src)]);
          if (duration) r.durationS = duration;
          r.hasAudio = hasAudio;
        }
        const size = await probeSize(src);
        if (size.width && size.height) Object.assign(r, size);
        if (!s.thumb) {
          const thumb = path.join(ctx.dir, `thumb-${n}.jpg`);
          let ok = false;
          if (s.kind === "video" && s.cover) {
            const tmp = `${thumb}.download`;
            try {
              await downloadToFile(s.cover, tmp, { maxBytes: THUMB_MAX_BYTES, signal: ctx.signal, fallbackMime: "image/jpeg" });
              await runFfmpeg(["-i", tmp, "-vf", "scale='min(720,iw)':-2", "-q:v", "4", thumb], ctx.signal);
              ok = true;
            } catch {
              /* fall back to a frame */
            } finally {
              await rm(tmp, { force: true }).catch(() => {});
            }
          }
          if (!ok) {
            const ss = s.kind === "video" ? ((r.durationS ?? s.durationS ?? 0) > 1 ? ["-ss", "0.5"] : ["-ss", "0"]) : [];
            ok = await runFfmpeg([...ss, "-i", src, ...(s.kind === "video" ? ["-frames:v", "1"] : []), "-vf", "scale='min(720,iw)':-2", "-q:v", "4", thumb], ctx.signal).then(() => true, () => false);
          }
          if (ok) files.push(`thumb-${n}.jpg`);
        }
        if (s.kind === "image" && !s.vision) {
          if (await runFfmpeg(["-i", src, "-vf", "scale='min(1280,iw)':-2", "-q:v", "3", path.join(ctx.dir, `vision-${n}.jpg`)], ctx.signal).then(() => true, () => false)) files.push(`vision-${n}.jpg`);
        }
      }
      const d = r.durationS ?? s.durationS ?? 0;
      if (s.fingerprint) {
        const fp = await fingerprintOf(src, s.kind, d, ctx.signal);
        if (fp) r.fingerprint = fp;
      }
      if (s.kind === "video" && s.wav && (r.hasAudio ?? s.hasAudio) !== false) {
        // one that cannot be cut leaves its transcript to fail on its own, as it did when it was cut here
        const wav = path.join(ctx.dir, `audio-${n}.wav`);
        if (await runFfmpeg(["-i", src, "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", wav], ctx.signal).then(() => true, () => false)) files.push(`audio-${n}.wav`);
      }
      if (s.kind === "video" && s.frames) {
        r.frames = [];
        for (const t of frameSampleTimes(d, input.visionFrames)) {
          const ms = Math.round(t * 1000);
          // a frame that cannot be read leaves its slide's text to fail as it did when it was read here
          if (await frameInto(src, ms, path.join(ctx.dir, `frame-${n}-${ms}.jpg`), {}, ctx.signal).then(() => true, () => false)) {
            files.push(`frame-${n}-${ms}.jpg`);
            r.frames.push(ms);
          }
        }
      }
      ctx.beat();
      out.push(r);
    }
    return { result: { slides: out }, files };
  },
  apply: (t, r, files) => filePostMedia(t.input, r.slides, files),
  failed: (t, e) => void postMediaFailed(t.input, e).catch(() => {}),
});

taskKind<PrintsInput, { prints: Record<string, string[]> }>("posted-prints", {
  async run(input, ctx) {
    const prints: Record<string, string[]> = {};
    const files: string[] = [];
    for (const [k, p] of input.posts.entries()) {
      // a post that can't be read is kept as an empty list, so it is not tried again
      if (p.print) prints[p.id] = await phashPerSecond(p.url).catch(() => []);
      if (p.voice) {
        const name = `sound-${k}.wav`;
        // the sound a transcript is heard from; a reel that has none is heard as saying nothing
        if (await ffmpegTo(path.join(ctx.dir, name), [...(/^https?:\/\//.test(p.url) ? ["-rw_timeout", "30000000"] : []), "-i", p.url, ...soundArgs(true)]).then(() => true, () => false)) files.push(name);
      }
      ctx.beat();
    }
    return { result: { prints }, files };
  },
  apply: (t, r, files) => filePrints(t.input, r.prints, Object.fromEntries(t.input.posts.flatMap((p, k) => (files[`sound-${k}.wav`] ? [[p.id, files[`sound-${k}.wav`]!]] : [])))),
});
