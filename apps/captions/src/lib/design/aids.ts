import { useSyncExternalStore } from "react";
import { DESIGN_SAFE, type DesignGrid, type DesignPage, type DesignSafe } from "@contracts/design";
import type { Rect } from "./hands";

/**
 * The designer's aids on a frame: ruler guides, layout grids and where a social app cuts or covers the picture. All
 * in the frame's own pixels; shown on the canvas only (components/design/Aids.tsx), never in a saved picture. Layers
 * moved in a frame catch on them through the same snapMove targets as on its edges (aidTargets).
 */

/** Far off on the other axis: a line given to snapMove as a box of no size catches on one axis only. */
const FAR = -1e9;
const vertical = (x: number): Rect => ({ x, y: FAR, w: 0, h: 0 });
const horizontal = (y: number): Rect => ({ x: FAR, y, w: 0, h: 0 });
/** More lines than this in a square grid are shown but not caught on (a 1-pixel grid would be thousands of targets). */
const MOST_LINES = 400;

/** A layout grid laid on a frame: its columns or rows as bands, and every line of it (band edges, cell lines). */
export function gridOf(g: DesignGrid, w: number, h: number): { bands: Rect[]; x: number[]; y: number[] } {
  if (g.kind === "grid") {
    const size = Math.max(1, g.size ?? 10);
    const along = (length: number) => Array.from({ length: Math.floor(length / size) + 1 }, (_, n) => n * size);
    return { bands: [], x: along(w), y: along(h) };
  }
  const across = g.kind === "columns" ? w : h;
  const count = Math.max(1, g.count ?? 1);
  const margin = Math.min(g.margin ?? 0, across / 2);
  const gutter = g.gutter ?? 0;
  const size = Math.max(0, (across - 2 * margin - gutter * (count - 1)) / count);
  const starts = Array.from({ length: count }, (_, n) => margin + n * (size + gutter));
  const bands = starts.map((s) => (g.kind === "columns" ? { x: s, y: 0, w: size, h } : { x: 0, y: s, w, h: size }));
  const lines = starts.flatMap((s) => [s, s + size]);
  return g.kind === "columns" ? { bands, x: lines, y: [] } : { bands, x: [], y: lines };
}

/** Where a social app shows a frame (`safe`) and the parts it cuts off or lays its buttons and words over (`covered`). */
export function safeOf(id: DesignSafe, w: number, h: number): { safe: Rect; covered: Rect[] } {
  const z = DESIGN_SAFE.find((s) => s.id === id)!;
  if ("crop" in z) {
    // taller than the crop: its top and bottom go; wider: its sides
    if (w / h < z.crop) {
      const shown = w / z.crop;
      const cut = (h - shown) / 2;
      return { safe: { x: 0, y: cut, w, h: shown }, covered: [{ x: 0, y: 0, w, h: cut }, { x: 0, y: h - cut, w, h: cut }] };
    }
    const shown = h * z.crop;
    const cut = (w - shown) / 2;
    return { safe: { x: cut, y: 0, w: shown, h }, covered: cut > 0 ? [{ x: 0, y: 0, w: cut, h }, { x: w - cut, y: 0, w: cut, h }] : [] };
  }
  const { top, bottom, left, right } = z.inset;
  const safe = { x: w * left, y: h * top, w: w * (1 - left - right), h: h * (1 - top - bottom) };
  return {
    safe,
    covered: [
      { x: 0, y: 0, w, h: safe.y },
      { x: 0, y: safe.y + safe.h, w, h: h - safe.y - safe.h },
      { x: 0, y: safe.y, w: safe.x, h: safe.h },
      { x: safe.x + safe.w, y: safe.y, w: w - safe.x - safe.w, h: safe.h },
    ],
  };
}

/** What a layer moved in this frame catches on beside its edges and layers: its guides, its shown grids' lines and its safe parts' edges. */
export function aidTargets(page: Pick<DesignPage, "guides" | "grids" | "safe">, w: number, h: number, grids = aidPrefs().grids): Rect[] {
  const out: Rect[] = (page.guides ?? []).map((g) => (g.axis === "x" ? vertical(g.at) : horizontal(g.at)));
  for (const g of grids ? (page.grids ?? []) : []) {
    if (g.hidden) continue;
    const { x, y } = gridOf(g, w, h);
    if (x.length + y.length > 2 * MOST_LINES) continue;
    out.push(...x.map(vertical), ...y.map(horizontal));
  }
  for (const id of page.safe ?? []) out.push(safeOf(id, w, h).safe);
  return out;
}

/** The marks along a ruler from `from` to `to` (canvas pixels shown at zoom `z`): a step of 1, 2 or 5 times a power of ten, at least 50 screen pixels apart, each numbered. */
export function rulerTicks(from: number, to: number, z: number): { step: number; at: number[] } {
  const want = 50 / z;
  const ten = 10 ** Math.floor(Math.log10(Math.max(want, 1e-6)));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * ten).find((s) => s >= want) ?? 10 * ten);
  const at: number[] = [];
  for (let v = Math.ceil(from / step) * step; v <= to && at.length < 500; v += step) at.push(v + 0); // + 0: no -0 label
  return { step, at };
}

/** The zoom from which every pixel of a frame is outlined (when the pixel grid is on). */
export const PIXEL_GRID_FROM = 4;

/** What this viewer shows: rulers, the frames' layout grids, the pixel grid. Kept in this browser only (a preference, not the design's). */
export interface AidPrefs {
  rulers: boolean;
  grids: boolean;
  pixels: boolean;
}
const KEY = "ct-design-aids";
const DEFAULTS: AidPrefs = { rulers: false, grids: true, pixels: true };
let prefs: AidPrefs = (() => {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<AidPrefs>) };
  } catch {
    return DEFAULTS;
  }
})();
const heard = new Set<() => void>();
export const aidPrefs = (): AidPrefs => prefs;
export function setAidPref(k: keyof AidPrefs, on: boolean = !prefs[k]): void {
  prefs = { ...prefs, [k]: on };
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // a private window keeps it until the page closes
  }
  heard.forEach((f) => f());
}
export const useAidPrefs = (): AidPrefs =>
  useSyncExternalStore(
    (f) => (heard.add(f), () => void heard.delete(f)),
    aidPrefs,
    aidPrefs,
  );
