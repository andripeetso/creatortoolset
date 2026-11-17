import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import type { IndexShot } from "../../contracts/edit-plan";
import { LOOK_LEVELS, STRETCH_TAGS, STRETCH_TEXT_MAX, type LookLevel } from "../../contracts/library";
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
export const FW = 64;
export const FH = 36;
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
/** A take longer than its level's `long` seconds is split, no piece shorter than its `piece` (contracts LOOK_LEVELS) */
const spanOf = (level: LookLevel) => LOOK_LEVELS.find((l) => l.value === level)!;
/** The change over this long (s) says where a long take changes most */
export const LAG_S = 0.5;
/** Movement (mean |Δ| a second) below which a source counts as still, whatever its own most is */
const STILL_PER_S = 0.15;

/**
 * Junk: pictures that are no shot (a world map or a dark crop of a game's skill buttons in a cut is noise). Measured on
 * the FW×FH grey frame (`looks`), set on real game footage (desktop, phone, screen recordings; frames per bin looked
 * at): a black, fade or loading frame has detail under FLAT; real dark-dungeon fights sit at luma 0.06-0.08 with detail
 * 0.04+; a frame whose 4×4 blocks are flat panels (spread under 3 grey levels, not black) for UI_PANELS or more, and
 * whose panels are near grey (chroma under UI_TINT: desktops and menus measured 8-14, a colourful snow fight 35+, test
 * patterns and cartoons far more), is a desktop, web page or menu; a stretch whose change over LAG_S (mean |Δ| in grey
 * levels) has a median under STILL is a map, inventory, menu, character select or someone standing. A shot is junk when
 * JUNK_SHARE of its LAG_S samples are, or it sits still.
 */
export const DARK = 0.06;
export const FLAT = 0.03;
export const UI_PANELS = 0.3;
export const UI_TINT = 20;
export const STILL = 0.6;
const JUNK_SHARE = 0.2;
/** HUD: a 16×9 cell that changes under 2 grey levels over LAG_S in STEADY of the frames where the rest moves (a game's
 * bottom bars measured 0.8-0.9, its world under 0.3). A crop window more than HUD_MAX of it never fills the frame. */
const STEADY = 0.6;
export const HUD_MAX = 0.5;
/** The grid a frame's change is kept on (PictureRead.maps): CX across, CY down */
export const CX = 16;
export const CY = 9;

export interface PictureRead {
  /** frames read a second */
  fps: number;
  /** change from the frame before (mean |Δ| of grey 0..1; index 0: 0) */
  step: Float32Array;
  /** the same over the two frames' contrast: what a cut is read on */
  cut: Float32Array;
  /** change from LAG_S before (0 until then) */
  lag: Float32Array;
  /** each frame's junk ("" when it is a picture), from `looks` */
  junk?: string[];
  /** where each frame changed from LAG_S before: CX×CY cells (row by row), mean |Δ| × 4, frames one after another */
  maps?: Uint8Array;
}

/** Which CX×CY cells of a FW×FH grey frame are flat (their 4×4 pixels spread under 3 grey levels): 1 = flat. */
function flatCells(f: Uint8Array): Uint8Array {
  const out = new Uint8Array(CX * CY);
  for (let cy = 0; cy < CY; cy++)
    for (let cx = 0; cx < CX; cx++) {
      let s = 0;
      let q = 0;
      for (let y = cy * 4; y < cy * 4 + 4; y++) for (let x = cx * 4; x < cx * 4 + 4; x++) (s += f[y * FW + x]!), (q += f[y * FW + x]! ** 2);
      out[cy * CX + cx] = Math.sqrt(Math.max(0, q / 16 - (s / 16) ** 2)) < 3 ? 1 : 0;
    }
  return out;
}

