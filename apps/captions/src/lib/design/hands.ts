import { DESIGN_GAP, DESIGN_LIMITS, type DesignPage, type DesignStyles, type Layer, type PathLayer } from "@contracts/design";
import { effectsOf, reachOf } from "./effects";
import { strokesOf } from "./paint";
import { fitContents } from "./resize";
import { boundsOf, everyLayer, findLayer, freshLayerIds, isGroup, layerOut, mapLayers, nextOf, outOf, parentOf, same, seenBox, stable } from "./tree";
import { pathBounds } from "./path";
import { syncInstances } from "./components";
import { mergeStyles, styled } from "./styles";

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
export const ZOOM = { min: 0.02, max: 256 } as const;
const zoomIn = (z: number) => Math.min(ZOOM.max, Math.max(ZOOM.min, z));
const round = (n: number) => Math.round(n * 100) / 100;

/** The view at zoom `z`, with the canvas point under the screen point (sx, sy) still under it. */
export function zoomAt(v: View, z: number, sx: number, sy: number): View {
  const k = zoomIn(z);
  return { z: k, x: sx - ((sx - v.x) / v.z) * k, y: sy - ((sy - v.y) / v.z) * k };
}

/** The view that shows `box` whole, in the middle of the room, zoomed in no further than `most`. */
export function fitView(box: Rect, room: { w: number; h: number }, pad: number | { x: number; top: number; bottom: number } = 56, most: number = ZOOM.max): View {
  const p = typeof pad === "number" ? { x: pad, top: pad, bottom: pad } : pad;
  const tall = room.h - p.top - p.bottom;
  const z = zoomIn(Math.min(most, Math.max(1, room.w - 2 * p.x) / Math.max(box.w, 1e-6), Math.max(1, tall) / Math.max(box.h, 1e-6)));
  return { z, x: (room.w - box.w * z) / 2 - box.x * z, y: p.top + (tall - box.h * z) / 2 - box.y * z };
}

export { boundsOf };

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
  return withContents(l, { ...l, x: whole(l.x + l.w / 2 + was.x - now.x - w / 2), y: whole(l.y + l.h / 2 + was.y - now.y - h / 2), w, h });
}
/** A container's layers following its new size (resize.ts fitContents); anything else as it is. */
const withContents = <T extends Turned>(was: T, now: T): T => ("type" in now && now.type === "group" ? (fitContents(was as unknown as Layer, now as unknown as Layer) as unknown as T) : now);

