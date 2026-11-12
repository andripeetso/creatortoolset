import type { DesignPage, Layer } from "@contracts/design";

/**
 * What the hands on the canvas work out, as plain functions: where the pages lie, the view (pan and zoom), a layer's
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

/** The pages lie in a row on the canvas, this many design pixels apart. */
export const PAGE_GAP = 120;
export const pageLeft = (k: number, width: number): number => k * (width + PAGE_GAP);
export const ZOOM = { min: 0.02, max: 32 } as const;
const zoomIn = (z: number) => Math.min(ZOOM.max, Math.max(ZOOM.min, z));
const round = (n: number) => Math.round(n * 100) / 100;

/** The view at zoom `z`, with the canvas point under the screen point (sx, sy) still under it. */
export function zoomAt(v: View, z: number, sx: number, sy: number): View {
  const k = zoomIn(z);
  return { z: k, x: sx - ((sx - v.x) / v.z) * k, y: sy - ((sy - v.y) / v.z) * k };
}

/** The view that shows `box` whole, in the middle of the room. */
export function fitView(box: Rect, room: { w: number; h: number }, pad = 56): View {
  const z = zoomIn(Math.min(Math.max(1, room.w - 2 * pad) / box.w, Math.max(1, room.h - 2 * pad) / box.h));
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

/** What the layers list calls a layer: its own name, or what it is. */
export const layerName = (l: Layer): string => l.name ?? (l.type === "text" ? l.text.replace(/\s+/g, " ").slice(0, 40) : l.type === "image" ? "Picture" : l.type === "drawing" ? "Drawing" : l.shape === "ellipse" ? "Ellipse" : "Rectangle");
export const pageName = (p: DesignPage, k: number): string => p.name ?? `Page ${k + 1}`;
