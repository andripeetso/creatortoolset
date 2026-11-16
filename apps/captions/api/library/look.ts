import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import type { IndexShot } from "../../contracts/edit-plan";
import { ffmpegCommand } from "../ffmpeg-runtime";
import { parseJsonObject } from "../lib/instagram/vision";
import { ffmpegSlot, ffmpegTo } from "./media/run";

/**
 * Reading footage's picture so an AI can be shown it without watching it: every frame read small and grey
 * (readPicture), the stretches it falls into (cuts, and long takes split where the picture changes most: shotsOf),
 * contact sheets of those stretches (contactSheet) and the prompt an AI looks at them with (lookPrompt). The Media
 * Library's shot descriptions and the AI Editor's footage index (editor/index.ts) both use these, so the same file
 * gives the same stretches wherever it is read.
 */

/** Frames are read this small and grey: enough to see a cut and how much moves, cheap to compare. */
const FW = 64;
const FH = 36;
const MAX_READ_FPS = 30;
/** A cut is read on the frame-to-frame change over the two frames' own contrast (their spread of grey, never under
 * SPREAD_FLOOR), so a dark shot cuts as clearly as a bright one: the change must reach CUT_MIN and be CUT_OVER times
 * its neighbourhood's median plus CUT_PLUS */
const SPREAD_FLOOR = 0.02;
const CUT_MIN = 0.25;
const CUT_OVER = 3;
const CUT_PLUS = 0.08;
/** Two cuts this close (s) are one: a flash frame is not a shot */
const MIN_SHOT_S = 0.3;
/** A take longer than LONG_S is split, no piece shorter than PIECE_S */
const LONG_S = 8;
const PIECE_S = 4;
/** The change over this long (s) says where a long take changes most */
const LAG_S = 0.5;
/** Movement (mean |Δ| a second) below which a source counts as still, whatever its own most is */
const STILL_PER_S = 0.15;

export interface PictureRead {
  /** frames read a second */
  fps: number;
  /** change from the frame before (mean |Δ| of grey 0..1; index 0: 0) */
  step: Float32Array;
  /** the same over the two frames' contrast: what a cut is read on */
  cut: Float32Array;
  /** change from LAG_S before (0 until then) */
  lag: Float32Array;
}

/** Every frame of `src` at up to MAX_READ_FPS, FW×FH grey, compared with the one before and the one LAG_S before. */
export async function readPicture(src: string, fps: number, signal?: AbortSignal): Promise<PictureRead> {
  const rate = fps > 0 ? Math.min(fps, MAX_READ_FPS) : 25;
  const L = Math.max(1, Math.round(LAG_S * rate));
  const size = FW * FH;
  return ffmpegSlot(
    () =>
      new Promise((resolve, reject) => {
        const p = spawn(
          ffmpegCommand(),
          ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", src, "-an", "-sn", "-vf", `fps=${rate},scale=${FW}:${FH}:flags=area,format=gray`, "-f", "rawvideo", "pipe:1"],
          { signal },
        );
        const ring: Buffer[] = []; // the last L+1 frames
        const step: number[] = [];
        const cut: number[] = [];
        let spreadBefore = 0;
        const spread = (x: Buffer) => {
          let s = 0;
          let q = 0;
          for (let i = 0; i < size; i++) (s += x[i]!), (q += x[i]! * x[i]!);
          return Math.sqrt(Math.max(0, q / size - (s / size) ** 2)) / 255;
        };
        const lag: number[] = [];
        const diff = (x: Buffer, y: Buffer) => {
          let s = 0;
          for (let i = 0; i < size; i++) s += Math.abs(x[i]! - y[i]!);
          return s / size / 255;
        };
        let carry = Buffer.alloc(0);
        let err = "";
        p.stdout.on("data", (d: Buffer) => {
          let buf = carry.length ? Buffer.concat([carry, d]) : d;
          while (buf.length >= size) {
            const f = Buffer.from(buf.subarray(0, size));
            buf = buf.subarray(size);
            const prev = ring[ring.length - 1];
            const d = prev ? diff(f, prev) : 0;
            const sp = spread(f);
            step.push(d);
            cut.push(prev ? d / Math.max(SPREAD_FLOOR, (sp + spreadBefore) / 2) : 0);
            spreadBefore = sp;
            lag.push(ring.length > L ? diff(f, ring[ring.length - 1 - L]!) : 0);
            ring.push(f);
            if (ring.length > L + 1) ring.shift();
          }
          carry = Buffer.from(buf);
        });
        p.stderr.on("data", (d) => (err = (err + d.toString()).slice(-2000)));
        p.on("error", reject);
        p.on("close", (code) => {
          if (code !== 0) return reject(new Error(err.trim() || `ffmpeg exited ${code}`));
          resolve({ fps: rate, step: Float32Array.from(step), cut: Float32Array.from(cut), lag: Float32Array.from(lag) });
        });
      }),
  );
}

