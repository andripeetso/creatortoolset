/**
 * A timeline in Review as a path-free view to draw (an imported timeline file,
 * contracts/timeline-import.ts, or one a plug-in files), and the hand edits a
 * manager makes on it: moves, trims, cuts, copies, reframes and grades, played
 * on the rendered cut and sent with a comment (src/components/ReviewEdits.tsx).
 */

import { cleanGrade, describeGrade, type Grade } from "./grade";

export interface TimelineItem {
  /** stable within a timeline: "<track>:<record frame>" */
  key: string;
  track: string;
  rec: number;
  len: number;
  label: string;
  detail?: string;
  /** source key (never a path): shots of one camera take share it */
  src?: string;
  /** V1: the shot's framing (a reframe starts from it) */
  zoom?: number;
  pan?: number;
  tilt?: number;
  /** V1: the grade it's rendered with */
  grade?: Grade;
  /** an overlay a plug-in can play (its clip id) */
  clip?: number;
  /** where in its media (`src`, or `clip`) this item starts, in seconds: what plays it from the original */
  ins?: number;
  /** record frames of its media before its first frame and after its last (none = no end known):
   *  how far an edge can be pulled out or the clip slipped */
  before?: number;
  after?: number;
  /** a piece of a split item: the key of the item it was cut from (splitView) */
  from?: string;
  /** a copy (paste, Option-drag): the key of the item it copies */
  copyOf?: string;
}

export interface TimelineView {
  name: string;
  fps: number;
  duration: number;
  /** frame size in timeline px (pan/tilt are in these); 0 when the file doesn't say */
  width: number;
  height: number;
  tracks: { id: string; name: string; items: TimelineItem[] }[];
  markers: { frame: number; name: string; color?: string }[];
  words: { t: string; rs: number; re: number }[];
  flags: { rec: number; len?: number; check: string; what: string }[];
}

// ---- hand edits in Review ---------------------------------------------------
// A manager moves, trims, extends, removes and reframes items on the Review
// timeline; the edits ride on a comment (a plug-in may make them into the next
// version). Frames of the reviewed cut. head/tail
// > 0 = longer at that end (an overlay's picture stays where it is; a talent
// shot runs on, silent), < 0 = shorter (a talent shot loses those words and
// everything after moves up); move = the whole overlay later (< 0 earlier);
// track = the overlay goes to that layer (V2 <-> V3 ..., A2 <-> A3 ...);
// split = record frames it is cut at, before anything else: the first piece
// keeps the key, every other one is "<track>:<frame>" with edits of its own;
// copyOf = this key is a new item, a copy of that one (paste, Option-drag),
// with the rest of its edit on the copy; slip = an overlay's span plays that
// many frames later in its clip (< 0 earlier), where it is (the slip tool).

export interface ItemEdit {
  key: string;
  label: string;
  remove?: boolean;
  move?: number;
  head?: number;
  tail?: number;
  track?: string;
  split?: number[];
  copyOf?: string;
  slip?: number;
  /** V1 reframe: the shot's new framing */
  zoom?: number;
  pan?: number;
  tilt?: number;
  /** V1: the shot's new grade (contracts/grade.ts) */
  grade?: Grade;
}

const neutral = (e: ItemEdit) => !e.remove && !e.move && !e.head && !e.tail && !e.track && !e.split?.length && !e.copyOf && !e.slip && e.zoom === undefined && !e.grade;
/** Layers an overlay may go to: the same kind, never the talent or its voice. */
export const layerFor = (from: string, to: string) => to !== from && to[0] === from[0] && /^[VA][2-9]$/.test(to);
const whole = (v: unknown) => (Number.isInteger(v) && v !== 0 && Math.abs(v as number) <= 100_000 ? (v as number) : undefined);
const real = (v: unknown, lo: number, hi: number, per = 10) =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v * per) / per : undefined;

