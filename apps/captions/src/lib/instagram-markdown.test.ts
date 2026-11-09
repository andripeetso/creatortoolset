import { describe, expect, it } from "vitest";
import {
  isoDate,
  postToMarkdown,
  timedTranscriptText,
  transcriptParagraphs,
  type MarkdownPost,
  type TranscriptWord,
} from "./instagram-markdown";

const w = (text: string, start: number, end = start + 0.4): TranscriptWord => ({ text, start, end });

const post: MarkdownPost = {
  url: "https://www.instagram.com/reel/ABC123/",
  kind: "reel",
  creator: { username: "swimcoach" },
  takenAt: Date.UTC(2026, 2, 4, 15),
  caption: "Pool day.\nSecond line",
  counts: { plays: 12345, likes: 900 },
  idea: {
    title: "Swimming for adults",
    takeaway: "Adults who swam before five were 11 months ahead in reading.",
  },
  slides: [
    {
      index: 0,
      kind: "video",
      durationS: 61,
      vision: { hook: "Adults who swim early", onScreenText: "WATER SAFETY", description: "A pool" },
    },
    { index: 1, kind: "image", caption: "slide two", vision: {} },
  ],
};

describe("postToMarkdown", () => {
  it("emits the sections in order with an ISO date", () => {
    const md = postToMarkdown(post, { 0: [w("Hello", 0), w("world.", 0.5)] }, [
      {
        text: "Love  this",
        likeCount: 3,
        user: { username: "mum" },
        replies: [{ text: "same", likeCount: 0, user: { username: "dad" } }],
      },
    ]);
    const order = [
      "# @swimcoach — Instagram reel",
      "Source: https://www.instagram.com/reel/ABC123/",
      "Published: 2026-03-04",
      "Numbers: 12K plays · 900 likes",
      "Idea: Swimming for adults",
      "Takeaway: Adults who swam before five were 11 months ahead in reading.",
      "## Caption",
      "Pool day.\nSecond line",
      "## Slides",
      "### Slide 1 (video, 01:01)",
      "Hook: Adults who swim early",
      "On-screen text:",
      "WATER SAFETY",
      "Description: A pool",
      "Transcript:",
      "[00:00] Hello world.",
      "### Slide 2 (image)",
      "Slide caption: slide two",
      "## Comments",
      "- **@mum** (3 likes): Love this",
      "  - **@dad** (0 likes): same",
    ];
    let at = -1;
    for (const needle of order) {
      const next = md.indexOf(needle, at + 1);
      expect(next, `missing or out of order: ${needle}`).toBeGreaterThan(at);
      at = next;
    }
    expect(md.endsWith("\n")).toBe(true);
  });

  it("leaves out empty parts", () => {
    const md = postToMarkdown({ ...post, caption: "  ", counts: {}, takenAt: 0, slides: [] }, {});
    expect(md).toContain("_No caption._");
    expect(md).not.toContain("Published:");
    expect(md).not.toContain("Numbers:");
    expect(md).not.toContain("## Comments");
  });
});

describe("transcript helpers", () => {
  it("splits on long pauses and stamps paragraphs", () => {
    const words = [w("One", 0), w("two", 0.5), w("three", 1), w("four", 1.5), w("five", 2), w("six", 2.5), w("seven", 6)];
    expect(transcriptParagraphs(words).map((p) => p.length)).toEqual([6, 1]);
    expect(timedTranscriptText(words)).toBe("[00:00] One two three four five six\n\n[00:06] seven");
  });

  it("formats ISO dates", () => {
    expect(isoDate(Date.UTC(2026, 8, 14, 23, 59))).toBe("2026-09-14");
  });
});