export const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1]!;
};

/** The frames where a new shot starts (hard cuts), from `read`. */
export function cutsOf({ fps, cut: step }: PictureRead): number[] {
  const W = Math.round(fps);
  const cuts: number[] = [];
  for (let i = 1; i < step.length; i++) {
    const d = step[i]!;
    if (d < CUT_MIN) continue;
    let peak = true;
    for (let j = Math.max(1, i - 2); j <= Math.min(step.length - 1, i + 2); j++) if (j !== i && step[j]! > d) peak = false;
    if (!peak) continue;
    const around: number[] = [];
    for (let j = Math.max(1, i - W); j <= Math.min(step.length - 1, i + W); j++) if (Math.abs(j - i) > 1) around.push(step[j]!);
    if (d < CUT_OVER * median(around) + CUT_PLUS) continue;
    const last = cuts[cuts.length - 1];
    if (last !== undefined && i - last < MIN_SHOT_S * fps) {
      if (d > step[last]!) cuts[cuts.length - 1] = i;
      continue;
    }
    if (i < MIN_SHOT_S * fps || step.length - i < MIN_SHOT_S * fps) continue;
    cuts.push(i);
  }
  return cuts;
}

/** Splits frames [a, b) into pieces of PIECE_S..LONG_S where the picture changes most (the lag change's peak). */
export function splitLong(a: number, b: number, read: PictureRead): number[] {
  const { fps, lag } = read;
  if (b - a <= LONG_S * fps) return [];
  const half = Math.round((LAG_S * fps) / 2);
  let best = -1;
  let at = Math.round((a + b) / 2);
  for (let i = Math.ceil(a + PIECE_S * fps); i <= Math.floor(b - PIECE_S * fps); i++) {
    const v = lag[Math.min(lag.length - 1, i + half)] ?? 0; // the change over LAG_S, centred on i
    if (v > best) [best, at] = [v, i];
  }
  return [...splitLong(a, at, read), at, ...splitLong(at, b, read)];
}

/** Shots covering 0..dur from what was read: cuts, long takes split, motion against the source's own most. */
export function shotsOf(read: PictureRead, dur: number): IndexShot[] {
  const n = read.step.length;
  if (!n) return dur > 0 ? [{ a: 0, b: dur, motion: 0 }] : [];
  const edges = [0, ...cutsOf(read), n];
  const all: number[] = [0];
  for (let k = 1; k < edges.length; k++) all.push(...splitLong(edges[k - 1]!, edges[k]!, read), edges[k]!);
  const per: number[] = [];
  for (let k = 1; k < all.length; k++) {
    let s = 0;
    let c = 0;
    for (let i = all[k - 1]! + 1; i < all[k]!; i++) (s += read.step[i]!), c++;
    per.push(c ? (s / c) * read.fps : 0);
  }
  const most = Math.max(STILL_PER_S, ...per);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return per.map((m, k) => ({
    a: r2(all[k]! / read.fps),
    b: k === per.length - 1 ? dur : r2(all[k + 1]! / read.fps),
    motion: r2(Math.min(1, m / most)),
  }));
}

