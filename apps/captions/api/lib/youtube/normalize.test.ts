import { describe, expect, it } from "vitest";
import { durationSeconds, normalizeYoutubeItem, pickSrt, srtToWords } from "./normalize";
import type { YoutubeRef } from "./url";

const long: YoutubeRef = {
  videoId: "dQw4w9WgXcQ",
  short: false,
  canonical: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
};

// Shaped like streamers/youtube-scraper's single-video item (docs fields).
const fixture = {
  id: "dQw4w9WgXcQ",
  title: "Sample week one",
  url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
  viewCount: 12034,
  likes: 880,
  commentsCount: 41,
  date: "2026-10-02",
  duration: "00:03:17",
  text: "Our first week of practice.",
  channelName: "Tiny Acrobatics",
  channelUrl: "https://www.youtube.com/@tinyacrobatics",
  subtitles: [
    {
      language: "en",
      type: "auto_generated",
      srt: "1\n00:00:00,000 --> 00:00:02,000\nhello there\n\n2\n00:00:02,000 --> 00:00:04,000\nhello there tummy time\n",
    },
  ],
};

describe("durationSeconds", () => {
  it("reads HH:MM:SS and MM:SS", () => {
    expect(durationSeconds("00:03:17")).toBe(197);
    expect(durationSeconds("0:45")).toBe(45);
    expect(durationSeconds("soon")).toBeUndefined();
  });
});

describe("srtToWords", () => {
  it("spreads each cue's words over its span and drops the rolling repeat", () => {
    const words = srtToWords(fixture.subtitles[0].srt);
    expect(words.map((w) => w.text)).toEqual(["hello", "there", "tummy", "time"]);
    expect(words[0]).toEqual({ text: "hello", start: 0, end: 1 });
    expect(words[3]).toEqual({ text: "time", start: 3, end: 4 });
  });

  it("reads CRLF files and strips inline tags", () => {
    const srt = "1\r\n00:00:01.500 --> 00:00:02.500\r\n<c>Tiny</c> step\r\n";
    expect(srtToWords(srt)).toEqual([
      { text: "Tiny", start: 1.5, end: 2 },
      { text: "step", start: 2, end: 2.5 },
    ]);
  });
});

describe("normalizeYoutubeItem", () => {
  it("maps a long video onto a library post with its captions", () => {
    const info = normalizeYoutubeItem(fixture, long);
    expect(info.shortcode).toBe("yt-dQw4w9WgXcQ");
    expect(info.kind).toBe("post");
    expect(info.url).toBe(long.canonical);
    expect(info.creator).toEqual({ username: "tinyacrobatics", fullName: "Tiny Acrobatics", id: "@tinyacrobatics" });
    expect(info.caption).toBe("Sample week one\n\nOur first week of practice.");
    expect(info.counts).toEqual({ likes: 880, comments: 41, plays: 12034 });
    expect(info.takenAt).toBe(Date.parse("2026-10-02"));
    expect(info.slides).toHaveLength(1);
    expect(info.slides[0]).toMatchObject({ index: 0, kind: "image", url: fixture.thumbnailUrl, durationS: 197 });
    expect(info.words?.map((w) => w.text)).toEqual(["hello", "there", "tummy", "time"]);
  });

  it("marks a Short as a reel and copes with a relative date and no captions", () => {
    const info = normalizeYoutubeItem(
      { ...fixture, date: "10 months ago", subtitles: [] },
      { videoId: long.videoId, short: true, canonical: "https://www.youtube.com/shorts/dQw4w9WgXcQ" },
    );
    expect(info.kind).toBe("reel");
    expect(info.takenAt).toBe(0);
    expect(info.words).toBeUndefined();
  });

  it("prefers the English track", () => {
    const srt = pickSrt({
      subtitles: [
        { language: "de", srt: "de" },
        { language: "en", srt: "en" },
      ],
    });
    expect(srt).toBe("en");
  });
});
