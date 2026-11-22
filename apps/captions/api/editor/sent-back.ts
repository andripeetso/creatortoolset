import { TRACKS, type Item, type Timeline, type TrackId } from "../../contracts/editor";
import type { TimelineView } from "../../contracts/timeline-import";
import { pathIn } from "./framing";

/**
 * The next round from a timeline sent back: a draft exported to an editing app (OTIO, FCPXML, FCP 7 XML, EDL), changed
 * there, and read back through Review's parser (contracts/timeline-import.ts). What the editing app says is the truth:
 * every cut, clip, in point and track as the file has it. What the file can't say (a shot's framing, a reframed shot's
 * window, a clip's gain) comes from the draft's own item that clip was cut from, the one of the same file and track whose
 * frames it shares most. A clip whose file isn't one of the draft's is refused by name: the next round re-edits this
 * draft's footage, new footage comes in through the editor's bin.
 *
 * What each format carries is what the export writes (otio.ts, fcpxml.ts): OTIO every track; FCP 7 XML the speaker (V1)
 * and their voice (A1); FCPXML and an EDL the speaker's shots, each with its own sound. A track the format never
 * carried keeps the draft's clips where they were.
 */

export type SentBackFormat = "otio" | "fcpxml" | "xml" | "edl";
/** The file's format, sniffed as the parser does. */
export const formatOf = (text: string): SentBackFormat => {
  const head = text.slice(0, 4000);
  return /^\s*\{/.test(head) ? "otio" : /<fcpxml[\s>]/.test(head) ? "fcpxml" : /<xmeml[\s>]/.test(head) ? "xml" : "edl";
};

export class SentBackRefused extends Error {}

const end = (i: { rec: number; len: number }) => i.rec + i.len;
const stem = (p: string) => decodeURIComponent(p.split(/[/\\]/).pop() ?? p).replace(/\.[^.]+$/, "").toLowerCase();

/**
 * Each of the file's sources (`paths`: its key → the path it names) as the draft's source key. A path the export wrote
 * (`files`, as the export route gives them) matches first, then the same file name, then the library's name for it.
 */
function sourceKeys(draft: Timeline, files: Record<string, string>, paths: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const unknown: string[] = [];
  for (const [k, p] of Object.entries(paths)) {
    const ks = Object.keys(draft.sources);
    const hit = ks.find((d) => files[d] === p) ?? ks.find((d) => files[d] && stem(files[d]!) === stem(p)) ?? ks.find((d) => draft.sources[d]!.name.toLowerCase() === stem(p));
    if (hit) out[k] = hit;
    else unknown.push(decodeURIComponent(p.split(/[/\\]/).pop() ?? p));
  }
  if (unknown.length) throw new SentBackRefused(`Not footage of this draft: ${[...new Set(unknown)].slice(0, 5).join(", ")}. Add new clips in the editor's bin, then send the timeline back again`);
  return out;
}

/** Timeline frames as the source's frames. */
const srcFrames = (draft: Timeline, frames: number, src: string) => Math.round((frames * (draft.sources[src]?.fps || draft.fps)) / draft.fps);

/** The draft's item on `track` an imported clip was cut from: same source, the most source frames shared (else the nearest: more of the same take). */
function origin(draft: Timeline, track: TrackId, it: Item): Item | undefined {
  let best: Item | undefined;
  let most = -Infinity;
  const last = (i: Item) => i.in + srcFrames(draft, i.len, i.src);
  for (const o of draft.tracks[track].items) {
    if (o.src !== it.src) continue;
    const shared = Math.min(last(o), last(it)) - Math.max(o.in, it.in);
    if (shared > most) [best, most] = [o, shared];
  }
  return best;
}

/**
 * The fields the file can't carry, from the clip's origin: a reframed shot's window re-cut to where the clip now starts,
 * a fade only where the clip still starts or ends where its origin did.
 */
function carried(draft: Timeline, track: TrackId, it: Item): Item {
  const o = origin(draft, track, it);
  if (!o) return it;
  const { src: _s, in: _i, len: _l, rec: _r, link: _k, path, fade_in, fade_out, ...rest } = o;
  const sfps = draft.sources[it.src]?.fps || draft.fps;
  const moved = path?.length ? pathIn(path, (it.in - o.in) / sfps, it.len / draft.fps) : [];
  const ends = (i: Item) => i.in + srcFrames(draft, i.len, i.src);
  return { ...rest, ...it, ...(moved.length ? { path: moved } : {}), ...(fade_in && it.in === o.in ? { fade_in } : {}), ...(fade_out && ends(it) === ends(o) ? { fade_out } : {}) };
}

/**
 * The speaker (V1) and their voice (A1) linked as the renders play them (preview.ts: a shot plays the voice linked to it,
 * from the same frame): each shot cut where a voice starts or ends under it, each piece linked to the voice under it.
 * A voice under no shot stays on A1 unlinked (the files carry it; the preview has no picture to play it with), except a
 * take with no picture (a voice recording): the writers leave its shot out, so it gets its shot back, linked.
 */
function linked(draft: Timeline, v1: Item[], a1: Item[]): { V1: Item[]; A1: Item[] } {
  // a piece of an item: its window re-cut, a fade only on the piece at that end
  const cutAt = (i: Item, a: number, b: number): Item => {
    const { path, fade_in, fade_out, ...rest } = i;
    const sub = path?.length ? pathIn(path, (a - i.rec) / draft.fps, (b - a) / draft.fps) : [];
    return { ...rest, in: i.in + srcFrames(draft, a - i.rec, i.src), rec: a, len: b - a, ...(sub.length ? { path: sub } : {}), ...(fade_in && a === i.rec ? { fade_in } : {}), ...(fade_out && b === end(i) ? { fade_out } : {}) };
  };
  const V1: Item[] = [];
  const A1: Item[] = [];
  let n = 0;
  // the draft's intro (intro.ts): the piece of its video that still opens the cut stays the intro
  const intro = draft.tracks.V1.items.find((i) => i.link === "intro" && i.rec === 0)?.src;
  for (const v of v1) {
    const edges = [...new Set([v.rec, end(v), ...a1.flatMap((a) => [a.rec, end(a)]).filter((f) => f > v.rec && f < end(v))])].sort((x, y) => x - y);
    for (let k = 1; k < edges.length; k++) {
      const [a, b] = [edges[k - 1]!, edges[k]!];
      const voice = a1.find((x) => x.rec <= a && end(x) >= b);
      const { link: _l, ...pic } = cutAt(v, a, b);
      if (!voice) V1.push(pic);
      else {
        const link = a === 0 && v.src === intro ? "intro" : `c${++n}`;
        V1.push({ ...pic, link });
        A1.push({ ...cutAt(voice, a, b), link });
      }
    }
  }
  // the voice's frames under no shot
  const bare = (x: Item, a: number, b: number) => {
    const { link: _l, ...piece } = cutAt(x, a, b);
    if (draft.sources[x.src]?.w) return void A1.push(piece);
    const link = `c${++n}`;
    const { fade_in: _fi, fade_out: _fo, gainDb: _g, ...shot } = piece;
    V1.push(carried(draft, "V1", { ...shot, link }));
    A1.push({ ...piece, link });
  };
  for (const x of a1) {
    let at = x.rec;
    for (const v of v1.filter((v) => end(v) > x.rec && v.rec < end(x)).sort((p, q) => p.rec - q.rec)) {
      if (v.rec > at) bare(x, at, v.rec);
      at = Math.max(at, end(v));
    }
    if (at < end(x)) bare(x, at, end(x));
  }
  V1.sort((p, q) => p.rec - q.rec);
  for (const i of A1) if (!i.link) delete i.link;
  return { V1, A1: A1.sort((p, q) => p.rec - q.rec) };
}

/**
 * The draft as the timeline sent back has it. `view`/`paths`: importTimeline and timelineSources of the file; `files`:
 * the draft's sources as the export wrote their paths. Throws SentBackRefused with the line the person reads.
 */
export function fromSentBack(draft: Timeline, files: Record<string, string>, view: TimelineView, paths: Record<string, string>, format: SentBackFormat): Timeline {
  // shortcut: a planned edit's speeds, ramps and effects aren't read from the files, so its next round stays in the app; read LinearTimeWarp / timeMap when one is asked for
  if (draft.plan) throw new SentBackRefused("A planned edit's speeds and effects can't be read back from a timeline file yet: make the changes in the app's editor");
  if (Math.abs(view.fps - draft.fps) > 0.01) throw new SentBackRefused(`The timeline sent back runs at ${view.fps} fps and the draft at ${draft.fps}: export it at the draft's frame rate`);
  // the tracks the format carries (otio.ts, fcpxml.ts), each found by the name the export gave it (the parser numbers only
  // the lanes with clips, so an empty Music track would make Sound "A2"), else by its place
  const reads: readonly string[] = format === "otio" ? TRACKS : format === "xml" ? ["V1", "A1"] : ["V1"];
  const shown = view.tracks.filter((t) => t.id !== "V0" && t.items.some((i) => !i.off));
  const named = shown.map((t) => TRACKS.find((k) => k[0] === t.id[0] && !!t.name && draft.tracks[k].name === t.name) ?? t.id);
  const ids = new Set(named).size === named.length ? named : shown.map((t) => t.id);
  const lanes = shown.map((t, k) => ({ ...t, id: ids[k]! })).filter((t) => format === "otio" || reads.includes(t.id));
  const extra = lanes.filter((t) => !reads.includes(t.id)).map((t) => t.id);
  if (extra.length) throw new SentBackRefused(`This editor has picture tracks V1 and V2 and sound tracks A1 to A3: move the clips on ${extra.join(", ")} onto those`);
  // only the files on the tracks read: a clip on a track the format never carried is not this round's
  const usedKeys = new Set(lanes.flatMap((t) => t.items.flatMap((i) => (i.src && !i.off ? [i.src] : []))));
  const keys = sourceKeys(draft, files, Object.fromEntries(Object.entries(paths).filter(([k]) => usedKeys.has(k))));
  const read = (id: TrackId): Item[] =>
    (lanes.find((t) => t.id === id)?.items ?? []).flatMap((i) => {
      if (i.off) return [];
      if (!i.src || i.ins === undefined) throw new SentBackRefused(`${i.label} on ${id} has no file the draft knows`);
      const src = keys[i.src]!;
      const s = draft.sources[src]!;
      const sfps = s.fps || draft.fps;
      // an EDL's source in is the file's own timecode: from the file's first frame, as the other formats give it
      const secs = format === "edl" ? i.ins - s.tc / sfps : i.ins;
      const it: Item = { src, in: Math.max(0, Math.round(secs * sfps)), len: i.len, rec: i.rec };
      return [carried(draft, id, it)];
    });
  const tracks = Object.fromEntries(TRACKS.map((t) => [t, { ...draft.tracks[t], items: [] as Item[] }])) as Timeline["tracks"];
  const shots = read("V1");
  // a shot's own sound is the voice where the draft had that take's voice (a picture-only take brings none)
  const voiced = format === "fcpxml" || format === "edl"
    ? shots.filter((v) => draft.tracks.A1.items.some((a) => a.src === v.src)).map(({ src, in: i, len, rec }) => carried(draft, "A1", { src, in: i, len, rec }))
    : read("A1");
  const { V1, A1 } = linked(draft, shots, voiced);
  if (!V1.length && !A1.length) throw new SentBackRefused("Nothing of the draft is left on the timeline sent back");
  tracks.V1.items = V1;
  tracks.A1.items = A1;
  const all = format === "otio";
  tracks.V2.items = all ? read("V2") : draft.tracks.V2.items;
  // an app that splits a stereo voice into one track per channel (A1 left, A2 right) sent its copy too: it is the same clip
  const same = (a: Item, b: Item) => a.src === b.src && a.in === b.in && a.rec === b.rec && a.len === b.len;
  for (const t of ["A2", "A3"] as const) tracks[t].items = all ? read(t).filter((i) => !voiced.some((v) => same(v, i))) : draft.tracks[t].items;
  const used = new Set(TRACKS.flatMap((t) => tracks[t].items.map((i) => i.src)));
  const notes = new Map(draft.markers.map((m) => [m.name, m.note]));
  return {
    ...draft,
    sources: Object.fromEntries(Object.entries(draft.sources).filter(([k]) => used.has(k))),
    tracks,
    // an EDL has no markers: the draft's stay
    markers: format === "edl" ? draft.markers : view.markers.map((m) => ({ rec: m.frame, name: m.name, color: (m.color ?? "Blue").toUpperCase(), note: notes.get(m.name) ?? "" })),
    // who speaks when was measured on the old cut's frames
    speakers: undefined,
  };
}

/** What changed, in a few words for the draft's notes: clips and length before and after. */
export function sentBackSummary(before: Timeline, after: Timeline): string {
  const clips = (t: Timeline) => TRACKS.reduce((n, k) => n + (k === "A1" ? 0 : t.tracks[k].items.length), 0);
  const secs = (t: Timeline) => Math.max(0, ...TRACKS.flatMap((k) => t.tracks[k].items.map(end))) / t.fps;
  return `${clips(before)} → ${clips(after)} clips, ${secs(before).toFixed(1)} → ${secs(after).toFixed(1)} s`;
}
