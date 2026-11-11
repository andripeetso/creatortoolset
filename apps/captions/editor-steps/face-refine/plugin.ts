import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Timeline } from "../../contracts/editor";
import { ffmpegCommand } from "../../api/ffmpeg-runtime";
import { env } from "../../api/lib/env";
import { engineRun, ensureMediapipe } from "../../api/editor/mediapipe";
import { definePlugin, type EditorStepInput } from "../../api/lib/plugin";
import { ffmpegSlot } from "../../api/library/media/run";
import { ENGINE } from "./engine";

/**
 * Face refinement, an AI Editor step: the speaker's skin evened out and the dark circles under the eyes lifted, on the
 * frames of each recording the cut shows on V1, on this computer. Beard, brows, eyes and lips are left alone, pores
 * are kept. The copy is the whole file again (ProRes, the source's sound and timecode), so every cut stays where it is.
 *
 * The engine is Python (MediaPipe + OpenCV, engine.ts): on first use it gets the face steps' shared venv
 * (api/editor/mediapipe.ts) and the two MediaPipe models in the app's data folder (README.md says why Python).
 */

/** frames either side of what the cut shows, for trims; ranges of one file closer than JOIN become one */
export const HANDLE = 25;
export const JOIN = 50;
export const LOOKS: Record<string, { smooth: number; undereye: number }> = {
  light: { smooth: 0.18, undereye: 0.4 },
  medium: { smooth: 0.28, undereye: 0.6 },
  strong: { smooth: 0.4, undereye: 0.8 },
};
const MODELS = [
  {
    name: "face_landmarker.task",
    url: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
    sha256: "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff",
  },
  {
    name: "selfie_multiclass.tflite",
    url: "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite",
    sha256: "c6748b1253a99067ef71f7e26ca71096cd449baefa8f101900ea23016507e0e0",
  },
];
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

/** {source id: [[first, end)]} in source frames: where the cut shows each V1 recording (not under V2), HANDLE either side, close ones joined. */
export function faceRanges(tl: Timeline): Record<string, [number, number][]> {
  const covers = (tl.tracks.V2?.items ?? []).map((i) => [i.rec, i.rec + i.len] as const).sort((a, b) => a[0] - b[0]);
  const out: Record<string, [number, number][]> = {};
  for (const it of tl.tracks.V1?.items ?? []) {
    const src = tl.sources[it.src];
    if (!src || !(src.w > 0)) continue;
    const k = (src.fps || tl.fps) / tl.fps;
    let at = it.rec;
    const end = it.rec + it.len;
    const pieces: [number, number][] = [];
    for (const [a, b] of covers) {
      if (b <= at || a >= end) continue;
      if (a > at) pieces.push([at, a]);
      at = Math.max(at, b);
    }
    if (at < end) pieces.push([at, end]);
    for (const [a, b] of pieces) {
      const first = Math.max(0, it.in + Math.floor((a - it.rec) * k) - HANDLE);
      const last = Math.min(src.dur || Infinity, it.in + Math.ceil((b - it.rec) * k) + HANDLE);
      if (last > first) (out[it.src] ??= []).push([first, last]);
    }
  }
  for (const [id, spans] of Object.entries(out)) {
    spans.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [[...spans[0]!]];
    for (const [a, b] of spans.slice(1)) {
      const m = merged[merged.length - 1]!;
      if (a - m[1] < JOIN) m[1] = Math.max(m[1], b);
      else merged.push([a, b]);
    }
    out[id] = merged;
  }
  return out;
}

/** One copy per file, version of it, ranges, look and engine: a draft made again reuses it. */
export function copyKey(file: string, ranges: [number, number][], look: string): string {
  const s = statSync(file);
  return sha1([file, s.size, s.mtimeMs, JSON.stringify(ranges), JSON.stringify(LOOKS[look] ?? LOOKS.medium), sha1(ENGINE)].join("\n")).slice(0, 12);
}

const home = () => path.join(env.dataDir, "plugins", "editor-face-refine");

