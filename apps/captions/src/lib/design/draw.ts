import type { DesignPage, DesignShape, Gradient, ImageLayer, Layer, Radius, ShapeLayer, Stroke, TextLayer } from "@contracts/design";
import { designWeight } from "./fonts";
import { onPath, tracePath } from "./path";
import { blurPixels, retouch, retouches } from "./retouch";

/**
 * Draws a design's page (contracts/design.ts) on a 2D canvas, in the design's own pixels. The editor's stage and the
 * PNG that is saved are drawn by this one function, so what is saved is what was seen.
 */

/** The CSS font of a text layer at its size (each bundled family is one weight: src/lib/types.ts). */
// a sign the face does not have (an arrow, in most of the serifs) is drawn in Inter, which every machine has from the
// app, and not in whatever face that machine falls back to: the same on the person's canvas and in an AI's picture
export const fontOf = (l: Pick<TextLayer, "font" | "size">, scale = 1): string => `${designWeight(l.font)} ${l.size * scale}px "${l.font}", "Inter"`;
export const lineHeightOf = (l: Pick<TextLayer, "size" | "lineHeight">): number => l.size * (l.lineHeight ?? 1.15);
export const shownText = (l: Pick<TextLayer, "text" | "upper">): string => (l.upper ? l.text.toUpperCase() : l.text);

/**
 * The lines a text makes inside `width`: its own line breaks are kept, and a line too long is broken between words
 * (a single word wider than the box stays whole, on a line of its own). `measure` gives a string's width.
 */
export function wrapLines(text: string, width: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/[ \t]+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && measure(next) > width) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

/** A drawing's markup as a picture's address. An SVG shown as a picture runs nothing and loads nothing. */
export const drawingUrl = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
/** What a layer needs loaded before it can be drawn: a picture's id, or a drawing's own markup. */
export const sourceOf = (l: Layer): string | null => (l.type === "image" ? l.picture : l.type === "drawing" ? l.svg : null);

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type Loaded = Map<string, CanvasImageSource & { width: number; height: number }>;

/** A corner's radius, held to half the box: the top left, top right, bottom right and bottom left. */
export const cornersOf = (r: Radius | undefined, w: number, h: number): [number, number, number, number] =>
  (typeof r === "object" ? r : [r ?? 0, r ?? 0, r ?? 0, r ?? 0]).map((n) => Math.max(0, Math.min(n, w / 2, h / 2))) as [number, number, number, number];

/** A box with rounded corners, added to the path under way (the caller begins it). */
function roundedRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: Radius | undefined) {
  const [tl, tr, br, bl] = cornersOf(r, w, h);
  ctx.moveTo(x + tl, y);
  ctx.arcTo(x + w, y, x + w, y + h, tr);
  ctx.arcTo(x + w, y + h, x, y + h, br);
  ctx.arcTo(x, y + h, x, y, bl);
  ctx.arcTo(x, y, x + w, y, tl);
  ctx.closePath();
}

/** A shape's outline in its own box, added to the path under way. */
function shapePath(ctx: Ctx, l: ShapeLayer) {
  if (l.shape === "ellipse") {
    // begun where the ellipse starts, so no line is drawn to it from whatever the path held before
    ctx.moveTo(l.w, l.h / 2);
    ctx.ellipse(l.w / 2, l.h / 2, l.w / 2, l.h / 2, 0, 0, Math.PI * 2);
    ctx.closePath();
  } else if (l.shape === "rect") roundedRect(ctx, 0, 0, l.w, l.h, l.radius);
  else {
    shapePoints(l.shape, l.w, l.h).forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
  }
}

