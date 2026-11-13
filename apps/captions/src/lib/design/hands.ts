import { DESIGN_GAP, type DesignPage, type Layer } from "@contracts/design";

/**
 * What the hands on the canvas work out, as plain functions: where the frames lie, the view (pan and zoom), a layer's
 * bounds through its rotation, resizing about the opposite corner, catching on edges and middles, lining up and
 * spacing out. Nothing here touches the screen, so each rule is checked by a plain test.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
type Turned = Rect & { rotate?: number };
/** The canvas as shown: where its origin is on the screen, and screen pixels per design pixel. */
export interface View {
  x: number;
  y: number;
  z: number;
}
export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export type Align = "left" | "center" | "right" | "top" | "middle" | "bottom";

/**
 * Where a frame lies on the canvas, and its size. The server gives every frame these; one without (a design as an
 * older window still holds it) lies in the row it always lay in, at the design's own size.
 */
export const frameOf = (p: Pick<DesignPage, "x" | "y" | "w" | "h">, k: number, w: number, h: number): Rect => ({ x: p.x ?? k * (w + DESIGN_GAP), y: p.y ?? 0, w: p.w ?? w, h: p.h ?? h });
/** Where a new frame of this size goes: beside the rightmost frame, level with `like` (the frame it is made from). */
export const besideFrames = (frames: readonly Rect[], like: Rect | undefined, size: { w: number; h: number }): Rect => ({ x: frames.length ? Math.max(...frames.map((f) => f.x + f.w)) + DESIGN_GAP : 0, y: like?.y ?? 0, w: size.w, h: size.h });
export const ZOOM = { min: 0.02, max: 32 } as const;
const zoomIn = (z: number) => Math.min(ZOOM.max, Math.max(ZOOM.min, z));
const round = (n: number) => Math.round(n * 100) / 100;

/** The view at zoom `z`, with the canvas point under the screen point (sx, sy) still under it. */
export function zoomAt(v: View, z: number, sx: number, sy: number): View {
  const k = zoomIn(z);
  return { z: k, x: sx - ((sx - v.x) / v.z) * k, y: sy - ((sy - v.y) / v.z) * k };
}

/** The view that shows `box` whole, in the middle of the room, zoomed in no further than `most`. */
export function fitView(box: Rect, room: { w: number; h: number }, pad = 56, most: number = ZOOM.max): View {
  const z = zoomIn(Math.min(most, Math.max(1, room.w - 2 * pad) / box.w, Math.max(1, room.h - 2 * pad) / box.h));
  return { z, x: (room.w - box.w * z) / 2 - box.x * z, y: (room.h - box.h * z) / 2 - box.y * z };
}

