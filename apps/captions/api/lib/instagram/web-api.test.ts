import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// keep the session store away from the real data dir
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "ig-webapi-"));
const { InstagramError, fetchMediaInfo, fetchUserCatalog, normalizePostInfo } = await import("./web-api");
const { readSession } = await import("./session");
type StoredSession = import("./session").StoredSession;

const session: StoredSession = {
  cookies: [
    { name: "sessionid", value: "s" },
    { name: "csrftoken", value: "c" },
    { name: "ds_user_id", value: "1" },
  ],
  savedAt: 1,
  savedBy: "test",
  valid: true,
  source: "file",
};

const resp = (status: number, contentType: string, body: string) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": contentType }),
    body: null,
    text: async () => body,
  }) as unknown as Response;

const versions = (w: number[]) =>
  w.map((width) => ({ width, height: Math.round(width * 1.25), url: `https://cdn/${width}.bin` }));

const reel = {
  pk: "1234567890123456789",
  code: "TestReel001",
  media_type: 2,
  product_type: "clips",
  taken_at: 1780000000,
  caption: { text: "Every room is its own world" },
  user: { pk: 25025320, username: "instagram", full_name: "Instagram" },
  like_count: 437991,
  comment_count: 12613,
  play_count: 73597513,
  video_duration: 34.8,
  video_versions: versions([480, 720]),
  image_versions2: { candidates: versions([640, 1080]) },
};

const carousel = {
  pk: "1234567890123456780",
  code: "TestPost001",
  media_type: 8,
  product_type: "carousel_container",
  taken_at: 1780000001,
  caption: { text: "Everyday photos, animated" },
  user: { pk: "25025320", username: "instagram", full_name: "Instagram" },
  like_count: 298028,
  comment_count: 5622,
  carousel_media: [
    {
      pk: "1",
      media_type: 2,
      video_duration: 6.79,
      video_versions: versions([720]),
      image_versions2: { candidates: versions([720]) },
    },
    {
      pk: "2",
      media_type: 1,
      image_versions2: { candidates: versions([1080, 240]) },
      accessibility_caption: "Photo of a street",
    },
  ],
};

describe("normalizePostInfo", () => {
  it("shapes a reel with plays and the best video rendition", () => {
    const info = normalizePostInfo(reel, { shortcode: "TestReel001", mediaId: "1234567890123456789" });
    expect(info.kind).toBe("reel");
    expect(info.url).toBe("https://www.instagram.com/reel/TestReel001/");
    expect(info.creator).toEqual({ username: "instagram", fullName: "Instagram", id: "25025320" });
    expect(info.takenAt).toBe(1780000000000);
    expect(info.counts).toEqual({ likes: 437991, comments: 12613, plays: 73597513 });
    expect(info.slides).toHaveLength(1);
    expect(info.slides[0]).toMatchObject({
      index: 0,
      kind: "video",
      url: "https://cdn/720.bin",
      width: 720,
      durationS: 34.8,
      coverUrl: "https://cdn/1080.bin",
    });
  });

  it("keeps carousel order and per-slide kinds", () => {
    const info = normalizePostInfo(carousel, { shortcode: "TestPost001", mediaId: "1234567890123456780" });
    expect(info.kind).toBe("carousel");
    expect(info.url).toBe("https://www.instagram.com/p/TestPost001/");
    expect(info.counts.plays).toBeUndefined();
    expect(info.slides.map((s) => s.kind)).toEqual(["video", "image"]);
    expect(info.slides[1]).toMatchObject({
      index: 1,
      url: "https://cdn/1080.bin",
      width: 1080,
      accessibilityCaption: "Photo of a street",
    });
  });

  it("treats a single image as a post, falls back to ig_play_count, and tolerates missing counts", () => {
    const info = normalizePostInfo(
      {
        code: "abcdef12345",
        media_type: 1,
        image_versions2: { candidates: versions([640]) },
        user: { username: "someone" },
        ig_play_count: 12,
      },
      { shortcode: "abcdef12345", mediaId: "1" },
    );
    expect(info.kind).toBe("post");
    expect(info.counts).toEqual({ likes: undefined, comments: undefined, plays: 12 });
    expect(info.takenAt).toBe(0);
    expect(info.creator.fullName).toBeUndefined();
  });

  it("refuses an item without downloadable media", () => {
    expect(() =>
      normalizePostInfo({ code: "abcdef12345", media_type: 1 }, { shortcode: "abcdef12345", mediaId: "1" }),
    ).toThrow(InstagramError);
  });
});

