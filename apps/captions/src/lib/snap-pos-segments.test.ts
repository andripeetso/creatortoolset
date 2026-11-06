import { describe, expect, it } from "vitest";
import { snapPosSegments } from "./captions";
import type { Cue, PosSegment } from "./types";

const cue = (id: number, start: number, end: number): Cue => ({ id, start, end, words: [] });
const seg = (id: number, start: number, end: number): PosSegment => ({ id, start, end, x: 10, y: 20 });

describe("snapPosSegments", () => {
  const cues = [cue(1, 10, 12), cue(2, 12.5, 14), cue(3, 15, 17)];

  it("moves each edge to the nearest caption cut and keeps the position", () => {
    // 10.4 → 10 (cue 1 start), 13.6 → 14 (cue 2 end)
    expect(snapPosSegments([seg(1, 10.4, 13.6)], cues, 30)).toEqual([seg(1, 10, 14)]);
  });

  it("keeps touching sections touching and never overlaps them", () => {
    const out = snapPosSegments([seg(1, 0, 13.4), seg(2, 13.4, 30)], cues, 30);
    expect(out).toEqual([seg(1, 0, 14), seg(2, 14, 30)]);
  });

  it("drops a section that held no caption's middle", () => {
    expect(snapPosSegments([seg(1, 15.2, 15.6)], cues, 30)).toEqual([]);
  });
});
