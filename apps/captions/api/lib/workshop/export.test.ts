import { describe, expect, it } from "vitest";
import { buildExportMarkdown, demoteHeadings, obsidianReelExport, obsidianExports, obsidianStatus } from "./export";
import type { DraftMeta, Document } from "./types";

const draft = (over: Partial<DraftMeta>): DraftMeta => ({
  id: "d1",
  kind: "reel",
  title: "Pool safety",
  frameworkIds: [],
  prompt: "",
  includeNotes: true,
  sourceIds: [],
  status: "ready",
  chars: 10,
  createdAt: Date.UTC(2026, 8, 14),
  ...over,
});

describe("export markdown", () => {
  it("demotes headings", () => {
    expect(demoteHeadings("# A\n## B\ntext # not")).toBe("## A\n### B\ntext # not");
  });

  it("assembles notes, sources and ready drafts", () => {
    const md = buildExportMarkdown(
      { title: "Pools", createdAt: 0 },
      "my notes",
      [{ handle: "coach", kind: "reel", url: "https://x/1", note: "hook" }],
      [
        { draft: draft({}), markdown: "# Pool safety\n## Hook\nhi" },
        { draft: draft({ id: "d2", status: "error" }), markdown: "" },
      ],
    );
    expect(md).toContain("# Pools\n\n## Notes\n\nmy notes\n\n## Sources\n\n- @coach — reel — https://x/1 — hook");
    expect(md).toContain("### Pool safety — Reel script — 2026-09-14");
    expect(md).toContain("### Pool safety\n#### Hook\nhi");
    expect(md.split("### Pool safety").length).toBe(3);
  });
});

describe("obsidian reel export", () => {
  const reel = {
    id: "r1",
    kind: "reel",
    title: "Reel script",
    blocks: [{ id: "b1", text: "Para 1", author: "ai", at: 0 }, { id: "b2", text: "Para 2\n\nPara 3", author: "ai", at: 0 }],
    hooks: [
      { id: "h1", text: "Closing her mouth?", author: "ai", at: 0 },
      { id: "h2", text: "Wait for it", author: "ai", at: 0 },
    ],
  } as unknown as Document;

  it("maps the Workshop status to the author's Selector.Status values", () => {
    expect(obsidianStatus("writing")).toBe("✍️ Writing");
    expect(obsidianStatus("published")).toBe("✅ Published");
    expect(obsidianStatus("shelved")).toBe("📁 Shelved");
    expect(obsidianStatus(undefined)).toBe("💡 Idea");
  });

  it("writes the note with the exact shape and the session title as filename", () => {
    const out = obsidianReelExport({ title: "15MinuteRule", status: "writing" }, [reel], "2026-11-05");
    expect(out).toEqual({
      filename: "15MinuteRule.md",
      markdown: "---\nchange: 2026-11-05\ndetails:\nselector.Status: ✍️ Writing\nselector.Media: 🎞️ Reel\n---\n// Closing her mouth?\n// Wait for it\n\nPara 1\n\nPara 2\n\nPara 3\n",
      pictures: [],
    });
  });

  it("returns null without a reel script", () => {
    expect(obsidianReelExport({ title: "X", status: "draft" }, [{ ...reel, kind: "carousel" } as Document], "2026-11-05")).toBeNull();
  });
});

describe("obsidian reel export with pictures", () => {
  const pic = (id: string) => `![Morgan's message](pic:${id})`;
  const reel = {
    id: "r1",
    kind: "reel",
    title: "Reel script",
    blocks: [{ id: "b1", text: `Before\n\n${pic("pic001")}\n\nAfter ${pic("pic002")}`, author: "user", at: 0 }, { id: "b2", text: pic("pic001"), author: "user", at: 0 }],
    hooks: [{ id: "h1", text: `Look ${pic("pic002")}`, author: "ai", at: 0 }],
  } as unknown as Document;

  it("turns each picture token into an Obsidian embed, numbered in order, and lists the files for the zip", () => {
    const out = obsidianReelExport({ title: "Kids strength", status: "ready" }, [reel], "2026-11-05", new Map([["pic001", "image/jpeg"], ["pic002", "image/png"]]));
    expect(out).not.toBeNull();
    // hooks come before the script, so p2 is picture 1
    expect(out!.filename).toBe("Kids strength.md");
    expect(out!.pictures).toEqual([
      { id: "pic002", file: "Kids strength 1.png", type: "image/png" },
      { id: "pic001", file: "Kids strength 2.jpg", type: "image/jpeg" },
    ]);
    expect(out!.markdown).toBe(
      "---\nchange: 2026-11-05\ndetails:\nselector.Status: 👍 Ready\nselector.Media: 🎞️ Reel\n---\n// Look ![[Kids strength 1.png]]\n\nBefore\n\n![[Kids strength 2.jpg]]\n\nAfter ![[Kids strength 1.png]]\n\n![[Kids strength 2.jpg]]\n",
    );
  });

  it("drops a token whose picture is gone and leaves no file for it", () => {
    const out = obsidianReelExport({ title: "Kids strength", status: "ready" }, [reel], "2026-11-05", new Map([["pic002", "image/png"]]));
    expect(out!.pictures.map((p) => p.file)).toEqual(["Kids strength 1.png"]);
    expect(out!.markdown).not.toContain("pic:");
    expect(out!.markdown).toContain("// Look ![[Kids strength 1.png]]");
  });

  it("is the same plain note when the reel has no pictures", () => {
    const plain = { ...reel, blocks: [{ id: "b1", text: "Just words", author: "user", at: 0 }], hooks: [] } as unknown as Document;
    const out = obsidianReelExport({ title: "Kids strength", status: "ready" }, [plain], "2026-11-05");
    expect(out!.pictures).toEqual([]);
    expect(out!.markdown).toBe("---\nchange: 2026-11-05\ndetails:\nselector.Status: 👍 Ready\nselector.Media: 🎞️ Reel\n---\nJust words\n");
  });
});

describe("a session with a reel and a carousel", () => {
  it("exports two notes named like the author's vault: -Reel and -Carousel, the carousel's slides apart and marked CAROUSEL", () => {
    const reel = { id: "r1", kind: "reel", title: "Reel", blocks: [{ id: "b1", text: "The script.", author: "user", at: 0 }], hooks: [{ id: "h1", text: "A hook", author: "user", at: 0 }] };
    const carousel = { id: "c1", kind: "carousel", title: "Carousel", blocks: [{ id: "b1", text: "Slide one", author: "user", at: 0 }, { id: "b2", text: "Slide two\nsecond line", author: "user", at: 0 }] };
    const notes = obsidianExports({ title: "TinyStory", status: "production" }, [reel, carousel] as never, "2026-11-05");
    expect(notes.map((n) => n.filename)).toEqual(["TinyStory-Reel.md", "TinyStory-Carousel.md"]);
    expect(notes[0]!.markdown).toBe("---\nchange: 2026-11-05\ndetails:\nselector.Status: 🎥 Filming\nselector.Media: 🎞️ Reel\n---\n// A hook\n\nThe script.\n");
    expect(notes[1]!.markdown).toBe("---\nchange: 2026-11-05\ndetails: CAROUSEL\nselector.Status: 🎥 Filming\nselector.Media: 🎪 Carousel\n---\nSlide one\n\n---\n\nSlide two\nsecond line\n");
    // one piece alone keeps the plain name
    expect(obsidianExports({ title: "TinyStory", status: "writing" }, [carousel] as never, "2026-11-05")[0]!.filename).toBe("TinyStory.md");
  });
});
