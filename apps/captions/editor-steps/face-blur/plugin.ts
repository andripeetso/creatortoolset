import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Timeline } from "../../contracts/editor";
import { anyVisionConfigured, completeVisionWithFallback } from "../../api/ai-vision";
import { engineRun, ensureMediapipe } from "../../api/editor/mediapipe";
import { ffmpegCommand } from "../../api/ffmpeg-runtime";
import { env } from "../../api/lib/env";
import { definePlugin, type EditorStepInput } from "../../api/lib/plugin";
import { ffmpeg, ffmpegSlot } from "../../api/library/media/run";
import { ENGINE } from "./engine";

/**
 * Blur faces, an AI Editor step: the faces the person asks for ("every face except the person speaking", "the
 * people in the background") blurred or pixelated in every video the cut shows, the speaker's (V1) and the B-roll
 * (V2), on this computer. MediaPipe finds the faces (engine.ts, in the face steps' shared Python), they are followed
 * from frame to frame into tracks, and the person's own AI looks at a few pictures of each track and says which ones
 * match what they wrote. The copy is the whole file again (ProRes, the source's sound and timecode).
 */

/** frames either side of what the cut shows, for trims; ranges of one file closer than JOIN become one */
export const HANDLE = 25;
export const JOIN = 50;
/** a track goes on through this many frames without its face; a blur holds this long before and after its track */
export const GAP = 12;
export const HOLD = 6;
/** a track with fewer detections than this is a flicker, not a face */
export const MIN_SEEN = 3;
/** the ellipse around a face box: wider and taller than the box (forehead, hair, chin), a little above its centre */
export const ELLIPSE = { rx: 0.65, ry: 0.8, up: 0.05 };
export const DEFAULT_WHO = "Every face except the person speaking";
const PER_CALL = 10; // tracks (one picture each) per question to the AI
const VERSION = "1"; // the tracking and ellipse maths here: a change makes new copies
const MODEL = {
  name: "blaze_face_short_range.tflite",
  url: "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
  sha256: "b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f",
};
const IMAGE = /\.(jpe?g|png|heic|heif|webp|gif|tiff?)$/i;
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

export type Box = [x: number, y: number, w: number, h: number, score: number];
export interface Track {
  id: string;
  src: string;
  /** detected boxes by source frame */
  boxes: Map<number, Box>;
}

const spans = (list: [number, number][]): [number, number][] => {
  const sorted = [...list].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const m = out[out.length - 1];
    if (m && a - m[1] < JOIN) m[1] = Math.max(m[1], b);
    else out.push([a, b]);
  }
  return out;
};

/** {source id: [[first, end)]} in source frames: every video the cut shows, V1 where B-roll doesn't cover it and V2, HANDLE either side, close ones joined. */
export function blurRanges(tl: Timeline): Record<string, [number, number][]> {
  const covers = (tl.tracks.V2?.items ?? []).map((i) => [i.rec, i.rec + i.len] as const).sort((a, b) => a[0] - b[0]);
  const out: Record<string, [number, number][]> = {};
  const add = (src: string, first: number, last: number) => {
    const s = tl.sources[src]!;
    const [a, b] = [Math.max(0, first - HANDLE), Math.min(s.dur || Infinity, last + HANDLE)];
    if (b > a) (out[src] ??= []).push([a, b]);
  };
  for (const [track, cover] of [["V1", true], ["V2", false]] as const) {
    for (const it of tl.tracks[track]?.items ?? []) {
      const src = tl.sources[it.src];
      if (!src || !(src.w > 0)) continue;
      const k = (src.fps || tl.fps) / tl.fps;
      let at = it.rec;
      const end = it.rec + it.len;
      for (const [a, b] of cover ? covers : []) {
        if (b <= at || a >= end) continue;
        if (a > at) add(it.src, it.in + Math.floor((at - it.rec) * k), it.in + Math.ceil((a - it.rec) * k));
        at = Math.max(at, b);
      }
      if (at < end) add(it.src, it.in + Math.floor((at - it.rec) * k), it.in + Math.ceil((end - it.rec) * k));
    }
  }
  for (const id of Object.keys(out)) out[id] = spans(out[id]!);
  return out;
}

