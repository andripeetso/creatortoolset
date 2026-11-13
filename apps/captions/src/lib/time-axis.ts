// One time axis for the app's timelines (Review's, components/EditTimeline.tsx, and the screen recording editor's,
// components/screen-editor/Timeline.tsx): how wide a second is, a zoom that keeps the playhead where it is, the
// playhead kept in view, and the ruler's marks. Pure arithmetic, so it is tested; lib/use-time-axis.ts puts it on a
// scroller with the wheel, the pinch and the keys.

/** The scroller as the axis sees it: its width and scroll, and the px of its content before 0:00 (a label column, padding). */
export interface AxisView {
  width: number;
  scroll: number;
  left: number;
}

/** Px a second takes when the whole length fits the scroller: zoom 1. Never under 1. */
export const fitPps = (width: number, seconds: number, left = 0, right = 0): number => Math.max(1, (width - left - right) / Math.max(seconds, 0.1));

/** How far the zoom goes: until a second is `maxPps` px wide. At least 1 (a length that already fills more than that still fits). */
export const maxZoomOf = (base: number, maxPps: number): number => Math.max(1, maxPps / base);

/** A zoom kept between the whole length (1) and `maxPps` px a second. */
export const clampZoom = (zoom: number, base: number, maxPps: number): number => Math.min(Math.max(1, zoom), maxZoomOf(base, maxPps));

/**
 * Where to scroll so that a zoom from `from` to `to` leaves `time` at the same place on screen. A time that is out of
 * view (before the content's start on screen, or in the last 8 px) goes to the middle of what shows.
 */
export function scrollForZoom(v: AxisView, base: number, from: number, to: number, time: number): number {
  const px = v.left + time * base * from - v.scroll;
  const at = px >= v.left && px <= v.width - 8 ? px : v.left + (v.width - v.left) / 2;
  return Math.max(0, time * base * to - at + v.left);
}

/** Where to scroll to bring `time` back into view, a third of the way in; null while it shows (up to 24 px from the right edge). */
export function scrollToFollow(v: AxisView, pps: number, time: number): number | null {
  const px = v.left + time * pps;
  return px < v.scroll + v.left || px > v.scroll + v.width - 24 ? Math.max(0, px - v.left - v.width / 3) : null;
}

/** A zoom as a slider's place, 0 to 1000, each step the same share wider (and back). */
export const zoomToSlider = (zoom: number, maxZoom: number): number => (maxZoom > 1 ? Math.round((Math.log(zoom) / Math.log(maxZoom)) * 1000) : 0);
export const sliderToZoom = (at: number, maxZoom: number): number => Math.exp((at / 1000) * Math.log(maxZoom));

/** Seconds between the ruler's marks, so that they stand at least 64 px apart. */
export function rulerStep(pxPerSecond: number): number {
  return [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((s) => s * pxPerSecond >= 64) ?? 1200;
}

/** m:ss, with tenths when `fine`. */
export function clock(t: number, fine = false): string {
  const s = Math.max(0, t);
  const whole = `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  return fine ? `${whole}.${Math.floor((s % 1) * 10)}` : whole;
}
