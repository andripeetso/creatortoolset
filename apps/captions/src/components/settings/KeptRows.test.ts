import { describe, expect, it } from "vitest";
import { capLabel, emptyQuestion, keptRows, shareLabel } from "./KeptRows";

describe("Settings → Storage, what is kept", () => {
  it("Empty's question says how many of what, what is kept and how much; it is never skippable", () => {
    const q = emptyQuestion({ kind: "chat-pictures", bytes: 21_000_000, items: 7 });
    expect(q.title).toBe("Delete 7 chat pictures?");
    expect(q.body).toBe("The chats are not deleted.");
    expect(q.ok).toBe("Delete 21 MB");
    expect(q.danger).toBe(true);
    expect(q.deleting).toBeUndefined(); // `deleting` lets a setting skip the question: not for this one
    const trash = emptyQuestion({ kind: "review-trash", bytes: 3_500_000_000, items: 1 });
    expect(trash.title).toBe("Delete 1 deleted Review video?");
    expect(trash.body).toBe("This cannot be undone.");
    // the sheets a Mac keeps for shot descriptions: counted by clip, and the lines stay
    const sheets = emptyQuestion({ kind: "look-sheets", bytes: 12_000_000, items: 30 });
    expect(sheets.title).toBe("Delete the shot description sheets of 30 clips?");
    expect(sheets.body).toBe("The shot descriptions are not deleted.");
  });

  it("lists the kinds that hold something, the biggest first, and says each one's share", () => {
    const rows = keptRows([
      { kind: "notes", bytes: 0, items: 0 },
      { kind: "review", bytes: 10, items: 1 },
      { kind: "captions", bytes: 90, items: 2 },
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["captions", "review"]);
    expect(shareLabel(420_000_000, 1_000_000_000)).toBe("42% of 1.0 GB");
    expect(shareLabel(1_000, 1_000_000_000)).toBe("under 1% of 1.0 GB");
  });
});

describe("Settings → Storage, the download cache cap", () => {
  it("the 25 GB cap reads as the copy does, decimal; a cap that is not whole GB keeps its size", () => {
    expect(capLabel(25e9)).toBe("25 GB");
    expect(capLabel(100)).toBe("1 KB");
    expect(capLabel(1.5e9)).toBe("1.5 GB");
  });
});
