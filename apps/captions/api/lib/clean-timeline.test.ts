import { describe, expect, it } from "vitest";
import { DEFAULT_ADJUSTMENTS } from "../../contracts/clean-edit";
import {
  editTimeline,
  sourceMoment,
  timelineDuration,
} from "../../contracts/clean-timeline";
import { remapCaptionData } from "./clean-caption-map";
describe("cut timeline and caption remapping", () => {
  const a = {
    ...DEFAULT_ADJUSTMENTS,
    speed: 2,
    cuts: [
      { start: 4, end: 6 },
      { start: 1, end: 3 },
      { start: 4, end: 5 },
    ],
  };
  const spans = editTimeline(a, 8);
  it("maps reordered and repeated scenes with half-open boundaries", () => {
    expect(timelineDuration(spans)).toBe(2.5);
    expect(sourceMoment(spans, 0.5, 2)).toBe(5);
    expect(sourceMoment(spans, 1, 2)).toBe(1);
    expect(sourceMoment(spans, 2, 2)).toBe(4);
    expect(() =>
      editTimeline({ ...a, cuts: [{ start: 7, end: 9 }] }, 8),
    ).toThrow();
  });
  it("clips and repeats annotations, preserves word IDs, and keeps removed visibility hidden", () => {
    const words = [
      { id: 5, start: 0.8, end: 1.5, text: "first" },
      { id: 7, start: 4.5, end: 5.5, text: "later" },
    ];
    const data = {
      duration: 8,
      words,
      originalWords: words,
      cues: words.map((w, id) => ({
        id,
        start: w.start,
        end: w.end,
        words: [w],
        lines: [1],
      })),
      style: { fontSize: 40 },
      posSegments: [{ id: 2, start: 6.1, end: 7, x: 50, y: 50 }],
      texts: [{ id: 8, text: "overlay", start: 4.8, end: 5.8 }],
      peaks: [0.5],
      done: true,
    };
    const mapped = remapCaptionData(data, spans, 2);
    expect(mapped.words.map((w) => [w.id, w.text, w.start, w.end])).toEqual([
      [0, "later", 0.25, 0.75],
      [1, "first", 1, 1.25],
      [2, "later", 2.25, 2.5],
    ]);
    expect(mapped.cues.flatMap((c) => c.words.map((w) => w.id))).toEqual(
      mapped.words.map((w) => w.id),
    );
    expect(mapped.texts).toHaveLength(2);
    expect(mapped.texts[1].end).toBe(2.5);
    expect(mapped.posSegments).toEqual([
      { id: 0, start: 0, end: 2.5, x: null, y: null },
    ]);
    expect(mapped.duration).toBe(2.5);
    expect(mapped.peaks).toBeNull();
    expect(mapped.done).toBe(false);
    expect(mapped).toMatchObject({ style: data.style });
    expect(data.words[0].start).toBe(0.8);
  });
});
