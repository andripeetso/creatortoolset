import { describe, expect, it } from "vitest";
import { annotateLowValue, isLowValue, normalizeComment } from "./comment-filter";
import type { Comment } from "./types";

describe("isLowValue", () => {
  it.each([
    "",
    "🔥🔥🔥",
    "❤️",
    "fire",
    "Beautiful!!!",
    "fire fire fire",
    "so so so",
    "@someone",
    "@a @b @c",
    "https://linktr.ee/x",
    "#reels #fyp",
    "first",
    "Follow me for more",
    "check out my page 🙏",
    "DM me for the free followers",
  ])("flags %j", (text) => {
    expect(isLowValue(text)).toBe(true);
  });

  it.each([
    "This is genuinely helpful, thank you",
    "Did you film this with a phone or a camera?",
    "The second slide changed how I think about hooks.",
    "Not sure I agree — the middle part drags",
  ])("keeps %j", (text) => {
    expect(isLowValue(text)).toBe(false);
  });

  it("flags repeats of something already seen on the post", () => {
    const seen = new Set<string>();
    expect(isLowValue("Love this so much", seen)).toBe(false);
    expect(isLowValue("love this SO much!!", seen)).toBe(true);
  });
});

describe("normalizeComment", () => {
  it("strips emoji, mentions, links, hashtags and punctuation", () => {
    expect(normalizeComment("@bob Love this 🔥 https://x.y #reel !!!")).toBe("love this");
  });
});

describe("annotateLowValue", () => {
  const c = (id: string, text: string, replies: Comment[] = []): Comment => ({
    id,
    text,
    createdAt: 0,
    user: { username: "u", id: "1" },
    likeCount: 0,
    replyCount: replies.length,
    replies,
  });

  it("marks comments and replies and counts what it hid", () => {
    const list = [
      c("1", "Really thoughtful take on pacing", [c("11", "🔥"), c("12", "Agreed, the pacing is the key")]),
      c("2", "wow"),
    ];
    expect(annotateLowValue(list)).toEqual({ filteredOut: 2 });
    expect(list[0].lowValue).toBe(false);
    expect(list[0].replies[0].lowValue).toBe(true);
    expect(list[0].replies[1].lowValue).toBe(false);
    expect(list[1].lowValue).toBe(true);
  });
});
