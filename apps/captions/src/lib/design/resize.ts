import type { DesignPage, Layer, Pin } from "../../../contracts/design";
import { withFills } from "./paint";

/**
 * A frame that changes size, and its layers with it: each follows the frame's edges as its pin says (contracts/design.ts
 * Pin). Pure maths, read by the server too (an AI's resize and copies, api/designs.ts): nothing here may touch the DOM.
 */

interface Rect {
  x?: number;
  y?: number;
  w: number;
  h: number;
}
export type Placed = { x: number; y: number; w: number; h: number; pin?: Pin };

const round = (n: number) => Math.round(n * 100) / 100;

/** One side of a layer (`at`, `size`) in a frame `from` long that is now `to` long, as `mode` pins it. */
export function pinAxis(mode: string | undefined, at: number, size: number, from: number, to: number): [number, number] {
  const grow = to - from;
  const k = from > 0 ? to / from : 1;
  if (mode === "right" || mode === "bottom") return [at + grow, size];
  if (mode === "both") return [at, Math.max(1, size + grow)];
  if (mode === "center") return [at + grow / 2, size];
  if (mode === "scale") return [at * k, size * k];
  return [at, size];
}

/**
 * Unpinned, in a copy of another size: the layer keeps its shape, grown or shrunk by the lesser of the two changes
 * (its words and lines with it), and its middle keeps its share of the frame. A layer across the whole frame (a
 * background picture) stretches along that side instead.
 */
function shareAxis(at: number, size: number, from: number, to: number, k: number): [number, number] {
  const s = from > 0 ? to / from : 1;
  if (at <= 0 && at + size >= from) return [at * s, size * s];
  const middle = (at + size / 2) * s;
  return [middle - (size * k) / 2, size * k];
}

/** What a layer draws scaled by `k`: its words' size, its lines, corners, shadow and blur. */
function scaled<L extends Layer>(l: L, k: number): L {
  if (k === 1) return l;
  const out: Layer = { ...l };
  if (out.shadow) out.shadow = { ...out.shadow, blur: round(out.shadow.blur * k), x: round(out.shadow.x * k), y: round(out.shadow.y * k) };
  if (out.blur) out.blur = Math.max(1, Math.round(out.blur * k));
  if (out.type === "text") {
    out.size = round(Math.max(8, out.size * k));
    if (out.spacing) out.spacing = round(out.spacing * k);
    if (out.outline) out.outline = { ...out.outline, width: round(out.outline.width * k) };
  }
  if ((out.type === "shape" || out.type === "path") && out.stroke) out.stroke = { ...out.stroke, width: round(out.stroke.width * k) };
  if (out.type !== "drawing" && out.strokes) out.strokes = out.strokes.map((s) => ({ ...s, width: round(s.width * k), ...(s.sides ? { sides: s.sides.map((n) => round(n * k)) as [number, number, number, number] } : {}) }));
  if ((out.type === "shape" || out.type === "image") && out.radius !== undefined) out.radius = typeof out.radius === "number" ? round(out.radius * k) : (out.radius.map((r) => round(r * k)) as [number, number, number, number]);
  return out as L;
}

/**
 * A frame's layers as the frame goes from `from` to `to` (its place on the canvas and its size). A pinned side follows
 * its pin. An unpinned side: `"stay"` (resized by hand or an AI) leaves it where it is on the canvas, so pulling the
 * frame's left edge moves the frame's corner under it; `"share"` (a copy in another size) places it by its share of
 * the frame, as shareAxis says.
 */
