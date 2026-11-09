import { describe, expect, it } from "vitest";
import {
  accountPathFor,
  avgRank,
  clampCatalogCount,
  instagramProfilesFromText,
  instagramUrlFromText,
  instagramUrlsFromText,
  isOwnPost,
  shareSheetText,
  keysInRange,
  playsVsMedian,
  sortCatalogItems,
  starsFromRank,
  toggleSavedFor,
  effectiveSavedFor,
  onShelf,
  postHealth,
  needsRun,
  accountCatalogReady,
  catalogTotals,
  monthTotals,
  virality,
  type CatalogItem,
  type InstagramPost,
  JOB_GROUPS,
  expandJobs,
  groupStatus,
  recipeFromPreset,
  usefulAltText,
} from "./instagram";

describe("instagramUrlFromText", () => {
  it("returns a reel URL as-is", () => {
    expect(instagramUrlFromText("https://www.instagram.com/reel/TestReel001/")).toBe(
      "https://www.instagram.com/reel/TestReel001/",
    );
  });

  it("pulls a URL out of Android share-sheet text", () => {
    expect(
      instagramUrlFromText(
        "Check this out\nhttps://www.instagram.com/reel/TestReel001/?igsh=abc",
      ),
    ).toBe("https://www.instagram.com/reel/TestReel001/?igsh=abc");
  });

  it("accepts an app share link and a missing protocol", () => {
    expect(instagramUrlFromText("instagram.com/share/reel/BAJ8xyz/")).toBe(
      "https://instagram.com/share/reel/BAJ8xyz/",
    );
  });

  it("strips trailing punctuation", () => {
    expect(instagramUrlFromText("see https://www.instagram.com/p/TestPost001/.")).toBe(
      "https://www.instagram.com/p/TestPost001/",
    );
  });

  it("ignores a profile URL and empty text", () => {
    expect(instagramUrlFromText("https://www.instagram.com/someuser/")).toBeNull();
    expect(instagramUrlFromText("")).toBeNull();
  });
});

describe("shareSheetText", () => {
  it("joins the PWA share-target query fields", () => {
    expect(
      shareSheetText(
        "?url=https://www.instagram.com/reel/TestReel001/&text=Check+this+out",
      ),
    ).toBe("https://www.instagram.com/reel/TestReel001/\nCheck this out");
  });

  it("is empty when the query has no share fields", () => {
    expect(shareSheetText("")).toBe("");
    expect(shareSheetText("?foo=bar")).toBe("");
  });
});

describe("instagramUrlsFromText", () => {
  it("collects every post link and skips duplicates", () => {
    expect(
      instagramUrlsFromText(`
        https://www.instagram.com/reel/TestReel001/?igsh=abc
        https://www.instagram.com/p/TestPost001/
        https://www.instagram.com/reel/TestReel001/
      `),
    ).toEqual([
      "https://www.instagram.com/reel/TestReel001/?igsh=abc",
      "https://www.instagram.com/p/TestPost001/",
    ]);
  });
});

describe("instagramUrlsFromText with YouTube", () => {
  it("takes YouTube videos and Shorts, keeping different videos apart", () => {
    expect(
      instagramUrlsFromText(`
        https://youtu.be/dQw4w9WgXcQ.
        https://www.youtube.com/watch?v=AAAAAAAAAAA&t=4
        https://www.youtube.com/watch?v=BBBBBBBBBBB
        https://www.youtube.com/shorts/dQw4w9WgXcQ
      `),
    ).toEqual([
      "https://youtu.be/dQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=AAAAAAAAAAA&t=4",
      "https://www.youtube.com/watch?v=BBBBBBBBBBB",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    ]);
  });
});

describe("instagramProfilesFromText", () => {
  it("collects profile URLs and @handles, skipping reserved paths", () => {
    expect(
      instagramProfilesFromText(
        "see @nike and https://www.instagram.com/someuser/\nalso instagram.com/p/TestPost001/",
      ),
    ).toEqual(["https://www.instagram.com/nike/", "https://www.instagram.com/someuser/"]);
  });
});

describe("research helpers", () => {
  it("averages set ranks and prefers plays for virality", () => {
    expect(avgRank([8, undefined, 6])).toBe(7);
    const plays = { counts: { plays: 12000, likes: 3, fetchedAt: 0 } } as InstagramPost;
    const likes = { counts: { likes: 40, fetchedAt: 0 } } as InstagramPost;
    expect(virality(plays)).toBe(12000);
    expect(virality(likes)).toBe(40);
  });
});

