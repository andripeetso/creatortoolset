import type { Edit, LineTakes, TakeCut } from "@contracts/editor";
import { find, fixTrans, isVideo, withKeys, type NleItem, type NleTimeline } from "@/lib/nle/model";

// The take picker's reading of a draft (the draft page's side panel in chat mode): which line a clip is, which take it
// plays, which versions use each take, and a take laid in its place as a ripple. A draft has a marker named for each
// line at the line's first frame (api/editor/timeline.ts), its pictures on V1 and each one's sound linked to it.

type Hit = { key: string; track: string; item: NleItem };

/** The clip the picker is about: the first picked one, a sound standing for the picture it is linked to; none picked: none. */
export function clipFor(tl: NleTimeline, picked: string[]): Hit | null {
  const c = picked.length ? find(tl, picked[0]!) : null;
  if (!c) return null;
  if (isVideo(c.track) || c.item.link === undefined) return { key: picked[0]!, ...c };
  const pic = (tl.tracks.V1?.items ?? []).find((i) => i.link === c.item.link);
  return pic?._k ? { key: pic._k, track: "V1", item: pic } : { key: picked[0]!, ...c };
}

/** The line markers in frame order (a marker that names no line of the edit is a person's own). */
const lineMarks = (tl: NleTimeline, lines: string[]) =>
  (tl.markers ?? []).filter((m) => lines.includes(String(m.name))).sort((a, b) => a.frame - b.frame);

/** The line a V1 clip plays: the last line marker at or before its start. */
export function lineOf(tl: NleTimeline, item: NleItem, lines: string[]): string | null {
  const m = lineMarks(tl, lines).filter((x) => x.frame <= item.rec).at(-1);
  return m ? String(m.name) : null;
}

/** A line's frames on the timeline: from its marker to the next line's (or the end of V1). */
export function lineSpan(tl: NleTimeline, line: string, lines: string[]): [number, number] | null {
  const marks = lineMarks(tl, lines);
  const i = marks.findIndex((m) => m.name === line);
  if (i < 0) return null;
  const end = Math.max(0, ...(tl.tracks.V1?.items ?? []).map((x) => x.rec + x.len));
  return [marks[i]!.frame, marks[i + 1]?.frame ?? end];
}

export interface TakeRow {
  take: TakeCut;
  /** 1-based, best first as the script ranked them */
  n: number;
  /** the other versions whose script uses it (their letters, or titles with one version) */
  used: string[];
  /** the open timeline plays it on this clip */
  here: boolean;
}

/** The letter a version goes by among several ("A", "B"), as its cut's name says (api/editor/ended.ts cutName). */
export const letterOf = (e: Pick<Edit, "plans">, name: string) => {
  const i = e.plans.findIndex((p) => p.name === name);
  return e.plans.length > 1 && i >= 0 ? String.fromCharCode(65 + i) : "";
};

/** The takes of a line, side by side: `here` the one the clip plays most of (same recording, overlapping frames). */
export function takeRows(e: Pick<Edit, "plans">, open: string, tl: NleTimeline, clip: NleItem, lt: LineTakes): TakeRow[] {
  const fps = tl.timeline.fps;
  const sfps = Number(tl.sources[clip.src]?.fps) || fps;
  const a = clip.in;
  const b = clip.in + Math.round((clip.len * sfps) / fps);
  const overlap = (t: TakeCut) => (t.src !== clip.src ? 0 : t.cut.reduce((n, [x, y]) => n + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0));
  const best = lt.takes.reduce((k, t, i) => (overlap(t) > 0 && (k < 0 || overlap(t) > overlap(lt.takes[k]!)) ? i : k), -1);
  return lt.takes.map((take, i) => ({
    take,
    n: i + 1,
    here: i === best,
    used: e.plans
      .filter((p) => p.name !== open && p.lines.some((l) => l.line === lt.line && l.take.first === take.first && l.take.last === take.last))
      .map((p) => letterOf(e, p.name) || p.title),
  }));
}

// a new clip carries its template's look and level, never what belongs to the old cut (its transition, fades, keys,
// speed, a reframed window's path), nor a sound's processing: no voice effect goes on a take until the person asks
const bare = ({ keys: _k, trans: _t, fade_in: _fi, fade_out: _fo, speed: _s, ramp: _r, path: _p, freeze: _f, _k: _h, link: _l, processing: _x, norm_db: _n, ...rest }: NleItem) => rest;
// on another recording its framing goes too
const reframed = ({ zoom: _z, pan: _p, tilt: _t, crop: _c, focus: _f, frame: _fr, split: _s, ...rest }: Partial<NleItem>) => rest;
const isPic = isVideo;

/**
 * Line `line` played from take `to` (the person's hand edit, a ripple replace): the line's pictures on V1 and the sounds
 * linked to them go, and the take's parts come in from the line's first frame, a picture and a linked sound each, on the
 * take's own recording as it was filmed (its sound as recorded, never a processed voice). The rest moves as a ripple does,
 * by the difference in length d: what starts at or after the line's end and the markers there; a clip under the whole
 * line (a music bed) grows or shrinks with it, never past its file's end; one starting inside it and
 * running over its end (B-roll, a whoosh) moves by d; a shorter take's last frames take what sits in them along.
 */
