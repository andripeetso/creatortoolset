import type { GradientStop, Paint, PathPoint, Stroke } from "@contracts/design";
import { segments } from "./path";

/**
 * Fills and lines drawn on a canvas, each of a list (lib/design/paint.ts) with its own visibility, opacity and blend:
 * colours, gradients of any number of stops (along an angle, from the middle, round the middle, in a diamond),
 * pictures filling, fitting, cropped or tiled, and lines with dashes, ends, corners, a width a side and heads.
 */

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Pics = Map<string, CanvasImageSource & { width: number; height: number }>;
type Style = string | CanvasGradient | CanvasPattern;
/** Where a picture that has not loaded (yet, or is gone) is: shown, so nothing is silently missing. */
const MISSING = "rgba(127,127,127,0.25)";

const byPlace = (stops: readonly GradientStop[]) => [...stops].sort((a, b) => a.at - b.at);
function addStops(g: CanvasGradient, stops: readonly GradientStop[]) {
  for (const s of byPlace(stops)) g.addColorStop(Math.min(1, Math.max(0, s.at)), s.color);
}

const newCanvas = (w: number, h: number): OffscreenCanvas | HTMLCanvasElement | null =>
  typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : typeof document !== "undefined" ? Object.assign(document.createElement("canvas"), { width: w, height: h }) : null;

/** A diamond gradient's square, kept by its stops: each quarter a straight gradient from the middle to its corner, stretched over the box when drawn. */
const DIAMOND = 256;
const diamonds = new Map<string, OffscreenCanvas | HTMLCanvasElement>();
function diamondOf(ctx: Ctx, stops: readonly GradientStop[], w: number, h: number): Style | null {
  const key = JSON.stringify(byPlace(stops));
  let tile = diamonds.get(key);
  if (!tile) {
    const c = newCanvas(DIAMOND, DIAMOND);
    const g = c?.getContext("2d") as CanvasRenderingContext2D | null;
    if (!c || !g) return null;
    const m = DIAMOND / 2;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      g.save();
      g.beginPath();
      g.rect(sx < 0 ? 0 : m, sy < 0 ? 0 : m, m, m);
      g.clip();
      const lg = g.createLinearGradient(m, m, m + sx * m, m + sy * m);
      addStops(lg, stops);
      g.fillStyle = lg;
      g.fillRect(0, 0, DIAMOND, DIAMOND);
      g.restore();
    }
    if (diamonds.size > 32) diamonds.clear();
    diamonds.set(key, (tile = c));
  }
  const pattern = ctx.createPattern(tile as CanvasImageSource, "no-repeat");
  pattern?.setTransform?.(new DOMMatrix([w / DIAMOND, 0, 0, h / DIAMOND, 0, 0]));
  return pattern;
}

/** A gradient paint across a w × h box: as long as the box is along its angle; radial and diamond reach the corners. */
function gradientOf(ctx: Ctx, p: Extract<Paint, { type: "gradient" }>, w: number, h: number): Style {
  const a = (p.angle * Math.PI) / 180;
  if (p.kind === "diamond") return diamondOf(ctx, p.stops, w, h) ?? p.stops[0]?.color ?? MISSING;
  let g: CanvasGradient;
  if (p.kind === "radial") g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.hypot(w, h) / 2);
  // a browser without round gradients draws it along the angle
  else if (p.kind === "angular" && "createConicGradient" in ctx) g = ctx.createConicGradient(a, w / 2, h / 2);
  else {
    const half = (Math.abs(Math.cos(a)) * w + Math.abs(Math.sin(a)) * h) / 2;
    g = ctx.createLinearGradient(w / 2 - Math.cos(a) * half, h / 2 - Math.sin(a) * half, w / 2 + Math.cos(a) * half, h / 2 + Math.sin(a) * half);
  }
  addStops(g, p.stops);
  return g;
}

/** Where a picture paint's picture lies in a w × h box: its scale and its top left corner. */
export function picturePlace(p: Extract<Paint, { type: "image" }>, pw: number, ph: number, w: number, h: number): { k: number; x: number; y: number } {
  if (p.mode === "tile") return { k: (w * (p.scale ?? 0.25)) / pw, x: 0, y: 0 };
  if (p.mode === "crop") {
    const c = p.crop ?? { x: 0, y: 0, w: 1, h: 1 };
    const k = Math.max(w / (c.w * pw), h / (c.h * ph));
    return { k, x: w / 2 - (c.x + c.w / 2) * pw * k, y: h / 2 - (c.y + c.h / 2) * ph * k };
  }
  const k = p.mode === "fit" ? Math.min(w / pw, h / ph) : Math.max(w / pw, h / ph);
  return { k, x: (w - pw * k) / 2, y: (h - ph * k) / 2 };
}