/** A comment's edits as the server keeps them (one per item, nothing on the voice track). */
export function cleanEdits(v: unknown): ItemEdit[] {
  const out = new Map<string, ItemEdit>();
  for (const raw of Array.isArray(v) ? v.slice(0, 200) : []) {
    const e = raw as Record<string, unknown> | null;
    if (!e || typeof e.key !== "string" || !/^[VA][1-9]:\d{1,7}$/.test(e.key)) continue;
    const talent = e.key.startsWith("V1:");
    // the voice (A1) alone: cut, its edges, moved
    // along its lane, a piece out (silence); never onto another lane, slipped or copied
    const voice = e.key.startsWith("A1:");
    const x: ItemEdit = { key: e.key, label: typeof e.label === "string" && e.label.trim() ? e.label.trim().slice(0, 120) : e.key };
    if (e.remove === true) x.remove = true;
    else {
      const [move, head, tail, slip] = [talent ? undefined : whole(e.move), whole(e.head), whole(e.tail), talent || voice ? undefined : whole(e.slip)];
      Object.assign(x, move && { move }, head && { head }, tail && { tail }, slip && { slip });
      const from = e.key.slice(0, 2);
      if (!talent && !voice && typeof e.track === "string" && layerFor(from, e.track)) x.track = e.track;
      const zoom = talent ? real(e.zoom, 1, 3, 1000) : undefined;
      if (zoom !== undefined) Object.assign(x, { zoom }, { pan: real(e.pan, -5000, 5000) ?? 0, tilt: real(e.tilt, -5000, 5000) ?? 0 });
      const grade = talent ? cleanGrade(e.grade) : undefined;
      if (grade) x.grade = grade;
    }
    // cuts stand whatever else the first piece gets (a removed first piece leaves the others)
    const split = Array.isArray(e.split)
      ? [...new Set(e.split.filter((f): f is number => Number.isInteger(f) && f > 0 && f < 10_000_000))].sort((a, b) => a - b).slice(0, 50)
      : [];
    if (split.length) x.split = split;
    // a copy: an overlay of the same kind (never the talent or its voice), not itself
    if (typeof e.copyOf === "string" && /^[VA][2-9]:\d{1,7}$/.test(e.copyOf) && e.copyOf !== e.key && e.copyOf[0] === e.key[0] && !talent && !voice) {
      x.copyOf = e.copyOf;
      delete x.remove;
    }
    if (!neutral(x)) out.set(x.key, x);
  }
  return [...out.values()];
}

/** The pending list with `patch` laid on `key`'s edit (an edit back to nothing goes). */
export function mergeEdit(list: ItemEdit[], key: string, label: string, patch: Partial<ItemEdit>): ItemEdit[] {
  const next: ItemEdit = { ...(list.find((e) => e.key === key) ?? { key, label }), ...patch };
  for (const k of Object.keys(next) as (keyof ItemEdit)[]) {
    const v = next[k];
    if (v === undefined || v === 0 || v === false || (Array.isArray(v) && !v.length)) delete next[k];
  }
  if (next.zoom === undefined) {
    delete next.pan;
    delete next.tilt;
  }
  const rest = list.filter((e) => e.key !== key);
  return neutral(next) ? rest : [...rest, next];
}

/**
 * Several comments' edits as one, oldest first (the timeline stays edited
 * after Send): an item's latest edit is where it stands
 * (Review starts a new one from it, so it is whole), its cuts add up and a
 * copy stays a copy.
 */
export function stackEdits(lists: ItemEdit[][]): ItemEdit[] {
  const out = new Map<string, ItemEdit>();
  for (const e of lists.flat()) {
    const was = out.get(e.key);
    const split = [...new Set([...(was?.split ?? []), ...(e.split ?? [])])].sort((a, b) => a - b);
    const copyOf = e.copyOf ?? was?.copyOf;
    out.set(e.key, { ...e, ...(split.length ? { split } : {}), ...(copyOf ? { copyOf } : {}) });
  }
  return [...out.values()];
}

/**
 * How far an edit may go in its item's media (a dragged edge stops at the
 * clip's limits): the most
 * head and tail it can have with this slip, and the slip's range with this
 * head and tail. Infinity where the media's end isn't known (a still).
 */
export function mediaRoom(it: TimelineItem, e?: Partial<ItemEdit>) {
  const [before, after] = [it.before ?? Infinity, it.after ?? Infinity];
  const [head, tail, slip] = [e?.head ?? 0, e?.tail ?? 0, e?.slip ?? 0];
  return { head: before + slip, tail: after - slip, slip: [head - before, after - tail] as [number, number] };
}

/** Where an item sits once its edit is made (no ripple: Review's video is the old cut). */
export const editedSpan = (it: { rec: number; len: number }, e?: Partial<ItemEdit>) => ({
  rec: it.rec + (e?.move ?? 0) - (e?.head ?? 0),
  len: it.len + (e?.head ?? 0) + (e?.tail ?? 0),
});

