import { describe, expect, it } from "vitest";
import { closestPairs, closestPosts } from "./closest";
import type { OwnPost } from "./folder";
import type { EditPair } from "./edit-log";

const post = (code: string, spoken: string, saved?: number): OwnPost =>
  ({ item: { shortcode: code, takenAt: 0, kind: "reel", counts: {}, insights: saved === undefined ? undefined : { views: 1000, saved, shares: 0 } }, slides: spoken ? [spoken] : undefined }) as unknown as OwnPost;
const pair = (from: string, at: number): EditPair => ({ key: from, kind: "slide", docKind: "carousel", docTitle: "t", from, to: `${from}!`, at });

describe("closest", () => {
  it("takes the posts nearest in words, most saved first", () => {
    const posts = [post("a", "tummy time on the floor", 5), post("b", "tummy time and crawling floor", 50), post("c", "sleep schedule night"), post("d", "", 99)];
    expect(closestPosts("floor tummy time", posts, 2).map((p) => p.item.shortcode)).toEqual(["b", "a"]);
    expect(closestPosts("nothing in common xyz", posts)).toEqual([]);
    const reposted = [post("a", "tummy time on the floor today", 5), post("a2", "tummy time on the floor today", 9), post("b", "crawling on the floor", 1)];
    expect(closestPosts("floor crawling tummy time", reposted).map((p) => p.item.shortcode)).toEqual(["a2", "b"]);
  });
  it("puts the nearest rewrites first and tops up with the newest", () => {
    const pairs = [pair("crawling early floor", 1), pair("sleep training night", 2), pair("bath time water", 3)];
    expect(closestPairs("when does crawling start", pairs, 2).map((p) => p.from)).toEqual(["crawling early floor", "bath time water"]);
  });
});
