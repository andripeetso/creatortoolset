import type { DesignBoolean, DesignMask, Stroke } from "@contracts/design";

/**
 * Combined shapes and masks (contracts/design.ts GroupLayer `boolean`, Box `mask`), drawn by laying canvases over each
 * other with the canvas's own compositing (no ctx.filter: the Mac app's WebKit has none). Each canvas covers only the
 * part of the canvas being drawn on that the layers can reach, in that canvas's own pixels, so what comes out is as
 * sharp as everything else at any zoom and never bigger than the canvas.
 */

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type Canvas = HTMLCanvasElement | OffscreenCanvas;
/** A box in a canvas's own pixels. */
export type Area = { x: number; y: number; w: number; h: number };

export const newCanvas = (w: number, h: number): Canvas | null =>
  typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : typeof document !== "undefined" ? Object.assign(document.createElement("canvas"), { width: w, height: h }) : null;

/** The box round a w × h box drawn with this transform, in the canvas's own pixels. */
export function areaOf(t: DOMMatrix, w: number, h: number): Area {
  const xs = [t.e, t.a * w + t.e, t.c * h + t.e, t.a * w + t.c * h + t.e];
  const ys = [t.f, t.b * w + t.f, t.d * h + t.f, t.b * w + t.d * h + t.f];
  const x = Math.floor(Math.min(...xs));
  const y = Math.floor(Math.min(...ys));
  return { x, y, w: Math.ceil(Math.max(...xs)) - x, h: Math.ceil(Math.max(...ys)) - y };
}

/** Where a box (in ctx's units as it draws now) lies on ctx's canvas, cut to the canvas; null when it is off it. */
export function sheetOf(ctx: Ctx, b: Area): Area | null {
  const t = ctx.getTransform();
  const a = areaOf(new DOMMatrix([t.a, t.b, t.c, t.d, t.e + t.a * b.x + t.c * b.y, t.f + t.b * b.x + t.d * b.y]), b.w, b.h);
  const x0 = Math.max(a.x, 0);
  const y0 = Math.max(a.y, 0);
  const x1 = Math.min(a.x + a.w, ctx.canvas.width);
  const y1 = Math.min(a.y + a.h, ctx.canvas.height);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** A blank canvas of sheet `s`, drawn on as ctx draws now (the same units and place). `read`: its pixels are read back (kept off the graphics card). */
function blank(ctx: Ctx, s: Area, read = false): { canvas: Canvas; g: Ctx } | null {
  const canvas = newCanvas(s.w, s.h);
  const g = canvas?.getContext("2d", read ? { willReadFrequently: true } : undefined) as Ctx | null | undefined;
  if (!canvas || !g) return null;
  const t = ctx.getTransform();
  g.setTransform(t.a, t.b, t.c, t.d, t.e - s.x, t.f - s.y);
  return { canvas, g };
}

/** A sheet's canvas emptied. */
function clear(g: Ctx, s: Area) {
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, s.w, s.h);
  g.restore();
}

/** `by` laid on `g` with this compositing, pixel for pixel (both a sheet's size). */
function lay(g: Ctx, by: Canvas, op: GlobalCompositeOperation, x = 0, y = 0) {
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = op;
  g.drawImage(by as CanvasImageSource, x, y);
  g.restore();
}

/** A finished sheet laid on ctx where it came from, with ctx's own fade and blend. */
function put(ctx: Ctx, s: Area, c: Canvas) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(c as CanvasImageSource, s.x, s.y);
  ctx.restore();
}

/** How each shape after the first is laid on those under it. */
const OPS: Record<DesignBoolean, GlobalCompositeOperation> = { union: "source-over", subtract: "destination-out", intersect: "destination-in", exclude: "xor" };

/**
 * Shapes combined into one (each of `shapes` draws one solid, as it lies, the bottom one first), painted by `fill`
 * and lined by `lines` (each with its colour; `paint` sets the canvas's fade and blend for one as eachStroke does),
 * over `box` in ctx's units: where the shape and its lines may reach. False when a canvas could not be made (the
 * browser out of canvas memory): nothing was drawn, and the caller draws something in its place.
 */