/** Several layers resized together: each keeps its place and share inside the box round them, as that box goes `from` → `to`. */
export function resizeAll<T extends Turned>(layers: readonly T[], from: Rect, to: Rect): T[] {
  const kx = to.w / (from.w || 1);
  const ky = to.h / (from.h || 1);
  return layers.map((l) => withContents(l, { ...l, x: Math.round(to.x + (l.x - from.x) * kx), y: Math.round(to.y + (l.y - from.y) * ky), w: Math.max(1, Math.round(l.w * kx)), h: Math.max(1, Math.round(l.h * ky)) }));
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

/** Layers lined up: one layer with its page (or the box it lies in, `x`/`y` given), several with the box round them. */
export function alignLayers<T extends Turned>(layers: readonly T[], how: Align, page: { x?: number; y?: number; w: number; h: number }): T[] {
  const to = layers.length > 1 ? boundsOf(layers) : { x: page.x ?? 0, y: page.y ?? 0, w: page.w, h: page.h };
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
/** Ids the frame never had: past its `next` too, so one taken out is never given again (tree.ts nextOf). */
export const freshIds = (page: DesignPage, count: number): string[] => freshLayerIds(page.layers, count, [], page.next);

/** The layers picked with a layer: every layer of its group, or itself alone. */
export const groupOf = (layers: readonly Layer[], l: Layer): string[] => {
  const all = l.group ? layers.filter((x) => x.group === l.group).map((x) => x.id) : [];
  return all.length ? all : [l.id];
};

/** Ids widened to whole groups: with every layer that shares a group with one of them. */
/**
 * What a box drawn across the canvas picks. A frame the box covers whole is picked itself, and so is an empty frame the
 * box touches (one with nothing in it to pick); once one frame is picked, every other frame the box touches is picked
 * with it and not opened. With no frame picked, the layers the box touches are: those of the frame it began on (`home`)
 * when it touches any there, else those of the first frame it touches any in (picked layers are always of one frame).
 * `deep` (⌘ held): never a frame, always the layers.
 */
export function boxPick(frames: readonly { rect: Rect; layers: readonly Layer[]; reach?: Rect }[], box: Rect, o: { home: number; deep?: boolean }): { frames: number[] } | { at: number; layers: string[] } | null {
  // `reach`: where a frame shows on the canvas (one that does not clip: its layers past its edges too); its layers are touched there
  const touched = frames.map((_, k) => k).filter((k) => intersects(frames[k]!.reach ?? frames[k]!.rect, box));
  const onFrame = (k: number) => intersects(frames[k]!.rect, box);
  const pickable = (l: Layer) => !l.hidden && !l.locked;
  const covered = (f: Rect) => f.x >= box.x && f.y >= box.y && f.x + f.w <= box.x + box.w && f.y + f.h <= box.y + box.h;
  if (!o.deep && touched.some((k) => onFrame(k) && (covered(frames[k]!.rect) || !frames[k]!.layers.some(pickable)))) return { frames: touched.filter(onFrame) };
  for (const k of [o.home, ...touched.filter((n) => n !== o.home)]) {
    const f = frames[k];
    if (!f) continue;
    const inFrame = { ...box, x: box.x - f.rect.x, y: box.y - f.rect.y };
    // a layer a mask cuts is touched where it is seen
    const layers = f.layers.filter((l) => pickable(l) && intersects(seenBox(f.layers, l), inFrame)).map((l) => l.id);
    if (layers.length) return { at: k, layers };
  }
  return null;
}

export function withGroups(layers: readonly Layer[], ids: readonly string[]): string[] {
  const groups = new Set(layers.filter((l) => l.group && ids.includes(l.id)).map((l) => l.group));
  return layers.filter((l) => ids.includes(l.id) || (l.group && groups.has(l.group))).map((l) => l.id);
}

/** A group id these layers do not use yet (nor any in `also`). */
/**
 * A group's own name, as the layers list and the panel say it: the name its maker gave it ("palm-trees" reads "Palm
 * trees"). A group made by hand (⌘G: g1, g2 …) has none.
 */
export const groupName = (id: string | undefined): string | null => (!id || /^g\d+$/.test(id) ? null : id.replace(/-+/g, " ").replace(/^./, (c) => c.toUpperCase()));

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
/** What each way of combining shapes is called (contracts/design.ts GroupLayer `boolean`). */
export const BOOLEAN_NAMES = { union: "Union", subtract: "Subtract", intersect: "Intersect", exclude: "Exclude" } as const;
export const layerName = (l: Layer): string => l.name ?? (l.type === "text" ? l.text.replace(/\s+/g, " ").slice(0, 40) : l.type === "image" ? "Picture" : l.type === "drawing" ? "Drawing" : l.type === "path" ? "Path" : l.type === "group" ? (l.box ? "Frame" : l.boolean ? BOOLEAN_NAMES[l.boolean] : "Group") : SHAPE_NAMES[l.shape]);
export const pageName = (p: DesignPage, k: number): string => p.name ?? `Frame ${k + 1}`;

/**
 * Pictures lying loose on the canvas, each kept to the box round its layers (a picture moved, resized or turned takes
 * its box with it, so nothing of it is ever cut off); one with no layer left is gone (`drop` false: kept). Loose pictures come after the frames. The pages themselves when none
 * changed.
 */
export function hugLoose(pages: DesignPage[], drop = true): DesignPage[] {
  let changed = false;
  const out: DesignPage[] = [];
  for (const p of pages) {
    if (!p.loose) {
      out.push(p);
      continue;
    }
    if (!p.layers.length) {
      if (drop) changed = true;
      else out.push(p);
      continue;
    }
    const b = boundsOf(p.layers);
    const x = Math.floor(b.x);
    const y = Math.floor(b.y);
    const w = Math.min(DESIGN_LIMITS.frameMax, Math.max(DESIGN_LIMITS.frameMin, Math.ceil(b.x + b.w) - x));
    const h = Math.min(DESIGN_LIMITS.frameMax, Math.max(DESIGN_LIMITS.frameMin, Math.ceil(b.y + b.h) - y));
    if (!x && !y && w === p.w && h === p.h) {
      out.push(p);
      continue;
    }
    changed = true;
    out.push({ ...p, x: (p.x ?? 0) + x, y: (p.y ?? 0) + y, w, h, layers: p.layers.map((l) => ({ ...l, x: l.x - x, y: l.y - y })) });
  }
  // loose pictures after the frames: a frame's place in the list is its number, and loose pictures lie over the frames
  const sorted = [...out.filter((p) => !p.loose), ...out.filter((p) => p.loose)];
  return changed || sorted.some((p, n) => p !== out[n]) ? sorted : pages;
}


/**
 * Where layers dragged out of frame `k` land, by the box they cover on the canvas now: the frame under their middle
 * (the later of two that lie over each other; a loose piece is no frame to land in, and one that is `full` keeps them
 * out); else, lying wholly off the frame they came from, loose on the canvas (-1); else (partly on it still, or a
 * loose piece moved about) where they were.
 */
export function dropTarget(frames: readonly { rect: Rect; loose?: boolean; full?: boolean }[], k: number, moved: Rect): number {
  const mx = moved.x + moved.w / 2;
  const my = moved.y + moved.h / 2;
  const over = frames.map((f) => !f.loose && mx >= f.rect.x && mx <= f.rect.x + f.rect.w && my >= f.rect.y && my <= f.rect.y + f.rect.h).lastIndexOf(true);
  if (over >= 0) return over === k || !frames[over]!.full ? over : k;
  const home = frames[k]!;
  const touches = moved.x < home.rect.x + home.rect.w && moved.x + moved.w > home.rect.x && moved.y < home.rect.y + home.rect.h && moved.y + moved.h > home.rect.y;
  return home.loose || touches ? k : -1;
}

/** Layers from a place on the canvas (`from`: their frame's top left corner, 0, 0 for the canvas itself) to another, where they stay on the canvas. */
export const rehome = <L extends { x: number; y: number }>(layers: readonly L[], from: { x?: number; y?: number }, to: { x?: number; y?: number }): L[] =>
  layers.map((l) => ({ ...l, x: l.x + (from.x ?? 0) - (to.x ?? 0), y: l.y + (from.y ?? 0) - (to.y ?? 0) }));

/**
 * Everything a layer paints, in its frame's pixels: its box (turned), and past it its lines (an outside or mitred one,
 * a line's heads), its blurs and its shadows (each where it falls, as soft as its blur). Generous: a few pixels too
 * many cost nothing, one too few cuts a shadow off in a square.
 */
/** A path's box and where its curves swing past it (handles pulled far out), through its turn. */
function curveBox(l: PathLayer): Rect {
  const c = pathBounds(l.points, !!l.closed);
  const xs = [Math.min(0, c.x), Math.max(1, c.x + c.w)].map((v) => v * l.w);
  const ys = [Math.min(0, c.y), Math.max(1, c.y + c.h)].map((v) => v * l.h);
  const at = xs.flatMap((x) => ys.map((y) => outOf(l, { x, y })));
  const x0 = Math.min(...at.map((p) => p.x));
  const y0 = Math.min(...at.map((p) => p.y));
  return { x: x0, y: y0, w: Math.max(...at.map((p) => p.x)) - x0, h: Math.max(...at.map((p) => p.y)) - y0 };
}

export function paintedBox(l: Layer): Rect {
  // a container paints its layers too (through its turn), past its box unless it cuts them there
  const b = isGroup(l) && !(l.box && l.clip) && l.layers.some((k) => !k.hidden) ? boundsOf([l, ...l.layers.filter((k) => !k.hidden).map((k) => layerOut(l, paintedBox(k)))]) : l.type === "path" ? curveBox(l) : boundsOf([l]);
  const fx = effectsOf(l).filter((e) => !e.hidden);
  const lines = Math.max(0, ...strokesOf(l).map((s) => Math.max(s.width, ...(s.sides ?? [])) * (s.join === "miter" ? 5 : 1) + (s.start || s.end ? Math.max(s.width, 2) * 5 : 0)));
  // words may run a little past their box, and sticker letters by their outline
  const grow = lines + reachOf(fx) + (l.type === "text" ? l.size * 0.3 : 0);
  let x0 = b.x - grow;
  let y0 = b.y - grow;
  let x1 = b.x + b.w + grow;
  let y1 = b.y + b.h + grow;
  for (const e of fx) {
    if (e.type !== "shadow") continue;
    const r = grow + e.blur * 1.5 + Math.max(0, e.spread ?? 0);
    x0 = Math.min(x0, b.x + e.x - r);
    y0 = Math.min(y0, b.y + e.y - r);
    x1 = Math.max(x1, b.x + b.w + e.x + r);
    y1 = Math.max(y1, b.y + b.h + e.y + r);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * A frame's layers while the words of layer `id` are typed in the box over it: that layer left out, but for a mask and
 * a part of a combined shape (they shape what is drawn: left out, a photo cut to the words would show whole).
 */
export function withoutTyped(layers: readonly Layer[], id: string): Layer[] {
  if (findLayer(layers, id)?.mask || parentOf(layers, id)?.boolean) return layers as Layer[];
  return mapLayers(layers, (l) => (l.id === id ? null : l));
}

/**
 * What of a frame shows on the canvas, in its own pixels, on whole pixels: the frame itself when it clips its layers;
 * else (a frame with Clip content off, a loose piece) the frame and all its layers paint, shadows and lines too.
 */
export function shownArea(p: DesignPage, w: number, h: number): Rect {
  const out = p.loose || p.clip === false ? p.layers.filter((l) => !l.hidden).map(paintedBox) : [];
  if (!out.length) return { x: 0, y: 0, w, h };
  const x = Math.floor(Math.min(0, ...out.map((r) => r.x)));
  const y = Math.floor(Math.min(0, ...out.map((r) => r.y)));
  return { x, y, w: Math.ceil(Math.max(w, ...out.map((r) => r.x + r.w))) - x, h: Math.ceil(Math.max(h, ...out.map((r) => r.y + r.h))) - y };
}

/** Whether the pointer moving over the canvas looks for a layer to hover: never mid-drag (a button down), with another tool or Space held, so a drag does no hit test on every move. */
export const hovers = (buttons: number, tool: string, space: boolean) => !buttons && tool === "move" && !space;

/**
 * A save of this window's still on its way (no answer yet): the frames it sent, and the frames this window had from the
 * server as it sent them (what it was a change of). The server may have it without this window knowing (a reply that
 * never came): where the server has a layer or a frame as the save left it (as it sent it, or taken out of what it was
 * sent on), that is what this window last agreed with, so what it did since (an undo too) is its own.
 */
export interface SentSave {
  pages: readonly DesignPage[];
  base: readonly DesignPage[];
}
/**
 * The saves on their way with one more, oldest first. shortcut: the newest SENT_MAX (a long time with replies lost);
 * an older one's layers may not be in the newer (an undo, a later move), so the cap is far past what a session sends.
 */
export const SENT_MAX = 50;
export const withSent = (list: readonly SentSave[], save: SentSave): SentSave[] => [...list, save].slice(-SENT_MAX);
/**
 * Whether an answer settles a save (it is no longer on its way): refused (nothing written), an answer the server itself
 * gave (below 500: a gateway's may come after the server wrote it), or none while the browser was offline as it was
 * sent (it never left). No answer otherwise (a reply lost): it may be there.
 */
export const settles = (a: { refused?: boolean; status?: number; offline: boolean }): boolean => !!a.refused || (a.status !== undefined ? a.status < 500 : a.offline);

/** What a save says of one thing (a frame of its, a layer of a frame of its): as it was sent, taken out (its base had it), or nothing. */
type Says<T> = { has: T } | { gone: true } | null;
const says = <T>(sent: T | undefined, before: boolean): Says<T> => (sent !== undefined ? { has: sent } : before ? { gone: true } : null);
/** The newest of the saves on their way that left a thing as the server has it now: what that save says, else null. */
function agreed<T>(saves: readonly Says<T>[], theirs: T | undefined, alike: (a: T, b: T) => boolean): Says<T> {
  for (const s of [...saves].reverse()) if (s && ("gone" in s ? theirs === undefined : theirs !== undefined && alike(s.has, theirs))) return s;
  return null;
}

/**
 * A frame as the server has it now (`theirs`) and as this window changed it meanwhile (`mine`, from `base`): what was
 * changed here stays, everything else is the server's. Its fields one by one, and its layers as one tree (mergeTree).
 * `sent`: what each save still on its way says of this frame (its version, and its base's), oldest first (SentSave).
 */
export function mergeFrame(mine: DesignPage, base: DesignPage | undefined, theirs: DesignPage, sent: readonly { page?: DesignPage; base?: DesignPage }[] = []): DesignPage {
  const was = base ?? sent.find((s) => s.page)?.page;
  if (!was) return mine;
  // each field: what a save on its way left it as, where the server has it so
  const field = (f: string) => agreed(sent.map((s) => says((s.page as unknown as Rec | undefined)?.[f], !!s.page && (s.base as unknown as Rec | undefined)?.[f] !== undefined)), (theirs as unknown as Rec)[f], (a, b) => rounded(a) === rounded(b));
  const agreedBase: Rec = { ...(was as unknown as Rec) };
  for (const f of new Set([...Object.keys(theirs), ...sent.flatMap((s) => Object.keys(s.page ?? {}))])) {
    if (f === "layers" || f === "id") continue;
    const a = field(f);
    if (a) "gone" in a ? delete agreedBase[f] : (agreedBase[f] = a.has);
  }
  const out = fieldsMerged(mine, agreedBase as unknown as DesignPage, theirs);
  // ids go on from the higher of the two: none is given again (tree.ts nextOf)
  const next = Math.max(nextOf(mine), nextOf(theirs));
  const saves = sent.map((s) => ({ layers: s.page?.layers, base: s.base?.layers }));
  out.layers = !sent.length && same(theirs.layers, was.layers) ? mine.layers : !sent.length && same(mine.layers, was.layers) ? theirs.layers : mergeTree(mine.layers, was.layers, theirs.layers, saves, next, theirs);
  return next > (out.next ?? 0) && (mine.next !== undefined || theirs.next !== undefined) ? { ...out, next } : out;
}

type Rec = Record<string, unknown>;

/** A value as the server keeps it (its rounding of numbers, its order of fields): how a save come back is told. */
const rounded = (v: unknown): string => JSON.stringify(v, (_, x) => (typeof x === "number" ? Math.round(x * 100) / 100 : x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

/** Objects changed on both sides, key by key (`depth` levels down): what this window changed is its own, the rest the server's. */
function mergeKeys(m: unknown, b: unknown, t: unknown, depth: number): unknown {
  const obj = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
  if (depth <= 0 || !obj(m) || !obj(t) || (b !== undefined && !obj(b))) return m;
  const base = (b ?? {}) as Rec;
  const out: Rec = { ...t };
  for (const k of new Set([...Object.keys(m), ...Object.keys(base)])) {
    if (same(m[k], base[k])) continue;
    if (m[k] === undefined) delete out[k];
    else out[k] = same(t[k], base[k]) ? m[k] : mergeKeys(m[k], base[k], t[k], depth - 1);
  }
  return out;
}

/**
 * The fields (not the layers) of a frame or a layer changed on both sides: each one this window changed is its own,
 * every other the server's; a text's words and runs together, from the side that changed them; an instance's main,
 * values and overrides key by key (a value set here and an override set there both stay).
 */
function fieldsMerged<T extends object>(mine: T, base: T, theirs: T): T {
  const m = mine as Rec;
  const b = base as Rec;
  const t = theirs as Rec;
  const out: Rec = { ...t };
  const words = ["text", "runs"].some((f) => !same(m[f], b[f]));
  for (const f of new Set([...Object.keys(m), ...Object.keys(b), ...(words ? ["text", "runs"] : [])])) {
    if (f === "id" || f === "layers" || (same(m[f], b[f]) && !(words && (f === "text" || f === "runs")))) continue;
    if (m[f] === undefined) delete out[f];
    else out[f] = f === "instance" && !same(t[f], b[f]) ? mergeKeys(m[f], b[f], t[f], 3) : m[f];
  }
  return out as T;
}

/** Where a layer lies in a frame's tree on one side: the layer, its container (ROOT: the frame), its place there, and whether it lies in an instance (its layers are its main's). */
interface At {
  l: Layer;
  parent: string;
  n: number;
  inInstance: boolean;
}
const ROOT = "";
const PLACE = ["x", "y", "rotate", "flipX", "flipY"] as const;
function indexed(layers: readonly Layer[]): Map<string, At> {
  const out = new Map<string, At>();
  const walk = (ls: readonly Layer[], parent: string, inInstance: boolean) =>
    ls.forEach((l, n) => {
      out.set(l.id, { l, parent, n, inInstance });
      if (isGroup(l)) walk(l.layers, l.id, inInstance || !!l.instance);
    });
  walk(layers, ROOT, false);
  return out;
}
/**
 * What a layer is and where, beside how it looks: told apart from another layer whatever the server cleaned of it (words
 * and names trimmed as design-check keeps them; its place held to its frame's and rounded to hundredths as design-check
 * keeps it, `size` the frame's). `flowing`: in an auto layout, where its place is the box's, not its own.
 */
const placeOf = (v: number, side: number | undefined): number => Math.round(Math.round((side ? Math.min(2 * side, Math.max(-side, v)) : v) * 100) / 100);
const whatItIs = (l: Layer, flowing: boolean, size?: { w?: number; h?: number }): string => {
  const r = l as unknown as Rec;
  const words = typeof r.text === "string" ? r.text.replace(/\r\n/g, "\n").trim() : r.text;
  const name = typeof l.name === "string" ? l.name.replace(/\s+/g, " ").trim() : l.name;
  return stable([l.type, words, r.picture, r.shape, r.svg, name, r.component, (r.instance as { of?: string } | undefined)?.of, ...(flowing ? [] : [placeOf(l.x, size?.w), placeOf(l.y, size?.h)])]);
};
/** The containers a layer lies in on one side, innermost first. */
function* ancestors(side: ReadonlyMap<string, At>, id: string): Generator<string> {
  const seen = new Set<string>();
  for (let p = side.get(id)?.parent; p !== undefined && p !== ROOT && !seen.has(p); p = side.get(p)?.parent) (seen.add(p), yield p);
}
/** A layer's own fields, as a change by a hand is told: without its layers, and without the place an auto layout gives it. */
const ownOf = (a: At, flowing: boolean): Rec => {
  const { layers: _l, ...rest } = a.l as Layer & { layers?: Layer[] };
  if (!flowing) return rest;
  const { x: _x, y: _y, w: _w, h: _h, ...placed } = rest;
  return placed;
};

/**
 * A frame's layers changed on both sides, as one tree (every layer by its id, however deep, on all three sides): each
 * layer's fields as fieldsMerged says, and its container and place from the side that moved it (else the server's). A
 * layer either side changed since `base` is never lost: one taken out on one side and changed on the other stays, and
 * one whose container is gone (taken out, taken apart) lies where that container was. Each side's new layers are kept;
 * one both added under the same id but different is this window's under an id of its own. A layer inside an instance
 * goes with its instance (its layers are its main's: lib/design/components.ts).
 */
function mergeTree(mine0: readonly Layer[], base: readonly Layer[], theirs: readonly Layer[], sent: readonly { layers?: readonly Layer[]; base?: readonly Layer[] }[], floor = 0, size?: { w?: number; h?: number }): Layer[] {
  const T = indexed(theirs);
  const B = indexed(base);
  // each layer a save on its way left as the server has it (sent so, or taken out of what it was sent on): that is its
  // base, so what this window did since (an undo too) is its own and a layer it sent is not a second one
  if (sent.length) {
    const flowsIn = (parent: string) => {
      const p = T.get(parent)?.l;
      return isGroup(p) && !!p.box && !!p.layout;
    };
    const saves = sent.map((s) => ({ sent: indexed(s.layers ?? []), was: indexed(s.base ?? []) }));
    for (const id of new Set([...T.keys(), ...saves.flatMap((s) => [...s.sent.keys(), ...s.was.keys()])])) {
      // (a layer new to the base is the one sent by what it is — its kind, words, picture, shape, drawing, name, main — not
      // by values the server may have cleaned, a weight snapped or a size held in; another's new layer under that id differs)
      const fresh = !B.has(id);
      const a = agreed(saves.map((s) => says(s.sent.get(id), s.was.has(id))), T.get(id), (x, y) => x.parent === y.parent && (fresh ? whatItIs(x.l, flowsIn(x.parent), size) === whatItIs(y.l, flowsIn(x.parent), size) : rounded(ownOf(x, false)) === rounded(ownOf(y, false))));
      if (a) "gone" in a ? B.delete(id) : B.set(id, a.has);
    }
  }
  const mine = apart(mine0, B, T, floor);
  const M = indexed(mine);
  const flows = (side: Map<string, At>, parent: string) => {
    const p = side.get(parent)?.l;
    return isGroup(p) && !!p.box && !!p.layout;
  };
  const changed = (side: Map<string, At>, id: string) => {
    const a = side.get(id);
    const b = B.get(id);
    return !!a && !!b && (a.parent !== b.parent || !same(ownOf(a, flows(side, a.parent)), ownOf(b, flows(B, b.parent))));
  };
  // which layers stay, and each one's fields
  const kept = new Map<string, Layer>();
  for (const id of new Set([...M.keys(), ...T.keys()])) {
    const m = M.get(id);
    const t = T.get(id);
    const b = B.get(id);
    if (!b) kept.set(id, (t ?? m)!.l);
    else if (m && t) kept.set(id, same(ownOf(m, false), ownOf(b, false)) ? t.l : (fieldsMerged(m.l, b.l, t.l) as Layer));
    else if (m && !m.inInstance && changed(M, id)) kept.set(id, m.l);
    else if (t && !t.inInstance && changed(T, id)) kept.set(id, t.l);
  }
  // a container kept from one side (changed there, taken out on the other) keeps its layers of that side: none is left empty
  for (const [side, other] of [[M, T], [T, M]] as const)
    for (const [id, a] of side) if (!kept.has(id) && !other.has(id) && B.has(id) && [...ancestors(side, id)].some((p) => kept.has(p) && !other.has(p))) kept.set(id, a.l);
  // each one's container: the side that moved it (this window first), else the server's; a layer of an instance only in it
  const home = new Map<string, { parent: string; side: Map<string, At> }>();
  for (const id of kept.keys()) {
    const m = M.get(id);
    const t = T.get(id);
    const b = B.get(id);
    const side = m && (!b || m.parent !== b.parent || !t) ? M : t ? T : M;
    home.set(id, { parent: side.get(id)!.parent, side });
  }
  for (const id of home.keys()) {
    const seen = new Set<string>();
    for (let p = id; p !== ROOT && home.has(p); p = home.get(p)!.parent) {
      if (seen.has(p)) {
        // a loop: the layer of it this window moved goes where the server (or the base) has it
        const fix = [...seen].find((x) => home.get(x)!.side === M && T.has(x)) ?? [...seen].find((x) => B.has(x));
        if (fix) home.set(fix, T.has(fix) ? { parent: T.get(fix)!.parent, side: T } : { parent: B.get(fix)!.parent, side: B as Map<string, At> });
        break;
      }
      seen.add(p);
    }
  }
  const liftedFrom = new Map<string, string>();
  for (const [id, h] of home) {
    // the place in its container from the side it lies as
    const from = h.side.get(id)!.l as unknown as Rec;
    let l = { ...(kept.get(id)! as unknown as Rec) };
    const moved = (side: Map<string, At>) => side.has(id) && B.has(id) && side.get(id)!.parent !== B.get(id)!.parent;
    if (moved(M) || moved(T)) for (const f of PLACE) from[f] === undefined ? delete l[f] : (l[f] = from[f]);
    // its container gone: up to the nearest one that stays, placed as it lay through those taken away
    let parent = h.parent;
    while (parent !== ROOT && !kept.has(parent)) {
      const c = h.side.get(parent) ?? B.get(parent);
      // an instance's layers go with it
      if (!c || c.inInstance || (isGroup(c.l) && c.l.instance)) {
        l = null as unknown as Rec;
        break;
      }
      l = layerOut(c.l, l as unknown as Layer) as unknown as Rec;
      liftedFrom.set(id, parent);
      parent = c.parent;
    }
    if (!l) kept.delete(id);
    else (kept.set(id, l as unknown as Layer), home.set(id, { ...h, parent }));
  }
  // each container's layers: the server's order, this window's own where it reordered or added
  const build = (parent: string): Layer[] => {
    const ids = [...kept.keys()].filter((id) => home.get(id)!.parent === parent);
    const theirsOrder = [...T.values()].filter((a) => a.parent === parent).sort((a, b) => a.n - b.n).map((a) => a.l.id);
    const mineOrder = [...M.values()].filter((a) => a.parent === parent).sort((a, b) => a.n - b.n).map((a) => a.l.id);
    const order = theirsOrder.filter((id) => ids.includes(id));
    mineOrder.forEach((id, n) => {
      if (!ids.includes(id) || order.includes(id)) return;
      const before = mineOrder.slice(0, n).reverse().find((x) => order.includes(x));
      order.splice(before ? order.indexOf(before) + 1 : 0, 0, id);
    });
    // what came up from a container taken away: where that container lay, after what lay before it
    for (const id of ids)
      if (!order.includes(id)) {
        const via = liftedFrom.get(id);
        const side = [M, T, B].find((s) => via && s.get(via)?.parent === parent);
        const siblings = side ? [...side.values()].filter((a) => a.parent === parent).sort((a, b) => a.n - b.n).map((a) => a.l.id) : [];
        const before = siblings.slice(0, Math.max(0, siblings.indexOf(via!))).reverse().find((x) => order.includes(x));
        order.splice(before ? order.indexOf(before) + 1 : via && side ? 0 : order.length, 0, id);
      }
    // reordered here: the layers all three have go in this window's order
    const common = (list: readonly string[]) => list.filter((id) => order.includes(id) && T.get(id)?.parent === parent && B.get(id)?.parent === parent && M.get(id)?.parent === parent);
    const baseOrder = [...B.values()].filter((a) => a.parent === parent).sort((a, b) => a.n - b.n).map((a) => a.l.id);
    if (common(mineOrder).join() !== common(baseOrder).join()) {
      const mo = common(mineOrder);
      let k = 0;
      for (let i = 0; i < order.length; i++) if (mo.includes(order[i]!)) order[i] = mo[k++]!;
    }
    return order.map((id) => {
      const l = kept.get(id)!;
      return isGroup(l) ? ({ ...l, layers: build(id) } as Layer) : l;
    });
  };
  return build(ROOT);
}

/**
 * This window's layers with each that is not the server's layer of its id given an id of its own: one both sides added
 * under the same id, and one this window changed whose id the server gave a new layer of another kind. An instance's
 * layers keep its id before theirs.
 */
function apart(mine: readonly Layer[], B: ReadonlyMap<string, At>, T: ReadonlyMap<string, At>, floor: number): Layer[] {
  const all = everyLayer(mine);
  const both = all.filter((l) => {
    const t = T.get(l.id)?.l;
    const b = B.get(l.id)?.l;
    return !!t && !same(l, t) && (!b || (b.type !== t.type && !same(l, b)));
  });
  const clash = both.filter((l) => !both.some((k) => l.id.startsWith(`${k.id}.`)));
  if (!clash.length) return mine as Layer[];
  const fresh = freshLayerIds([...all, ...[...T.values()].map((a) => a.l)], clash.length, [], floor);
  const to = new Map(clash.map((l, n) => [l.id, fresh[n]!]));
  const renamed = (id: string): string => {
    const head = [...to.keys()].find((k) => id.startsWith(`${k}.`));
    return head ? to.get(head)! + id.slice(head.length) : (to.get(id) ?? id);
  };
  return mapLayers(mine, (l) => (renamed(l.id) === l.id ? l : ({ ...l, id: renamed(l.id) } as Layer)));
}

/**
 * A design's frames as the server has them now (`theirs`), with what this window did since it last agreed with the
 * server (`base` → `mine`) done to them again: a frame changed here keeps that change (mergeFrame), one made here is
 * there, one deleted here stays deleted, one the server deleted that this window changed stays, and the order is this
 * window's when it reordered them. `sent`: the saves of this window's still on its way, oldest first (SentSave): a frame
 * the server has as one of them left it is taken as agreed (made, taken out, or as it was sent).
 */
export function mergeFrames(mine: readonly DesignPage[], base0: readonly DesignPage[], theirs: readonly DesignPage[], sent: readonly SentSave[] = []): DesignPage[] {
  const theirsBy = new Map(theirs.map((p) => [p.id, p]));
  const sentOf = (id: string) => sent.map((s) => ({ page: s.pages.find((p) => p.id === id), base: s.base.find((p) => p.id === id) }));
  // the frames as this window last agreed with the server: a frame a save made or took out that the server has so, too
  const base = [...base0];
  for (const id of new Set(sent.flatMap((s) => [...s.pages, ...s.base].map((p) => p.id)))) {
    const a = agreed(sentOf(id).map((s) => says(s.page, !!s.base)), theirsBy.get(id), () => true);
    const at = base.findIndex((p) => p.id === id);
    if (a && "gone" in a && at >= 0) base.splice(at, 1);
    else if (a && "has" in a && at < 0) base.push(a.has);
  }
  const baseOf = new Map(base.map((p) => [p.id, p]));
  const mineOf = new Map(mine.map((p) => [p.id, p]));
  const theirsOf = new Set(theirs.map((p) => p.id));
  const kept = theirs.filter((p) => mineOf.has(p.id) || !baseOf.has(p.id)).map((p) => (mineOf.has(p.id) ? mergeFrame(mineOf.get(p.id)!, baseOf.get(p.id), p, sentOf(p.id)) : p));
  // made here, or changed here while the server deleted it: this window's work is never lost
  const made = mine.filter((p) => !theirsOf.has(p.id) && (!baseOf.has(p.id) || !same(p, baseOf.get(p.id))));
  const all = [...kept, ...made];
  // reordered here: the frames both sides have go in this window's order, the others stay where they are
  const common = (list: readonly DesignPage[]) => list.filter((p) => baseOf.has(p.id) && mineOf.has(p.id) && theirsOf.has(p.id)).map((p) => p.id);
  if (common(mine).join() === common(base).join()) return all;
  const order = common(mine).filter((id) => all.some((p) => p.id === id));
  const byId = new Map(all.map((p) => [p.id, p]));
  let n = 0;
  return all.map((p) => (order.includes(p.id) ? byId.get(order[n++]!)! : p));
}

/**
 * A design as this window has it (`mine`, changed from `base`) put onto the server's (`theirs`): the styles style by
 * style (mergeStyles), the frames layer by layer (mergeFrames), every style's value put on again. The three sides are
 * compared with the merged styles on each: a value a style put on a layer is no side's change of it, so a colour or size
 * the other side gave that layer (taking it off the style, or as its own) stays, and a layer one side deleted stays deleted.
 * `lay`: the base laid out as this window lays out (its widths of the words).
 */
export function mergeDesign<P extends DesignPage>(mine: { pages: readonly P[]; styles: DesignStyles }, base: { pages: readonly P[]; styles: DesignStyles }, theirs: { pages: readonly P[]; styles?: DesignStyles }, sent: readonly SentSave[] = [], lay: (pages: P[]) => P[] = (p) => p): { pages: P[]; styles: DesignStyles } {
  const styles = mergeStyles(mine.styles, base.styles, theirs.styles);
  // the merged styles on all three sides: a value a style put on a layer is no one's change of it, whichever side changed the style
  const on = (pages: readonly P[]) => lay(styled(pages, styles));
  return { pages: styled(syncInstances(mergeFrames(on(mine.pages), on(base.pages), on(theirs.pages), sent) as P[]), styles), styles };
}