/** The upright box round every layer given, each through its own rotation. */
export function boundsOf(layers: readonly Turned[]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const l of layers) {
    const a = ((l.rotate ?? 0) * Math.PI) / 180;
    const hw = (Math.abs(Math.cos(a)) * l.w + Math.abs(Math.sin(a)) * l.h) / 2;
    const hh = (Math.abs(Math.sin(a)) * l.w + Math.abs(Math.cos(a)) * l.h) / 2;
    x0 = Math.min(x0, l.x + l.w / 2 - hw);
    y0 = Math.min(y0, l.y + l.h / 2 - hh);
    x1 = Math.max(x1, l.x + l.w / 2 + hw);
    y1 = Math.max(y1, l.y + l.h / 2 + hh);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const intersects = (a: Rect, b: Rect): boolean => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;

/**
 * A layer resized by one of its eight handles: (dx, dy) is how far the pointer moved, in the page's pixels. The
 * opposite corner (or side) stays where it was on the page, through the layer's rotation; `center` keeps its middle
 * there instead, and `keep` keeps its shape. Never smaller than `min`.
 */
export function resizeBox<T extends Turned>(l: T, handle: Handle, dx: number, dy: number, o: { keep?: boolean; center?: boolean; min?: number } = {}): T {
  const a = ((l.rotate ?? 0) * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const min = o.min ?? 1;
  const whole = l.rotate ? round : Math.round;
  // which way each handle pulls along the layer's own axes, and the pointer's move along them
  const sx = handle.includes("e") ? 1 : handle.includes("w") ? -1 : 0;
  const sy = handle.includes("s") ? 1 : handle.includes("n") ? -1 : 0;
  const twice = o.center ? 2 : 1;
  let w = sx ? Math.max(min, l.w + sx * (dx * cos + dy * sin) * twice) : l.w;
  let h = sy ? Math.max(min, l.h + sy * (dy * cos - dx * sin) * twice) : l.h;
  if (o.keep) {
    const k = sx && sy ? Math.max(w / l.w, h / l.h) : sx ? w / l.w : h / l.h;
    w = l.w * k;
    h = l.h * k;
  }
  w = whole(w);
  h = whole(h);
  // the point that stays: the opposite corner or side's middle, in half sizes from the layer's middle (0, 0 = the middle)
  const ax = o.center ? 0 : -sx;
  const ay = o.center ? 0 : -sy;
  const at = (hw: number, hh: number) => ({ x: ax * hw * cos - ay * hh * sin, y: ax * hw * sin + ay * hh * cos });
  const was = at(l.w / 2, l.h / 2);
  const now = at(w / 2, h / 2);
  return { ...l, x: whole(l.x + l.w / 2 + was.x - now.x - w / 2), y: whole(l.y + l.h / 2 + was.y - now.y - h / 2), w, h };
}

/** Several layers resized together: each keeps its place and share inside the box round them, as that box goes `from` → `to`. */
export function resizeAll<T extends Turned>(layers: readonly T[], from: Rect, to: Rect): T[] {
  const kx = to.w / (from.w || 1);
  const ky = to.h / (from.h || 1);
  return layers.map((l) => ({ ...l, x: Math.round(to.x + (l.x - from.x) * kx), y: Math.round(to.y + (l.y - from.y) * ky), w: Math.max(1, Math.round(l.w * kx)), h: Math.max(1, Math.round(l.h * ky)) }));
}

/**
 * A moving box catching on what is near: its left edge, middle and right edge against those of each target (and the
 * same down the page). Gives how far to move it to sit on the nearest line within `near`, and that line for the guide.
 */
export function snapMove(box: Rect, targets: readonly Rect[], near: number): { dx: number; dy: number; x?: number; y?: number } {
  const nearest = (from: number, size: number, lines: number[]) => {
    let hit: { d: number; line: number } | null = null;
    for (const line of lines)
      for (const mine of [from, from + size / 2, from + size]) {
        const d = line - mine;
        if (Math.abs(d) < near && (!hit || Math.abs(d) < Math.abs(hit.d))) hit = { d, line };
      }
    return hit;
  };
  const hx = nearest(box.x, box.w, targets.flatMap((t) => [t.x, t.x + t.w / 2, t.x + t.w]));
  const hy = nearest(box.y, box.h, targets.flatMap((t) => [t.y, t.y + t.h / 2, t.y + t.h]));
  return { dx: hx?.d ?? 0, dy: hy?.d ?? 0, ...(hx ? { x: hx.line } : {}), ...(hy ? { y: hy.line } : {}) };
}

/** A gap between two boxes along `axis`, to show: from `from` to `to` along it, at `at` across it. */
export interface Gap {
  axis: "x" | "y";
  from: number;
  to: number;
  at: number;
}

/**
 * A moving box catching on even spacing along one axis. Among the boxes beside it (the ones it overlaps across the
 * axis) it catches where its gaps come out equal: between its two neighbours, the same gap to each; or beside one
 * neighbour, at the gap that neighbour keeps to the next box on. Gives how far to move it to the nearest such place
 * within `near`, and the gaps that are then equal, to show; null when there is none.
 */
export function snapSpacing(box: Rect, others: readonly Rect[], near: number, axis: "x" | "y"): { d: number; gaps: Gap[] } | null {
  const [size, cross, crossSize] = axis === "x" ? (["w", "y", "h"] as const) : (["h", "x", "w"] as const);
  const end = (r: Rect) => r[axis] + r[size];
  const mid = box[axis] + box[size] / 2;
  const beside = others.filter((o) => o[cross] < box[cross] + box[crossSize] && box[cross] < o[cross] + o[crossSize]);
  // the nearest first, each way
  const before = beside.filter((o) => end(o) <= mid).sort((a, b) => end(b) - end(a));
  const after = beside.filter((o) => o[axis] >= mid).sort((a, b) => a[axis] - b[axis]);
  const [prev, prev2] = before;
  const [next, next2] = after;
  const at = box[cross] + box[crossSize] / 2;
  const gap = (from: number, to: number): Gap => ({ axis, from, to, at });
  /** Places it could sit: where its start would be, and the gaps equal there. */
  const places: { to: number; gaps: Gap[] }[] = [];
  if (prev && next) {
    const each = (next[axis] - end(prev) - box[size]) / 2;
    if (each >= 0) places.push({ to: end(prev) + each, gaps: [gap(end(prev), end(prev) + each), gap(next[axis] - each, next[axis])] });
  }
  if (prev && prev2) {
    const each = prev[axis] - end(prev2);
    if (each >= 0) places.push({ to: end(prev) + each, gaps: [gap(end(prev2), prev[axis]), gap(end(prev), end(prev) + each)] });
  }
  if (next && next2) {
    const each = next2[axis] - end(next);
    if (each >= 0) places.push({ to: next[axis] - each - box[size], gaps: [gap(next[axis] - each, next[axis]), gap(end(next), next2[axis])] });
  }
  const best = places.filter((p) => Math.abs(p.to - box[axis]) < near).sort((a, b) => Math.abs(a.to - box[axis]) - Math.abs(b.to - box[axis]))[0];
  return best ? { d: best.to - box[axis], gaps: best.gaps } : null;
}

/** Layers lined up: one layer with its page, several with the box round them. */
export function alignLayers<T extends Turned>(layers: readonly T[], how: Align, page: { w: number; h: number }): T[] {
  const to = layers.length > 1 ? boundsOf(layers) : { x: 0, y: 0, w: page.w, h: page.h };
  return layers.map((l) => {
    const b = boundsOf([l]);
    const dx = how === "left" ? to.x - b.x : how === "center" ? to.x + to.w / 2 - b.x - b.w / 2 : how === "right" ? to.x + to.w - b.x - b.w : 0;
    const dy = how === "top" ? to.y - b.y : how === "middle" ? to.y + to.h / 2 - b.y - b.h / 2 : how === "bottom" ? to.y + to.h - b.y - b.h : 0;
    return { ...l, x: round(l.x + dx), y: round(l.y + dy) };
  });
}

/** Three or more layers spaced out evenly along one axis: the first and the last stay, the gaps between become equal. */
export function distribute<T extends Turned>(layers: readonly T[], axis: "x" | "y"): T[] {
  if (layers.length < 3) return [...layers];
  const size = axis === "x" ? "w" : "h";
  const boxes = layers.map((l) => ({ l, b: boundsOf([l]) })).sort((p, q) => p.b[axis] - q.b[axis]);
  const first = boxes[0]!.b;
  const last = boxes.at(-1)!.b;
  const gap = (last[axis] + last[size] - first[axis] - boxes.reduce((n, p) => n + p.b[size], 0)) / (boxes.length - 1);
  const by = new Map<T, number>();
  let at = first[axis];
  for (const p of boxes) {
    by.set(p.l, at - p.b[axis]);
    at += p.b[size] + gap;
  }
  return layers.map((l) => ({ ...l, [axis]: round(l[axis] + (by.get(l) ?? 0)) }) as T);
}

/** `count` layer ids the page does not have yet. */
export function freshIds(page: DesignPage, count: number): string[] {
  const taken = new Set(page.layers.map((l) => l.id));
  const out: string[] = [];
  for (let n = page.layers.length + 1; out.length < count; n++) if (!taken.has(`l${n}`)) out.push(`l${n}`);
  return out;
}

/** The layers picked with a layer: every layer of its group, or itself alone. */
export const groupOf = (layers: readonly Layer[], l: Layer): string[] => (l.group ? layers.filter((x) => x.group === l.group).map((x) => x.id) : [l.id]);

/** Ids widened to whole groups: with every layer that shares a group with one of them. */
/**
 * What a box drawn across the canvas picks. A frame the box covers whole is picked itself, and so is an empty frame the
 * box touches (one with nothing in it to pick); once one frame is picked, every other frame the box touches is picked
 * with it and not opened. With no frame picked, the layers the box touches are: those of the frame it began on (`home`)
 * when it touches any there, else those of the first frame it touches any in (picked layers are always of one frame).
 * `deep` (⌘ held): never a frame, always the layers.
 */
export function boxPick(frames: readonly { rect: Rect; layers: readonly Layer[] }[], box: Rect, o: { home: number; deep?: boolean }): { frames: number[] } | { at: number; layers: string[] } | null {
  const touched = frames.map((_, k) => k).filter((k) => intersects(frames[k]!.rect, box));
  const pickable = (l: Layer) => !l.hidden && !l.locked;
  const covered = (f: Rect) => f.x >= box.x && f.y >= box.y && f.x + f.w <= box.x + box.w && f.y + f.h <= box.y + box.h;
  if (!o.deep && touched.some((k) => covered(frames[k]!.rect) || !frames[k]!.layers.some(pickable))) return { frames: touched };
  for (const k of [o.home, ...touched.filter((n) => n !== o.home)]) {
    const f = frames[k];
    if (!f) continue;
    const inFrame = { ...box, x: box.x - f.rect.x, y: box.y - f.rect.y };
    const layers = f.layers.filter((l) => pickable(l) && intersects(boundsOf([l]), inFrame)).map((l) => l.id);
    if (layers.length) return { at: k, layers };
  }
  return null;
}

export function withGroups(layers: readonly Layer[], ids: readonly string[]): string[] {
  const groups = new Set(layers.filter((l) => l.group && ids.includes(l.id)).map((l) => l.group));
  return layers.filter((l) => ids.includes(l.id) || (l.group && groups.has(l.group))).map((l) => l.id);
}

/** A group id these layers do not use yet (nor any in `also`). */
export function freshGroup(layers: readonly Layer[], also: readonly string[] = []): string {
  const taken = new Set([...layers.map((l) => l.group), ...also]);
  for (let n = 1; ; n++) if (!taken.has(`g${n}`)) return `g${n}`;
}

/**
 * Layers coming into a frame (pasted, copied, dragged in from another frame): a group of theirs whose id the frame
 * already uses gets an id of its own, so they stay a group among themselves and do not join the one that is there.
 */
export function regroup<T extends Layer>(coming: readonly T[], there: readonly Layer[]): T[] {
  const taken = new Set(there.map((l) => l.group));
  const renamed = new Map<string, string>();
  return coming.map((l) => {
    if (!l.group || !taken.has(l.group)) return l;
    if (!renamed.has(l.group)) renamed.set(l.group, freshGroup(there, [...renamed.values(), ...coming.map((c) => c.group ?? "")]));
    return { ...l, group: renamed.get(l.group)! };
  });
}

export const SHAPE_NAMES = { rect: "Rectangle", ellipse: "Ellipse", triangle: "Triangle", star: "Star", arrow: "Arrow" } as const;
/** What the layers list calls a layer: its own name, or what it is. */
export const layerName = (l: Layer): string => l.name ?? (l.type === "text" ? l.text.replace(/\s+/g, " ").slice(0, 40) : l.type === "image" ? "Picture" : l.type === "drawing" ? "Drawing" : l.type === "path" ? "Path" : SHAPE_NAMES[l.shape]);
export const pageName = (p: DesignPage, k: number): string => p.name ?? `Frame ${k + 1}`;

/**
 * A frame as the server has it now (`theirs`) and as this window changed it meanwhile (`mine`, from `base`): what was
 * changed here stays, everything else is the server's. So a frame dragged aside while its layers were designed
 * somewhere else keeps both its new place and its new layers.
 * ponytail: the layers are one thing; both sides changing the same frame's layers keeps this window's. Layer by layer when that bites.
 */
export function mergeFrame(mine: DesignPage, base: DesignPage | undefined, theirs: DesignPage): DesignPage {
  if (!base) return mine;
  const out: Record<string, unknown> = { ...theirs };
  for (const f of ["name", "x", "y", "w", "h", "background", "gradient", "layers"] as const) {
    if (JSON.stringify(mine[f]) === JSON.stringify(base[f])) continue;
    if (mine[f] === undefined) delete out[f];
    else out[f] = mine[f];
  }
  return out as unknown as DesignPage;
}

/**
 * A design's frames as the server has them now (`theirs`), with what this window did since it last agreed with the
 * server (`base` → `mine`) done to them again: a frame changed here keeps that change (mergeFrame), one made here is
 * there, one deleted here stays deleted, and the order is this window's when it reordered them.
 */
export function mergeFrames(mine: readonly DesignPage[], base: readonly DesignPage[], theirs: readonly DesignPage[]): DesignPage[] {
  const baseOf = new Map(base.map((p) => [p.id, p]));
  const mineOf = new Map(mine.map((p) => [p.id, p]));
  const kept = theirs.filter((p) => mineOf.has(p.id) || !baseOf.has(p.id)).map((p) => (mineOf.has(p.id) ? mergeFrame(mineOf.get(p.id)!, baseOf.get(p.id), p) : p));
  const made = mine.filter((p) => !baseOf.has(p.id) && !theirs.some((t) => t.id === p.id));
  const all = [...kept, ...made];
  // reordered here: the frames both sides have go in this window's order, the others stay where they are
  const common = (list: readonly DesignPage[]) => list.filter((p) => baseOf.has(p.id) && mineOf.has(p.id)).map((p) => p.id);
  if (common(mine).join() === common(base).join()) return all;
  const order = common(mine).filter((id) => all.some((p) => p.id === id));
  const byId = new Map(all.map((p) => [p.id, p]));
  let n = 0;
  return all.map((p) => (order.includes(p.id) ? byId.get(order[n++]!)! : p));
}