const iou = (a: Box, b: Box) => {
  const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  return (ix * iy) / (a[2] * a[3] + b[2] * b[3] - ix * iy || 1);
};
/** how well a box goes on a track's last one: overlap, or a centre close by for a face that moved fast */
const fit = (a: Box, b: Box) => {
  const o = iou(a, b);
  if (o > 0.2) return o;
  const d = Math.hypot(a[0] + a[2] / 2 - (b[0] + b[2] / 2), a[1] + a[3] / 2 - (b[1] + b[3] / 2));
  const size = Math.max(a[2], b[2]);
  return d < 0.5 * size && Math.max(a[2], b[2]) < 2 * Math.min(a[2], b[2]) ? 0.1 : 0;
};

/** Boxes per frame (the engine's) into face tracks: each box goes on the best-fitting track seen less than GAP frames ago, or starts one. */
export function buildTracks(src: string, dets: Record<string, Box[]>): Omit<Track, "id">[] {
  const frames = Object.keys(dets).map(Number).sort((a, b) => a - b);
  const all: { boxes: Map<number, Box>; last: number }[] = [];
  for (const f of frames) {
    const live = all.filter((t) => f - t.last <= GAP);
    const pairs = dets[String(f)]!.flatMap((b, bi) => live.map((t, ti) => ({ bi, ti, s: fit(t.boxes.get(t.last)!, b) }))).filter((p) => p.s > 0).sort((a, b) => b.s - a.s);
    const usedB = new Set<number>();
    const usedT = new Set<number>();
    for (const p of pairs) {
      if (usedB.has(p.bi) || usedT.has(p.ti)) continue;
      usedB.add(p.bi);
      usedT.add(p.ti);
      live[p.ti]!.boxes.set(f, dets[String(f)]![p.bi]!);
      live[p.ti]!.last = f;
    }
    dets[String(f)]!.forEach((b, bi) => usedB.has(bi) || all.push({ boxes: new Map([[f, b]]), last: f }));
  }
  return all.filter((t) => t.boxes.size >= MIN_SEEN).map((t) => ({ src, boxes: t.boxes }));
}

/** The track's box at every frame from HOLD before its first to HOLD after its last: detections, straight lines between them, the nearest at the ends; averaged over ±2 frames so the blur doesn't shake. */
export function trackBoxes(t: Pick<Track, "boxes">, frames: number): Map<number, Box> {
  const seen = [...t.boxes.keys()].sort((a, b) => a - b);
  const first = seen[0]!;
  const last = seen[seen.length - 1]!;
  const raw = new Map<number, Box>();
  let j = 0;
  for (let f = Math.max(0, first - HOLD); f <= Math.min(frames - 1, last + HOLD); f++) {
    while (j < seen.length - 1 && seen[j + 1]! <= f) j++;
    const a = seen[j]!;
    const b = seen[Math.min(j + 1, seen.length - 1)]!;
    const A = t.boxes.get(a)!;
    const B = t.boxes.get(b)!;
    const k = f <= a ? 0 : f >= b ? 1 : (f - a) / (b - a);
    raw.set(f, A.map((v, i) => v + (B[i]! - v) * k) as Box);
  }
  const out = new Map<number, Box>();
  for (const f of raw.keys()) {
    const near = [-2, -1, 0, 1, 2].map((d) => raw.get(f + d)).filter((x): x is Box => !!x);
    out.set(f, [0, 1, 2, 3, 4].map((i) => near.reduce((s, x) => s + x[i]!, 0) / near.length) as Box);
  }
  return out;
}

/** The ellipse [cx, cy, rx, ry] that covers a face box whole, in the frame's pixels. */
export const ellipseOf = ([x, y, w, h]: Box): [number, number, number, number] =>
  [x + w / 2, y + h / 2 - ELLIPSE.up * h, w * ELLIPSE.rx, h * ELLIPSE.ry].map((v) => Math.round(v * 10) / 10) as [number, number, number, number];

/** {frame: ellipses} for the engine: every chosen track's ellipse at every frame it covers. */
export function ellipses(tracks: Pick<Track, "boxes">[], frames: number): Record<string, number[][]> {
  const out: Record<string, number[][]> = {};
  for (const t of tracks) for (const [f, b] of trackBoxes(t, frames)) (out[String(f)] ??= []).push(ellipseOf(b));
  return out;
}

