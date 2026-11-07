import { describe, expect, it } from "vitest";
import {
  InstagramUrlError,
  extractInstagramProfiles,
  extractInstagramUrls,
  parseInstagramUrl,
  parseProfileHandle,
  postFromText,
  shortcodeToMediaId,
} from "./url";

describe("shortcodeToMediaId", () => {
  it("decodes shortcodes into the media id Instagram's API wants", () => {
    expect(shortcodeToMediaId("TestReel001")).toBe("22458524554839412021");
    expect(shortcodeToMediaId("TestPost001")).toBe("22458524428374854965");
  });

  it("rejects strings that are not shortcodes", () => {
    expect(() => shortcodeToMediaId("no spaces!")).toThrow(InstagramUrlError);
    expect(() => shortcodeToMediaId("abc")).toThrow(InstagramUrlError);
  });
});

describe("parseInstagramUrl", () => {
  it.each([
    ["https://www.instagram.com/p/TestPost001/", "TestPost001", false],
    ["https://www.instagram.com/reel/TestReel001/?igsh=MTIz", "TestReel001", true],
    ["instagram.com/reels/TestReel001", "TestReel001", true],
    ["https://m.instagram.com/tv/TestReel001/", "TestReel001", true],
    ["https://www.instagram.com/instagram/reel/TestReel001/", "TestReel001", true],
    [
      "https://www.instagram.com/accounts/login/?next=%2Fp%2FTestPost001%2F",
      "TestPost001",
      false,
    ],
  ])("parses %s", (input, shortcode, reelHint) => {
    const parsed = parseInstagramUrl(input);
    expect(parsed.kind).toBe("post");
    if (parsed.kind !== "post") return;
    expect(parsed.shortcode).toBe(shortcode);
    expect(parsed.reelHint).toBe(reelHint);
    expect(parsed.canonical).toBe(
      `https://www.instagram.com/${reelHint ? "reel" : "p"}/${shortcode}/`,
    );
  });

  it("treats /share/reel/<code> as a post and strips the query", () => {
    expect(parseInstagramUrl("https://www.instagram.com/share/reel/BAJ8xyz/?utm=1")).toEqual({
      kind: "post",
      shortcode: "BAJ8xyz",
      reelHint: true,
      canonical: "https://www.instagram.com/reel/BAJ8xyz/",
    });
  });

  it("keeps opaque /share/ links for redirect resolution", () => {
    expect(parseInstagramUrl("https://www.instagram.com/share/BAJ8xyz/?utm=1")).toEqual({
      kind: "share",
      url: "https://www.instagram.com/share/BAJ8xyz/",
    });
  });

  it("rejects other hosts and empty input", () => {
    expect(() => parseInstagramUrl("https://example.com/p/abcdef/")).toThrow(InstagramUrlError);
    expect(() => parseInstagramUrl("   ")).toThrow(InstagramUrlError);
  });

  it("parses a profile URL and an @handle", () => {
    expect(parseInstagramUrl("https://www.instagram.com/someuser/")).toEqual({
      kind: "profile",
      username: "someuser",
      url: "https://www.instagram.com/someuser/",
    });
    expect(parseInstagramUrl("@nike")).toEqual({
      kind: "profile",
      username: "nike",
      url: "https://www.instagram.com/nike/",
    });
  });
});

describe("parseProfileHandle", () => {
  it("accepts @handle, a bare handle, and a profile URL", () => {
    expect(parseProfileHandle("@tinyacrobatics")).toBe("tinyacrobatics");
    expect(parseProfileHandle("tinyacrobatics")).toBe("tinyacrobatics");
    expect(parseProfileHandle("https://www.instagram.com/tinyacrobatics/")).toBe("tinyacrobatics");
  });
});

describe("extractInstagramUrls", () => {
  it("pulls several links out of a pasted list and drops duplicates", () => {
    const text = `
      https://www.instagram.com/reel/TestReel001/?igsh=abc
      https://www.instagram.com/p/TestPost001/
      https://www.instagram.com/reel/TestReel001/
      instagram.com/share/BAJ8xyz/
    `;
    expect(extractInstagramUrls(text)).toEqual([
      "https://www.instagram.com/reel/TestReel001/",
      "https://www.instagram.com/p/TestPost001/",
      "https://instagram.com/share/BAJ8xyz/",
    ]);
  });

  it("returns an empty list when there are no post links", () => {
    expect(extractInstagramUrls("https://www.instagram.com/someuser/\nhello")).toEqual([]);
  });
});

describe("extractInstagramProfiles", () => {
  it("pulls @handles and profile URLs, skipping reserved paths and posts", () => {
    expect(
      extractInstagramProfiles(`
        @nike
        https://www.instagram.com/humansofny/
        https://www.instagram.com/reel/TestReel001/
        @nike
      `),
    ).toEqual([
      "https://www.instagram.com/nike/",
      "https://www.instagram.com/humansofny/",
    ]);
  });
});

describe("postFromText", () => {
  it("finds an escaped post link inside a JSON blob", () => {
    expect(
      postFromText('{"url":"https:\\/\\/www.instagram.com\\/reel\\/TestReel001\\/"}'),
    ).toEqual({ shortcode: "TestReel001", reelHint: true });
  });

  it("returns null when there is no post link", () => {
    expect(postFromText("<html>nothing here</html>")).toBeNull();
  });
});
