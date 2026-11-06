import { describe, expect, it } from "vitest";
import { attachKind } from "./workshop";

const f = (name: string, type = "") => new File(["x"], name, { type });

describe("attachKind: what the message box does with a file", () => {
  it("sends pictures as pictures", () => {
    expect(attachKind(f("slide.jpg", "image/jpeg"))).toBe("picture");
    expect(attachKind(f("shot.heic", "image/heic"))).toBe("picture");
  });

  it("reads text-like files in the browser, by name or type", () => {
    for (const name of ["notes.md", "a.txt", "data.csv", "subs.srt", "page.html", "app.ts", "cfg.yaml", "x.json"]) {
      expect(attachKind(f(name))).toBe("text");
    }
    expect(attachKind(f("plain", "text/plain"))).toBe("text");
  });

  it("sends a PDF whole", () => {
    expect(attachKind(f("brief.pdf", "application/pdf"))).toBe("pdf");
    expect(attachKind(f("brief.PDF"))).toBe("pdf");
  });

  it("refuses everything else", () => {
    expect(attachKind(f("clip.mp4", "video/mp4"))).toBe("refused");
    expect(attachKind(f("bundle.zip", "application/zip"))).toBe("refused");
    expect(attachKind(f("deck.docx"))).toBe("refused");
  });
});
