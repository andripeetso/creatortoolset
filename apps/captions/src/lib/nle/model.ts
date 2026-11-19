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
    for (const it of t.items) delete it._k;
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
  const right = { ...clone(it), _k: newKey(), rec: f, len: it.len - d, in: r3(it.in + d * rateOf(tl, it)) };
  return [{ ...it, len: d }, right];
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

/** A track taken off with what is on it (V1 and A1 stay: a timeline always has somewhere to put a clip). */
export function removeTrack(tl: NleTimeline, id: string): NleTimeline {
  if (!tl.tracks[id] || id === "V1" || id === "A1" || tl.tracks[id].locked) return tl;
  const out = clone(tl);
  delete out.tracks[id];
  return out;
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
