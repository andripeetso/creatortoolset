import { afterEach, describe, expect, it, vi } from "vitest";
import { pullAccount, YT_REPORTS, ytReportParams, type YtReport, type YtReportId } from "./platforms";
import type { StoredAccount } from "./store";

// The YouTube pull on a fake channel: Data API and Analytics API answered from fixtures, no network.

const DAY = 86_400_000;
const account = { key: "youtube:UC1", platform: "youtube", platformId: "UC1", handle: "tinyacrobatics", via: "login", token: "tok" } as StoredAccount;

// rows in the order each report asks for: its dimensions, then its metrics
const FIXTURE: Partial<Record<YtReportId, unknown[][]>> = {
  day: [
    ["2026-10-20", 120, 45, 3, 1, 9, 0, 2, 1, 61, 40],
    ["2026-10-21", 80, 30, 2, 0, 5, 0, 1, 0, 58, 38],
  ],
  countries: [["US", 150, 70, 61, 4]],
};

function fakeChannel(withheld: YtReportId[] = []) {
  const analytics: URL[] = [];
  vi.stubGlobal("fetch", async (url: string | URL) => {
    const u = new URL(String(url));
    if (u.hostname === "youtubeanalytics.googleapis.com") {
      analytics.push(u);
      const id = (Object.keys(YT_REPORTS) as YtReportId[]).find((k) => YT_REPORTS[k].dimensions.join(",") === u.searchParams.get("dimensions"))!;
      if (withheld.includes(id)) return Response.json({ error: { code: 403, message: "not available" } }, { status: 403 });
      return Response.json({ kind: "youtubeAnalytics#resultTable", rows: FIXTURE[id] ?? [] });
    }
    if (u.pathname.endsWith("/channels"))
      return Response.json({ items: [{ id: "UC1", snippet: { title: "Tiny Acrobatics" }, statistics: { subscriberCount: "1200", viewCount: "99000", videoCount: "40" }, contentDetails: { relatedPlaylists: { uploads: "" } } }] });
    return Response.json({}, { status: 404 });
  });
  return analytics;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("TikTok snapshots", () => {
  const tiktok = { key: "tiktok:o1", platform: "tiktok", platformId: "o1", handle: "tinyacrobatics", via: "login", token: "tok" } as StoredAccount;

  // one video whose running totals are `views`, as the Display API reports them
  function fakeTiktok(views: number) {
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/user/info/")) return Response.json({ data: { user: { open_id: "o1", display_name: "Tiny Acrobatics", username: "tinyacrobatics" } } });
      if (u.includes("/video/list/")) return Response.json({ data: { videos: [{ id: "v1", create_time: 1_700_000_000, view_count: views, like_count: 5 }], has_more: false } });
      return Response.json({}, { status: 404 });
    });
  }

  it("keeps one row per day for each post, a same-day pull replacing that day's row", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-11-01T12:00:00Z"));
    fakeTiktok(100);
    const first = await pullAccount(tiktok, "tinyacrobatics");
    expect(first.snapshots).toEqual([{ day: "2026-11-01", id: "v1", views: 100, likes: 5 }]);

    vi.setSystemTime(Date.parse("2026-11-02T12:00:00Z"));
    fakeTiktok(150);
    const second = await pullAccount({ ...tiktok, snapshots: first.snapshots }, "tinyacrobatics");
    expect(second.snapshots).toEqual([
      { day: "2026-11-01", id: "v1", views: 100, likes: 5 },
      { day: "2026-11-02", id: "v1", views: 150, likes: 5 },
    ]);

    fakeTiktok(170);
    const again = await pullAccount({ ...tiktok, snapshots: second.snapshots }, "tinyacrobatics");
    expect(again.snapshots).toEqual([
      { day: "2026-11-01", id: "v1", views: 100, likes: 5 },
      { day: "2026-11-02", id: "v1", views: 170, likes: 5 },
    ]);
  });
});

