import { TRACKS, type Item, type Timeline, type TrackId } from "../../contracts/editor";
import { editedSpan, playPlan, splitView, type ItemEdit, type TimelineItem, type TimelineView } from "../../contracts/edit-timeline";
import type { TimedWord } from "../library/transcribe";

/**
 * A draft on Review's timeline, and the hand edits made there cut into the draft's next version with no AI.
 *
 * draftView is what Review draws under a version (contracts/edit-timeline.ts): every item keyed "<track>:<frame>".
 * applyEdits takes the same timeline and the edits made on that view, and returns the timeline they make. It reads
 * the edits through the functions Review's player reads them through (splitView, playPlan), so the frames the player
 * skips are the frames that go and the frames it holds are the frames a longer shot gains.
 *
 * What the render can play decides what is made (preview.ts: a speaker shot plays with its linked voice, B-roll over it):
 * - a speaker shot (V1): cut, taken out, an edge in (those words go, the rest moves up) or out (more of the take, the
 *   rest moves later); its voice goes with it;
 * - a voice (A1): cut, taken out, an edge in: the picture stays and plays silent there. It never moves or runs past its shot;
 * - B-roll and the other sound (V2, A2, A3): moved, trimmed, slipped, cut, copied, taken out. One dropped on another
 *   takes its place there. Under frames a speaker edit takes out it gets shorter at its end, its clip running on unbroken.
 */

/** An edit that can't be made into a cut: the message is the whole line the person reads. */
export class EditRefused extends Error {}

const end = (i: { rec: number; len: number }) => i.rec + i.len;
/** Source frames as timeline frames, never more than there are. */
const recFrames = (n: number, sfps: number, fps: number) => Math.floor((n * fps) / sfps);
/** An OTIO marker colour (RED) as Review names it (Red). */
const colourName = (c: string) => (c ? c[0]!.toUpperCase() + c.slice(1).toLowerCase() : c);

/** The draft as Review's timeline. `words`: each source's transcript, for the words lane and each shot's label. */
export function draftView(tl: Timeline, words: Record<string, TimedWord[]> = {}): TimelineView {
  const said: TimelineView["words"] = [];
  const line = new Map<number, string>(); // a shot's first words, by its frame
  for (const a of tl.tracks.A1.items) {
    const sfps = tl.sources[a.src]?.fps || tl.fps;
    const s0 = a.in / sfps;
    const mine = (words[a.src] ?? []).filter((w) => w.e > s0 && w.s < s0 + a.len / tl.fps);
    for (const w of mine) {
      const rs = Math.max(a.rec, a.rec + Math.round((w.s - s0) * tl.fps));
      const re = Math.min(end(a), a.rec + Math.round((w.e - s0) * tl.fps));
      if (re > rs) said.push({ t: w.w, rs, re });
    }
    if (mine.length) line.set(a.rec, mine.slice(0, 7).map((w) => w.w).join(" "));
  }
  const item = (track: TrackId, i: Item): TimelineItem => {
    const s = tl.sources[i.src];
    const sfps = s?.fps || tl.fps;
    const name = s?.name ?? i.src;
    const text = track === "V1" || track === "A1" ? line.get(i.rec) : undefined;
    return {
      key: `${track}:${i.rec}`,
      track,
      rec: i.rec,
      len: i.len,
      label: text ?? name,
      ...(text ? { detail: name } : {}),
      src: i.src,
      ins: Math.round((i.in / sfps) * 1000) / 1000,
      // a voice has no room of its own: it runs for as long as its shot does
      before: track === "A1" ? 0 : recFrames(i.in, sfps, tl.fps),
      after: track === "A1" || !s ? 0 : Math.max(0, recFrames(s.dur - i.in, sfps, tl.fps) - i.len),
    };
  };
  return {
    name: tl.name,
    fps: tl.fps,
    duration: Math.max(0, ...TRACKS.flatMap((t) => tl.tracks[t].items.map(end))),
    width: tl.width,
    height: tl.height,
    tracks: TRACKS.filter((t) => t === "V1" || t === "A1" || tl.tracks[t].items.length).map((t) => ({
      id: t,
      name: tl.tracks[t].name,
      items: [...tl.tracks[t].items].sort((a, b) => a.rec - b.rec).map((i) => item(t, i)),
    })),
    markers: tl.markers.map((m) => ({ frame: m.rec, name: m.name, color: colourName(m.color) })),
    words: said.sort((a, b) => a.rs - b.rs),
    flags: [],
  };
}

