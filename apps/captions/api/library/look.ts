import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import type { IndexShot } from "../../contracts/edit-plan";
import { STRETCH_TAGS, STRETCH_TEXT_MAX } from "../../contracts/library";
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
 * The shot descriptions' sheet (stretchSheet), as measured to pass on 2026-11-15 (tasks/flywheel stage 1.0, "format D"):
 * each tile is one stretch as three frames side by side (its start and end STRETCH_INSET_S inside it, so a cut's
 * neighbour never shows, and its middle), each frame FRAME_W × FRAME_H (turned for a portrait source) on an 8 px white
 * border; SHEET_STRETCHES tiles a sheet, STRETCH_COLS across (a landscape sheet is 1584 × 1216, which an AI reads at
 * about its own size). One middle frame a stretch (COLS × ROWS, contactSheet) told fewer dull stretches from action
 * ones: 81% and 84%, where this scored 97% and 95%.
 */
export const STRETCH_FRAMES = 3;
export const STRETCH_INSET_S = 0.25;
export const FRAME_W = 256;
export const FRAME_H = 144;
export const SHEET_STRETCHES = 16;
export const STRETCH_COLS = { landscape: 2, portrait: 3 } as const;

/** The frames a stretch's tile shows: its start and end a little inside it, and its middle; inside 0..duration. */
export function stretchTimes(s: { a: number; b: number }, duration: number): number[] {
  const inset = Math.min(STRETCH_INSET_S, (s.b - s.a) / 4);
  const at = (t: number) => Math.max(0, Math.min(duration > 0.1 ? duration - 0.1 : t, t));
  return [at(s.a + inset), at((s.a + s.b) / 2), at(s.b - inset)];
}

/**
 * A sheet of up to SHEET_STRETCHES stretches of `src` (stretchTimes each, STRETCH_FRAMES side by side a tile), tiles in
 * reading order, written as a JPEG to `out`. Made a row at a time like contactSheet: a few seeks per ffmpeg run, one
 * thread each, the runs short so other work gets the ffmpeg slot in between.
 */
export async function stretchSheet(src: string, stretches: { a: number; b: number }[], duration: number, landscape: boolean, out: string): Promise<void> {
  const [w, h] = landscape ? [FRAME_W, FRAME_H] : [FRAME_H, FRAME_W];
  const cols = landscape ? STRETCH_COLS.landscape : STRETCH_COLS.portrait;
  const cell = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w + 8}:${h + 8}:(ow-iw)/2:(oh-ih)/2:white,setsar=1`;
  const across = cols * STRETCH_FRAMES;
  const rows: string[] = [];
  try {
    for (let r = 0; r * cols < stretches.length; r++) {
      const these = stretches.slice(r * cols, (r + 1) * cols).flatMap((s) => stretchTimes(s, duration));
      const args = these.flatMap((t) => ["-threads", "1", "-ss", t.toFixed(3), "-i", src]);
      const blanks = across - these.length;
      const graph =
        these.map((_, j) => `[${j}:v:0]${cell}[f${j}]`).join(";") +
        (blanks ? `;color=white:s=${w + 8}x${h + 8}:d=1,split=${blanks}${Array.from({ length: blanks }, (_, k) => `[b${k}]`).join("")}` : "") +
        ";" +
        [...these.map((_, j) => `[f${j}]`), ...Array.from({ length: blanks }, (_, k) => `[b${k}]`)].join("") +
        `hstack=inputs=${across}`;
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

/**
 * The look at contact sheets. `rated` (the Media Library's shot descriptions, shots.ts): each shot also gets how much
 * happens in it, whether its subject is easy to see and a few tags (RATE_RUBRIC), answered as a list. Unrated, the
 * prompt is the AI Editor's as it always was.
 */
export function lookPrompt(lines: string[], story: boolean, workspace = "", rated = false): { system: string; user: string } {
  const shape = rated ? '{"shots": [{"n": 1, "text": "a few words", "action": 0, "clear": true, "tags": ["…"]}, …]}' : '{"shots": {"1": "a few words", "2": "…"}}';
  return {
    system:
      "You look at contact sheets of footage for a video editor, so it can pick shots without watching them. For each numbered " +
      "shot say in a few words what is seen: the subject, the action, the setting and the kind of shot (wide, close, screen, text). " +
      (rated ? `${RATE_RUBRIC} ` : "") +
      `${RULE} Answer with JSON only.`,
    user: [
      ...(workspace
        ? [`The workspace the footage is for. Use it to name what is seen (the product, the game, its places and features) when the pictures show it; never add what they don't show:\n${workspace}`]
        : []),
      ...lines,
      story
        ? `Answer as ${shape.slice(0, -1)}, "story": "what happens across all of the footage, in order, told from the pictures alone, in a few sentences"}`
        : `Answer as ${shape}`,
    ].join("\n\n"),
  };
}