export function placeLayers<L extends Placed>(layers: readonly L[], from: Rect, to: Rect, unpinned: "stay" | "share"): L[] {
  const sx = from.w > 0 ? to.w / from.w : 1;
  const sy = from.h > 0 ? to.h / from.h : 1;
  const k = Math.min(sx, sy);
  const dx = (to.x ?? 0) - (from.x ?? 0);
  const dy = (to.y ?? 0) - (from.y ?? 0);
  return layers.map((l) => {
    if (![l.x, l.y, l.w, l.h].every((n) => typeof n === "number" && Number.isFinite(n))) return l;
    const pin = l.pin && typeof l.pin === "object" ? l.pin : {};
    const free = (at: number, size: number, a: number, b: number, shift: number): [number, number] => (unpinned === "stay" ? [at - shift, size] : shareAxis(at, size, a, b, k));
    const [x, w] = pin.x ? pinAxis(pin.x, l.x, l.w, from.w, to.w) : free(l.x, l.w, from.w, to.w, dx);
    const [y, h] = pin.y ? pinAxis(pin.y, l.y, l.h, from.h, to.h) : free(l.y, l.h, from.h, to.h, dy);
    const moved = { ...l, x: round(x), y: round(y), w: round(w), h: round(h) };
    // a copy scales what a layer draws with it when the layer was scaled whole (no side pinned or stretched across)
    const across = (at: number, size: number, of: number) => at <= 0 && at + size >= of;
    const whole = unpinned === "share" && !pin.x && !pin.y && !across(l.x, l.w, from.w) && !across(l.y, l.h, from.h);
    return whole && "type" in l ? (scaled(moved as unknown as Layer, k) as unknown as L) : moved;
  });
}

/** A frame with a new size (and place), its layers following it as placeLayers says. */
export function resized(page: DesignPage, to: Rect, unpinned: "stay" | "share" = "stay"): DesignPage {
  const from = { x: page.x ?? 0, y: page.y ?? 0, w: page.w ?? to.w, h: page.h ?? to.h };
  const at = { x: to.x ?? from.x, y: to.y ?? from.y, w: Math.round(to.w), h: Math.round(to.h) };
  return { ...page, ...at, layers: placeLayers(page.layers, from, at, unpinned) };
}

/** A copy of a frame in another size, its layers placed by their pins and their share of it; the copy draws no slide of its own. */
export function sizedCopy(page: DesignPage, size: { w: number; h: number }, id: string, name?: string): DesignPage {
  const { block: _slide, ...rest } = resized(page, { w: size.w, h: size.h }, "share");
  return { ...rest, id, ...(name ? { name } : {}) };
}

/**
 * One row of data onto a copy of a frame: each key but `name` names layers (by their name, any case), and a string or
 * number sets a text's words, `{ text?, visible?, color? }` more. `name` names the copy. Answers the keys no layer has.
 */
export function fillRow(page: DesignPage, row: Record<string, unknown>): { page: DesignPage; missing: string[] } {
  const missing: string[] = [];
  let layers = page.layers;
  for (const [key, v] of Object.entries(row)) {
    if (key === "name") continue;
    const want = key.trim().toLowerCase();
    const hit = (l: Layer) => (l.name ?? "").trim().toLowerCase() === want;
    if (!layers.some(hit)) {
      missing.push(key);
      continue;
    }
    const set: { text?: string; visible?: boolean; color?: string } = typeof v === "string" || typeof v === "number" ? { text: String(v) } : v && typeof v === "object" ? (v as typeof set) : {};
    layers = layers.map((l): Layer => {
      if (!hit(l)) return l;
      let out: Layer = { ...l };
      if (typeof set.visible === "boolean") out = { ...out, hidden: set.visible ? undefined : true };
      if (out.type === "text" && typeof set.text === "string") out = { ...out, text: set.text };
      // a layer with a list of fills takes the colour as its one fill
      if (typeof set.color === "string") out = (out.type === "text" || out.type === "shape") && out.fills ? withFills(out, [{ type: "solid", color: set.color }]) : out.type === "text" ? { ...out, color: set.color } : out.type === "shape" ? { ...out, fill: set.color } : out;
      return out;
    });
  }
  return { page: { ...page, layers, ...(typeof row.name === "string" && row.name.trim() ? { name: row.name.trim() } : {}) }, missing };
}
