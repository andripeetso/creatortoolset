import { describe, expect, it } from "vitest";
import { attachedFile, ATTACH_EXT, messageAttachments } from "./attached";

const MID = "5f0c2a91-7d3e-4b1a-9c2d-0e8f6a4b3c21";

describe("attached files in the Mac folder", () => {
  it("numbers pictures first, then files, in the order they go, under the message's own folder", () => {
    expect(attachedFile({ name: "Slide 3.jpg", type: "image/jpeg" }, 0, MID)).toBe("attached/5f0c2a91/01-slide-3.jpg");
    expect(attachedFile({ name: "Brief v2.pdf", type: "application/pdf" }, 2, MID)).toBe("attached/5f0c2a91/03-brief-v2.pdf");
  });

  it("keeps a PDF as .pdf and strips only the last extension from the name", () => {
    expect(attachedFile({ name: "notes.final.pdf", type: "application/pdf" }, 0, MID)).toBe("attached/5f0c2a91/01-notes-final.pdf");
    expect(ATTACH_EXT["application/pdf"]).toBe("pdf");
  });

  it("gives a message's pictures and files the same paths on every turn, files after the pictures", () => {
    const m = {
      id: MID,
      images: [
        { id: "a", name: "1.jpg", type: "image/jpeg" as const },
        { id: "b", name: "2.png", type: "image/png" as const },
      ],
      files: [{ id: "c", name: "Study.pdf", type: "application/pdf" as const, bytes: 10 }],
    };
    expect(messageAttachments(m).map((a) => [a.kind, a.file])).toEqual([
      ["image", "attached/5f0c2a91/01-1.jpg"],
      ["image", "attached/5f0c2a91/02-2.png"],
      ["file", "attached/5f0c2a91/03-study.pdf"],
    ]);
    expect(messageAttachments({ id: MID })).toEqual([]);
  });
});
