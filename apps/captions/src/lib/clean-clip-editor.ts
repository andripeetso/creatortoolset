import { sameEdit, type EditOptions } from "@contracts/clean-edit";
import { editTimeline } from "@contracts/clean-timeline";
export type ClipRange = { start: number; end: number };
export function clipRanges(
  options: EditOptions,
  duration: number,
): ClipRange[] {
  return editTimeline(options.adjustments, duration).map(({ start, end }) => ({
    start,
    end,
  }));
}
export function withClipRanges(
  options: EditOptions,
  cuts: ClipRange[],
): EditOptions {
  if (!cuts.length || cuts.length > 64)
    throw new Error("Keep between 1 and 64 scenes.");
  return {
    ...options,
    adjustments: { ...options.adjustments, start: 0, end: null, cuts },
  };
}
export function splitClip(
  options: EditOptions,
  duration: number,
  outputTime: number,
): EditOptions {
  const spans = editTimeline(options.adjustments, duration);
  const index = spans.findIndex(
    (s) => outputTime >= s.outputStart && outputTime < s.outputEnd,
  );
  if (index < 0 || spans.length >= 64) return options;
  const span = spans[index];
  const at =
    span.start + (outputTime - span.outputStart) * options.adjustments.speed;
  if (at - span.start < 0.1 || span.end - at < 0.1) return options;
  return withClipRanges(
    options,
    spans.flatMap((s, i) =>
      i === index
        ? [
            { start: s.start, end: at },
            { start: at, end: s.end },
          ]
        : [{ start: s.start, end: s.end }],
    ),
  );
}
export function moveClip(cuts: ClipRange[], from: number, to: number) {
  if (from < 0 || from >= cuts.length || to < 0 || to >= cuts.length)
    return cuts;
  const next = [...cuts],
    [clip] = next.splice(from, 1);
  next.splice(to, 0, clip);
  return next;
}
export function trimClip(
  cuts: ClipRange[],
  index: number,
  edge: "start" | "end",
  seconds: number,
  duration: number,
) {
  if (!Number.isFinite(seconds) || !cuts[index]) return cuts;
  return cuts.map((s, i) =>
    i !== index
      ? s
      : {
          ...s,
          [edge]:
            edge === "start"
              ? Math.max(0, Math.min(s.end - 0.1, seconds))
              : Math.min(duration, Math.max(s.start + 0.1, seconds)),
        },
  );
}
export interface EditHistory {
  group?: string;
  past: EditOptions[];
  present: EditOptions;
  future: EditOptions[];
}
export type EditAction =
  | { type: "set"; options: EditOptions; group?: string }
  | { type: "undo" | "redo" };
export function editHistory(
  state: EditHistory,
  action: EditAction,
): EditHistory {
  if (action.type === "set")
    return sameEdit(state.present, action.options)
      ? state
      : {
          past:
            action.group && action.group === state.group
              ? state.past
              : [...state.past, state.present].slice(-80),
          group: action.group,
          present: action.options,
          future: [],
        };
  if (action.type === "undo")
    return !state.past.length
      ? state
      : {
          past: state.past.slice(0, -1),
          present: state.past.at(-1)!,
          future: [state.present, ...state.future],
        };
  return !state.future.length
    ? state
    : {
        past: [...state.past, state.present],
        present: state.future[0],
        future: state.future.slice(1),
      };
}
