import { describe, expect, it } from "vitest";
import { emptyQuestion, keptRows, shareLabel } from "./KeptRows";

describe("Settings → Storage, what is kept", () => {
  it("Empty's question says how many of what, how much, what stays, and that it is for good; it is never skippable", () => {
    const q = emptyQuestion({ kind: "chat-pictures", bytes: 21_000_000, items: 7 });
    expect(q.title).toBe("Delete 7 chat pictures?");
    expect(q.body).toBe("21 MB. The chats stay; the pictures show as removed. This cannot be undone.");
    expect(q.ok).toBe("Delete 21 MB");
    expect(q.danger).toBe(true);
    expect(q.deleting).toBeUndefined(); // `deleting` lets a setting skip the question: not for this one
    expect(emptyQuestion({ kind: "review-trash", bytes: 3_500_000_000, items: 1 }).title).toBe("Delete 1 deleted Review video?");
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
