// A timeline as a non-linear editor holds it (components/nle): tracks V1…Vn and A1…An of clips in frames, the sources
// they play, and the edits a person makes on them. Each edit is a pure function that returns a new timeline (the editor
// keeps whole snapshots for undo), so the rules are tested on their own. Fields this file does not know (what an AI
// wrote on a clip, a track or the timeline) ride along untouched.
//
// A clip: `rec` its first frame on the timeline, `len` its length in timeline frames, `in` its first frame in its
// source (the source's own frames), `speed` (1 = as filmed). The picture fields are in the units a timeline file for
// Resolve takes: `zoom` (1 = the source covering the frame), `pan` px right, `tilt` px up, `rot` degrees
// counter-clockwise, `flip` "h" / "v" / "hv", `crop` [left, top, right, bottom] fractions of the source, `opacity` 0–1;
// sound: `gain_db`. A track may be `hidden` (picture), `mute` (sound) or `locked` (no edit touches it).
//
// Semantics: a move overwrites what it lands on; insert pushes everything after it on every unlocked track; a trim
// stops at its neighbour and at the ends of its source; a ripple trim or ripple delete moves everything after it on
// every unlocked track by one amount (as far as every track can go, so they stay in sync); clips that share a `link`
// move and trim together.

export type Flip = "h" | "v" | "hv";

export interface NleSource {
  path?: string;
  /** frames a second of the source (the timeline's when absent) */
  fps?: number;
  /** length in the source's frames (no limit when absent: a still, or a file whose length is unknown) */
  dur?: number;
  w?: number;
  h?: number;
  [k: string]: unknown;
}

export interface NleItem {
  src: string;
  rec: number;
  len: number;
  in: number;
  link?: string | number;
  zoom?: number;
  pan?: number;
  tilt?: number;
  rot?: number;
  flip?: Flip;
  crop?: [number, number, number, number];
  opacity?: number;
  speed?: number;
  gain_db?: number;
  enabled?: boolean;
  /** timeline frames of fade at the start / end: a picture from / to black (an opacity ramp), a sound from / to silence */
  fade_in?: number;
  fade_out?: number;
  /** this editor's own handle on the clip while it is open (stripped on save) */
  _k?: string;
  [k: string]: unknown;
}

export interface NleTrack {
  name?: string;
  items: NleItem[];
  mute?: boolean;
  hidden?: boolean;
  locked?: boolean;
  enabled?: boolean;
  [k: string]: unknown;
}

export interface NleTimeline {
  timeline: { fps: number; width?: number; height?: number; duration?: number; name?: string; [k: string]: unknown };
  tracks: Record<string, NleTrack>;
  sources: Record<string, NleSource>;
  [k: string]: unknown;
}

export type Edge = "head" | "tail";
export type PlaceMode = "overwrite" | "insert";

let seq = 0;
const newKey = () => `c${++seq}`;
const clone = <T>(v: T): T => structuredClone(v);
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export const isVideo = (track: string) => track[0] === "V";
export const trackNo = (track: string) => Number(track.slice(1)) || 0;
/** V3 V2 V1 above A1 A2 A3, as an editor shows them. */
export const trackOrder = (tl: NleTimeline) =>
  Object.keys(tl.tracks).sort((a, b) => (isVideo(a) === isVideo(b) ? (isVideo(a) ? trackNo(b) - trackNo(a) : trackNo(a) - trackNo(b)) : isVideo(a) ? -1 : 1));

/** The timeline with a handle on every clip (what the editor opens). */
export function withKeys(tl: NleTimeline): NleTimeline {
  const out = clone(tl);
  out.sources ??= {};
  for (const t of Object.values(out.tracks)) for (const it of t.items) it._k ??= newKey();
  return out;
}

/** The timeline as it is saved: no handles, each track's clips in order, its length set. */
export function toSaved(tl: NleTimeline): NleTimeline {
  const out = clone(tl);
  for (const t of Object.values(out.tracks)) {
    for (const it of t.items) {
      delete it._k;
      // a clip trimmed shorter than its fades keeps fades that fit it
      for (const f of ["fade_in", "fade_out"] as const) if (it[f] === undefined) delete it[f];
      if (it.fade_in) it.fade_in = Math.min(it.fade_in, it.len);
      if (it.fade_out) it.fade_out = Math.min(it.fade_out, it.len - (it.fade_in ?? 0)) || undefined;
      if (it.fade_out === undefined) delete it.fade_out;
    }
    t.items.sort((a, b) => a.rec - b.rec);
  }
  out.timeline.duration = lengthOf(out);
  return out;
}

export const endOf = (it: NleItem) => it.rec + it.len;
/** A track that plays: on, and not hidden (a picture) or muted (a sound). */
const live = (t: NleTrack) => t.enabled !== false && !t.hidden && !t.mute;

