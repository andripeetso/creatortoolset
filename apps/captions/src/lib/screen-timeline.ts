// The arithmetic of the screen recording editor's timeline (components/screen-editor/Timeline.tsx): dragging a zoom
// or the ends of the kept part, where a new zoom fits, and the ruler's marks. Pure, so it is tested.
import { MIN_ZOOM, type Zoom } from "./screen-recording";

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const ms = (v: number) => Math.round(v * 1000) / 1000;

/** Which part of a zoom a drag holds. */
export type ZoomGrip = "body" | "start" | "end";

/**
 * The zoom at `index` dragged by `dt` seconds from where the drag began (`zooms` is the list as it was then): moved
 * whole, or one end moved. It stays inside the recording, at least MIN_ZOOM long, and stops at its neighbours.
 */
export function dragZoom(zooms: Zoom[], index: number, grip: ZoomGrip, dt: number, duration: number): Zoom[] {
  const z = zooms[index];
  if (!z) return zooms;
  const lo = index > 0 ? zooms[index - 1].end : 0;
  const hi = index < zooms.length - 1 ? zooms[index + 1].start : duration;
  let { start, end } = z;
  if (grip === "body") {
    const length = end - start;
    start = clamp(start + dt, lo, Math.max(lo, hi - length));
    end = start + length;
  } else if (grip === "start") start = clamp(start + dt, lo, end - MIN_ZOOM);
  else end = clamp(end + dt, start + MIN_ZOOM, hi);
  return zooms.map((o, i) => (i === index ? { ...o, start: ms(start), end: ms(end) } : o));
}

/**
 * Where a new zoom fits at `t`: up to `length` seconds in the gap between the zooms around it, centred on t (a click
 * on the track) or starting at t (the playhead). Null inside a zoom or where the gap is under MIN_ZOOM.
 */
export function zoomSlot(
  zooms: Zoom[],
  t: number,
  duration: number,
  anchor: "center" | "start" = "center",
  length = 3,
): { start: number; end: number } | null {
  if (zooms.some((z) => t >= z.start && t <= z.end)) return null;
  const lo = Math.max(0, ...zooms.filter((z) => z.end <= t).map((z) => z.end));
  const hi = Math.min(duration, ...zooms.filter((z) => z.start >= t).map((z) => z.start));
  if (hi - lo < MIN_ZOOM) return null;
  const size = Math.min(length, hi - lo);
  const start = clamp(anchor === "center" ? t - size / 2 : t, lo, hi - size);
  return { start: ms(start), end: ms(start + size) };
}

/** One end of the kept part dragged to `t`. At least half a second is kept. */
export function dragTrim(trim: { start: number; end: number }, grip: "start" | "end", t: number, duration: number) {
  return grip === "start"
    ? { start: ms(clamp(t, 0, trim.end - 0.5)), end: trim.end }
    : { start: trim.start, end: ms(clamp(t, trim.start + 0.5, duration)) };
}

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
