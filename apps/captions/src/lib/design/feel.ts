import { boundsOf, intersects, type Rect } from "./hands";

/**
 * How the canvas moves under the hand: the numbers that make it feel like a design app (how near a line catches,
 * how fast a number follows a drag, how fast the view runs on at its edge) and the arranging that goes with them.
 */

/** How near (in screen pixels) a line catches what is moving. */
export const SNAP_PX = 4.5;
/** How far the arrow keys pan the view when nothing is picked, in screen pixels (Shift: the far one). */
export const PAN_STEP = { near: 64, far: 320 } as const;
/** What Shift+1 and Shift+2 leave round what they fit, in screen pixels: room for the tools along the bottom. */
export const FIT_PAD = { x: 24, top: 40, bottom: 100 } as const;

/** A number's change for a drag of `px` CSS pixels along its label: `rate` a pixel, ten times with Shift, a tenth with Alt. */
export const scrubBy = (px: number, rate: number, o: { shift?: boolean; alt?: boolean } = {}): number => px * rate * (o.shift ? 10 : 1) * (o.alt ? 0.1 : 1);

/**
 * How fast the view runs on while something is dragged near the canvas's edge, in screen pixels a second: nothing
 * 15 px in or more, faster the nearer, 600 at the edge and past it. `d` is how far in from the edge the pointer is
 * (below 0 outside).
 */
export const edgeSpeed = (d: number): number => Math.min(600, Math.max(0, 40 * (15 - d)));

/** How the view's offset runs for a pointer at (x, y) in a canvas `w` by `h` on the screen, in screen pixels a second: near the left edge it grows (more of the left comes into view). */
export function edgePan(x: number, y: number, w: number, h: number): { x: number; y: number } {
  return { x: edgeSpeed(x) - edgeSpeed(w - x), y: edgeSpeed(y) - edgeSpeed(h - y) };
}

/** A turn: the angle it started at plus what was turned, in whole degrees from −180 to 180; `snap` (Shift) to the nearest 15° on the page. */
export function turnTo(start: number, by: number, snap: boolean): number {
  let r = start + by;
  if (snap) r = Math.round(r / 15) * 15;
  return Math.round((((r % 360) + 540) % 360) - 180);
}

/** The step a duplicate repeats: how far the copies moved from what they copy (their middles, on average), and the turn they all took (0 unless they agree). */
export function dupStep(from: readonly (Rect & { rotate?: number })[], to: readonly (Rect & { rotate?: number })[]): { dx: number; dy: number; turn: number } {
  if (!from.length || from.length !== to.length) return { dx: 0, dy: 0, turn: 0 };
  let dx = 0;
  let dy = 0;
  for (let n = 0; n < from.length; n++) {
    dx += to[n]!.x + to[n]!.w / 2 - from[n]!.x - from[n]!.w / 2;
    dy += to[n]!.y + to[n]!.h / 2 - from[n]!.y - from[n]!.h / 2;
  }
  const turns = from.map((f, n) => (to[n]!.rotate ?? 0) - (f.rotate ?? 0));
  return { dx: dx / from.length, dy: dy / from.length, turn: turns.every((t) => t === turns[0]) ? turns[0]! : 0 };
}

/** The gap the layers already mostly use: the commonest (a tie: the smaller), else, when every gap differs, the mean rounded half up. */
export function evenGap(gaps: readonly number[]): number {
  if (!gaps.length) return 0;
  const counts = new Map<number, number>();
  for (const g of gaps) counts.set(Math.round(g * 100) / 100, (counts.get(Math.round(g * 100) / 100) ?? 0) + 1);
  const most = Math.max(...counts.values());
  if (most > 1 || gaps.length === 1) return Math.min(...[...counts].filter(([, c]) => c === most).map(([g]) => g));
  return Math.floor(gaps.reduce((a, b) => a + b, 0) / gaps.length + 0.5);
}

type Box = Rect & { rotate?: number };
/** Groups of boxes whose ranges along `axis` overlap, one after another, in order along it. */
function bands<T>(items: readonly { t: T; b: Rect }[], axis: "x" | "y"): { t: T; b: Rect }[][] {
  const size = axis === "x" ? "w" : "h";
  const sorted = [...items].sort((p, q) => p.b[axis] - q.b[axis]);
  const out: { t: T; b: Rect }[][] = [];
  let end = -Infinity;
  for (const it of sorted) {
    const to = it.b[axis] + it.b[size];
    if (out.length && it.b[axis] < end) {
      out.at(-1)!.push(it);
      end = Math.max(end, to);
    } else {
      out.push([it]);
      end = to;
    }
  }
  return out;
}