/** An RGB picture as grey (BT.601 luma, 0..255) and each pixel's chroma (its distance from grey, as YCbCr's Cb, Cr). */
export function grey(rgb: Uint8Array): [Buffer, Float32Array] {
  const n = rgb.length / 3;
  const g = Buffer.alloc(n);
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const [r, gr, b] = [rgb[3 * i]!, rgb[3 * i + 1]!, rgb[3 * i + 2]!];
    g[i] = Math.round(0.299 * r + 0.587 * gr + 0.114 * b);
    c[i] = Math.hypot(-0.1687 * r - 0.3313 * gr + 0.5 * b, 0.5 * r - 0.4187 * gr - 0.0813 * b);
  }
  return [g, c];
}

/** (luma 0..1, detail: mean |step| between neighbours 0..1, the share of 4×4 blocks that are flat panels, those panels'
 * mean chroma when `chroma` is given) of a grey picture `w`×`h` at the index's scale (FW×FH for a whole frame). */
export function looks(g: ArrayLike<number>, w: number, h: number, chroma?: ArrayLike<number>): { luma: number; detail: number; panels: number; tint: number } {
  let sum = 0;
  let dx = 0;
  let dy = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = g[y * w + x]!;
      sum += v;
      if (x) dx += Math.abs(v - g[y * w + x - 1]!);
      if (y) dy += Math.abs(v - g[(y - 1) * w + x]!);
    }
  let flat = 0;
  let tint = 0;
  const bw = Math.floor(w / 4);
  const bh = Math.floor(h / 4);
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      let s = 0;
      let q = 0;
      for (let y = by * 4; y < by * 4 + 4; y++)
        for (let x = bx * 4; x < bx * 4 + 4; x++) (s += g[y * w + x]!), (q += g[y * w + x]! ** 2);
      const mean = s / 16;
      if (Math.sqrt(Math.max(0, q / 16 - mean * mean)) >= 3 || mean <= 25) continue;
      flat++;
      if (chroma) for (let y = by * 4; y < by * 4 + 4; y++) for (let x = bx * 4; x < bx * 4 + 4; x++) tint += chroma[y * w + x]! / 16;
    }
  const detail = w > 1 && h > 1 ? (dx / (h * (w - 1)) + dy / ((h - 1) * w)) / 255 : 0;
  return { luma: sum / (w * h) / 255, detail, panels: bw * bh ? flat / (bw * bh) : 0, tint: flat ? tint / flat : 0 };
}

/** Why a picture is no shot: "dark", "flat" (black, a fade, a loading screen) or "ui" (a desktop, page or menu: grey
 * flat panels); "" when it is one. */
export const junkOf = ({ luma, detail, panels, tint = 0 }: { luma: number; detail: number; panels: number; tint?: number }) =>
  luma < DARK ? "dark" : detail < FLAT ? "flat" : panels >= UI_PANELS && tint < UI_TINT ? "ui" : "";