/** What a canvas fills with for a paint in a w × h box. */
export function styleOf(ctx: Ctx, p: Paint, w: number, h: number, loaded: Pics): Style {
  if (p.type === "solid") return p.color;
  if (p.type === "gradient") return gradientOf(ctx, p, w, h);
  const pic = loaded.get(p.picture);
  if (!pic?.width || !pic.height) return MISSING;
  const pattern = ctx.createPattern(pic, p.mode === "tile" ? "repeat" : "no-repeat");
  if (!pattern) return MISSING;
  const { k, x, y } = picturePlace(p, pic.width, pic.height, w, h);
  pattern.setTransform?.(new DOMMatrix([k, 0, 0, k, x, y]));
  return pattern;
}

/** Each shown paint of a list, bottom first, set as the canvas's fill (with its opacity and blend) while `draw` fills. */
export function fillWith(ctx: Ctx, paints: readonly Paint[], w: number, h: number, loaded: Pics, draw: () => void): void {
  for (const p of paints) {
    if (p.hidden) continue;
    ctx.save();
    ctx.globalAlpha *= p.opacity ?? 1;
    if (p.blend) ctx.globalCompositeOperation = p.blend;
    ctx.fillStyle = styleOf(ctx, p, w, h, loaded);
    draw();
    ctx.restore();
  }
}

/**
 * What throws a layer's shadow in place of its fills: one opaque fill at the strongest shown fill's opacity, so fills
 * laid over each other cast one shadow, not one each that darken together.
 */
export const castFills = (paints: readonly Paint[]): Paint[] => {
  const shown = paints.filter((p) => !p.hidden);
  return shown.length ? [{ type: "solid", color: "#000000", opacity: Math.max(...shown.map((p) => p.opacity ?? 1)) }] : [];
};

/** Each shown line of a list, bottom first, with its opacity and blend, while `draw` strokes it. `sides`: the caller draws a width a side, so a line with only those counts. */
export function eachStroke(ctx: Ctx, strokes: readonly Stroke[], draw: (s: Stroke) => void, sides = false): void {
  for (const s of strokes) {
    // a width of 0 is no line at all: a canvas told to stroke 0 wide keeps the width it had (1 at first)
    if (s.hidden || !(s.width > 0 || (sides && s.sides?.some((n) => n > 0)))) continue;
    ctx.save();
    ctx.globalAlpha *= s.opacity ?? 1;
    if (s.blend) ctx.globalCompositeOperation = s.blend;
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    draw(s);
    ctx.restore();
  }
}

/**
 * Lines along an outline (`trace` adds it to a path) in a w × h box: dashed, with their ends and corners, on one side
 * of the outline when they say so. `box`: the outline is the box's own (a rectangle, a picture, a frame), so a line
 * may have a width a side. `points`: an open path's, whose ends may have heads.
 */
export function strokeWith(ctx: Ctx, strokes: readonly Stroke[], trace: () => void, w: number, h: number, join: CanvasLineJoin, more: { box?: boolean; points?: readonly PathPoint[]; closed?: boolean } = {}): void {
  eachStroke(ctx, strokes, (s) => {
    if (s.sides && more.box) return sidesOf(ctx, s, w, h);
    ctx.beginPath();
    trace();
    ctx.lineJoin = s.join ?? join;
    ctx.lineCap = s.cap ?? (s.round ? "round" : "butt");
    if (s.dash) ctx.setLineDash(s.dash);
    if (!s.side || (more.points && !more.closed)) {
      ctx.lineWidth = s.width;
      ctx.stroke();
    } else {
      // on one side of the edge: a line twice as wide along the edge, with the half on the other side cut away
      // (inside: only what is in the shape is drawn; outside: only what is in a box round it and not in the shape)
      ctx.save();
      if (s.side === "outside") {
        const far = 2 * s.width + 10;
        ctx.beginPath();
        ctx.rect(-far, -far, w + 2 * far, h + 2 * far);
        trace();
        ctx.clip("evenodd");
      } else ctx.clip();
      ctx.beginPath();
      trace();
      ctx.lineWidth = s.width * 2;
      ctx.stroke();
      ctx.restore();
    }
    if (more.points && !more.closed && (s.start || s.end)) {
      ctx.setLineDash([]);
      heads(ctx, s, more.points, w, h);
    }
  }, !!more.box);
}

