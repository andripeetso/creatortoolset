import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ffmpegCommand } from "../ffmpeg-runtime";
import { env } from "../lib/env";
import type { TimedWord } from "../library/transcribe";
import { ffmpegSlot } from "../library/media/run";
import { faceModel, facesOf, SIZE, YUNET } from "./eyeline";

/**
 * Who talks when in a stretch of footage with several people in it: the faces in it (YuNet, eyeline.ts) looked at
 * LOOK_FPS times a second, each followed from frame to frame, and how much its mouth moves (a small patch under the
 * face's mouth points, set by its eyes so a turned or nodding head moves it along); then, for each run of words in the
 * transcript, the face whose mouth moves most while they are said, or nobody on screen when no mouth moves clearly
 * (someone off camera; a microphone held over the mouth reads the same). Turns change only where the words pause, and only when the next face moves its mouth clearly more
 * (SWITCH): no flicker between two people on a word or a nod. The people are Speaker 1, 2, … in the order they first
 * talk; a name is only ever the person's own (the AI never names anyone).
 *
 * Runs where the footage is read: the edit's draft step (engine.ts places it on a computer first). Looked at once per
 * stretch and kept (editor/cache), so a turn found again with other words reads no video.
 */

export const LOOK_FPS = 10;
/**
 * A mouth's movement over the footage's floor that counts as talking (the patch's mean change a frame, in deviations):
 * measured on interviews, people talking 0.3-0.8, listening 0.0-0.2.
 */
export const TALKING = 0.15;
/** What it costs to hand a turn to another face, in score × seconds: about a second of clearly more movement. */
export const SWITCH = 0.3;
/** Words closer than this are one run (a turn changes only between runs). */
export const RUN_GAP = 0.35;
const PATCH_W = 24;
const PATCH_H = 16;
const KEPT_V = 1;

/** A face in one frame: box as fractions of the picture, and its mouth's movement since the frame before (none: first seen). */
export interface SeenFace {
  x: number;
  y: number;
  w: number;
  h: number;
  /** the track it belongs to: one person while the camera holds */
  id: number;
  mouth?: number;
}

export interface SeenFrame {
  /** seconds in the source */
  t: number;
  faces: SeenFace[];
}

export interface Turn {
  /** seconds in the source */
  s: number;
  e: number;
  /** 1, 2, … in the order they first talk; 0 = nobody on screen (someone off camera) */
  speaker: number;
}

export interface Speakers {
  turns: Turn[];
  /** each speaker's track ids: speaker n's face is a face of one of these */
  tracks: Record<number, number[]>;
}

type Face = { x: number; y: number; w: number; h: number; kps?: number[] };
type Track = { t: number; f: Face; kps?: number[]; patch?: Float32Array };
/** How much of a face's new landmarks a track takes each frame: the rest is where they were, so the patch holds still. */
const STEADY = 0.3;

/**
 * Faces of one frame put on the tracks of the frames before: each to the nearest track's last place within 60 % of its
 * width, seen in the last second. Each track's landmarks are smoothed over its frames (STEADY): the detector's points
 * jitter by a pixel or two, and a patch read where they jitter to changes all over though the mouth did not. The
 * mouth's movement is the mean change of its patch (`read`, at the smoothed points) since its track's frame before,
 * when that was the frame just before. Changes `tracks` in place.
 */
export function follow(
  t: number,
  faces: Face[],
  tracks: Map<number, Track>,
  next: { id: number },
  read?: (kps: number[]) => Float32Array,
): SeenFace[] {
  const out: SeenFace[] = [];
  const free = new Set(tracks.keys());
  const pairs: { d: number; i: number; id: number }[] = [];
  faces.forEach((f, i) => {
    for (const [id, tr] of tracks) {
      if (t - tr.t > 1) continue;
      const d = Math.hypot(f.x + f.w / 2 - tr.f.x - tr.f.w / 2, f.y + f.h / 2 - tr.f.y - tr.f.h / 2);
      if (d < 0.6 * Math.max(f.w, tr.f.w)) pairs.push({ d, i, id });
    }
  });
  const taken = new Map<number, number>();
  for (const p of pairs.sort((a, b) => a.d - b.d)) if (!taken.has(p.i) && free.has(p.id)) (taken.set(p.i, p.id), free.delete(p.id));
  faces.forEach((f, i) => {
    const id = taken.get(i) ?? next.id++;
    const before = tracks.get(id);
    const going = !!before && t - before.t < 1.5 / LOOK_FPS;
    const kps = f.kps && (going && before.kps ? f.kps.map((v, k) => before.kps![k]! + STEADY * (v - before.kps![k]!)) : f.kps);
    const patch = kps && read?.(kps);
    let mouth: number | undefined;
    if (going && patch && before.patch) {
      let d = 0;
      for (let k = 0; k < patch.length; k++) d += Math.abs(patch[k]! - before.patch[k]!);
      mouth = d / patch.length;
    }
    tracks.set(id, { t, f, kps, patch });
    out.push({ x: f.x, y: f.y, w: f.w, h: f.h, id, ...(mouth !== undefined ? { mouth } : {}) });
  });
  return out;
}