/** The frames a track's pictures come from: the clearest (score × size) of each third of it. */
export function pickFrames(t: Pick<Track, "boxes">, n = 3): number[] {
  const seen = [...t.boxes.keys()].sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const part = seen.slice(Math.floor((i * seen.length) / n), Math.floor(((i + 1) * seen.length) / n));
    const best = part.sort((a, b) => clear(t.boxes.get(b)!) - clear(t.boxes.get(a)!))[0];
    if (best !== undefined && !out.includes(best)) out.push(best);
  }
  return out.sort((a, b) => a - b);
}
const clear = (b: Box) => b[4] * Math.sqrt(b[2] * b[3]);

/** The track ids the AI's answer names, of those asked about ({"blur": ["T1", …]}, also inside other text). */
export function chosenIn(text: string, ids: string[]): Set<string> {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Error("The AI's answer had no JSON");
  const blur = (JSON.parse(m[0]) as { blur?: unknown }).blur;
  if (!Array.isArray(blur)) throw new Error('The AI\'s answer had no "blur" list');
  return new Set(blur.map(String).filter((id) => ids.includes(id)));
}

/** What the AI is told about each track, in words: which footage, whether it is the speaker, where, how big, how long. */
export function describe(t: Track, info: { w: number; h: number; fps: number }, role: "speaker" | "broll", speaker: boolean): string {
  const boxes = [...t.boxes.values()];
  const avg = (i: number) => boxes.reduce((s, b) => s + b[i]!, 0) / boxes.length;
  const cx = (avg(0) + avg(2) / 2) / info.w;
  const cy = (avg(1) + avg(3) / 2) / info.h;
  const where = `${cy < 0.33 ? "top" : cy > 0.67 ? "bottom" : "middle"} ${cx < 0.33 ? "left" : cx > 0.67 ? "right" : "centre"}`;
  const frames = [...t.boxes.keys()];
  const secs = (Math.max(...frames) - Math.min(...frames) + 1) / (info.fps || 25);
  const who = role === "speaker" ? (speaker ? "the speaker's footage (V1); this is the person speaking to camera: the largest face there, on screen most of the time" : "the speaker's footage (V1), not the speaker") : "B-roll (V2)";
  return `${t.id}: ${who}; ${where} of the frame; ${Math.round((avg(2) / info.w) * 100)}% of the frame's width; seen for ${secs.toFixed(1)} s`;
}

export const SYSTEM =
  "You choose which faces in a video edit get blurred, following the editor's instruction. Each picture is one face track: the same face at up to three moments of the video, side by side, " +
  "with a line saying where it is and whether it is the person speaking to camera. Match only what the instruction asks, from what is visible and from those lines: where a face is, how big, " +
  "whether it is the speaker, whether the person looks younger or older. Never identify anyone: don't name, guess or describe who a person is. A track whose pictures show no face is not blurred. " +
  'Answer with JSON only: {"blur": ["T1", ...]}, the ids of the tracks to blur; an empty list when none match.';

/** One question to the AI: the instruction, the lines, one picture per track (JPEG, base64). Returns its answer's text. */
export type Ask = (system: string, user: string, images: string[], who: string, signal: AbortSignal) => Promise<string>;

const askAi: Ask = async (system, user, images, who, signal) =>
  (await completeVisionWithFallback(system, user, images.map((jpegBase64) => ({ jpegBase64 })), signal, (t) => t, who, { label: "Blur faces", background: true })).value;

/** One copy per file, version of it, ranges, instruction, look and engine: a draft made again reuses it. */
export function copyKey(file: string, ranges: [number, number][], who: string, look: string): string {
  const s = statSync(file);
  return sha1([file, s.size, s.mtimeMs, JSON.stringify(ranges), who, look, sha1(ENGINE), VERSION].join("\n")).slice(0, 12);
}

const home = () => path.join(env.dataDir, "plugins", "editor-face-blur");

