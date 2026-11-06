import type { VideoAdjustments } from "./clean-edit";

export interface TimelineSpan {
  start: number;
  end: number;
  outputStart: number;
  outputEnd: number;
}
/** One shared time map for export, preview, scoring and caption handoff. */
export function editTimeline(
  a: VideoAdjustments,
  duration: number,
): TimelineSpan[] {
  const cuts = a.cuts.length
    ? a.cuts
    : [{ start: a.start, end: a.end ?? duration }];
  let cursor = 0;
  return cuts.map((cut) => {
    if (
      !Number.isFinite(cut.start) ||
      !Number.isFinite(cut.end) ||
      cut.start < 0 ||
      cut.end > duration + 0.05 ||
      cut.end - cut.start < 0.099999
    )
      throw new Error(
        "Keep each scene inside the source and at least 0.1 seconds long.",
      );
    const end = Math.min(duration, cut.end);
    const span = {
      start: cut.start,
      end,
      outputStart: cursor,
      outputEnd: cursor + (end - cut.start) / a.speed,
    };
    cursor = span.outputEnd;
    return span;
  });
}
export function sourceMoment(
  spans: TimelineSpan[],
  seconds: number,
  speed: number,
): number {
  const span =
    spans.find((s) => seconds < s.outputEnd) ?? spans[spans.length - 1];
  return Math.max(
    span.start,
    Math.min(
      span.end - 0.000001,
      span.start + (seconds - span.outputStart) * speed,
    ),
  );
}
export function timelineDuration(spans: TimelineSpan[]): number {
  return spans.at(-1)?.outputEnd ?? 0;
}