/** Why these edits can't be made on this view, one line per edit; empty when they all can. */
function refusals(items: TimelineItem[], edits: ItemEdit[]): string[] {
  const why: string[] = [];
  for (const e of edits) {
    const it = items.find((i) => i.key === e.key);
    if (!it) why.push(`${e.label} is not on this version's timeline`);
    else if (!(TRACKS as readonly string[]).includes(e.track ?? it.track) || (e.track && (e.track[0] !== it.track[0] || e.track === "V1" || e.track === "A1")))
      why.push(`${e.label}: this editor has no layer ${e.track ?? it.track}`);
    else if (e.zoom !== undefined) why.push(`${e.label}: a reframe can't be made into a version here`);
    else if (e.grade) why.push(`${e.label}: a colour change can't be made into a version here`);
    else if (it.track === "A1" && (e.move || (e.head ?? 0) > 0 || (e.tail ?? 0) > 0)) why.push(`${e.label}: a voice stays with its picture, it can only be cut or taken out`);
    else if (!e.remove && it.len + (e.head ?? 0) + (e.tail ?? 0) < 1) why.push(`${e.label} is trimmed to nothing: take it out`);
  }
  return why;
}

/** `tl` with the hand edits made on its view (draftView) cut in. Throws EditRefused, naming every edit it can't make. */
export function applyEdits(tl: Timeline, edits: ItemEdit[]): Timeline {
  const cut = splitView(draftView(tl), edits);
  const items = cut.tracks.flatMap((t) => t.items);
  const why = refusals(items, edits);
  if (why.length) throw new EditRefused(why.join(". "));
  const editOf = new Map(edits.map((e) => [e.key, e]));
  const plan = playPlan(cut, edits);
  // the frames that go, joined where they touch
  const skips: [number, number][] = [];
  for (const [a, b] of [...plan.skips].sort((x, y) => x[0] - y[0])) {
    const last = skips.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else skips.push([a, b]);
  }
  /** A frame of the filed cut on the new timeline: the holds before it added, the frames taken out before it gone. */
  const at = (r: number) =>
    r + plan.holds.reduce((n, h) => n + (h.at < r ? h.frames : 0), 0) - skips.reduce((n, [a, b]) => n + Math.max(0, Math.min(b, r) - a), 0);
  const muted = (r: number) => plan.mutes.some(([a, b]) => r >= a && r < b);
  const sfps = (src: string) => tl.sources[src]?.fps || tl.fps;
  const toSrc = (frames: number, src: string) => Math.round((frames * sfps(src)) / tl.fps);
  const inOf = (i: TimelineItem) => Math.round((i.ins ?? 0) * sfps(i.src!));
  const tracks = Object.fromEntries(TRACKS.map((t) => [t, { name: tl.tracks[t].name, items: [] as Item[] }])) as Timeline["tracks"];

  // the speaker and his voice: each shot as its edit leaves it, cut where its voice goes silent or comes back
  let links = 0;
  for (const p of cut.tracks.find((t) => t.id === "V1")?.items ?? []) {
    const e = editOf.get(p.key);
    if (e?.remove) continue;
    const orig = tl.tracks.V1.items.find((i) => i.rec <= p.rec && p.rec < end(i))!;
    const voice = orig.link ? tl.tracks.A1.items.find((a) => a.link === orig.link) : undefined;
    const [head, tail] = [e?.head ?? 0, e?.tail ?? 0];
    const start = p.rec - head; // its first frame in the filed cut's frames (before the shot when it was made longer)
    const len = p.len + head + tail;
    // counted from the draft's own item, as its voice is below: the two stay on the same source frame
    const srcAt = (k: number) => orig.in + toSrc(start + k - orig.rec, orig.src);
    const src = tl.sources[orig.src];
    if (srcAt(0) < 0 || (src && srcAt(len) > src.dur)) throw new EditRefused(`${e?.label ?? p.label}: its footage has no more there`);
    const [bodyA, bodyB] = [p.rec + Math.max(0, -head), end(p) - Math.max(0, -tail)];
    // a frame it gained takes the voice of the edge it was pulled from
    const silent = (k: number) => !voice || muted(Math.min(bodyB - 1, Math.max(bodyA, start + k)));
    const rec = at(p.rec);
    const { link: _link, ...shot } = orig;
    for (let k0 = 0, k = 1; k <= len; k++) {
      if (k < len && silent(k) === silent(k0)) continue;
      const here = { in: srcAt(k0), len: k - k0, rec: rec + k0 };
      if (silent(k0)) tracks.V1.items.push({ ...shot, ...here });
      else {
        const link = `c${++links}`;
        tracks.V1.items.push({ ...shot, ...here, link });
        tracks.A1.items.push({ ...voice!, in: voice!.in + toSrc(start + k0 - voice!.rec, voice!.src), len: k - k0, rec: rec + k0, link });
      }
      k0 = k;
    }
  }
  if (!tracks.V1.items.length) throw new EditRefused("Nothing would be left of the cut");

  // B-roll and the other sound, in the filed cut's frames: the ones left alone first, an edited one over what it lands on
  const laid = Object.fromEntries(TRACKS.map((t) => [t, [] as Item[]])) as Record<TrackId, Item[]>;
  const lay = (track: TrackId, top: Item) => {
    laid[track] = laid[track].flatMap((o) => {
      if (end(o) <= top.rec || o.rec >= end(top)) return [o];
      return [
        ...(top.rec > o.rec ? [{ ...o, len: top.rec - o.rec }] : []),
        ...(end(o) > end(top) ? [{ ...o, rec: end(top), len: end(o) - end(top), in: o.in + toSrc(end(top) - o.rec, o.src) }] : []),
      ];
    });
    laid[track].push(top);
  };
  /** The draft's own item a piece or a copy comes from (its gain goes with it). */
  const origin = (p: TimelineItem): Item | undefined => {
    let q = p;
    for (let n = 0; q.copyOf && n < 50; n++) q = items.find((i) => i.key === q.copyOf) ?? { ...q, copyOf: undefined };
    return tl.tracks[q.track as TrackId]?.items.find((i) => i.rec <= q.rec && q.rec < end(i));
  };
  const overlays = items.filter((p) => p.track !== "V1" && p.track !== "A1" && !editOf.get(p.key)?.remove);
  for (const edited of [false, true]) {
    for (const p of overlays) {
      const e = editOf.get(p.key);
      if (!!e !== edited) continue;
      const span = editedSpan(p, e);
      const first = Math.max(0, inOf(p) + toSrc((e?.slip ?? 0) - (e?.head ?? 0), p.src!));
      const item: Item = { ...origin(p), src: p.src!, in: first, len: span.len, rec: Math.max(0, span.rec) };
      delete item.link;
      if (edited) lay((e!.track ?? p.track) as TrackId, item);
      else laid[p.track as TrackId].push(item);
    }
  }
  // then onto the new timeline: shorter by the frames taken out under it, longer by the frames gained, as far as its clip goes
  for (const t of TRACKS) {
    for (const o of laid[t]) {
      const [a, b] = [at(o.rec), at(end(o))];
      const gone = skips.find(([x, y]) => o.rec >= x && o.rec < y); // its start was under frames taken out
      const first = o.in + (gone ? toSrc(Math.min(gone[1], end(o)) - o.rec, o.src) : 0);
      const src = tl.sources[o.src];
      const len = Math.min(b - a, src ? recFrames(src.dur - first, sfps(o.src), tl.fps) : b - a);
      if (len > 0) tracks[t].items.push({ ...o, in: first, rec: a, len });
    }
  }
  for (const t of TRACKS) tracks[t].items.sort((x, y) => x.rec - y.rec);
  const used = new Set(TRACKS.flatMap((t) => tracks[t].items.map((i) => i.src)));
  return {
    name: tl.name,
    fps: tl.fps,
    width: tl.width,
    height: tl.height,
    sources: Object.fromEntries(Object.entries(tl.sources).filter(([k]) => used.has(k))),
    tracks,
    markers: tl.markers.map((m) => ({ ...m, rec: at(m.rec) })),
  };
}
