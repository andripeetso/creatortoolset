import type { Effect, Layer } from "@contracts/design";
import { blurPixels, blurredRows, mixed } from "./retouch";

/**
 * A layer's effects (contracts/design.ts Effect), worked pixel by pixel: the Mac app's browser has no blur of a
 * canvas's own, so every blur here is retouch.ts blurPixels, the same on every machine. draw.ts lays the results in
 * place. Every function works on RGBA bytes as a canvas gives them (colours not weighed by their alpha).
 */

/** A layer's effects as a list: its own, or the shadow and the blur it had before it had a list (a picture's blur is one of its colour changes, not an effect). */
export function effectsOf(l: Layer): Effect[] {
  if (l.effects) return l.effects;
  const out: Effect[] = [];
  if (l.shadow) out.push({ type: "shadow", ...l.shadow });
  if (l.blur && l.type !== "image") out.push({ type: "blur", blur: l.blur });
  return out;
}

/** The layer with this list as its effects, the old fields it stands for taken off (a picture keeps its own blur). */
export const withEffects = (l: Layer, list: Effect[]): Layer => ({ ...l, effects: list.length ? list : undefined, shadow: undefined, ...(l.type === "image" ? {} : { blur: undefined }) }) as Layer;

/** Whether a layer with these (shown) effects is painted in a box of its own and worked there: a shadow and a background blur alone are not. */
export const worksPixels = (fx: readonly Effect[]): boolean => fx.some((e) => e.type === "inner-shadow" || e.type === "noise" || ((e.type === "blur" || e.type === "progressive-blur") && e.blur > 0));

/** How far a layer's own pixels spread past its box: what its blurs reach, in design pixels. */
export const reachOf = (fx: readonly Effect[]): number => Math.ceil(Math.max(0, ...fx.map((e) => (e.type === "blur" ? Math.min(200, e.blur) * 3 : 0))));

const rgbOf = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

/**
 * The alpha of every pixel grown (r > 0) or shrunk (r < 0) by r pixels each way: a square's worth, the largest (or the
 * smallest) alpha within it, a row at a time and then a column at a time, at a cost that does not grow with r. What
 * lies past the edges counts as see-through. Colours are left alone.
 */
export function spreadAlpha(data: Uint8ClampedArray, w: number, h: number, r: number): void {
  const n = Math.round(Math.abs(r));
  if (!n) return;
  const op = r > 0 ? Math.max : Math.min;
  const span = 2 * n + 1;
  const most = Math.max(w, h);
  const pad = most + 2 * n;
  const src = new Uint8Array(most);
  const out = new Uint8Array(most);
  const pre = new Uint8Array(pad);
  const suf = new Uint8Array(pad);
  /** One line of `len` pixels: each the largest (smallest) within n of it, in blocks of `span` (prefix and suffix runs). */
  const line = (len: number) => {
    const end = len + 2 * n;
    const v = (i: number) => (i < n || i >= len + n ? 0 : src[i - n]!);
    for (let i = 0; i < end; i++) pre[i] = i % span === 0 ? v(i) : op(pre[i - 1]!, v(i));
    for (let i = end - 1; i >= 0; i--) suf[i] = i % span === span - 1 || i === end - 1 ? v(i) : op(suf[i + 1]!, v(i));
    for (let x = 0; x < len; x++) out[x] = op(suf[x]!, pre[x + 2 * n]!);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) src[x] = data[(y * w + x) * 4 + 3]!;
    line(w);
    for (let x = 0; x < w; x++) data[(y * w + x) * 4 + 3] = out[x]!;
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) src[y] = data[(y * w + x) * 4 + 3]!;
    line(h);
    for (let y = 0; y < h; y++) data[(y * w + x) * 4 + 3] = out[y]!;
  }
}

/**
 * An inner shadow laid on a layer's pixels: the outside of its shape moved by (dx, dy), grown by `spread`, blurred, in
 * its colour, over the layer only where the layer is (its alpha stays as it was). All numbers in these pixels.
 */
export function innerShadow(data: Uint8ClampedArray, w: number, h: number, e: { color: string; opacity: number; blur: number; spread?: number }, dx: number, dy: number): void {
  const mask = new Uint8ClampedArray(w * h * 4);
  const ox = Math.round(dx);
  const oy = Math.round(dy);
  for (let y = 0; y < h; y++) {
    const sy = y - oy;
    for (let x = 0; x < w; x++) {
      const sx = x - ox;
      mask[(y * w + x) * 4 + 3] = 255 - (sx >= 0 && sx < w && sy >= 0 && sy < h ? data[(sy * w + sx) * 4 + 3]! : 0);
    }
  }
  if (e.spread) spreadAlpha(mask, w, h, e.spread);
  if (e.blur > 0) blurPixels(mask, w, h, e.blur);
  const [r, g, b] = rgbOf(e.color);
  for (let i = 0; i < w * h * 4; i += 4) {
    if (!data[i + 3]) continue;
    const k = (mask[i + 3]! / 255) * e.opacity;
    data[i] = data[i]! + (r - data[i]!) * k;
    data[i + 1] = data[i + 1]! + (g - data[i + 1]!) * k;
    data[i + 2] = data[i + 2]! + (b - data[i + 2]!) * k;
  }
}

