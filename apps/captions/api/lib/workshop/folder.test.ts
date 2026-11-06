import { describe, expect, it } from "vitest";
import { frameworkFiles, libraryFiles, outsideWords, ownPostFiles, pastedWords, quoteComments, sessionFile, sessionText, slug, sourceFile, OUTSIDE } from "./folder";
import { newDocument } from "./doc";
import type { CatalogItem } from "../instagram/types";

const item = (code: string, at: number, views: number, saved?: number, shares?: number, caption = `Caption of ${code}\nmore`): CatalogItem => ({
  shortcode: code,
  url: `https://www.instagram.com/reel/${code}/`,
  kind: "reel",
  takenAt: at,
  caption,
  counts: { likes: 10 },
  insights: { views, ...(saved !== undefined ? { saved } : {}), ...(shares !== undefined ? { shares } : {}) },
});

describe("ownPostFiles", () => {
  it("indexes every post newest first, puts the most saved and shared per 1,000 views on top, and writes each in full", () => {
    const files = ownPostFiles("tinyacrobatics", [
      { item: item("OLD", Date.UTC(2025, 0, 2), 100_000, 100, 100) }, // 2 per 1k
      { item: item("NEW", Date.UTC(2026, 9, 1), 10_000, 150, 50) }, // 20 per 1k
      { item: item("RAW", Date.UTC(2026, 5, 1), 5_000), markdown: "## Slides\nthe transcript" },
    ], { fetchedAt: Date.UTC(2026, 10, 4, 9, 30), lastCatalogAt: Date.UTC(2026, 10, 3, 22) });
    const index = files["my-posts/INDEX.md"]!;
    expect(index).toContain("Every post on @tinyacrobatics (3)");
    expect(index.startsWith("Numbers as of 2026-11-04 09:30 UTC; catalog synced 2026-11-03 22:00 UTC.\n# Every post")).toBe(true);
    expect(index).toContain("With the library's slide text or transcript: 1.");
    const all = index.slice(index.indexOf("## All"));
    expect(all.indexOf("2026-10-01-NEW")).toBeLessThan(all.indexOf("2026-06-01-RAW"));
    expect(all.indexOf("2026-06-01-RAW")).toBeLessThan(all.indexOf("2025-01-02-OLD"));
    const top = index.slice(index.indexOf("## Most saved"), index.indexOf("## All"));
    expect(top.indexOf("NEW")).toBeLessThan(top.indexOf("OLD"));
    expect(top).not.toContain("RAW"); // no saves known
    expect(top).toContain("| 20.0 |");
    const post = files["my-posts/2026-10-01-NEW.md"]!;
    expect(post).toContain("10,000 views");
    expect(post).toContain("150 saves (15.0 per 1,000 views)");
    expect(post).toContain("Caption of NEW\nmore");
    const machine = JSON.parse(files["my-posts/posts.json"]!);
    expect(machine[0]).toEqual({ file: "2026-10-01-NEW.md", date: "2026-10-01", views: 10_000, keptPer1k: 20, text: "Caption of NEW\nmore" });
    expect(machine[1].text).toBe("Caption of RAW\nmore"); // no slides: the caption
    expect(files["my-posts/2026-06-01-RAW.md"]).toContain("the transcript");
    expect(files["my-posts/2026-10-01-NEW.md"]).toContain("Numbers: 10,000 views");
  });

  it("opens a carousel on its first slide, and writes no file for a post with no words", () => {
    const files = ownPostFiles("tinyacrobatics", [
      { item: item("CARO", Date.UTC(2026, 6, 2), 4_000, 40, 0, "Carousel caption"), slides: ["Stop buying the big toy | first slide text", "second"] },
      { item: { ...item("SILENT", Date.UTC(2026, 7, 2), 900), caption: undefined } },
    ]);
    const index = files["my-posts/INDEX.md"]!;
    expect(index).toContain("| 2026-07-02 | reel | 4,000 | 10.0 | Stop buying the big toy / first slide text | Carousel caption | 2026-07-02-CARO.md |");
    expect(index).toContain("| 2026-08-02 | reel | 900 |  |  |  |  |");
    expect(files["my-posts/2026-08-02-SILENT.md"]).toBeUndefined();
    const machine = JSON.parse(files["my-posts/posts.json"]!);
    expect(machine.find((m: { date: string }) => m.date === "2026-08-02")).toEqual({ date: "2026-08-02", views: 900, keptPer1k: undefined, text: "" });
  });
});

