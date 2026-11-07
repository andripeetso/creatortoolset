import { TRACKS, type Item, type Timeline, type TrackId } from "../../contracts/editor";

/**
 * Edits on a timeline, each a pure function returning a new one: what a revision and, later, a page timeline apply.
 * An item is named by its track and a frame it covers; linked items (a speaker shot and its voice) go along.
 */

const copy = (tl: Timeline): Timeline => structuredClone(tl);
const end = (i: Item) => i.rec + i.len;

/** The item on `track` covering frame `at`, or throws. */
function find(tl: Timeline, track: TrackId, at: number): Item {
  const it = tl.tracks[track].items.find((i) => i.rec <= at && at < end(i));
  if (!it) throw new Error(`Nothing on ${track} at frame ${at}`);
  return it;
}

/** The item and every item linked to it, across tracks. */
function group(tl: Timeline, item: Item): Item[] {
  if (!item.link) return [item];
  return TRACKS.flatMap((t) => tl.tracks[t].items.filter((i) => i === item || (i.link === item.link && i.rec === item.rec)));
}

/** Splits the item at `at` (and its linked items) into two at that frame. */
export function split(tl: Timeline, track: TrackId, at: number): Timeline {
  const out = copy(tl);
  const g = group(out, find(out, track, at));
  const link = g[0]!.link && `${g[0]!.link}@${at}`;
  for (const it of g) {
    if (at <= it.rec || at >= end(it)) continue;
    const d = at - it.rec;
    const sfps = out.sources[it.src]?.fps ?? out.fps;
    const right: Item = { ...it, rec: at, len: it.len - d, in: it.in + Math.round((d * sfps) / out.fps), ...(link ? { link } : {}) };
    it.len = d;
    const items = out.tracks[TRACKS.find((t) => out.tracks[t].items.includes(it))!].items;
    items.splice(items.indexOf(it) + 1, 0, right);
  }
  return out;
}

/**
 * Takes out frames [from, to) of every track and closes the gap. An item partly inside keeps the part outside;
 * markers inside move to `from`.
 */
export function rippleOut(tl: Timeline, from: number, to: number): Timeline {
  const out = copy(tl);
  const n = to - from;
  for (const t of TRACKS) {
    out.tracks[t].items = out.tracks[t].items.flatMap((i): Item[] => {
      if (end(i) <= from) return [i];
      if (i.rec >= to) return [{ ...i, rec: i.rec - n }];
      // ponytail: an item across the range keeps its head only (B-roll over a removed shot ends early); split first to keep both sides
      if (i.rec < from) return [{ ...i, len: from - i.rec }];
      if (end(i) > to) {
        const d = to - i.rec;
        const sfps = out.sources[i.src]?.fps ?? out.fps;
        return [{ ...i, rec: from, len: end(i) - to, in: i.in + Math.round((d * sfps) / out.fps) }];
      }
      return [];
    });
  }
  out.markers = out.markers.map((m) => ({ ...m, rec: m.rec >= to ? m.rec - n : Math.min(m.rec, from) }));
  return out;
}

/** Removes the item at `at` with its linked items; `ripple` closes the gap on every track. */
export function remove(tl: Timeline, track: TrackId, at: number, ripple = true): Timeline {
  const it = find(tl, track, at);
  if (ripple) return rippleOut(tl, it.rec, end(it));
  const out = copy(tl);
  const g = new Set(group(out, find(out, track, at)));
  for (const t of TRACKS) out.tracks[t].items = out.tracks[t].items.filter((i) => !g.has(i));
  return out;
}

/** Moves the item at `at` (with its linked items) to start at `rec`; refuses to overlap another item. */
export function move(tl: Timeline, track: TrackId, at: number, rec: number): Timeline {
  const out = copy(tl);
  const g = group(out, find(out, track, at));
  const d = rec - g[0]!.rec;
  for (const t of TRACKS) {
    const mine = out.tracks[t].items.filter((i) => g.includes(i));
    for (const it of mine) {
      if (out.tracks[t].items.some((o) => !g.includes(o) && o.rec < end(it) + d && it.rec + d < end(o))) throw new Error(`${t}: frame ${rec} is taken`);
    }
  }
  for (const it of g) it.rec += d;
  for (const t of TRACKS) out.tracks[t].items.sort((a, b) => a.rec - b.rec);
  return out;
}

/** Trims the item at `at` (and linked items): `head` frames off its start, `tail` off its end (negative: longer). Ripples. */
export function trim(tl: Timeline, track: TrackId, at: number, head: number, tail: number): Timeline {
  const fromRec = find(tl, track, at).rec;
  const out = copy(tl);
  const g = group(out, find(out, track, at));
  for (const i of g) {
    const sfps = out.sources[i.src]?.fps ?? out.fps;
    i.in = Math.max(0, i.in + Math.round((head * sfps) / out.fps));
    i.len -= head + tail;
    if (i.len <= 0) throw new Error("Trimmed to nothing");
  }
  // the rest of every track follows the change in length
  const delta = head + tail;
  if (delta) {
    for (const t of TRACKS) for (const o of out.tracks[t].items) if (o.rec > fromRec && !g.includes(o)) o.rec -= delta;
    out.markers = out.markers.map((m) => (m.rec > fromRec ? { ...m, rec: m.rec - delta } : m));
  }
  return out;
}

/** Slips the item at `at` (and linked items) by `frames` of its source: same place, other picture and sound. */
export function slip(tl: Timeline, track: TrackId, at: number, frames: number): Timeline {
  const out = copy(tl);
  for (const i of group(out, find(out, track, at))) i.in = Math.max(0, i.in + frames);
  return out;
}

/** Sets the zoom and tilt of the picture at `at` (undefined clears them). */
export function setFraming(tl: Timeline, track: TrackId, at: number, f: { zoom?: number; tilt?: number }): Timeline {
  const out = copy(tl);
  const it = find(out, track, at);
  delete it.zoom;
  delete it.tilt;
  Object.assign(it, f.zoom && f.zoom !== 1 ? { zoom: f.zoom } : {}, f.tilt ? { tilt: f.tilt } : {});
  return out;
}
