import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  comparisonTimeline,
  type TimedHash,
} from "@contracts/clean-comparison";
const frames = (n: number): TimedHash[] =>
  Array.from({ length: n }, (_, i) => ({
    hash: createHash("sha256").update(`unique shot ${i}`).digest("hex"),
    quality: 90,
  }));
describe("content comparison timeline", () => {
  it("finds reordered scenes across timestamps, and separates omitted source material", () => {
    const before = frames(8),
      after = [
        before[5],
        before[6],
        before[7],
        before[0],
        before[1],
        before[2],
      ];
    const map = comparisonTimeline(before, after, [8, 6], [1, 1]);
    expect(map.samples.map((s) => s.sourceStart)).toEqual([5, 6, 7, 0, 1, 2]);
    expect(
      map.originalSamples
        .filter((s) => s.state === "unmatched")
        .map((s) => s.start),
    ).toEqual([3, 4]);
    expect(map.longestRun?.seconds).toBe(2);
    expect(map.samples.every((s) => s.state === "matched")).toBe(true);
  });
  it("allows small rate differences without joining reordered sequences", () => {
    const before = frames(8);
    const map = comparisonTimeline(
      before,
      before.slice(2, 7),
      [8, 5 / 1.01],
      [1, 1 / 1.01],
    );
    expect(map.longestRun?.seconds).toBeCloseTo(4 / 1.01);
    expect(map.samples[4].end).toBeCloseTo(5 / 1.01);
  });
  it("marks equally good distant matches as ambiguous rather than inventing a location", () => {
    const before = frames(6);
    before[4] = before[0];
    const map = comparisonTimeline(before, [before[0]], [6, 1], [1, 1]);
    expect(map.samples[0].state).toBe("ambiguous");
    expect(map.samples[0].candidates).toBe(2);
    expect(map.longestRun).toBeNull();
  });
  it("separates low detail and missing reliable references from nonmatches", () => {
    const a = frames(4);
    expect(
      comparisonTimeline(a, [{ ...a[0], quality: 49 }], [4, 1], [1, 1])
        .samples[0].state,
    ).toBe("low-detail");
    expect(
      comparisonTimeline(
        a.map((x) => ({ ...x, quality: 0 })),
        [a[0]],
        [4, 1],
        [1, 1],
      ).samples[0].state,
    ).toBe("low-detail");
    expect(
      comparisonTimeline([], [a[0]], [4, 1], [1, 1]).samples[0].state,
    ).toBe("low-detail");
  });
  it("uses inclusive PDQ distance 31, rejects 32 and ignores malformed hashes", () => {
    const zero = { hash: "0".repeat(64), quality: 90 };
    const bits = (n: number) => ({
      hash: ((1n << BigInt(n)) - 1n).toString(16).padStart(64, "0"),
      quality: 90,
    });
    const map = comparisonTimeline(
      [zero, { ...zero, hash: "broken" }],
      [bits(31), bits(32)],
      [2, 2],
      [1, 1],
    );
    expect(map.samples.map((s) => s.state)).toEqual(["matched", "unmatched"]);
    expect(map.samples.map((s) => s.distance)).toEqual([31, 32]);
  });
});