describe("outside words", () => {
  it("marks other people's words as data and quotes comment lines, leaving the post itself alone", () => {
    const md = "# @x reel\n\nCaption here\n\n## Comments\n\n- **@fan** (3 likes): love this\n  - **@b** (0 likes): reply\n";
    const quoted = quoteComments(md);
    expect(quoted).toBe("# @x reel\n\nCaption here\n\n## Comments\n>\n> - **@fan** (3 likes): love this\n>   - **@b** (0 likes): reply\n>");
    expect(outsideWords(md).startsWith(`${OUTSIDE}\n\n# @x reel`)).toBe(true);
    expect(pastedWords("my own words")).toBe("Pasted by the author.\n\nmy own words");
  });
});

describe("libraryFiles", () => {
  it("lists every kept post, most played first, a file each", () => {
    const files = libraryFiles([
      { id: "aaaaaaaa-1", handle: "small.one", kind: "reel", takenAt: 0, plays: 10, markdown: "small" },
      { id: "bbbbbbbb-2", handle: "Big", kind: "carousel", takenAt: 0, plays: 9000, idea: "Floor time", savedFor: ["format"], markdown: "big" },
    ]);
    const index = files["library/INDEX.md"]!;
    expect(index.indexOf("@Big")).toBeLessThan(index.indexOf("@small.one"));
    expect(index).toContain("| Floor time | format |");
    expect(files["library/big-bbbbbbbb.md"]).toBe(outsideWords("big"));
    expect(files["library/small-one-aaaaaaaa.md"]).toBe(outsideWords("small"));
    expect(files["library/big-bbbbbbbb.md"]!.startsWith(OUTSIDE)).toBe(true);
  });
});

describe("sessionText", () => {
  it("carries the pieces as they stand, the author's edits and the whole conversation", () => {
    const doc = newDocument("d1", "s1", "carousel", "Carousel", { text: "Slide one", now: 1 });
    doc.userEdits = [{ blockId: "b1", from: "This is why", fromAuthor: "ai", to: "Slide one", at: 2 }];
    const long = "z".repeat(5000);
    const text = sessionText({ title: "Kids Strength Training", createdAt: Date.UTC(2026, 10, 3), updatedAt: Date.UTC(2026, 10, 4) }, "Tiny Acrobatics", [doc], [
      { id: "m1", role: "user", text: `the hook sucks ${long}`, at: Date.UTC(2026, 10, 3), docId: "d1" },
      { id: "m2", role: "assistant", text: "Agreed.", at: Date.UTC(2026, 10, 3), docId: "d1" },
      { id: "m3", role: "assistant", text: "broken", at: 3, docId: "d1", status: "error" },
    ], true);
    expect(text).toContain("# THIS SESSION: Kids Strength Training (project Tiny Acrobatics)");
    expect(text).toContain("Slide one");
    expect(text).toContain("«This is why» → «Slide one»");
    expect(text).toContain(`the hook sucks ${long}`);
    expect(text).toContain("**AI** (2026-11-03, on Carousel):\nAgreed.");
    expect(text).not.toContain("broken");
  });

  it("names files safely", () => {
    expect(sessionFile({ id: "7eba52a1-x", title: "Kids / Strength!", createdAt: Date.UTC(2026, 10, 3) })).toBe("sessions/2026-11-03-kids-strength-7eba52.md");
    expect(sourceFile("S2", "@ready.set")).toBe("sources/S2-ready-set.md");
    expect(slug("")).toBe("untitled");
  });
});


describe("frameworkFiles", () => {
  it("lists every framework with when it fits, and gives each its own file with the steps", () => {
    const files = frameworkFiles([
      { name: "Problem | Agitate", role: "persuasion", summary: "Name the pain first.", steps: ["Problem", "Agitate", "Solve"], whenToUse: "A product ad", pairsWith: "", example: "" },
    ]);
    expect(files["frameworks/INDEX.md"]).toContain("| Problem / Agitate | persuasion | Name the pain first. | A product ad |");
    const one = Object.entries(files).find(([k]) => k !== "frameworks/INDEX.md")!;
    expect(one[1]).toContain("1. Problem\n2. Agitate\n3. Solve");
    expect(frameworkFiles([])).toEqual({});
  });
});