describe("YouTube channel report", () => {
  it("asks every report about channel==MINE over the last 28 days, with its sort and row limit", async () => {
    const analytics = fakeChannel();
    await pullAccount(account, "tinyacrobatics");
    expect(analytics).toHaveLength(Object.keys(YT_REPORTS).length);
    for (const u of analytics) {
      expect(u.searchParams.get("ids")).toBe("channel==MINE");
      const days = (Date.parse(u.searchParams.get("endDate")!) - Date.parse(u.searchParams.get("startDate")!)) / DAY;
      // the videos report covers the whole channel; the others the last 28 days
      if (u.searchParams.get("dimensions")?.startsWith("video")) expect(u.searchParams.get("startDate")).toBe("2005-01-01");
      else expect(days).toBe(28);
    }
    const countries = analytics.find((u) => u.searchParams.get("dimensions") === "country")!;
    expect(countries.searchParams.get("metrics")).toBe("views,estimatedMinutesWatched,averageViewDuration,subscribersGained");
    expect(countries.searchParams.get("sort")).toBe("-views");
    expect(countries.searchParams.get("maxResults")).toBe("25");
    const day = analytics.find((u) => u.searchParams.get("dimensions") === "day")!;
    expect(day.searchParams.get("sort")).toBe("day");
    expect(day.searchParams.has("maxResults")).toBe(false);
  });

  it("keeps the daily series in the stats and returns every report's rows by name", async () => {
    fakeChannel();
    const got = await pullAccount(account, "tinyacrobatics");
    expect(got.stats.days).toEqual([
      { day: "2026-10-20", views: 120, watchMinutes: 45, followersGained: 3 },
      { day: "2026-10-21", views: 80, watchMinutes: 30, followersGained: 2 },
    ]);
    expect(got.reports?.day?.[0]).toMatchObject({ day: "2026-10-20", subscribersLost: 1, averageViewPercentage: 40 });
    expect(got.reports?.countries).toEqual([{ country: "US", views: 150, estimatedMinutesWatched: 70, averageViewDuration: 61, subscribersGained: 4 }]);
  });

  it("leaves a report the platform withholds out, not zero, and still returns the others", async () => {
    fakeChannel(["countries"]);
    const got = await pullAccount(account, "tinyacrobatics");
    expect(got.reports?.countries).toBeUndefined();
    expect(got.reports?.day).toHaveLength(2);
    expect(got.stats.days).toHaveLength(2);
  });

  describe("every video, Shorts and retention", () => {
    const uploads = { ...account, platformId: "UC1" } as StoredAccount;
    // one row of the videos report: video, creatorContentType, then its eight metrics
    const videoRow = (i: number, kind: string) => [`v${i}`, kind, 1000 - i, 10, 30, 50, 1, 0, 0, 0];

    // a channel with three uploads, the videos report in the pages given, and retention withheld for the listed videos
    function fakeUploads(pages: unknown[][][], withheldRetention: string[] = []) {
      const analytics: URL[] = [];
      vi.stubGlobal("fetch", async (url: string | URL) => {
        const u = new URL(String(url));
        if (u.hostname === "youtubeanalytics.googleapis.com") {
          analytics.push(u);
          const dims = u.searchParams.get("dimensions");
          if (dims === "elapsedVideoTimeRatio") {
            const v = u.searchParams.get("filters")!.replace("video==", "");
            if (withheldRetention.includes(v)) return Response.json({ error: { code: 403, message: "not available" } }, { status: 403 });
            return Response.json({ rows: [[0, 1.2, 1.1], [0.5, 0.8, 0.9]] });
          }
          if (dims === "video,creatorContentType") return Response.json({ rows: pages[(Number(u.searchParams.get("startIndex") ?? 1) - 1) / 200] ?? [] });
          return Response.json({ rows: [] });
        }
        if (u.pathname.endsWith("/channels")) return Response.json({ items: [{ id: "UC1", statistics: {}, contentDetails: { relatedPlaylists: { uploads: "UU1" } } }] });
        if (u.pathname.endsWith("/playlistItems")) return Response.json({ items: ["v1", "v2", "v3"].map((id) => ({ snippet: { resourceId: { videoId: id } } })) });
        if (u.pathname.endsWith("/videos"))
          return Response.json({ items: u.searchParams.get("id")!.split(",").map((id) => ({ id, snippet: { title: id, publishedAt: "2026-10-20T00:00:00Z" }, statistics: { viewCount: "1" }, contentDetails: { duration: "PT30S" } })) });
        return Response.json({}, { status: 404 });
      });
      return analytics;
    }

    it("pages the videos report 200 at a time from startIndex 1 and keeps 500 videos at most", async () => {
      const page = (from: number) => Array.from({ length: 200 }, (_, k) => videoRow(from + k, "VIDEO_ON_DEMAND"));
      const analytics = fakeUploads([page(1), page(201), page(401)]);
      const got = await pullAccount(uploads, "tinyacrobatics");
      const starts = analytics.filter((u) => u.searchParams.get("dimensions") === "video,creatorContentType").map((u) => u.searchParams.get("startIndex") ?? "1");
      expect(starts).toEqual(["1", "201", "401"]);
      expect(got.videos).toHaveLength(500);
      expect(got.videos?.[499]).toMatchObject({ id: "v500", kind: "VIDEO_ON_DEMAND", views: 500 });
    });

    it("tells Shorts from long videos by kind, and asks each newest video's retention on its own", async () => {
      const analytics = fakeUploads([[videoRow(1, "SHORTS"), videoRow(2, "VIDEO_ON_DEMAND")]]);
      const got = await pullAccount(uploads, "tinyacrobatics");
      expect(got.videos).toEqual([
        expect.objectContaining({ id: "v1", kind: "SHORTS", views: 999, watchMinutes: 10, averageViewSeconds: 30, averageViewPercent: 50 }),
        expect.objectContaining({ id: "v2", kind: "VIDEO_ON_DEMAND", views: 998 }),
      ]);
      const retention = analytics.filter((u) => u.searchParams.get("dimensions") === "elapsedVideoTimeRatio");
      // v3 is an upload the videos report does not list, so it has no retention to ask for
      expect(retention.map((u) => u.searchParams.get("filters"))).toEqual(["video==v1", "video==v2"]);
      expect(retention[0].searchParams.get("startDate")).toBe("2026-10-20");
      expect(got.videos?.[0].retention).toEqual([
        { elapsed: 0, watch: 1.2, relative: 1.1 },
        { elapsed: 0.5, watch: 0.8, relative: 0.9 },
      ]);
    });

    it("leaves a withheld video's retention out and keeps the video", async () => {
      fakeUploads([[videoRow(1, "SHORTS"), videoRow(2, "VIDEO_ON_DEMAND")]], ["v2"]);
      const got = await pullAccount(uploads, "tinyacrobatics");
      expect(got.videos?.find((v) => v.id === "v2")).toBeDefined();
      expect(got.videos?.find((v) => v.id === "v2")?.retention).toBeUndefined();
      expect(got.videos?.find((v) => v.id === "v1")?.retention).toHaveLength(2);
    });
  });

  it("every report follows the Analytics API rules for channel reports", () => {
    for (const [id, r] of Object.entries(YT_REPORTS) as [string, YtReport][]) {
      expect(r.metrics.length, id).toBeGreaterThan(0);
      const names = new Set([...r.dimensions, ...r.metrics]);
      expect(names.has(r.sort.replace(/^-/, "")), `${id} sorts by a column it returns`).toBe(true);
      if (r.maxResults !== undefined) expect(r.maxResults, id).toBeLessThanOrEqual(200);
      if (r.dimensions[0] !== "day") expect(r.maxResults, `${id} is a ranked report`).toBeGreaterThan(0);
      const q = ytReportParams(r, "2026-10-01", "2026-10-28");
      expect(q.get("dimensions")).toBe(r.dimensions.join(","));
      expect(q.get("metrics")).toBe(r.metrics.join(","));
    }
  });
});