/**
 * Grain on a layer's pixels: each grain `size` pixels across a shade lighter or darker, up to `amount` (1 to 100),
 * where the layer is. `x0`, `y0`: where the layer's box starts in these pixels, so the grains stay on the layer
 * wherever it is drawn. Its alpha stays as it was.
 */
export function addNoise(data: Uint8ClampedArray, w: number, h: number, amount: number, size: number, x0: number, y0: number): void {
  const k = (Math.min(100, Math.max(0, amount)) / 100) * 160;
  const s = Math.max(1, size);
  for (let y = 0; y < h; y++) {
    const gy = Math.floor((y - y0) / s);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (!data[i + 3]) continue;
      const d = (mixed(Math.floor((x - x0) / s), gy) - 0.5) * k;
      data[i] = data[i]! + d;
      data[i + 1] = data[i + 1]! + d;
      data[i + 2] = data[i + 2]! + d;
    }
  }
}

/**
 * A blur that grows across the layer: none up to `from` and all of `blur` from `to`, as parts of the box (x0, y0,
 * bw, bh in these pixels) along `angle` (0 left to right, 90 top to bottom). Worked as the layer blurred a quarter, a
 * half and fully, each pixel taken between the two nearest, so the blur grows and no picture shows through another.
 * The layer's edges stay where they are (its alpha is kept). The blurred levels are read a row at a time (retouch.ts
 * blurredRows) and the sharp one is the layer itself, so a wide blur keeps no full-size copy (a saved file may be
 * worked at tens of millions of pixels).
 */
export function progressiveBlur(data: Uint8ClampedArray, w: number, h: number, e: { blur: number; from: number; to: number; angle: number }, box: { x: number; y: number; w: number; h: number }): void {
  if (e.blur <= 0) return;
  // every level made from the layer before any pixel of it changes
  const levels = [0.25, 0.5, 1].map((f) => blurredRows(data, w, h, e.blur * f));
  const rows = levels.map(() => new Uint8ClampedArray(w * 4));
  const ts = new Float32Array(w);
  const a = (e.angle * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const half = (Math.abs(cos) * box.w + Math.abs(sin) * box.h) / 2 || 1;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const from = Math.min(e.from, e.to);
  const to = Math.max(e.from, e.to);
  for (let y = 0; y < h; y++) {
    let any = false;
    for (let x = 0; x < w; x++) {
      const along = ((x + 0.5 - cx) * cos + (y + 0.5 - cy) * sin) / (2 * half) + 0.5;
      ts[x] = to > from ? Math.min(1, Math.max(0, (along - from) / (to - from))) : along >= from ? 1 : 0;
      if (ts[x]) any = true;
    }
    if (!any) continue;
    const row = y * w * 4;
    // a level's row starts as the layer's own, as a blurred copy of the whole layer did where it blurred to nothing
    rows.forEach((r, j) => {
      r.set(data.subarray(row, row + w * 4));
      levels[j]!(y, r, 0);
    });
    for (let x = 0; x < w; x++) {
      const t = ts[x]!;
      if (!t) continue;
      const i = row + x * 4;
      const at = t * 3;
      const lo = Math.min(2, Math.floor(at));
      const f = at - lo;
      // the sharp level is the layer's own pixel, not yet changed
      const p = lo ? rows[lo - 1]! : data;
      const pi = lo ? x * 4 : i;
      const q = rows[lo]!;
      const qi = x * 4;
      data[i] = p[pi]! + (q[qi]! - p[pi]!) * f;
      data[i + 1] = p[pi + 1]! + (q[qi + 1]! - p[pi + 1]!) * f;
      data[i + 2] = p[pi + 2]! + (q[qi + 2]! - p[pi + 2]!) * f;
    }
  }
}

/** A mask's alpha made whole where it is anything: each pixel's over the strongest (a see-through glass panel still blurs all that is under it), edges kept soft. */
export function fullAlpha(data: Uint8ClampedArray): void {
  let peak = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i]! > peak) peak = data[i]!;
  if (!peak || peak === 255) return;
  for (let i = 3; i < data.length; i += 4) data[i] = (data[i]! * 255) / peak;
}