/** A fill for a w × h box: the colour, or its gradient across the box, as long as the box is along the gradient's angle. */
function fillOf(ctx: Ctx, color: string, g: Gradient | undefined, w: number, h: number): string | CanvasGradient {
  if (!g) return color;
  const a = (g.angle * Math.PI) / 180;
  const half = (Math.abs(Math.cos(a)) * w + Math.abs(Math.sin(a)) * h) / 2;
  // radial: from the middle out to the corners
  const grad = g.kind === "radial" ? ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.hypot(w, h) / 2) : ctx.createLinearGradient(w / 2 - Math.cos(a) * half, h / 2 - Math.sin(a) * half, w / 2 + Math.cos(a) * half, h / 2 + Math.sin(a) * half);
  grad.addColorStop(0, color);
  if (g.via) grad.addColorStop(0.5, g.via);
  grad.addColorStop(1, g.to);
  return grad;
}

/** The corners of a shape that is made of straight sides, in its w × h box: a triangle pointing up, a five-pointed star, an arrow pointing right. */
export function shapePoints(shape: Exclude<DesignShape, "rect" | "ellipse">, w: number, h: number): [number, number][] {
  if (shape === "triangle") return [[w / 2, 0], [w, h], [0, h]];
  if (shape === "arrow") {
    // the head is as long as the box is high, and never more than half the arrow
    const neck = w - Math.min(w / 2, h);
    return [[0, h * 0.3], [neck, h * 0.3], [neck, 0], [w, h / 2], [neck, h], [neck, h * 0.7], [0, h * 0.7]];
  }
  return Array.from({ length: 10 }, (_, k): [number, number] => {
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    const r = k % 2 ? 0.4 : 1;
    return [w / 2 + (Math.cos(a) * r * w) / 2, h / 2 + (Math.sin(a) * r * h) / 2];
  });
}

/**
 * How wide a line of a text is drawn. With letter spacing each letter is measured and drawn by itself, the spacing
 * between them (a browser's own letter spacing on a canvas is not in every browser), so the stage, the saved PNG and
 * the picture an AI is shown all break their lines at the same words.
 */
export function textWidth(l: Pick<TextLayer, "spacing">, s: string, measure: (s: string) => number): number {
  if (!l.spacing) return measure(s);
  const letters = Array.from(s);
  return letters.reduce((n, ch) => n + measure(ch), 0) + l.spacing * Math.max(0, letters.length - 1);
}

/** The smallest size words are shrunk to, in pixels. */
const SMALLEST = 8;

/**
 * How a text is set in its box: the size it is drawn at and its lines. The size is its own, or (when it shrinks to
 * fit) the largest up to its own at which every line fits the box's width and all of them its height, never under
 * SMALLEST. Balanced, each paragraph's lines are broken at the narrowest width that takes it no more lines, so they
 * come out about as long as each other. `base` gives a string's width at the layer's own size: a width at another size is that in
 * proportion, so nothing is measured twice.
 */