describe("Instagram login reader", () => {
  const ig = { key: "instagram:17841", platform: "instagram", platformId: "17841", handle: "tinyacrobatics", via: "login", token: "page-token" } as StoredAccount;

  const MEDIA = {
    id: "m1",
    media_type: "VIDEO",
    media_product_type: "REELS",
    caption: "Tiny Acrobatics first roll",
    timestamp: "2026-10-20T10:00:00+0000",
    permalink: "https://www.instagram.com/reel/ABC123/",
    like_count: 12,
    comments_count: 3,
    insights: { data: [{ name: "views", values: [{ value: 300 }] }, { name: "saved", values: [{ value: 7 }] }, { name: "shares", values: [{ value: 2 }] }] },
  };

  // Graph answered from fixtures on graph.facebook.com only; `seen` collects every request. Batches answer one entry per request.
  function fakeGraph(seen: URL[] = [], media: unknown[] = [MEDIA]) {
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.hostname !== "graph.facebook.com") return Response.json({}, { status: 404 });
      seen.push(u);
      if (init?.method === "POST") {
        const batch = JSON.parse(new URLSearchParams(String(init.body)).get("batch") ?? "[]") as Array<{ relative_url: string }>;
        return Response.json(batch.map((b) => ({ code: 200, body: JSON.stringify(b.relative_url.endsWith("metric=views") ? { data: [{ name: "views", total_value: { value: 900 } }] } : { data: [] }) })));
      }
      if (u.pathname === "/v27.0/17841") return Response.json({ id: "17841", username: "tinyacrobatics", name: "Tiny Acrobatics", followers_count: 1200, follows_count: 90, media_count: 40, profile_picture_url: "https://img.test/p.jpg" });
      if (u.pathname === "/v27.0/17841/media") return Response.json({ data: media });
      if (u.pathname === "/v27.0/17841/insights" && u.searchParams.get("metric") === "reach,follower_count")
        return Response.json({
          data: [
            { name: "reach", values: [{ value: 300, end_time: "2024-05-03T07:00:00+0000" }] },
            { name: "follower_count", values: [{ value: 4, end_time: "2024-05-03T07:00:00+0000" }] },
          ],
        });
      if (u.pathname === "/v27.0/17841/insights") return Response.json({ data: [] });
      return Response.json({}, { status: 404 });
    });
  }

  it("shows the posts with their insights and the account numbers, with no Apify key and the install's Meta login set aside", async () => {
    vi.stubEnv("META_ACCESS_TOKEN", "install-token");
    vi.stubEnv("INSTAGRAM_USER_ID", "999");
    const seen: URL[] = [];
    fakeGraph(seen);
    const got = await pullAccount(ig, "tinyacrobatics");

    expect(got.name).toBe("Tiny Acrobatics");
    expect(got.stats).toMatchObject({ followers: 1200, following: 90, posts: 40, views: 900 });
    expect(got.stats.days).toEqual([{ day: "2024-05-02", reach: 300, followersGained: 4 }]);
    expect(got.posts).toEqual([
      {
        id: "m1",
        url: expect.stringContaining("ABC123"),
        at: Date.parse("2026-10-20T10:00:00Z"),
        text: "Tiny Acrobatics first roll",
        kind: "reel",
        views: 300,
        likes: 12,
        comments: 3,
        shares: 2,
        saves: 7,
      },
    ]);
    // every read ran as the connected account, on its own Instagram id
    const gets = seen.filter((u) => u.pathname.startsWith("/v27.0/17841"));
    expect(gets.length).toBeGreaterThan(0);
    for (const u of gets) expect(u.searchParams.get("access_token")).toBe("page-token");
    expect(seen.some((u) => u.pathname.includes("/999"))).toBe(false);
  });

  it("keeps the media URL of a video only: a photo's image is not a video to compare", async () => {
    vi.stubEnv("META_ACCESS_TOKEN", "install-token");
    fakeGraph([], [
      { ...MEDIA, id: "v1", media_url: "https://scontent.test/reel.mp4" },
      { ...MEDIA, id: "p1", media_type: "IMAGE", media_product_type: "FEED", caption: "Tiny Acrobatics a still", timestamp: "2026-10-21T10:00:00+0000", permalink: "https://www.instagram.com/p/PICSTILL1/", media_url: "https://scontent.test/photo.jpg" },
    ]);
    const got = await pullAccount(ig, "tinyacrobatics");
    expect(got.posts?.find((p) => p.id === "v1")?.mediaUrl).toBe("https://scontent.test/reel.mp4");
    expect(got.posts?.find((p) => p.id === "p1")).toBeDefined();
    expect(got.posts?.find((p) => p.id === "p1")?.mediaUrl).toBeUndefined();
  });

  it("reads nothing for an Instagram account with no login: no Graph call, and no other reader takes it", async () => {
    const seen: URL[] = [];
    fakeGraph(seen);
    await expect(pullAccount({ ...ig, token: undefined }, "tinyacrobatics")).rejects.toThrow("Connect this Instagram account with its login");
    await expect(pullAccount({ ...ig, via: "apify", token: undefined }, "tinyacrobatics")).rejects.toThrow("Connect this Instagram account with its login");
    expect(seen).toHaveLength(0);
  });
});