/**
 * How a rated look scores each shot (lookPrompt `rated`), word for word as measured on 2026-11-15 (tasks/flywheel stage
 * 1.0): with three frames a stretch (stretchSheet) it scored 97% of dull stretches 2 or lower and 95% of action ones 3
 * or higher. Only 0 and 5 are named: the steps between were not measured, so they are not defined here.
 */
export const RATE_RUBRIC =
  "For each shot also give action from 0 to 5: 0 nothing changes (a menu, loading, standing), 5 a peak; clear: the main subject " +
  "is easy to see; and up to three tags, free words.";

export interface RatedLine {
  text: string;
  action: number;
  clear: boolean;
  tags: string[];
}

/**
 * A rated look's answer: each numbered shot's line, cut to the caps (STRETCH_TEXT_MAX, STRETCH_TAGS), from the list the
 * prompt asks for (or an object by number). Throws when no shot has one; `lenient`: none is an empty answer.
 */
export function parseRated(text: string, lenient = false): Record<string, RatedLine> {
  const out: Record<string, RatedLine> = {};
  let o: Record<string, unknown> = {};
  try {
    o = parseJsonObject(text);
  } catch (e) {
    if (!lenient) throw e;
  }
  const entries: [unknown, unknown][] = Array.isArray(o.shots)
    ? o.shots.map((v) => [(v as { n?: unknown } | null)?.n, v])
    : o.shots && typeof o.shots === "object"
      ? Object.entries(o.shots as Record<string, unknown>)
      : [];
  for (const [k, v] of entries) {
    const n = typeof k === "number" ? k : parseInt(String(k), 10);
    const line = ratedLine(v);
    if (line && Number.isSafeInteger(n) && n > 0) out[String(n)] = line;
  }
  if (!lenient && !Object.keys(out).length) throw new Error("The AI described no shot");
  return out;
}

/** One line checked: text trimmed and capped, action a whole 0..5, tags lowercase and capped; null without text. */
export function ratedLine(v: unknown): RatedLine | null {
  const r = (typeof v === "string" ? { text: v } : v) as Record<string, unknown> | null;
  const text = typeof r?.text === "string" ? r.text.trim().replace(/\s+/g, " ").slice(0, STRETCH_TEXT_MAX) : "";
  if (!text) return null;
  const n = Number(r!.action);
  const tags = Array.isArray(r!.tags)
    ? [...new Set(r!.tags.filter((t): t is string => typeof t === "string").map((t) => t.trim().toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, STRETCH_TAGS)
    : [];
  return { text, action: Number.isFinite(n) ? Math.max(0, Math.min(5, Math.round(n))) : 0, clear: r!.clear === true, tags };
}

/** Bits two picture hashes may differ in and still show the same picture (64-bit difference hashes). */
export const SAME_PICTURE_BITS = 10;

/**
 * Whether two 64-bit picture hashes (16 hex digits, the difference hash of a frame's 9×8 grey: each bit says whether a
 * pixel is brighter than its right-hand neighbour) show the same picture: the one check a cut gets mechanically, that
 * a picture is shown once (tasks/flywheel/PLAN.md D9). An empty or malformed hash is never the same as anything.
 */
export function samePicture(a: string, b: string, maxBits = SAME_PICTURE_BITS): boolean {
  if (!/^[0-9a-f]{16}$/i.test(a) || !/^[0-9a-f]{16}$/i.test(b)) return false;
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let bits = 0;
  while (x) (bits += Number(x & 1n)), (x >>= 1n);
  return bits <= maxBits;
}

/** The difference hash of one 9×8 grey frame (72 bytes, row by row), as 16 hex digits: what samePicture compares. */
export function pictureHash(gray9x8: Uint8Array): string {
  if (gray9x8.length < 72) throw new Error("A picture hash needs a 9×8 grey frame");
  let h = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) h = (h << 1n) | (gray9x8[y * 9 + x]! > gray9x8[y * 9 + x + 1]! ? 1n : 0n);
  return h.toString(16).padStart(16, "0");
}
