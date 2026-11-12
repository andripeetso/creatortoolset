import type { DesignPage, Layer, TextLayer } from "@contracts/design";
import { fontWeightFor } from "@/lib/types";

/**
 * Draws a design's page (contracts/design.ts) on a 2D canvas, in the design's own pixels. The editor's stage and the
 * PNG that is saved are drawn by this one function, so what is saved is what was seen.
 */

/** The CSS font of a text layer at its size (each bundled family is one weight: src/lib/types.ts). */
export const fontOf = (l: Pick<TextLayer, "font" | "size">, scale = 1): string => `${fontWeightFor(l.font)} ${l.size * scale}px "${l.font}"`;
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

function roundedRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}

function drawText(ctx: Ctx, l: TextLayer) {
  ctx.font = fontOf(l);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = l.align;
  const lines = wrapLines(shownText(l), l.w, (s) => ctx.measureText(s).width);
  const lh = lineHeightOf(l);
  const top = l.valign === "middle" ? (l.h - lines.length * lh) / 2 : l.valign === "bottom" ? l.h - lines.length * lh : 0;
  const x = l.align === "center" ? l.w / 2 : l.align === "right" ? l.w : 0;
  lines.forEach((line, k) => {
    // the letters sit in the middle of their line: the baseline is about 0.8 of the letter height under its top
    const y = top + k * lh + (lh - l.size) / 2 + l.size * 0.8;
    if (l.outline) {
      ctx.lineJoin = "round";
      ctx.lineWidth = l.outline.width * 2;
      ctx.strokeStyle = l.outline.color;
      ctx.strokeText(line, x, y);
    }
    ctx.fillStyle = l.color;
    ctx.fillText(line, x, y);
  });
}

function drawLayer(ctx: Ctx, l: Layer, loaded: Loaded) {
  ctx.save();
  ctx.translate(l.x + l.w / 2, l.y + l.h / 2);
  if (l.rotate) ctx.rotate((l.rotate * Math.PI) / 180);
  ctx.translate(-l.w / 2, -l.h / 2);
  ctx.globalAlpha = l.opacity ?? 1;
  if (l.type === "text") drawText(ctx, l);
  else if (l.type === "shape") {
    if (l.shape === "ellipse") {
      ctx.beginPath();
      ctx.ellipse(l.w / 2, l.h / 2, l.w / 2, l.h / 2, 0, 0, Math.PI * 2);
    } else roundedRect(ctx, 0, 0, l.w, l.h, l.radius ?? 0);
    ctx.fillStyle = l.fill;
    ctx.fill();
    if (l.stroke) {
      ctx.lineWidth = l.stroke.width;
      ctx.strokeStyle = l.stroke.color;
      ctx.stroke();
    }
  } else {
    const pic = loaded.get(sourceOf(l)!);
    if (pic && pic.width && pic.height) {
      if (l.type === "image") {
        roundedRect(ctx, 0, 0, l.w, l.h, l.radius ?? 0);
        ctx.clip();
        const k = l.fit === "cover" ? Math.max(l.w / pic.width, l.h / pic.height) : Math.min(l.w / pic.width, l.h / pic.height);
        ctx.drawImage(pic, (l.w - pic.width * k) / 2, (l.h - pic.height * k) / 2, pic.width * k, pic.height * k);
      } else ctx.drawImage(pic, 0, 0, l.w, l.h);
    } else {
      // not loaded (yet, or gone): its place is shown, so nothing is silently missing from the page
      ctx.fillStyle = "rgba(127,127,127,0.25)";
      ctx.fillRect(0, 0, l.w, l.h);
    }
  }
  ctx.restore();
}

export function drawPage(ctx: Ctx, page: DesignPage, w: number, h: number, loaded: Loaded): void {
  ctx.fillStyle = page.background;
  ctx.fillRect(0, 0, w, h);
  for (const l of page.layers) drawLayer(ctx, l, loaded);
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

/** The topmost layer under a point of the page, or null. */
export const layerAt = (page: DesignPage, px: number, py: number): Layer | null => [...page.layers].reverse().find((l) => inLayer(l, px, py).inside) ?? null;