export function describeEdit(e: ItemEdit, fps: number): string {
  const f = (n: number) => (Math.abs(n) < fps ? `${Math.abs(n)} f` : `${(Math.abs(n) / fps).toFixed(2)} s`);
  if (e.remove) return e.key.startsWith("V1:") ? "taken out with its voice, what follows moves up"
    : e.key.startsWith("A1:") ? "voice taken out (silent there, the picture stays)" : "removed";
  return [
    e.move && `${f(e.move)} ${e.move < 0 ? "earlier" : "later"}`,
    e.head && (e.head < 0 ? `${f(e.head)} off the start` : `${f(e.head)} more at the start`),
    e.tail && (e.tail < 0 ? `${f(e.tail)} off the end` : `${f(e.tail)} more at the end`),
    e.track && `to ${e.track}`,
    e.slip && `plays ${f(e.slip)} ${e.slip < 0 ? "earlier" : "later"} in its clip`,
    e.copyOf && "a copy",
    e.split?.length && `split ${e.split.length === 1 ? "in two" : `in ${e.split.length + 1}`}`,
    e.zoom !== undefined && `reframed to ${e.zoom.toFixed(2)}×`,
    e.grade && `graded: ${describeGrade(e.grade)}`,
  ].filter(Boolean).join(", ");
}

// Reframe on Review's video (the rendered cut): a 9:16 box inside the frame,
// x/y = its top-left and k = its width, as fractions of the frame. The
// render is out_x = W/2 + z (x - W/2) + pan, out_y = H/2 + z (y - H/2) - tilt
// (the framing a render uses); showing only the box scales that by 1/k.

export type Framing = { zoom: number; pan: number; tilt: number };
export type CropBox = { x: number; y: number; k: number };

export function cropToFraming(f: Framing, b: CropBox, w: number, h: number): Framing {
  const zoom = Math.min(3, f.zoom / b.k);
  const k = f.zoom / zoom;
  const lim = (v: number, half: number) => Math.round(Math.max(-(zoom - 1) * half, Math.min((zoom - 1) * half, v)) * 10) / 10;
  return {
    zoom: Math.round(zoom * 1000) / 1000,
    pan: lim((w / 2 + f.pan - b.x * w) / k - w / 2, w / 2),
    tilt: lim(h / 2 - (h / 2 - f.tilt - b.y * h) / k, h / 2),
  };
}

export function framingToCrop(f: Framing, g: Framing, w: number, h: number): CropBox {
  const k = f.zoom / g.zoom;
  return { x: (w / 2 + f.pan - (g.pan + w / 2) * k) / w, y: (h / 2 - f.tilt - (h / 2 - g.tilt) * k) / h, k };
}

/**
 * A reframe box kept on the camera frame (the footage moves inside the
 * window): the new zoom stays 1x-3x, so the box may be bigger than
 * the render (out to the whole camera frame, which reaches past the render
 * when `f` is zoomed in) and never shows past the camera frame's edges.
 */
export function clampCrop(f: Framing, b: CropBox, w: number, h: number): CropBox {
  const k = Math.min(f.zoom, Math.max(f.zoom / 3, b.k));
  const [x0, y0] = [0.5 + f.pan / w - f.zoom / 2, 0.5 - f.tilt / h - f.zoom / 2]; // the camera frame's corner, in the render
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return { k: r(k), x: r(Math.min(x0 + f.zoom - k, Math.max(x0, b.x))), y: r(Math.min(y0 + f.zoom - k, Math.max(y0, b.y))) };
}

/** Where the camera frame sits in the reframe window (fractions of the window: corner, size). */
export const cameraIn = (f: Framing, b: CropBox, w: number, h: number) => ({
  x: (0.5 + f.pan / w - f.zoom / 2 - b.x) / b.k, y: (0.5 - f.tilt / h - f.zoom / 2 - b.y) / b.k, s: f.zoom / b.k,
});

/** Talent shots framed like this one: the same camera take at the same zoom. */
export const likeThis = (view: TimelineView, it: TimelineItem) =>
  (view.tracks.find((t) => t.id === "V1")?.items ?? []).filter(
    (x) => x.src === it.src && Math.abs((x.zoom ?? 1) - (it.zoom ?? 1)) <= 0.05);

/** Talent shots of the same camera take, any framing: one light, one grade. */
export const sameTake = (view: TimelineView, it: TimelineItem) =>
  (view.tracks.find((t) => t.id === "V1")?.items ?? []).filter((x) => x.src === it.src);

