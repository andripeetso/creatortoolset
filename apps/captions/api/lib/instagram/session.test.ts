import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "ig-session-"));
process.env.DATA_DIR = dir;
const { filesOf, loginState, mediaIdOf, PACE, readAccount, readComments, readPost, readPostInfo, saveCookies, shortcodeOf } = await import("./session");
const { ingestGate } = await import("./apify");
PACE.ms = 0;
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());

describe("a post by its link", () => {
  it("takes the code from post, reel and tv links, with or without a handle", () => {
    expect(shortcodeOf("https://www.instagram.com/reel/C0dE_x-1/?igsh=abc")).toBe("C0dE_x-1");
    expect(shortcodeOf("instagram.com/tinyacrobatics/p/ABC123/")).toBe("ABC123");
    expect(shortcodeOf("https://instagram.com/reels/XYZ")).toBe("XYZ");
    expect(shortcodeOf("https://www.instagram.com/tinyacrobatics/")).toBeNull();
  });

  it("turns a code into the media id Instagram's API takes", () => {
    expect(mediaIdOf("B")).toBe("1");
    expect(mediaIdOf("BA")).toBe("64");
    // a private post's code carries 28 characters more: they are not part of the id
    expect(mediaIdOf(`BA${"x".repeat(28)}`)).toBe("64");
  });

  it("takes the widest video, else the widest photo, of each carousel item", () => {
    expect(
      filesOf({
        carousel_media: [
          { video_versions: [{ url: "v-small", width: 480 }, { url: "v-big", width: 1080 }], image_versions2: { candidates: [{ url: "cover" }] } },
          { image_versions2: { candidates: [{ url: "p-small", width: 320 }, { url: "p-big", width: 1440 }] } },
        ],
      }),
    ).toEqual([
      { url: "v-big", kind: "video" },
      { url: "p-big", kind: "picture" },
    ]);
  });

  it("a signed-out session forgets the cookies and says to sign in again", async () => {
    saveCookies("owner", { sessionid: "s", csrftoken: "c", ds_user_id: "1" });
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      asked.push(`${url} ${(init.headers as Record<string, string>).cookie}`);
      return new Response(JSON.stringify({ message: "login_required" }), { status: 400 });
    });
    await expect(readPost("owner", "https://www.instagram.com/reel/BA/")).rejects.toThrow("Sign in again");
    expect(asked).toEqual(["https://www.instagram.com/api/v1/media/64/info/ sessionid=s; csrftoken=c; ds_user_id=1"]);
    expect(loginState("owner").signedIn).toBe(false);
  });

  it("reads a post's files and whose it is", async () => {
    saveCookies("owner", { sessionid: "s", csrftoken: "c", ds_user_id: "1" });
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ items: [{ code: "BA", user: { username: "tinyacrobatics" }, video_versions: [{ url: "v", width: 720 }] }] })));
    expect(await readPost("owner", "https://www.instagram.com/p/BA/")).toEqual({ username: "tinyacrobatics", code: "BA", files: [{ url: "v", kind: "video" }] });
  });

  it("reads an account's grid and its Reels tab, a reel kept off the grid included, newest first", async () => {
    saveCookies("owner", { sessionid: "s", csrftoken: "c", ds_user_id: "1" });
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      asked.push(`${init.method} ${url.replace("https://www.instagram.com", "")}${init.body ? ` ${String(init.body)}` : ""}`);
      if (url.includes("web_profile_info")) return Response.json({ data: { user: { id: "42", username: "tinyacrobatics" } } });
      if (url.includes("/feed/user/"))
        return Response.json({ items: [{ code: "GRID", pk: "7_42", taken_at: 200, media_type: 1, like_count: 5, caption: { text: "hello" } }, { code: "SHARED", taken_at: 100, product_type: "clips" }], more_available: false });
      return Response.json({ items: [{ media: { code: "SHARED", taken_at: 100, product_type: "clips" } }, { media: { code: "OFFGRID", taken_at: 300, product_type: "clips", play_count: 900 } }], paging_info: { more_available: false } });
    });
    const items = await readAccount("owner", "tinyacrobatics", 50);
    expect(items.map((i) => [i.shortcode, i.kind, i.takenAt])).toEqual([
      ["OFFGRID", "reel", 300_000],
      ["GRID", "post", 200_000],
      ["SHARED", "reel", 100_000],
    ]);
    expect(items[0]!.counts.plays).toBe(900);
    expect(items[1]).toMatchObject({ graphId: "7", captionPreview: "hello", counts: { likes: 5 }, url: "https://www.instagram.com/p/GRID/" });
    expect(asked).toEqual([
      "GET /api/v1/users/web_profile_info/?username=tinyacrobatics",
      "GET /api/v1/feed/user/42/?count=33",
      "POST /api/v1/clips/user/ target_user_id=42&page_size=24&include_feed_video=true",
    ]);
  });

  it("reads a carousel in full: a video slide with its poster, a photo slide, the caption and counts", async () => {
    saveCookies("owner", { sessionid: "s", csrftoken: "c", ds_user_id: "1" });
    vi.stubGlobal("fetch", async () =>
      Response.json({
        items: [{
          code: "BA", pk: "64_9", taken_at: 50, media_type: 8, like_count: 3, comment_count: 2, caption: { text: "two slides" }, user: { pk: 9, username: "tinyacrobatics" },
          carousel_media: [
            { video_versions: [{ url: "v", width: 720, height: 1280 }], video_duration: 12.5, image_versions2: { candidates: [{ url: "poster", width: 720 }] } },
            { image_versions2: { candidates: [{ url: "photo", width: 1080, height: 1350 }] }, accessibility_caption: "a handstand" },
          ],
        }],
      }),
    );
    const { info } = await readPostInfo("owner", "https://www.instagram.com/p/BA/");
    expect(info).toMatchObject({ shortcode: "BA", mediaId: "64", kind: "carousel", takenAt: 50_000, caption: "two slides", creator: { username: "tinyacrobatics", id: "9" }, counts: { likes: 3, comments: 2 } });
    expect(info.slides).toEqual([
      { index: 0, kind: "video", url: "v", width: 720, height: 1280, durationS: 12.5, coverUrl: "poster" },
      { index: 1, kind: "image", url: "photo", width: 1080, height: 1350, accessibilityCaption: "a handstand" },
    ]);
  });

  it("reads comments page by page and stops at the cap with the cursor kept", async () => {
    saveCookies("owner", { sessionid: "s", csrftoken: "c", ds_user_id: "1" });
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      asked.push(url.replace("https://www.instagram.com/api/v1/media/64/comments/?can_support_threading=true&permalink_enabled=false", ""));
      const n = asked.length;
      return Response.json({ comments: [{ pk: n, text: `c${n}`, created_at: n, user: { pk: 1, username: "fan" }, child_comment_count: 1 }], next_min_id: `cur${n}`, has_more_comments: true });
    });
    const r = await readComments("owner", "https://www.instagram.com/p/BA/", 2);
    expect(r.status).toBe("capped");
    expect(r.cursor).toBe("cur2");
    expect(r.comments.map((c) => [c.text, c.createdAt, c.replyCount])).toEqual([["c1", 1000, 1], ["c2", 2000, 1]]);
    expect(asked).toEqual(["", "&min_id=cur1"]);
  });

  it("with no Apify key, the Content Analyzer's gate lets the reads through the sign-in", async () => {
    saveCookies("owner", { sessionid: "s", csrftoken: "c", ds_user_id: "1" });
    expect(await ingestGate("owner")).toEqual({ ok: true, mode: "session" });
    expect((await ingestGate("nobody")).ok).toBe(false);
  });

  it("an account whose id is known reads no profile first", async () => {
    saveCookies("owner", { sessionid: "s", csrftoken: "c", ds_user_id: "1" });
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      asked.push(url.replace("https://www.instagram.com", "").split("?")[0]!);
      return url.includes("/feed/user/") ? Response.json({ items: [], more_available: false }) : Response.json({ items: [], paging_info: { more_available: false } });
    });
    await readAccount("owner", "tinyacrobatics", 50, undefined, "42");
    expect(asked).toEqual(["/api/v1/feed/user/42/", "/api/v1/clips/user/"]);
  });
});
