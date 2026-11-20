import type { DesignPage, DesignShape, Effect, Gradient, ImageLayer, Layer, Radius, ShapeLayer, Stroke, TextLayer } from "@contracts/design";
import { faceOf } from "./fonts";
import { onPath, tracePath } from "./path";
import { addNoise, effectsOf, fullAlpha, innerShadow, progressiveBlur, reachOf, spreadAlpha, worksPixels } from "./effects";
import { blurPixels, retouch, retouches } from "./retouch";
import { casedText, pieceFont, setRuns, usesRuns, type RunLine } from "./runs";

/**
 * Draws a design's page (contracts/design.ts) on a 2D canvas, in the design's own pixels. The editor's stage and the
 * PNG that is saved are drawn by this one function, so what is saved is what was seen.
 */

/** The CSS font of a text layer at its size: its font's face nearest its weight (src/lib/design/fonts.ts faceOf). */
// a sign the face does not have (an arrow, in most of the serifs) is drawn in Inter, which every machine has from the
// app, and not in whatever face that machine falls back to: the same on the person's canvas and in an AI's picture
export const fontOf = (l: Pick<TextLayer, "font" | "size" | "weight">, scale = 1): string => {
  const f = faceOf(l.font, l.weight);
  return `${f.css} ${l.size * scale}px "${f.family}", "Inter"`;
};
export const lineHeightOf = (l: Pick<TextLayer, "size" | "lineHeight">): number => l.size * (l.lineHeight ?? 1.15);
export const shownText = (l: Pick<TextLayer, "text" | "upper" | "case">): string => casedText(l);

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
export function setText(l: Pick<TextLayer, "text" | "upper" | "case" | "size" | "lineHeight" | "spacing" | "w" | "h" | "fit" | "balance" | "lines">, base: (s: string) => number): { size: number; lines: string[] } {
  const text = shownText(l);
  const widthAt = (k: number) => (s: string) => textWidth(l, s, (t) => base(t) * k);
  const linesAt = (k: number, width = l.w) => wrapLines(text, width, widthAt(k));
  const fits = (k: number) => {
    const lines = linesAt(k);
    return lines.length * lineHeightOf(l) * k <= l.h + 0.5 && lines.every((line) => widthAt(k)(line) <= l.w + 0.5) && (!l.lines || lines.length <= l.lines);
  };
  let k = 1;
  if ((l.fit === "shrink" || l.lines) && !fits(1)) {
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
  // held to a number of lines: no word alone on a paragraph's last line, by shrinking a little more when that is enough
  if (l.lines && orphaned(linesAt(k), text)) {
    for (let s = k * 0.99; s >= k * 0.92; s -= k * 0.01)
      if (fits(s) && !orphaned(linesAt(s), text)) {
        k = s;
        break;
      }
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
  return { size: Math.round(l.size * k * 100) / 100, lines: l.lines ? keepLastTwo(lines, text, (s) => widthAt(k)(s) <= l.w + 0.5) : lines };
}

/** The line indexes that end a paragraph of `text` (its own line breaks), for `lines` wrapped from it. */
function paragraphEnds(lines: readonly string[], text: string): number[] {
  const ends: number[] = [];
  let at = -1;
  for (const para of text.split("\n")) {
    // a paragraph takes as many lines as its words fill: count them off by words
    let left = para.split(/[ \t]+/).filter(Boolean).length;
    do left -= lines[++at]?.split(" ").filter(Boolean).length ?? left;
    while (left > 0 && at < lines.length - 1);
    ends.push(at);
  }
  return ends;
}

/** Whether a paragraph broken over two lines or more ends on a line of one word. A one-word paragraph is no orphan. */
export function orphaned(lines: readonly string[], text: string): boolean {
  let start = 0;
  return paragraphEnds(lines, text).some((end) => {
    const lone = end > start && lines[end]!.trim().split(" ").length === 1;
    start = end + 1;
    return lone;
  });
}

/** A paragraph's last word that stands alone gets the word before it as company, when the two fit the width together. */
function keepLastTwo(lines: string[], text: string, fits: (s: string) => boolean): string[] {
  const out = [...lines];
  let start = 0;
  for (const end of paragraphEnds(out, text)) {
    const before = out[end - 1]?.split(" ");
    if (end > start && out[end]!.trim().split(" ").length === 1 && before && before.length > 1 && fits(`${before.at(-1)} ${out[end]}`)) {
      out[end] = `${before.pop()} ${out[end]}`;
      out[end - 1] = before.join(" ");
    }
    start = end + 1;
  }
  return out;
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
 * is as high as the others. Without it, what most faces come to. A text with runs gives its size, line height and
 * ink a line each (the line's largest letters), and `width` the line and the place in it a string starts at.
 */
export function markBoxes(
  marks: TextLayer["marks"],
  lines: readonly string[],
  size: number | readonly number[],
  lh: number | readonly number[],
  top: number,
  left: (line: string, k: number) => number,
  width: (s: string, k: number, from: number) => number,
  ink?: { up: number; down: number } | readonly { up: number; down: number }[],
): { x: number; y: number; w: number; h: number; color: string }[] {
  const out: { x: number; y: number; w: number; h: number; color: string }[] = [];
  const tops: number[] = [];
  lines.reduce((t, _, k) => (tops.push(t), t + (typeof lh === "number" ? lh : lh[k]!)), top);
  const box = (k: number, from: number, to: number, m: { color: string; low?: true }) => {
    const line = lines[k]!;
    if (to <= from || !line.slice(from, to).trim()) return;
    const sz = typeof size === "number" ? size : size[k]!;
    const high = typeof lh === "number" ? lh : lh[k]!;
    const up = (ink && "up" in ink ? ink : ink?.[k]) ?? { up: sz * 0.72, down: sz * 0.2 };
    const pad = sz * 0.14;
    const over = sz * 0.1;
    // the words' left end is where their last letter ends, less their own width: right with letters spaced apart too,
    // where the width of what stands before them is one space between letters short
    const wide = width(line.slice(from, to), k, from);
    // the line the letters stand on is where drawText puts it: 0.8 of the size under the top of the letters' own room
    const foot = tops[k]! + (high - sz) / 2 + sz * 0.8;
    // low: over the small letters and a little under the line they stand on, the tall letters standing out of it
    const y = m.low ? foot - up.up * 0.72 : foot - up.up - over;
    out.push({ x: left(line, k) + width(line.slice(0, to), k, 0) - wide - pad, y, w: wide + 2 * pad, h: foot + (m.low ? sz * 0.14 : up.down + over) - y, color: m.color });
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
      lines.forEach((line, k) => box(k, 0, line.length, m));
      continue;
    }
    for (let at = all.indexOf(words); at >= 0; at = all.indexOf(words, at + words.length)) {
      // the stroke takes in what closes its last word (a full stop, a comma, a closing quote): cut off before it, it looks torn
      let end = at + words.length;
      while (end < all.length && /[.,!?:;…”")\]]/.test(all[end]!)) end++;
      lines.forEach((line, k) => box(k, Math.max(0, at - starts[k]!), Math.min(line.length, end - starts[k]!), m));
    }
  }
  return out;
}

function drawText(ctx: Ctx, given: TextLayer, cast = false) {
  if (usesRuns(given)) return drawRuns(ctx, given, cast);
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
  // the highlighter's strokes lie under the words, as high as this text's own letters are drawn. They are ink on the
  // ground: flat, with no shadow of their own (`cast`: the pass that draws only the layer's shadow leaves them out)
  const drawn = l.marks?.length && !cast ? lines.map((line) => ctx.measureText(line)) : [];
  const up = Math.max(0, ...drawn.map((m) => m.actualBoundingBoxAscent));
  const down = Math.max(0, ...drawn.map((m) => m.actualBoundingBoxDescent));
  for (const b of markBoxes(cast ? undefined : l.marks, lines, l.size, lh, top, (line) => (l.align === "center" ? (l.w - textWidth(l, line, measure)) / 2 : l.align === "right" ? l.w - textWidth(l, line, measure) : 0), (s) => textWidth(l, s, measure), up > 0 ? { up, down } : undefined)) {
    ctx.beginPath();
    roundedRect(ctx, b.x, b.y, b.w, b.h, l.size * 0.02);
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
 * `setRuns`, kept a layer (as `setTextOnce`): used again while the layer is the same one and each of its faces is as
 * wide as it was (a face that arrived since changes that).
 */
const runsOnce = new WeakMap<object, { wide: number; set: ReturnType<typeof setRuns> }>();
export function setRunsOnce(l: TextLayer, measure: (font: string, s: string) => number): ReturnType<typeof setRuns> {
  const wide = fontsOfText(l).reduce((n, f) => n + measure(f, "Hamburg 1"), 0);
  const had = runsOnce.get(l);
  if (had?.wide === wide) return had.set;
  const set = setRuns(l, measure);
  runsOnce.set(l, { wide, set });
  return set;
}

/** Every CSS font a text is drawn in (its own and its runs' faces), at 100px: what must be loaded before it is drawn. */
export function fontsOfText(l: TextLayer): string[] {
  const styles = [l, ...(l.runs ?? [])];
  return [...new Set(styles.map((r) => pieceFont(faceOf(r.font ?? l.font, r.weight ?? l.weight, r.italic ?? l.italic), 100)))];
}

const measureOn = (ctx: Ctx) => (font: string, s: string) => {
  ctx.font = font;
  return ctx.measureText(s).width;
};

/** How a text is set, measured on `ctx`: the size of its own letters, each line's width, and all of them together high. */
export function textBlock(ctx: Ctx, l: TextLayer): { size: number; widths: number[]; tall: number } {
  if (usesRuns(l)) {
    const set = setRuns(l, measureOn(ctx));
    return { size: set.size, widths: set.lines.map((r) => r.width), tall: set.lines.reduce((n, r) => n + r.height, 0) };
  }
  ctx.font = fontOf(l);
  const set = setText(l, (t) => ctx.measureText(t).width);
  const drawn = { ...l, size: set.size };
  ctx.font = fontOf(drawn);
  return { size: set.size, widths: set.lines.map((s) => textWidth(l, s, (t) => ctx.measureText(t).width)), tall: set.lines.length * lineHeightOf(drawn) };
}

/** The size a text's own letters are drawn at (their own, or the one they shrank to), for where no drawing is under way. */
export function textSize(l: TextLayer): number {
  return usesRuns(l) ? setRuns(l, (font, s) => measurer(font)(s)).size : setText(l, measurer(fontOf(l))).size;
}

/** How far an upright face is leaned over when italic is asked for and its family has no italic face: about 12°. */
const SLANT = 0.21;

/**
 * A text with runs (or a slant, lines under or through it, small capitals), drawn piece by piece: each in its own
 * face, size and colour, every piece of a line on one baseline, a line as high as its largest letters. The highlighter
 * strokes lie under the words as in drawText, a line each as high as that line's letters are drawn.
 */
function drawRuns(ctx: Ctx, l: TextLayer, cast: boolean) {
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  const measure = measureOn(ctx);
  const lines: RunLine[] = setRunsOnce(l, measure).lines;
  const tall = lines.reduce((n, r) => n + r.height, 0);
  const top = l.valign === "middle" ? (l.h - tall) / 2 : l.valign === "bottom" ? l.h - tall : 0;
  const lefts = lines.map((r) => (l.align === "center" ? (l.w - r.width) / 2 : l.align === "right" ? l.w - r.width : 0));
  /** The first letters of a piece, as wide as they are drawn. */
  const partWidth = (p: RunLine["pieces"][number], part: string) => {
    const font = pieceFont(p, p.size);
    const each = Array.from(part);
    return (p.spacing ? each.reduce((n, ch) => n + measure(font, ch), 0) : measure(font, part)) + p.spacing * each.length;
  };
  if (l.marks?.length && !cast) {
    // how far the letters reach over and under the line, for the size they are set at: the most of any line, in proportion to each line's size
    let up = 0;
    let down = 0;
    for (const r of lines)
      for (const p of r.pieces) {
        if (!p.text.trim()) continue;
        ctx.font = pieceFont(p, p.size);
        const m = ctx.measureText(p.text);
        up = Math.max(up, m.actualBoundingBoxAscent / r.size);
        down = Math.max(down, m.actualBoundingBoxDescent / r.size);
      }
    const xAt = (k: number, at: number) => {
      let x = 0;
      let n = 0;
      for (const p of lines[k]!.pieces) {
        if (at >= n + p.text.length) {
          x += p.width;
          n += p.text.length;
          continue;
        }
        return x + partWidth(p, p.text.slice(0, at - n));
      }
      return x;
    };
    const ink = up > 0 ? lines.map((r) => ({ up: up * r.size, down: down * r.size })) : undefined;
    for (const b of markBoxes(l.marks, lines.map((r) => r.text), lines.map((r) => r.size), lines.map((r) => r.height), top, (_, k) => lefts[k]!, (s, k, from) => xAt(k, from + s.length) - xAt(k, from), ink)) {
      ctx.beginPath();
      roundedRect(ctx, b.x, b.y, b.w, b.h, l.size * 0.02);
      ctx.fillStyle = b.color;
      ctx.fill();
    }
  }
  const fill = fillOf(ctx, l.color, l.gradient, l.w, l.h);
  if (l.outline) {
    ctx.lineJoin = "round";
    ctx.lineWidth = l.outline.width * 2;
    ctx.strokeStyle = l.outline.color;
  }
  let y0 = top;
  lines.forEach((r, k) => {
    // every piece on the line's baseline: 0.8 of its largest letters under the top of their room
    const y = y0 + (r.height - r.size) / 2 + r.size * 0.8;
    y0 += r.height;
    const draw = (outline: boolean) => {
      let x = lefts[k]!;
      for (const p of r.pieces) {
        ctx.font = pieceFont(p, p.size);
        if (!outline) ctx.fillStyle = p.color ?? fill;
        const put = (t: string, at: number) => {
          // leaned over about the baseline, so the letters stand where they would upright
          if (p.slant) {
            ctx.save();
            ctx.transform(1, 0, -SLANT, 1, SLANT * y, 0);
          }
          if (outline) ctx.strokeText(t, at, y);
          else ctx.fillText(t, at, y);
          if (p.slant) ctx.restore();
        };
        if (!p.spacing) put(p.text, x);
        else {
          let at = x;
          for (const ch of Array.from(p.text)) {
            put(ch, at);
            at += measure(pieceFont(p, p.size), ch) + p.spacing;
          }
        }
        x += p.width;
      }
    };
    // every outline of the line first, so none lies over the letter before it
    if (l.outline) draw(true);
    draw(false);
    // lines under and through the letters, in their colour, as thick as their size asks
    let x = lefts[k]!;
    r.pieces.forEach((p, j) => {
      if (p.underline || p.strike) {
        ctx.fillStyle = p.color ?? fill;
        const thick = Math.max(1, p.size * 0.06);
        const w = p.width - (j === r.pieces.length - 1 ? p.spacing : 0);
        if (p.underline) ctx.fillRect(x, y + p.size * 0.1, w, thick);
        if (p.strike) ctx.fillRect(x, y - p.size * 0.3 - thick / 2, w, thick);
      }
      x += p.width;
    });
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

/** A box in the canvas's own pixels: the frame's, where a background blur may read what is under it. */
type Area = { x: number; y: number; w: number; h: number };
/** The box round a w × h box drawn with this transform, in the canvas's own pixels. */
function areaOf(t: DOMMatrix, w: number, h: number): Area {
  const xs = [t.e, t.a * w + t.e, t.c * h + t.e, t.a * w + t.c * h + t.e];
  const ys = [t.f, t.b * w + t.f, t.d * h + t.f, t.b * w + t.d * h + t.f];
  const x = Math.floor(Math.min(...xs));
  const y = Math.floor(Math.min(...ys));
  return { x, y, w: Math.ceil(Math.max(...xs)) - x, h: Math.ceil(Math.max(...ys)) - y };
}

function drawLayer(ctx: Ctx, l: Layer, loaded: Loaded, frame: string, exact: boolean, area: Area) {
  ctx.save();
  ctx.translate(l.x + l.w / 2, l.y + l.h / 2);
  if (l.rotate) ctx.rotate((l.rotate * Math.PI) / 180);
  if (l.flipX || l.flipY) ctx.scale(l.flipX ? -1 : 1, l.flipY ? -1 : 1);
  ctx.translate(-l.w / 2, -l.h / 2);
  ctx.globalAlpha = l.opacity ?? 1;
  const fx = effectsOf(l).filter((e) => !e.hidden);
  const own = worksPixels(fx) || fx.some((e) => e.type === "shadow" && e.spread) ? workedLayer(ctx, l, fx, loaded, frame, exact) : null;
  const lay = (g: Ctx, p: Piece) => g.drawImage(p.canvas as CanvasImageSource, -p.m, -p.m, p.bw, p.bh);
  const paint = (g: Ctx, cast: boolean) => (own?.body ? lay(g, own.body) : paintLayer(g, l, loaded, cast, frame, exact));
  for (const e of fx) {
    if (e.type !== "shadow") continue;
    const grown = e.spread ? own?.spread(e.spread) : null;
    castShadow(ctx, e, (g) => (grown ? lay(g, grown) : paint(g, true)));
  }
  const glass = fx.find((e): e is Effect & { blur: number } => e.type === "background-blur");
  if (glass) backdrop(ctx, l, glass.blur, (g) => paint(g, true), area);
  if (l.blend) ctx.globalCompositeOperation = l.blend;
  paint(ctx, false);
  ctx.restore();
}

/**
 * A shadow alone: the layer is drawn far off the canvas with its shadow thrown back to where it falls, so the shadow
 * never shows through the layer's own see-through parts. A canvas's shadow is in the canvas's own pixels whatever the
 * drawing is scaled or turned by, so its blur and offset are scaled here by hand (and it falls the same way however
 * the layer is turned).
 */
function castShadow(ctx: Ctx, s: { color: string; opacity: number; blur: number; x: number; y: number }, paint: (g: Ctx) => void) {
  const t = ctx.getTransform();
  const k = Math.hypot(t.a, t.b);
  const c = s.color;
  ctx.save();
  ctx.setTransform(t.a, t.b, t.c, t.d, t.e - FAR, t.f);
  ctx.shadowColor = `rgba(${parseInt(c.slice(1, 3), 16)},${parseInt(c.slice(3, 5), 16)},${parseInt(c.slice(5, 7), 16)},${s.opacity})`;
  ctx.shadowBlur = s.blur * k;
  ctx.shadowOffsetX = s.x * k + FAR;
  ctx.shadowOffsetY = s.y * k;
  paint(ctx);
  ctx.restore();
}

/** The pixels a layer is worked at for its effects on the canvas (a blur has nothing fine in it) and in a saved file, and the worked layers kept. */
const WORK_PIXELS = 3_000_000;
const EXACT_WORK_PIXELS = 24_000_000;
const KEPT_WORK = 16_000_000;
const newCanvas = (w: number, h: number): Canvas | null =>
  typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : typeof document !== "undefined" ? Object.assign(document.createElement("canvas"), { width: w, height: h }) : null;

/** A layer worked in a box of its own: its canvas, the room round its box (`m`, design pixels) and the box's size with that room. */
type Piece = { canvas: Canvas; m: number; bw: number; bh: number };
type Worked = { body: Piece | null; spread: (n: number) => Piece | null };
const workedKept = new WeakMap<Loaded, Map<string, { key: string; size: number; made: Worked }>>();

/** A w × h box (with `m` design pixels of room round it) drawn at `scale` by `draw`, its pixels then changed by `work`. Null when no canvas can be made. */
function pieceOf(w: number, h: number, m: number, scale: number, draw: (g: Ctx) => void, work: (px: Uint8ClampedArray, w: number, h: number) => void): Piece | null {
  const bw = w + 2 * m;
  const bh = h + 2 * m;
  const pw = Math.max(1, Math.ceil(bw * scale));
  const ph = Math.max(1, Math.ceil(bh * scale));
  const canvas = newCanvas(pw, ph);
  const g = canvas?.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | null;
  if (!canvas || !g) return null;
  g.setTransform(scale, 0, 0, scale, m * scale, m * scale);
  draw(g);
  const pixels = g.getImageData(0, 0, pw, ph);
  work(pixels.data, pw, ph);
  g.putImageData(pixels, 0, 0);
  return { canvas, m, bw, bh };
}

/**
 * A layer with the effects that change its own pixels (lib/design/effects.ts): painted into a box of its own with
 * room round it for what its blur spreads, then its inner shadows, its noise and its blurs in that order; and its
 * outline grown by a shadow's spread, made when a shadow asks. Kept one a layer of a frame while it is the same but
 * for its place, drawn at the same scale: dragging it about works nothing again.
 */
function workedLayer(ctx: Ctx, l: Layer, fx: Effect[], loaded: Loaded, frame: string, exact: boolean): Worked {
  const t = ctx.getTransform();
  const reach = reachOf(fx);
  const grow = Math.max(0, ...fx.map((e) => (e.type === "shadow" ? (e.spread ?? 0) : 0)));
  const bw = l.w + 2 * (reach + grow);
  const bh = l.h + 2 * (reach + grow);
  const room = exact ? EXACT_WORK_PIXELS : WORK_PIXELS;
  let scale = Math.hypot(t.a, t.b);
  if (bw * bh * scale * scale > room) scale = Math.sqrt(room / (bw * bh));
  // a picture or a drawing that has not loaded yet is a grey box: it is worked again once it is there
  const src = sourceOf(l);
  const key = JSON.stringify([{ ...l, x: 0, y: 0 }, scale, src ? !!loaded.get(src)?.width : ""]);
  let mine = workedKept.get(loaded);
  if (!mine) workedKept.set(loaded, (mine = new Map()));
  return keptOr(mine, `${frame}/${l.id}`, key, Math.ceil(bw * bh * scale * scale), KEPT_WORK, () => {
    // an inner shadow falls the way a shadow does on the page, however the layer is turned or mirrored
    const a = (-(l.rotate ?? 0) * Math.PI) / 180;
    const inLayer = (x: number, y: number) => [(x * Math.cos(a) - y * Math.sin(a)) * (l.flipX ? -1 : 1), (x * Math.sin(a) + y * Math.cos(a)) * (l.flipY ? -1 : 1)] as const;
    const body = worksPixels(fx)
      ? pieceOf(l.w, l.h, reach, scale, (g) => paintLayer(g, l, loaded, false, frame, exact), (px, w, h) => {
          // its pixels a design pixel
          const k = w / (l.w + 2 * reach);
          for (const e of fx) {
            if (e.type !== "inner-shadow") continue;
            const [dx, dy] = inLayer(e.x, e.y);
            innerShadow(px, w, h, { ...e, blur: e.blur * k, spread: (e.spread ?? 0) * k }, dx * k, dy * k);
          }
          for (const e of fx) if (e.type === "noise") addNoise(px, w, h, e.amount, (e.size ?? 1) * k, reach * k, reach * k);
          for (const e of fx) {
            if (e.type === "blur") blurPixels(px, w, h, Math.min(200, e.blur) * k);
            else if (e.type === "progressive-blur") progressiveBlur(px, w, h, { ...e, blur: Math.min(200, e.blur) * k }, { x: reach * k, y: reach * k, w: l.w * k, h: l.h * k });
          }
        })
      : null;
    const spreads = new Map<number, Piece | null>();
    const spread = (n: number) => {
      if (!spreads.has(n))
        spreads.set(n, pieceOf(l.w, l.h, reach + Math.max(0, n), scale, (g) => (body ? g.drawImage(body.canvas as CanvasImageSource, -body.m, -body.m, body.bw, body.bh) : paintLayer(g, l, loaded, true, frame, exact)), (px, w, h) => spreadAlpha(px, w, h, (n * w) / (l.w + 2 * (reach + Math.max(0, n))))));
      return spreads.get(n)!;
    };
    return { body, spread };
  });
}

/** The pixels a background blur reads and works at (what it shows has nothing fine in it). */
const GLASS_PIXELS = 400_000;

/**
 * A background blur: what the canvas has under the layer so far (inside the frame's `area`) read small, blurred
 * (retouch.ts blurPixels: a canvas's own blur is missing in some browsers), and laid back only where the layer is.
 * `mask` paints the layer's shape; a see-through fill still blurs all that is under it. Worked at every drawing,
 * since what is under the layer changes with everything under it.
 */
function backdrop(ctx: Ctx, l: Layer, blur: number, mask: (g: Ctx) => void, area: Area) {
  const t = ctx.getTransform();
  const own = areaOf(t, l.w, l.h);
  const x0 = Math.max(own.x, area.x, 0);
  const y0 = Math.max(own.y, area.y, 0);
  const x1 = Math.min(own.x + own.w, area.x + area.w, ctx.canvas.width);
  const y1 = Math.min(own.y + own.h, area.y + area.h, ctx.canvas.height);
  if (x1 <= x0 || y1 <= y0) return;
  const r = Math.min(200, blur) * Math.hypot(t.a, t.b);
  const s = Math.min(1, 8 / Math.max(r, 1), Math.sqrt(GLASS_PIXELS / ((x1 - x0) * (y1 - y0))));
  const w = Math.max(1, Math.ceil((x1 - x0) * s));
  const h = Math.max(1, Math.ceil((y1 - y0) * s));
  const under = newCanvas(w, h);
  const shape = newCanvas(w, h);
  const g = under?.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | null;
  const sg = shape?.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | null;
  if (!under || !g || !sg) return;
  g.drawImage(ctx.canvas as CanvasImageSource, x0, y0, x1 - x0, y1 - y0, 0, 0, w, h);
  const pixels = g.getImageData(0, 0, w, h);
  blurPixels(pixels.data, w, h, r * s);
  sg.setTransform(t.a * s, t.b * s, t.c * s, t.d * s, (t.e - x0) * s, (t.f - y0) * s);
  mask(sg);
  const cut = sg.getImageData(0, 0, w, h).data;
  fullAlpha(cut);
  for (let i = 3; i < cut.length; i += 4) pixels.data[i] = (pixels.data[i]! * cut[i]!) / 255;
  g.putImageData(pixels, 0, 0);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(under as CanvasImageSource, x0, y0, x1 - x0, y1 - y0);
  ctx.restore();
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
  if (l.type === "text") drawText(ctx, l, cast);
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
  // pictures lying loose on the canvas have no ground and no finish of a frame's
  if (!page.loose) {
    ctx.fillStyle = fillOf(ctx, page.background, page.gradient, w, h);
    ctx.fillRect(0, 0, w, h);
  }
  // the frame's box on the canvas: a background blur reads only what is inside it (on the editor's canvas, what is
  // outside is other frames and the canvas itself)
  const area = page.loose ? { x: 0, y: 0, w: Infinity, h: Infinity } : areaOf(ctx.getTransform(), w, h);
  for (const l of page.layers) if (!l.hidden) drawLayer(ctx, l, loaded, page.id, exact, area);
  if (!page.loose) finishFrame(ctx, page, w, h);
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
