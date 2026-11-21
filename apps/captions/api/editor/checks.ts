import type { Critique } from "../../contracts/edit-plan";
import type { Timeline } from "../../contracts/editor";

/**
 * Checks on a rendered cut and on the words it plays, the pure half (critique.ts reads the render for them). They never
 * hold a cut back: what they find is named on its Review version, with the shot it is in. From the retired engine's QA,
 * with its measured constants: a frame at a cut that belongs to neither shot (a flash), a video that ends on black, a
 * word said twice across a cut, and a word a cut runs through.
 */

/** One problem: the timeline frame it is at, and what it is in the person's words. */
export interface Found {
  rec: number;
  why: string;
}

/** The tiny picture flash frames are looked for in (27×48 RGB, the retired engine's). */
export const TW = 27;
export const TH = 48;
/** A cut that changes the picture less than this (mean, 0..1) changes nothing: a card resolving into the shot after it. */
const CUT_MIN = 0.06;
/** A frame next to a cut that differs from its own side by more than this share of the cut is a flash. */
const FLASH_SHARE = 0.6;
/** Black end: the last 1.2 s are looked at, black is a frame under 8 % light. */
export const TAIL_S = 1.2;

/** Whether a black finder's report on the last TAIL_S of a video `duration` long says it ends on black. */
export const blackAtEnd = (report: string, duration: number): boolean => {
  const tail = Math.min(TAIL_S, duration);
  return [...report.matchAll(/black_end:([\d.]+)/g)].some((m) => Number(m[1]) >= tail - 0.08);
};
/** A word a cut runs through: more than this much of it (seconds) on the side the cut takes away. */
const CLIP_S = 0.06;
const FILLERS = new Set(["uh", "um", "uhm", "mm", "mhm", "hmm", "ah", "er", "erm"]);

/** The frames where the picture cuts: every edge of a shot on V1 or V2, but not the first or last two frames. */
export function cutsOf(tl: Timeline): number[] {
  const items = [...tl.tracks.V1.items, ...tl.tracks.V2.items];
  const end = Math.max(0, ...items.map((i) => i.rec + i.len));
  return [...new Set(items.flatMap((i) => [i.rec, i.rec + i.len]))].filter((c) => c > 2 && c < end - 2).sort((a, b) => a - b);
}

const diff = (x: Uint8Array, y: Uint8Array) => {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += Math.abs(x[i]! - y[i]!);
  return s / x.length / 255;
};

/** Frames next to cut `c` that belong to neither shot: c − 1 should match the frame before it, c the one after it. */
export function oddAt(frames: Uint8Array[], c: number): number[] {
  if (c < 2 || c + 1 >= frames.length) return [];
  const cut = diff(frames[c - 1]!, frames[c]!);
  if (cut < CUT_MIN) return [];
  return [
    [c - 1, diff(frames[c - 2]!, frames[c - 1]!)],
    [c, diff(frames[c]!, frames[c + 1]!)],
  ].flatMap(([f, same]) => (same! > FLASH_SHARE * cut ? [f!] : []));
}

const token = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

/**
 * The words the voice track plays that slip at a cut, from each take's own transcript (no hearing again): the same word
 * either side of a cut ("time | time"), and a word a cut runs through, so only part of it plays.
 */
export function wordSlips(tl: Timeline, words: Record<string, { w: string; s: number; e: number }[]>): Found[] {
  const found: Found[] = [];
  let before: string | undefined;
  const pieces = [...tl.tracks.A1.items].sort((a, b) => a.rec - b.rec);
  pieces.forEach((p, k) => {
    const src = tl.sources[p.src];
    if (!src) return;
    const a = p.in / src.fps;
    const b = a + p.len / tl.fps;
    const at = (s: number) => p.rec + Math.round((s - a) * tl.fps);
    const prev = pieces[k - 1];
    // the piece goes on from where the one before it stopped in the same take: no cut in the voice there
    const joined = !!prev && prev.src === p.src && Math.abs(prev.in / src.fps + prev.len / tl.fps - a) < 1 / tl.fps;
    const mine = (words[p.src] ?? []).filter((w) => (w.s + w.e) / 2 >= a && (w.s + w.e) / 2 < b && !FILLERS.has(token(w.w)) && token(w.w));
    const first = mine[0];
    if (first && !joined && before === token(first.w)) found.push({ rec: p.rec, why: `said twice across a cut: “${first.w} | ${first.w}”` });
    if (!joined) {
      const head = (words[p.src] ?? []).find((w) => w.s < a - CLIP_S && w.e > a + CLIP_S);
      if (head) found.push({ rec: p.rec, why: `a cut runs through “${head.w}”` });
    }
    const next = pieces[k + 1];
    const goesOn = !!next && next.src === p.src && Math.abs(next.in / src.fps - b) < 1 / tl.fps;
    if (!goesOn) {
      const tail = (words[p.src] ?? []).find((w) => w.s < b - CLIP_S && w.e > b + CLIP_S);
      if (tail) found.push({ rec: at(b) - 1, why: `a cut runs through “${tail.w}”` });
    }
    const last = mine.at(-1);
    before = last && token(last.w);
  });
  return found;
}

/**
 * What the checks found, as failing shots of the cut: each in the shot it lands in (`shots`, seconds, in order), its
 * reasons joined with the look's own for that shot. The look's verdict passes only when nothing is named.
 */
export function withFound(c: Critique, found: Found[], shots: { at: number; dur: number }[], fps: number): Critique {
  const fails = c.fails.map((f) => ({ ...f }));
  for (const x of found) {
    const t = x.rec / fps;
    const k = Math.max(0, shots.findIndex((s, i) => t < s.at + s.dur || i === shots.length - 1));
    const s = shots[k];
    const named = fails.find((f) => f.n === k + 1);
    if (named) {
      if (!named.why.includes(x.why)) named.why = `${named.why}; ${x.why}`.slice(0, 200);
    } else fails.push({ n: k + 1, why: x.why, ...(s ? { at: s.at, dur: s.dur } : {}) });
  }
  return { ...c, ok: !fails.length, fails: fails.sort((a, b) => a.n - b.n) };
}
