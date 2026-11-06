import { describe, expect, it } from "vitest";
import {
  extractClipEmbeds,
  parseDocumentMarkdown,
  splitDocumentTitle,
  withDocumentTitle,
} from "./document-markdown";

const md = `# Website Review

Hello Morgan.

[AC - 3 - Summary](/clips/8e6b5147-6c9d-4159-935b-915dabe41a36)
`;

describe("parseDocumentMarkdown", () => {
  it("passes through markdown", () => {
    expect(parseDocumentMarkdown(md)).toBe(md.trim());
  });

  it("strips a wrapping fence", () => {
    expect(parseDocumentMarkdown("```markdown\n# Hello\n```")).toBe("# Hello");
  });

  it("unwraps a JSON markdown field", () => {
    expect(
      parseDocumentMarkdown(JSON.stringify({ markdown: "# Hello\n\nWorld" })),
    ).toBe("# Hello\n\nWorld");
  });

  it("unwraps pretty-printed JSON", () => {
    expect(
      parseDocumentMarkdown('{\n  "markdown": "# Title\\n\\nBody"\n}'),
    ).toBe("# Title\n\nBody");
  });

  it("salvages malformed JSON with trailing junk", () => {
    const raw = `{\n  "markdown": "# Website Review\\n\\nHi."\n   :   "marketdown"\n}`;
    expect(parseDocumentMarkdown(raw)).toBe("# Website Review\n\nHi.");
  });
});

describe("document title", () => {
  it("splits the leading heading from the rest", () => {
    expect(splitDocumentTitle("# Hello\n\nWorld")).toEqual({
      title: "Hello",
      rest: "World",
    });
  });

  it("puts the name back as the leading heading", () => {
    expect(withDocumentTitle("World", "Hello")).toBe("# Hello\n\nWorld");
  });
});

describe("markdownToHtml", () => {
  it("embeds clip links as figures", async () => {
    const { markdownToHtml } = await import("./document-html");
    const html = markdownToHtml(
      "[AC - 3 - Summary](/clips/8e6b5147-6c9d-4159-935b-915dabe41a36)",
    );
    expect(html).toContain('data-clip-id="8e6b5147-6c9d-4159-935b-915dabe41a36"');
    expect(html).toContain("AC - 3 - Summary");
  });

  it("keeps inline clip titles as text, not a second link", async () => {
    const { markdownToHtml } = await import("./document-html");
    const html = markdownToHtml(
      "See [AC - 4](/clips/8e6b5147-6c9d-4159-935b-915dabe41a36) for more.",
    );
    expect(html).toContain('data-clip-id="8e6b5147-6c9d-4159-935b-915dabe41a36"');
    expect(html).toContain("See AC - 4 for more.");
    expect(html).not.toContain('href="/clips/8e6b5147-6c9d-4159-935b-915dabe41a36"');
  });

  it("renders mixed _*emphasis*_ as bold italic", async () => {
    const { markdownToHtml } = await import("./document-html");
    const html = markdownToHtml("advantages in early mathematical reasoning_*without*_ any extra counting");
    expect(html).toContain("<strong><em>without</em></strong>");
    expect(html).not.toContain("_*without*_");
  });
});

describe("extractClipEmbeds", () => {
  it("pulls a note off a standalone clip line", () => {
    expect(
      extractClipEmbeds(
        "[AC - 3](/clips/8e6b5147-6c9d-4159-935b-915dabe41a36) — watch first",
      ),
    ).toEqual({
      clips: [{ id: "8e6b5147-6c9d-4159-935b-915dabe41a36", title: "AC - 3" }],
      rest: "watch first",
    });
  });
});