/**
 * A line a width a side round a w × h box: a bar along each side that has one, inside the edge, outside it or half on
 * each as the line's side says. The bars along the top and bottom take the corners.
 * shortcut: square corners and no dashes for lines a side; follow the corners' radius when someone rounds such a box.
 */
function sidesOf(ctx: Ctx, s: Stroke, w: number, h: number) {
  const [t, r, b, l] = s.sides!;
  // how much of each bar lies outside the edge
  const out = s.side === "outside" ? 1 : s.side === "inside" ? 0 : 0.5;
  const x0 = -l * out;
  const x1 = w + r * out;
  if (t > 0) ctx.fillRect(x0, -t * out, x1 - x0, t);
  if (b > 0) ctx.fillRect(x0, h - b * (1 - out), x1 - x0, b);
  const y0 = t * (1 - out);
  const y1 = h - b * (1 - out);
  if (l > 0) ctx.fillRect(-l * out, y0, l, y1 - y0);
  if (r > 0) ctx.fillRect(w - r * (1 - out), y0, r, y1 - y0);
}

type Pair = [number, number];
/** The ends of an open path, in the box's pixels: each end and the way the line runs into it there. */
export function pathEnds(points: readonly PathPoint[], w: number, h: number): { start: { at: Pair; dir: Pair }; end: { at: Pair; dir: Pair } } | null {
  const segs = segments(points, false);
  if (!segs.length) return null;
  const px = (p: Pair): Pair => [p[0] * w, p[1] * h];
  /** The way from `from` to `tip`, as one pixel long; the first of `from` that is not the tip itself. */
  const way = (tip: Pair, ...from: Pair[]): Pair => {
    for (const f of from) {
      const d = Math.hypot(tip[0] - f[0], tip[1] - f[1]);
      if (d > 1e-6) return [(tip[0] - f[0]) / d, (tip[1] - f[1]) / d];
    }
    return [1, 0];
  };
  const [a, c1, c2] = segs[0]!.map(px);
  const last = segs[segs.length - 1]!.map(px);
  return { start: { at: a!, dir: way(a!, c1!, c2!, last[3]!) }, end: { at: last[3]!, dir: way(last[3]!, last[2]!, last[1]!, last[0]!) } };
}

/** An open path's heads in its line's colour: an open arrow, a solid triangle, a dot or a bar across, as big as the line is wide. */
function heads(ctx: Ctx, s: Stroke, points: readonly PathPoint[], w: number, h: number) {
  const ends = pathEnds(points, w, h);
  if (!ends) return;
  const len = Math.max(s.width * 4, 8);
  const half = len * 0.6;
  for (const [kind, { at, dir }] of [[s.start, ends.start], [s.end, ends.end]] as const) {
    if (!kind) continue;
    const n: Pair = [-dir[1], dir[0]];
    ctx.beginPath();
    if (kind === "circle") {
      ctx.arc(at[0], at[1], Math.max(s.width * 1.6, 3), 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === "triangle") {
      // its tip a line's width past the end, so the line's square end is inside it
      const tip: Pair = [at[0] + dir[0] * s.width, at[1] + dir[1] * s.width];
      const base: Pair = [tip[0] - dir[0] * len, tip[1] - dir[1] * len];
      ctx.moveTo(tip[0], tip[1]);
      ctx.lineTo(base[0] + n[0] * half, base[1] + n[1] * half);
      ctx.lineTo(base[0] - n[0] * half, base[1] - n[1] * half);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.lineWidth = s.width;
      ctx.lineCap = kind === "bar" ? "butt" : "round";
      ctx.lineJoin = "round";
      if (kind === "bar") {
        ctx.moveTo(at[0] + n[0] * half, at[1] + n[1] * half);
        ctx.lineTo(at[0] - n[0] * half, at[1] - n[1] * half);
      } else {
        const back: Pair = [at[0] - dir[0] * len, at[1] - dir[1] * len];
        ctx.moveTo(back[0] + n[0] * half, back[1] + n[1] * half);
        ctx.lineTo(at[0], at[1]);
        ctx.lineTo(back[0] - n[0] * half, back[1] - n[1] * half);
      }
      ctx.stroke();
    }
  }
}
