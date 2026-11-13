import type { PathLayer, PathPoint } from "@contracts/design";
import type { Rect } from "./hands";

/**
 * A path layer's line, as plain functions: the curve between its anchors, the box that holds it, and what the pen
 * and the hands on its anchors do to it. A path's points are kept in parts of its layer's box (0 to 1 each way), so
 * the box's place, size and rotation are the layer's like any other's and resizing the box resizes the line. The
 * hands work in pixels of that box (`inPixels`), and `refit` brings the result back: the box drawn close round the
 * line again, with every point where it was on the canvas.
 */

type Pair = [number, number];
/** A point of a path in pixels: where the line passes, and how far from there each handle ends (none: a corner). */
export type Anchor = PathPoint;

const add = (a: Pair, b: Pair | undefined): Pair => (b ? [a[0] + b[0], a[1] + b[1]] : a);

/** The curve from each anchor to the next (and from the last back to the first, closed): its start, two control points and end. */
export function segments(points: readonly Anchor[], closed: boolean): [Pair, Pair, Pair, Pair][] {
  const out: [Pair, Pair, Pair, Pair][] = [];
  for (let n = 0; n < points.length - (closed ? 0 : 1); n++) {
    const a = points[n]!;
    const b = points[(n + 1) % points.length]!;
    out.push([[a.x, a.y], add([a.x, a.y], a.out), add([b.x, b.y], b.in), [b.x, b.y]]);
  }
  return out;
}

/** The path added to a canvas's path under way, its points taken times `w` and `h` (1 and 1 for points in pixels). */
export function tracePath(ctx: Pick<CanvasRenderingContext2D, "moveTo" | "lineTo" | "bezierCurveTo" | "closePath">, points: readonly Anchor[], closed: boolean, w = 1, h = 1): void {
  if (!points.length) return;
  ctx.moveTo(points[0]!.x * w, points[0]!.y * h);
  for (const [a, c1, c2, b] of segments(points, closed)) {
    // a stretch with no handle at either end is a straight line
    if (c1[0] === a[0] && c1[1] === a[1] && c2[0] === b[0] && c2[1] === b[1]) ctx.lineTo(b[0] * w, b[1] * h);
    else ctx.bezierCurveTo(c1[0] * w, c1[1] * h, c2[0] * w, c2[1] * h, b[0] * w, b[1] * h);
  }
  if (closed) ctx.closePath();
}

/** The same as an SVG path, each point through `at` (to the screen, say). */
export function svgPath(points: readonly Anchor[], closed: boolean, at: (x: number, y: number) => Pair): string {
  if (!points.length) return "";
  const p = (q: Pair) => at(q[0], q[1]).map((n) => Math.round(n * 100) / 100).join(" ");
  return `M ${p([points[0]!.x, points[0]!.y])} ${segments(points, closed).map(([, c1, c2, b]) => `C ${p(c1)} ${p(c2)} ${p(b)}`).join(" ")}${closed ? " Z" : ""}`;
}

/** The box close round the line itself: its anchors, and where a curve swings furthest out between them (not its handles' ends). */
export function pathBounds(points: readonly Anchor[], closed: boolean): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const take = (x: number, y: number) => {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  };
  for (const p of points) take(p.x, p.y);
  for (const [a, c1, c2, b] of segments(points, closed)) {
    for (const k of [0, 1] as const) {
      // where the curve turns back along this axis: the roots of its derivative, a quadratic in t
      const qa = -a[k] + 3 * c1[k] - 3 * c2[k] + b[k];
      const qb = 2 * (a[k] - 2 * c1[k] + c2[k]);
      const qc = c1[k] - a[k];
      const roots = Math.abs(qa) < 1e-9 ? (Math.abs(qb) < 1e-9 ? [] : [-qc / qb]) : [1, -1].map((s) => (-qb + s * Math.sqrt(Math.max(0, qb * qb - 4 * qa * qc))) / (2 * qa)).filter(() => qb * qb - 4 * qa * qc >= 0);
      for (const t of roots) {
        if (t <= 0 || t >= 1) continue;
        const u = 1 - t;
        const at = (j: 0 | 1) => u * u * u * a[j] + 3 * u * u * t * c1[j] + 3 * u * t * t * c2[j] + t * t * t * b[j];
        take(at(0), at(1));
      }
    }
  }
  return points.length ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 0, h: 0 };
}