const quantile = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * q)] ?? 0;

/** Runs of words with no pause of RUN_GAP in them, as [start, end] seconds. */
export function runsOf(words: Pick<TimedWord, "s" | "e">[]): [number, number][] {
  const runs: [number, number][] = [];
  for (const w of [...words].sort((a, b) => a.s - b.s)) {
    const last = runs.at(-1);
    if (last && w.s - last[1] < RUN_GAP) last[1] = Math.max(last[1], w.e);
    else runs.push([w.s, w.e]);
  }
  return runs;
}

/**
 * The turns: per run of words, each track seen through at least half of it scores its mouth's mean movement over the
 * footage's floor (the 10th percentile of every mouth in it); nobody on screen scores TALKING. Faces are measured
 * against each other in the same words, never against a level of their own: a quiet level taken in the pauses is
 * spoiled by breaths and by words the transcript times a little off. The cheapest path through the runs (score × seconds, SWITCH per
 * change of face) is who said each; runs of one person in a row are one turn.
 */
export function turnsOf(frames: SeenFrame[], words: Pick<TimedWord, "s" | "e">[]): Speakers {
  const runs = runsOf(words);
  const byTrack = new Map<number, { t: number; m: number }[]>();
  for (const fr of frames) for (const f of fr.faces) if (f.mouth !== undefined) (byTrack.get(f.id) ?? byTrack.set(f.id, []).get(f.id)!).push({ t: fr.t, m: f.mouth });
  // the footage's own floor: how much a still mouth seems to move in it (the detector's jitter, the compression)
  const floor = quantile([...byTrack.values()].flat().map((x) => x.m), 0.1);
  // per run: state → score (0 = nobody on screen)
  const scores = runs.map(([s, e]) => {
    const out = new Map<number, number>([[0, TALKING]]);
    const want = Math.max(1, (e - s) * LOOK_FPS * 0.5);
    for (const [id, xs] of byTrack) {
      const inRun = xs.filter((x) => x.t >= s && x.t <= e);
      if (inRun.length >= want) out.set(id, inRun.reduce((n, x) => n + x.m, 0) / inRun.length - floor);
    }
    return out;
  });
  // the cheapest path: cost = -score × seconds, SWITCH per change
  type Step = { cost: number; from: number | null };
  const table: Map<number, Step>[] = [];
  scores.forEach((sc, i) => {
    const dur = Math.max(0.2, runs[i]![1] - runs[i]![0]);
    const row = new Map<number, Step>();
    for (const [k, v] of sc) {
      let best: Step = { cost: -v * dur, from: null };
      if (i > 0)
        for (const [j, p] of table[i - 1]!) {
          const c = p.cost + (j === k ? 0 : SWITCH) - v * dur;
          if (best.from === null || c < best.cost) best = { cost: c, from: j };
        }
      row.set(k, best);
    }
    table.push(row);
  });
  const who: number[] = [];
  let k: number | undefined = [...(table.at(-1) ?? new Map<number, Step>())].sort((a, b) => a[1].cost - b[1].cost)[0]?.[0];
  for (let i = table.length - 1; i >= 0 && k !== undefined; i--) {
    who[i] = k;
    k = table[i]!.get(k)!.from ?? undefined;
  }
  // tracks → Speaker n, in the order they first talk
  const number = new Map<number, number>();
  const turns: Turn[] = [];
  runs.forEach(([s, e], i) => {
    const id = who[i] ?? 0;
    if (id && !number.has(id)) number.set(id, number.size + 1);
    const speaker = id ? number.get(id)! : 0;
    const last = turns.at(-1);
    if (last && last.speaker === speaker) last.e = e;
    else turns.push({ s, e, speaker });
  });
  const tracks: Record<number, number[]> = {};
  for (const [id, n] of number) (tracks[n] ??= []).push(id);
  return { turns, tracks };
}

/**
 * The mouth patch of a face: PATCH_W × PATCH_H grey samples around the mouth's corners, as wide as the eyes are apart
 * and turned with them, normalised (mean 0, deviation 1) so light changes don't read as talking. `px`: BGR, w × h.
 */
export function mouthPatch(px: Uint8Array, w: number, h: number, kps: number[]): Float32Array {
  const [ex, ey] = [kps[2]! - kps[0]!, kps[3]! - kps[1]!];
  const eye = Math.hypot(ex, ey) || 1;
  const [ux, uy] = [ex / eye, ey / eye];
  const [vx, vy] = [-uy, ux];
  const cx = (kps[6]! + kps[8]!) / 2 + vx * 0.1 * eye;
  const cy = (kps[7]! + kps[9]!) / 2 + vy * 0.1 * eye;
  const out = new Float32Array(PATCH_W * PATCH_H);
  const grey = (x: number, y: number) => {
    const [xi, yi] = [Math.min(w - 1, Math.max(0, Math.round(x))), Math.min(h - 1, Math.max(0, Math.round(y)))];
    const o = (yi * w + xi) * 3;
    return 0.114 * px[o]! + 0.587 * px[o + 1]! + 0.299 * px[o + 2]!;
  };
  let sum = 0;
  for (let j = 0; j < PATCH_H; j++)
    for (let i = 0; i < PATCH_W; i++) {
      const a = (i / (PATCH_W - 1) - 0.5) * 1.1 * eye;
      const b = (j / (PATCH_H - 1) - 0.5) * 0.75 * eye;
      sum += out[j * PATCH_W + i] = grey(cx + ux * a + vx * b, cy + uy * a + vy * b);
    }
  const mean = sum / out.length;
  let v = 0;
  for (let k = 0; k < out.length; k++) v += (out[k]! - mean) ** 2;
  const sd = Math.sqrt(v / out.length) || 1;
  for (let k = 0; k < out.length; k++) out[k] = (out[k]! - mean) / sd;
  return out;
}

