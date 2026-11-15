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
const INDEX_V = 1;
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
  return per.map((m, k) => ({
    a: r2(all[k]! / read.fps),
    b: k === per.length - 1 ? dur : r2(all[k + 1]! / read.fps),
    motion: r2(Math.min(1, m / most)),
  }));
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
      const shots = picture ? shotsOf(await readPicture(await readable(id, row.source_key), probe.fps, signal), probe.duration) : [];
      src = { id, title: row.title, dur: probe.duration, fps: probe.fps, w: turned ? probe.height : probe.width, h: turned ? probe.width : probe.height, shots };
      await keep(src);
    }
    sources.push({ ...src, title: row.title, speech });
  }
  return { sources };
}

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
