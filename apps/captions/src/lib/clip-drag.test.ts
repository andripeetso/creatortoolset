import { describe, expect, it } from "vitest";
import { dragSpan, snapDelta } from "./clip-drag";

describe("a clip under the hand", () => {
  it("lands on what is near, and only then", () => {
    // an edge at 100 dragged 46 comes to 146: 4 from the target at 150, inside a tolerance of 7
    expect(snapDelta([100], 46, [150], 7)).toBe(50);
    expect(snapDelta([100], 40, [150], 7)).toBe(40); // 10 away: left alone
    expect(snapDelta([100], 43, [150], 7)).toBe(43); // exactly the tolerance away is not near
    expect(snapDelta([100], 46, [], 7)).toBe(46);
    expect(snapDelta([100], 46, [150], 0)).toBe(46); // snapping off
  });

  it("of several edges and targets the nearest pair wins", () => {
    // a clip 100-130 moved 18: its start comes to 118 (2 from 120), its end to 148 (2 from 150, and 1 from 149)
    expect(snapDelta([100, 130], 18, [120, 149], 7)).toBe(19); // the end on 149
    expect(snapDelta([100, 130], 18, [120, 150], 7)).toBe(20); // both 2 away: the first found, the start on 120
    expect(snapDelta([100, 130], -3, [96, 131], 7)).toBe(-4); // back the other way: the start on 96 (1 away)
  });

  it("a span held by its body keeps its length between its limits", () => {
    const limits = { lo: 5, hi: 12, min: 0.6 };
    expect(dragSpan({ start: 7, end: 9 }, "body", 1, limits)).toEqual({ start: 8, end: 10 });
    expect(dragSpan({ start: 7, end: 9 }, "body", 30, limits)).toEqual({ start: 10, end: 12 });
    expect(dragSpan({ start: 7, end: 9 }, "body", -30, limits)).toEqual({ start: 5, end: 7 });
    // a span longer than its room stays at the room's start
    expect(dragSpan({ start: 7, end: 17 }, "body", 3, limits)).toEqual({ start: 5, end: 15 });
  });

  it("an end stops at its limit and leaves the span its least length", () => {
    const limits = { lo: 5, hi: 12, min: 0.6 };
    expect(dragSpan({ start: 7, end: 9 }, "end", 2, limits)).toEqual({ start: 7, end: 11 });
    expect(dragSpan({ start: 7, end: 9 }, "end", 30, limits)).toEqual({ start: 7, end: 12 });
    expect(dragSpan({ start: 7, end: 9 }, "end", -30, limits)).toEqual({ start: 7, end: 7.6 });
    expect(dragSpan({ start: 7, end: 9 }, "start", -30, limits)).toEqual({ start: 5, end: 9 });
    expect(dragSpan({ start: 7, end: 9 }, "start", 30, limits)).toEqual({ start: 8.4, end: 9 });
  });
});
