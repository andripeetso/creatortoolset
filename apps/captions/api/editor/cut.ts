import type { TimedWord } from "../library/transcribe";
import { ENERGY_PER_SECOND } from "./analyze";

/**
 * The AI Editor's cut: one take of a script line → the source frames to use. Trims the take to the line's words (a
 * previous take's tail and junk after it go), cuts restarts ("so this is | so this is for", and the ones the line's
 * text shows), then tightens pauses by loudness. Pure: words, loudness and numbers in, segments out.
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

/** What a stray word between two matched ones costs: a matched word is worth reaching across one stray word, not two. */
const SKIP = 0.5;

/**
 * The words that say `text`, as pairs [word, text token] in order: the most matched words, less SKIP for every stray
 * word between two of them (a word the text has no token for; a word that stands where the text has another one is
 * a misheard word and costs nothing), the later ones on a tie. So the line is its last reading, whole: a previous
 * take's tail and a false start fall outside it (also when one of the two readings has a word misheard), and a phrase
 * said twice inside the line does not end it. Empty when fewer than half the line's words are found (a paraphrase).
 */
function said(words: TimedWord[], text: string): [number, number][] {
  const a = words.map(tokenOf);
  const b = tokens(text);
  // open[i][j]: the best run of pairs within words < i and tokens < j, ready for another pair; at[i][j]: the best one that ends in the pair (i, j)
  const open = Array.from({ length: a.length + 1 }, () => new Float32Array(b.length + 1).fill(-Infinity));
  const at = Array.from({ length: a.length }, () => new Float32Array(b.length).fill(-Infinity));
  let end: [number, number] | undefined;
  for (let i = 0; i <= a.length; i++)
    for (let j = 0; j <= b.length; j++) {
      if (i && j) open[i]![j] = Math.max(open[i - 1]![j]! - SKIP, open[i]![j - 1]!, open[i - 1]![j - 1]!, at[i - 1]![j - 1]!);
      if (i === a.length || j === b.length || a[i] !== b[j]) continue;
      at[i]![j] = 1 + Math.max(0, open[i]![j]!);
      if (!end || at[i]![j]! >= at[end[0]]![end[1]]!) end = [i, j];
    }
  const pairs: [number, number][] = [];
  for (let [i, j] = end ?? [-1, 0]; i >= 0; ) {
    pairs.unshift([i, j]);
    if (open[i]![j]! <= 0) break;
    // back to the pair before: the word right before when it matches (the later reading), else past a token, a misheard word, a stray word
    while (at[i - 1]![j - 1] !== open[i]![j]) {
      if (open[i]![j - 1] === open[i]![j]) j--;
      else {
        if (open[i - 1]![j - 1] === open[i]![j]) j--;
        i--;
      }
    }
    i--;
    j--;
  }
  return pairs.length * 2 < b.length ? [] : pairs;
}

/** [i0, i1) of the words that say `text` (said): its last reading, without another take's words around it. A paraphrase keeps the whole take. */
export function trim(words: TimedWord[], text: string): [number, number] {
  const pairs = said(words, text);
  return pairs.length ? [pairs[0]![0], pairs[pairs.length - 1]![0] + 1] : [0, words.length];
}

/**
 * Restarts only the line's text shows, because the two readings differ (the stumble itself, or a word misheard):
 * between two words the text has side by side, the take says words the text does not have, and they begin with the
 * word the line carries on with. The same sizes as restarts(): three words or more, or fewer across a pause.
 */
function strays(words: TimedWord[], pairs: [number, number][], c: CutSettings): [number, number][] {
  const out: [number, number][] = [];
  for (let p = 1; p < pairs.length; p++) {
    const [i0, j0] = pairs[p - 1]!;
    const [i1, j1] = pairs[p]!;
    const again = j1 === j0 + 1 && i1 > i0 + 1 && tokenOf(words[i0 + 1]!) === tokenOf(words[i1]!);
    if (again && (i1 - i0 > 3 || words[i1]!.s - words[i1 - 1]!.e >= c.restartPauseS)) out.push([i0 + 1, i1]);
  }
  return out;
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

/** The middle of the first `need` quiet frames in [lo, hi], read forward (step 1) or back (-1); undefined when it has no such pause. */
function pause(e: Float32Array, lo: number, hi: number, step: 1 | -1, need: number, threshold: number): number | undefined {
  lo = Math.max(lo, 0);
  hi = Math.min(hi, e.length - 1);
  for (let f = step > 0 ? lo : hi, run = 0; f >= lo && f <= hi; f += step) {
    run = e[f]! < threshold ? run + 1 : 0;
    if (run === need) return f - step * (need >> 1);
  }
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
  const pairs = said(take, text);
  const [t0, t1] = pairs.length ? [pairs[0]![0], pairs[pairs.length - 1]![0] + 1] : [0, take.length];
  if (t1 <= t0) return { segments: [], removed: [] };
  const i0 = from + t0;
  const i1 = from + t1;
  const e = frameEnergy(energy, fps);
  const f = (s: number) => Math.round(s * fps);
  const pad = Math.round(fps / 3);
  // the cut between two words, in the pause next to the words that stay (the first one after them, the last one before
  // them), so speech between two takes that nobody wrote down stays out; with no pause there, the quietest frame
  // between the two words (±2 frames, word timings are loose)
  const between = (i: number, stay: "before" | "after"): number => {
    const prev = words[i - 1];
    const next = words[i];
    if (!prev) return Math.max(f(next!.s) - pad, 0);
    if (!next) return f(prev.e) + pad;
    const [lo, hi] = [f(prev.e), f(next.s)].sort((x, y) => x - y);
    if (!e.length) return Math.round((lo! + hi!) / 2);
    return pause(e, lo! - 2, hi! + 2, stay === "before" ? 1 : -1, Math.max(1, Math.round(c.minSilenceS * fps)), c.threshold) ?? quietest(e, lo! - 2, hi! + 2);
  };
  const head = between(i0, "after");
  const tail = between(i1, "before");
  const removed: string[] = [];
  const quote = (a: number, b: number) => words.slice(a, b).map((w) => w.w).join(" ");
  if (i0 > from) removed.push(`before the line: ${quote(from, i0)}`);
  if (i1 < to) removed.push(`after the line: ${quote(i1, to)}`);
  let ranges: [number, number][] = [[head, tail]];
  const gone = restarts(words.slice(i0, i1), c);
  for (const [i, j] of strays(take, pairs, c)) if (!gone.some(([x, y]) => i - t0 < y && j - t0 > x)) gone.push([i - t0, j - t0]);
  for (const [i, j] of gone) {
    removed.push(`false start: ${quote(i0 + i, i0 + j)}`);
    ranges = without(ranges, i === 0 ? head : between(i0 + i, "before"), between(i0 + j, "after"));
  }
  // no loudness read (a file with no sound frames): keep the word ranges as they are
  const segments = e.length ? ranges.flatMap(([a, b]) => speechPieces(e, a, b, fps, c)) : ranges;
  return { segments, removed };
}