// ---- playing the edits on the old cut -----------------------------------------
// Review's video is the cut as rendered, so while it plays: a talent shot's
// cut frames are skipped, one made longer holds its end (the take isn't here),
// a reframe zooms the picture, and B-roll / graphics / placeholders that now
// cover a span show a card there (their frames aren't here either).

export type PlaceholderLook = "card" | "solid" | "outline";
export const PLACEHOLDER_LOOKS: PlaceholderLook[] = ["card", "solid", "outline"];
export type PlanHole = { track: string; rec: number; len: number; text?: string; look?: PlaceholderLook; color?: string };
export type PlayCard = {
  from: number; to: number; track: string; label: string;
  /** added = it covers this now, gone = it no longer does, hole = a placeholder */
  kind: "added" | "gone" | "hole"; look?: PlaceholderLook; color?: string;
  /** an added overlay a plug-in can play: its clip, and the second of it that plays at `from` */
  clip?: number; at?: number;
};
export interface PlayPlan {
  /** frames to jump over, [from, to) */
  skips: [number, number][];
  /** voice taken out (A1 pieces removed or trimmed): the video plays silent there */
  mutes: [number, number][];
  /** hold the picture at `at` for `frames` */
  holds: { at: number; frames: number }[];
  cards: PlayCard[];
  /** a reframed shot where nothing covers it */
  frames: { from: number; to: number; box: CropBox }[];
  /** a regraded shot where nothing covers it: `was` is what the render has */
  grades: { from: number; to: number; key: string; was?: Grade; grade: Grade }[];
}

/** [from, to) spans minus the others. */
function minus(a: [number, number], cuts: [number, number][]): [number, number][] {
  let out: [number, number][] = [a];
  for (const [c0, c1] of cuts) {
    out = out.flatMap(([x0, x1]): [number, number][] =>
      c1 <= x0 || c0 >= x1 ? [[x0, x1]] : [...(c0 > x0 ? [[x0, c0] as [number, number]] : []), ...(c1 < x1 ? [[c1, x1] as [number, number]] : [])]);
  }
  return out.filter(([x0, x1]) => x1 > x0);
}

export function playPlan(view: TimelineView, edits: ItemEdit[], holes: PlanHole[] = []): PlayPlan {
  const items = view.tracks.flatMap((t) => t.items);
  const covers = items.filter((i) => i.track !== "V1" && i.track[0] === "V").map((i): [number, number] => [i.rec, i.rec + i.len]);
  const plan: PlayPlan = { skips: [], mutes: [], holds: [], cards: [], frames: [], grades: [] };
  for (const e of edits) {
    const it = items.find((i) => i.key === e.key);
    if (!it) continue;
    const end = it.rec + it.len;
    if (it.track === "A1") { // the render has the voice: what's taken out plays silent (a longer one can't be heard here)
      if (e.remove || e.move) plan.mutes.push([it.rec, end]); // moved: gone from here (where it goes, the render has other sound)
      else {
        if ((e.head ?? 0) < 0) plan.mutes.push([it.rec, it.rec - e.head!]);
        if ((e.tail ?? 0) < 0) plan.mutes.push([end + e.tail!, end]);
      }
      continue;
    }
    if (it.track === "V1") {
      if (e.remove) plan.skips.push([it.rec, end]);
      if (e.remove) continue;
      if ((e.head ?? 0) < 0) plan.skips.push([it.rec, it.rec - e.head!]);
      if ((e.tail ?? 0) < 0) plan.skips.push([end + e.tail!, end]);
      if ((e.head ?? 0) > 0) plan.holds.push({ at: it.rec, frames: e.head! });
      if ((e.tail ?? 0) > 0) plan.holds.push({ at: end - 1, frames: e.tail! });
      if (e.zoom !== undefined) {
        const box = framingToCrop({ zoom: it.zoom ?? 1, pan: it.pan ?? 0, tilt: it.tilt ?? 0 },
          { zoom: e.zoom, pan: e.pan ?? 0, tilt: e.tilt ?? 0 }, view.width, view.height);
        for (const [from, to] of minus([it.rec, end], covers)) plan.frames.push({ from, to, box });
      }
      if (e.grade) for (const [from, to] of minus([it.rec, end], covers)) plan.grades.push({ from, to, key: it.key, was: it.grade, grade: e.grade });
      continue;
    }
    const now = editedSpan(it, e);
    const was: [number, number] = [it.rec, end];
    const is: [number, number] = [now.rec, now.rec + now.len];
    const moved = !!e.move || !!e.track;
    const card = (kind: PlayCard["kind"], track: string) => ([from, to]: [number, number]) =>
      plan.cards.push({ from, to, track, label: it.label, kind,
        // the clip's picture where it now plays: the same second of it as before the move
        ...(kind === "added" && it.clip !== undefined ? { clip: it.clip, at: (it.ins ?? 0) + (from - it.rec - (e.move ?? 0) + (e.slip ?? 0)) / view.fps } : {}) });
    if (e.copyOf) { // a copy covers its whole span: nothing of it is in the render
      card("added", e.track ?? it.track)(is);
      continue;
    }
    if (e.remove) {
      card("gone", it.track)(was);
      continue;
    }
    (moved ? [was] : minus(was, [is])).forEach(card("gone", it.track));
    // what an extension adds reaches one frame into the rendered clip: the card or the real clip is up
    // before the render's last frame of it has gone, so playback never shows a frame of what's under it
    // slipped: all of it shows another part of its clip (none of that is in the render)
    (moved || e.slip ? [is] : minus(is, [was]).map(([a, b]): [number, number] => [a === end ? a - 1 : a, b === it.rec ? b + 1 : b]))
      .forEach(card("added", e.track ?? it.track));
  }
  for (const h of holes) {
    plan.cards.push({ from: h.rec, to: h.rec + h.len, track: h.track, label: h.text || "Placeholder", kind: "hole",
      look: h.look ?? "card", ...(h.color ? { color: h.color } : {}) });
  }
  return plan;
}