/** Every frame of `src` (or of its stretch a..b s) at up to MAX_READ_FPS, FW×FH grey, compared with the one before and the one LAG_S before. */
export async function readPicture(src: string, fps: number, signal?: AbortSignal, span?: { a: number; b: number }): Promise<PictureRead> {
  const rate = fps > 0 ? Math.min(fps, MAX_READ_FPS) : 25;
  const L = Math.max(1, Math.round(LAG_S * rate));
  const size = FW * FH;
  return ffmpegSlot(
    () =>
      new Promise((resolve, reject) => {
        const p = spawn(
          ffmpegCommand(),
          ["-hide_banner", "-loglevel", "error", "-nostdin", ...(span ? ["-ss", String(span.a), "-t", String(Math.max(0.1, span.b - span.a))] : []), "-i", src, "-an", "-sn", "-vf", `fps=${rate},scale=${FW}:${FH}:flags=area,format=rgb24`, "-f", "rawvideo", "pipe:1"],
          { signal },
        );
        const ring: Buffer[] = []; // the last L+1 frames
        const flats: Uint8Array[] = []; // and which of their cells are flat
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
        const junk: string[] = [];
        const maps: Uint8Array[] = [];
        const diff = (x: Buffer, y: Buffer) => {
          let s = 0;
          for (let i = 0; i < size; i++) s += Math.abs(x[i]! - y[i]!);
          return s / size / 255;
        };
        let carry = Buffer.alloc(0);
        let err = "";
        p.stdout.on("data", (d: Buffer) => {
          let buf = carry.length ? Buffer.concat([carry, d]) : d;
          while (buf.length >= 3 * size) {
            const [f, tint] = grey(buf.subarray(0, 3 * size));
            buf = buf.subarray(3 * size);
            const prev = ring[ring.length - 1];
            const d = prev ? diff(f, prev) : 0;
            const sp = spread(f);
            step.push(d);
            cut.push(prev ? d / Math.max(SPREAD_FLOOR, (sp + spreadBefore) / 2) : 0);
            spreadBefore = sp;
            const back = ring.length > L ? ring[ring.length - 1 - L]! : undefined;
            lag.push(back ? diff(f, back) : 0);
            junk.push(junkOf(looks(f, FW, FH, tint)));
            // where it moves: change in a cell with texture (a flat panel flipping from white to black is no action)
            const flat = flatCells(f);
            const backFlat = ring.length > L ? flats[flats.length - 1 - L]! : undefined;
            const cells = new Uint8Array(CX * CY);
            if (back)
              for (let cy = 0; cy < CY; cy++)
                for (let cx = 0; cx < CX; cx++) {
                  if (flat[cy * CX + cx] && backFlat![cy * CX + cx]) continue;
                  let s = 0;
                  for (let y = cy * 4; y < cy * 4 + 4; y++) for (let x = cx * 4; x < cx * 4 + 4; x++) s += Math.abs(f[y * FW + x]! - back[y * FW + x]!);
                  cells[cy * CX + cx] = Math.min(255, Math.round((s / 16) * 4));
                }
            maps.push(cells);
            ring.push(f);
            flats.push(flat);
            if (ring.length > L + 1) ring.shift(), flats.shift();
          }
          carry = Buffer.from(buf);
        });
        p.stderr.on("data", (d) => (err = (err + d.toString()).slice(-2000)));
        p.on("error", reject);
        p.on("close", (code) => {
          if (code !== 0) return reject(new Error(err.trim() || `ffmpeg exited ${code}`));
          const all = new Uint8Array(maps.length * CX * CY);
          maps.forEach((m, i) => all.set(m, i * CX * CY));
          resolve({ fps: rate, step: Float32Array.from(step), cut: Float32Array.from(cut), lag: Float32Array.from(lag), junk, maps: all });
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

/** Splits frames [a, b) into pieces of the level's piece..long seconds where the picture changes most (the lag change's peak). */
export function splitLong(a: number, b: number, read: PictureRead, level: LookLevel = "standard"): number[] {
  const { fps, lag } = read;
  const { long: LONG_S, piece: PIECE_S } = spanOf(level);
  if (b - a <= LONG_S * fps) return [];
  const half = Math.round((LAG_S * fps) / 2);
  let best = -1;
  let at = Math.round((a + b) / 2);
  for (let i = Math.ceil(a + PIECE_S * fps); i <= Math.floor(b - PIECE_S * fps); i++) {
    const v = lag[Math.min(lag.length - 1, i + half)] ?? 0; // the change over LAG_S, centred on i
    if (v > best) [best, at] = [v, i];
  }
  return [...splitLong(a, at, read, level), at, ...splitLong(at, b, read, level)];
}

/** Shots covering 0..dur from what was read: cuts, long takes split (at the library's `level`), motion against the source's own most. */
export function shotsOf(read: PictureRead, dur: number, level: LookLevel = "standard"): IndexShot[] {
  const n = read.step.length;
  if (!n) return dur > 0 ? [{ a: 0, b: dur, motion: 0 }] : [];
  const edges = [0, ...cutsOf(read), n];
  const all: number[] = [0];
  for (let k = 1; k < edges.length; k++) all.push(...splitLong(edges[k - 1]!, edges[k]!, read, level), edges[k]!);
  const per: number[] = [];
  for (let k = 1; k < all.length; k++) {
    let s = 0;
    let c = 0;
    for (let i = all[k - 1]! + 1; i < all[k]!; i++) (s += read.step[i]!), c++;
    per.push(c ? (s / c) * read.fps : 0);
  }
  const most = Math.max(STILL_PER_S, ...per);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const hud = hudOf(read);
  return per.map((m, k) => ({
    a: r2(all[k]! / read.fps),
    b: k === per.length - 1 ? dur : r2(all[k + 1]! / read.fps),
    motion: r2(Math.min(1, m / most)),
    ...pictureOf(read, all[k]!, all[k + 1]!, hud),
  }));
}

/** The HUD of what was read: the CX×CY cells that change under 2 grey levels over LAG_S in STEADY of the frames whose
 * change is over its median (where the rest moves): a game's bars and buttons. Row by row, 1 = HUD. */
export function hudOf(read: PictureRead): number[] {
  const out = new Array<number>(CX * CY).fill(0);
  const { maps, lag } = read;
  if (!maps?.length) return out;
  const L = Math.max(1, Math.round(LAG_S * read.fps));
  const live = Array.from(lag).slice(L);
  const mid = median(live);
  const act: number[] = [];
  for (let i = L; i < lag.length; i++) if (lag[i]! > mid) act.push(i);
  if (!act.length) return out;
  for (let c = 0; c < CX * CY; c++) {
    let still = 0;
    for (const i of act) if (maps[i * CX * CY + c]! < 8) still++;
    out[c] = still / act.length >= STEADY ? 1 : 0;
  }
  return out;
}

/** A shot's frames [a, b) as a picture: why it is junk (JUNK_SHARE of its LAG_S samples junk, or it sits still) and
 * where it moves, the HUD left out. */
function pictureOf(read: PictureRead, a: number, b: number, hud: number[]): Pick<IndexShot, "junk" | "moves"> {
  if (!read.junk?.length || !read.maps) return {};
  const L = Math.max(1, Math.round(LAG_S * read.fps));
  const codes: string[] = [];
  const lags: number[] = [];
  const cols = new Array<number>(CX).fill(0);
  const rows = new Array<number>(CY).fill(0);
  for (let i = a; i < Math.max(a + 1, b) && i < read.junk.length; i += L) {
    codes.push(read.junk[i]!);
    if (i < L) continue;
    lags.push(read.lag[i]!);
    for (let c = 0; c < CX * CY; c++) {
      if (hud[c]) continue;
      const v = read.maps[i * CX * CY + c]!;
      cols[c % CX] += v;
      rows[Math.floor(c / CX)] += v;
    }
  }
  const bad = codes.filter(Boolean);
  const junk = codes.length && bad.length / codes.length >= JUNK_SHARE ? bad.sort((x, y) => bad.filter((z) => z === y).length - bad.filter((z) => z === x).length)[0] : lags.length && median(lags) < STILL / 255 ? "still" : "";
  const tot = cols.reduce((x, y) => x + y, 0);
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return { ...(junk ? { junk } : {}), ...(tot > 0 ? { moves: { cols: cols.map((x) => r3(x / tot)), rows: rows.map((x) => r3(x / tot)) } } : {}) };
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
      // a rated look's action 0 is its junk; the AI Editor's own look marks junk in words (isJunk)
      (rated
        ? `${RATE_RUBRIC} `
        : 'A shot that shows no action, only a map, an inventory, a menu, character select, a loading screen, a chat window, a desktop, a dark or empty frame, or mostly a game\'s buttons and bars, begins with "junk:" and that kind ("junk: map", "junk: menu", "junk: loading", "junk: dark", "junk: ui"). ') +
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

/**
 * Bits two picture hashes may differ in and still show the same picture (64-bit difference hashes). Measured on real
 * gameplay with a fixed camera: the same standing scene 0-3 bits apart, different moments of one fight 3-14 (mostly
 * 6-11), different files 18-25. At 10 a cut could take only about two stretches of a 25-second fight.
 * ponytail: the hash covers the whole frame, the HUD included, so moments that look alike stay apart only by this
 * threshold; hash the picture without the HUD (look.ts hudOf) if repeats get through.
 */
export const SAME_PICTURE_BITS = 4;

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
