import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { waveformPeaks } from "../../../src/lib/waveform-peaks";
import { DEVICE_AUDIO } from "../../lib/device-transcribe";
import { env } from "../../lib/env";
import { ffmpeg, withSignal } from "../../library/media/run";
import { taskKind } from "../tasks";

/**
 * Caption Studio's processing as computer tasks (work/tasks.ts): a clip's editing copy (ingest: the proxy, the size and
 * frame rate of the original, the project picker's picture) and the sound its auto-captions are heard from. Whichever
 * machine mayRunHere picks reads the original (where it has it, else from the server) and makes the files; the server
 * files them (projects.ts ingested, captions-job.ts captionsHeard). The words are heard on the server on the person's
 * key from the sound cut there (decision 12): nothing is decoded on the server for it.
 */

const clipDir = (project: string, clip: string) => path.join(env.dataDir, "projects", project, "clips", clip);
const here = (p: string) => (existsSync(p) ? p : undefined);

export type IngestInput = {
  /** the project that holds the clip's media (an admin copy shares its home's) */
  project: string;
  clip: string;
  /** the picture and the probe only, for a clip that has its editing copy (from the original, else that copy) */
  look?: boolean;
  /** the project whose clip gets the picture and the probe, when not `project` */
  into?: string;
  /** the computer that holds the original when the server has none; its path there is paths.original */
  device?: string;
  paths?: { original?: string };
};
export type Probe = { srcWidth: number; srcHeight: number; srcFps: number };

taskKind<IngestInput, Probe>("caption-ingest", {
  serve: (t, name) => {
    const { project, clip } = t.input as IngestInput;
    return name === "original" ? here(path.join(clipDir(project, clip), "original")) : name === "proxy" ? here(path.join(clipDir(project, clip), "proxy.mp4")) : undefined;
  },
  // placeTask asks with no input (tasks.ts): any computer may; the queued task itself names its computer
  can: (d, t) => !t.input?.device || d.id === t.input.device,
  async run(input, ctx) {
    let src: string;
    let fromProxy = false;
    try {
      src = await ctx.file("original");
    } catch (e) {
      if (!input.look) throw e;
      src = await ctx.file("proxy");
      fromProxy = true;
    }
    const files: string[] = [];
    await withSignal(ctx.signal, async () => {
      if (!input.look) {
        ctx.beat("Making the editing copy");
        // editing proxy: ≤720p CRF 25, light enough to stream, close enough to judge the picture. Audio is COPIED
        // whenever mp4 allows it: a bit-identical track can't drift out of sync the way a re-encode can
        const audioCodec = await probeAudioCodec(src);
        const audioArgs = ["aac", "mp3"].includes(audioCodec) ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "128k", "-af", "aresample=async=1:first_pts=0"];
        const vf = ["-vf", "scale=-2:floor(min(720\\,ih)/2)*2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "25", "-pix_fmt", "yuv420p"];
        await ffmpeg(["-i", src, ...vf, ...audioArgs, "-movflags", "+faststart", "-f", "mp4", path.join(ctx.dir, "proxy.mp4")]);
        files.push("proxy.mp4");
      }
      // a missing picture is made again on the next /thumb ask
      if (await makeThumb(src, path.join(ctx.dir, "thumb.jpg")).then(() => true, () => false)) files.push("thumb.jpg");
    });
    // the editing copy is smaller than the original: only its frame rate stands in for the original's
    const dims = fromProxy ? { width: 0, height: 0 } : await probeDims(src);
    return { result: { srcWidth: dims.width, srcHeight: dims.height, srcFps: await probeFps(src) }, files };
  },
  apply: async (t, probe, files) => (await import("../../projects")).ingested(t.input, probe, files),
  failed: (t, error) => console.warn(`[projects] editing copy ${t.input.project}/${t.input.clip} failed: ${error}`),
});

export type SoundInput = {
  project: string;
  clip: string;
  /** the cloud hears it (a WAV is made too), else This Mac's own model */
  cloud: boolean;
  /** the clip's length for the waveform (0: the sound's own) */
  seconds: number;
  /** the project's name, for the chat's line */
  name: string;
};
export type Sound = { peaks: number[]; seconds: number };
const RATE = 16000;

