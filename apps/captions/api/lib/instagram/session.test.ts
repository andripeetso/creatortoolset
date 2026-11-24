import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "ig-session-"));
process.env.DATA_DIR = dir;
const { filesOf, loginState, mediaIdOf, PACE, readPost, saveCookies, shortcodeOf } = await import("./session");
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
});
