import { describe, expect, it } from "vitest";
import { parseInlineMarkdown, stripInlineMarkdown } from "./inline-markdown";

describe("parseInlineMarkdown", () => {
  it("keeps a mixed _*emphasis*_ mark as one strong-italic run", () => {
    const parts = parseInlineMarkdown(
      "linked to advantages in early mathematical reasoning_*without*_ any extra counting",
    );
    expect(parts).toEqual([
      { kind: "text", text: "linked to advantages in early mathematical reasoning" },
      { kind: "strongem", text: "without" },
      { kind: "text", text: " any extra counting" },
    ]);
    expect(stripInlineMarkdown("reasoning_*without*_ any")).toBe("reasoningwithout any");
  });

  it("handles bold, italic, and links", () => {
    expect(parseInlineMarkdown("a **bold** and *italic* _also_")).toEqual([
      { kind: "text", text: "a " },
      { kind: "strong", text: "bold" },
      { kind: "text", text: " and " },
      { kind: "em", text: "italic" },
      { kind: "text", text: " " },
      { kind: "em", text: "also" },
    ]);
    expect(parseInlineMarkdown("[AC](/clips/1)")).toEqual([{ kind: "link", text: "AC", href: "/clips/1" }]);
  });
});

describe("picture tokens in a piece", () => {
  const url = "/api/workshop/sessions/s1/images/p1";
  it("reads ![alt](session picture) as a picture, not a link, and drops it from plain copies", () => {
    expect(parseInlineMarkdown(`See ![Morgan's message](${url}) now`)).toEqual([
      { kind: "text", text: "See " },
      { kind: "image", text: "Morgan's message", href: url },
      { kind: "text", text: " now" },
    ]);
    expect(stripInlineMarkdown(`See ![Morgan's message](${url}) now`)).toBe("See  now");
  });
  it("keeps other image addresses as plain text", () => {
    expect(parseInlineMarkdown("![x](https://evil.example/a.png)").some((p) => p.kind === "image")).toBe(false);
  });
});