export function swapTake(tl: NleTimeline, line: string, lines: string[], to: TakeCut, source: LineTakes["sources"][string] | undefined): NleTimeline {
  const fps = tl.timeline.fps;
  const span = lineSpan(tl, line, lines);
  if (!span) throw new Error("That line isn't on this timeline");
  const inLine = (i: NleItem) => i.rec >= span[0] && i.rec < span[1];
  const links = new Set((tl.tracks.V1?.items ?? []).filter((i) => inLine(i) && i.link !== undefined).map((i) => i.link));
  const mine = (t: string, i: NleItem) => (t === "V1" ? inLine(i) : !isPic(t) && i.link !== undefined && links.has(i.link));
  const old = Object.entries(tl.tracks).flatMap(([t, tr]) => tr.items.filter((i) => mine(t, i)).map((i) => ({ t, i }))).sort((x, y) => x.i.rec - y.i.rec);
  const pics = old.filter((o) => isPic(o.t));
  const voices = old.filter((o) => !isPic(o.t));
  const pic = pics[0];
  if (!pic) throw new Error("That line isn't on this timeline");
  if (old.some((o) => tl.tracks[o.t]!.locked)) throw new Error("The line is on a locked track: unlock it to change its take");
  // every picture with its sound: an unlinked one would leave the old take's voice under the new take
  if (pics.some((o) => o.i.link === undefined || !voices.some((v) => v.i.link === o.i.link))) throw new Error(`${line}'s voice isn't linked to its picture`);
  const voice = voices.find((o) => o.i.link === pic.i.link)!;
  const ends = (xs: typeof old) => [Math.min(...xs.map((o) => o.i.rec)), Math.max(...xs.map((o) => o.i.rec + o.i.len))];
  const [a, b] = ends(pics) as [number, number];
  const [va, vb] = ends(voices);
  // shortcut: a J or L cut (voice and picture not flush) is refused, not rippled per track; build it when someone asks
  if (va !== a || vb !== b) throw new Error(`${line}'s voice and picture don't start together: trim them flush, then try again`);

  const sources = { ...tl.sources };
  if (!sources[to.src]) {
    if (!source) throw new Error("This take's recording isn't in the edit's footage");
    sources[to.src] = { ...source };
  }
  const sfps = Number(sources[to.src]!.fps) || fps;
  const parts = to.cut.map(([x, y]) => ({ x, len: Math.round(((y - x) * fps) / sfps) })).filter((p) => p.len > 0);
  if (!parts.length) throw new Error(`Take ${to.first}: nothing of it is left once cut`);
  const d = parts.reduce((n, p) => n + p.len, 0) - (b - a);

  const look = pic.i.src === to.src ? bare(pic.i) : reframed(bare(pic.i));
  const tag = Math.random().toString(36).slice(2, 8);
  const newPics: NleItem[] = [];
  const newVoices: NleItem[] = [];
  let rec = a;
  parts.forEach((p, k) => {
    const link = `${line}.${tag}.${k}`;
    newPics.push({ ...look, src: to.src, rec, len: p.len, in: p.x, link });
    newVoices.push({ ...bare(voice.i), src: to.src, rec, len: p.len, in: p.x, link });
    rec += p.len;
  });
  // the line's transition and fades stay on its new ends
  const keepEnds = (xs: typeof old, made: NleItem[]) => {
    const first = xs[0]!.i;
    const last = xs[xs.length - 1]!.i;
    if (first.trans) made[0]!.trans = first.trans;
    if (first.fade_in) made[0]!.fade_in = first.fade_in;
    if (last.fade_out) made[made.length - 1]!.fade_out = last.fade_out;
  };
  keepEnds(pics, newPics);
  keepEnds(voices, newVoices);
  const made: Record<string, NleItem[]> = { [pic.t]: newPics, [voice.t]: newVoices };
  const c = b + Math.min(d, 0); // the new line's end
  // as long as its file lets it be, in timeline frames (no limit for a file of unknown length)
  const room = (i: NleItem) => {
    const s = tl.sources[i.src];
    return typeof s?.dur === "number" ? Math.floor((s.dur - i.in) / (((i.speed ?? 1) * (Number(s.fps) || fps)) / fps)) : Infinity;
  };
  const tracks = Object.fromEntries(Object.entries(tl.tracks).map(([t, tr]) => {
    if (tr.locked) return [t, tr];
    const items = tr.items.filter((i) => !mine(t, i)).map((i) => {
      const e = i.rec + i.len;
      if (i.rec >= b) return { ...i, rec: i.rec + d };
      if (e <= a) return i;
      // under the whole line (a bed from the first frame too): it grows or shrinks with it
      if (i.rec <= a && e >= b) return { ...i, len: Math.max(1, Math.min(i.len + d, Math.max(i.len, room(i)))) };
      if (i.rec < a) return d < 0 && e > c ? { ...i, len: Math.max(1, c - i.rec) } : i;
      // starts inside the line: over its end, or (shorter) in the frames taken off, it moves with what comes after
      if (e > b || (d < 0 && i.rec >= c)) return { ...i, rec: Math.max(a, i.rec + d) };
      return d < 0 && e > c ? { ...i, len: Math.max(1, c - i.rec) } : i;
    });
    return [t, { ...tr, items: [...items, ...(made[t] ?? [])].sort((x, y) => x.rec - y.rec) }];
  }));
  const markers = tl.markers?.map((m) => (m.frame >= c ? { ...m, frame: Math.max(c, m.frame + d) } : m));
  return fixTrans(withKeys({ ...tl, sources, tracks, ...(markers ? { markers } : {}) }));
}
