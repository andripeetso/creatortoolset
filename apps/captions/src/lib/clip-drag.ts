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

/** A clip on one lane as it stands: where it starts and how long it is. */
export type LaneSpan = { key: string; rec: number; len: number };
/** What a clip of the lane becomes: its new start and end, or `gone` (all of it covered). */
export type Settled = { key: string; rec: number; end: number; gone?: boolean };

/**
 * The rest of a lane after one clip (`key`) went from `was` to `now`, so that one lane plays one clip at a time.
 * Ripple: the clips that started at or after its old end move by what its end moved, then anything it still lies over
 * is overwritten. Overwrite: what it now lies over is cut back to where it starts or ends, or taken out when it covers
 * all of it. Only the clips that change are returned.
 */
export function settle(lane: LaneSpan[], key: string, was: { rec: number; len: number }, now: { rec: number; len: number },
  mode: "ripple" | "overwrite"): Settled[] {
  const wasEnd = was.rec + was.len;
  const d = mode === "ripple" ? now.rec + now.len - wasEnd : 0;
  const [c0, c1] = [now.rec, now.rec + now.len];
  const out: Settled[] = [];
  for (const s of lane) {
    if (s.key === key) continue;
    let [a, b] = [s.rec, s.rec + s.len];
    if (d && a >= wasEnd) [a, b] = [a + d, b + d];
    if (b > c0 && a < c1) {
      if (a >= c0 && b <= c1) {
        out.push({ key: s.key, rec: a, end: b, gone: true });
        continue;
      }
      // ponytail: covered in its middle keeps its start only (a split would keep both ends)
      if (a < c0) b = c0;
      else a = c1;
    }
    if (a !== s.rec || b !== s.rec + s.len) out.push({ key: s.key, rec: a, end: b });
  }
  return out;
}