describe("Facebook Page reader", () => {
  const page = { key: "facebook:P1", platform: "facebook", platformId: "P1", handle: "tinyacrobatics", via: "login", token: "page-token" } as StoredAccount;

  // Graph answered from fixtures on graph.facebook.com. `retired` metrics answer with Meta's error, as a removed metric does.
  function fakePage(retired: string[] = []) {
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const u = new URL(String(url));
      if (u.hostname !== "graph.facebook.com") return Response.json({}, { status: 404 });
      if (u.pathname === "/v27.0/P1")
        return Response.json({ id: "P1", name: "Tiny Acrobatics", username: "tinyacrobatics", followers_count: 800, picture: { data: { url: "https://img.test/p.jpg" } } });
      if (u.pathname === "/v27.0/P1/posts")
        return Response.json({
          data: [{ id: "P1_1", message: "first roll", created_time: "2026-10-19T09:00:00+0000", permalink_url: "https://www.facebook.com/P1/posts/1", shares: { count: 4 }, reactions: { summary: { total_count: 20 } }, comments: { summary: { total_count: 2 } } }],
        });
      if (u.pathname === "/v27.0/P1/insights") {
        const metric = u.searchParams.get("metric") ?? "";
        if (retired.includes(metric)) return Response.json({ error: { code: 100, message: `(metric[0]) ${metric} is not valid` } }, { status: 400 });
        const series: Record<string, Array<{ value: number | null; end_time: string }>> = {
          page_media_view: [{ value: 150, end_time: "2026-10-18T07:00:00+0000" }, { value: 90, end_time: "2026-10-19T07:00:00+0000" }],
          page_follows: [{ value: 3, end_time: "2026-10-18T07:00:00+0000" }, { value: 1, end_time: "2026-10-19T07:00:00+0000" }],
          page_post_engagements: [{ value: 40, end_time: "2026-10-18T07:00:00+0000" }, { value: null, end_time: "2026-10-19T07:00:00+0000" }],
          page_video_views: [],
        };
        return Response.json({ data: [{ name: metric, values: series[metric] ?? [] }] });
      }
      return Response.json({}, { status: 404 });
    });
  }

  it("returns the Page's followers, its posts and the daily series, with each series' own day", async () => {
    fakePage();
    const got = await pullAccount(page, "tinyacrobatics");
    expect(got.name).toBe("Tiny Acrobatics");
    expect(got.stats.followers).toBe(800);
    expect(got.posts).toEqual([
      { id: "P1_1", url: "https://www.facebook.com/P1/posts/1", at: Date.parse("2026-10-19T09:00:00Z"), text: "first roll", likes: 20, comments: 2, shares: 4 },
    ]);
    expect(got.stats.days).toEqual([
      { day: "2026-10-18", views: 150, followersGained: 3, engagements: 40 },
      { day: "2026-10-19", views: 90, followersGained: 1 },
    ]);
  });

  it("leaves a retired or empty metric out of the days, not zero, and keeps the others", async () => {
    fakePage(["page_video_views"]);
    const got = await pullAccount(page, "tinyacrobatics");
    for (const d of got.stats.days ?? []) {
      expect(d).not.toHaveProperty("videoViews");
      expect(Object.values(d).includes(0)).toBe(false);
    }
    expect(got.stats.days).toHaveLength(2);
    expect(got.stats.days?.[0]).toMatchObject({ views: 150, followersGained: 3 });
  });

  it("asks the Page insights for one daily metric per call over the last 28 days", async () => {
    const seen: URL[] = [];
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith("/insights")) seen.push(u);
      return Response.json({ data: [] });
    });
    await pullAccount(page, "tinyacrobatics").catch(() => undefined);
    const metrics = seen.map((u) => u.searchParams.get("metric"));
    expect(metrics).toEqual(["page_media_view", "page_follows", "page_post_engagements", "page_video_views"]);
    for (const u of seen) {
      expect(u.searchParams.get("period")).toBe("day");
      expect(Number(u.searchParams.get("until")) - Number(u.searchParams.get("since"))).toBe(28 * 86400);
      expect(Math.abs(Number(u.searchParams.get("until")) - Date.now() / 1000)).toBeLessThan(120);
    }
  });
});

describe("Business Discovery reader", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  const byHandle = { key: "instagram:tinyacrobatics", platform: "instagram", platformId: "tinyacrobatics", handle: "tinyacrobatics", via: "apify" } as StoredAccount;

  it("is not registered while the switch is off, so an Instagram handle still needs its login", async () => {
    vi.stubEnv("INSTAGRAM_BUSINESS_DISCOVERY", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(pullAccount(byHandle, "owner")).rejects.toThrow("Connect this Instagram account with its login to read it");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