async function fetchModel(m: (typeof MODELS)[number], dir: string): Promise<void> {
  const dest = path.join(dir, m.name);
  if (existsSync(dest)) return;
  const res = await fetch(m.url).catch(() => null);
  if (!res?.ok) throw new Error(`Face refinement could not download its face model (${m.name}) from Google's MediaPipe storage: ${res ? `HTTP ${res.status}` : "no internet connection?"}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== m.sha256) throw new Error(`Face refinement's face model (${m.name}) did not match its checksum`);
  await writeFile(`${dest}.part`, bytes);
  await rename(`${dest}.part`, dest);
}

/**
 * The models and the engine in the step's own folder, and the face steps' shared Python (api/editor/mediapipe.ts), made
 * once in the data folder the first time the step runs (never before the person has switched it on).
 */
async function setUp(): Promise<{ python: string; engine: string; models: string }> {
  const dir = home();
  const engine = path.join(dir, `engine-${sha1(ENGINE).slice(0, 8)}.py`);
  const models = path.join(dir, "models");
  await mkdir(models, { recursive: true });
  if (!existsSync(engine)) {
    await writeFile(`${engine}.part`, ENGINE);
    await rename(`${engine}.part`, engine);
  }
  for (const m of MODELS) await fetchModel(m, models);
  const python = await ensureMediapipe("Face refinement", (py) => engineRun(py, [engine, "--selftest"], new AbortController().signal, { FACE_REFINE_MODELS: models }));
  return { python, engine, models };
}
let setting: Promise<{ python: string; engine: string; models: string }> | undefined;
const ensure = () => (setting ??= setUp().catch((e) => ((setting = undefined), Promise.reject(e))));

export async function refineFaces({ files, timeline, values, workDir, signal }: EditorStepInput): Promise<Record<string, string>> {
  const look = LOOKS[values.smoothing ?? ""] ? values.smoothing! : "medium";
  const out: Record<string, string> = {};
  const wanted = Object.entries(faceRanges(timeline)).filter(([id]) => files[id]);
  if (!wanted.length) return out;
  const rt = await ensure();
  const ffmpeg = ffmpegCommand();
  const ffprobe = path.isAbsolute(ffmpeg) && existsSync(path.join(path.dirname(ffmpeg), "ffprobe")) ? path.join(path.dirname(ffmpeg), "ffprobe") : "ffprobe";
  for (const [id, ranges] of wanted) {
    if (signal.aborted) break;
    const file = files[id]!;
    const dest = path.join(workDir, `${id}-${copyKey(file, ranges, look)}.mov`);
    const none = `${dest}.noface`; // no face in any frame: the file plays as it is
    if (existsSync(none)) continue;
    if (!existsSync(dest)) {
      const tmp = `${dest}.part.mov`;
      const track = `${dest}.track`;
      try {
        await ffmpegSlot(() =>
          engineRun(rt.python, [rt.engine, file, tmp, "--ranges", ranges.map(([a, b]) => `${a}-${b}`).join(","), "--work", track, "--ffmpeg", ffmpeg, "--ffprobe", ffprobe,
            "--smooth", String(LOOKS[look]!.smooth), "--undereye", String(LOOKS[look]!.undereye)], signal, { FACE_REFINE_MODELS: rt.models }),
        );
        const meta = JSON.parse(await readFile(`${tmp}.json`, "utf8")) as { faces: number };
        if (meta.faces) await rename(tmp, dest);
        else await writeFile(none, "");
      } catch (e) {
        if (signal.aborted) break;
        throw new Error(`Face refinement failed on ${timeline.sources[id]?.name ?? id}: ${(e as Error).message}`);
      } finally {
        await Promise.all([rm(tmp, { force: true }), rm(`${tmp}.json`, { force: true }), rm(track, { recursive: true, force: true })]);
      }
      if (!existsSync(dest)) continue;
    }
    out[id] = dest;
  }
  return out;
}

export default definePlugin({
  id: "editor-face-refine",
  name: "Face refinement",
  about: "Evens out the speaker's skin and lifts dark circles in every edit, on this computer. About 1.4 GB of disk for each minute of video",
  editor: {
    steps: [
      {
        id: "face-refine",
        title: "Face refinement",
        about: "Evens out the skin and lifts the dark circles under the eyes, and leaves beard, brows, eyes and lips alone. The first run sets up its own Python (MediaPipe). About 1.4 GB of disk for each minute of video.",
        order: 20,
        options: [
          {
            id: "smoothing",
            label: "Smoothing",
            kind: "choice",
            default: "medium",
            choices: [
              { value: "light", label: "Light" },
              { value: "medium", label: "Medium" },
              { value: "strong", label: "Strong" },
            ],
          },
        ],
        run: refineFaces,
      },
    ],
  },
});