describe("catalog helpers", () => {
  it("clamps count and sorts missing stats last", () => {
    expect(clampCatalogCount(undefined)).toBe(12);
    expect(clampCatalogCount(400)).toBe(200);
    const rows = [
      { shortcode: "a", url: "", kind: "reel", takenAt: 2, counts: { plays: 10 } },
      { shortcode: "b", url: "", kind: "reel", takenAt: 3, counts: {} },
      { shortcode: "c", url: "", kind: "reel", takenAt: 1, counts: { plays: 50 } },
    ] as CatalogItem[];
    expect(sortCatalogItems(rows, "plays").map((r) => r.shortcode)).toEqual(["c", "a", "b"]);
    expect(sortCatalogItems(rows, "posted").map((r) => r.shortcode)).toEqual(["b", "a", "c"]);
    expect(playsVsMedian(10, 50, [100, 10, 50])).toBe("low");
    expect(playsVsMedian(100, 50, [100, 10, 50])).toBe("2×");
  });
});

describe("rating and range select", () => {
  it("caps legacy 1–10 ranks at five stars", () => {
    expect(starsFromRank(undefined)).toBe(0);
    expect(starsFromRank(3)).toBe(3);
    expect(starsFromRank(10)).toBe(5);
  });

  it("selects an inclusive shift range", () => {
    expect(keysInRange(["a", "b", "c", "d"], "b", "d")).toEqual(["b", "c", "d"]);
    expect(keysInRange(["a", "b", "c"], undefined, "c")).toEqual(["c"]);
  });

  it("resolves an account path from id or username", () => {
    expect(
      accountPathFor("/instagram", { accountId: "acct-1", creator: { username: "x" } }, []),
    ).toBe("/instagram/accounts/acct-1");
    expect(
      accountPathFor(
        "/instagram",
        { creator: { username: "Natasha_Fernshah" } },
        [{ id: "acct-2", username: "natasha_fernshah" }],
      ),
    ).toBe("/instagram/accounts/acct-2");
  });
});

describe("accountCatalogReady", () => {
  const base = {
    available: false,
    allowed: true,
    cloud: false,
    ai: false,
    source: "apify" as const,
    session: { configured: false, valid: null, source: "none" as const },
    apify: { configured: false, valid: null, source: "none" as const },
    limits: { maxSlideMb: 200, maxPostMb: 500 },
  };

  it("lets Mine catalog pull when Graph is configured", () => {
    expect(accountCatalogReady({ ...base, graph: { configured: true } }, true)).toBe(true);
    expect(accountCatalogReady({ ...base, graph: { configured: true } }, false)).toBe(false);
    expect(accountCatalogReady({ ...base, available: true }, false)).toBe(true);
    expect(accountCatalogReady(null, true)).toBe(false);
  });
});

describe("isOwnPost", () => {
  it("matches by account id or handle", () => {
    const mine = { id: "acct-1", username: "TinyAcrobatics" };
    expect(isOwnPost({ accountId: "acct-1", creator: { username: "x" } }, mine)).toBe(true);
    expect(isOwnPost({ creator: { username: "tinyacrobatics" } }, mine)).toBe(true);
    expect(isOwnPost({ accountId: "other", creator: { username: "coach" } }, mine)).toBe(false);
    expect(isOwnPost({ creator: { username: "coach" } }, null)).toBe(false);
  });
});

describe("job groups", () => {
  it("always pulls info and media, whatever was asked for", () => {
    expect(expandJobs([])).toEqual(["info", "media"]);
    expect(expandJobs(["comments"])).toEqual(["info", "media", "comments"]);
    expect(recipeFromPreset("full").jobs).toContain("idea");
    expect(recipeFromPreset("stats").jobs).toEqual(["info", "stats", "media"]);
  });

  it("shows transcript and slide text as one switch", () => {
    const read = JOB_GROUPS.find((g) => g.id === "read");
    expect(read?.types).toEqual(["transcript", "vision"]);
    expect(JOB_GROUPS.filter((g) => g.locked).map((g) => g.id)).toEqual(["info", "media"]);
    expect(JOB_GROUPS.map((g) => g.id)).toContain("idea");
  });

  it("folds two job records into one status, running first", () => {
    const jobs = [
      { type: "transcript" as const, status: "done" as const },
      { type: "vision" as const, status: "running" as const },
    ];
    expect(groupStatus(jobs, ["transcript", "vision"])).toBe("running");
    expect(groupStatus([{ type: "vision", status: "error" }], ["transcript", "vision"])).toBe("error");
    expect(
      groupStatus(
        [
          { type: "transcript", status: "skipped" },
          { type: "vision", status: "done" },
        ],
        ["transcript", "vision"],
      ),
    ).toBe("done");
    expect(groupStatus(undefined, ["transcript", "vision"])).toBe("idle");
  });
});

