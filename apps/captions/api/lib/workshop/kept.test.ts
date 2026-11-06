import { describe, expect, it } from "vitest";
import { finished, keptByWeek, keptShare } from "./kept";

const b = (text: string, author: "ai" | "user") => ({ id: "b", text, author, at: 0 });

describe("kept", () => {
  it("is the share of the piece's characters still the AI's", () => {
    expect(keptShare({ kind: "carousel", blocks: [b("aaaa", "ai"), b("bbbbbbbbbbbb", "user")], caption: b("cccc", "ai") })).toBe(0.4);
    expect(keptShare({ kind: "notes", blocks: [b("x", "ai")] })).toBeUndefined();
    expect(keptShare({ kind: "reel", blocks: [b("  ", "ai")] })).toBeUndefined();
  });
  it("counts sessions the author moved on with", () => {
    expect(finished({ status: "production" })).toBe(true);
    expect(finished({ status: "writing" })).toBe(false);
    expect(finished({ status: "writing", posted: { shortcode: "x", url: "", by: "auto", at: 0 } })).toBe(true);
  });
  it("groups by the week's Monday, median per week", () => {
    const mon = Date.UTC(2026, 10, 2); // a Monday
    const weeks = keptByWeek([
      { at: mon + 3 * 86_400_000, share: 0.2 },
      { at: mon, share: 0.6 },
      { at: mon + 86_400_000, share: 0.4 },
      { at: mon + 7 * 86_400_000, share: 1 },
    ]);
    expect(weeks).toEqual([
      { week: "2026-11-02", pieces: 3, median: 0.4 },
      { week: "2026-11-09", pieces: 1, median: 1 },
    ]);
  });
});
