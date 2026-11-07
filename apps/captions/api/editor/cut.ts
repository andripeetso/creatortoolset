import type { TimedWord } from "../library/transcribe";
import { ENERGY_PER_SECOND } from "./analyze";

/**
 * The AI Editor's cut: one take of a script line → the source frames to use. Trims the take to the line's words (a
 * previous take's tail and junk after it go), cuts restarts ("so this is | so this is for"), then tightens pauses by
 * loudness. Pure: words, loudness and numbers in, segments out.
 */

/**
 * Starting values, in seconds so they mean the same at every frame rate (at 25 fps: threshold 0.15 of the file's
 * loud level, 7 frames of silence, 2 kept after speech and 1 before). Re-measure on real footage before changing.
 */
export const CUT = {
  /** speech is loudness at or above this share of the file's 90th percentile */
  threshold: 0.15,
  /** a silence this long inside a take is cut */
  minSilenceS: 0.28,
  /** silence kept after speech, and before it resumes */
  keepTailS: 0.08,
  keepHeadS: 0.04,
  /** the take opens this much before its first speech and closes this much after its last */
  lineHeadS: 0.08,
  lineTailS: 0.12,
  /** an edge piece shorter than this is a breath or a click */
  minPieceS: 0.24,
  /** an inner piece shorter than this stays joined to the one before (no flash of a shot) */
  minShotS: 0.48,
  /** a one- or two-word repeat counts as a restart only across a pause this long (or a cut-off word): "very very" stays */
  restartPauseS: 0.1,
  /** the longest phrase a restart repeats, in words */
  restartWords: 8,
};
export type CutSettings = typeof CUT;

/** Words as lower-case tokens without punctuation. */
export const tokens = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/-/g, " ")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

const tokenOf = (w: TimedWord) => tokens(w.w).join(" ");

/**
 * [i0, i1) of the words that say `text`: the longest common subsequence of their tokens, without matches far from the
 * main run (another take's words). When fewer than half the line's words are found (the text is a paraphrase), the whole
 * take stays.
 */
export function trim(words: TimedWord[], text: string): [number, number] {
  const a = words.map(tokenOf);
  const b = tokens(text);
  if (!a.length || !b.length) return [0, words.length];
  // LCS table, from the end so the walk goes forward
  const L = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) L[i]![j] = a[i] === b[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  // skip a word whenever a later one matches as well: a restart keeps its last reading, a previous take's tail never anchors the line
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (L[i + 1]![j] === L[i]![j]) i++;
    else if (a[i] === b[j]) pairs.push([i++, j++]);
    else j++;
  }
  if (pairs.length * 2 < b.length) return [0, words.length];
  // the main run: the longest stretch of pairs consecutive on both sides
  let best = [0, 1];
  for (let s = 0, k = 1; k <= pairs.length; k++) {
    const consecutive = k < pairs.length && pairs[k]![0] === pairs[k - 1]![0] + 1 && pairs[k]![1] === pairs[k - 1]![1] + 1;
    if (!consecutive) {
      if (k - s > best[1]! - best[0]!) best = [s, k];
      s = k;
    }
  }
  const [mi, mj] = pairs[best[0]!]!;
  const keep = pairs.filter(([i, j]) => Math.abs(i - mi) - Math.abs(j - mj) <= 3);
  return [keep[0]![0], keep[keep.length - 1]![0] + 1];
}

/** `a` is `b` or a cut-off start of it ("you" of "your"). */
const prefix = (a: string, b: string) => a === b || (a.length >= 2 && b.startsWith(a));

/**
 * Word spans [i, j) the speaker abandoned and said again: words i.. repeat from j (the last abandoned word may be cut
 * off). Left to right, chained restarts merged ("all it | all it takes is | all it takes is").
 */
export function restarts(words: TimedWord[], c: CutSettings = CUT): [number, number][] {
  const t = words.map(tokenOf);
  const spans: [number, number][] = [];
  for (let i = 0; i < words.length; ) {
    let found = 0;
    for (let j = i + 1; j <= Math.min(words.length - 1, i + c.restartWords); j++) {
      const n = j - i;
      if (j + n > words.length || !t[i] || t[i] !== t[j]) continue;
      let same = true;
      for (let k = 0; k < n - 1 && same; k++) same = t[i + k] === t[j + k];
      if (!same || !prefix(t[j - 1]!, t[j + n - 1]!)) continue;
      const pause = words[j]!.s - words[j - 1]!.e;
      const cutOff = t[j - 1] !== t[j + n - 1];
      if (n >= 3 || cutOff || pause >= c.restartPauseS) found = j; // keep going: the longest restart wins
    }
    if (!found) {
      i++;
      continue;
    }
    const last = spans[spans.length - 1];
    if (last && last[1] === i) last[1] = found;
    else spans.push([i, found]);
    i = found;
  }
  return spans;
}