async function fetchModel(dir: string): Promise<void> {
  const dest = path.join(dir, MODEL.name);
  if (existsSync(dest)) return;
  const res = await fetch(MODEL.url).catch(() => null);
  if (!res?.ok) throw new Error(`Blur faces could not download its face model from Google's MediaPipe storage: ${res ? `HTTP ${res.status}` : "no internet connection?"}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== MODEL.sha256) throw new Error("Blur faces' face model did not match its checksum");
  await writeFile(`${dest}.part`, bytes);
  await rename(`${dest}.part`, dest);
}

type Runtime = { python: string; engine: string; models: string };
async function setUp(onInstall: () => void): Promise<Runtime> {
  const dir = home();
  const engine = path.join(dir, `engine-${sha1(ENGINE).slice(0, 8)}.py`);
  const models = path.join(dir, "models");
  await mkdir(models, { recursive: true });
  if (!existsSync(engine)) {
    await writeFile(`${engine}.part`, ENGINE);
    await rename(`${engine}.part`, engine);
  }
  await fetchModel(models);
  const python = await ensureMediapipe("Blur faces", (py) => engineRun(py, [engine, "--selftest"], new AbortController().signal, { FACE_BLUR_MODELS: models }), onInstall);
  return { python, engine, models };
}
let setting: Promise<Runtime> | undefined;
const ensure = (onInstall: () => void) => (setting ??= setUp(onInstall).catch((e) => ((setting = undefined), Promise.reject(e))));

const tools = () => {
  const ff = ffmpegCommand();
  const probe = path.isAbsolute(ff) && existsSync(path.join(path.dirname(ff), "ffprobe")) ? path.join(path.dirname(ff), "ffprobe") : "ffprobe";
  return ["--ffmpeg", ff, "--ffprobe", probe];
};

/** One picture per track: its frames side by side, each a square around the face. */
async function picture(file: string, t: Track, info: { w: number; h: number; fps: number }, out: string): Promise<string> {
  const frames = pickFrames(t);
  const inputs = frames.flatMap((f) => ["-ss", (f / (info.fps || 25)).toFixed(4), "-i", file]);
  const crops = frames.map((f, i) => {
    const [x, y, w, h] = t.boxes.get(f)!;
    const side = Math.round(Math.min(info.w, info.h, 1.8 * Math.max(w, h)));
    const cx = Math.round(Math.min(Math.max(x + w / 2 - side / 2, 0), info.w - side));
    const cy = Math.round(Math.min(Math.max(y + h / 2 - side / 2, 0), info.h - side));
    return `[${i}:v]crop=${side}:${side}:${cx}:${cy},scale=256:256[c${i}]`;
  });
  const join = frames.length > 1 ? `;${frames.map((_, i) => `[c${i}]`).join("")}hstack=${frames.length}[v]` : ";[c0]null[v]";
  await ffmpeg([...inputs, "-filter_complex", crops.join(";") + join, "-map", "[v]", "-frames:v", "1", "-q:v", "4", out]);
  const b64 = (await readFile(out)).toString("base64");
  await rm(out, { force: true });
  return b64;
}

/** What one file's faces came to: how many were found, how many blurred, and the ones left, in words a person can check. */
export interface Counts { found: number; blurred: number; left: string[] }

/**
 * The note every run writes, so a person never has to trust that nothing was missed: how many faces it found, how
 * many it blurred and which it left, over every video the cut shows (a copy made before counts from its own file).
 */
export function countsNote(all: Counts[], who: string): string {
  const found = all.reduce((n, c) => n + c.found, 0);
  const blurred = all.reduce((n, c) => n + c.blurred, 0);
  const left = all.flatMap((c) => c.left);
  const faces = (n: number) => `${n} ${n === 1 ? "face" : "faces"}`;
  if (!found) return "Blur faces: 0 faces found in the footage, nothing blurred";
  if (!blurred) return `Blur faces: ${faces(found)} found, none matched “${who}”, nothing blurred`;
  return `Blur faces: ${faces(found)} found, ${blurred} blurred${left.length ? `, ${left.length} left as ${left.length === 1 ? "it is" : "they are"} (${left.join("; ")})` : ""}`;
}

/** A face left as it is, in words: its file, where it is, and whether it is the speaker. */
const leftLabel = (name: string, t: Track, info: { w: number; h: number }, speaker: boolean): string => {
  const boxes = [...t.boxes.values()];
  const avg = (i: number) => boxes.reduce((s, b) => s + b[i]!, 0) / boxes.length;
  const cx = (avg(0) + avg(2) / 2) / info.w;
  const cy = (avg(1) + avg(3) / 2) / info.h;
  const where = `${cy < 0.33 ? "top" : cy > 0.67 ? "bottom" : "middle"} ${cx < 0.33 ? "left" : cx > 0.67 ? "right" : "centre"}`;
  return `${name}, ${where}${speaker ? ", the speaker" : ""}`;
};

/** The step. `ask` stands in for the person's AI in tests; without it the AI must be connected. */
export async function blurFaces(input: EditorStepInput, ask?: Ask): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    return await blur(input, out, ask);
  } catch (e) {
    if (input.signal.aborted) return out; // stopped: the edit says so itself
    throw e;
  }
}

async function blur(input: EditorStepInput, out: Record<string, string>, given?: Ask): Promise<Record<string, string>> {
  const { files, timeline, values, workDir, signal, edit } = input;
  const who = values.who?.trim() || DEFAULT_WHO;
  const look = values.look === "pixels" ? "pixels" : "blur";
  const shown = Object.entries(blurRanges(timeline)).filter(([id]) => files[id]);
  const wanted = shown.filter(([id]) => !IMAGE.test(files[id]!));
  const stills = shown.filter(([id]) => IMAGE.test(files[id]!)).map(([id]) => timeline.sources[id]?.name ?? id);
  // ponytail: photos are left alone (a copy must be a video of the same length); blur them in a photo editor until a still copy is wanted
  if (stills.length) input.note(`Blur faces left the photos as they are: ${stills.join(", ")}`);
  const todo: { id: string; ranges: [number, number][]; dest: string }[] = [];
  const counts: Counts[] = [];
  for (const [id, ranges] of wanted) {
    const dest = path.join(workDir, `${id}-${copyKey(files[id]!, ranges, who, look)}.mov`);
    // a copy made before, with the counts it was made with beside it (<copy>.counts.json; prune keeps a kept copy's own files)
    const kept = existsSync(dest) ? await readFile(`${dest}.counts.json`, "utf8").then((t) => JSON.parse(t) as Counts, () => null) : null;
    if (kept) {
      out[id] = dest;
      counts.push(kept);
    } else todo.push({ id, ranges, dest });
  }
  if (signal.aborted) return out;
  if (!todo.length) {
    if (wanted.length) input.note(countsNote(counts, who));   // only photos: nothing was looked at, so no count
    return out;
  }
  if (!given && !anyVisionConfigured(edit.createdBy)) throw new Error("Blur faces needs your AI to decide which faces match: connect one in Settings → Providers. Nothing was blurred, and this draft has no preview until it runs again");
  const ask = given ?? askAi;
  const rt = await ensure(() => input.say("Blur faces: setting up its face tools, the first time only (a few minutes)"));
  input.say("Blur faces: finding the faces");
  const fail = (id: string) => (e: unknown) => {
    throw new Error(`Blur faces failed on ${timeline.sources[id]?.name ?? id}: ${(e as Error).message}`);
  };

  // 1. the faces in every file, as tracks
  const v1 = new Set((timeline.tracks.V1?.items ?? []).map((i) => i.src));
  const found: { id: string; dest: string; info: { w: number; h: number; fps: number; frames: number }; tracks: Track[] }[] = [];
  let n = 0;
  for (const { id, ranges, dest } of todo) {
    if (signal.aborted) return out;
    const json = `${dest}.faces.json`;
    try {
      await ffmpegSlot(() => engineRun(rt.python, [rt.engine, "detect", files[id]!, json, "--ranges", ranges.map(([a, b]) => `${a}-${b}`).join(","), ...tools()], signal, { FACE_BLUR_MODELS: rt.models })).catch(fail(id));
      const meta = JSON.parse(await readFile(json, "utf8")) as { w: number; h: number; fps: number; frames: number; dets: Record<string, Box[]> };
      const tracks = buildTracks(id, meta.dets)
        .sort((a, b) => clear([...b.boxes.values()][0]!) * b.boxes.size - clear([...a.boxes.values()][0]!) * a.boxes.size)
        .map((t) => ({ ...t, id: `T${++n}` }));
      found.push({ id, dest, info: meta, tracks });
    } finally {
      await rm(json, { force: true });
    }
  }
  const all = found.flatMap((f) => f.tracks.map((t) => ({ t, f })));
  if (!all.length) {
    input.note(countsNote(counts, who));
    return out;
  }

  // 2. which tracks match what the person wrote: the person's AI, from a picture of each and a line about it
  const chosen = new Set<string>();
  for (let i = 0; i < all.length; i += PER_CALL) {
    if (signal.aborted) return out;
    const batch = all.slice(i, i + PER_CALL);
    const images: string[] = [];
    for (const { t, f } of batch) images.push(await picture(files[f.id]!, t, f.info, path.join(workDir, `${t.id}-${process.pid}.jpg`)).catch(fail(f.id)));
    const lines = batch.map(({ t, f }) => {
      // the speaker: the face seen longest on V1 footage (tracks are sorted by size × time), first of its file
      const role = v1.has(f.id) ? "speaker" : "broll";
      return describe(t, f.info, role, role === "speaker" && f.tracks[0] === t);
    });
    const user = `The editor's instruction: "${who}"\n\nThe face tracks, one picture each, in this order:\n${lines.join("\n")}\n\nWhich tracks match the instruction?`;
    input.say("Blur faces: asking your AI which faces to blur");
    const answer = await ask(SYSTEM, user, images, edit.createdBy, signal).catch((e: Error) => {
      if (signal.aborted) throw e;
      throw new Error(`Blur faces could not ask your AI which faces to blur (${e.message}). Nothing was blurred, and this draft has no preview until it runs again`);
    });
    let ids: Set<string>;
    try {
      ids = chosenIn(answer, batch.map((b) => b.t.id));
    } catch (e) {
      throw new Error(`Blur faces could not read your AI's answer (${(e as Error).message}). Nothing was blurred, and this draft has no preview until it runs again: run it again, or try another AI in Settings → Providers`);
    }
    for (const id of ids) chosen.add(id);
  }
  // each file's count, from what the AI chose (a file with no face found counts 0)
  const countOf = new Map<string, Counts>();
  for (const f of found) {
    const mine = f.tracks.filter((t) => chosen.has(t.id));
    const name = timeline.sources[f.id]?.name ?? f.id;
    const left = f.tracks.filter((t) => !chosen.has(t.id)).map((t) => leftLabel(name, t, f.info, v1.has(f.id) && f.tracks[0] === t));
    countOf.set(f.id, { found: f.tracks.length, blurred: mine.length, left });
    counts.push(countOf.get(f.id)!);
  }
  input.note(countsNote(counts, who));
  if (!chosen.size) return out;

  // 3. the copies, with the chosen tracks blurred
  for (const f of found) {
    const mine = f.tracks.filter((t) => chosen.has(t.id));
    if (!mine.length || signal.aborted) continue;
    const tmp = `${f.dest}.part.mov`;
    const ell = `${f.dest}.ellipses.json`;
    try {
      await writeFile(ell, JSON.stringify(ellipses(mine, f.info.frames)));
      await ffmpegSlot(() => engineRun(rt.python, [rt.engine, "render", files[f.id]!, tmp, "--ellipses", ell, "--look", look, ...tools()], signal, { FACE_BLUR_MODELS: rt.models })).catch(fail(f.id));
      await rename(tmp, f.dest);
      await writeFile(`${f.dest}.counts.json`, JSON.stringify(countOf.get(f.id)));
      out[f.id] = f.dest;
    } finally {
      await Promise.all([rm(tmp, { force: true }), rm(`${tmp}.json`, { force: true }), rm(ell, { force: true })]);
    }
  }
  return out;
}

export default definePlugin({
  id: "editor-face-blur",
  name: "Blur faces",
  about: "Blurs the faces you name in every edit (the people in the background, everyone but you), on this computer. About 1.4 GB of disk for each minute of video",
  kind: "editor",
  editor: {
    steps: [
      {
        id: "face-blur",
        title: "Blur faces",
        about: "Finds the faces in the footage an edit shows, and your AI picks the ones that match what you write here. The first run sets up its own Python (MediaPipe). About 1.4 GB of disk for each minute of video.",
        order: 30,
        options: [
          { id: "who", label: "What to blur", kind: "text", default: DEFAULT_WHO },
          {
            id: "look",
            label: "Look",
            kind: "choice",
            default: "blur",
            choices: [
              { value: "blur", label: "Blur" },
              { value: "pixels", label: "Pixels" },
            ],
          },
        ],
        run: (input) => blurFaces(input),
      },
    ],
  },
});
