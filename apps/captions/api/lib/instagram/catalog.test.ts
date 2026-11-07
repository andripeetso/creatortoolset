import { describe, expect, it } from "vitest";
import { mergeCatalog, mergeCatalogCounts, parseCatalogCount, catalogNewestAt, catalogCrossedSince } from "./catalog";
import type { CatalogItem } from "./types";

const row = (shortcode: string, extra: Partial<CatalogItem> = {}): CatalogItem => ({
  shortcode,
  url: `https://www.instagram.com/reel/${shortcode}/`,
  kind: "reel",
  takenAt: extra.takenAt ?? 1,
  counts: extra.counts ?? { plays: 10 },
  ...extra,
});

describe("parseCatalogCount", () => {
  it("defaults to 12 and clamps 1–200", () => {
    expect(parseCatalogCount(undefined)).toBe(12);
    expect(parseCatalogCount("")).toBe(12);
    expect(parseCatalogCount("25")).toBe(25);
    expect(parseCatalogCount(0)).toBe(1);
    expect(parseCatalogCount(400)).toBe(200);
    expect(parseCatalogCount("nope")).toBe(12);
  });
});

describe("catalogNewestAt", () => {
  it("is the latest takenAt so the next pull can stop there", () => {
    expect(catalogNewestAt([])).toBeUndefined();
    expect(
      catalogNewestAt([
        row("old", { takenAt: 10 }),
        row("new", { takenAt: 40 }),
        row("mid", { takenAt: 20 }),
      ]),
    ).toBe(40);
  });

  it("crosses a since watermark on older rows", () => {
    expect(catalogCrossedSince([row("new", { takenAt: 50 })], 40)).toBe(false);
    expect(catalogCrossedSince([row("old", { takenAt: 10 })], 40)).toBe(true);
    expect(catalogCrossedSince([row("new", { takenAt: 50 })], undefined)).toBe(false);
  });
});

describe("mergeCatalog", () => {
  it("keeps ideaStatus and rank from the existing row", () => {
    const prev = [row("aaa", { ideaStatus: "idea", rank: 8, takenAt: 100, counts: { plays: 1 } })];
    const next = [row("aaa", { takenAt: 100, counts: { plays: 99, likes: 4 } })];
    const merged = mergeCatalog(prev, next);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      shortcode: "aaa",
      ideaStatus: "idea",
      rank: 8,
      counts: { plays: 99, likes: 4 },
      prevCounts: { plays: 1 },
    });
  });
});

describe("mergeCatalogCounts", () => {
  it("stays empty when stats has no catalog rows to refresh", () => {
    expect(mergeCatalogCounts([], [row("brandnew")])).toEqual([]);
  });

  it("never lengthens the list and keeps marks", () => {
    const prev = [
      row("keep", { ideaStatus: "done", rank: 3, counts: { plays: 10 } }),
      row("stale", { counts: { plays: 4 } }),
    ];
    const next = [
      row("keep", { counts: { plays: 22, likes: 1 } }),
      row("brandnew", { counts: { plays: 999 } }),
    ];
    const merged = mergeCatalogCounts(prev, next);
    expect(merged.map((r) => r.shortcode)).toEqual(["keep", "stale"]);
    expect(merged[0]).toMatchObject({
      ideaStatus: "done",
      rank: 3,
      counts: { plays: 22, likes: 1 },
      prevCounts: { plays: 10 },
    });
    expect(merged[1]?.counts.plays).toBe(4);
  });

  it("keeps the Graph block and visibility basis when a newer row lacks them", () => {
    const graph = { mediaType: "VIDEO", productType: "REELS", permalink: "https://www.instagram.com/reel/aaa/", seenAt: 5, insightsAt: 5 };
    const prev = [row("aaa", { graphId: "1", graph, visibility: "trial", visibilityBasis: "not_shared_to_feed" })];
    // a library/Apify row for the same post: no Graph data, no visibility
    const merged = mergeCatalog(prev, [row("aaa", { counts: { plays: 11 } })]);
    expect(merged[0]).toMatchObject({ graph, visibility: "trial", visibilityBasis: "not_shared_to_feed", counts: { plays: 11 } });
  });

  it("takes a fresh Graph block but keeps when insights were last read if this fetch had none", () => {
    const prev = [
      row("aaa", {
        graphId: "1",
        graph: { permalink: "https://www.instagram.com/reel/aaa/", mediaUrl: "https://cdn/old.mp4", seenAt: 5, insightsAt: 5 },
        insights: { views: 3 },
      }),
    ];
    const next = [row("aaa", { graphId: "1", graph: { permalink: "https://www.instagram.com/reel/aaa/", mediaUrl: "https://cdn/new.mp4", seenAt: 9 } })];
    expect(mergeCatalog(prev, next)[0]).toMatchObject({
      graph: { mediaUrl: "https://cdn/new.mp4", seenAt: 9, insightsAt: 5 },
      insights: { views: 3 },
    });
    expect(mergeCatalogCounts(prev, next)[0]).toMatchObject({
      graph: { mediaUrl: "https://cdn/new.mp4", seenAt: 9, insightsAt: 5 },
    });
  });

  it("moves the visibility basis together with the visibility", () => {
    const prev = [row("aaa", { visibility: "public", visibilityBasis: "shared_to_feed" })];
    expect(mergeCatalog(prev, [row("aaa", { visibility: "trial", visibilityBasis: "not_shared_to_feed" })])[0]).toMatchObject({
      visibility: "trial",
      visibilityBasis: "not_shared_to_feed",
    });
    expect(mergeCatalog(prev, [row("aaa", { visibility: "public" })])[0]?.visibilityBasis).toBeUndefined();
    expect(mergeCatalogCounts(prev, [row("aaa", { visibility: "trial", visibilityBasis: "not_shared_to_feed" })])[0]).toMatchObject({
      visibility: "trial",
      visibilityBasis: "not_shared_to_feed",
    });
  });

  it("keeps Graph visibility and insights when a newer row has them", () => {
    const prev = [row("aaa", { graphId: "1", visibility: "trial", counts: { plays: 1 } })];
    const next = [
      row("aaa", {
        graphId: "1",
        visibility: "public",
        insights: { reach: 9, saved: 2 },
        counts: { plays: 4 },
      }),
    ];
    expect(mergeCatalog(prev, next)[0]).toMatchObject({
      visibility: "public",
      insights: { reach: 9, saved: 2 },
      graphId: "1",
    });
  });
});
