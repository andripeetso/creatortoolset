import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InferenceSession } from "onnxruntime-node";
import { ffmpegCommand } from "../ffmpeg-runtime";
import { hfApp, OWN_COPY } from "../hfproxy";
import { deviceTranscribes, modelsDir } from "../lib/device-transcribe";
import { env } from "../lib/env";
import { ffmpegSlot } from "../library/media/run";

/**
 * The speaker's eye line, found on this computer: a small face model (YuNet, MIT, 232 KB) looks at a few frames of a
 * source and gives the height of the eyes as a fraction of the picture's. Only where the server transcribes by itself
 * (deviceTranscribes: one person's own computer, never a hosted server); nothing is sent anywhere. Found once per
 * source version and kept. A line the person set wins over it, and a source with none found keeps DEFAULT_EYELINE.
 */

export const YUNET = {
  url: "/opencv/face_detection_yunet/resolve/3cc26e7f1014a5ee5d74a42acee58bafc9d0a310/face_detection_yunet_2023mar.onnx",
  sha256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
};
const SIZE = 640;
const STRIDES = [8, 16, 32];
const MIN_SCORE = 0.6;
/** Where along the clip the frames are taken. */
const AT = [0.2, 0.5, 0.8];
/** A found line outside this band is not a speaker's eyes in a talking-head shot: the default stays. */
export const SANE: [number, number] = [0.15, 0.6];

export const saneEyeline = (y: number | null | undefined): number | null => (typeof y === "number" && y >= SANE[0] && y <= SANE[1] ? y : null);

/**
 * The eyes' height in the biggest face of one frame, in canvas px, from YuNet's outputs (OpenCV's FaceDetectorYN
 * decode): per stride, a score sqrt(cls × obj), a box and five points, the eyes first.
 */
export function eyesOf(out: Record<string, { data: unknown }>): number | null {
  let best: { area: number; y: number } | null = null;
  for (const s of STRIDES) {
    const cols = SIZE / s;
    const cls = out[`cls_${s}`]!.data as Float32Array;
    const obj = out[`obj_${s}`]!.data as Float32Array;
    const box = out[`bbox_${s}`]!.data as Float32Array;
    const kps = out[`kps_${s}`]!.data as Float32Array;
    for (let i = 0; i < cls.length; i++) {
      const clamp = (x: number) => Math.min(1, Math.max(0, x));
      if (Math.sqrt(clamp(cls[i]!) * clamp(obj[i]!)) < MIN_SCORE) continue;
      const area = Math.exp(box[i * 4 + 2]!) * Math.exp(box[i * 4 + 3]!) * s * s;
      const r = Math.floor(i / cols);
      const y = ((kps[i * 10 + 1]! + r) * s + (kps[i * 10 + 3]! + r) * s) / 2;
      if (!best || area > best.area) best = { area, y };
    }
  }
  return best?.y ?? null;
}

const modelFile = () => path.join(modelsDir(), "opencv", "face_detection_yunet", path.basename(YUNET.url));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** The model's bytes: kept with the person's data, fetched once through the server's model route (its mirror fallback). */
async function modelBytes(): Promise<Uint8Array> {
  const kept = await readFile(modelFile()).catch(() => null);
  if (kept && sha(kept) === YUNET.sha256) return kept;
  const r = await hfApp.request(YUNET.url, { headers: { [OWN_COPY]: "1" } });
  if (!r.ok) throw new Error(`The face model could not be fetched (${r.status})`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (sha(bytes) !== YUNET.sha256) throw new Error("The face model's checksum does not match");
  await mkdir(path.dirname(modelFile()), { recursive: true });
  await writeFile(`${modelFile()}.part`, bytes);
  await rename(`${modelFile()}.part`, modelFile());
  return bytes;
}

// ponytail: kept loaded for the server's life (a few MB); give it back on idle if memory ever matters
let session: Promise<InferenceSession> | undefined;
const load = () =>
  (session ??= (async () => {
    const ort = await import("onnxruntime-node");
    return ort.InferenceSession.create(await modelBytes(), { executionProviders: ["cpu"], intraOpNumThreads: 2, interOpNumThreads: 1 });
  })().catch((e) => {
    session = undefined;
    throw e;
  }));

/** One frame at `t` seconds, upright, fitted into the top-left of a 640×640 black canvas, as BGR 0..255 planes (the model's input). */
function frameAt(src: string, t: number, signal?: AbortSignal): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const vf = `scale=${SIZE}:${SIZE}:force_original_aspect_ratio=decrease,pad=${SIZE}:${SIZE}:0:0:black`;
    const p = spawn(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", String(t), "-i", src, "-frames:v", "1", "-vf", vf, "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1"], { signal });
    const parts: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (d: Buffer) => parts.push(d));
    p.stderr.on("data", (d) => (err = (err + d.toString()).slice(-2000)));
    p.on("error", reject);
    p.on("close", (code) => {
      const px = Buffer.concat(parts);
      if (code !== 0 || px.length !== SIZE * SIZE * 3) return reject(new Error(err.trim() || `ffmpeg exited ${code}`));
      const n = SIZE * SIZE;
      const planes = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) planes[c * n + i] = px[i * 3 + c]!;
      resolve(planes);
    });
  });
}

/**
 * The eye line of the video at `src` (w×h upright, `duration` seconds): the median of the frames where a face is found,
 * or null when none is. Runs in the server's ffmpeg limit.
 */
export function findEyeline(src: string, dims: { w: number; h: number; duration: number }, signal?: AbortSignal): Promise<number | null> {
  return ffmpegSlot(async () => {
    const model = await load();
    const ort = await import("onnxruntime-node");
    const picH = dims.h >= dims.w ? SIZE : (SIZE * dims.h) / dims.w;
    const found: number[] = [];
    for (const f of AT) {
      signal?.throwIfAborted();
      const input = new ort.Tensor("float32", await frameAt(src, dims.duration * f, signal), [1, 3, SIZE, SIZE]);
      const y = eyesOf(await model.run({ input }));
      if (y !== null) found.push(y / picH);
    }
    found.sort((a, b) => a - b);
    return found.length ? found[found.length >> 1]! : null;
  });
}

export const eyelineFile = (versionId: string) => path.join(env.dataDir, "editor", "cache", `${versionId}.eyeline.json`);

/**
 * A version's found eye line, inside the sane band, or null: from the cache, else looked for once and kept (no face
 * is kept too). Never on a server that does not transcribe by itself. A failure (no model, offline, a bad frame) is
 * not kept, so the next analyze looks again, and never stops the edit.
 */
export async function eyelineOf(
  versionId: string,
  src: () => Promise<string>,
  dims: { w: number; h: number; duration: number },
  signal?: AbortSignal,
  find = findEyeline,
): Promise<number | null> {
  const file = eyelineFile(versionId);
  const kept = JSON.parse(await readFile(file, "utf8").catch(() => "null")) as { model: string; y: number | null } | null;
  if (kept?.model === YUNET.sha256) return saneEyeline(kept.y);
  if (!deviceTranscribes()) return null;
  try {
    const y = await find(await src(), dims, signal);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(`${file}.part`, JSON.stringify({ model: YUNET.sha256, y }));
    await rename(`${file}.part`, file);
    return saneEyeline(y);
  } catch (e) {
    if (!signal?.aborted) console.warn("[editor] eye line not found:", e);
    return null;
  }
}