/**
 * The view with the edits' cuts made (Review's blade) and copies added (paste,
 * Option-drag): a cut item's first piece keeps its
 * key, the others are "<track>:<frame>" with `from` = the key they were cut
 * from; a talent shot's voice (the A1 item at the same frame) is cut with it;
 * a copy is its source's item at its own key.
 */
export function splitView(view: TimelineView, edits: ItemEdit[]): TimelineView {
  const cuts = new Map(edits.filter((e) => e.split?.length).map((e) => [e.key, e.split!]));
  const copies = edits.filter((e) => e.copyOf);
  if (!cuts.size && !copies.length) return view;
  const voice = view.tracks.find((t) => t.id === "A1")?.items ?? [];
  for (const it of view.tracks.find((t) => t.id === "V1")?.items ?? []) {
    const c = cuts.get(it.key);
    const vo = c && voice.find((a) => a.rec === it.rec);
    if (vo) cuts.set(vo.key, [...new Set([...(cuts.get(vo.key) ?? []), ...c])].sort((a, b) => a - b)); // and the voice's own cuts
  }
  const cut: TimelineView = {
    ...view,
    tracks: view.tracks.map((t) => ({
      ...t,
      items: t.items.flatMap((it) => {
        const at = (cuts.get(it.key) ?? []).filter((f) => f > it.rec && f < it.rec + it.len);
        if (!at.length) return [it];
        const edges = [it.rec, ...at, it.rec + it.len];
        return edges.slice(0, -1).map((a, k): TimelineItem => ({
          ...it,
          key: k ? `${t.id}:${a}` : it.key,
          rec: a,
          len: edges[k + 1] - a,
          ...(k ? { from: it.key } : {}),
          ...(it.ins !== undefined ? { ins: Math.round((it.ins + (a - it.rec) / view.fps) * 1000) / 1000 } : {}),
          // its own media room: the pieces before it are media before it, those after it after
          ...(it.before !== undefined ? { before: it.before + a - it.rec } : {}),
          ...(it.after !== undefined ? { after: it.after + it.rec + it.len - edges[k + 1] } : {}),
        }));
      }),
    })),
  };
  if (!copies.length) return cut;
  const all = cut.tracks.flatMap((t) => t.items);
  const tracks = cut.tracks.map((t) => ({ ...t, items: [...t.items] }));
  for (const e of copies) { // in order: a copy of a copy follows the first
    const src = all.find((i) => i.key === e.copyOf);
    if (!src) continue;
    const [id, rec] = e.key.split(":");
    const item: TimelineItem = { ...src, key: e.key, track: id, rec: Number(rec), from: undefined, copyOf: e.copyOf };
    all.push(item);
    let lane = tracks.find((t) => t.id === id);
    if (!lane) tracks.push((lane = { id, name: id, items: [] }));
    lane.items.push(item);
  }
  for (const t of tracks) t.items.sort((a, b) => a.rec - b.rec);
  return { ...cut, tracks };
}