/** A layer's points in pixels of its box. */
export const inPixels = (l: Pick<PathLayer, "points" | "w" | "h">): Anchor[] =>
  l.points.map((p) => ({ x: p.x * l.w, y: p.y * l.h, ...(p.in ? { in: [p.in[0] * l.w, p.in[1] * l.h] as Pair } : {}), ...(p.out ? { out: [p.out[0] * l.w, p.out[1] * l.h] as Pair } : {}) }));

const part = (n: number) => Math.round(n * 1e5) / 1e5;

/** Points in pixels as a box close round them and the points in parts of it. A line with no height (or width) gets a box 1 pixel high (wide). */
export function fitPath(px: readonly Anchor[], closed: boolean): { box: Rect; points: PathPoint[] } {
  const b = pathBounds(px, closed);
  const w = Math.max(1, b.w);
  const h = Math.max(1, b.h);
  const points = px.map((p) => ({ x: part((p.x - b.x) / w), y: part((p.y - b.y) / h), ...(p.in ? { in: [part(p.in[0] / w), part(p.in[1] / h)] as Pair } : {}), ...(p.out ? { out: [part(p.out[0] / w), part(p.out[1] / h)] as Pair } : {}) }));
  return { box: { x: b.x, y: b.y, w, h }, points };
}

type Placed = Pick<PathLayer, "x" | "y" | "w" | "h" | "rotate" | "flipX" | "flipY">;
/** A point of the layer's own box (pixels from its top left) as a point of its frame, through the layer's flips and rotation; and back. */
export function toFrame(l: Placed, x: number, y: number): Pair {
  const a = ((l.rotate ?? 0) * Math.PI) / 180;
  const vx = (x - l.w / 2) * (l.flipX ? -1 : 1);
  const vy = (y - l.h / 2) * (l.flipY ? -1 : 1);
  return [l.x + l.w / 2 + vx * Math.cos(a) - vy * Math.sin(a), l.y + l.h / 2 + vx * Math.sin(a) + vy * Math.cos(a)];
}
export function toBox(l: Placed, x: number, y: number): Pair {
  const a = (-(l.rotate ?? 0) * Math.PI) / 180;
  const dx = x - (l.x + l.w / 2);
  const dy = y - (l.y + l.h / 2);
  return [(dx * Math.cos(a) - dy * Math.sin(a)) * (l.flipX ? -1 : 1) + l.w / 2, (dx * Math.sin(a) + dy * Math.cos(a)) * (l.flipY ? -1 : 1) + l.h / 2];
}

/**
 * The layer with its line changed to `px` (points in pixels of the box it has now): its box drawn close round the
 * new line, and every point of it where it is on the canvas, whatever the layer is turned or flipped by.
 */
export function refit<T extends PathLayer>(l: T, px: readonly Anchor[]): T {
  const { box, points } = fitPath(px, !!l.closed);
  // the new box's middle, as a point of the frame
  const [cx, cy] = toFrame(l, box.x + box.w / 2, box.y + box.h / 2);
  const whole = (n: number) => Math.round(n * 100) / 100;
  return { ...l, x: whole(cx - box.w / 2), y: whole(cy - box.h / 2), w: whole(box.w), h: whole(box.h), points };
}

/**
 * A handle of an anchor dragged to `to` (how far from the anchor). The handle across from it turns to stay in line
 * with it and keeps its own length, so the curve stays smooth through the anchor; `free` leaves it where it is (a
 * corner with two handles).
 */
