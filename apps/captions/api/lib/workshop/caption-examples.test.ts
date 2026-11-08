import { describe, expect, it } from "vitest";
import { captionExamplesFor, CAPTION_EXAMPLES } from "./caption-examples";
import type { OwnPost } from "./folder";

const long = (tag: string) => `${tag} ${"word ".repeat(40)}`.trim();
const post = (kind: "reel" | "carousel", day: number, caption: string, saves = 0): OwnPost => ({
  item: {
    shortcode: `c${day}`,
    url: "",
    kind,
    takenAt: Date.UTC(2026, 0, day),
    caption,
    counts: {},
    insights: { views: 10_000, saved: saves, shares: 0 },
  } as OwnPost["item"],
});

describe("captionExamplesFor", () => {
  it("shows the newest reel captions, not carousels, one-liners or the most-saved list", () => {
    const posts = [
      post("reel", 1, long("old reel")),
      post("carousel", 9, long("newer carousel")),
      post("reel", 8, "one short line about tiny tumbles", 900),
      ...Array.from({ length: 10 }, (_, i) => post("reel", 2 + i, long(`reel ${i + 2}`), 5)),
    ];
    const got = captionExamplesFor(posts)!;
    expect(got.examples.length).toBe(CAPTION_EXAMPLES);
    expect(got.examples[0]!.text.startsWith("reel 11")).toBe(true);
    expect(got.examples.every((e) => e.text.startsWith("reel"))).toBe(true);
    expect(got.examples.map((e) => e.text)).not.toContain("one short line about tiny tumbles");
  });

  it("adds the captions saved on the session's other pieces, and only non-empty ones", () => {
    const posts = Array.from({ length: 10 }, (_, i) => post("reel", i + 1, long(`reel ${i}`)));
    const got = captionExamplesFor(posts, ["  Saved one. ", "", "Saved two."])!;
    expect(got.saved).toEqual(["Saved one.", "Saved two."]);
    expect(captionExamplesFor(posts, [])!.saved).toBeUndefined();
  });

  it("is undefined with fewer than ten captions to read the length from", () => {
    expect(captionExamplesFor([post("reel", 1, long("only"))])).toBeUndefined();
  });
});
