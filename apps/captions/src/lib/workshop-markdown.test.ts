import { describe, expect, it } from "vitest";
import { cardsFrontmatter, camelStem, exportFilename, exportStem, joinParts, obsidianFilename, pieceMarkdown, rangesIn, reelObsidianMarkdown, splitPictures } from "./workshop-markdown";

describe("obsidian reel note", () => {
  it("keeps the session title as the filename, replacing only / and :", () => {
    expect(obsidianFilename("15 Minute Rule")).toBe("15 Minute Rule.md");
    expect(obsidianFilename("A/B: test")).toBe("A-B- test.md");
    expect(obsidianFilename("  ", "Untitled")).toBe("Untitled.md");
  });

  it("writes frontmatter, hook lines, then the script paragraphs and nothing else", () => {
    const md = reelObsidianMarkdown({
      day: "2026-11-05",
      status: "✍️ Writing",
      hooks: [{ text: "First hook?" }, { text: "Second\n  hook" }, { text: " " }],
      blocks: [{ text: "Para one.\n" }, { text: "Para two." }, { text: "Para three\n\nand more" }],
    });
    expect(md).toBe(
      "---\nchange: 2026-11-05\ndetails:\nselector.Status: ✍️ Writing\nselector.Media: 🎞️ Reel\n---\n// First hook?\n// Second hook\n\nPara one.\n\nPara two.\n\nPara three\n\nand more\n",
    );
  });

  it("omits the hook block when there are no hooks", () => {
    expect(reelObsidianMarkdown({ day: "2026-11-05", status: "💡 Idea", blocks: [{ text: "Only" }] })).toBe(
      "---\nchange: 2026-11-05\ndetails:\nselector.Status: 💡 Idea\nselector.Media: 🎞️ Reel\n---\nOnly\n",
    );
  });
});

describe("export filename", () => {
  it("keeps project camelCase and capitalizes the kind", () => {
    expect(exportFilename("TinyStory", "carousel")).toBe("TinyStoryCarousel.md");
    expect(exportFilename("TinyStory", "reel")).toBe("TinyStoryReel.md");
    expect(exportStem("TinyStory", "ad")).toBe("TinyStoryAd");
  });

  it("does not lowercase or hyphenate", () => {
    expect(camelStem("TinyStory")).toBe("TinyStory");
    expect(exportFilename("TinyStoryCarousel", "carousel")).toBe("TinyStoryCarousel.md");
  });

  it("does not double a suffix already on the stem", () => {
    expect(exportStem("TinyStoryCarousel", "carousel")).toBe("TinyStoryCarousel");
    expect(exportStem("TinyStory", "carousel", "TinyStoryCarousel")).toBe("TinyStoryCarousel");
  });

  it("falls back to a custom title, not stock or untitled names", () => {
    expect(exportFilename(undefined, "carousel", "Sample")).toBe("SampleCarousel.md");
    expect(exportFilename(undefined, "carousel", "Script")).toBe("Carousel.md");
    expect(exportFilename(undefined, "reel", "Untitled session")).toBe("Reel.md");
  });
});

describe("carousel markdown", () => {
  it("labels cards, separates them, and puts the count in frontmatter", () => {
    const md = pieceMarkdown({
      kind: "carousel",
      blocks: [{ text: "Hook line" }, { text: "Second card" }, { text: "  " }],
      caption: { text: "The caption." },
      pinned: { text: "Pinned." },
    });
    expect(md.startsWith(cardsFrontmatter(2))).toBe(true);
    expect(md).toContain("## Card 1\n\nHook line");
    expect(md).toContain("---\n\n## Card 2\n\nSecond card");
    expect(md).toContain("## Post description\n\nThe caption.");
    expect(md).toContain("## Pinned comment\n\nPinned.");
  });

  it("can omit frontmatter when nested in a session export", () => {
    const md = pieceMarkdown({ kind: "carousel", blocks: [{ text: "A" }, { text: "B" }] }, { frontmatter: false });
    expect(md.startsWith("---")).toBe(false);
    expect(md).toBe("## Card 1\n\nA\n\n---\n\n## Card 2\n\nB\n");
  });

  it("keeps the reel script as written", () => {
    expect(pieceMarkdown({ kind: "reel", blocks: [{ text: "Hook\n\nThen the story" }] })).toBe("Hook\n\nThen the story\n");
    expect(pieceMarkdown({ kind: "reel", blocks: [{ text: "Hook" }, { text: "Beat" }] })).toBe("Hook\n\nBeat\n");
  });

  it("puts reel hook variations above the script as comments", () => {
    const md = pieceMarkdown({
      kind: "reel",
      hooks: [{ text: "Closing her mouth" }, { text: "Wait for it" }, { text: "  " }],
      blocks: [{ text: "Then the story" }, { text: "Next beat" }],
    });
    expect(md.startsWith("---")).toBe(false);
    expect(md).toBe("=== === === === ===\n\n//HOOK1: Closing her mouth\n\n//HOOK2: Wait for it\n\nThen the story\n\nNext beat\n");
  });
});

describe("pictures in a field", () => {
  const tok = "![Morgan's msg](pic:f0871c22)";
  it("cuts the text at each picture token, text parts at even indexes, with offsets", () => {
    const text = `Hi ${tok} middle ${tok}!`;
    const parts = splitPictures(text);
    expect(parts.map((p) => (p.kind === "text" ? p.text : p.id))).toEqual(["Hi ", "f0871c22", " middle ", "f0871c22", "!"]);
    expect(parts.map((p) => p.start)).toEqual([0, 3, 3 + tok.length, 3 + tok.length + 8, 3 + 2 * tok.length + 8]);
    for (const p of parts) expect(text.slice(p.start, p.start + (p.kind === "text" ? p.text.length : p.token.length))).toBe(p.kind === "text" ? p.text : p.token);
  });
  it("gives a text-only value one text part", () => {
    expect(splitPictures("plain")).toEqual([{ kind: "text", text: "plain", start: 0 }]);
    expect(splitPictures("")).toEqual([{ kind: "text", text: "", start: 0 }]);
  });
  it("rebuilds the whole value from one edited part, keeping the tokens exactly", () => {
    const text = `Hi ${tok} middle`;
    const parts = splitPictures(text);
    expect(joinParts(parts, 0, "Hello ")).toBe(`Hello ${tok} middle`);
    expect(joinParts(parts, 2, " end")).toBe(`Hi ${tok} end`);
    expect(joinParts(parts, 2, "")).toBe(`Hi ${tok}`);
  });
  it("takes a picture out by replacing its token with nothing", () => {
    const parts = splitPictures(`A ${tok} B`);
    expect(joinParts(parts, 1, "")).toBe("A  B");
  });
  it("maps highlight ranges onto one part, clipped", () => {
    expect(rangesIn([[0, 5], [10, 20]], 3, 10)).toEqual([[0, 2], [7, 10]]);
    expect(rangesIn([[0, 2]], 5, 4)).toEqual([]);
  });
});
