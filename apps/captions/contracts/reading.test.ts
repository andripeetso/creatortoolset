import { describe, expect, it } from "vitest";
import { readS, wordBudget } from "./reading";

describe("reading time", () => {
  it("holds a short text for the minimum and 0.3 s a word beyond it", () => {
    expect(readS("one")).toBe(0.8);
    expect(readS("  one two three four five six seven eight nine ten ")).toBeCloseTo(3);
  });

  it("fits words into a hold after the entrance", () => {
    expect(wordBudget(1)).toBe(0); // 0.7 s after the entrance: under the minimum
    expect(wordBudget(1.2)).toBe(3);
    expect(wordBudget(2.4)).toBe(7);
  });
});
