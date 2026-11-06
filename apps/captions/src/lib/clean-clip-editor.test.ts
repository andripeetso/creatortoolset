import { expect, it } from "vitest";
import { editOptionsSchema } from "@contracts/clean-edit";
import {
  editTimeline,
  sourceMoment,
  timelineDuration,
} from "@contracts/clean-timeline";
import {
  clipRanges,
  editHistory,
  moveClip,
  splitClip,
  trimClip,
  withClipRanges,
} from "./clean-clip-editor";
it("splits at the actual source moment after reorder and 101% speed without changing content or duration", () => {
  const options = editOptionsSchema.parse({
    adjustments: {
      speed: 1.01,
      cuts: [
        { start: 10, end: 20 },
        { start: 0, end: 5 },
      ],
    },
  });
  const result = splitClip(options, 20, 3);
  expect(result.adjustments.cuts).toHaveLength(3);
  expect(result.adjustments.cuts[0].start).toBe(10);
  expect(result.adjustments.cuts[0].end).toBeCloseTo(13.03, 10);
  expect(result.adjustments.cuts[1].start).toBe(result.adjustments.cuts[0].end);
  expect(result.adjustments.cuts[2]).toEqual({ start: 0, end: 5 });
  const before = editTimeline(options.adjustments, 20),
    after = editTimeline(result.adjustments, 20);
  expect(timelineDuration(after)).toBeCloseTo(timelineDuration(before));
  for (const time of [0, 2.9, 3, 3.1, 9.91, 12])
    expect(sourceMoment(after, time, 1.01)).toBeCloseTo(
      sourceMoment(before, time, 1.01),
    );
});
it("clamps trim handles inside the source and keeps the minimum scene length", () => {
  const cuts = [{ start: 3, end: 8 }];
  expect(trimClip(cuts, 0, "start", 9, 10)[0]).toEqual({ start: 7.9, end: 8 });
  expect(trimClip(cuts, 0, "end", -1, 10)[0]).toEqual({ start: 3, end: 3.1 });
  expect(trimClip(cuts, 0, "end", 50, 10)[0].end).toBe(10);
  expect(trimClip(cuts, 0, "start", NaN, 10)).toBe(cuts);
});
it("moves scenes without mutating the draft and preserves non-timeline settings", () => {
  const initial = editOptionsSchema.parse({
    adjustments: { brightness: 1.2, start: 2, end: 8 },
  });
  const cuts = [
    { start: 0, end: 2 },
    { start: 5, end: 8 },
  ];
  const reordered = moveClip(cuts, 0, 1);
  expect(reordered).toEqual([cuts[1], cuts[0]]);
  expect(cuts[0].start).toBe(0);
  const result = withClipRanges(initial, reordered);
  expect(result.adjustments.brightness).toBe(1.2);
  expect(result.adjustments.start).toBe(0);
  expect(clipRanges(result, 10)).toEqual(reordered);
});
it("keeps draft undo/redo isolated from the original options and drops abandoned redo branches", () => {
  const original = editOptionsSchema.parse({ adjustments: {} });
  const edited = splitClip(original, 10, 5);
  const first = editHistory(
    { past: [], present: original, future: [] },
    { type: "set", options: edited },
  );
  const undo = editHistory(first, { type: "undo" });
  expect(undo.present).toEqual(original);
  expect(editHistory(undo, { type: "redo" }).present).toEqual(edited);
  const other = splitClip(original, 10, 3);
  expect(editHistory(undo, { type: "set", options: other }).future).toEqual([]);
  expect(original.adjustments.cuts).toEqual([]);
});
it("rejects empty timelines and prevents tiny or excessive splits", () => {
  const options = editOptionsSchema.parse({ adjustments: {} });
  expect(splitClip(options, 10, 0.01)).toBe(options);
  expect(splitClip(options, 10, 9.99)).toBe(options);
  expect(() => withClipRanges(options, [])).toThrow();
  const max = withClipRanges(
    options,
    Array.from({ length: 64 }, (_, i) => ({ start: i, end: i + 1 })),
  );
  expect(splitClip(max, 64, 0.5)).toBe(max);
});
it("groups a slider gesture into one undo step", () => {
  const original = editOptionsSchema.parse({ adjustments: {} });
  const first = {
    ...original,
    adjustments: { ...original.adjustments, brightness: 1.05 },
  };
  const second = {
    ...original,
    adjustments: { ...original.adjustments, brightness: 1.2 },
  };
  const history = editHistory(
    editHistory(
      { past: [], present: original, future: [] },
      { type: "set", options: first, group: "1" },
    ),
    { type: "set", options: second, group: "1" },
  );
  expect(history.past).toHaveLength(1);
  expect(editHistory(history, { type: "undo" }).present).toEqual(original);
});