// ---- the edit as it plays from its originals --------------------------------
// The preview above plays the old cut with skips and holds. Played from the originals, the voice (A1) runs on its own
// clock, the edited timeline: the render's frames with every hold put in and every skip taken out. A clip's voice plays
// from its own recording there, handles included (a longer clip plays the words the cut left out).

type Spans = Pick<PlayPlan, "skips" | "holds">;
const ms = (s: number) => Math.round(s * 1000) / 1000;

/** A frame of the cut as a frame of the edited timeline: the holds it is past added, the skipped frames before it taken out. */
export function editedFrame(plan: Spans, r: number): number {
  let e = r;
  for (const h of plan.holds) if (r >= h.at + 1) e += h.frames;
  for (const [a, b] of plan.skips) e -= Math.max(0, Math.min(b, r) - a);
  return e;
}

/** [a, b) without the skips, cut after each held frame (the timeline goes on there while the picture waits). */
function playedSpans(a: number, b: number, plan: Spans): [number, number][] {
  return minus([a, b], plan.skips).flatMap(([x, y]) => {
    const cuts = plan.holds.map((h) => h.at + 1).filter((c) => c > x && c < y).sort((p, q) => p - q);
    const edges = [x, ...cuts, y];
    return edges.slice(0, -1).map((c, i): [number, number] => [c, edges[i + 1]]);
  });
}

/** One stretch of a recording on the edited timeline: from frame `at` for `frames`, `offset` seconds into `src`. */
export type SoundPiece = { src: string; at: number; frames: number; offset: number };

/** Pieces that run on from each other, in the timeline and in the recording, as one. */
function joined(list: SoundPiece[], fps: number): SoundPiece[] {
  const out: SoundPiece[] = [];
  for (const p of list) {
    const q = out.at(-1);
    if (q && q.src === p.src && q.at + q.frames === p.at && Math.abs(q.offset + q.frames / fps - p.offset) < 1e-6) q.frames += p.frames;
    else out.push({ ...p });
  }
  return out;
}

/** The cut's own sound (a stem the length of the render) on the edited timeline: what plays between skips and holds. */
export function renderPieces(plan: Spans, frames: number, fps: number, src = "render"): SoundPiece[] {
  return joined(playedSpans(0, frames, plan).map(([a, b]) => ({ src, at: editedFrame(plan, a), frames: b - a, offset: ms(a / fps) })), fps);
}

/**
 * Each voice clip (A1, with its recording `src` and in point `ins`) on the edited timeline, from its recording: what the
 * picture skips is cut from it too, an edge pulled out plays the recording's words past it (into a hold, when the shot
 * was made longer with it), a move puts it that much later. `view` is the split view (splitView), so a cut clip's
 * pieces are clips of their own.
 */
export function voicePieces(view: TimelineView, edits: ItemEdit[], plan: Spans): SoundPiece[] {
  const fps = view.fps;
  const out: SoundPiece[] = [];
  for (const it of view.tracks.find((t) => t.id === "A1")?.items ?? []) {
    const e = edits.find((x) => x.key === it.key);
    if (!it.src || it.ins === undefined || e?.remove) continue;
    const [move, head, tail, slip] = [e?.move ?? 0, e?.head ?? 0, e?.tail ?? 0, e?.slip ?? 0];
    const src = it.src;
    const sec = (r: number) => ms(it.ins! + (r - it.rec + slip) / fps);
    const pieces: SoundPiece[] = playedSpans(it.rec + Math.max(0, -head), it.rec + it.len - Math.max(0, -tail), plan)
      .map(([a, b]) => ({ src, at: editedFrame(plan, a) + move, frames: b - a, offset: sec(a) }));
    if (!pieces.length) continue;
    if (head > 0) pieces.unshift({ src, at: pieces[0].at - head, frames: head, offset: ms(pieces[0].offset - head / fps) });
    if (tail > 0) {
      const p = pieces.at(-1)!;
      pieces.push({ src, at: p.at + p.frames, frames: tail, offset: ms(p.offset + p.frames / fps) });
    }
    // nothing before the recording's first second (an edge pulled out further than it has)
    const inside = pieces.map((p) => {
      const cut = p.offset < 0 ? Math.round(-p.offset * fps) : 0;
      return cut ? { ...p, at: p.at + cut, frames: p.frames - cut, offset: 0 } : p;
    }).filter((p) => p.frames > 0);
    out.push(...joined(inside, fps));
  }
  return out.sort((a, b) => a.at - b.at);
}
