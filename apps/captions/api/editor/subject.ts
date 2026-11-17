import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ffmpegCommand } from "../ffmpeg-runtime";
import { env } from "../lib/env";
import type { DatabaseSync } from "node:sqlite";
import { cutsOf, readPicture } from "../library/look";
import { stretchesOf } from "../library/stretches";
import { onComputer } from "../work/on-computer";
import type { Timeline } from "../../contracts/editor";
import { centreOn, fillZoom, followPath, pathIn, pickKey, type PathKey, splicePath, windowOf } from "./framing";
import { engineRun, ensureVenv, run, type PyList } from "./mediapipe";
import { LOOK_FPS } from "./speakers";
import { ENGINE } from "./subject-engine";
import { SUBJECT_REQUIREMENTS } from "./subject-requirements";

/**
 * The subject tracker, for a reframe of footage with no faces to follow (game capture, a product, someone turned away):
 * one thing followed through each shot of a stretch with SAM 2.1's video predictor (subject-engine.ts), LOOK_FPS times
 * a second. Each shot is tracked from its own seed: a point the person clicked on it in Review, else what the shot's
 * description from the library's look names (a text detector finds it); a shot with neither is not followed. A new shot
 * starts where library/look.ts cutsOf finds a cut.
 *
 * Runs only on a computer (a step's work there: onComputer) with an NVIDIA graphics card of at least MIN_GPU_MB on
 * Linux x86-64, the platform its pinned packages are for; anywhere else the caller keeps the picture in the middle, as
 * before. Its Python (PyTorch with CUDA, about 2.9 GB to download, 5.6 GB installed) and models (0.83 GB) are fetched
 * the first time it runs there. Looked at once per stretch and seeds and kept (editor/cache), like the faces.
 */

/** What a draft says when a subject clicked in Review is held, not followed (preview.ts). */
export const HELD_NOTE = "The frame holds where the subject was clicked: following it takes a computer with an NVIDIA graphics card";

/** The least memory a card needs: the tracker measured 3.7 GB at its peak, with the text detector 7.7 GB. */
export const MIN_GPU_MB = 8 << 10;
const KEPT_V = 1;

/** A point the person clicked (`t` seconds in the source, `x` `y` fractions of the picture), or what a description of `a`..`b` s names. */
export type Seed = { t: number; x: number; y: number } | { a: number; b: number; text: string };
/** The subject in one looked-at frame: its box as fractions of the picture, null where it is not seen. */
export interface SubjectFrame {
  t: number;
  box: [number, number, number, number] | null;
}
export interface Tracked {
  frames: SubjectFrame[];
  /** the seconds each shot starts */
  shots: number[];
}

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");
const LIST: PyList = { name: "subject", requirements: SUBJECT_REQUIREMENTS, minPython: 11, holds: "PyTorch and SAM 2" };

