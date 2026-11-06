import { describe, expect, it } from "vitest";
import { addedSpans, wordDiff } from "./word-diff";

/** Rebuilds both sides from the pieces: keeps and drops must give back the before text, keeps and adds the after text. */
const sides = (pieces: ReturnType<typeof wordDiff>) => ({
  before: pieces.filter((p) => p.kind !== "add").map((p) => p.text).join(""),
  after: pieces.filter((p) => p.kind !== "del").map((p) => p.text).join(""),
});

describe("wordDiff", () => {
  it("marks one changed word as a removal and an addition", () => {
    expect(wordDiff("the cat sat", "the dog sat")).toEqual([
      { text: "the ", kind: "same" },
      { text: "cat", kind: "del" },
      { text: "dog", kind: "add" },
      { text: " sat", kind: "same" },
    ]);
  });

  it("reads back to both texts", () => {
    const before = "Slide one says hello to the baby.";
    const after = "Slide one says hi to the little friend, twice.";
    expect(sides(wordDiff(before, after))).toEqual({ before, after });
  });

  it("treats a new block as all added and a deleted one as all removed", () => {
    expect(wordDiff("", "new line")).toEqual([{ text: "new line", kind: "add" }]);
    expect(wordDiff("gone line", "")).toEqual([{ text: "gone line", kind: "del" }]);
  });

  it("reads a text too long for the table as a whole replace", () => {
    const big = Array.from({ length: 2500 }, (_, i) => `w${i}`).join(" ");
    expect(wordDiff(big, `${big} x`)).toEqual([
      { text: big, kind: "del" },
      { text: `${big} x`, kind: "add" },
    ]);
  });
});

describe("addedSpans", () => {
  it("gives the after text's new words, without the spaces around them", () => {
    const after = "the big dog sat down";
    expect(addedSpans("the cat sat", after).map(([a, b]) => after.slice(a, b))).toEqual(["big dog", "down"]);
    expect(addedSpans("same words", "same words")).toEqual([]);
    expect(addedSpans("", "all new")).toEqual([[0, 7]]);
  });
});
