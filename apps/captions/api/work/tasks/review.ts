import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ffmpegCommand } from "../../ffmpeg-runtime";
import { keep, taskKind } from "../tasks";

/**
 * Review frames (local-first P3c): the frame a comment is on, its drawing painted in, and the JPEG an AI reads of a
 * comment's reference. A frame is a picture, so processing (D7), even of an uploaded file the server serves for playback:
 * decision 5 keeps only the upload transcode on the server. A computer reads the version's file where it has it (`local`),
 * else downloads the server's copy.
 */
export const REVIEW_FRAME = "review-frame";

export interface Stroke {
  color: string;
  points: [number, number][];
}

export interface FrameInput {
  /** a reference's look (its kind); without it, the frame at `at`, `width` wide, `strokes` painted on */
  look?: "image" | "video";
  at?: number;
  width?: number;
  strokes?: Stroke[];
  /** server: the file it is cut from, and where the JPEG goes */
  src: string;
  out: string;
  paths?: { src?: string };
}

// frames are asked for on public share links: a version keeps this many, the newest
const FRAMES_KEPT = 50;

/** A file's length in seconds, 0 when ffprobe cannot say. */
function seconds(file: string): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
    let out = "";
    const kill = setTimeout(() => p.kill("SIGKILL"), 30_000);
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("error", () => resolve(0));
    p.on("close", () => {
      clearTimeout(kill);
      resolve(Number(out.trim()) || 0);
    });
  });
}

/** Paint strokes (0–1 points) onto an RGBA frame, about as thick as the page draws them. */
export function paintStrokes(rgba: Buffer, w: number, h: number, strokes: Stroke[]): void {
  const r = Math.max(2, Math.round(w / 200));
  const dot = (cx: number, cy: number, rgb: number[]) => {
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) rgba.set([...rgb, 255], (y * w + x) * 4);
      }
    }
  };
  for (const s of strokes) {
    const rgb = [1, 3, 5].map((i) => parseInt(s.color.slice(i, i + 2), 16));
    const pts = s.points.map(([x, y]) => [x * (w - 1), y * (h - 1)]);
    pts.forEach(([x, y], i) => {
      const [px, py] = pts[i - 1] ?? [x, y];
      const steps = Math.max(1, Math.ceil(Math.hypot(x - px, y - py) / (r / 2)));
      for (let k = 1; k <= steps; k++) dot(px + ((x - px) * k) / steps, py + ((y - py) * k) / steps, rgb);
    });
  }
}

/** ffmpeg with an optional stdin, its stdout as one buffer. */
function ffmpegPipe(args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", ...args]);
    const out: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.stderr.on("data", (d) => (err = (err + d.toString()).slice(-2000)));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(err || `ffmpeg ${code}`))));
    p.stdin.on("error", () => {}); // ffmpeg may exit before reading it all
    p.stdin.end(input);
  });
}

/** The frame at t as a JPEG `width` wide, with a comment's drawing painted on it. */
async function frameJpeg(file: string, t: number, width: number, strokes?: Stroke[]): Promise<Buffer> {
  // decoded (so rotated like the player) and scaled; its height follows from the bytes
  const rgba = await ffmpegPipe([
    "-ss", String(t), "-i", file, "-frames:v", "1",
    "-vf", `scale=${width}:-2`, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1",
  ]);
  const height = rgba.length / (width * 4);
  if (!Number.isInteger(height) || height < 1) throw new Error("No frame there");
  if (strokes) paintStrokes(rgba, width, height, strokes);
  return ffmpegPipe([
    "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-i", "pipe:0",
    "-frames:v", "1", "-q:v", "3", "-f", "image2", "-c:v", "mjpeg", "pipe:1",
  ], rgba);
}

/** What an AI reads of a reference: a still at most 1568 px, or one that
 *  moves as 9 frames spread across it in a 3×3 sheet. */
async function refLook(file: string, kind: "image" | "video"): Promise<Buffer> {
  const fit = (px: number) => `scale=w='min(${px},iw)':h='min(${px},ih)':force_original_aspect_ratio=decrease`;
  const duration = kind === "video" ? await seconds(file) : 0;
  const vf = kind === "image" ? fit(1568) : `fps=${duration > 0 ? 9 / duration : 1},${fit(512)},tile=3x3`;
  return ffmpegPipe(["-i", file, "-vf", vf, "-frames:v", "1", "-q:v", "3", "-c:v", "mjpeg", "-f", "image2", "pipe:1"]);
}

taskKind<FrameInput, null>(REVIEW_FRAME, {
  serve: (t, name) => (name === "src" ? (t.input as FrameInput).src : undefined),
  async run(input, ctx) {
    const src = await ctx.file("src");
    const jpeg = input.look ? await refLook(src, input.look) : await frameJpeg(src, input.at ?? 0, input.width ?? 540, input.strokes);
    await writeFile(path.join(ctx.dir, "out.jpg"), jpeg);
    return { result: null, files: ["out.jpg"] };
  },
  async apply(t, _r, files) {
    // its version or reference went meanwhile: nothing to file it beside
    if (!existsSync(t.input.src) || !files["out.jpg"]) return;
    await keep(files["out.jpg"], t.input.out);
    if (t.input.look) return;
    const dir = path.dirname(t.input.out);
    const all = await readdir(dir);
    if (all.length > FRAMES_KEPT) {
      for (const f of all) if (f !== path.basename(t.input.out)) await rm(path.join(dir, f), { force: true });
    }
  },
});
