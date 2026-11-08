import { describe, expect, it } from "vitest";
import { describePage } from "./page-context";

describe("describePage", () => {
  it("lists where you are, the open dialog and the headings, once each", () => {
    expect(
      describePage({ crumb: "Review Tiny launch reel", dialog: "Share link", headings: ["Review Tiny launch reel", "Comments", "comments", "Versions"] }),
    ).toBe("Page: Review Tiny launch reel\nOpen dialog: Share link\n- Comments\n- Versions");
  });

  it("is empty with nothing on screen and never longer than 2000 characters", () => {
    expect(describePage({ headings: [] })).toBe("");
    expect(describePage({ headings: Array.from({ length: 100 }, (_, i) => `Heading ${i} `.repeat(5)) }).length).toBe(2000);
  });
});
