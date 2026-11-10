import { describe, expect, it, vi } from "vitest";
import { detectReposts, pairMode, pairScore } from "./duplicates";

const long = "Crawling does one real thing for the brain every morning if you let them stay on the floor";

describe("pairScore", () => {
  it("marks identical captions as a repost", () => {
    expect(pairScore(long, long).kind).toBe("repost");
  });

  it("ignores a short identical CTA", () => {
    expect(pairScore("Save this one", "Save this one").kind).toBeUndefined();
  });

  it("marks a paraphrased hook as a variation and ignores unrelated text", () => {
    const a = "Wait for the talking head hook in the first three seconds";
    const b = "Talking head hook during the first three seconds wait for it";
    const c = "Sunset beach vacation vlog with a drone over the water";
    expect(pairScore(a, b).kind).toBe("variation");
    expect(pairScore(a, c).kind).toBeUndefined();
  });

  it("does not fuzzy-match reels in exact mode", () => {
    const a = "Wait for the talking head hook in the first three seconds please";
    const b = "Talking head hook during the first three seconds wait for it please";
    expect(pairScore(a, b, "exact").kind).toBeUndefined();
    expect(pairScore(long, long, "exact").kind).toBe("repost");
  });
});

describe("pairMode", () => {
  it("skips a reel that also exists as a feed post", () => {
    expect(pairMode("reel", "carousel")).toBe("skip");
    expect(pairMode("reel", "reel")).toBe("exact");
    expect(pairMode("carousel", "carousel")).toBe("fuzzy");
  });
});

describe("detectReposts", () => {
  it("clusters this account first then attaches a library hit", () => {
    const cap = "Preschool is not created equal and high achieving is not always safer";
    const clusters = detectReposts(
      [
        { shortcode: "aaa", captionPreview: cap, kind: "carousel" },
        { shortcode: "bbb", captionPreview: cap, kind: "carousel" },
        { shortcode: "ccc", captionPreview: "Unrelated cooking recipe with garlic and lemon" },
      ],
      [
        {
          id: "lib1",
          shortcode: "zzz",
          caption: cap,
          username: "other",
          kind: "carousel",
        },
      ],
    );
    const dup = clusters.find((c) => c.members.some((m) => m.shortcode === "aaa"));
    expect(dup?.kind).toBe("repost");
    expect(dup?.members.map((m) => m.shortcode).sort()).toEqual(["aaa", "bbb"]);
    expect(dup?.libraryHits.some((h) => h.postId === "lib1")).toBe(true);
  });

  it("only treats reel pairs as reposts when the full caption is identical", () => {
    const clusters = detectReposts(
      [
        { shortcode: "r1", kind: "reel", caption: `${long} version one extra sentence about crawling` },
        { shortcode: "r2", kind: "reel", caption: `${long} version two extra sentence about rolling` },
        { shortcode: "r3", kind: "reel", caption: long },
        { shortcode: "r4", kind: "reel", caption: long },
        { shortcode: "c1", kind: "carousel", caption: long },
      ],
      [],
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.members.map((m) => m.shortcode).sort()).toEqual(["r3", "r4"]);
    expect(clusters[0]?.kind).toBe("repost");
  });

  it("uses the full caption, not the 180-character preview", () => {
    const hook = "Your sample will run and jump on its own but everything else takes a team";
    const clusters = detectReposts(
      [
        { shortcode: "a", kind: "reel", captionPreview: hook, caption: `${hook} one` },
        { shortcode: "b", kind: "reel", captionPreview: hook, caption: `${hook} two` },
      ],
      [],
    );
    expect(clusters).toHaveLength(0);
  });

  it("prepares each caption once, however many posts are compared", () => {
    // an account page waited seconds here: every pair of a few hundred posts normalised both captions again
    const rows = Array.from({ length: 60 }, (_, i) => ({
      shortcode: `r${i}`,
      kind: "reel" as const,
      caption: `Sample post number ${i} about rolling, crawling and climbing with a small sample`,
    }));
    const lowered = vi.spyOn(String.prototype, "toLowerCase");
    detectReposts(rows, []);
    const calls = lowered.mock.calls.length;
    lowered.mockRestore();
    expect(calls).toBeLessThanOrEqual(rows.length * 4);
  });
});
