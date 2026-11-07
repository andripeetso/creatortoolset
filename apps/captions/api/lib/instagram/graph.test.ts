import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "../../lib/env";

process.env.META_ACCESS_TOKEN = "test-meta-token";
process.env.INSTAGRAM_USER_ID = "17841000000000001";
process.env.INSTAGRAM_MINE_CATALOG_CAP = "700";

const {
  applyMineVisibility,
  catalogItemFromGraph,
  classifyVisibility,
  classifyVisibilityWithBasis,
  fetchMineAccountStats,
  fetchMineCatalog,
  fetchMineCatalogAll,
  fetchMineDailyInsights,
  fetchMineProfile,
  graphConfigured,
  insightDays,
  insightsFromGraph,
  MINE_CATALOG_CAP,
  mineUsesGraph,
  profileFromGraph,
} = await import("./graph");

const jsonRes = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }) as unknown as Response;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MINE_CATALOG_CAP", () => {
  it("reads INSTAGRAM_MINE_CATALOG_CAP", () => {
    expect(MINE_CATALOG_CAP).toBe(700);
  });
});

describe("graphConfigured", () => {
  it("is true when both env vars are set", () => {
    expect(graphConfigured()).toBe(true);
  });
});

describe("mineUsesGraph", () => {
  const saved = { appSecret: env.appSecret, adminUsername: env.adminUsername };
  afterEach(() => Object.assign(env, saved));

  it("uses the shared token only for the owner's Mine account", () => {
    env.appSecret = "app-secret";
    env.adminUsername = "admin";
    expect(mineUsesGraph({ mine: true, owner: "admin" })).toBe(true);
    expect(mineUsesGraph({ mine: false, owner: "admin" })).toBe(false);
    expect(mineUsesGraph({})).toBe(false);
  });

  it("keeps another user's Mine account off the token's Instagram account", () => {
    process.env.SOCIAL_FEED_OWNER = "admin";
    expect(mineUsesGraph({ mine: true, owner: "jordan" })).toBe(false);
    expect(mineUsesGraph({ mine: true })).toBe(false);
  });
});

describe("profileFromGraph", () => {
  it("maps a professional account", () => {
    expect(
      profileFromGraph({
        id: "17841000000000001",
        username: "tinyacrobatics",
        name: "Tiny Acrobatics",
        biography: "Circus for tots",
        followers_count: 1200,
        follows_count: 80,
        media_count: 40,
        profile_picture_url: "https://scontent.cdninstagram.com/v/t51/pic.jpg",
      }),
    ).toEqual({
      igUserId: "17841000000000001",
      username: "tinyacrobatics",
      fullName: "Tiny Acrobatics",
      biography: "Circus for tots",
      profilePic: "https://scontent.cdninstagram.com/v/t51/pic.jpg",
      followers: 1200,
      following: 80,
      posts: 40,
    });
  });
});

