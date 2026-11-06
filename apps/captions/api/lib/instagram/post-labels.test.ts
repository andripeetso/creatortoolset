import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../jev", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../jev")>()),
  ask: vi.fn(),
}));

import { ask } from "../jev";
import { labelPosts, LABELS_VERSION, MIN_POSTS, performanceBy } from "./post-labels";

beforeEach(() => vi.clearAllMocks());

describe("labelling posts", () => {
  it("asks hook, format and call to action per post and keeps only listed labels", async () => {
    vi.mocked(ask).mockResolvedValueOnce({
      hook0: { choice: "story", confidence: 0.9 },
      format0: { choice: "story or vlog", confidence: 0.8 },
      cta0: { choice: "none", confidence: 0.95 },
      hook1: { choice: "something invented", confidence: 0.4 },
      format1: { choice: "talking head", confidence: 0.7 },
      cta1: { choice: "comment keyword", confidence: 0.9 },
    });
    const labels = await labelPosts([
      { id: "A", text: "Sample post line about the rollout…" },
      { id: "B", text: "Comment POTTY and I'll send the guide" },
    ], "@someone, whose bio says: potty training help");
    expect(vi.mocked(ask).mock.calls[0]![0]).toEqual({ creator: "@someone, whose bio says: potty training help" });
    expect(labels.get("A")).toEqual({
      hook: "story",
      format: "story or vlog",
      cta: "none",
      confidence: { hook: 0.9, format: 0.8, cta: 0.95 },
      v: LABELS_VERSION,
    });
    // a label not on the list falls back instead of leaking into the counts
    expect(labels.get("B")?.hook).toBe("bold claim");
    expect(labels.get("B")?.cta).toBe("comment keyword");
  });

  it("sends at most 10 posts per request", async () => {
    vi.mocked(ask).mockResolvedValue({});
    await labelPosts(Array.from({ length: 25 }, (_, i) => ({ id: String(i), text: "x" })), "@someone");
    expect(ask).toHaveBeenCalledTimes(3);
  });
});

describe("how each label performs", () => {
  const post = (id: string, group: string, views: number) => ({ id, group, views });

  it("compares a post only with posts of its own group", () => {
    // trial reels get far fewer views; a story trial reel doing 2× its group still counts as 2×
    const posts = [
      ...Array.from({ length: 5 }, (_, i) => post(`p${i}`, "reel/public", 10_000)),
      ...Array.from({ length: 5 }, (_, i) => post(`t${i}`, "reel/trial", 1_000)),
      post("s1", "reel/trial", 2_000),
      post("s2", "reel/trial", 2_000),
      post("s3", "reel/trial", 2_000),
      post("s4", "reel/public", 20_000),
      post("s5", "reel/public", 20_000),
    ];
    const rows = performanceBy(posts, (id) => (id.startsWith("s") ? "story" : "bold claim"));
    const story = rows.find((r) => r.label === "story")!;
    expect(story.posts).toBe(5);
    expect(story.lift).toBeGreaterThanOrEqual(1.8);
    expect(story.verdict).toBe("better");
    expect(rows.find((r) => r.label === "bold claim")?.verdict).toBe("similar");
  });

  it(`says "too few" under ${MIN_POSTS} posts`, () => {
    const posts = [post("a", "g", 100), post("b", "g", 100), post("c", "g", 900)];
    const rows = performanceBy(posts, (id) => (id === "c" ? "rare" : "common"));
    expect(rows.find((r) => r.label === "rare")?.verdict).toBe("too few");
  });

  it("skips unlabelled posts and groups with no views", () => {
    const rows = performanceBy([post("a", "g", 0), post("b", "g", 0)], () => "x");
    expect(rows).toEqual([]);
    expect(performanceBy([post("a", "g", 10)], () => undefined)).toEqual([]);
  });
});
