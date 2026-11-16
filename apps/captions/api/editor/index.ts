import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { FootageIndex, IndexShot, IndexSource, SongBeats } from "../../contracts/edit-plan";
import { aiFor, completeWithFallback } from "../ai-complete";
import { completeVisionWithFallback } from "../ai-vision";
import { ffmpegCommand } from "../ffmpeg-runtime";
import { env } from "../lib/env";
import { parseJsonObject } from "../lib/instagram/vision";
import { libraryDb } from "../library/db";
import { whoFor } from "../library/describe";
import { ffmpegSlot, ffmpegTo, writeJsonAtomic } from "../library/media/run";
import type { ProbeSummary } from "../library/media/probe";
import { NeedsKey, segmentsOf, wordsOf } from "../library/transcribe";
import { Waiting } from "./analyze";
import { readable } from "./media";
import { macAway } from "./script";

/**
 * The footage index for an edit planned as shots (contracts/edit-plan.ts): what each source holds, from its picture
 * alone, and where a song's beats, hits and parts are. Any footage, not only someone talking: shots between picture
 * changes, long takes split where the picture changes most, how much moves in each, and, from the person's own AI
 * looking at contact sheets, what is seen. The measuring is plain arithmetic on what ffmpeg decodes; nothing else runs.
 */

// ── the picture ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Bump when the shots a source gets would change: a cached index of another version is read again. */
const INDEX_V = 2;
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
/** A phone game's skill buttons sit over a moving world and never stay put: in a very wide picture (a 9:16 window
 * under WIDE of its width, a phone's 2.2:1) a window at the outer EDGE of either side never fills either. */
const WIDE = 0.3;
const EDGE = 0.15;
/** A crop window off-centre must hold this much more of what moves: a game keeps its hero in the middle */
const CENTRE = 0.25;
const CX = 16;
const CY = 9;

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
          ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", src, "-an", "-sn", "-vf", `fps=${rate},scale=${FW}:${FH}:flags=area,format=rgb24`, "-f", "rawvideo", "pipe:1"],
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