export function dragHandle(p: Anchor, which: "in" | "out", to: Pair, free = false): Anchor {
  const other = which === "in" ? "out" : "in";
  const across = p[other];
  const long = Math.hypot(to[0], to[1]);
  if (free || !across || !long) return { ...p, [which]: to };
  const keep = Math.hypot(across[0], across[1]);
  return { ...p, [which]: to, [other]: [(-to[0] / long) * keep, (-to[1] / long) * keep] };
}

/**
 * An anchor made a corner (its handles taken off) when it has any, or smooth when it has none: handles along the line
 * from the anchor before it to the one after, each a third of the way to its own neighbour.
 */
export function toggleSmooth(points: readonly Anchor[], n: number, closed: boolean): Anchor[] {
  const p = points[n];
  if (!p) return [...points];
  if (p.in || p.out) return points.map((q, k) => (k === n ? { x: q.x, y: q.y } : q));
  const before = points[n - 1] ?? (closed ? points.at(-1) : undefined);
  const after = points[n + 1] ?? (closed ? points[0] : undefined);
  if (!before || !after || before === p || after === p) return [...points];
  const dx = after.x - before.x;
  const dy = after.y - before.y;
  const long = Math.hypot(dx, dy) || 1;
  const reach = (q: Anchor) => Math.hypot(q.x - p.x, q.y - p.y) / 3;
  return points.map((q, k) => (k === n ? { ...q, in: [(-dx / long) * reach(before), (-dy / long) * reach(before)] as Pair, out: [(dx / long) * reach(after), (dy / long) * reach(after)] as Pair } : q));
}

/**
 * Whether a point of the frame is on the path: on its line (within `near` pixels, or the line's own width), or inside
 * it when it is filled. The box round a path is mostly empty, so a press in it elsewhere goes to what lies under.
 */
export function onPath(l: PathLayer, x: number, y: number, near = 8): boolean {
  const [bx, by] = toBox(l, x, y);
  const reach = Math.max(near, (l.stroke?.width ?? 0) / 2 + 2);
  if (bx < -reach || by < -reach || bx > l.w + reach || by > l.h + reach) return false;
  // the line as short straight pieces: each stretch in sixteen
  const pts: Pair[] = [];
  for (const [a, c1, c2, b] of segments(inPixels(l), !!l.closed)) {
    for (let k = pts.length ? 1 : 0; k <= 16; k++) {
      const t = k / 16;
      const u = 1 - t;
      pts.push([u * u * u * a[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * b[0], u * u * u * a[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * b[1]]);
    }
  }
  for (let n = 1; n < pts.length; n++) {
    const [x0, y0] = pts[n - 1]!;
    const [x1, y1] = pts[n]!;
    const long = (x1 - x0) ** 2 + (y1 - y0) ** 2;
    const t = long ? Math.min(1, Math.max(0, ((bx - x0) * (x1 - x0) + (by - y0) * (y1 - y0)) / long)) : 0;
    if (Math.hypot(bx - (x0 + t * (x1 - x0)), by - (y0 + t * (y1 - y0))) <= reach) return true;
  }
  if (!l.fill) return false;
  // inside: a line from the point to the right crosses the outline an odd number of times (an open line closed the way its fill is)
  let inside = false;
  for (let n = 0, m = pts.length - 1; n < pts.length; m = n++) {
    const [xi, yi] = pts[n]!;
    const [xj, yj] = pts[m]!;
    if (yi > by !== yj > by && bx < ((xj - xi) * (by - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** What the pointer is on, of a path's anchors and the picked anchor's handle ends, within `near` pixels: a handle before an anchor (it lies over it when it is short). */
export function pathHit(points: readonly Anchor[], picked: number | null, x: number, y: number, near: number): { anchor: number; handle?: "in" | "out" } | null {
  const close = (px: number, py: number) => Math.hypot(px - x, py - y) <= near;
  const p = picked === null ? undefined : points[picked];
  if (p) for (const which of ["out", "in"] as const) if (p[which] && close(p.x + p[which]![0], p.y + p[which]![1])) return { anchor: picked!, handle: which };
  const n = points.findIndex((q) => close(q.x, q.y));
  return n < 0 ? null : { anchor: n };
}