/** Loudness per source frame, divided by the file's 90th percentile so the threshold means the same on every recording. */
export function frameEnergy(energy: Float32Array, fps: number): Float32Array {
  const n = Math.floor((energy.length / ENERGY_PER_SECOND) * fps);
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    const a = Math.floor((f / fps) * ENERGY_PER_SECOND);
    const b = Math.max(a + 1, Math.floor(((f + 1) / fps) * ENERGY_PER_SECOND));
    let sum = 0;
    for (let i = a; i < b; i++) sum += energy[i] ?? 0;
    out[f] = sum / (b - a);
  }
  const p90 = Float32Array.from(out).sort()[Math.floor(n * 0.9)] ?? 0;
  if (p90 > 0) for (let f = 0; f < n; f++) out[f]! /= p90;
  return out;
}

/** The quietest frame in [lo, hi], the later on a tie. */
function quietest(e: Float32Array, lo: number, hi: number): number {
  lo = Math.max(lo, 0);
  hi = Math.min(hi, e.length - 1);
  let at = lo;
  for (let f = lo; f <= hi; f++) if (e[f]! <= e[at]!) at = f;
  return at;
}

/** Speech pieces of frames [a, b): silences of minSilence or more cut, keeping a little each side; never outside [a, b). */
export function speechPieces(e: Float32Array, a: number, b: number, fps: number, c: CutSettings = CUT): [number, number][] {
  const fr = (s: number) => Math.max(1, Math.round(s * fps));
  const loud = (f: number) => (e[f] ?? 0) >= c.threshold;
  let first = -1;
  let last = -1;
  for (let f = a; f < b; f++) if (loud(f)) (first < 0 && (first = f), (last = f));
  if (first < 0) return [];
  const pieces: [number, number][] = [[Math.max(first - fr(c.lineHeadS), a), 0]];
  let quiet = 0;
  for (let f = first; f <= last; f++) {
    if (!loud(f)) {
      quiet++;
      continue;
    }
    if (quiet >= fr(c.minSilenceS)) {
      pieces[pieces.length - 1]![1] = f - quiet + fr(c.keepTailS);
      pieces.push([f - fr(c.keepHeadS), 0]);
    }
    quiet = 0;
  }
  pieces[pieces.length - 1]![1] = Math.min(last + 1 + fr(c.lineTailS), b);
  const len = (p: [number, number]) => p[1] - p[0];
  while (pieces.length && len(pieces[0]!) < fr(c.minPieceS)) pieces.shift();
  while (pieces.length && len(pieces[pieces.length - 1]!) < fr(c.minPieceS)) pieces.pop();
  const out: [number, number][] = [];
  for (const p of pieces) {
    const prev = out[out.length - 1];
    if (prev && len(p) < fr(c.minShotS)) prev[1] = p[1];
    else out.push([...p]);
  }
  if (out.length > 1 && len(out[0]!) < fr(c.minShotS)) out[1]![0] = out.shift()![0];
  return out;
}

/** Ranges with [a, b) taken out. */
function without(ranges: [number, number][], a: number, b: number): [number, number][] {
  return ranges.flatMap(([s, e]): [number, number][] => {
    if (e <= a || s >= b) return [[s, e]];
    return [...(s < a ? [[s, a] as [number, number]] : []), ...(e > b ? [[b, e] as [number, number]] : [])];
  });
}

export interface CutResult {
  /** source frames [in, out), in order */
  segments: [number, number][];
  /** what went, for the draft's notes */
  removed: string[];
}

/**
 * One take → source frames. `words` are the take's words with one neighbour each side when the file has one (so the
 * cut before and after finds the real gap); `energy` is the source's loudness at ENERGY_PER_SECOND; `fps` its frame rate.
 */
export function cutTake(words: TimedWord[], from: number, to: number, text: string, energy: Float32Array, fps: number, c: CutSettings = CUT): CutResult {
  const take = words.slice(from, to);
  const [t0, t1] = trim(take, text);
  if (t1 <= t0) return { segments: [], removed: [] };
  const i0 = from + t0;
  const i1 = from + t1;
  const e = frameEnergy(energy, fps);
  const f = (s: number) => Math.round(s * fps);
  const pad = Math.round(fps / 3);
  // the cut between two words: the quietest frame between them (±2 frames, word timings are loose)
  const between = (i: number): number => {
    const prev = words[i - 1];
    const next = words[i];
    if (!prev) return Math.max(f(next!.s) - pad, 0);
    if (!next) return f(prev.e) + pad;
    const [lo, hi] = [f(prev.e), f(next.s)].sort((x, y) => x - y);
    return e.length ? quietest(e, lo! - 2, hi! + 2) : Math.round((lo! + hi!) / 2);
  };
  const head = between(i0);
  const tail = between(i1);
  const removed: string[] = [];
  const said = (a: number, b: number) => words.slice(a, b).map((w) => w.w).join(" ");
  if (i0 > from) removed.push(`before the line: ${said(from, i0)}`);
  if (i1 < to) removed.push(`after the line: ${said(i1, to)}`);
  let ranges: [number, number][] = [[head, tail]];
  for (const [i, j] of restarts(words.slice(i0, i1), c)) {
    removed.push(`false start: ${said(i0 + i, i0 + j)}`);
    ranges = without(ranges, i === 0 ? head : between(i0 + i), between(i0 + j));
  }
  // no loudness read (a file with no sound frames): keep the word ranges as they are
  const segments = e.length ? ranges.flatMap(([a, b]) => speechPieces(e, a, b, fps, c)) : ranges;
  return { segments, removed };
}
