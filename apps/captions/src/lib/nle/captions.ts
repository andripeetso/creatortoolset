import type { EdjCaptions } from "@contracts/editor";
import type { Cue, PosSegment, TextOverlay, Word } from "../types";
import type { NleTimeline } from "./model";

// A timeline's captions are a Caption Studio clip made from its render (EDJ `captions`). They belong to the cut whose A1
// clips are in `captions.from`: a cut whose A1 differs has captions from an older cut (derived here, never a stored flag),
// and Update Captions moves the old captions through the edit by SOURCE frames, so his word fixes and look stay and only
// material that was never in the old cut is heard again. Pure: used by the editor and by the server (api/editor/captions.ts).

export type From = EdjCaptions["from"][number];

/** The A1 clips that play, as `captions.from` keeps them: [rec, len, src, in], in timeline order. */
export const fromOf = (tl: Pick<NleTimeline, "tracks">): From[] =>
  [...(tl.tracks.A1?.items ?? [])]
    .filter((i) => i.enabled !== false)
    .sort((a, b) => a.rec - b.rec)
    .map((i) => [i.rec, i.len, i.src, i.in]);

/** The captions were made from another cut than this one (its A1 changed since). */
export const captionsStale = (tl: Pick<NleTimeline, "tracks" | "captions">): boolean =>
  !!tl.captions && JSON.stringify(tl.captions.from) !== JSON.stringify(fromOf(tl));

/** Old timeline frames [a, b) that are in the new cut, moved by `delta` frames. */
interface Piece { a: number; b: number; delta: number }

type Range = [number, number];
const minus = ([a, b]: Range, cuts: Range[]): Range[] =>
  cuts.reduce<Range[]>((left, [c, d]) => left.flatMap(([x, y]) => (d <= x || c >= y ? [[x, y]] : [...(c > x ? [[x, c] as Range] : []), ...(d < y ? [[d, y] as Range] : [])])), [[a, b]]).filter(([x, y]) => y > x);

/**
 * Where the old cut's material is in the new one. For each new A1 clip and each old one of the same source, the overlap
 * of their source ranges is old material (each source frame taken once per new clip, the earlier old clip first), moved
 * by Δ = (new.rec − old.rec) + (old.in − new.in)/k frames (k: the source's frames per timeline frame). What no old clip
 * covers is new material: `fill`, in the new cut's frames.
 */
export function moves(from: From[], to: From[], rate: (src: string) => number = () => 1): { pieces: Piece[]; fill: Range[] } {
  const pieces: Piece[] = [];
  const fill: Range[] = [];
  const old = [...from].sort((x, y) => x[0] - y[0]);
  for (const [rec, len, src, inn] of [...to].sort((x, y) => x[0] - y[0])) {
    const k = rate(src) || 1;
    const covered: Range[] = [];
    for (const [orec, olen, osrc, oin] of old) {
      if (osrc !== src) continue;
      const lo = Math.max(inn, oin);
      const hi = Math.min(inn + len * k, oin + olen * k);
      if (hi <= lo) continue;
      for (const [s0, s1] of minus([lo, hi], covered)) pieces.push({ a: orec + (s0 - oin) / k, b: orec + (s1 - oin) / k, delta: rec - orec + (oin - inn) / k });
      covered.push([lo, hi]);
    }
    for (const [s0, s1] of minus([inn, inn + len * k], covered)) fill.push([rec + (s0 - inn) / k, rec + (s1 - inn) / k]);
  }
  // a cut that moved nothing (a blade) leaves two pieces that join again, so a line across it stays one line
  pieces.sort((x, y) => x.a + x.delta - (y.a + y.delta));
  const joined = pieces.reduce<Piece[]>((all, p) => {
    const last = all.at(-1);
    if (last && last.delta === p.delta && Math.abs(last.b - p.a) < 1e-6) last.b = p.b;
    else all.push({ ...p });
    return all;
  }, []);
  return { pieces: joined, fill: fill.reduce<Range[]>((all, r) => (all.length && Math.abs(all.at(-1)![1] - r[0]) < 1e-6 ? (all.at(-1)![1] = r[1], all) : [...all, r]), []) };
}