/** The timeline's length: where the last clip that is on ends, on any track that plays (0 when empty). */
export const lengthOf = (tl: NleTimeline): number =>
  Math.max(0, ...Object.values(tl.tracks).filter(live).flatMap((t) => t.items.filter((i) => i.enabled !== false).map(endOf)));

/** m:ss:ff, h:mm:ss:ff from an hour. */
export const timecode = (f: number, fps: number): string => {
  const s = Math.floor(f / fps);
  const m = Math.floor(s / 60);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${m >= 60 ? `${Math.floor(m / 60)}:${p2(m % 60)}` : m}:${p2(s % 60)}:${p2(Math.round(f % fps))}`;
};

export function find(tl: NleTimeline, key: string): { track: string; item: NleItem } | null {
  for (const [track, t] of Object.entries(tl.tracks)) {
    const item = t.items.find((i) => i._k === key);
    if (item) return { track, item };
  }
  return null;
}

/** Source frames one timeline frame of the clip uses. */
export const rateOf = (tl: NleTimeline, it: NleItem) => ((tl.sources[it.src]?.fps || tl.timeline.fps) / tl.timeline.fps) * (it.speed || 1);

/** Timeline frames the clip can still be pulled out by at each end before its source runs out. */
export function roomOf(tl: NleTimeline, it: NleItem): { before: number; after: number } {
  const r = rateOf(tl, it);
  const dur = tl.sources[it.src]?.dur;
  return {
    before: Math.floor(it.in / r + 1e-6),
    after: typeof dur === "number" ? Math.max(0, Math.floor((dur - it.in) / r + 1e-6) - it.len) : Infinity,
  };
}

/** The keys with every clip linked to one of them. */
export function withLinked(tl: NleTimeline, keys: string[]): string[] {
  keys = keys.filter((k) => find(tl, k));
  const links = new Set(keys.map((k) => find(tl, k)!.item.link).filter((l) => l !== undefined));
  const out = new Set(keys);
  if (links.size) for (const t of Object.values(tl.tracks)) for (const i of t.items) if (i.link !== undefined && links.has(i.link)) out.add(i._k!);
  return [...out];
}

const trackOf = (tl: NleTimeline, key: string) => find(tl, key)?.track;
const lockedAny = (tl: NleTimeline, keys: string[]) => keys.some((k) => tl.tracks[trackOf(tl, k) ?? ""]?.locked);

/** A clip cut in two at timeline frame `f` (inside it): the left part keeps its handle. */
function cutAt(tl: NleTimeline, it: NleItem, f: number): [NleItem, NleItem] {
  const d = f - it.rec;
  const right = { ...clone(it), _k: newKey(), rec: f, len: it.len - d, in: r3(it.in + d * rateOf(tl, it)), fade_in: undefined };
  // the fade in stays on the left part, the fade out on the right one
  return [{ ...it, len: d, fade_out: undefined }, right];
}

/** What lies on `track` between frames a and b is taken out (overwrite): clips cut back, split or removed. */
function clear(tl: NleTimeline, track: string, a: number, b: number, keep: Set<string>) {
  const t = tl.tracks[track];
  const out: NleItem[] = [];
  for (const it of t.items) {
    if (keep.has(it._k!) || endOf(it) <= a || it.rec >= b) {
      out.push(it);
      continue;
    }
    if (it.rec < a) out.push(cutAt(tl, it, a)[0]);
    if (endOf(it) > b) out.push(it.rec < b ? cutAt(tl, it, b)[1] : it);
  }
  t.items = out;
}

const sortAll = (tl: NleTimeline) => {
  for (const t of Object.values(tl.tracks)) t.items.sort((a, b) => a.rec - b.rec);
  return tl;
};

/**
 * Everything on the unlocked tracks that starts at or after `at` moves by `d` (all the same amount). Going back, it
 * stops where any track has something in the way, so no clip runs into another and every track stays in sync.
 * Returns the amount it moved.
 */
function ripple(tl: NleTimeline, at: number, d: number, skip: Set<string>): number {
  const tracks = Object.values(tl.tracks).filter((t) => !t.locked);
  if (d < 0) {
    for (const t of tracks) {
      const before = t.items.filter((i) => !skip.has(i._k!) && i.rec < at).map(endOf);
      const later = t.items.some((i) => !skip.has(i._k!) && i.rec >= at);
      if (later) d = Math.max(d, Math.max(0, ...before) - at);
      d = Math.max(d, -Math.min(at, ...t.items.filter((i) => !skip.has(i._k!) && i.rec >= at).map((i) => i.rec)));
    }
  }
  if (d) for (const t of tracks) for (const i of t.items) if (!skip.has(i._k!) && i.rec >= at) i.rec += d;
  return d;
}

/**
 * Clips moved by `d` frames (and their linked clips), the ones on `from` onto `to` (a track of the same kind). They
 * overwrite what they land on. Never before frame 0; nothing moves when one of them is on a locked track.
 */
export function move(tl: NleTimeline, keys: string[], d: number, lane?: { from: string; to: string }): NleTimeline {
  const all = withLinked(tl, keys);
  if (!all.length || lockedAny(tl, all)) return tl;
  const to = lane && lane.from !== lane.to && tl.tracks[lane.to] && isVideo(lane.from) === isVideo(lane.to) && !tl.tracks[lane.to].locked ? lane : undefined;
  const items = all.map((k) => find(tl, k)!.item);
  d = Math.max(d, -Math.min(...items.map((i) => i.rec)));
  if (!d && !to) return tl;
  const out = clone(tl);
  const moved = new Set(all);
  const landed: [string, NleItem][] = [];
  for (const [track, t] of Object.entries(out.tracks)) {
    t.items = t.items.filter((i) => {
      if (!moved.has(i._k!)) return true;
      landed.push([to && track === to.from ? to.to : track, { ...i, rec: i.rec + d }]);
      return false;
    });
  }
  for (const [track, it] of landed) clear(out, track, it.rec, endOf(it), moved);
  for (const [track, it] of landed) out.tracks[track].items.push(it);
  return sortAll(out);
}

/**
 * One end of a clip pulled by `d` frames (> 0 later, < 0 earlier), with the linked clips whose same end is at the same
 * frame. A plain trim stops at the next clip and at the ends of the source; a ripple trim moves what comes after.
 */
export function trim(tl: NleTimeline, key: string, edge: Edge, d: number, ripple_ = false): NleTimeline {
  const hit = find(tl, key);
  if (!hit || !d) return tl;
  const at = edge === "head" ? hit.item.rec : endOf(hit.item);
  const group = withLinked(tl, [key]).filter((k) => {
    const i = find(tl, k)!.item;
    return (edge === "head" ? i.rec : endOf(i)) === at;
  });
  if (lockedAny(tl, group)) return tl;
  const skip = new Set(group);
  for (const k of group) {
    const { track, item: i } = find(tl, k)!;
    const room = roomOf(tl, i);
    const near = tl.tracks[track].items.filter((x) => !skip.has(x._k!));
    if (edge === "tail") {
      d = Math.max(d, 1 - i.len);
      d = Math.min(d, room.after);
      if (!ripple_) d = Math.min(d, Math.min(Infinity, ...near.filter((x) => x.rec >= endOf(i)).map((x) => x.rec)) - endOf(i));
    } else if (ripple_) {
      // the start stays where it is and the clip begins later (or earlier) in its source
      d = Math.min(d, i.len - 1);
      d = Math.max(d, -room.before);
    } else {
      d = Math.min(d, i.len - 1);
      d = Math.max(d, -room.before, -i.rec);
      d = Math.max(d, Math.max(-Infinity, ...near.filter((x) => endOf(x) <= i.rec).map(endOf)) - i.rec);
    }
  }
  if (!d) return tl;
  const out = clone(tl);
  // a ripple head trim: the clip loses `d` at its start, and what comes after moves back by `d`
  const shift = ripple_ ? ripple(out, at, edge === "tail" ? d : -d, skip) : 0;
  if (ripple_ && shift !== (edge === "tail" ? d : -d)) {
    if (!shift) return tl;
    d = edge === "tail" ? shift : -shift;
  }
  for (const k of group) {
    const i = find(out, k)!.item;
    if (edge === "tail") i.len += d;
    else {
      i.in = r3(i.in + d * rateOf(out, i));
      i.len -= d;
      if (!ripple_) i.rec += d;
    }
  }
  return sortAll(out);
}

/** The cut between a clip and the one right after it on its track moved by `d`: one gets longer, the other shorter. */
export function roll(tl: NleTimeline, key: string, d: number): NleTimeline {
  const hit = find(tl, key);
  if (!hit || !d) return tl;
  const at = endOf(hit.item);
  // the linked clips that end at the same cut roll with it (a shot and its voice), each with the clip after it there
  const pairs = withLinked(tl, [key]).map((k) => find(tl, k)!).filter((h) => endOf(h.item) === at)
    .map((h) => ({ ...h, next: tl.tracks[h.track].items.find((x) => x.rec === at) }));
  if (pairs.some((p) => tl.tracks[p.track].locked)) return tl;
  for (const p of pairs) {
    d = Math.max(d, 1 - p.item.len);
    if (p.next) d = Math.max(d, -roomOf(tl, p.next).before);
    d = Math.min(d, roomOf(tl, p.item).after);
    if (p.next) d = Math.min(d, p.next.len - 1);
    else d = Math.min(d, Math.min(Infinity, ...tl.tracks[p.track].items.filter((x) => x.rec >= at).map((x) => x.rec)) - at);
  }
  if (!d) return tl;
  const out = clone(tl);
  for (const p of pairs) {
    find(out, p.item._k!)!.item.len += d;
    if (!p.next) continue;
    const b = find(out, p.next._k!)!.item;
    b.rec += d;
    b.len -= d;
    b.in = r3(b.in + d * rateOf(out, b));
  }
  return out;
}

/** What the clip shows moved by `d` timeline frames into its source (the linked clips with it); its place stays. */
export function slip(tl: NleTimeline, key: string, d: number): NleTimeline {
  const group = withLinked(tl, [key]);
  if (!d || lockedAny(tl, group)) return tl;
  for (const k of group) {
    const i = find(tl, k)!.item;
    const room = roomOf(tl, i);
    d = Math.max(-room.before, Math.min(room.after, d));
  }
  if (!d) return tl;
  const out = clone(tl);
  for (const k of group) {
    const i = find(out, k)!.item;
    i.in = r3(i.in + d * rateOf(out, i));
  }
  return out;
}

/** Clips cut in two at frame `f`: the ones given, or every clip under it on the unlocked tracks. */
export function blade(tl: NleTimeline, f: number, keys?: string[]): NleTimeline {
  const want = keys?.length ? new Set(withLinked(tl, keys)) : null;
  const out = clone(tl);
  let any = false;
  for (const t of Object.values(out.tracks)) {
    if (t.locked) continue;
    t.items = t.items.flatMap((i) => {
      if ((want && !want.has(i._k!)) || f <= i.rec || f >= endOf(i)) return [i];
      any = true;
      return cutAt(out, i, f);
    });
  }
  return any ? out : tl;
}

/** Clips taken out (with their linked clips). Ripple: what came after moves up to close the gap, every track together. */
export function remove(tl: NleTimeline, keys: string[], ripple_ = false): NleTimeline {
  const all = withLinked(tl, keys);
  if (!all.length || lockedAny(tl, all)) return tl;
  const items = all.map((k) => find(tl, k)!.item);
  const out = clone(tl);
  const gone = new Set(all);
  for (const t of Object.values(out.tracks)) t.items = t.items.filter((i) => !gone.has(i._k!));
  if (ripple_) {
    const a = Math.min(...items.map((i) => i.rec));
    const b = Math.max(...items.map(endOf));
    ripple(out, b, a - b, new Set());
  }
  return out;
}

/** Clips laid on the timeline: each on its own track from its `rec`. Overwrite takes out what is under them; insert
 *  cuts every unlocked track at the first one's start and pushes what is after by their length. */
export function place(tl: NleTimeline, clips: { track: string; item: NleItem }[], mode: PlaceMode = "overwrite"): { tl: NleTimeline; keys: string[] } {
  const ok = clips.filter((c) => !tl.tracks[c.track]?.locked);
  if (!ok.length) return { tl, keys: [] };
  let out = clone(tl);
  const fresh = ok.map((c) => ({ track: c.track, item: { ...clone(c.item), _k: newKey(), rec: Math.max(0, Math.round(c.item.rec)), len: Math.max(1, Math.round(c.item.len)) } }));
  if (mode === "insert") {
    const a = Math.min(...fresh.map((c) => c.item.rec));
    const b = Math.max(...fresh.map((c) => endOf(c.item)));
    out = blade(out, a);
    ripple(out, a, b - a, new Set());
  } else for (const c of fresh) clear(out, c.track, c.item.rec, endOf(c.item), new Set());
  for (const c of fresh) out.tracks[c.track].items.push(c.item);
  return { tl: sortAll(out), keys: fresh.map((c) => c.item._k!) };
}

/** The picked clips as a clipboard: each with its track and its start counted from the first one's. */
export function copyOf(tl: NleTimeline, keys: string[]): { track: string; item: NleItem }[] {
  const hits = withLinked(tl, keys).map((k) => find(tl, k)!).filter(Boolean);
  const a = Math.min(...hits.map((h) => h.item.rec));
  return hits.map((h) => ({ track: h.track, item: { ...clone(h.item), rec: h.item.rec - a } }));
}

/** A clipboard laid at frame `at`: the clips keep their link to each other under a new link, not to the originals. */
export function paste(tl: NleTimeline, clip: { track: string; item: NleItem }[], at: number, mode: PlaceMode = "overwrite") {
  const links = new Map<unknown, string>();
  const fresh = clip.filter((c) => tl.tracks[c.track]).map((c) => {
    const { link, ...rest } = c.item;
    if (link !== undefined && !links.has(link)) links.set(link, `l${newKey()}`);
    return { track: c.track, item: { ...rest, rec: at + c.item.rec, ...(link !== undefined ? { link: links.get(link) } : {}) } };
  });
  return place(tl, fresh, mode);
}

/** Copies of the clips right after the last of them. */
export function duplicate(tl: NleTimeline, keys: string[]) {
  const hits = withLinked(tl, keys).map((k) => find(tl, k)!.item);
  if (!hits.length) return { tl, keys: [] };
  return paste(tl, copyOf(tl, keys), Math.max(...hits.map(endOf)));
}

/** Fields of clips set (the inspector). `undefined` takes a field off. */
export function setItems(tl: NleTimeline, keys: string[], patch: Partial<NleItem>): NleTimeline {
  if (!keys.length || lockedAny(tl, keys)) return tl;
  const out = clone(tl);
  for (const k of keys) {
    const i = find(out, k)?.item;
    if (!i) continue;
    for (const [f, v] of Object.entries(patch)) if (v === undefined) delete i[f]; else i[f] = v;
  }
  return out;
}

/** A new speed for clips: each keeps its length unless its source runs out sooner, then it ends there. */
export function setSpeed(tl: NleTimeline, keys: string[], speed: number): NleTimeline {
  const out = setItems(tl, keys, { speed: speed === 1 ? undefined : speed });
  if (out === tl) return tl;
  for (const k of keys) {
    const i = find(out, k)?.item;
    const dur = i && out.sources[i.src]?.dur;
    if (i && typeof dur === "number") i.len = Math.max(1, Math.min(i.len, Math.floor((dur - i.in) / rateOf(out, i) + 1e-6)));
  }
  return out;
}

export const unlink =(tl: NleTimeline, keys: string[]) => setItems(tl, withLinked(tl, keys), { link: undefined });

export function linkTogether(tl: NleTimeline, keys: string[]): NleTimeline {
  return keys.length > 1 ? setItems(tl, keys, { link: `l${newKey()}` }) : tl;
}

/** A track's own switches and name. */
export function setTrack(tl: NleTimeline, id: string, patch: Partial<Omit<NleTrack, "items">>): NleTimeline {
  if (!tl.tracks[id]) return tl;
  const out = clone(tl);
  Object.assign(out.tracks[id], patch);
  for (const [f, v] of Object.entries(patch)) if (v === undefined) delete out.tracks[id][f];
  return out;
}

/** A new track above the video tracks or below the audio tracks. Returns its id. */
export function addTrack(tl: NleTimeline, kind: "V" | "A"): { tl: NleTimeline; id: string } {
  const n = 1 + Math.max(0, ...Object.keys(tl.tracks).filter((t) => t[0] === kind).map(trackNo));
  const id = `${kind}${n}`;
  const out = clone(tl);
  out.tracks[id] = { name: id, items: [] };
  return { tl: out, id };
}

/** A source for a file, or the one that already plays it. Returns its key. */
export function addSource(tl: NleTimeline, s: NleSource & { path: string }): { tl: NleTimeline; src: string } {
  const had = Object.keys(tl.sources).find((k) => tl.sources[k].path === s.path);
  if (had) return { tl, src: had };
  let src = s.path.split("/").pop() || "clip";
  while (src in tl.sources) src += "+";
  const out = clone(tl);
  out.sources[src] = Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined));
  return { tl: out, src };
}

/** The first track of a kind with nothing between frames a and b (a new one when all are taken). */
export function freeTrack(tl: NleTimeline, kind: "V" | "A", a: number, b: number, from = 1): { tl: NleTimeline; id: string } {
  const ids = Object.keys(tl.tracks).filter((t) => t[0] === kind && trackNo(t) >= from && !tl.tracks[t].locked).sort((x, y) => trackNo(x) - trackNo(y));
  const free = ids.find((t) => !tl.tracks[t].items.some((i) => i.rec < b && endOf(i) > a));
  return free ? { tl, id: free } : addTrack(tl, kind);
}

/** Every clip edge, for a drag to land on. */
export const edgesOf = (tl: NleTimeline, except: Set<string>) =>
  [0, ...Object.values(tl.tracks).flatMap((t) => t.items.filter((i) => !except.has(i._k!)).flatMap((i) => [i.rec, endOf(i)]))];

/**
 * Y and ⌥Y (Select clips forward / on this track) and ⌘Y (backward): the clips on the unlocked tracks (or only `tracks`)
 * that end after frame `f`, or start before it backward. The clip under the playhead is in both.
 */
export function clipsFrom(tl: NleTimeline, f: number, dir: 1 | -1, tracks?: string[]): string[] {
  return Object.entries(tl.tracks)
    .filter(([id, t]) => !t.locked && (!tracks || tracks.includes(id)))
    .flatMap(([, t]) => t.items.filter((i) => (dir > 0 ? endOf(i) > f : i.rec < f)).map((i) => i._k!));
}

/** The clip under frame `f` that Q, W and E work on: a picked one, else the lowest video track's, else the first sound track's. */
export function clipAt(tl: NleTimeline, f: number, picked: string[]): { track: string; item: NleItem } | null {
  const hits = Object.entries(tl.tracks).filter(([, t]) => !t.locked)
    .flatMap(([track, t]) => t.items.filter((i) => i.rec < f && f < endOf(i)).map((item) => ({ track, item })));
  const mine = hits.filter((h) => picked.includes(h.item._k!));
  const rank = (h: { track: string }) => (isVideo(h.track) ? 0 : 1000) + trackNo(h.track);
  return (mine.length ? mine : hits).sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/** Q / W: the clip under frame `f` loses its start (or end) up to `f`, and what comes after moves up to close the gap. */
export function rippleToPlayhead(tl: NleTimeline, f: number, edge: Edge, picked: string[]): NleTimeline {
  const h = clipAt(tl, f, picked);
  if (!h) return tl;
  return trim(tl, h.item._k!, edge, f - (edge === "head" ? h.item.rec : endOf(h.item)), true);
}

/**
 * E (Extend edit): the clip's end nearer frame `f` (the end past which `f` lies) is moved to `f`. A cut against the next
 * or the previous clip rolls, so that clip gives up what this one takes; a free end is trimmed.
 */
export function extendTo(tl: NleTimeline, key: string, f: number): NleTimeline {
  const hit = find(tl, key);
  if (!hit) return tl;
  const { item: it, track } = hit;
  const tail = f >= endOf(it) || (f > it.rec && endOf(it) - f <= f - it.rec);
  const d = f - (tail ? endOf(it) : it.rec);
  const items = tl.tracks[track].items;
  if (tail) return items.some((x) => x.rec === endOf(it)) ? roll(tl, key, d) : trim(tl, key, "tail", d);
  const prev = items.find((x) => endOf(x) === it.rec);
  return prev ? roll(tl, prev._k!, d) : trim(tl, key, "head", d);
}

/** What each clip field is when it does nothing (crop: all zero; flip: none). */
const PLAIN: Record<string, unknown> = { zoom: 1, pan: 0, tilt: 0, rot: 0, opacity: 1, speed: 1, gain_db: 0, fade_in: 0, fade_out: 0 };
const plainField = (f: string, v: unknown) =>
  v === undefined || v === PLAIN[f] || (f === "crop" && Array.isArray(v) && v.every((x) => !x));

/** Whether clips' fields all do nothing (an inspector section left as it was). */
export const isPlain = (tl: NleTimeline, keys: string[], fields: string[]): boolean =>
  keys.every((k) => {
    const it = find(tl, k)?.item;
    return !it || fields.every((f) => plainField(f, it[f]));
  });

/** Clips' fields as they are now, each clip's own (`undefined` = not set), for `putParts` to put back. */
export function partsOf(tl: NleTimeline, keys: string[], fields: string[]): Record<string, Partial<NleItem>> {
  const out: Record<string, Partial<NleItem>> = {};
  for (const k of keys) {
    const it = find(tl, k)?.item;
    if (it) out[k] = Object.fromEntries(fields.map((f) => [f, it[f]])) as Partial<NleItem>;
  }
  return out;
}

/** Each clip's fields set to `parts[key]`; `speed` through setSpeed (a clip never runs past its source). */
export function putParts(tl: NleTimeline, parts: Record<string, Partial<NleItem>>): NleTimeline {
  let out = tl;
  for (const [k, p] of Object.entries(parts)) {
    const { speed, ...rest } = p;
    if (Object.keys(rest).length) out = setItems(out, [k], rest);
    if ("speed" in p) out = setSpeed(out, [k], speed ?? 1);
  }
  return out;
}

/** Clips' fields back to doing nothing. */
export const resetFields = (tl: NleTimeline, keys: string[], fields: string[]): NleTimeline =>
  putParts(tl, Object.fromEntries(keys.map((k) => [k, Object.fromEntries(fields.map((f) => [f, undefined]))])));

/** The Inspector's fade rows: the fade at the picked clips' start ("in") or end ("out"), each clip on its own. */
export const setFades = (tl: NleTimeline, keys: string[], edge: "in" | "out", frames: number): NleTimeline =>
  keys.reduce((out, k) => setFade(out, k, edge === "in" ? "head" : "tail", frames), tl);

/**
 * A clip's fade at its start (`head`, fade_in) or end (`tail`, fade_out) set to `frames`, kept so the two fit in the
 * clip; 0 takes it off. The clip alone, not its linked clips.
 */
export function setFade(tl: NleTimeline, key: string, edge: Edge, frames: number): NleTimeline {
  const hit = find(tl, key);
  if (!hit || tl.tracks[hit.track].locked) return tl;
  const [f, other] = edge === "head" ? (["fade_in", "fade_out"] as const) : (["fade_out", "fade_in"] as const);
  const v = Math.max(0, Math.min(Math.round(frames) || 0, hit.item.len - (hit.item[other] ?? 0)));
  if (v === (hit.item[f] ?? 0)) return tl;
  return setItems(tl, [key], { [f]: v || undefined });
}

/** How much of a clip shows `k` timeline frames after its start, 0–1, from its fades. */
export const fadeAt = (it: NleItem, k: number): number =>
  Math.max(0, Math.min(1, it.fade_in ? k / it.fade_in : 1, it.fade_out ? (it.len - k) / it.fade_out : 1));

/** In and Out marks in frames (null: not marked); Out is the last frame of the marked part. */
export type Marks = [number | null, number | null];
export const NO_MARKS: Marks = [null, null];

/** Marks after Mark In / Mark Out at frame `f` (an Out before the new In, or an In after the new Out, goes) or a clear. */
export function setMark(m: Marks, what: "in" | "out" | "clearIn" | "clearOut" | "clear", f: number): Marks {
  const [i, o] = m;
  switch (what) {
    case "in": return [f, o !== null && o >= f ? o : null];
    case "out": return [i !== null && i <= f ? i : null, f];
    case "clearIn": return [null, o];
    case "clearOut": return [i, null];
    case "clear": return NO_MARKS;
  }
}

/** A source's marked part in seconds, `from` its In to the end of its Out frame (the whole of `seconds` around what is
 *  not marked); undefined when nothing is marked. */
export function markedPart(m: Marks | undefined, fps: number, seconds?: number): { from: number; to?: number } | undefined {
  if (!m || (m[0] === null && m[1] === null)) return undefined;
  return { from: (m[0] ?? 0) / fps, ...(m[1] !== null ? { to: (m[1] + 1) / fps } : seconds ? { to: seconds } : {}) };
}

/** A clip laid at `rec` from a source's part `from`–`to` seconds (the whole `seconds` when unmarked; 5 s when nothing is
 *  known): `in` in the source's own frames (`sfps`), `len` in the timeline's (`fps`). */
export function clipOfPart(src: string, rec: number, fps: number, sfps: number, p: { seconds?: number; from?: number; to?: number }): NleItem {
  const from = Math.max(0, p.from ?? 0);
  const to = p.to ?? p.seconds ?? from + 5;
  return { src, rec, in: Math.round(from * sfps), len: Math.max(1, Math.round((to - from) * fps)) };
}

/** A one-clip timeline playing a source on its own (the source viewer): its picture on V1 and its sound on A1, as far as
 *  it has them, at the source's own frame rate and size. */
export function sourceTimeline(key: string, s: NleSource, o: { fps: number; frames: number; picture: boolean; sound: boolean }): NleTimeline {
  const item = (): NleItem => ({ src: key, rec: 0, len: Math.max(1, o.frames), in: 0 });
  return {
    timeline: { fps: o.fps, width: o.picture ? s.w || 1080 : 1920, height: o.picture ? s.h || 1920 : 1080, name: key },
    sources: { [key]: s },
    tracks: { V1: { items: o.picture ? [item()] : [] }, A1: { items: o.sound ? [item()] : [] } },
  };
}

/** The part looping playback plays, in seconds: In to the end of the Out frame when both are marked, else 0 to the end of
 *  the last frame (`frames` long). */
export const loopPart = (m: Marks, frames: number, fps: number): [number, number] =>
  m[0] !== null && m[1] !== null && m[1] >= m[0] ? [m[0] / fps, (m[1] + 1) / fps] : [0, frames / fps];

/** Where looping playback goes from `t` seconds: past the part's end going forward, back to its start (with what it ran
 *  over, so the clock keeps time); before its start going backward, to its end; else `t`. */
export function loopNext(t: number, rate: number, [a, b]: [number, number]): number {
  const len = b - a;
  if (len <= 0) return t;
  // a playhead far outside the part (play pressed after the Out) goes to its start / end exactly
  if (rate > 0 && t >= b) return t - b < len ? a + (t - b) : a;
  if (rate < 0 && t < a) return a - t < len ? b - Math.max(1e-6, a - t) : b - 1e-6;
  return t;
}

/** Where Insert (F9) and Overwrite (F10) lay a source: the track of a picked clip, picture and sound each, else V1 / A1. */
export function editTracks(tl: NleTimeline, picked: string[]): { picture: string; sound: string } {
  const on = picked.map((k) => find(tl, k)?.track).filter((t): t is string => !!t);
  return { picture: on.find(isVideo) ?? "V1", sound: on.find((t) => !isVideo(t)) ?? "A1" };
}

// Round 3: a clip's look kept across tracks, the track menu (add, move, delete), box select and where a drop lands.

// eslint-disable-next-line import/first -- the renderer's cover/fit rule, read only when called (picture.ts imports this file)
import { covers } from "./picture";

/**
 * The clip as it would be on picture track `to`, looking as it did on `from`: the renderer scales a source to cover the
 * frame on some tracks and to fit inside it on the others, so its zoom takes the difference and its size on screen stays.
 * The clip as it is when that doesn't differ or the source's size isn't known.
 */
export function lookOn(tl: NleTimeline, it: NleItem, from: string, to: string): NleItem {
  const s = tl.sources[it.src];
  const W = tl.timeline.width || 1080;
  const H = tl.timeline.height || 1920;
  if (!isVideo(from) || !isVideo(to) || covers(from) === covers(to) || !s?.w || !s?.h) return it;
  const cover = Math.max(W / s.w, H / s.h);
  const fit = Math.min(W / s.w, H / s.h);
  const zoom = r3((it.zoom ?? 1) * (covers(from) ? cover / fit : fit / cover));
  const { zoom: _, ...rest } = it;
  return zoom === 1 ? rest : { ...rest, zoom };
}

/** `after` with every clip that went to another picture track since `before` looking as it did there (lookOn). */
export function keepLooks(before: NleTimeline, after: NleTimeline): NleTimeline {
  const was = new Map<string, string>();
  for (const [id, t] of Object.entries(before.tracks)) for (const i of t.items) if (i._k) was.set(i._k, id);
  let out: NleTimeline | null = null;
  for (const [id, t] of Object.entries(after.tracks)) {
    t.items.forEach((i, n) => {
      const from = i._k ? was.get(i._k) : undefined;
      const next = from && from !== id ? lookOn(after, i, from, id) : i;
      if (next === i) return;
      out ??= clone(after);
      out.tracks[id].items[n] = next;
    });
  }
  return out ?? after;
}

/** The tracks of a kind from number 1 up, in number order (V0, which the renderer doesn't draw, stays out of it). */
const kindOrder = (tl: NleTimeline, kind: "V" | "A") =>
  Object.keys(tl.tracks).filter((t) => t[0] === kind && trackNo(t) >= 1).sort((a, b) => trackNo(a) - trackNo(b));

// A track keeps its number for good: the AI Editor reads the tracks by number (V1 the talent, V3 motion graphics, A1 the
// voice…), so adding or deleting one never numbers the others again. Only Move Track changes what is on a number.

/** A new empty track with number `n` (1 = V1 / A1), when that number is free. */
export function addTrackAt(tl: NleTimeline, kind: "V" | "A", n: number): { tl: NleTimeline; id: string } | null {
  const id = `${kind}${Math.round(n)}`;
  if (n < 1 || tl.tracks[id]) return null;
  const out = clone(tl);
  out.tracks[id] = { name: id, items: [] };
  return { tl: out, id };
}

/** The track a track trades places with one step up or down on screen among its kind (video tracks count up the
 *  screen, sound tracks down it): null at the end, or when it or that one is locked. */
export function moveTarget(tl: NleTimeline, id: string, up: boolean): string | null {
  const order = kindOrder(tl, id[0] as "V" | "A");
  const i = order.indexOf(id);
  const other = order[i + ((id[0] === "V") === up ? 1 : -1)];
  return i >= 0 && other && !tl.tracks[id].locked && !tl.tracks[other].locked ? other : null;
}

/** A track moved one place up or down on screen among its kind: it and its neighbour trade numbers, each with its
 *  name, switches and clips (the clips keeping their look, lookOn). */
export function moveTrack(tl: NleTimeline, id: string, up: boolean): NleTimeline {
  const other = moveTarget(tl, id, up);
  if (!other) return tl;
  const out = clone(tl);
  const onto = (from: string, to: string) => ({ ...clone(tl.tracks[from]), items: tl.tracks[from].items.map((i) => lookOn(tl, i, from, to)) });
  out.tracks[other] = onto(id, other);
  out.tracks[id] = onto(other, id);
  return out;
}

/** A track can go: not locked, and not V1 or A1 (a timeline always has the talent's tracks to put a clip on). */
export const canDeleteTrack = (tl: NleTimeline, id: string) =>
  !!tl.tracks[id] && !tl.tracks[id].locked && trackNo(id) >= 1 && id !== "V1" && id !== "A1";

/** A track taken off with its clips; the others keep their numbers. */
export function deleteTrack(tl: NleTimeline, id: string): NleTimeline {
  if (!canDeleteTrack(tl, id)) return tl;
  const out = clone(tl);
  delete out.tracks[id];
  return out;
}

/** Every empty track taken off (not locked ones, not V1 or A1); the others keep their numbers. */
export function deleteEmptyTracks(tl: NleTimeline): NleTimeline {
  const gone = Object.keys(tl.tracks).filter((t) => canDeleteTrack(tl, t) && !tl.tracks[t].items.length);
  if (!gone.length) return tl;
  const out = clone(tl);
  for (const t of gone) delete out.tracks[t];
  return out;
}

/** The clips on `tracks` (locked tracks left out) that a box from frame `a` to frame `b` touches. */
export function boxPick(tl: NleTimeline, tracks: string[], a: number, b: number): string[] {
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return tracks.flatMap((id) => {
    const t = tl.tracks[id];
    return !t || t.locked ? [] : t.items.filter((i) => i.rec <= hi && endOf(i) > lo).map((i) => i._k!);
  });
}

/** Where a drop of `len` frames at `frame` on `track` lands, as the editor lays it: on that track, and a picture's sound
 *  with it on the first free sound track (from A1 under V1, from A2 under the others). */
export function dropPlan(tl: NleTimeline, track: string, frame: number, len: number, sound: boolean): { track: string; rec: number; len: number }[] {
  const out = [{ track, rec: frame, len }];
  if (isVideo(track) && sound) out.push({ track: freeTrack(tl, "A", frame, frame + len, track === "V1" ? 1 : 2).id, rec: frame, len });
  return out;
}