describe("usefulAltText", () => {
  it("hides Instagram's automatic alt text and keeps real descriptions", () => {
    expect(
      usefulAltText({ accessibilityCaption: "Photo by Parenting Support on August 25, 2026." }),
    ).toBeUndefined();
    expect(usefulAltText({ accessibilityCaption: "A puppy kicking a ball" })).toBe(
      "A puppy kicking a ball",
    );
    expect(usefulAltText({})).toBeUndefined();
  });
});

describe("toggleSavedFor", () => {
  it("treats unmarked as content and never leaves a post with neither", () => {
    expect(effectiveSavedFor(undefined)).toEqual(["content"]);
    expect(toggleSavedFor(undefined, "format")).toEqual(["content", "format"]);
    expect(toggleSavedFor(["format"], "content")).toEqual(["content", "format"]);
    expect(toggleSavedFor(["content", "format"], "format")).toEqual(["content"]);
    expect(toggleSavedFor(["format"], "format")).toEqual(["content"]);
    expect(toggleSavedFor(["content"], "content")).toEqual(["content"]);
  });
});

describe("onShelf (the phone Analyzer's filter)", () => {
  it("puts an untagged post under Content and Know-how only under Know-how", () => {
    const untagged = {};
    const format = { savedFor: ["format" as const] };
    const knowhow = { knowhow: true, savedFor: ["content" as const] };
    expect(["all", "content", "format", "knowhow"].filter((s) => onShelf(untagged, s as never))).toEqual(["all", "content"]);
    expect(onShelf(format, "format")).toBe(true);
    expect(onShelf(format, "content")).toBe(false);
    expect(onShelf(knowhow, "knowhow")).toBe(true);
    expect(onShelf(knowhow, "content")).toBe(false);
  });
});

describe("catalogTotals / monthTotals", () => {
  const row = (code: string, takenAt: number, extra: Partial<CatalogItem>): CatalogItem => ({
    shortcode: code,
    url: `https://www.instagram.com/reel/${code}/`,
    kind: "reel",
    takenAt,
    counts: {},
    ...extra,
  });

  it("adds up every listed post, Graph views before public plays", () => {
    const t = catalogTotals([
      row("a", 1, { counts: { plays: 100, likes: 5 }, insights: { views: 150, saved: 2, shares: 1 } }),
      row("b", 2, { counts: { plays: 400, likes: 7, comments: 3 } }),
      row("c", 3, {}),
    ]);
    expect(t).toMatchObject({ posts: 3, views: 550, likes: 12, comments: 3, saves: 2, shares: 1 });
    expect(t.top?.shortcode).toBe("b");
    expect(catalogTotals([]).top).toBeUndefined();
  });

  it("sums per month and fills the months in between", () => {
    expect(
      monthTotals([
        ["2025-11-30", 5],
        ["2026-01-02", 1],
        ["2025-11-01T10:00:00.000Z", 2],
        ["2026-01-31", undefined],
        ["2026-13-01", 99],
        ["junk", 99],
      ]),
    ).toEqual([
      { month: "2025-11", value: 7 },
      { month: "2025-12", value: 0 },
      { month: "2026-01", value: 1 },
    ]);
    expect(monthTotals([])).toEqual([]);
  });
});

describe("postHealth (what the phone list flags)", () => {
  const now = 1_000_000_000;
  const post = (status: "processing" | "ready" | "error", ago: number, jobs: Array<"pending" | "done" | "error"> = []) => ({
    status,
    updatedAt: now - ago,
    jobs: jobs.map((s, i) => ({ type: (["info", "media", "transcript"] as const)[i], status: s })),
  });
  it("tells a live run from a stalled one, and finds posts that never ran or half failed", () => {
    expect(postHealth(post("processing", 60_000), now)).toBe("working");
    expect(postHealth(post("processing", 16 * 60_000), now)).toBe("stuck");
    expect(postHealth(post("error", 0), now)).toBe("failed");
    expect(postHealth(post("ready", 0, ["done", "error"]), now)).toBe("partial");
    expect(postHealth(post("ready", 0, ["pending", "pending"]), now)).toBe("waiting");
    expect(postHealth(post("ready", 0, ["done", "done"]), now)).toBe("done");
    expect(["working", "stuck", "failed", "partial", "waiting", "done"].filter((h) => needsRun(h as never)))
      .toEqual(["stuck", "failed", "partial", "waiting"]);
  });
});