/** A Caption Studio clip's saved data (GET /api/projects/:id, one clip): the parts that are timed, and the rest. */
export interface CaptionData {
  words?: Word[];
  originalWords?: Word[];
  cues?: Cue[];
  posSegments?: PosSegment[];
  texts?: TextOverlay[];
  [k: string]: unknown;
}

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

/**
 * Update Captions: a clip's captions moved from the cut `from` to the cut `to` (fps: the timeline's). A word is kept
 * where its middle is in old material, shifted with it and kept inside it; else it was cut out. A line stays one line
 * while its words move together; where a cut moved or removed something inside it, it splits there (the parts take
 * their words' times and wrap to width again); a line with no word left is gone. Texts on screen and box positions move
 * with their start. His words, their order and the look are kept. `fill`: the new material's seconds, to be heard.
 */
export function remapCaptions(data: CaptionData, from: From[], to: From[], fps: number, rate?: (src: string) => number): { data: CaptionData; fill: Range[] } {
  const { pieces, fill } = moves(from, to, rate);
  const sec = (f: number) => f / fps;
  const has = (p: Piece, t: number) => t * fps >= p.a - 1e-6 && t * fps < p.b - 1e-6;
  const shift = (t: number, p: Piece) => r4(Math.min(sec(p.b + p.delta), Math.max(sec(p.a + p.delta), t + sec(p.delta))));
  const mid = (w: { start: number; end: number }) => (w.start + w.end) / 2;
  // each word once per piece it is in (material used twice: its words twice), numbered again in the new order
  const mapWords = (list: Word[] = []) => {
    const ids = new Map<string, number>();
    const out = pieces.flatMap((p, pi) => list.filter((w) => has(p, mid(w))).map((w) => ({ w, pi, start: shift(w.start, p), end: shift(w.end, p) })))
      .sort((x, y) => x.start - y.start)
      .map(({ w, pi, start, end }, i) => {
        ids.set(`${pi}:${w.id}`, i + 1);
        return { ...w, id: i + 1, start, end };
      });
    return { out, ids };
  };
  const words = mapWords(data.words);
  const cues = (data.cues ?? []).flatMap((c) =>
    pieces.map((p, pi) => ({ p, pi, ws: c.words.filter((w) => has(p, mid(w))) })).filter((g) => g.ws.length).map(({ p, pi, ws }) => {
      const moved = ws.map((w) => ({ ...w, id: words.ids.get(`${pi}:${w.id}`) ?? w.id, start: shift(w.start, p), end: shift(w.end, p) }));
      const { lines, ...rest } = c;
      return ws.length === c.words.length
        ? { ...rest, ...(lines ? { lines } : {}), start: shift(c.start, p), end: shift(c.end, p), words: moved }
        : { ...rest, start: moved[0]!.start, end: moved.at(-1)!.end, words: moved };
    }),
  ).sort((x, y) => x.start - y.start).map((c, i) => ({ ...c, id: i + 1 }));
  const byStart = <T extends { start: number; end: number; id: number }>(xs: T[] = []) =>
    xs.flatMap((x) => {
      const p = pieces.find((q) => has(q, x.start));
      return p ? [{ ...x, start: shift(x.start, p), end: r4(x.end + sec(p.delta)) }] : [];
    }).sort((x, y) => x.start - y.start).map((x, i) => ({ ...x, id: i + 1 }));
  // the waveform is of the old cut's sound: Caption Studio draws it again from the new one
  const { peaks: _peaks, ...rest } = data;
  return {
    data: {
      ...rest,
      words: words.out,
      ...(data.originalWords ? { originalWords: mapWords(data.originalWords).out } : {}),
      cues,
      ...(data.posSegments ? { posSegments: byStart(data.posSegments) } : {}),
      ...(data.texts ? { texts: byStart(data.texts) } : {}),
    },
    fill: fill.map(([a, b]) => [r4(sec(a)), r4(sec(b))]),
  };
}

/** Seconds inside one of `ranges`. */
export const inRanges = (t: number, ranges: Range[]) => ranges.some(([a, b]) => t >= a && t < b);