const median = (xs: number[]) => {
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
function splitLong(a: number, b: number, read: PictureRead): number[] {
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

/** A shot is no shot: measured junk, or the AI saw "junk: …" on the contact sheet. */
export const isJunk = (x: Pick<IndexShot, "junk" | "desc">) => !!x.junk || /^junk\b/i.test(x.desc ?? "");

/** A window `r` of a line of cells wide over shares `e`: the place holding the most, a centred one favoured by CENTRE
 * -> [place 0..1, share held, first and last edge as fractions]. */
function place(e: number[], r: number): [number, number, number, number] {
  if (r >= 0.98) return [0.5, 1, 0, 1];
  const n = e.length;
  const cum = [0];
  for (const v of e) cum.push(cum[cum.length - 1]! + v);
  const tot = cum[n]!;
  const at = (u: number) => {
    const x = Math.min(n, Math.max(0, u));
    const i = Math.min(n - 1, Math.floor(x));
    return cum[i]! + (cum[i + 1]! - cum[i]!) * (x - i);
  };
  const held = (x: number) => (tot > 0 ? (at((x * (1 - r) + r) * n) - at(x * (1 - r) * n)) / tot : r);
  let best = 0;
  let score = -Infinity;
  for (let k = 0; k <= 40; k++) {
    const x = k / 40;
    const v = held(x) + CENTRE * (1 - 2 * Math.abs(x - 0.5));
    if (v > score + 1e-12) [best, score] = [x, v];
  }
  return [Math.round(best * 1000) / 1000, held(best), best * (1 - r), best * (1 - r) + r];
}

/**
 * Where a w:h crop window sits in a source's picture for its stretch a..b s, so it shows what moves there, never a HUD
 * corner or empty floor: the shots' change across and down, weighted by how much of
 * each the stretch covers, the HUD left out; then the window holding the most (`place`). One window a shot, no drift.
 * `ok` is false when no window of that shape holds its share of what moves, it is more than HUD_MAX HUD, or it sits at
 * the edge of a very wide picture (WIDE, EDGE): a fill becomes a blur (the whole picture over a blurred copy).
 */
export function focusOf(src: Pick<IndexSource, "w" | "h" | "shots" | "hud">, a: number, b: number, w: number, h: number): { x: number; y: number; ok: boolean } {
  const cols = new Array<number>(CX).fill(0);
  const rows = new Array<number>(CY).fill(0);
  for (const x of src.shots) {
    const k = Math.max(0, Math.min(b, x.b) - Math.max(a, x.a)) / Math.max(1e-6, x.b - x.a);
    if (k <= 0 || !x.moves) continue;
    x.moves.cols.forEach((v, i) => (cols[i] += k * v));
    x.moves.rows.forEach((v, i) => (rows[i] += k * v));
  }
  const rx = Math.min(1, w / h / (src.w / src.h));
  const ry = Math.min(1, src.w / src.h / (w / h));
  const [x, hx, x0, x1] = place(cols, rx);
  const [y, hy, y0, y1] = place(rows, ry);
  const hud = src.hud ?? [];
  let n = 0;
  let on = 0;
  const c0 = Math.floor(x0 * CX + 1e-6);
  const r0 = Math.floor(y0 * CY + 1e-6);
  for (let r = r0; r < Math.max(r0 + 1, Math.ceil(y1 * CY - 1e-6)); r++)
    for (let c = c0; c < Math.max(c0 + 1, Math.ceil(x1 * CX - 1e-6)); c++) (n++, (on += hud[r * CX + c] ?? 0));
  return { x, y, ok: on / Math.max(1, n) <= HUD_MAX && hx >= 0.85 * rx && hy >= 0.85 * ry && (rx >= WIDE || (x >= EDGE && x <= 1 - EDGE)) };
}

/**
 * One version's index as cached: everything but `speech`, which a transcript arriving later changes. `looked`: the AI
 * has looked at it (describeShots), so a shot it left without words is not asked about again.
 */
const indexFile = (versionId: string) => path.join(env.dataDir, "editor", "cache", `${versionId}.index.json`);
type Cached = { v: number; src: Omit<IndexSource, "speech">; looked?: true };

async function cached(versionId: string): Promise<Cached | null> {
  try {
    const c = JSON.parse(await readFile(indexFile(versionId), "utf8")) as Cached;
    return c.v === INDEX_V ? c : null;
  } catch {
    return null;
  }
}

async function keep(src: Omit<IndexSource, "speech"> & { speech?: boolean }, looked = false): Promise<void> {
  const { speech: _, ...rest } = src;
  await mkdir(path.dirname(indexFile(src.id)), { recursive: true });
  await writeJsonAtomic(indexFile(src.id), { v: INDEX_V, src: rest, ...(looked ? { looked: true as const } : {}) } satisfies Cached);
}

interface Row {
  id: string;
  source_key: string;
  probe: string | null;
  state: string;
  title: string;
}

const rowOf = (id: string) =>
  libraryDb()
    .prepare("SELECT v.id, v.source_key, v.probe, v.state, a.title FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?")
    .get(id) as Row | undefined;

/**
 * What every source of the edit holds: length, frame rate, size, whether someone speaks, and its shots. A source not
 * probed yet, or whose transcript is being made, makes it wait (Waiting); one with no picture (a song) has no shots.
 * The picture is read once per version and cached; a transcript is never asked for here (analyze does that).
 */
export async function indexSources(edit: { sources: string[] }, signal: AbortSignal): Promise<FootageIndex> {
  const db = libraryDb();
  const sources: IndexSource[] = [];
  for (const id of edit.sources) {
    if (signal.aborted) throw signal.reason ?? new Error("Stopped");
    const row = rowOf(id);
    if (!row) throw new Error(`A source of the edit is gone from the library (${id})`);
    const probe = JSON.parse(row.probe ?? "null") as ProbeSummary | null;
    if (!probe) {
      if (row.state === "failed") throw new Error(`“${row.title}” could not be read by the library`);
      throw new Waiting();
    }
    const t = db.prepare("SELECT state FROM jobs WHERE version_id = ? AND kind = 'transcribe'").get(id) as { state: string } | undefined;
    if (t?.state === "queued" || t?.state === "running") throw new Waiting();
    const speech = !!(wordsOf(db, id)?.length || segmentsOf(db, id).length);
    let src = (await cached(id))?.src;
    if (!src) {
      const turned = probe.rotation === 90 || probe.rotation === 270;
      const picture = !!probe.vcodec && !probe.cover;
      const read = picture ? await readPicture(await readable(id, row.source_key), probe.fps, signal) : null;
      const shots = read ? shotsOf(read, probe.duration) : [];
      src = { id, title: row.title, dur: probe.duration, fps: probe.fps, w: turned ? probe.height : probe.width, h: turned ? probe.width : probe.height, shots, ...(read ? { hud: hudOf(read) } : {}) };
      await keep(src);
    }
    sources.push({ ...src, title: row.title, speech });
  }
  return { sources };
}

/**
 * The last look before a shot is used: its frame at `t` s as the shot shows it (a `shape` window at `focus`, else the
 * whole picture), at the index's scale -> why it is no shot (`junkOf`, or "ui" when more than UI_BRIGHT of it is bright
 * and colourless: an app window or a document; snow stays well under), "" when fine or unreadable.
 */
export async function frameJunk(file: string, t: number, size: { w: number; h: number }, shape: [number, number] | null, focus?: { x: number; y: number }, signal?: AbortSignal): Promise<string> {
  const buf = await ffmpegSlot(
    () =>
      new Promise<Buffer>((resolve) => {
        const p = spawn(
          ffmpegCommand(),
          ["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", Math.max(0, t).toFixed(3), "-i", file, "-frames:v", "1", "-vf", "scale='if(gte(iw,ih),256,-2)':'if(gte(iw,ih),-2,256)'", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
          { signal },
        );
        const parts: Buffer[] = [];
        p.stdout.on("data", (d: Buffer) => parts.push(d));
        p.on("error", () => resolve(Buffer.alloc(0)));
        p.on("close", () => resolve(Buffer.concat(parts)));
      }),
  );
  if (!buf.length) return "";
  // the frame is 256 on its long side
  const [W, H] = size.w >= size.h ? [256, buf.length / 3 / 256] : [buf.length / 3 / 256, 256];
  if (!Number.isInteger(W) || !Number.isInteger(H)) return "";
  let [x0, y0, cw, ch] = [0, 0, W, H];
  if (shape) {
    const r = shape[0] / shape[1] / (W / H);
    [cw, ch] = r < 1 ? [Math.round(W * r), H] : [W, Math.round(H / r)];
    [x0, y0] = [Math.round((W - cw) * (focus?.x ?? 0.5)), Math.round((H - ch) * (focus?.y ?? 0.5))];
  }
  const gw = Math.max(4, Math.floor(cw / 4));
  const gh = Math.max(4, Math.floor(ch / 4));
  const g = new Float32Array(gw * gh);
  const ch2 = new Float32Array(gw * gh);
  let bright = 0;
  for (let y = 0; y < gh * 4 && y < ch; y++)
    for (let x = 0; x < gw * 4 && x < cw; x++) {
      const i = ((y0 + y) * W + x0 + x) * 3;
      const [r, gr, b] = [buf[i]!, buf[i + 1]!, buf[i + 2]!];
      const hi = Math.max(r, gr, b);
      if (hi > 217 && (hi - Math.min(r, gr, b)) / hi < 31 / 255) bright++;
      const j = Math.floor(y / 4) * gw + Math.floor(x / 4);
      g[j] += (0.299 * r + 0.587 * gr + 0.114 * b) / 16;
      ch2[j] += Math.hypot(-0.1687 * r - 0.3313 * gr + 0.5 * b, 0.5 * r - 0.4187 * gr - 0.0813 * b) / 16;
    }
  return junkOf(looks(g, gw, gh, ch2)) || (bright / (Math.min(ch, gh * 4) * Math.min(cw, gw * 4)) > UI_BRIGHT ? "ui" : "");
}

/** A window more than this share bright and colourless is an app window or a document, not a shot */
const UI_BRIGHT = 0.2;

// ── contact sheets and the person's AI ──────────────────────────────────────────────────────────────────────────

const LABEL = "AI Editor footage";
/** Tiles a sheet: COLS across, up to ROWS down, one frame (the middle) per shot */
const COLS = 4;
const ROWS = 4;
/** Sheets in one call: a call reads up to SHEETS_PER_CALL × COLS × ROWS shots */
const SHEETS_PER_CALL = 6;
/** Sheets per source at most: a longer source has every k-th shot looked at, the rest left without words */
const MAX_SHEETS = 8;

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

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** One tile of a call: which shot of which source, and its number in the call (from 1). */
interface Tile {
  src: number;
  shot: number;
  n: number;
}

interface Sheet {
  src: number;
  tiles: Tile[];
}

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

const RULE = 'Never say who anyone is: no names, no guessed ages, no identities; "a person" or "people" is enough.';

export function lookPrompt(lines: string[], story: boolean, workspace = ""): { system: string; user: string } {
  return {
    system:
      "You look at contact sheets of footage for a video editor, so it can pick shots without watching them. For each numbered " +
      "shot say in a few words what is seen: the subject, the action, the setting and the kind of shot (wide, close, screen, text). " +
      'A shot that shows no action, only a map, an inventory, a menu, character select, a loading screen, a chat window, a desktop, a dark or empty frame, or mostly a game\'s buttons and bars, begins with "junk:" and that kind ("junk: map", "junk: menu", "junk: loading", "junk: dark", "junk: ui"). ' +
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

/**
 * Fills each shot's `desc` (and the index's `story` when `ai.story`) from the person's own AI looking at contact
 * sheets: one frame per shot, COLS × ROWS to a sheet, up to SHEETS_PER_CALL sheets in one call across sources. A
 * one-shot source the library has described already takes the library's words with no call. What was said is kept
 * with the source's cached index, so a second edit of the same footage asks nothing.
 */
export async function describeShots(index: FootageIndex, ai: { actor: string; story?: boolean; workspace?: string }, signal: AbortSignal): Promise<FootageIndex> {
  const who = whoFor(ai.actor);
  const route = aiFor(who, "editor", LABEL);
  if (route.off) throw new NeedsKey(route.off);
  const db = libraryDb();
  const libraryWords = (id: string) =>
    (db.prepare("SELECT text FROM descriptions WHERE version_id = ? ORDER BY source = 'user' DESC LIMIT 1").get(id) as { text: string } | undefined)?.text;
  const sources = index.sources.map((s) => ({ ...s, shots: s.shots.map((x) => ({ ...x })) }));
  const sheets: Sheet[] = [];
  for (const [si, s] of sources.entries()) {
    const open = s.shots.map((x, i) => (x.desc ? -1 : i)).filter((i) => i >= 0);
    if (!open.length || (await cached(s.id))?.looked) continue;
    const known = libraryWords(s.id);
    if (s.shots.length === 1 && known) {
      s.shots[0]!.desc = known.slice(0, 200);
      await keep(s, true);
      continue;
    }
    // ponytail: a source past MAX_SHEETS sheets has every k-th open shot looked at; the rest stay without words
    const cap = MAX_SHEETS * COLS * ROWS;
    const picked = open.length <= cap ? open : Array.from({ length: cap }, (_, k) => open[Math.floor((k * open.length) / cap)]!);
    for (let i = 0; i < picked.length; i += COLS * ROWS) sheets.push({ src: si, tiles: picked.slice(i, i + COLS * ROWS).map((shot) => ({ src: si, shot, n: 0 })) });
  }
  let story: string | undefined;
  const scratch = path.join(env.dataDir, "editor", "cache", `sheets-${randomUUID()}`);
  try {
    for (let c = 0; c < sheets.length; c += SHEETS_PER_CALL) {
      if (signal.aborted) throw signal.reason ?? new Error("Stopped");
      const batch = sheets.slice(c, c + SHEETS_PER_CALL);
      const last = c + SHEETS_PER_CALL >= sheets.length;
      await mkdir(scratch, { recursive: true });
      const lines: string[] = [];
      const images = [];
      let n = 0;
      for (const [k, sh] of batch.entries()) {
        const s = sources[sh.src]!;
        const row = rowOf(s.id);
        if (!row) throw new Error(`A source of the edit is gone from the library (${s.id})`);
        const file = path.join(scratch, `${k}.jpg`);
        await contactSheet(
          await readable(s.id, row.source_key),
          sh.tiles.map((t) => Math.max(0, Math.min(s.dur - 0.1, (s.shots[t.shot]!.a + s.shots[t.shot]!.b) / 2))),
          s.w >= s.h,
          file,
        );
        images.push({ jpegBase64: (await readFile(file)).toString("base64") });
        for (const t of sh.tiles) t.n = ++n;
        const known = libraryWords(s.id);
        lines.push(
          `Picture ${k + 1}: from “${s.title}”${known ? ` (the library describes it as: ${known.slice(0, 400)})` : ""}. Its tiles, left to right, top to bottom, are shots ` +
            sh.tiles.map((t) => `${t.n} (${clock(s.shots[t.shot]!.a)}–${clock(s.shots[t.shot]!.b)})`).join(", "),
        );
      }
      if (last && ai.story) {
        const before = sources.flatMap((s) => s.shots.filter((x) => x.desc).map((x) => `${s.title} ${clock(x.a)}: ${x.desc}`));
        if (before.length) lines.push(`Already described elsewhere in the footage:\n${before.slice(0, 300).join("\n")}`);
      }
      const { system, user } = lookPrompt(lines, last && !!ai.story, ai.workspace);
      const { value } = await completeVisionWithFallback(system, user, images, signal, parseLooked, who, { label: LABEL, job: "editor" });
      for (const sh of batch)
        for (const t of sh.tiles) {
          const words = value.shots[String(t.n)];
          if (words) sources[sh.src]!.shots[t.shot]!.desc = words;
        }
      // a source whose last sheet this was is looked at: what the AI left without words stays so
      for (const si of new Set(batch.map((b) => b.src))) await keep(sources[si]!, !sheets.slice(c + SHEETS_PER_CALL).some((x) => x.src === si));
      if (value.story) story = value.story;
    }
    // every shot was described before: the story is one question in words alone
    if (ai.story && !story && !sheets.length) {
      const lines = sources.flatMap((s) => s.shots.filter((x) => x.desc).map((x) => `${s.title} ${clock(x.a)}–${clock(x.b)}: ${x.desc}`));
      if (lines.length) {
        const system = `You read shot-by-shot notes of footage for a video editor and tell what happens across it, from the pictures alone. ${RULE} Answer with JSON only.`;
        const user = `${lines.slice(0, 600).join("\n")}\n\nAnswer as {"story": "what happens across all of the footage, in order, in a few sentences"}`;
        story = (await completeWithFallback(system, user, signal, parseLooked, { ...route, retries: 0 })).story;
      }
    }
  } catch (e) {
    // the person's Mac is off or its AI gone: the step waits for it, as the script step does
    const away = macAway(e);
    if (away) throw new NeedsKey(away.message);
    throw e;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return { ...index, sources, ...(story ? { story } : {}) };
}

// ── the song ─────────────────────────────────────────────────────────────────────────────────────────────────────

const SR = 22050;
const N = 1024;
const HOP = 256;
/** envelope frames a second */
const ENV_RATE = SR / HOP;
/** The bins up to about 200 Hz (21.5 Hz each): where a kick drum's hit is. */
const LOW_BINS = Math.round(200 / (SR / N));
/** A beat or a hit is moved to the steepest rise in loudness within this far (s): the onset itself, to the millisecond */
const SNAP_S = 0.035;
/** loudness reads for that snap, each this long (s) */
const FINE_S = 0.002;
/** A hit is strong when it is this many times the median hit within STRONG_AROUND_S */
const STRONG_OVER = 1.5;
const STRONG_AROUND_S = 8;
/** Parts: loudness read in windows of SECTION_WIN_S, a change of SECTION_DB between the SECTION_SPAN_S before and after
 * makes a new part, no part shorter than SECTION_MIN_S */
const SECTION_WIN_S = 1;
const SECTION_SPAN_S = 4;
const SECTION_DB = 6;
const SECTION_MIN_S = 4;

/** `file` from `startS` as mono samples at SR. */
export async function decodeMono(file: string, startS: number, signal?: AbortSignal): Promise<Float32Array> {
  return ffmpegSlot(
    () =>
      new Promise((resolve, reject) => {
        // -ss after -i: the start is exact to the sample, not the nearest packet
        const p = spawn(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", file, "-ss", String(startS), "-vn", "-ac", "1", "-ar", String(SR), "-f", "f32le", "pipe:1"], {
          signal,
        });
        const parts: Buffer[] = [];
        let err = "";
        p.stdout.on("data", (d: Buffer) => parts.push(d));
        p.stderr.on("data", (d) => (err = (err + d.toString()).slice(-2000)));
        p.on("error", reject);
        p.on("close", (code) => {
          if (code !== 0) return reject(new Error(err.trim() || `ffmpeg exited ${code}`));
          const b = Buffer.concat(parts);
          const whole = b.length - (b.length % 4);
          resolve(new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + whole)));
        });
      }),
  );
}

/** In-place radix-2 FFT of (re, im), length a power of two. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len)
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b]! * wr - im[b]! * wi;
        const xi = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
      }
  }
}

/**
 * The onset envelope: how much louder each band got from one frame to the next, rises only. `env` on log magnitudes
 * (every onset counts, soft or hard: tempo and onsets); `hard` on plain magnitudes (how hard a hit is; a steady bass
 * under it adds nothing).
 */
export function onsetEnvelope(x: Float32Array): { env: Float32Array; hard: Float32Array; low: Float32Array } {
  const frames = Math.max(0, Math.floor((x.length - N) / HOP) + 1);
  const env = new Float32Array(frames);
  const hard = new Float32Array(frames);
  const low = new Float32Array(frames);
  const win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  let prev = new Float64Array(N / 2);
  let prevLin = new Float64Array(N / 2);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < N; i++) (re[i] = x[f * HOP + i]! * win[i]!), (im[i] = 0);
    fft(re, im);
    const mag = new Float64Array(N / 2);
    const lin = new Float64Array(N / 2);
    let flux = 0;
    let rise = 0;
    let kick = 0;
    for (let k = 1; k < N / 2; k++) {
      lin[k] = Math.hypot(re[k]!, im[k]!);
      mag[k] = Math.log1p(100 * lin[k]!);
      if (f) (flux += Math.max(0, mag[k]! - prev[k]!)), (rise += Math.max(0, lin[k]! - prevLin[k]!));
      if (f && k <= LOW_BINS) kick += Math.max(0, mag[k]! - prev[k]!); // log rise: a hit from quiet counts, a steady bass barely
    }
    env[f] = flux;
    hard[f] = rise;
    low[f] = kick;
    prev = mag;
    prevLin = lin;
  }
  return { env, hard, low };
}

/** The envelope frame `f`'s time (s): its window's middle. */
const frameTime = (f: number) => (f * HOP + N / 2) / SR;

/**
 * The time (s) of the steepest loudness rise within SNAP_S of `t`: where the hit starts. Read on the change from one
 * sample to the next, where a hit's attack is loud and a steady bass (whose 2 ms reads would swing with its own wave)
 * is nearly silent.
 */
function snap(x: Float32Array, t: number): number {
  const L = Math.round(FINE_S * SR);
  const from = Math.max(0, Math.round((t - SNAP_S) * SR));
  const to = Math.min(x.length - L, Math.round((t + SNAP_S) * SR));
  let best = -Infinity;
  let at = t;
  let before = from === 0 ? 0 : -1; // before the file's first sample is silence: a hit right at 0 is a rise
  for (let i = from; i <= to; i += L) {
    let s = 0;
    for (let j = Math.max(1, i); j < i + L; j++) s += (x[j]! - x[j - 1]!) ** 2;
    const rms = Math.sqrt(s / L);
    if (before >= 0 && rms - before > best) [best, at] = [rms - before, i / SR];
    before = rms;
  }
  return at;
}

/** How hard the hit at `t` (s) is: the plain rise around its frame. */
function hitStrength(hard: Float32Array, t: number): number {
  const f = Math.round((t * SR - N / 2) / HOP);
  let m = 0;
  for (let j = Math.max(0, f - 2); j <= Math.min(hard.length - 1, f + 2); j++) m = Math.max(m, hard[j]!);
  return m;
}

/** Peaks of the envelope over its local mean: the onsets, as frames. */
function peaksOf(env: Float32Array): number[] {
  const w = Math.round(0.05 * ENV_RATE);
  const span = Math.round(1.5 * ENV_RATE);
  const out: number[] = [];
  let sum = 0;
  let sq = 0;
  let c = 0;
  // ponytail: one mean and spread over the whole song; a moving one if quiet intros lose their onsets
  for (const v of env) (sum += v), (sq += v * v), c++;
  const mean = sum / Math.max(1, c);
  const sd = Math.sqrt(Math.max(0, sq / Math.max(1, c) - mean * mean));
  for (let i = 1; i < env.length - 1; i++) {
    const v = env[i]!;
    if (v < mean + 0.5 * sd) continue;
    let top = true;
    for (let j = Math.max(0, i - w); j <= Math.min(env.length - 1, i + w); j++) if (env[j]! > v || (env[j] === v && j < i)) top = false;
    if (!top) continue;
    let local = 0;
    let n = 0;
    for (let j = Math.max(0, i - span); j <= Math.min(env.length - 1, i + span); j++) (local += env[j]!), n++;
    if (v > (local / n) * 1.3) out.push(i);
  }
  return out;
}

/** The beat period in envelope frames, by autocorrelation weighted toward 120 bpm (so a half or double tempo loses). */
function periodOf(env: Float32Array): number {
  const mean = env.reduce((a, b) => a + b, 0) / Math.max(1, env.length);
  const e = Array.from(env, (v) => v - mean);
  let best = -Infinity;
  let at = Math.round((60 / 120) * ENV_RATE);
  const ac = (lag: number) => {
    let s = 0;
    for (let i = lag; i < e.length; i++) s += e[i]! * e[i - lag]!;
    return s / (e.length - lag);
  };
  for (let lag = Math.floor((60 / 200) * ENV_RATE); lag <= Math.ceil((60 / 60) * ENV_RATE); lag++) {
    const bpm = (60 * ENV_RATE) / lag;
    const weight = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    const v = ac(lag) * weight;
    if (v > best) [best, at] = [v, lag];
  }
  // between whole frames: the peak of a parabola through the three around it
  const [l, m, r] = [ac(at - 1), ac(at), ac(at + 1)];
  const d = l - 2 * m + r;
  return d < 0 ? at + (0.5 * (l - r)) / d : at;
}

/**
 * Where the beats, bars, hard hits and loud and quiet parts of a song are, from `startS` on; times in the song's own
 * seconds. The tempo is the autocorrelation of the onset envelope; beats are followed from the strongest phase, each
 * one moved to the onset nearest it, so a drifting tempo is followed too; the bpm is the slope through the beats.
 * Downbeats assume four beats to a bar, on the beat where the bar's hits are hardest.
 */
export async function songBeats(file: string, startS: number, signal: AbortSignal): Promise<SongBeats> {
  const x = await decodeMono(file, startS, signal);
  return beatsOf(x, file, startS);
}

/** songBeats on samples already decoded (SR, mono). */
export function beatsOf(x: Float32Array, source: string, startS: number): SongBeats {
  const { env, hard, low } = onsetEnvelope(x);
  const empty: SongBeats = { source, startS, bpm: 0, beats: [], downbeats: [], strong: [], sections: sectionsOf(x, startS) };
  if (env.length < 4 * ENV_RATE) return empty;
  const P = periodOf(env);
  // the phase whose grid lands on the most kick (bass onsets): hi-hats between the beats are more onsets than the kick,
  // so all onsets alike put the beats on the off-beat. The bass is trusted only when it pulses with the tempo (one
  // phase well ahead of the rest); a steady bass, or none, goes by every onset.
  const phaseScores = (e: Float32Array) =>
    Array.from({ length: Math.ceil(P) }, (_, p) => {
      let s = 0;
      for (let t = p; t < e.length; t += P) {
        let m = 0; // the grid point or a frame either side: a kick's rise can straddle two frames
        for (let j = Math.max(0, Math.round(t) - 1); j <= Math.min(e.length - 1, Math.round(t) + 1); j++) m = Math.max(m, e[j]!);
        s += m;
      }
      return s;
    });
  const top = (xs: number[]) => xs.reduce((b, v, i) => (v > xs[b]! ? i : b), 0);
  const kickAt = phaseScores(low);
  const kickMean = kickAt.reduce((a, b) => a + b, 0) / kickAt.length;
  const phase = kickMean > 0 && kickAt[top(kickAt)]! > 2 * kickMean ? top(kickAt) : top(phaseScores(env));
  // follow the grid: each beat at the envelope's peak within a tenth of a period of where it was expected
  const tol = Math.max(1, Math.round(P * 0.1));
  const frames: number[] = [];
  const near = (t: number) => {
    let at = Math.round(t);
    for (let j = Math.max(0, Math.round(t) - tol); j <= Math.min(env.length - 1, Math.round(t) + tol); j++) if (env[j]! > env[at]!) at = j;
    return at;
  };
  for (let t = phase; t < env.length; ) {
    const f = near(t);
    const strongEnough = env[f]! > 0;
    frames.push(strongEnough ? f : Math.round(t));
    t = (strongEnough ? f : t) + P;
  }
  const beatsT = frames.map((f) => snap(x, frameTime(f)));
  // the slope through the beats: the bpm, to a fraction
  const n = beatsT.length;
  const mi = (n - 1) / 2;
  const mt = beatsT.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  beatsT.forEach((t, i) => ((num += (i - mi) * (t - mt)), (den += (i - mi) ** 2)));
  const period = den ? num / den : P / ENV_RATE;
  const strength = beatsT.map((t) => hitStrength(hard, t));
  let bar = 0;
  let barBest = -Infinity;
  for (let k = 0; k < 4; k++) {
    let s = 0;
    for (let i = k; i < n; i += 4) s += strength[i]!;
    if (s > barBest) [barBest, bar] = [s, k];
  }
  const onsets = peaksOf(env).map((f) => snap(x, frameTime(f)));
  const hits = onsets.map((t) => hitStrength(hard, t));
  const strong = onsets.filter((t, i) => {
    const around = hits.filter((_, j) => Math.abs(onsets[j]! - t) <= STRONG_AROUND_S);
    return hits[i]! >= STRONG_OVER * median(around);
  });
  const r3 = (t: number) => Math.round((t + startS) * 1000) / 1000;
  return {
    source,
    startS,
    bpm: Math.round((60 / period) * 10) / 10,
    beats: beatsT.map(r3),
    downbeats: beatsT.filter((_, i) => i % 4 === bar).map(r3),
    strong: strong.map(r3),
    sections: sectionsOf(x, startS),
  };
}

/** Loud and quiet parts: a new part where the loudness before and after differs by SECTION_DB; energy 0..1 of the loudest. */
export function sectionsOf(x: Float32Array, startS: number): SongBeats["sections"] {
  const W = Math.round(SECTION_WIN_S * SR);
  const db: number[] = [];
  for (let i = 0; i + W / 2 <= x.length; i += W) {
    let s = 0;
    const end = Math.min(x.length, i + W);
    for (let j = i; j < end; j++) s += x[j]! * x[j]!;
    db.push(10 * Math.log10(s / (end - i) + 1e-10));
  }
  const dur = x.length / SR;
  if (!db.length) return [];
  const span = Math.round(SECTION_SPAN_S / SECTION_WIN_S);
  const avg = (a: number, b: number) => {
    const xs = db.slice(Math.max(0, a), Math.min(db.length, b));
    return xs.reduce((p, q) => p + q, 0) / Math.max(1, xs.length);
  };
  const change = db.map((_, i) => (i < 1 ? 0 : Math.abs(avg(i, i + span) - avg(i - span, i))));
  const cuts: number[] = [];
  for (let i = 1; i < db.length; i++) {
    if (change[i]! < SECTION_DB) continue;
    if (change[i - 1]! > change[i]! || (change[i + 1] ?? 0) > change[i]!) continue;
    if (i * SECTION_WIN_S < SECTION_MIN_S || dur - i * SECTION_WIN_S < SECTION_MIN_S) continue;
    if (cuts.length && (i - cuts[cuts.length - 1]!) * SECTION_WIN_S < SECTION_MIN_S) continue;
    cuts.push(i);
  }
  const edges = [0, ...cuts, db.length];
  const rms = edges.slice(1).map((b, k) => {
    const a = edges[k]!;
    let s = 0;
    for (let i = a; i < b; i++) s += 10 ** (db[i]! / 10);
    return Math.sqrt(s / Math.max(1, b - a));
  });
  const top = Math.max(...rms, 1e-9);
  const r3 = (t: number) => Math.round((t + startS) * 1000) / 1000;
  return rms.map((e, k) => ({ a: r3(edges[k]! * SECTION_WIN_S), b: r3(k === rms.length - 1 ? dur : edges[k + 1]! * SECTION_WIN_S), energy: Math.round((e / top) * 100) / 100 }));
}
