// A shot-list edit's V1 shot as the renderer draws it, for the player (components/nle/NlePlayer.tsx). Checked against
// the renderer's own answers in shots.fixture.json. Such a shot is not one placed picture (picture.ts `placement`): its
// source covers the frame through a window (`fit_x` 0 left … 1 right, `fit_y` 0 top … 1 bottom), or it is composed first
// at the frame's size with a `frame` size (fit: whole on black; blur: whole over a darkened blur of itself; letterbox: a
// 2:1 band; inset: `scale` of the width in a white edge over the shot before, `under`, darkened and blurred) or a `split`
// (one to two more pictures stacked in rows); then the frame is zoomed, `zoom` → `zoom_to`, `pan` → `pan_to`, `tilt` →
// `tilt_to` over the shot's part `move` of the curve (eased unless `ease` is "linear"), kept inside the picture. A
// `freeze` holds its first frame, `rev` plays its frames backwards, `speed` faster.
// Which shots go this way and which are placed as a person placed them: `drawnAsShot`, the renderer's own choice.

import type { NleItem } from "./model";

export type Rect = [number, number, number, number];
/** a source in a shot: the clip's own, the shot before it (`under`), or split row 1 or 2 */
export type Pic = "main" | "under" | 1 | 2;
export interface ShotOp {
  pic: Pic;
  /** the part of the source (source px) … */
  src: Rect;
  /** … drawn here on the composed frame (frame px) */
  dst: Rect;
  /** drawn small (w × h), blurred (sigma at that size), darkened by `dim` (0–1 of white) and scaled up */
  bg?: { w: number; h: number; sigma: number; dim: number };
  /** a white edge this wide (frame px) round it */
  edge?: number;
}
/** what to draw for a shot at one frame: `ops` onto a black frame, then its `view` rect stretched over the whole frame */
export interface ShotPlan {
  ops: ShotOp[];
  view: Rect;
}

type Part = { src: string; in: number; fit_x?: number; fit_y?: number };
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** Python's round (half to even), as the renderer rounds */
const pyRound = (x: number) => {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 ? r - 1 : r;
};
const even = (x: number) => Math.max(2, pyRound(x / 2) * 2);
/** the renderer's picture size (preview.SIZE): sizes and edges are worked out there, then scaled to the timeline */
const OUT_W = 1080;

export const shotParts = (it: NleItem) => ({
  under: (it.under && typeof it.under === "object" ? (it.under as Part) : null),
  split: (Array.isArray(it.split) ? (it.split as Part[]).slice(0, 2) : []),
});

/** A picture the shot-list paths don't draw (preview.hand): turned, mirrored, cut, see-through, smaller than the frame or moved past its edge. */
export function placedByHand(it: NleItem, W: number, H: number): boolean {
  const z = num(it.zoom, 1);
  return !!it.rot || !!it.flip || (it.crop ?? []).some((v) => Number(v)) || num(it.opacity, 1) < 1
    || z < 1 || Math.abs(num(it.pan, 0)) > ((z - 1) * W) / 2 + 0.5 || Math.abs(num(it.tilt, 0)) > ((z - 1) * H) / 2 + 0.5;
}

/** Whether the renderer draws this clip as a shot-list shot (shotPlan) rather than placed (placement): V1 only. */
export function drawnAsShot(it: NleItem, track: string, W: number, H: number): boolean {
  if (track !== "V1") return false;
  if (it.frame || shotParts(it).split.length) return true;
  return !placedByHand(it, W, H) || "zoom_to" in it || "fit_x" in it || "fit_y" in it;
}

/** edits.ease: the smooth zoom's curve */
export const ease = (u: number) => {
  u = clamp(u, 0, 1);
  return u < 0.5 ? 16 * u ** 5 : 1 - (2 - 2 * u) ** 5 / 2;
};

/** Zoom, pan and tilt `k` frames into the shot (a smooth zoom on its curve, else its own; never under 1 while it moves). */
export function framingAt(it: NleItem, k: number): [number, number, number] {
  const z = num(it.zoom, 1), p = num(it.pan, 0), t = num(it.tilt, 0);
  if (!("zoom_to" in it)) return [z, p, t];
  const [u0, u1] = Array.isArray(it.move) ? (it.move as number[]) : [0, 1];
  const u = u0 + ((u1 - u0) * k) / Math.max(it.len, 1);
  const g = it.ease === "linear" ? clamp(u, 0, 1) : ease(u);
  const lerp = (a: number, b: number) => a + (b - a) * g;
  // the renderer's zoompan keeps its zoom at 1 or more
  return [Math.max(1, lerp(z, num(it.zoom_to, z))), lerp(p, num(it.pan_to, p)), lerp(t, num(it.tilt_to, t))];
}

/** The w × h window of a source covering it, at fit_x / fit_y (centred when unset), in source px. */
function windowOf(sw: number, sh: number, w: number, h: number, fx?: unknown, fy?: unknown): Rect {
  const s = Math.max(w / sw, h / sh);
  return [((sw * s - w) * num(fx, 0.5)) / s, ((sh * s - h) * num(fy, 0.5)) / s, w / s, h / s];
}
/** The whole source inside a w × h box, centred: [x, y, w, h] in the box. */
function fitIn(sw: number, sh: number, w: number, h: number): Rect {
  const s = Math.min(w / sw, h / sh);
  return [(w - sw * s) / 2, (h - sh * s) / 2, sw * s, sh * s];
}

