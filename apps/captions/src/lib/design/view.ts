import { useSyncExternalStore } from "react";
import { ZOOM, type View } from "./hands";

/**
 * The canvas's view (where it is scrolled to, how far it is zoomed), held beside the page's own state. A wheel moves it
 * at every picture the screen shows, and only what shows the view (the canvas, the zoom's number) is drawn again for
 * that: the layers list and the panel are not.
 */
export interface ViewStore {
  get: () => View;
  /** Where the view is headed: the end of a glide under way, else where it is. What + and − step on from. */
  aim: () => View;
  /** The view, at once. It ends a glide under way. */
  set: (to: View | ((now: View) => View)) => void;
  /** The view moves to `to` over `ms`, easing out; at once where no pictures are shown (a hidden window) or less motion is asked for. */
  glide: (to: View, ms?: number) => void;
  subscribe: (heard: () => void) => () => void;
}

const same = (a: View, b: View) => a.x === b.x && a.y === b.y && a.z === b.z;

/**
 * The view a part `t` (0 to 1) of the way from `a` to `b`. The zoom grows by equal factors, and the one point of the
 * canvas that is at the same place on the screen in both views stays there all the way: a zoom about the pointer or the
 * middle stays about it instead of swinging past.
 */
export function between(a: View, b: View, t: number): View {
  if (t <= 0) return a;
  if (t >= 1) return b;
  if (a.z === b.z) return { z: a.z, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  const z = a.z * (b.z / a.z) ** t;
  const f = (z - a.z) / (b.z - a.z);
  return { z, x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

/** Nothing would be seen of a glide: no window to show it in, or the person asked for less motion. */
const noGlide = () => typeof document === "undefined" || document.hidden || typeof requestAnimationFrame === "undefined" || !!globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function viewStore(first: View = { x: 0, y: 0, z: 1 }): ViewStore {
  let now = first;
  let heading: View | null = null;
  // every set and every glide takes a turn: a glide stops as soon as the turn is no longer its own
  let turn = 0;
  const heard = new Set<() => void>();
  const put = (next: View) => {
    if (same(next, now)) return;
    now = next;
    for (const h of heard) h();
  };
  return {
    get: () => now,
    aim: () => heading ?? now,
    set: (to) => {
      turn++;
      heading = null;
      put(typeof to === "function" ? to(now) : to);
    },
    glide: (to, ms = 160) => {
      const mine = ++turn;
      if (noGlide() || same(to, now)) {
        heading = null;
        return put(to);
      }
      const from = now;
      const began = performance.now();
      heading = to;
      const end = () => {
        if (turn !== mine) return;
        heading = null;
        put(to);
      };
      // the end is reached even when no picture of the screen ever comes (a window that is there but never drawn)
      const sure = setTimeout(end, ms + 150);
      const frame = (at: number) => {
        if (turn !== mine) return void clearTimeout(sure);
        const part = Math.max(0, Math.min(1, (at - began) / ms));
        if (part >= 1) return void (clearTimeout(sure), end());
        put(between(from, to, 1 - (1 - part) ** 3));
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    },
    subscribe: (h) => (heard.add(h), () => void heard.delete(h)),
  };
}

export const useView = (s: ViewStore): View => useSyncExternalStore(s.subscribe, s.get);
/** The zoom alone: what shows only its number is not drawn again when the canvas is scrolled. */
export const useZoom = (s: ViewStore): number => useSyncExternalStore(s.subscribe, () => s.get().z);

/** The zooms that + and − stop at. */
export const ZOOM_STOPS = [0.02, 0.03, 0.06, 0.13, 0.25, 0.5, 1, 2, 4, 8, 16, 32] as const;
/** The next stop in from `z` (`in` true) or out from it; at the last one, the far end. */
export function zoomStop(z: number, closer: boolean): number {
  // a zoom a hair off a stop (0.4999) is on it
  const off = z * 0.001;
  return closer ? (ZOOM_STOPS.find((s) => s > z + off) ?? ZOOM.max) : ([...ZOOM_STOPS].reverse().find((s) => s < z - off) ?? ZOOM.min);
}

/** The picture of a frame that is kept: the content it was made of, and its device pixels per design pixel. */
export interface KeptFrame {
  content: string;
  scale: number;
}
/** Device pixels one frame's kept picture may have (about 16 MB), and the longest side a canvas is given. */
export const FRAME_PIXELS = 4_000_000;
const LONGEST = 8192;
/** The finest scale a frame of this size is kept at. */
export const keptScale = (w: number, h: number): number => Math.min(Math.sqrt(FRAME_PIXELS / (w * h)), LONGEST / Math.max(w, h));

/**
 * How one frame gets onto the canvas for one drawing.
 *   "kept"    its kept picture is put there (stretched when its scale is not the one asked for)
 *   "make"    its picture is made at `scale` first, then put there
 *   "direct"  it is drawn straight onto the canvas, exactly, and nothing is kept
 * While something moves, a kept picture of the same content is used as long as it is no more than four times too
 * coarse, so a zoom that glides makes no picture on the way. `exact` (nothing has moved for a moment) wants every
 * pixel right: a picture at the very scale, or the frame drawn directly when a picture that fine would be too big. A
 * frame too big to keep at its scale (zoomed far into) is drawn directly whenever the view is still, and kept coarse
 * only for a view that moves.
 */
export function framePlan(o: { want: number; finest: number; content: string; had: KeptFrame | undefined; viewMoved: boolean; exact: boolean }): { how: "kept" | "make"; scale: number } | { how: "direct" } {
  const fits = o.want <= o.finest;
  const mine = o.had?.content === o.content ? o.had : undefined;
  if (!fits && (o.exact || !o.viewMoved)) return { how: "direct" };
  if (o.exact) return mine?.scale === o.want ? { how: "kept", scale: o.want } : { how: "make", scale: o.want };
  const scale = Math.min(o.want, o.finest);
  return mine && mine.scale >= scale / 4 ? { how: "kept", scale: mine.scale } : { how: "make", scale };
}