describe("catalogItemFromGraph", () => {
  it("shapes a reel from permalink + product type", () => {
    const item = catalogItemFromGraph({
      id: "123",
      media_type: "VIDEO",
      media_product_type: "REELS",
      caption: "Spot the kick",
      timestamp: "2026-06-22T01:19:46+0000",
      permalink: "https://www.instagram.com/reel/TestReel001/",
      thumbnail_url: "https://scontent.cdninstagram.com/v/t51/thumb.jpg",
      like_count: 10,
      comments_count: 2,
    });
    expect(item).toMatchObject({
      shortcode: "TestReel001",
      url: "https://www.instagram.com/reel/TestReel001/",
      kind: "reel",
      captionPreview: "Spot the kick",
      thumbnailUrl: "https://scontent.cdninstagram.com/v/t51/thumb.jpg",
      counts: { likes: 10, comments: 2 },
    });
    expect(item?.takenAt).toBeGreaterThan(0);
  });

  it("lifts views from nested insights into plays", () => {
    const item = catalogItemFromGraph({
      id: "181",
      media_type: "VIDEO",
      media_product_type: "REELS",
      permalink: "https://www.instagram.com/reel/TestReel001/",
      timestamp: "2026-06-22T01:19:46+0000",
      like_count: 10,
      insights: {
        data: [
          { name: "views", values: [{ value: 61481 }] },
          { name: "reach", values: [{ value: 44329 }] },
          { name: "saved", values: [{ value: 598 }] },
        ],
      },
    });
    expect(item?.graphId).toBe("181");
    expect(item?.counts.plays).toBe(61481);
    expect(item?.insights).toMatchObject({ views: 61481, reach: 44329, saved: 598 });
  });

  it("keeps the raw Graph fields and when they were seen", () => {
    const item = catalogItemFromGraph(
      {
        id: "181",
        media_type: "VIDEO",
        media_product_type: "REELS",
        permalink: "https://www.instagram.com/reel/TestReel001/",
        media_url: "https://scontent.cdninstagram.com/v/t50/clip.mp4?oe=1",
        thumbnail_url: "https://scontent.cdninstagram.com/v/t51/thumb.jpg?oe=1",
        timestamp: "2026-06-22T01:19:46+0000",
        insights: { data: [{ name: "views", values: [{ value: 5 }] }] },
      },
      1234,
    );
    expect(item?.graph).toEqual({
      mediaType: "VIDEO",
      productType: "REELS",
      permalink: "https://www.instagram.com/reel/TestReel001/",
      mediaUrl: "https://scontent.cdninstagram.com/v/t50/clip.mp4?oe=1",
      thumbnailUrl: "https://scontent.cdninstagram.com/v/t51/thumb.jpg?oe=1",
      seenAt: 1234,
      insightsAt: 1234,
    });
    const bare = catalogItemFromGraph(
      { id: "182", media_type: "IMAGE", permalink: "https://www.instagram.com/p/TestPost001/" },
      99,
    );
    expect(bare?.graph?.seenAt).toBe(99);
    expect(bare?.graph?.insightsAt).toBeUndefined();
    expect(bare?.graph?.thumbnailUrl).toBeUndefined();
  });

  it("shapes a carousel feed post", () => {
    const item = catalogItemFromGraph({
      media_type: "CAROUSEL_ALBUM",
      media_product_type: "FEED",
      permalink: "https://www.instagram.com/p/TestPost001/",
      timestamp: "2026-06-22T01:19:46+0000",
      media_url: "https://scontent.cdninstagram.com/v/t51/01.jpg",
      like_count: 4,
    });
    expect(item?.kind).toBe("carousel");
    expect(item?.shortcode).toBe("TestPost001");
    expect(item?.url).toBe("https://www.instagram.com/p/TestPost001/");
  });
});

describe("fetchMineProfile", () => {
  it("GETs the connected IG user", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      expect(url).toContain("/17841000000000001?");
      expect(url).toContain("fields=");
      expect(url).not.toContain("paging.next");
      return jsonRes(200, {
        id: "17841000000000001",
        username: "tinyacrobatics",
        followers_count: 9,
        media_count: 2,
      });
    });
    const info = await fetchMineProfile({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(info.username).toBe("tinyacrobatics");
    expect(info.followers).toBe(9);
  });
});

