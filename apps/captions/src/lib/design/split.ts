import { DESIGN_LIMITS, type DesignPage, type ImageLayer, type Layer, type SplitAnswer, type SplitBox, type SplitLine, type TextLayer } from "@contracts/design";
import { everyLayer, freshLayerIds } from "./tree";

/**
 * A picture layer split into layers (POST /api/designs/:id/pictures/:pid/split): in its place on the frame, the picture
 * itself kept hidden ("Original", to set beside what was made of it), what is behind its words and pieces drawn the way
 * the picture was, each piece where it lay, and its words as text that can be changed, one layer a paragraph. The Mac
 * that read the words knows where each line lies, its colour and how heavy its letters are, never the font: heavy
 * letters are set in a bold sans, the others in a regular one, each paragraph shrinking to fit its box.
 * When the frame has no room for all of them (DESIGN_LIMITS.layers), the words come first, then the biggest pieces,
 * and the original last.
 */

/** A line's letters, measured from the top of its box to their baseline, as a part of the font size (the reader's boxes, measured on drawn slides). */
const BASELINE = 0.82;
/** A box the reader gives is about this part of the font size high. */
const SIZE = 0.97;
/** Ink above this (how much of a line's box its letters cover) is set in the bold sans: bold lines read 0.26 to 0.35, regular ones 0.17 to 0.23, measured on drawn slides. */
const INK_BOLD = 0.24;
export const SPLIT_FONTS = { bold: "Inter", regular: "Poppins Regular" } as const;

type Rect = { x: number; y: number; w: number; h: number };

/** Where a box of the picture (fractions of it) is drawn on the frame, the layer's turn left out: through its fit, zoom and focus as the canvas draws it, and its flips. */
function placer(l: ImageLayer, pic: { width: number; height: number }) {
  const k = (l.fit === "cover" ? Math.max(l.w / pic.width, l.h / pic.height) : Math.min(l.w / pic.width, l.h / pic.height)) * (l.zoom ?? 1);
  const c = l.crop;
  const dw = c ? l.w / c.w : pic.width * k;
  const dh = c ? l.h / c.h : pic.height * k;
  const ox = c ? -c.x * dw : (l.w - dw) * (l.focus?.x ?? 0.5);
  const oy = c ? -c.y * dh : (l.h - dh) * (l.focus?.y ?? 0.5);
  return (b: SplitBox): Rect => {
    const r = { x: l.x + ox + b.x * dw, y: l.y + oy + b.y * dh, w: b.w * dw, h: b.h * dh };
    if (l.flipX) r.x = 2 * l.x + l.w - r.x - r.w;
    if (l.flipY) r.y = 2 * l.y + l.h - r.y - r.h;
    return r;
  };
}

/** A box on the frame turned with the layer: its middle goes round the layer's middle, and it takes the layer's turn. */
function turned(l: ImageLayer, r: Rect): Rect & { rotate?: number } {
  if (!l.rotate) return r;
  const a = (l.rotate * Math.PI) / 180;
  const [cx, cy] = [l.x + l.w / 2, l.y + l.h / 2];
  const [dx, dy] = [r.x + r.w / 2 - cx, r.y + r.h / 2 - cy];
  return { ...r, x: cx + dx * Math.cos(a) - dy * Math.sin(a) - r.w / 2, y: cy + dx * Math.sin(a) + dy * Math.cos(a) - r.h / 2, rotate: l.rotate };
}

const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!;
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const far = (a: string, b: string) => Math.hypot(...rgb(a).map((v, i) => v - rgb(b)[i]!));

type Placed = SplitLine & { r: Rect };
/** Lines one under the other with the same colour and size, close together and lined up on one side or their middles, are one paragraph. */
export function paragraphs(lines: Placed[]): Placed[][] {
  const out: Placed[][] = [];
  for (const line of [...lines].sort((a, b) => a.r.y - b.r.y)) {
    const p = out.find((q) => {
      const last = q[q.length - 1]!.r;
      const h = Math.max(last.h, line.r.h);
      const lined = [last.x - line.r.x, last.x + last.w / 2 - (line.r.x + line.r.w / 2), last.x + last.w - (line.r.x + line.r.w)].some((d) => Math.abs(d) < 0.6 * h);
      return far(q[0]!.color, line.color) < 60 && line.r.h / last.h > 0.65 && line.r.h / last.h < 1.5 && line.r.y - (last.y + last.h) < 0.9 * h && line.r.y >= last.y + last.h * 0.5 && lined;
    });
    if (p) p.push(line);
    else out.push([line]);
  }
  return out;
}