/** The gaps between boxes one after another along `axis` (below 0 where two lie on each other). */
const gapsAlong = (sorted: readonly { b: Rect }[], axis: "x" | "y"): number[] => sorted.slice(1).map((p, n) => p.b[axis] - sorted[n]!.b[axis] - sorted[n]!.b[axis === "x" ? "w" : "h"]);

/**
 * Tidy up: three or more layers (or frames) in a row, a column or a full grid, evened out. Their order and sizes
 * stay, the first one stays put, and every gap becomes the one they mostly use (evenGap). A grid goes by the
 * direction with more lines (columns when as many), each line stacked and centred across. null when they are none
 * of those (two of them, a diagonal, a jumble, all on each other): nothing to tidy.
 */
export function tidy<T extends Box>(items: readonly T[]): T[] | null {
  if (items.length < 3) return null;
  const all = items.map((t) => ({ t, b: boundsOf([t]) }));
  const rows = bands(all, "y");
  const cols = bands(all, "x");
  const moved = new Map<T, { x: number; y: number }>();
  /** One line along `axis`: each after the one before it by the gap. Boxes of one band across it must lie on each other (else it is a jumble). */
  const line = (it: { t: T; b: Rect }[], axis: "x" | "y"): boolean => {
    const size = axis === "x" ? "w" : "h";
    const across = bands(it, axis);
    for (const band of across) for (let i = 0; i < band.length; i++) for (let j = i + 1; j < band.length; j++) if (!intersects(band[i]!.b, band[j]!.b)) return false;
    const sorted = [...it].sort((p, q) => p.b[axis] - q.b[axis]);
    const g = evenGap(gapsAlong(sorted, axis));
    let at = sorted[0]!.b[axis];
    for (const p of sorted) {
      moved.set(p.t, { ...(moved.get(p.t) ?? { x: 0, y: 0 }), [axis]: Math.round(at - p.b[axis]) });
      at += p.b[size] + g;
    }
    return true;
  };
  if (rows.length === 1 && cols.length > 1) {
    if (!line(all, "x")) return null;
  } else if (cols.length === 1 && rows.length > 1) {
    if (!line(all, "y")) return null;
  } else if (rows.length > 1 && cols.length > 1 && rows.length * cols.length === all.length && rows.every((r) => cols.every((c) => c.filter((x) => r.includes(x)).length === 1))) {
    // lines along the direction with more of them: columns (each stacked down) or rows (each across)
    const byCols = cols.length >= rows.length;
    const lines = byCols ? cols : rows;
    const axis = byCols ? "y" : "x";
    const crossAxis = byCols ? "x" : "y";
    const size = byCols ? "h" : "w";
    const cross = byCols ? "w" : "h";
    const inner = evenGap(lines.flatMap((l) => gapsAlong([...l].sort((p, q) => p.b[axis] - q.b[axis]), axis)));
    const spans = lines.map((l) => ({ from: Math.min(...l.map((p) => p.b[crossAxis])), to: Math.max(...l.map((p) => p.b[crossAxis] + p.b[cross])) }));
    const outer = evenGap(spans.slice(1).map((s, n) => s.from - spans[n]!.to));
    const start = Math.min(...all.map((p) => p.b[axis]));
    let at = spans[0]!.from;
    lines.forEach((l, n) => {
      const width = spans[n]!.to - spans[n]!.from;
      const sorted = [...l].sort((p, q) => p.b[axis] - q.b[axis]);
      let down = start;
      for (const p of sorted) {
        moved.set(p.t, { [crossAxis]: Math.round(at + (width - p.b[cross]) / 2 - p.b[crossAxis]), [axis]: Math.round(down - p.b[axis]) } as { x: number; y: number });
        down += p.b[size] + inner;
      }
      at += width + outer;
    });
  } else return null;
  return items.map((t) => {
    const d = moved.get(t) ?? { x: 0, y: 0 };
    return { ...t, x: t.x + (d.x ?? 0), y: t.y + (d.y ?? 0) };
  });
}