taskKind<SoundInput, Sound>("caption-sound", {
  serve: (t, name) => {
    const { project, clip } = t.input as SoundInput;
    return name === "original" ? here(path.join(clipDir(project, clip), "original")) : undefined;
  },
  async run(input, ctx) {
    const src = await ctx.file("original");
    ctx.beat("Preparing audio");
    // one cut: the samples (the waveform, and This Mac's own model) and, for the cloud, the WAV the browser would post
    const samples = path.join(ctx.dir, "audio.f32");
    const wav = path.join(ctx.dir, "audio.wav");
    const args = ["-i", src, ...DEVICE_AUDIO, samples, ...(input.cloud ? ["-vn", "-ac", "1", "-ar", String(RATE), "-f", "wav", wav] : [])];
    await withSignal(ctx.signal, () => ffmpeg(args)).catch((e: Error) => {
      if (/does not contain any stream/.test(e.message)) throw new Error("This file has no audio track");
      console.warn(`[captions] ${input.project}: the sound was not cut:`, e); // the log has the details, the chat one line
      throw new Error("Its sound could not be read");
    });
    const b = await readFile(samples);
    const n = b.byteLength >> 2;
    const pcm = b.byteOffset % 4 ? new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + n * 4)) : new Float32Array(b.buffer, b.byteOffset, n);
    const seconds = pcm.length / RATE;
    const peaks = Array.from(waveformPeaks(pcm, input.seconds || seconds), (v) => Math.round(v * 1000) / 1000);
    // the samples are only for This Mac's own model, which runs where the server is this computer
    const files = [...(input.cloud ? ["audio.wav"] : []), ...(ctx.where === "server" ? ["audio.f32"] : [])];
    return { result: { peaks, seconds }, files };
  },
  apply: async (t, sound, files) => (await import("../../captions-job")).captionsHeard(t.actor, t.input, sound, files),
  failed: (t, error) => void import("../../captions-job").then((m) => m.captionsFailed(t.actor, t.input, error)),
});

// ---- probes and the picture, moved from projects.ts ----

/** Probe the first audio stream's codec ("" when none / ffprobe fails). */
function probeAudioCodec(file: string): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", file]);
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("close", () => resolve(out.trim().toLowerCase()));
    p.on("error", () => resolve(""));
  });
}

/**
 * Probe a video's size as it is shown (0×0 when ffprobe fails). A phone clip filmed upright is stored lying down
 * with a quarter turn beside it: every player, the editing copy and a render show it turned, so that is its size.
 */
function probeDims(file: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    // a wedged file must never hang a task: killed after 10 s
    const p = spawn(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:stream_side_data=rotation:stream_tags=rotate", "-of", "default=noprint_wrappers=1", file],
      { timeout: 10_000 },
    );
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("close", () => {
      const n = (key: string) => Number(new RegExp(`^${key}=(-?[\\d.]+)`, "m").exec(out)?.[1]) || 0;
      const [w, h] = [n("width"), n("height")];
      // the turn is side data on today's ffprobe, a `rotate` tag on older ones
      const turned = Math.abs(n("rotation") || n("TAG:rotate")) % 180 === 90;
      resolve(turned ? { width: h, height: w } : { width: w, height: h });
    });
    p.on("error", () => resolve({ width: 0, height: 0 }));
  });
}

/** Nearest standard frame rate within 2%, else the raw value rounded. */
const STD_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 120];
function snapFps(raw: number): number {
  let best = STD_FPS[0]!;
  for (const s of STD_FPS) if (Math.abs(raw - s) < Math.abs(raw - best)) best = s;
  return Math.abs(raw - best) / best < 0.02 ? best : Math.round(raw * 100) / 100;
}

/** Probe a video's frame rate (0 when unknown / ffprobe fails). */
function probeFps(file: string): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate,avg_frame_rate", "-of", "default=noprint_wrappers=1", file], {
      timeout: 10_000,
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("close", () => {
      const rates: Record<string, number> = {};
      for (const line of out.trim().split("\n")) {
        const [k, v] = line.split("=");
        if (!k || !v) continue;
        const [num, den] = v.split("/").map(Number);
        rates[k] = den ? num! / den : Number(v) || 0;
      }
      // avg is the truth for variable-rate phone clips; r_ is the fallback
      const raw = [rates.avg_frame_rate, rates.r_frame_rate].find((v) => typeof v === "number" && v > 0 && v <= 480);
      resolve(raw ? snapFps(raw) : 0);
    });
    p.on("error", () => resolve(0));
  });
}

/** 320px JPEG for the project picker: 1 s in, the first frame as fallback. */
async function makeThumb(src: string, out: string): Promise<void> {
  const args = (seek: string[]) => [...seek, "-i", src, "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "5", out];
  try {
    await ffmpeg(args(["-ss", "1"]), true);
    if (statSync(out).size === 0) throw new Error("empty thumb");
  } catch {
    await ffmpeg(args([]), true);
  }
}
