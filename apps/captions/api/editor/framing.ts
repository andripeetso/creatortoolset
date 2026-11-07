import type { TimelineSource } from "../../contracts/editor";

/**
 * Punch-ins without face detection: every cut on the speaker track changes scale (1.0 ↔ punch), pan stays 0, and the
 * tilt keeps the eye line the user set for each source at the same screen height, clamped so no edge shows.
 */

/** The most a source may be punched in: 2.0 from 4K (a short side of 2160 px), else 1.5. */
export const maxPunch = (src: Pick<TimelineSource, "w" | "h">) => (Math.min(src.w, src.h) >= 2160 ? 2 : 1.5);

/** The source's size inside a W×H frame at zoom 1: scaled to fit, the whole picture showing. */
export function fitted(src: Pick<TimelineSource, "w" | "h">, W: number, H: number): { w: number; h: number } {
  if (!src.w || !src.h) return { w: W, h: H };
  const s = Math.min(W / src.w, H / src.h);
  return { w: src.w * s, h: src.h * s };
}

/**
 * How far (timeline px) the picture may move up or down at `zoom`: while it is taller than the frame, until an edge
 * would show; while it is shorter (a wide shot in a tall frame), until it would leave the frame.
 */
export const tiltLimit = (fittedH: number, H: number, zoom: number) => Math.abs(zoom * fittedH - H) / 2;

/**
 * The tilt (timeline px, positive = the picture moves up) that keeps an eye line at `eyeline` (a fraction of the
 * source's height from the top) at the same screen height at `zoom`, clamped by tiltLimit.
 */
export function tiltFor(src: Pick<TimelineSource, "w" | "h">, W: number, H: number, zoom: number, eyeline: number): number {
  const { h } = fitted(src, W, H);
  const above = (0.5 - eyeline) * h; // the eye line's height above the centre at zoom 1
  const t = -(zoom - 1) * above; // zooming moves it to zoom × above; move the picture back by the difference
  const lim = tiltLimit(h, H, zoom);
  return Math.round(Math.max(-lim, Math.min(lim, t)) * 100) / 100;
}

/** Zoom and tilt for the n-th speaker shot: even shots wide (no transform), odd shots punched in. */
export function framingOf(n: number, src: TimelineSource, W: number, H: number, punch: number, eyeline: number): { zoom?: number; tilt?: number } {
  if (n % 2 === 0) return {};
  const zoom = Math.min(punch, maxPunch(src));
  if (zoom <= 1) return {};
  const tilt = tiltFor(src, W, H, zoom, eyeline);
  return tilt ? { zoom, tilt } : { zoom };
}
