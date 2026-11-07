import { describe, expect, it } from "vitest";
import { countReplies, mergeComments } from "./comments";
import type { Comment } from "./types";

const c = (id: string, replies: Comment[] = [], likeCount = 3): Comment => ({
  id, text: `comment ${id}`, createdAt: 1, user: { id: `u${id}`, username: `user${id}` }, likeCount, replyCount: replies.length, replies,
});

describe("mergeComments", () => {
  it("merges a fresh collection into a stored one without duplicates", () => {
    const stored = [c("1", [c("11")]), c("2")];
    const merged = mergeComments(stored, [c("1", [c("11"), c("13")], 9), c("7")]);
    expect(merged.map((x) => x.id)).toEqual(["1", "2", "7"]);
    expect(merged[0].likeCount).toBe(9);
    expect(merged[0].replies.map((r) => r.id)).toEqual(["11", "13"]);
    expect(countReplies(merged)).toBe(2);
  });
});
