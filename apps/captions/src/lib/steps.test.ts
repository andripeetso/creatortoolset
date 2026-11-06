import { describe, expect, it } from "vitest";
import { durationLabel, stepsSummary } from "./workshop";

describe("a turn's steps", () => {
  it("say in one line what it read, searched and how long it took", () => {
    const t = 1_000_000;
    const steps = [
      { label: "Reading your folder and thinking", at: t, end: t + 5_000 },
      { label: "Read my-posts/INDEX.md", at: t + 5_000, end: t + 9_000 },
      { label: "Read context/what-is-true.md", at: t + 9_000, end: t + 12_000 },
      { label: 'Searched sessions for "strength"', at: t + 12_000, end: t + 14_000 },
      { label: 'Searched the web: "tummy time crawling onset"', at: t + 14_000, end: t + 100_000 },
      { label: "Writing the piece", at: t + 100_000, end: t + 160_000 },
    ];
    expect(stepsSummary(steps)).toBe("Read 2 files · searched the folder 1× · searched the web · 2 min 40 s");
    expect(durationLabel(385_000)).toBe("6 min 25 s");
    expect(durationLabel(8_400)).toBe("8 s");
  });
});
