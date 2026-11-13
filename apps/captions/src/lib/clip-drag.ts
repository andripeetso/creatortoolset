// What a clip does under the hand on the app's timelines (Review's items, components/EditTimeline.tsx, and the screen
// recording editor's zooms and the ends of its kept part, components/screen-editor/Timeline.tsx): a drag that lands on
// something near it, and a span that stays inside its limits. Numbers are in the timeline's own unit, frames in Review
// and seconds in the recorder. Pure, so it is tested.

/** How near, in screen px, a dragged edge has to come to a target to land on it. */
export const SNAP_PX = 7;

/**
 * A drag of `delta` that lands on what is near: `edges` are the dragged edges where they stood before the drag. When
 * one of them comes within `tolerance` of a target, the drag becomes the one that puts it exactly there; of several,
 * the nearest wins. Otherwise the drag is as it was.
 */
export function snapDelta(edges: number[], delta: number, targets: number[], tolerance: number): number {
  let best = 0;
  let dist = tolerance;
  for (const e of edges) for (const t of targets) if (Math.abs(t - (e + delta)) < dist) [dist, best] = [Math.abs(t - (e + delta)), t - (e + delta)];
  return delta + best;
}

/** Which part of a clip a drag holds: all of it, or one end. */
export type Grip = "body" | "start" | "end";

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/**
 * A span dragged by `delta` at its body or at one end. Held by the body it keeps its length and stays between `lo` and
 * `hi`; an end stops at its side's limit and leaves the span at least `min` long.
 */
export function dragSpan(span: { start: number; end: number }, grip: Grip, delta: number, { lo, hi, min }: { lo: number; hi: number; min: number }): { start: number; end: number } {
  let { start, end } = span;
  if (grip === "body") {
    const length = end - start;
    start = clamp(start + delta, lo, Math.max(lo, hi - length));
    end = start + length;
  } else if (grip === "start") start = clamp(start + delta, lo, end - min);
  else end = clamp(end + delta, start + min, hi);
  return { start, end };
}
