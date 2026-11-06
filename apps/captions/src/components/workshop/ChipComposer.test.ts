import { describe, expect, it } from "vitest";
import { numbered, readable } from "./ChipComposer";

const quotes = [
  { id: "qa", text: "As a passenger", field: "script" as const },
  { id: "qb", text: "Sample thing A syndrome", comment: "too clinical" },
];

describe("the message box's citations", () => {
  it("are numbered in the order they stand in the words; a chip twice is one quote; a lost one is dropped", () => {
    expect(numbered("Keep ⟦qb⟧ but not ⟦qa⟧, and ⟦qb⟧ again ⟦gone⟧", quotes)).toEqual({
      text: "Keep ⟦1⟧ but not ⟦2⟧, and ⟦1⟧ again ",
      quotes: [quotes[1], quotes[0]],
    });
  });
  it("read as their words outside the box", () => {
    expect(readable("I don't like ⟦qa⟧.", quotes)).toBe("I don't like “As a passenger”.");
  });
});