/** One paragraph as a text layer: its first line's letters on the baseline they had, its lines as far apart as they were. */
function textLayer(id: string, p: Placed[], l: ImageLayer): TextLayer {
  const size = Math.max(4, Math.round(median(p.map((q) => q.r.h)) * SIZE));
  const pitch = p.length > 1 ? median(p.slice(1).map((q, k) => q.r.y - p[k]!.r.y)) : 0;
  const lineHeight = pitch > 0 ? Math.round((pitch / size) * 100) / 100 : undefined;
  const lh = size * (lineHeight ?? 1.15);
  const spread = (f: (r: Rect) => number) => Math.max(...p.map((q) => f(q.r))) - Math.min(...p.map((q) => f(q.r)));
  const align: TextLayer["align"] = p.length < 2 || spread((r) => r.x) < 0.3 * size ? "left" : spread((r) => r.x + r.w / 2) < 0.3 * size ? "center" : spread((r) => r.x + r.w) < 0.3 * size ? "right" : "left";
  // room for a font a little wider than the one in the picture: the words shrink when it is wider still
  const w = Math.max(...p.map((q) => q.r.w)) * 1.2;
  const left = Math.min(...p.map((q) => q.r.x));
  const right = Math.max(...p.map((q) => q.r.x + q.r.w));
  const x = align === "left" ? left : align === "right" ? right - w : (left + right) / 2 - w / 2;
  const y = p[0]!.r.y + BASELINE * size - (lh - size) / 2 - 0.8 * size;
  const box = turned(l, { x, y, w, h: lh * p.length + size * 0.1 });
  const ink = p.reduce((sum, q) => sum + q.ink, 0) / p.length;
  return {
    id,
    type: "text",
    text: p.map((q) => q.text).join("\n"),
    font: ink > INK_BOLD ? SPLIT_FONTS.bold : SPLIT_FONTS.regular,
    size,
    color: p[0]!.color,
    align,
    fit: "shrink",
    ...(lineHeight ? { lineHeight } : {}),
    ...rounded(box),
  };
}

const rounded = <T extends Rect & { rotate?: number }>(r: T) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.max(1, Math.round(r.w)), h: Math.max(1, Math.round(r.h)), ...(r.rotate ? { rotate: r.rotate } : {}) });

/** The frame with picture layer `layerId` split as `a` says, `pic` being the picture's own size (any size of it: only its shape counts). */
/** `taken`: every layer of the frame however deep in its containers (the page may be a container's layers, tree.ts inScope), so the new ids are the frame's own. */
export function splitLayers(page: DesignPage, layerId: string, pic: { width: number; height: number }, a: SplitAnswer, taken: readonly Layer[] = page.layers): DesignPage {
  const at = page.layers.findIndex((x) => x.id === layerId);
  const l = page.layers[at];
  if (!l || l.type !== "image") return page;
  const place = placer(l, pic);
  // what the layer's box cuts off was not to be seen: what lies there is left out
  const seen = (r: Rect) => r.x + r.w / 2 >= l.x && r.x + r.w / 2 <= l.x + l.w && r.y + r.h / 2 >= l.y && r.y + r.h / 2 <= l.y + l.h;
  const lines = a.lines.map((q) => ({ ...q, r: place(q) })).filter((q) => seen(q.r));
  const paras = paragraphs(lines);
  const pieces = a.pieces.map((p) => ({ ...p, r: place(p) })).filter((p) => seen(p.r));
  // room on the frame: the picture's own place, and what is under the cap
  const room = DESIGN_LIMITS.layers - (everyLayer(taken).length - 1);
  const words = Math.max(0, Math.min(paras.length, room - 1));
  const kept = pieces.map((p, n) => ({ p, n })).sort((x, y) => y.p.w * y.p.h - x.p.w * x.p.h).slice(0, Math.max(0, room - 1 - words)).sort((x, y) => x.n - y.n).map((x) => x.p);
  const original = room - 1 - words - kept.length > 0;
  const ids = freshLayerIds(taken, 1 + kept.length + words, [], page.next);
  const made: Layer[] = [
    ...(original ? [{ ...l, hidden: true, name: "Original" } as Layer] : []),
    { ...l, id: ids[0]!, picture: a.background, uncut: undefined, hidden: undefined, name: "Background" },
    ...kept.map((p, n): Layer => ({ id: ids[1 + n]!, type: "image", picture: p.picture, fit: "contain", name: `Piece ${n + 1}`, ...rounded(turned(l, p.r)), ...(l.flipX ? { flipX: true } : {}), ...(l.flipY ? { flipY: true } : {}) })),
    ...paras.slice(0, words).map((p, n) => textLayer(ids[1 + kept.length + n]!, p, l)),
  ];
  return { ...page, layers: [...page.layers.slice(0, at), ...made, ...page.layers.slice(at + 1)] };
}
