import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "ig-apify-"));
process.env.DATA_DIR = dataDir;
delete process.env.APIFY_TOKEN;
delete process.env.INSTAGRAM_COOKIE;

const {
  APIFY_INVALID_MSG,
  activeApifyRuns,
  checkApify,
  clearApify,
  commentsFromApify,
  fetchPostViaApify,
  ingestGate,
  normalizeApifyPost,
  publicApifyStatus,
  readApify,
  readMode,
  writeApify,
  writeMode,
} = await import("./apify");
type StoredApify = import("./apify").StoredApify;

const token = "apify_api_test_token_value_do_not_leak";
const OWNER = "alex";
const OTHER = "other";

const jsonRes = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    body: null,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }) as unknown as Response;

const stored = (): StoredApify => ({
  token,
  savedAt: 1,
  savedBy: OWNER,
  valid: true,
  source: "file",
});

describe("normalizeApifyPost", () => {
  it("shapes a still image", () => {
    const info = normalizeApifyPost(
      {
        type: "Image",
        shortCode: "TestPost001",
        id: "1234567890123456780",
        caption: "Everyday photos",
        likesCount: 10,
        commentsCount: 2,
        displayUrl: "https://scontent.cdninstagram.com/v/t51/01.jpg",
        dimensionsWidth: 1080,
        dimensionsHeight: 1350,
        timestamp: "2026-06-22T01:19:46.000Z",
        ownerUsername: "nike",
        ownerFullName: "Nike",
        ownerId: "123",
        alt: "A shoe",
      },
      "https://www.instagram.com/p/TestPost001/",
    );
    expect(info.kind).toBe("post");
    expect(info.shortcode).toBe("TestPost001");
    expect(info.mediaId).toBe("1234567890123456780");
    expect(info.creator).toEqual({ username: "nike", fullName: "Nike", id: "123" });
    expect(info.counts).toEqual({ likes: 10, comments: 2, plays: undefined });
    expect(info.slides).toEqual([
      {
        index: 0,
        kind: "image",
        url: "https://scontent.cdninstagram.com/v/t51/01.jpg",
        width: 1080,
        height: 1350,
        accessibilityCaption: "A shoe",
      },
    ]);
  });

  it("shapes a reel with plays and a cover", () => {
    const info = normalizeApifyPost(
      {
        type: "Video",
        productType: "clips",
        shortCode: "TestReel001",
        id: "1234567890123456789",
        caption: "Every room",
        likesCount: 4,
        commentsCount: 1,
        videoPlayCount: 99,
        videoUrl: "https://scontent.cdninstagram.com/v/t50/r.mp4",
        displayUrl: "https://scontent.cdninstagram.com/v/t51/c.jpg",
        videoDuration: 34.8,
        dimensionsWidth: 720,
        dimensionsHeight: 1280,
        ownerUsername: "instagram",
        ownerId: 25025320,
      },
      "https://www.instagram.com/reel/TestReel001/",
    );
    expect(info.kind).toBe("reel");
    expect(info.url).toBe("https://www.instagram.com/reel/TestReel001/");
    expect(info.counts.plays).toBe(99);
    expect(info.slides[0]).toMatchObject({
      kind: "video",
      url: "https://scontent.cdninstagram.com/v/t50/r.mp4",
      durationS: 34.8,
      coverUrl: "https://scontent.cdninstagram.com/v/t51/c.jpg",
    });
    expect(info.creator.id).toBe("25025320");
  });

  it("shapes a sidecar from childPosts (mixed image + video)", () => {
    const info = normalizeApifyPost(
      {
        type: "Sidecar",
        shortCode: "TestPost002",
        id: "1234567890123456789",
        caption: "Grateful",
        likesCount: 14,
        commentsCount: 1,
        displayUrl: "https://scontent.cdninstagram.com/v/t51/cover.jpg",
        ownerUsername: "sample.creator",
        ownerId: "1234567",
        childPosts: [
          {
            type: "Image",
            displayUrl: "https://scontent.cdninstagram.com/v/t51/a.jpg",
            dimensionsWidth: 1080,
            dimensionsHeight: 1080,
          },
          {
            type: "Video",
            videoUrl: "https://scontent.cdninstagram.com/v/t50/b.mp4",
            displayUrl: "https://scontent.cdninstagram.com/v/t51/b.jpg",
            videoDuration: 6.7,
            dimensionsWidth: 720,
            dimensionsHeight: 1280,
          },
        ],
      },
      "https://www.instagram.com/p/TestPost002/",
    );
    expect(info.kind).toBe("carousel");
    expect(info.slides).toHaveLength(2);
    expect(info.slides[0].kind).toBe("image");
    expect(info.slides[1].kind).toBe("video");
    expect(info.slides[1].coverUrl).toContain("b.jpg");
  });

  it("falls back to carouselImages when childPosts is missing", () => {
    const info = normalizeApifyPost(
      {
        type: "Sidecar",
        shortCode: "TestPost002",
        id: "1",
        ownerUsername: "x",
        carouselImages: [
          "https://scontent.cdninstagram.com/v/t51/a.jpg",
          "https://scontent.cdninstagram.com/v/t51/b.jpg",
        ],
      },
      "https://www.instagram.com/p/TestPost002/",
    );
    expect(info.kind).toBe("carousel");
    expect(info.slides.map((s) => s.url)).toEqual([
      "https://scontent.cdninstagram.com/v/t51/a.jpg",
      "https://scontent.cdninstagram.com/v/t51/b.jpg",
    ]);
  });
});