export function setText(l: Pick<TextLayer, "text" | "upper" | "size" | "lineHeight" | "spacing" | "w" | "h" | "fit" | "balance">, base: (s: string) => number): { size: number; lines: string[] } {
  const text = shownText(l);
  const widthAt = (k: number) => (s: string) => textWidth(l, s, (t) => base(t) * k);
  const linesAt = (k: number, width = l.w) => wrapLines(text, width, widthAt(k));
  const fits = (k: number) => {
    const lines = linesAt(k);
    return lines.length * lineHeightOf(l) * k <= l.h + 0.5 && lines.every((line) => widthAt(k)(line) <= l.w + 0.5);
  };
  let k = 1;
  if (l.fit === "shrink" && !fits(1)) {
    // between the smallest and its own size: the largest that fits, to a four-thousandth
    let lo = Math.min(1, SMALLEST / l.size);
    let hi = 1;
    for (let n = 0; n < 12; n++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    k = lo;
  }
  // evened out a paragraph at a time: each of the text's own lines keeps its break, and is broken further (when it is
  // too long) at the narrowest width that takes it no more lines
  const lines = !l.balance
    ? linesAt(k)
    : text.split("\n").flatMap((para) => {
        const wrap = (width: number) => wrapLines(para, width, widthAt(k));
        const own = wrap(l.w);
        if (own.length < 2) return own;
        let lo = 0;
        let hi = l.w;
        for (let n = 0; n < 10; n++) {
          const mid = (lo + hi) / 2;
          if (wrap(mid).length <= own.length) hi = mid;
          else lo = mid;
        }
        return wrap(hi);
      });
  return { size: Math.round(l.size * k * 100) / 100, lines };
}

/**
 * `setText`, kept a layer: a layer is drawn many times as it is (every redraw of the canvas while it is dragged
 * about), and working out its size and lines again each time is most of what drawing words costs. What was worked
 * out is used again while the layer is the same one and its words are as wide as they were then: a font that
 * arrived since changes that width, and the layer is set again.
 */
const setOnce = new WeakMap<object, { wide: number; set: { size: number; lines: string[] } }>();
export function setTextOnce(l: TextLayer, base: (s: string) => number): { size: number; lines: string[] } {
  const wide = base(shownText(l));
  const had = setOnce.get(l);
  if (had?.wide === wide) return had.set;
  const set = setText(l, base);
  setOnce.set(l, { wide, set });
  return set;
}

/** A string's width in a font, measured on a canvas kept for it (a browser's own; for where no drawing is under way, like the box words are typed in). */
let measuring: CanvasRenderingContext2D | null = null;
export function measurer(font: string): (s: string) => number {
  measuring ??= document.createElement("canvas").getContext("2d")!;
  const ctx = measuring;
  return (s) => {
    ctx.font = font;
    return ctx.measureText(s).width;
  };
}

/**
 * Where a text's highlighter strokes go, in its box: for each mark, a box on every line its words are on (a phrase
 * that wraps gets one a line, and every place the phrase is in the text gets its own); a mark without words, a box
 * behind each line. `lines` are the lines as they are set, `left` a line's left edge and `width` a string's width as it
 * is drawn. A stroke runs from just over the letters' tops to just under their feet, and a little past the words:
 * `ink` is how far the text's letters reach over and under the line they stand on, as its font draws them (tall
 * capitals reach higher than a round book face, and capitals alone reach nowhere under it), so every stroke of one text
 * is as high as the others. Without it, what most faces come to.
 */
export function markBoxes(
  marks: TextLayer["marks"],
  lines: readonly string[],
  size: number,
  lh: number,
  top: number,
  left: (line: string) => number,
  width: (s: string) => number,
  ink: { up: number; down: number } = { up: size * 0.72, down: size * 0.2 },
): { x: number; y: number; w: number; h: number; color: string }[] {
  const out: { x: number; y: number; w: number; h: number; color: string }[] = [];
  const pad = size * 0.14;
  const over = size * 0.1;
  const box = (k: number, from: number, to: number, color: string) => {
    const line = lines[k]!;
    if (to <= from || !line.slice(from, to).trim()) return;
    // the words' left end is where their last letter ends, less their own width: right with letters spaced apart too,
    // where the width of what stands before them is one space between letters short
    const wide = width(line.slice(from, to));
    // the line the letters stand on is where drawText puts it: 0.8 of the size under the top of the letters' own room
    const foot = top + k * lh + (lh - size) / 2 + size * 0.8;
    out.push({ x: left(line) + width(line.slice(0, to)) - wide - pad, y: foot - ink.up - over, w: wide + 2 * pad, h: ink.up + ink.down + 2 * over, color });
  };
  // the lines end to end with one space between them: where a phrase is found there says which lines it is on
  // ponytail: found by its small letters, place for place. A letter whose small form is longer (the Turkish İ) moves
  // the stroke by a letter, and in capitals a phrase with ß (set as SS) is not found; match by Intl.Collator when
  // someone highlights such words
  const starts: number[] = [];
  let all = "";
  for (const line of lines) {
    starts.push(all.length + (all ? 1 : 0));
    all += (all ? " " : "") + line.toLowerCase();
  }
  for (const m of marks ?? []) {
    const words = m.words?.replace(/\s+/g, " ").trim().toLowerCase();
    if (!words) {
      lines.forEach((line, k) => box(k, 0, line.length, m.color));
      continue;
    }
    for (let at = all.indexOf(words); at >= 0; at = all.indexOf(words, at + words.length)) {
      // the stroke takes in what closes its last word (a full stop, a comma, a closing quote): cut off before it, it looks torn
      let end = at + words.length;
      while (end < all.length && /[.,!?:;…”")\]]/.test(all[end]!)) end++;
      lines.forEach((line, k) => box(k, Math.max(0, at - starts[k]!), Math.min(line.length, end - starts[k]!), m.color));
    }
  }
  return out;
}

function drawText(ctx: Ctx, given: TextLayer) {
  ctx.font = fontOf(given);
  ctx.textBaseline = "alphabetic";
  const set = setTextOnce(given, (s) => ctx.measureText(s).width);
  // from here on the layer at the size it is drawn at
  const l = set.size === given.size ? given : { ...given, size: set.size };
  ctx.font = fontOf(l);
  const measure = (s: string) => ctx.measureText(s).width;
  const lines = set.lines;
  const lh = lineHeightOf(l);
  const top = l.valign === "middle" ? (l.h - lines.length * lh) / 2 : l.valign === "bottom" ? l.h - lines.length * lh : 0;
  // the highlighter's strokes lie under the words, as high as this text's own letters are drawn
  const drawn = l.marks?.length ? lines.map((line) => ctx.measureText(line)) : [];
  const up = Math.max(0, ...drawn.map((m) => m.actualBoundingBoxAscent));
  const down = Math.max(0, ...drawn.map((m) => m.actualBoundingBoxDescent));
  for (const b of markBoxes(l.marks, lines, l.size, lh, top, (line) => (l.align === "center" ? (l.w - textWidth(l, line, measure)) / 2 : l.align === "right" ? l.w - textWidth(l, line, measure) : 0), (s) => textWidth(l, s, measure), up > 0 ? { up, down } : undefined)) {
    ctx.beginPath();
    roundedRect(ctx, b.x, b.y, b.w, b.h, l.size * 0.07);
    ctx.fillStyle = b.color;
    ctx.fill();
  }
  const fill = fillOf(ctx, l.color, l.gradient, l.w, l.h);
  if (l.outline) {
    ctx.lineJoin = "round";
    ctx.lineWidth = l.outline.width * 2;
    ctx.strokeStyle = l.outline.color;
  }
  lines.forEach((line, k) => {
    // the letters sit in the middle of their line: the baseline is about 0.8 of the letter height under its top
    const y = top + k * lh + (lh - l.size) / 2 + l.size * 0.8;
    if (!l.spacing) {
      ctx.textAlign = l.align;
      const x = l.align === "center" ? l.w / 2 : l.align === "right" ? l.w : 0;
      if (l.outline) ctx.strokeText(line, x, y);
      ctx.fillStyle = fill;
      return void ctx.fillText(line, x, y);
    }
    // letter by letter from the line's left end: every outline first, so none lies over the letter before it
    // ponytail: a "letter" is a code point, so with spacing set an accent written as its own mark, a joined emoji and
    // right-to-left or joining scripts come apart; split by grapheme (Intl.Segmenter) when someone spaces such words
    ctx.textAlign = "left";
    const wide = textWidth(l, line, measure);
    const left = l.align === "center" ? (l.w - wide) / 2 : l.align === "right" ? l.w - wide : 0;
    const each = (draw: (ch: string, x: number) => void) => {
      let x = left;
      for (const ch of Array.from(line)) {
        draw(ch, x);
        x += measure(ch) + l.spacing!;
      }
    };
    if (l.outline) each((ch, x) => ctx.strokeText(ch, x, y));
    ctx.fillStyle = fill;
    each((ch, x) => ctx.fillText(ch, x, y));
  });
}

/**
 * Things made for a place (a layer of a frame) and kept: the one a place has is given back while its `key` is the
 * same, and made again (from the old one, to use its memory again) when it is not. The ones used longest ago are let
 * go once all of them together are over `room`; the one just asked for always stays.
 */
export function keptOr<T>(kept: Map<string, { key: string; size: number; made: T }>, place: string, key: string, size: number, room: number, make: (old?: T) => T): T {
  const had = kept.get(place);
  kept.delete(place);
  const now = had?.key === key ? had : { key, size, made: make(had?.made) };
  // the newest last: the first is the one used longest ago
  kept.set(place, now);
  let all = 0;
  for (const k of kept.values()) all += k.size;
  for (const [other, k] of kept) {
    if (all <= room || other === place) break;
    kept.delete(other);
    all -= k.size;
  }
  return now.made;
}

type Canvas = HTMLCanvasElement | OffscreenCanvas;
/** The pixels a retouched picture is worked at on the canvas (a saved file is worked at its full size), and the pixels of them kept at once: about 6 MB and 48 MB. */
const LIVE_PIXELS = 1_500_000;
const KEPT_PIXELS = 12_000_000;
const retouched = new WeakMap<Loaded, Map<string, { key: string; size: number; made: Canvas }>>();

/**
 * A picture with its layer's colour changes made (lib/design/retouch.ts), as it lies in the layer's box. Kept one a
 * layer of a frame (`place`) for each set of loaded pictures, and made again only when the layer, the picture or the
 * size it is drawn at changes: a slider dragged about leaves one picture behind, not one for every value it passed.
 */
function retouchedPicture(l: ImageLayer, pic: CanvasImageSource & { width: number; height: number }, loaded: Loaded, zoom: number, place: string, exact: boolean): Canvas {
  // made at the size it is drawn at, in steps (so a zoom that glides does not make it again at every step of the
  // glide), never finer than twice the design's own pixels, and on the canvas never more pixels than LIVE_PIXELS
  let scale = exact ? zoom : Math.min(2, 2 ** (Math.round(Math.log2(Math.max(zoom, 0.02)) * 2) / 2));
  if (!exact && l.w * l.h * scale * scale > LIVE_PIXELS) scale = Math.sqrt(LIVE_PIXELS / (l.w * l.h));
  const w = Math.max(1, Math.round(l.w * scale));
  const h = Math.max(1, Math.round(l.h * scale));
  const key = JSON.stringify([l.picture, pic.width, pic.height, w, h, l.fit, l.zoom, l.focus, l.adjust, l.duotone, l.vignette, l.grain, l.blur]);
  let mine = retouched.get(loaded);
  if (!mine) retouched.set(loaded, (mine = new Map()));
  return keptOr(mine, place, key, w * h, KEPT_PIXELS, (old) => {
    const canvas = old ?? (typeof OffscreenCanvas === "undefined" ? document.createElement("canvas") : new OffscreenCanvas(w, h));
    // setting the size empties it
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
    placePicture(ctx, { ...l, w, h }, pic);
    const pixels = ctx.getImageData(0, 0, w, h);
    retouch(pixels.data, w, h, w / l.w, l);
    ctx.putImageData(pixels, 0, 0);
    return canvas;
  });
}

/** A picture in its layer's box: filling it or fitting in it, bigger by its zoom, with what the box cuts off taken from both sides by where the focus is (0 keeps the picture's left or top edge, 1 its right or bottom). */
function placePicture(ctx: Ctx, l: Pick<ImageLayer, "w" | "h" | "fit" | "zoom" | "focus">, pic: { width: number; height: number } & CanvasImageSource) {
  const k = (l.fit === "cover" ? Math.max(l.w / pic.width, l.h / pic.height) : Math.min(l.w / pic.width, l.h / pic.height)) * (l.zoom ?? 1);
  ctx.drawImage(pic, (l.w - pic.width * k) * (l.focus?.x ?? 0.5), (l.h - pic.height * k) * (l.focus?.y ?? 0.5), pic.width * k, pic.height * k);
}

/** How far off the canvas a layer is drawn to throw its shadow alone back onto it, in canvas pixels. */
const FAR = 30_000;

function drawLayer(ctx: Ctx, l: Layer, loaded: Loaded, frame: string, exact: boolean) {
  ctx.save();
  ctx.translate(l.x + l.w / 2, l.y + l.h / 2);
  if (l.rotate) ctx.rotate((l.rotate * Math.PI) / 180);
  if (l.flipX || l.flipY) ctx.scale(l.flipX ? -1 : 1, l.flipY ? -1 : 1);
  ctx.translate(-l.w / 2, -l.h / 2);
  ctx.globalAlpha = l.opacity ?? 1;
  if (l.shadow) {
    // The shadow alone, first: the layer is drawn far off the canvas with its shadow thrown back to where it falls,
    // so the shadow never shows through the layer's own see-through parts. A canvas's shadow is in the canvas's own
    // pixels whatever the drawing is scaled or turned by, so its blur and offset are scaled here by hand.
    const t = ctx.getTransform();
    const k = Math.hypot(t.a, t.b);
    const c = l.shadow.color;
    ctx.save();
    ctx.setTransform(t.a, t.b, t.c, t.d, t.e - FAR, t.f);
    ctx.shadowColor = `rgba(${parseInt(c.slice(1, 3), 16)},${parseInt(c.slice(3, 5), 16)},${parseInt(c.slice(5, 7), 16)},${l.shadow.opacity})`;
    ctx.shadowBlur = l.shadow.blur * k;
    ctx.shadowOffsetX = l.shadow.x * k + FAR;
    ctx.shadowOffsetY = l.shadow.y * k;
    paintLayer(ctx, l, loaded, true, frame, exact);
    ctx.restore();
  }
  if (l.blend) ctx.globalCompositeOperation = l.blend;
  if (l.blur && l.type !== "image" && !softLayer(ctx, l, loaded, frame, exact)) paintLayer(ctx, l, loaded, false, frame, exact);
  else if (!l.blur || l.type === "image") paintLayer(ctx, l, loaded, false, frame, exact);
  ctx.restore();
}

/** The pixels a blurred layer is worked at (a blur has nothing fine in it, so a big one is worked smaller), and the blurred layers kept. */
const SOFT_PIXELS = 1_500_000;
const soft = new WeakMap<Layer, { key: string; canvas: Canvas; margin: number }>();
const newCanvas = (w: number, h: number): Canvas | null =>
  typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : typeof document !== "undefined" ? Object.assign(document.createElement("canvas"), { width: w, height: h }) : null;

/**
 * A layer that is not a picture, drawn blurred (its `blur`): painted into a box of its own with room around it for
 * what the blur spreads, blurred there (retouch.ts blurPixels: the same in every browser, where a canvas's own blur is
 * not), and laid in place. Kept while the layer is the same one, drawn at the same scale: a layer is a new object
 * whenever anything of it changes. False when no canvas can be made (the layer is then drawn sharp).
 */
function softLayer(ctx: Ctx, l: Layer, loaded: Loaded, frame: string, exact: boolean): boolean {
  const blur = Math.min(200, l.blur ?? 0);
  const t = ctx.getTransform();
  // what the blur spreads past the box, in design pixels
  const m = Math.ceil(blur * 3);
  const bw = l.w + 2 * m;
  const bh = l.h + 2 * m;
  let scale = Math.hypot(t.a, t.b);
  if (bw * bh * scale * scale > SOFT_PIXELS) scale = Math.sqrt(SOFT_PIXELS / (bw * bh));
  // a drawing that has not loaded yet is a grey box: it is blurred again once it is there
  const src = sourceOf(l);
  const key = `${scale}|${src ? !!loaded.get(src)?.width : ""}`;
  let kept = soft.get(l);
  if (kept?.key !== key) {
    const w = Math.max(1, Math.ceil(bw * scale));
    const h = Math.max(1, Math.ceil(bh * scale));
    const canvas = newCanvas(w, h);
    const g = canvas?.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | null;
    if (!canvas || !g) return false;
    g.setTransform(scale, 0, 0, scale, m * scale, m * scale);
    paintLayer(g, l, loaded, false, frame, exact);
    const pixels = g.getImageData(0, 0, w, h);
    blurPixels(pixels.data, w, h, blur * scale);
    g.putImageData(pixels, 0, 0);
    kept = { key, canvas, margin: m };
    soft.set(l, kept);
  }
  ctx.drawImage(kept.canvas as CanvasImageSource, -m, -m, bw, bh);
  return true;
}

/** A square of film grain, the same on every machine and at every drawing: one grey value a grain. */
const GRAIN_SIDE = 128;
let grainTile: Canvas | null | undefined;
function grainOf(): Canvas | null {
  if (grainTile !== undefined) return grainTile;
  const canvas = newCanvas(GRAIN_SIDE, GRAIN_SIDE);
  const g = canvas?.getContext("2d") as CanvasRenderingContext2D | null;
  if (!canvas || !g) return (grainTile = null);
  const pixels = g.createImageData(GRAIN_SIDE, GRAIN_SIDE);
  let seed = 0x2f6e2b1;
  for (let i = 0; i < pixels.data.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = seed >>> 24;
    pixels.data[i + 3] = 255;
  }
  g.putImageData(pixels, 0, 0);
  return (grainTile = canvas);
}

/**
 * A frame's finish, over everything on it: its edges darkened or lightened (nothing inside the middle third, all of it
 * at the corners, as a picture's own vignette), and a film grain two design pixels a grain, strongest in the middle
 * greys. Both are drawn, not worked pixel by pixel, so they are the same at every zoom and cost next to nothing.
 */
function finishFrame(ctx: Ctx, page: Pick<DesignPage, "grain" | "vignette">, w: number, h: number): void {
  const edge = Math.min(100, Math.max(-100, page.vignette ?? 0)) / 100;
  if (edge) {
    const far = Math.hypot(w, h) / 2;
    const fade = ctx.createRadialGradient(w / 2, h / 2, far * 0.35, w / 2, h / 2, far);
    const tone = edge > 0 ? "0,0,0" : "255,255,255";
    const most = Math.abs(edge) * 0.85;
    fade.addColorStop(0, `rgba(${tone},0)`);
    fade.addColorStop(0.5, `rgba(${tone},${(most * 0.5).toFixed(3)})`);
    fade.addColorStop(1, `rgba(${tone},${most.toFixed(3)})`);
    ctx.fillStyle = fade;
    ctx.fillRect(0, 0, w, h);
  }
  const grain = Math.min(100, Math.max(0, page.grain ?? 0)) / 100;
  const tile = grain ? grainOf() : null;
  const pattern = tile ? ctx.createPattern(tile as CanvasImageSource, "repeat") : null;
  if (!pattern) return;
  ctx.save();
  ctx.globalCompositeOperation = "overlay";
  ctx.globalAlpha = grain * 0.4;
  // a grain a screen pixel or more across is drawn crisp; smaller (zoomed far out), the grains run together as they would to the eye
  const t = ctx.getTransform();
  ctx.imageSmoothingEnabled = 2 * Math.hypot(t.a, t.b) < 1;
  ctx.scale(2, 2);
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, w / 2, h / 2);
  ctx.restore();
}

/**
 * A line along an outline (`trace` adds the outline to the path under way) in a w × h box: dashed and with round ends
 * when it says so, and on one side of the outline only when it has a side.
 */
function strokeAlong(ctx: Ctx, s: Stroke | undefined, trace: () => void, w: number, h: number, join: CanvasLineJoin) {
  if (!s) return;
  ctx.lineJoin = join;
  ctx.strokeStyle = s.color;
  ctx.lineCap = s.round ? "round" : "butt";
  if (s.dash) ctx.setLineDash(s.dash);
  if (!s.side) {
    ctx.lineWidth = s.width;
    return void ctx.stroke();
  }
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

/** A layer in its own box. `cast`: only what throws its shadow (a picture's whole box, not the picture cut to its corners). */
function paintLayer(ctx: Ctx, l: Layer, loaded: Loaded, cast: boolean, frame: string, exact: boolean) {
  if (l.type === "text") drawText(ctx, l);
  else if (l.type === "shape") {
    ctx.beginPath();
    shapePath(ctx, l);
    ctx.fillStyle = fillOf(ctx, l.fill, l.gradient, l.w, l.h);
    ctx.fill();
    // a rectangle keeps its square corners; a star's or an arrow's points are rounded off, or a wide line would spike far out of them
    strokeAlong(ctx, l.stroke, () => shapePath(ctx, l), l.w, l.h, l.shape === "rect" || l.shape === "ellipse" ? "miter" : "round");
  } else if (l.type === "path") {
    const trace = () => tracePath(ctx, l.points, !!l.closed, l.w, l.h);
    ctx.beginPath();
    trace();
    if (l.fill) {
      ctx.fillStyle = fillOf(ctx, l.fill, l.gradient, l.w, l.h);
      ctx.fill();
    }
    strokeAlong(ctx, l.stroke, trace, l.w, l.h, "round");
  } else {
    const pic = loaded.get(sourceOf(l)!);
    if (pic && pic.width && pic.height) {
      if (l.type === "image") {
        ctx.beginPath();
        roundedRect(ctx, 0, 0, l.w, l.h, l.radius);
        if (cast) {
          ctx.fillStyle = "#000000";
          return void ctx.fill();
        }
        ctx.clip();
        if (retouches(l)) {
          const t = ctx.getTransform();
          ctx.drawImage(retouchedPicture(l, pic, loaded, Math.hypot(t.a, t.b), `${frame}/${l.id}`, exact), 0, 0, l.w, l.h);
        } else placePicture(ctx, l, pic);
      } else ctx.drawImage(pic, 0, 0, l.w, l.h);
    } else {
      // not loaded (yet, or gone): its place is shown, so nothing is silently missing from the page
      ctx.fillStyle = "rgba(127,127,127,0.25)";
      ctx.fillRect(0, 0, l.w, l.h);
    }
  }
}

/** `exact`: for a file that is saved (or a picture an AI is shown): a retouched picture is worked at every pixel it is drawn at, where the canvas works at fewer when the picture is big. */
export function drawPage(ctx: Ctx, page: DesignPage, w: number, h: number, loaded: Loaded, exact = false): void {
  ctx.fillStyle = fillOf(ctx, page.background, page.gradient, w, h);
  ctx.fillRect(0, 0, w, h);
  for (const l of page.layers) if (!l.hidden) drawLayer(ctx, l, loaded, page.id, exact);
  finishFrame(ctx, page, w, h);
}

/** A point of the page in a layer's own box (its rotation taken out): inside when 0..w and 0..h. */
export function inLayer(l: Layer, px: number, py: number): { x: number; y: number; inside: boolean } {
  const a = (-(l.rotate ?? 0) * Math.PI) / 180;
  const dx = px - (l.x + l.w / 2);
  const dy = py - (l.y + l.h / 2);
  const x = dx * Math.cos(a) - dy * Math.sin(a) + l.w / 2;
  const y = dx * Math.sin(a) + dy * Math.cos(a) + l.h / 2;
  return { x, y, inside: x >= 0 && x <= l.w && y >= 0 && y <= l.h };
}

/** The topmost layer under a point of the page that a press can pick (a hidden or locked one lets it through), or null. */
export const layerAt = (page: DesignPage, px: number, py: number, near = 8): Layer | null =>
  // a path is under the pointer where its line or its fill is (or within `near` of its line: a few pixels of the
  // screen, whatever the zoom), not anywhere in the box round it
  [...page.layers].reverse().find((l) => !l.hidden && !l.locked && (l.type === "path" ? onPath(l, px, py, near) : inLayer(l, px, py).inside)) ?? null;