export function combine(ctx: Ctx, box: Area, op: DesignBoolean, shapes: readonly ((g: Ctx) => void)[], fill: (g: Ctx) => void, lines: readonly Stroke[], paint: (each: (s: Stroke) => void) => void): boolean {
  const s = sheetOf(ctx, box);
  if (!s || !shapes.length) return true;
  const cover = blank(ctx, s);
  if (!cover) return false;
  shapes[0]!(cover.g);
  // one canvas for every shape after the first, emptied before each
  const one = shapes.length > 1 ? blank(ctx, s) : null;
  for (const draw of shapes.slice(1)) {
    if (!one) return false;
    clear(one.g, s);
    draw(one.g);
    lay(cover.g, one.canvas, OPS[op]);
  }
  const filled = blank(ctx, s);
  if (!filled) return false;
  fill(filled.g);
  lay(filled.g, cover.canvas, "destination-in");
  put(ctx, s, filled.canvas);
  if (!lines.length) return true;
  const t = ctx.getTransform();
  const k = Math.hypot(t.a, t.b);
  let whole = true;
  paint((line) => {
    const band = lineOf(ctx, s, cover.canvas, line.width * k, line.side);
    if (!band) return void (whole = false);
    band.g.save();
    band.g.setTransform(1, 0, 0, 1, 0, 0);
    band.g.globalCompositeOperation = "source-in";
    band.g.fillStyle = line.color;
    band.g.fillRect(0, 0, s.w, s.h);
    band.g.restore();
    put(ctx, s, band.canvas);
  });
  return whole;
}

/**
 * A line round the shape on `cover`, `w` of the sheet's pixels wide, on the side it says (half on each when none): the
 * shape grown less the shape shrunk, both by laying it again round a few rings of steps.
 * shortcut: no dashes, ends or corners of its own on a combined shape's line (its outline is pixels, not a path); draw them once shapes combine as paths.
 */
function lineOf(ctx: Ctx, s: Area, cover: Canvas, w: number, side: Stroke["side"]) {
  const outside = blank(ctx, s);
  if (!outside) return null;
  // where the shape is not (past the sheet counts as not)
  outside.g.save();
  outside.g.setTransform(1, 0, 0, 1, 0, 0);
  outside.g.fillRect(0, 0, s.w, s.h);
  outside.g.restore();
  lay(outside.g, cover, "destination-out");
  const reach = side ? w : w / 2;
  const outer = side === "inside" ? grow(ctx, s, cover, 0) : grow(ctx, s, cover, reach);
  const inner = side === "outside" ? outside : grow(ctx, s, outside.canvas, reach);
  if (!outer || !inner) return null;
  lay(outer.g, inner.canvas, "destination-in");
  return outer;
}

/** Steps on a ring of radius k close enough that its edge between two is at most half a pixel in from it: k (1 - cos(π / n)) ≤ ½. */
export const ringSteps = (k: number): number => Math.max(8, Math.ceil(Math.PI * Math.sqrt(k)));

/**
 * `src` grown by r pixels every way, in steps of 1, 1, 2, 4 … (the last what is left): each step lays what is grown so
 * far round a ring of its own size, and is never wider than what it lays is thick, so no part, however thin, is left
 * with gaps; about 16 draws a step.
 */
function grow(ctx: Ctx, s: Area, src: Canvas, r: number) {
  const out = blank(ctx, s);
  const was = blank(ctx, s);
  if (!out || !was) return null;
  lay(out.g, src, "source-over");
  let done = 0;
  while (done < r - 0.25) {
    // as wide as what is grown so far (1 at first), the last step what is left
    const k = Math.min(Math.max(1, done), r - done);
    clear(was.g, s);
    lay(was.g, out.canvas, "source-over");
    const n = ringSteps(k);
    for (let i = 0; i < n; i++) lay(out.g, was.canvas, "source-over", k * Math.cos((2 * Math.PI * i) / n), k * Math.sin((2 * Math.PI * i) / n));
    done += k;
  }
  return out;
}

/**
 * Layers (`run` draws them, given the sheet it draws on) cut to a mask (`mask` draws it: as it is, or solid for a
 * "vector" one), over `box` in ctx's units: where the mask may reach, since nothing shows past it. False when a canvas
 * could not be made (nothing was drawn).
 */
export function masked(ctx: Ctx, box: Area, mode: DesignMask, mask: (g: Ctx) => void, run: (g: Ctx, sheet: Area) => void): boolean {
  const s = sheetOf(ctx, box);
  if (!s) return true;
  const top = blank(ctx, s);
  const cut = blank(ctx, s, mode === "luminance");
  if (!top || !cut) return false;
  run(top.g, s);
  mask(cut.g);
  if (mode === "luminance") {
    // how light it is, as it is drawn (sRGB weights), times how solid
    const px = cut.g.getImageData(0, 0, s.w, s.h);
    const d = px.data;
    for (let i = 0; i < d.length; i += 4) d[i + 3] = (d[i + 3]! * (0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!)) / 255;
    cut.g.putImageData(px, 0, 0);
  }
  lay(top.g, cut.canvas, "destination-in");
  put(ctx, s, top.canvas);
  return true;
}