/**
 * What the renderer draws for a shot-list V1 shot `k` frames into it (preview._picture, _composed, _bg, _window, _crop,
 * _zoom). `size` gives a source's picture size (null: not known yet; that part is left out).
 */
export function shotPlan(it: NleItem, k: number, size: (pic: Pic) => [number, number] | null, W: number, H: number): ShotPlan {
  const ow = OUT_W;
  const oh = Math.round((OUT_W * H) / W);
  const sc = W / ow;
  const ops: ShotOp[] = [];
  const add = (pic: Pic, src: Rect, dst: Rect, more: Partial<ShotOp> = {}) =>
    ops.push({ pic, src, dst: dst.map((v) => v * sc) as Rect, ...more });
  const main = size("main");
  const { under, split } = shotParts(it);
  const bg = (pic: Pic, wh: [number, number], kind: "blur" | "inset") => {
    const [bw, bh] = [even(ow / 8), even(oh / 8)];
    add(pic, windowOf(wh[0], wh[1], bw, bh), [0, 0, ow, oh], { bg: { w: bw, h: bh, sigma: kind === "blur" ? 3 : 2, dim: kind === "blur" ? 0.15 : 0.18 } });
  };
  if (split.length) {
    const n = 1 + split.length;
    const bh = even(oh / n);
    [it as Part, ...split].forEach((x, j) => {
      const wh = j ? size(j as 1 | 2) : main;
      // the rows are stacked (n × bh tall) and the stack scaled to the frame
      if (wh) add(j ? (j as 1 | 2) : "main", windowOf(wh[0], wh[1], ow, bh, x.fit_x, x.fit_y), [0, (j * oh) / n, ow, oh / n]);
    });
  } else if (it.frame && main) {
    const frame = it.frame === "inset" && !under ? "blur" : it.frame;
    if (frame === "fit") add("main", [0, 0, main[0], main[1]], fitIn(main[0], main[1], ow, oh));
    else if (frame === "letterbox") {
      const bh = even(ow / 2);
      add("main", windowOf(main[0], main[1], ow, bh, it.fit_x, it.fit_y), [0, (oh - bh) / 2, ow, bh]);
    } else if (frame === "inset") {
      const wh = size("under");
      if (wh) bg("under", wh, "inset");
      const iw = even(ow * num(it.scale, 0.6));
      const ih = even((main[1] * iw) / main[0]);
      add("main", [0, 0, main[0], main[1]], [(ow - iw) / 2, (oh - ih) / 2, iw, ih], { edge: 6 * sc });
    } else {
      bg("main", main, "blur");
      add("main", [0, 0, main[0], main[1]], fitIn(main[0], main[1], ow, oh));
    }
  } else if (main) add("main", windowOf(main[0], main[1], ow, oh, it.fit_x, it.fit_y), [0, 0, ow, oh]);
  // then the frame zoomed (_crop / _zoom): a window W/z × H/z kept inside it
  const [z, p, t] = framingAt(it, k);
  const [cw, ch] = [W / z, H / z];
  return { ops, view: [clamp(W / 2 - (W / 2 + p) / z, 0, W - cw), clamp(H / 2 - (H / 2 - t) / z, 0, H - ch), cw, ch] };
}

/** Seconds into its file each picture of a V1 shot shows `k` frames into it (a freeze holds, a reversed shot runs back). */
export function shotTime(it: NleItem, pic: Pic, k: number, fps: number, srcFps: (src: string) => number): number {
  const { under, split } = shotParts(it);
  const part = pic === "main" ? null : pic === "under" ? under : split[pic - 1];
  if (part) return part.in / srcFps(part.src) + k / fps; // the others play on at their own speed
  const start = it.in / srcFps(it.src);
  const speed = num(it.speed, 1);
  if (it.freeze) return start;
  return start + ((it.rev ? Math.max(0, it.len - 1 - k) : k) * speed) / fps;
}

/** A shot's source for each of its pictures. */
export const shotSource = (it: NleItem, pic: Pic): string | null => {
  const { under, split } = shotParts(it);
  return pic === "main" ? it.src : pic === "under" ? (under?.src ?? null) : (split[pic - 1]?.src ?? null);
};

/** The looks a shot shows `k` frames into it that the player draws (preview._looks: blur, invert), as a canvas filter. */
export function lookFilter(it: NleItem, k: number, W: number): string {
  const out: string[] = [];
  for (const l of Array.isArray(it.look) ? (it.look as [string, number, number, number][]) : []) {
    const [kind, a, n, amt] = l;
    if (k < a || k > a + n - 1) continue;
    if (kind === "invert") out.push("invert(1)");
    if (kind === "blur") out.push(`blur(${((8 * amt * W) / OUT_W).toFixed(1)}px)`);
  }
  return out.join(" ");
}