/** Tiles a sheet: COLS across, up to ROWS down, one frame (the middle) per shot */
export const COLS = 4;
export const ROWS = 4;

/**
 * A contact sheet of `src` at `times`, COLS across in reading order, written as a JPEG to `out`. Frames are taken a
 * row at a time (a few seeks per ffmpeg run, one thread each), so a 4K source never holds many decoders at once.
 */
export async function contactSheet(src: string, times: number[], landscape: boolean, out: string): Promise<void> {
  const [w, h] = landscape ? [256, 144] : [144, 256];
  const cell = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w + 8}:${h + 8}:(ow-iw)/2:(oh-ih)/2:white,setsar=1`;
  const rows: string[] = [];
  try {
    for (let r = 0; r * COLS < times.length; r++) {
      const these = times.slice(r * COLS, (r + 1) * COLS);
      const args = these.flatMap((t) => ["-threads", "1", "-ss", t.toFixed(3), "-i", src]);
      // a short row is padded with blank cells so every row is as wide
      const blanks = COLS - these.length;
      const graph =
        these.map((_, j) => `[${j}:v:0]${cell}[f${j}]`).join(";") +
        (blanks ? `;color=white:s=${w + 8}x${h + 8}:d=1,split=${blanks}${Array.from({ length: blanks }, (_, k) => `[b${k}]`).join("")}` : "") +
        ";" +
        [...these.map((_, j) => `[f${j}]`), ...Array.from({ length: blanks }, (_, k) => `[b${k}]`)].join("") +
        `hstack=inputs=${COLS}`;
      const row = `${out}.${r}.png`;
      await ffmpegTo(row, [...args, "-filter_complex", graph, "-frames:v", "1"]);
      rows.push(row);
    }
    const stack = rows.length > 1 ? ["-filter_complex", `vstack=inputs=${rows.length}`] : [];
    await ffmpegTo(out, [...rows.flatMap((p) => ["-i", p]), ...stack, "-frames:v", "1", "-q:v", "4"]);
  } finally {
    await Promise.all(rows.map((p) => rm(p, { force: true })));
  }
}

export const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export interface Looked {
  shots: Record<string, string>;
  story?: string;
}

/** The answer: a few words per shot number, and the story when asked. */
export function parseLooked(text: string): Looked {
  const o = parseJsonObject(text);
  const shots: Record<string, string> = {};
  if (o.shots && typeof o.shots === "object")
    for (const [k, v] of Object.entries(o.shots as Record<string, unknown>)) if (typeof v === "string" && v.trim()) shots[String(parseInt(k, 10))] = v.trim().slice(0, 200);
  const story = typeof o.story === "string" && o.story.trim() ? o.story.trim().slice(0, 3000) : undefined;
  if (!Object.keys(shots).length && !story) throw new Error("The AI described no shot");
  return { shots, ...(story ? { story } : {}) };
}

export const RULE = 'Never say who anyone is: no names, no guessed ages, no identities; "a person" or "people" is enough.';

export function lookPrompt(lines: string[], story: boolean, workspace = ""): { system: string; user: string } {
  return {
    system:
      "You look at contact sheets of footage for a video editor, so it can pick shots without watching them. For each numbered " +
      "shot say in a few words what is seen: the subject, the action, the setting and the kind of shot (wide, close, screen, text). " +
      `${RULE} Answer with JSON only.`,
    user: [
      ...(workspace
        ? [`The workspace the footage is for. Use it to name what is seen (the product, the game, its places and features) when the pictures show it; never add what they don't show:\n${workspace}`]
        : []),
      ...lines,
      story
        ? 'Answer as {"shots": {"1": "a few words", "2": "…"}, "story": "what happens across all of the footage, in order, told from the pictures alone, in a few sentences"}'
        : 'Answer as {"shots": {"1": "a few words", "2": "…"}}',
    ].join("\n\n"),
  };
}