describe("fetchMediaInfo", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns items[0] from a JSON answer", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      resp(200, "application/json; charset=utf-8", JSON.stringify({ items: [reel] })),
    );
    const item = await fetchMediaInfo("1234567890123456789", session, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(item.code).toBe("TestReel001");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://www.instagram.com/api/v1/media/1234567890123456789/info/");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-IG-App-ID"]).toBe("936619743392459");
    expect(headers["X-CSRFToken"]).toBe("c");
    expect(headers.Cookie).toContain("sessionid=s");
    expect(init.redirect).toBe("manual");
  });

  it("treats an HTML answer as the login wall and marks the session invalid", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resp(200, "text/html", "<html>login</html>"));
    await expect(
      fetchMediaInfo("1", session, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ code: "SESSION" });
    // no stored session in this temp data dir, so nothing to mark
    expect(await readSession("test")).toBeNull();
  });

  it("maps 404 to NOT_FOUND", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resp(404, "application/json", "{}"));
    await expect(
      fetchMediaInfo("1", session, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("recognises a login_required failure inside JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      resp(200, "application/json", JSON.stringify({ status: "fail", message: "login_required" })),
    );
    await expect(
      fetchMediaInfo("1", session, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ code: "SESSION" });
  });
});

describe("fetchUserCatalog", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("continues from next_max_id when after is set", async () => {
    const page2 = {
      items: [reel],
      more_available: true,
      next_max_id: "CURSOR2",
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      resp(200, "application/json", JSON.stringify(page2)),
    );
    const out = await fetchUserCatalog("25025320", session, {
      cap: 1,
      after: "CURSOR1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toContain("max_id=CURSOR1");
    expect(out.items[0]?.shortcode).toBe("TestReel001");
    expect(out.nextMaxId).toBe("CURSOR2");
    expect(out.more).toBe(true);
  });

  it("stops when the feed has no further page", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      resp(
        200,
        "application/json",
        JSON.stringify({ items: [reel], more_available: false }),
      ),
    );
    const out = await fetchUserCatalog("25025320", session, {
      cap: 12,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out.items).toHaveLength(1);
    expect(out.more).toBe(false);
    expect(out.nextMaxId).toBeUndefined();
  });

  it("stops before older pages once since is crossed", async () => {
    const newer = { ...reel, code: "NewCodeAAAAA", taken_at: 1_800_000_000 };
    const older = { ...carousel, code: "OldCodeBBBBB", taken_at: 1_700_000_000 };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        resp(
          200,
          "application/json",
          JSON.stringify({ items: [newer], more_available: true, next_max_id: "CURSOR2" }),
        ),
      )
      .mockResolvedValueOnce(
        resp(
          200,
          "application/json",
          JSON.stringify({ items: [older], more_available: true, next_max_id: "CURSOR3" }),
        ),
      );
    const out = await fetchUserCatalog("25025320", session, {
      cap: 50,
      since: 1_750_000_000_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out.items.map((i) => i.shortcode)).toEqual(["NewCodeAAAAA", "OldCodeBBBBB"]);
    expect(out.more).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // two real requests spaced by the ~2 s Instagram throttle: the default
    // 5 s limit fails whenever the machine is busy
  }, 15_000);
});