/** This computer's NVIDIA card by name when the tracker can run on it, else null. */
export async function usableGpu(): Promise<string | null> {
  if (process.platform !== "linux" || process.arch !== "x64") return null;
  const out = await run("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], { timeout: 10_000 }).catch(() => "");
  const [name, mb] = (out.split("\n")[0] ?? "").split(",").map((s) => s.trim());
  return name && Number(mb) >= MIN_GPU_MB ? name : null;
}

async function setUp(onInstall: () => void): Promise<{ python: string; engine: string; models: string }> {
  const dir = path.join(env.dataDir, "runtime", "subject");
  const engine = path.join(dir, `engine-${sha1(ENGINE).slice(0, 8)}.py`);
  const models = path.join(dir, "models");
  await mkdir(models, { recursive: true });
  if (!existsSync(engine)) {
    await writeFile(`${engine}.part`, ENGINE);
    await rename(`${engine}.part`, engine);
  }
  const python = await ensureVenv(LIST, "The subject tracker", (py) => engineRun(py, [engine, "--selftest", "--models", models, "--ffmpeg", ffmpegCommand()], new AbortController().signal), onInstall);
  return { python, engine, models };
}
let setting: Promise<{ python: string; engine: string; models: string }> | undefined;
const ensure = (onInstall: () => void) => (setting ??= setUp(onInstall).catch((e) => ((setting = undefined), Promise.reject(e))));

export const subjectFile = (versionId: string, a: number, b: number, seeds: Seed[]) =>
  path.join(env.dataDir, "editor", "cache", `${versionId}.subject${KEPT_V}.${a.toFixed(2)}-${b.toFixed(2)}.${sha1(JSON.stringify(seeds)).slice(0, 8)}.json`);

/**
 * The subject followed through `versionId`'s stretch a..b s from `seeds`, kept or looked at once; null on a computer
 * that can't run the tracker (no card), so the caller keeps the middle. `fps`: the source's frame rate.
 */
export async function trackSubject(
  versionId: string,
  src: () => Promise<string>,
  a: number,
  b: number,
  fps: number,
  seeds: Seed[],
  signal: AbortSignal,
  onInstall: () => void = () => {},
): Promise<Tracked | null> {
  const file = subjectFile(versionId, a, b, seeds);
  const kept = JSON.parse(await readFile(file, "utf8").catch(() => "null")) as Tracked | null;
  if (kept) return kept;
  if (!onComputer.on || !seeds.length || !(await usableGpu())) return null;
  const rt = await ensure(onInstall);
  const video = await src();
  const read = await readPicture(video, fps, signal, { a, b });
  const plan = seedShots(cutsOf(read).map((i) => a + i / read.fps), a, b, seeds);
  const out = await engineRun(rt.python, [rt.engine, video, "--plan", JSON.stringify(plan), "--fps", String(LOOK_FPS), "--models", rt.models, "--ffmpeg", ffmpegCommand()], signal);
  const got = JSON.parse(out.trim().split("\n").at(-1)!) as { frames: SubjectFrame[] };
  const tracked: Tracked = { frames: got.frames, shots: plan.map((p) => p.s) };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.part`, JSON.stringify(tracked));
  await rename(`${file}.part`, file);
  return tracked;
}

/** A seed placed in a shot: the click, or a description's text looked for at `t`. */
export type ShotSeed = { t: number; x: number; y: number } | { t: number; text: string };

/**
 * Each shot of the stretch a..b s (`cuts`: where a new one starts, seconds in the source) with its own seed: a click in
 * it, else the description that covers its middle, looked for half a second in (past a fade or the cut's blur; a
 * quarter of the shot when shorter); null for neither. A shot shorter than a looked-at frame is left out.
 */
export function seedShots(cuts: number[], a: number, b: number, seeds: Seed[]): { s: number; e: number; seed: ShotSeed | null }[] {
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const edges = [a, ...cuts.filter((c) => c > a && c < b).sort((x, y) => x - y), b];
  const out: { s: number; e: number; seed: ShotSeed | null }[] = [];
  for (let i = 1; i < edges.length; i++) {
    const [s, e] = [edges[i - 1]!, edges[i]!];
    if (e - s < 1 / LOOK_FPS) continue;
    const mid = (s + e) / 2;
    const click = seeds.find((x): x is Extract<Seed, { x: number }> => "x" in x && x.t >= s && x.t < e);
    const told = seeds.find((x): x is Extract<Seed, { text: string }> => "text" in x && x.a <= mid && mid < x.b);
    const seed: ShotSeed | null = click ? { ...click, t: r3(click.t) } : told ? { t: r3(s + Math.min(0.5, (e - s) / 4)), text: told.text } : null;
    out.push({ s: r3(s), e: r3(e), seed });
  }
  return out;
}

/** A stretch with faces in fewer of its looked-at frames than this has none to follow: its subject is followed instead. */
export const FACELESS = 0.2;
export const faceless = (frames: { faces: unknown[] }[]) => frames.filter((f) => f.faces.length).length < FACELESS * frames.length;

/** What the library's look says each shot of `versionId`'s stretch a..b s shows, as seeds (library/stretches.ts). */
export const describedSeeds = (db: DatabaseSync, versionId: string, a: number, b: number): Seed[] =>
  stretchesOf(db, versionId)
    .filter((s) => s.text.trim() && s.b > a && s.a < b)
    .map((s) => ({ a: Math.max(s.a, a), b: Math.min(s.b, b), text: s.text.slice(0, 200) }));

/** The followed subject's middle at each frame it is seen, for framing.ts followPath: `jump` at the first one of a new shot. */
export function subjectTargets({ frames, shots }: Tracked): { t: number; c: number; jump?: boolean }[] {
  const out: { t: number; c: number; jump?: boolean }[] = [];
  let was = -1;
  for (const f of frames) {
    if (!f.box) continue;
    const shot = shots.filter((s) => s <= f.t + 1e-6).length;
    out.push({ t: f.t, c: Math.round((f.box[0] + f.box[2] / 2) * 1e4) / 1e4, ...(out.length && shot !== was ? { jump: true } : {}) });
    was = shot;
  }
  return out;
}

/**
 * The draft's shots set in Review to follow a clicked subject (WindowCrop.subject) that is not followed yet: each one
 * followed from its click through the camera shot it was clicked in (the other camera shots of its pieces keep the
 * source's own path, or the middle), their windows set to that path and the path kept in Timeline.reframe's `picked`
 * (edits.ts takes it from there for later versions). `files`: each source's file here.
 * Null with nothing to follow; "held" when this computer can't follow them (the window stays on the click).
 */
export async function followPicked(tl: Timeline, files: Record<string, string>, signal: AbortSignal, onInstall?: () => void): Promise<Timeline | "held" | null> {
  const fpsOf = (src: string) => tl.sources[src]?.fps || tl.fps;
  const todo = new Map<string, { src: string; s: { t: number; x: number; y: number }; a: number; b: number; zoom?: number }>();
  for (const it of tl.tracks.V1.items) {
    const c = it.crop;
    if (!c || !("subject" in c) || !tl.sources[it.src]?.w || tl.reframe?.[it.src]?.picked?.[pickKey(c.subject)]) continue;
    const [a, b] = [it.in / fpsOf(it.src), it.in / fpsOf(it.src) + it.len / tl.fps];
    const k = `${it.src} ${pickKey(c.subject)}`;
    const g = todo.get(k);
    todo.set(k, g ? { ...g, a: Math.min(g.a, a), b: Math.max(g.b, b) } : { src: it.src, s: c.subject, a, b, zoom: it.zoom });
  }
  if (!todo.size) return null;
  const picked: Record<string, Record<string, PathKey[]>> = {};
  for (const g of todo.values()) {
    const src = tl.sources[g.src]!;
    const file = files[g.src];
    const got = file ? await trackSubject(g.src, async () => file, g.a, g.b, src.fps, [g.s], signal, onInstall) : null;
    if (!got) continue;
    const win = windowOf(src, tl.width, tl.height, g.zoom ?? fillZoom(src, tl.width, tl.height));
    // followed in the camera shot it was clicked in; the other shots keep the source's own path (or the middle)
    const s = Math.max(g.a, ...got.shots.filter((x) => x <= g.s.t));
    const e = Math.min(g.b, ...got.shots.filter((x) => x > g.s.t));
    const keys = followPath(subjectTargets({ frames: got.frames.filter((f) => f.t >= s && f.t < e), shots: [s] }), win);
    (picked[g.src] ??= {})[pickKey(g.s)] = splicePath(tl.reframe?.[g.src]?.auto ?? [], keys.length ? keys : [{ t: s, x: centreOn(g.s.x, win) }], s, e);
  }
  if (!Object.keys(picked).length) return "held";
  const items = tl.tracks.V1.items.map((it) => {
    const keys = it.crop && "subject" in it.crop ? picked[it.src]?.[pickKey(it.crop.subject)] : undefined;
    if (!keys) return it;
    const { path: _path, ...rest } = it;
    const path = pathIn(keys, it.in / fpsOf(it.src), it.len / tl.fps);
    return path.length ? { ...rest, path } : rest;
  });
  const reframe = { ...tl.reframe };
  for (const [src, p] of Object.entries(picked)) reframe[src] = { ...(reframe[src] ?? { auto: [], speakers: {} }), picked: { ...reframe[src]?.picked, ...p } };
  return { ...tl, tracks: { ...tl.tracks, V1: { ...tl.tracks.V1, items } }, reframe };
}
