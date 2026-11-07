import { describe, expect, it } from "vitest";
import type { VersionPlan } from "@contracts/editor";
import { swapTake, takeSpan } from "./editor";

const plan: VersionPlan = {
  name: "v2",
  title: "Second",
  lines: [
    { line: "L1", take: { first: 1, last: 2, score: 0.9 } },
    { line: "L2", take: { first: 5, last: 5, score: 0.6 } },
  ],
};

describe("AI Editor script table", () => {
  it("a swapped take becomes the PUT lines body: that version, every line in order, only the one take changed, no scores", () => {
    expect(swapTake(plan, 1, { first: 7, last: 8 })).toEqual({
      plans: [
        {
          name: "v2",
          lines: [
            { line: "L1", take: { first: 1, last: 2 } },
            { line: "L2", take: { first: 7, last: 8 } },
          ],
        },
      ],
    });
  });

  it("a take plays from its first sentence's start to its last one's end", () => {
    const s = (n: number, at: number) => ({ n, src: "ver_a", text: "x", s: at, e: at + 1, w0: 0, w1: 0 });
    expect(takeSpan({ first: 1, last: 2 }, [s(1, 3), s(2, 5)])).toEqual({ src: "ver_a", s: 3, e: 6 });
    expect(takeSpan({ first: 1, last: 9 }, [s(1, 3)])).toBeNull();
  });
});
