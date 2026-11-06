import { describe, expect, it } from "vitest";
import { extractYoutubeUrls, isYoutubeLink, parseYoutubeUrl, YoutubeUrlError } from "./url";

const ID = "dQw4w9WgXcQ";

describe("parseYoutubeUrl", () => {
  it.each([
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}&t=42s`,
    `https://m.youtube.com/watch?feature=share&v=${ID}`,
    `https://youtu.be/${ID}?si=abc`,
    `youtube.com/watch?v=${ID}`,
  ])("reads a long video from %s", (raw) => {
    expect(parseYoutubeUrl(raw)).toEqual({
      videoId: ID,
      short: false,
      canonical: `https://www.youtube.com/watch?v=${ID}`,
    });
  });

  it("reads a Short as a Short", () => {
    expect(parseYoutubeUrl(`https://www.youtube.com/shorts/${ID}?feature=share`)).toEqual({
      videoId: ID,
      short: true,
      canonical: `https://www.youtube.com/shorts/${ID}`,
    });
  });

  it("returns null for anything that is not YouTube", () => {
    expect(parseYoutubeUrl("https://www.instagram.com/reel/abc123DEF_x/")).toBeNull();
    expect(parseYoutubeUrl("@tinyacrobatics")).toBeNull();
    expect(parseYoutubeUrl("https://notyoutube.com/watch?v=" + ID)).toBeNull();
  });

  it("refuses a YouTube page with no video id", () => {
    expect(() => parseYoutubeUrl("https://www.youtube.com/@somechannel")).toThrow(YoutubeUrlError);
    expect(() => parseYoutubeUrl("https://www.youtube.com/watch?v=short")).toThrow(YoutubeUrlError);
  });

  it("isYoutubeLink is true for a broken YouTube link too", () => {
    expect(isYoutubeLink("https://www.youtube.com/watch")).toBe(true);
    expect(isYoutubeLink("https://www.instagram.com/p/abcdefgh/")).toBe(false);
  });
});

describe("extractYoutubeUrls", () => {
  it("finds, cleans and de-duplicates links in a pasted blob", () => {
    const blob = [
      `Watch this: https://youtu.be/${ID}.`,
      `https://www.youtube.com/shorts/${ID}`,
      `see (youtube.com/watch?v=AAAAAAAAAAA),`,
      "https://www.instagram.com/reel/DEF123ghi/",
    ].join("\n");
    expect(extractYoutubeUrls(blob)).toEqual([
      `https://www.youtube.com/watch?v=${ID}`,
      "https://www.youtube.com/watch?v=AAAAAAAAAAA",
    ]);
  });
});