describe("commentsFromApify", () => {
  it("maps nested replies", () => {
    const comments = commentsFromApify([
      {
        id: "1",
        text: "hello",
        ownerUsername: "ann",
        ownerId: "10",
        timestamp: "2026-01-01T00:00:00.000Z",
        likesCount: 3,
        repliesCount: 1,
        replies: [
          {
            id: "2",
            text: "hi",
            ownerUsername: "bob",
            timestamp: "2026-01-01T00:01:00.000Z",
            likesCount: 0,
          },
        ],
      },
    ]);
    expect(comments).toHaveLength(1);
    expect(comments[0].user.username).toBe("ann");
    expect(comments[0].replies).toHaveLength(1);
    expect(comments[0].replies[0].text).toBe("hi");
  });

  it("nests items that only carry parentCommentId", () => {
    const comments = commentsFromApify([
      { id: "1", text: "top", ownerUsername: "ann" },
      { id: "2", text: "reply", ownerUsername: "bob", parentCommentId: "1" },
      { id: "9", shortCode: "abc", caption: "not a comment", ownerUsername: "skip" },
    ]);
    expect(comments).toHaveLength(1);
    expect(comments[0].replies.map((r) => r.id)).toEqual(["2"]);
  });
});

describe("apify store", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await clearApify(OWNER);
    await clearApify(OTHER);
    await writeMode(OWNER, "session");
  });

  it("writes an owner-only file and never exposes the token", async () => {
    await writeApify(OWNER, stored());
    const file = path.join(dataDir, "instagram", "users", OWNER, "apify.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const status = publicApifyStatus(await readApify(OWNER));
    expect(JSON.stringify(status)).not.toContain(token);
    expect(status).toMatchObject({ configured: true, valid: true, savedBy: OWNER, source: "file" });
    expect(status).not.toHaveProperty("token");
  });

  it("keeps two users' tokens apart", async () => {
    const otherToken = "apify_api_other_user_token_secret";
    await writeApify(OWNER, stored());
    await writeApify(OTHER, { ...stored(), token: otherToken, savedBy: OTHER });
    expect((await readApify(OWNER))?.token).toBe(token);
    expect((await readApify(OTHER))?.token).toBe(otherToken);
    expect(JSON.stringify(publicApifyStatus(await readApify(OWNER)))).not.toContain(otherToken);
    expect(JSON.stringify(publicApifyStatus(await readApify(OTHER)))).not.toContain(token);
  });

  it("does not unlock another user from a leftover global apify.json", async () => {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dataDir, "instagram"), { recursive: true });
    await fs.writeFile(
      path.join(dataDir, "instagram", "apify.json"),
      JSON.stringify({ token, savedAt: 1, savedBy: OWNER, valid: true, source: "file" }),
      { mode: 0o600 },
    );
    expect(await readApify(OTHER)).toBeNull();
    const mine = await readApify(OWNER);
    expect(mine?.token).toBe(token);
    expect(() => statSync(path.join(dataDir, "instagram", "apify.json"))).toThrow();
    expect(statSync(path.join(dataDir, "instagram", "users", OWNER, "apify.json")).mode & 0o777).toBe(
      0o600,
    );
  });

  it("checkApify accepts users/me and stores the username", async () => {
    await writeApify(OWNER, { ...stored(), valid: null });
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.apify.com/v2/users/me");
      expect(String((init?.headers as Record<string, string>).Authorization)).toBe(
        `Bearer ${token}`,
      );
      return jsonRes(200, { data: { username: "alex", id: "user_1" } });
    });
    const s = await checkApify(OWNER, fetchImpl as unknown as typeof fetch);
    expect(s?.valid).toBe(true);
    expect(s?.account).toEqual({ id: "user_1", username: "alex" });
  });

  it("checkApify treats 401 as an invalid token", async () => {
    await writeApify(OWNER, { ...stored(), valid: true });
    const fetchImpl = vi.fn(async () => jsonRes(401, { error: { message: "nope" } }));
    const s = await checkApify(OWNER, fetchImpl as unknown as typeof fetch);
    expect(s?.valid).toBe(false);
    expect(s?.invalidReason).toMatch(/401/);
  });

  it("ingestGate follows the chosen source", async () => {
    expect((await ingestGate(OWNER)).ok).toBe(false);
    await writeApify(OWNER, stored());
    await writeMode(OWNER, "apify");
    expect(await ingestGate(OWNER)).toEqual({ ok: true, mode: "apify" });
    await writeMode(OWNER, "session");
    const gate = await ingestGate(OWNER);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.code).toBe("NO_SESSION");
  });

  it("defaults to apify when only a token exists", async () => {
    await writeApify(OWNER, stored());
    await import("node:fs/promises").then((fs) =>
      fs.rm(path.join(dataDir, "instagram", "users", OWNER, "source.json"), { force: true }),
    );
    expect(await readMode(OWNER)).toBe("apify");
  });

  it("fetchPostViaApify retries the other resultsType when the first run is empty", async () => {
    await writeApify(OWNER, stored());
    await writeMode(OWNER, "apify");
    const post = {
      type: "Image",
      shortCode: "TestPost001",
      id: "1",
      displayUrl: "https://scontent.cdninstagram.com/v/t51/a.jpg",
      ownerUsername: "x",
    };
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { resultsType?: string };
      if (body.resultsType === "reels") return jsonRes(200, []);
      return jsonRes(200, [post]);
    });
    const { info } = await fetchPostViaApify("https://www.instagram.com/p/TestPost001/", {
      username: OWNER,
      reelHint: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(info.shortcode).toBe("TestPost001");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("marks the token invalid when an actor run returns 401", async () => {
    await writeApify(OWNER, stored());
    const fetchImpl = vi.fn(async () => jsonRes(401, { error: { message: "unauthorized" } }));
    await expect(
      fetchPostViaApify("https://www.instagram.com/p/TestPost001/", {
        username: OWNER,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ message: APIFY_INVALID_MSG });
    expect((await readApify(OWNER))?.valid).toBe(false);
  });

  it("keeps the token valid when a run is refused for the monthly usage limit", async () => {
    await writeApify(OWNER, stored());
    const fetchImpl = vi.fn(async (u: string) =>
      u.endsWith("/users/me")
        ? jsonRes(200, { data: { id: "a1", username: "me" } })
        : jsonRes(403, { error: { type: "platform-feature-disabled", message: "Monthly usage hard limit exceeded" } }),
    );
    await expect(
      fetchPostViaApify("https://www.instagram.com/p/TestPost001/", {
        username: OWNER,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ message: "Apify refused the run: Monthly usage hard limit exceeded" });
    expect((await readApify(OWNER))?.valid).not.toBe(false);
  });
});

describe("publicApifyStatus", () => {
  it("returns none when nothing is stored", () => {
    expect(publicApifyStatus(null)).toEqual({ configured: false, valid: null, source: "none" });
  });
});

describe("apify run limiter and retries", () => {
  const url = "https://www.instagram.com/p/TestPost001/";
  const samplePost = {
    type: "Image",
    shortCode: "TestPost001",
    id: "1",
    displayUrl: "https://scontent.cdninstagram.com/v/t51/a.jpg",
    ownerUsername: "x",
  };

  it("waits out the concurrent-runs limit and retries", async () => {
    await writeApify(OWNER, stored());
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return jsonRes(402, { error: { type: "concurrent-runs-limit-exceeded", message: "limit of 5" } });
      }
      return jsonRes(200, [samplePost]);
    });
    const sleeps: number[] = [];
    const { info } = await fetchPostViaApify(url, {
      username: OWNER,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(info.shortcode).toBe("TestPost001");
    expect(sleeps).toEqual([15_000]);
    expect(activeApifyRuns(OWNER)).toBe(0);
  });

  it("does not retry a credit refusal", async () => {
    await writeApify(OWNER, stored());
    const fetchImpl = vi.fn(async () =>
      jsonRes(402, { error: { type: "insufficient-credit", message: "You have insufficient credit" } }),
    );
    await expect(
      fetchPostViaApify(url, {
        username: OWNER,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/insufficient credit/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("slow mode runs one actor at a time", async () => {
    await writeApify(OWNER, { ...stored(), slow: true });
    let active = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      return jsonRes(200, [samplePost]);
    });
    await Promise.all(
      [1, 2, 3].map(() =>
        fetchPostViaApify(url, { username: OWNER, fetchImpl: fetchImpl as unknown as typeof fetch }),
      ),
    );
    expect(peak).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
