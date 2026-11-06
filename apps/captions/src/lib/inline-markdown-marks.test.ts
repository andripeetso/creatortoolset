import { describe, expect, it } from "vitest";
import { markdownToHtml, toggleMark } from "./inline-markdown";

describe("⌘B / ⌘I", () => {
  const t = "show up later today";
  const at = t.indexOf("later");
  it("wraps the selection and keeps it selected", () => {
    expect(toggleMark(t, at, at + 5, "**")).toEqual({ text: "show up **later** today", start: at + 2, end: at + 7 });
    expect(toggleMark(t, at, at + 5, "*")).toEqual({ text: "show up *later* today", start: at + 1, end: at + 6 });
  });
  it("takes the marks off again, inside or around the selection", () => {
    const bold = "show up **later** today";
    expect(toggleMark(bold, at + 2, at + 7, "**").text).toBe(t);
    expect(toggleMark(bold, at, at + 9, "**").text).toBe(t);
    expect(toggleMark("show up *later* today", at + 1, at + 6, "*").text).toBe(t);
  });
  it("doesn't read bold as italic, and adds italic inside bold", () => {
    expect(toggleMark("show up **later** today", at + 2, at + 7, "*").text).toBe("show up ***later*** today");
  });
  it("keeps a selection's spaces outside the marks, and gives an empty pair with no selection", () => {
    expect(toggleMark(t, at - 1, at + 6, "**").text).toBe("show up **later** today");
    expect(toggleMark(t, at, at, "*")).toEqual({ text: "show up **later today", start: at + 1, end: at + 1 });
  });
});

describe("copying a slide with its emphasis", () => {
  it("turns the slide into paragraphs with <strong> and <em>", () => {
    expect(markdownToHtml("Tummy → **neck**\nSide → *side*\n\nAnd it shows up _*later*_ <3")).toBe(
      "<p>Tummy → <strong>neck</strong><br>Side → <em>side</em></p><p>And it shows up <strong><em>later</em></strong> &lt;3</p>",
    );
  });
});

describe("copying keeps every line break", () => {
  it("as a <br> per line break in the HTML, and as text with the marks dropped", async () => {
    const { markdownToClipboardHtml, markdownToPlain } = await import("./inline-markdown");
    const text = "This comes from a **study**.\n\nOn average:\n→ 20 months ahead\n\nSource: Jorgensen";
    expect(markdownToClipboardHtml(text)).toBe("<div>This comes from a <strong>study</strong>.<br><br>On average:<br>→ 20 months ahead<br><br>Source: Jorgensen</div>");
    expect(markdownToPlain(text)).toBe("This comes from a study.\n\nOn average:\n→ 20 months ahead\n\nSource: Jorgensen");
  });
});
