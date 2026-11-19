import { describe, expect, it } from "vitest";
import { fadePoints } from "./audio";

describe("nle sound fades", () => {
  it("ramps a clip up from silence and down to it, from where it starts playing", () => {
    const p = { dur: 10, gain: 0.5, fadeIn: 2, fadeOut: 4 };
    expect(fadePoints(p, 100, 0, 1)).toEqual([[100, 0], [102, 0.5], [106, 0.5], [110, 0]]);
    // started 1 s in, at double speed: half way up, the clock runs twice as fast
    expect(fadePoints(p, 100, 1, 2)).toEqual([[100.5, 0.25], [101, 0.5], [103, 0.5], [105, 0]]);
    // no fades: one point at its loudness
    expect(fadePoints({ dur: 10, gain: 1 }, 0, 3, 1)).toEqual([[3, 1]]);
  });
});
