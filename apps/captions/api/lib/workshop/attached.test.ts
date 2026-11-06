import { describe, expect, it } from "vitest";
import { attachedFile, ATTACH_EXT } from "./attached";

describe("attached files in the Mac folder", () => {
  it("numbers pictures first, then files, in the order they go", () => {
    expect(attachedFile({ name: "Slide 3.jpg", type: "image/jpeg" }, 0)).toBe("attached/01-slide-3.jpg");
    expect(attachedFile({ name: "Brief v2.pdf", type: "application/pdf" }, 2)).toBe("attached/03-brief-v2.pdf");
  });

  it("keeps a PDF as .pdf and strips only the last extension from the name", () => {
    expect(attachedFile({ name: "notes.final.pdf", type: "application/pdf" }, 0)).toBe("attached/01-notes-final.pdf");
    expect(ATTACH_EXT["application/pdf"]).toBe("pdf");
  });
});