describe("fetchMineCatalog", () => {
  it("pages with after cursors, never storing paging.next", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (!url.searchParams.get("after")) {
        return jsonRes(200, {
          data: [
            {
              media_type: "VIDEO",
              media_product_type: "REELS",
              permalink: "https://www.instagram.com/reel/AaAaAaAaAaA/",
              timestamp: "2026-01-01T00:00:00+0000",
              like_count: 1,
            },
          ],
          paging: {
            cursors: { after: "CURSOR1" },
            next: "https://graph.facebook.com/v21.0/17841000000000001/media?access_token=secret&after=CURSOR1",
          },
        });
      }
      return jsonRes(200, {
        data: [
          {
            media_type: "IMAGE",
            media_product_type: "FEED",
            permalink: "https://www.instagram.com/p/BbBbBbBbBbB/",
            timestamp: "2026-01-02T00:00:00+0000",
          },
        ],
        paging: { cursors: { after: "CURSOR2" } },
      });
    });
    const page = await fetchMineCatalog({ cap: 12, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(page.items.map((i) => i.shortcode)).toEqual(["AaAaAaAaAaA", "BbBbBbBbBbB"]);
    expect(page.items[0]?.kind).toBe("reel");
    expect(page.items[1]?.kind).toBe("post");
    expect(page.more).toBe(false);
    expect(page.nextMaxId).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const second = new URL(String(fetchImpl.mock.calls[1]![0]));
    expect(second.searchParams.get("after")).toBe("CURSOR1");
  });

  it("stops paging once a page crosses the last listed date", async () => {
    const media = (code: string, timestamp: string, after?: string) =>
      jsonRes(200, {
        data: [
          {
            media_type: "VIDEO",
            media_product_type: "REELS",
            permalink: `https://www.instagram.com/reel/${code}/`,
            timestamp,
          },
        ],
        paging: after
          ? {
              cursors: { after },
              next: `https://graph.facebook.com/v21.0/17841000000000001/media?access_token=secret&after=${after}`,
            }
          : { cursors: { after: "UNUSED" } },
      });
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      const after = url.searchParams.get("after");
      if (!after) return media("NewPostCode1", "2026-09-17T12:00:00+0000", "CURSOR1");
      if (after === "CURSOR1") return media("OldPostCode2", "2026-08-01T12:00:00+0000", "CURSOR2");
      return media("AncientCode3", "2026-01-01T12:00:00+0000");
    });
    const since = Date.parse("2026-09-10T00:00:00+0000");
    const page = await fetchMineCatalog({
      cap: 500,
      since,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(page.items.map((i) => i.shortcode)).toEqual(["NewPostCode1", "OldPostCode2"]);
    expect(page.more).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("fetchMineCatalogAll", () => {
  const reel = (id: string, code: string, timestamp: string) => ({
    id,
    media_type: "VIDEO",
    media_product_type: "REELS",
    permalink: `https://www.instagram.com/reel/${code}/`,
    timestamp,
  });

  it("adds a post the insights listing silently dropped", async () => {
    // 2026-09-24: /media with nested insights returned 235 posts, the plain listing 236.
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const fields = new URL(String(input)).searchParams.get("fields") ?? "";
      const rows = [reel("1801", "NewestCode1", "2026-09-20T10:00:00+0000")];
      if (!fields.includes("insights.")) rows.push(reel("1802", "DroppedCode", "2025-08-13T15:30:30+0000"));
      rows.push(reel("1803", "OldestCode3", "2025-01-01T10:00:00+0000"));
      return jsonRes(200, { data: rows, paging: { cursors: { after: "END" } } });
    });
    const page = await fetchMineCatalogAll({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(page.items.map((i) => i.graphId)).toEqual(["1801", "1802", "1803"]);
    expect(page.items[1]?.graph?.permalink).toBe("https://www.instagram.com/reel/DroppedCode/");
    expect(page.items[1]?.insights).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns the insights listing unchanged when nothing is missing", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonRes(200, {
        data: [reel("1901", "OnlyCode001", "2026-09-20T10:00:00+0000")],
        paging: { cursors: { after: "END" } },
      }),
    );
    const page = await fetchMineCatalogAll({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(page.items.map((i) => i.graphId)).toEqual(["1901"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("classifyVisibility", () => {
  it("reads is_shared_to_feed from the official login only; a reel without it stays unknown", () => {
    expect(classifyVisibility({ kind: "reel", isSharedToFeed: true })).toBe("public");
    expect(classifyVisibility({ kind: "reel", isSharedToFeed: false })).toBe("trial");
    expect(classifyVisibility({ kind: "carousel" })).toBe("public");
    expect(classifyVisibility({ kind: "reel" })).toBeUndefined();
  });

  it("stamps a catalog from shared-to-feed flags", () => {
    const stamped = applyMineVisibility(
      [
        { shortcode: "pub", url: "https://www.instagram.com/reel/pub/", kind: "reel", takenAt: 1, graphId: "1", counts: {} },
        { shortcode: "hid", url: "https://www.instagram.com/reel/hid/", kind: "reel", takenAt: 1, graphId: "2", counts: {} },
      ],
      new Map([
        ["1", true],
        ["2", false],
      ]),
    );
    expect(stamped.map((r) => r.visibility)).toEqual(["public", "trial"]);
    expect(stamped.map((r) => r.visibilityBasis)).toEqual(["shared_to_feed", "not_shared_to_feed"]);
  });

  it("says which evidence decided", () => {
    expect(classifyVisibilityWithBasis({ kind: "reel", isSharedToFeed: true })).toEqual({ visibility: "public", basis: "shared_to_feed" });
    expect(classifyVisibilityWithBasis({ kind: "reel", isSharedToFeed: false })).toEqual({ visibility: "trial", basis: "not_shared_to_feed" });
    expect(classifyVisibilityWithBasis({ kind: "post" })).toEqual({ visibility: "public", basis: "kind" });
    expect(classifyVisibilityWithBasis({ kind: "reel" })).toEqual({});
  });
});

describe("insightsFromGraph", () => {
  it("reads lifetime values", () => {
    expect(
      insightsFromGraph({
        data: [{ name: "total_interactions", values: [{ value: 12 }] }],
      }),
    ).toEqual({ interactions: 12 });
  });
});

describe("fetchMineAccountStats", () => {
  it("rolls daily reach and demographics", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      const metric = url.searchParams.get("metric") ?? "";
      if (metric.includes("follower_count")) {
        return jsonRes(200, {
          data: [
            {
              name: "reach",
              values: [
                { value: 10, end_time: "2026-09-16T07:00:00+0000" },
                { value: 20, end_time: "2026-09-17T07:00:00+0000" },
              ],
            },
          ],
        });
      }
      if (metric.includes("profile_views")) {
        return jsonRes(200, {
          data: [{ name: "profile_views", total_value: { value: 44 } }],
        });
      }
      if (url.searchParams.get("breakdown") === "country") {
        return jsonRes(200, {
          data: [
            {
              name: "reached_audience_demographics",
              total_value: {
                breakdowns: [{ results: [{ dimension_values: ["US"], value: 9 }] }],
              },
            },
          ],
        });
      }
      return jsonRes(200, { data: [] });
    });
    const stats = await fetchMineAccountStats({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(stats.reach30d).toBe(30);
    expect(stats.profileViews).toBe(44);
    expect(stats.countries).toEqual([{ label: "US", value: 9 }]);
  });
});

describe("insightDays", () => {
  const FETCHED = Date.UTC(2026, 8, 24, 6, 0, 3);

  it("labels each value with the day it covers and drops the day that isn't over", () => {
    const raw = {
      data: [
        {
          name: "reach",
          values: [
            { value: 5100, end_time: "2026-09-22T07:00:00+0000" },
            { value: 5400, end_time: "2026-09-23T07:00:00+0000" },
            // 23 September (Pacific) ends after the fetch: partial, left out
            { value: 300, end_time: "2026-09-24T07:00:00+0000" },
          ],
        },
        {
          name: "follower_count",
          values: [
            { value: 9, end_time: "2026-09-22T07:00:00+0000" },
            { value: 12, end_time: "2026-09-23T07:00:00+0000" },
            { value: 1, end_time: "2026-09-24T07:00:00+0000" },
          ],
        },
        { name: "impressions", values: [{ value: 1, end_time: "2026-09-23T07:00:00+0000" }] },
      ],
    };
    expect(insightDays(raw, FETCHED)).toEqual([
      { date: "2026-09-21", endTime: Date.UTC(2026, 8, 22, 7), reach: 5100, newFollows: 9 },
      { date: "2026-09-22", endTime: Date.UTC(2026, 8, 23, 7), reach: 5400, newFollows: 12 },
    ]);
  });

  it("skips values without a time or a number", () => {
    const raw = {
      data: [{ name: "reach", values: [{ value: 1 }, { value: "n/a", end_time: "2026-09-23T07:00:00+0000" }] }],
    };
    expect(insightDays(raw, FETCHED)).toEqual([]);
    expect(insightDays(null, FETCHED)).toEqual([]);
  });
});

const DAY_S = 86_400;
const NOW = Date.UTC(2026, 8, 24, 6, 0, 3);

/** Graph account insights: a value per 07:00 UTC day end, and today's partial day too. */
function dailyGraph(refuse: (url: URL) => number | null = () => null) {
  const calls: URL[] = [];
  const fetchImpl = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    calls.push(url);
    const status = refuse(url);
    if (status) return jsonRes(status, { error: { message: "(#100) refused", code: 100 } });
    const metric = url.searchParams.get("metric") ?? "";
    if (metric.includes("profile_views")) {
      return jsonRes(200, {
        data: [
          { name: "profile_views", total_value: { value: 900 } },
          { name: "accounts_engaged", total_value: { value: 3100 } },
          { name: "website_clicks", total_value: { value: 44 } },
        ],
      });
    }
    if (url.searchParams.get("breakdown")) return jsonRes(200, { data: [] });
    const since = Number(url.searchParams.get("since")) * 1000;
    const until = Number(url.searchParams.get("until")) * 1000;
    const ends: string[] = [];
    let t = Math.floor(since / 86_400_000) * 86_400_000 + 7 * 3600_000;
    if (t <= since) t += 86_400_000;
    for (; t < until + 86_400_000; t += 86_400_000) {
      ends.push(new Date(t).toISOString().replace(".000Z", "+0000"));
    }
    return jsonRes(200, {
      data: metric.split(",").map((name) => ({
        name,
        period: "day",
        values: ends.map((end_time) => ({ end_time, value: name === "reach" ? 100 : 2 })),
      })),
    });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const windowOf = (url: URL) => ({
  since: Number(url.searchParams.get("since")),
  until: Number(url.searchParams.get("until")),
  metric: url.searchParams.get("metric"),
});

describe("fetchMineDailyInsights", () => {
  it("backfills two years in 30-day windows, newest first, complete days only", async () => {
    const graph = dailyGraph();
    const { days, complete } = await fetchMineDailyInsights(NOW - 730 * DAY_S * 1000, NOW, {
      fetchImpl: graph.fetchImpl,
      now: NOW,
    });
    expect(complete).toBe(true);
    const windows = graph.calls.map(windowOf);
    expect(windows).toHaveLength(25);
    expect(windows[0]!.until).toBe(Math.floor(NOW / 1000));
    expect(windows.at(-1)!.since).toBe(Math.floor(NOW / 1000) - 730 * DAY_S);
    windows.forEach((w, i) => {
      expect(w.until - w.since).toBeLessThanOrEqual(30 * DAY_S);
      expect(w.metric).toBe("reach,follower_count");
      if (i) expect(w.until).toBe(windows[i - 1]!.since);
    });
    expect(days).toHaveLength(730);
    expect(days[0]!.date).toBe("2024-09-23");
    // 23 September (Pacific) ends at 07:00 UTC on the 24th, after the fetch
    expect(days.at(-1)).toEqual({ date: "2026-09-22", endTime: Date.UTC(2026, 8, 23, 7), reach: 100, newFollows: 2 });
    expect(new Set(days.map((d) => d.date)).size).toBe(days.length);
    expect(JSON.stringify(days)).not.toMatch(/access_token|test-meta-token/);
  });

  it("drops follower_count for the older windows once Meta refuses it", async () => {
    const recent = Math.floor(NOW / 1000) - 30 * DAY_S;
    const graph = dailyGraph((url) => {
      const w = windowOf(url);
      return w.metric?.includes("follower_count") && w.since < recent ? 400 : null;
    });
    const { days, complete } = await fetchMineDailyInsights(NOW - 90 * DAY_S * 1000, NOW, {
      fetchImpl: graph.fetchImpl,
      now: NOW,
    });
    expect(complete).toBe(true);
    expect(graph.calls.map((u) => windowOf(u).metric)).toEqual([
      "reach,follower_count",
      "reach,follower_count",
      "reach",
      "reach",
    ]);
    expect(days.at(-1)?.newFollows).toBe(2);
    expect(days[0]).not.toHaveProperty("newFollows");
    expect(days[0]?.reach).toBe(100);
  });

  it("stops at the first older window Meta refuses and still calls the run complete", async () => {
    const oldest = Math.floor(NOW / 1000) - 60 * DAY_S;
    const graph = dailyGraph((url) => (windowOf(url).since < oldest ? 400 : null));
    const { days, complete } = await fetchMineDailyInsights(NOW - 730 * DAY_S * 1000, NOW, {
      fetchImpl: graph.fetchImpl,
      now: NOW,
    });
    expect(complete).toBe(true);
    // two windows, then the refused one twice (with and without follower_count)
    expect(graph.calls).toHaveLength(4);
    expect(days.length).toBeGreaterThanOrEqual(59);
  });

  it("is incomplete when a rate limit cuts an older window, and keeps what it read", async () => {
    let n = 0;
    const graph = dailyGraph(() => (++n === 2 ? 429 : null));
    const { days, complete } = await fetchMineDailyInsights(NOW - 730 * DAY_S * 1000, NOW, {
      fetchImpl: graph.fetchImpl,
      now: NOW,
    });
    expect(complete).toBe(false);
    expect(graph.calls).toHaveLength(2);
    expect(days.length).toBeGreaterThanOrEqual(29);
  });

  it("throws when the newest window fails", async () => {
    const limited = dailyGraph(() => 429);
    await expect(
      fetchMineDailyInsights(NOW - 730 * DAY_S * 1000, NOW, { fetchImpl: limited.fetchImpl, now: NOW }),
    ).rejects.toMatchObject({ code: "RATE_LIMIT" });
    expect(limited.calls).toHaveLength(1);
    const refused = dailyGraph(() => 400);
    await expect(
      fetchMineDailyInsights(NOW - 60 * DAY_S * 1000, NOW, { fetchImpl: refused.fetchImpl, now: NOW }),
    ).rejects.toMatchObject({ code: "GRAPH" });
    expect(refused.calls.map((u) => windowOf(u).metric)).toEqual(["reach,follower_count", "reach"]);
  });
});

describe("fetchMineAccountStats windows", () => {
  it("reads the last 30 complete days and totals for the same days", async () => {
    const graph = dailyGraph();
    const stats = await fetchMineAccountStats({ fetchImpl: graph.fetchImpl, now: NOW });
    expect(stats.fetchedAt).toBe(NOW);
    expect(stats.days).toHaveLength(30);
    expect(stats.days[0]!.date).toBe("2026-08-24");
    expect(stats.days.at(-1)!.date).toBe("2026-09-22");
    expect(stats.reach30d).toBe(3000);
    expect(stats).toMatchObject({ profileViews: 900, accountsEngaged: 3100, websiteClicks: 44 });
    const totals = graph.calls.find((u) => u.searchParams.get("metric")?.includes("profile_views"))!;
    const lastEnd = Date.UTC(2026, 8, 23, 7) / 1000;
    expect(windowOf(totals)).toMatchObject({ since: lastEnd - 30 * DAY_S, until: lastEnd });
    const demo = graph.calls.filter((u) => u.searchParams.get("breakdown"));
    expect(demo.map((u) => u.searchParams.get("breakdown")).sort()).toEqual(["age", "country", "gender"]);
    for (const u of demo) {
      expect(u.searchParams.get("period")).toBe("lifetime");
      expect(u.searchParams.get("timeframe")).toBe("this_month");
      expect(u.searchParams.has("since")).toBe(false);
    }
  });
});

describe("fetchMineAccountStats totals", () => {
  it("reads each 30-day total and the views splits as separate batch items", async () => {
    let batch: Array<{ relative_url: string }> = [];
    const total = (name: string, value: number) => ({ data: [{ name, total_value: { value } }] });
    const split = (rows: Array<[string, number]>) => ({
      data: [
        {
          name: "views",
          total_value: {
            breakdowns: [{ results: rows.map(([k, value]) => ({ dimension_values: [k], value })) }],
          },
        },
      ],
    });
    const fetchImpl = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      if (init?.method !== "POST") return jsonRes(400, { error: { message: "(#100) refused", code: 100 } });
      batch = JSON.parse(new URLSearchParams(String(init.body)).get("batch")!);
      const bodies = batch.map(({ relative_url }) => {
        const url = new URL(relative_url, "https://graph.test/");
        const metric = url.searchParams.get("metric")!;
        const breakdown = url.searchParams.get("breakdown");
        if (breakdown === "follow_type") return split([["NON_FOLLOWER", 70], ["FOLLOWER", 30]]);
        if (breakdown === "media_product_type") return split([["REELS", 90], ["STORY", 10]]);
        if (metric === "replies") return { error: { message: "(#100) invalid metric", code: 100 } };
        return total(metric, metric === "views" ? 12345 : 7);
      });
      return jsonRes(200, bodies.map((b) => ({ code: 200, body: JSON.stringify(b) })));
    });
    const stats = await fetchMineAccountStats({ fetchImpl: fetchImpl as unknown as typeof fetch, now: NOW });
    expect(stats.totals).toMatchObject({ views: 12345, reach: 7, total_interactions: 7, profile_links_taps: 7 });
    expect(stats.totals).not.toHaveProperty("replies");
    expect(stats.viewsByFollower).toEqual([
      { label: "NON_FOLLOWER", value: 70 },
      { label: "FOLLOWER", value: 30 },
    ]);
    expect(stats.viewsBySurface?.[0]).toEqual({ label: "REELS", value: 90 });
    for (const { relative_url } of batch) {
      expect(relative_url).toMatch(/metric_type=total_value&period=day&since=\d+&until=\d+/);
      expect(relative_url).not.toContain("access_token");
    }
  });
});
