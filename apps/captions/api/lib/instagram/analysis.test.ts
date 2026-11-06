import { describe, expect, it } from "vitest";
import { catalogMix, commentThemes, hookPatterns, kindAverages, medianPlays, playsPerDay, playsVsMedian, postingCadence, stackStatusFromMembers, visibilitySplit } from "./analysis";

describe("hookPatterns", () => {
  it("groups the same opening line", () => {
    const out = hookPatterns([
      { id: "a", hook: "Wait for it", rank: 8, virality: 10 },
      { id: "b", hook: "wait  for IT", rank: 6, virality: 20 },
      { id: "c", hook: "Different hook here", virality: 1 },
    ]);
    expect(out[0]?.hook).toBe("wait for it");
    expect(out[0]?.count).toBe(2);
    expect(out[0]?.avgRank).toBe(7);
  });
});

describe("playsPerDay", () => {
  it("uses elapsed time between snapshots", () => {
    const v = playsPerDay(
      { at: 0, source: "apify", plays: 100 },
      { at: 2 * 86_400_000, source: "apify", plays: 300 },
    );
    expect(v).toBe(100);
  });
});

describe("postingCadence", () => {
  it("computes median gap", () => {
    const day = 86_400_000;
    const out = postingCadence([
      {
        id: "1",
        username: "x",
        catalog: [
          { shortcode: "a", url: "", kind: "reel", takenAt: day, counts: {} },
          { shortcode: "b", url: "", kind: "reel", takenAt: 3 * day, counts: {} },
          { shortcode: "c", url: "", kind: "reel", takenAt: 5 * day, counts: {} },
        ],
      },
    ]);
    expect(out[0]?.medianGapDays).toBe(2);
  });
});

describe("commentThemes", () => {
  it("drops stopwords and keeps repeats", () => {
    const out = commentThemes(["this recipe is fire", "the recipe slap", "fire fire"]);
    expect(out[0]?.label).toBe("fire");
    expect(out.find((t) => t.label === "recipe")?.count).toBe(2);
  });
});

describe("stackStatusFromMembers", () => {
  it("collapses a mixed stack to idea if any are made", () => {
    expect(stackStatusFromMembers(["done", "inbox"])).toBe("idea");
    expect(stackStatusFromMembers(["done", "done"])).toBe("done");
    expect(stackStatusFromMembers([])).toBe("inbox");
  });
});

describe("catalog mix", () => {
  it("counts kinds, median plays, and flags the bottom fifth as low", () => {
    const catalog = [
      { shortcode: "a", url: "", kind: "reel" as const, takenAt: 1, counts: { plays: 100 } },
      { shortcode: "b", url: "", kind: "reel" as const, takenAt: 1, counts: { plays: 10 } },
      { shortcode: "c", url: "", kind: "carousel" as const, takenAt: 1, counts: { plays: 50 } },
      { shortcode: "d", url: "", kind: "post" as const, takenAt: 1, counts: {} },
    ];
    expect(catalogMix(catalog)).toEqual({ reels: 2, carousels: 1, posts: 1 });
    expect(medianPlays(catalog)).toBe(50);
    expect(kindAverages(catalog).find((k) => k.kind === "reel")?.avgPlays).toBe(55);
    expect(playsVsMedian(10, 50, [100, 10, 50]).hint).toBe("low");
    expect(playsVsMedian(100, 50, [100, 10, 50]).hint).toBe("2×");
  });

  it("splits public vs trial reach", () => {
    const split = visibilitySplit([
      {
        shortcode: "p",
        url: "",
        kind: "reel",
        takenAt: 1,
        visibility: "public",
        insights: { views: 10, reach: 8 },
        counts: { plays: 10 },
      },
      {
        shortcode: "t",
        url: "",
        kind: "reel",
        takenAt: 1,
        visibility: "trial",
        insights: { views: 4, reach: 3 },
        counts: { plays: 4 },
      },
    ]);
    expect(split.public).toMatchObject({ count: 1, views: 10, reach: 8 });
    expect(split.trial).toMatchObject({ count: 1, views: 4, reach: 3 });
  });
});