/**
 * The faces in `src` from `a` to `b` seconds, LOOK_FPS frames a second: decoded at twice the model's picture (the
 * mouths are read there), halved into its 640 × 640 canvas. `dims`: the picture as shown.
 */
export function watchFaces(src: string, a: number, b: number, dims: { w: number; h: number }, signal?: AbortSignal): Promise<SeenFrame[]> {
  return ffmpegSlot(async () => {
    const model = await faceModel();
    const ort = await import("onnxruntime-node");
    const k = SIZE / Math.max(dims.w, dims.h);
    const [pw, ph] = [Math.max(2, Math.round((dims.w * k) / 2) * 2), Math.max(2, Math.round((dims.h * k) / 2) * 2)];
    const [W, H] = [pw * 2, ph * 2];
    const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", String(a), "-i", src, "-t", String(Math.max(0.1, b - a)), "-an", "-vf", `fps=${LOOK_FPS},scale=${W}:${H}`, "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1"];
    const p = spawn(ffmpegCommand(), args, { signal, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err = (err + d.toString()).slice(-2000)));
    const done = new Promise<number | null>((res, rej) => (p.on("error", rej), p.on("close", res)));
    const size = W * H * 3;
    const n = SIZE * SIZE;
    const canvas = new Float32Array(n * 3);
    const tracks = new Map<number, Track>();
    const next = { id: 1 };
    const frames: SeenFrame[] = [];
    const px = new Uint8Array(size);
    let have = 0;
    for await (const chunk of p.stdout as AsyncIterable<Buffer>) {
      for (let at = 0; at < chunk.length; ) {
        const take = Math.min(size - have, chunk.length - at);
        px.set(chunk.subarray(at, at + take), have);
        (have += take), (at += take);
        if (have < size) break;
        have = 0;
        canvas.fill(0);
        for (let y = 0; y < ph; y++)
          for (let x = 0; x < pw; x++) {
            const o = (2 * y * W + 2 * x) * 3;
            for (let c = 0; c < 3; c++) canvas[c * n + y * SIZE + x] = (px[o + c]! + px[o + 3 + c]! + px[o + W * 3 + c]! + px[o + W * 3 + 3 + c]!) / 4;
          }
        const found = facesOf(await model.run({ input: new ort.Tensor("float32", canvas, [1, 3, SIZE, SIZE]) }));
        const t = a + frames.length / LOOK_FPS;
        const faces = found.map((f) => ({ x: f.x / pw, y: f.y / ph, w: f.w / pw, h: f.h / ph, kps: f.kps.map((v) => v * 2) }));
        frames.push({ t: Math.round(t * 1000) / 1000, faces: follow(t, faces, tracks, next, (kps) => mouthPatch(px, W, H, kps)) });
      }
    }
    const code = await done;
    if (code !== 0) throw new Error(err.trim() || `ffmpeg exited ${code}`);
    return frames;
  });
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
export const speakersFile = (versionId: string, a: number, b: number) => path.join(env.dataDir, "editor", "cache", `${versionId}.faces.${a.toFixed(2)}-${b.toFixed(2)}.json`);

/** The faces of a source's stretch a..b s, from the cache or looked at once and kept. */
export async function facesIn(versionId: string, src: () => Promise<string>, a: number, b: number, dims: { w: number; h: number }, signal?: AbortSignal, watch = watchFaces): Promise<SeenFrame[]> {
  const file = speakersFile(versionId, a, b);
  const kept = JSON.parse(await readFile(file, "utf8").catch(() => "null")) as { v: number; model: string; frames: SeenFrame[] } | null;
  if (kept?.v === KEPT_V && kept.model === YUNET.sha256) return kept.frames;
  const frames = (await watch(await src(), a, b, dims, signal)).map((fr) => ({
    t: fr.t,
    faces: fr.faces.map((f) => ({ x: r3(f.x), y: r3(f.y), w: r3(f.w), h: r3(f.h), id: f.id, ...(f.mouth !== undefined ? { mouth: r3(f.mouth) } : {}) })),
  }));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.part`, JSON.stringify({ v: KEPT_V, model: YUNET.sha256, frames }));
  await rename(`${file}.part`, file);
  return frames;
}
