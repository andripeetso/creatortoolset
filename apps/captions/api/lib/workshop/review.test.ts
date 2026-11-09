import { describe, expect, it } from "vitest";
import { audienceOf, buildReviewPrompt, pieceAsPosted } from "./review";
import { newDocument } from "./doc";
import { buildTurnPrompt } from "./chat-prompt";

const carousel = () => {
  const d = newDocument("d1", "s1", "carousel", "Carousel", { text: "This is why your sample needs a clear plan", now: 1 });
  d.blocks.push({ id: "b2", text: "BUT before your sample can start...", author: "user" } as never);
  return d;
};

describe("a follower's read", () => {
  it("sees the piece as posted, who the followers are and the best posts, nothing else", () => {
    const { system, user } = buildReviewPrompt({
      doc: carousel(),
      handle: "tinyacrobatics",
      audience: audienceOf({ notes: "You write as Alex.\n\nAudience: parents 25–40, puppies 0–24 months.\n\nHard rules: …" }),
      best: [{ date: "2025-12-08", views: 1_234_567, keptPer1k: 92, text: "Sample review of the app. Very happy, 10/10." }],
    });
    expect(system).toContain("You're one of the people this account posts for: parents 25–40, puppies 0–24 months.");
    expect(system).toContain("@tinyacrobatics");
    expect(system).toContain("one slide at a time");
    expect(system).toContain("opening on slide 2");
    expect(system).toContain("don't rewrite the piece");
    expect(system).not.toContain("Hard rules");
    expect(user).toContain("Slide 1\nThis is why your sample needs a clear plan\n\nSlide 2\nBUT before");
    expect(user).toContain("[2025-12-08 · 1,234,567 views · 92.0 per 1,000]\nSample review");
  });

  it("reads a reel as watched, openings first", () => {
    const d = newDocument("r1", "s1", "reel", "Reel", { text: "So our sample has its own plan.", now: 1 });
    d.hooks = [{ id: "h1", text: "Your sample needs a plan", author: "user" } as never];
    expect(pieceAsPosted(d)).toBe("Opening 1: Your sample needs a plan\n\nSo our sample has its own plan.");
    expect(buildReviewPrompt({ doc: d, audience: "", best: [] }).system).toContain("stop watching");
  });

  it("is labelled for the writer as another model's read, not its own words", () => {
    const { user } = buildTurnPrompt({
      frameworks: [],
      rules: [],
      doc: carousel(),
      pinned: [],
      sources: [],
      history: [
        { id: "m1", role: "user", text: "Read it as a follower would.", at: 1, docId: "d1" },
        { id: "m2", role: "assistant", text: "I'd stop at slide 3.", at: 2, docId: "d1", review: { model: "claude-fable-5-1" } },
      ],
      message: "fix that",
    });
    expect(user).toContain("A follower's read (another model, shown only the piece): I'd stop at slide 3.");
  });
});

describe("pack instructions in the follower's read", () => {
  it("are added to the system prompt after the app's own, and an empty text changes nothing", () => {
    const input = { doc: carousel(), handle: "tinyacrobatics", audience: "parents", best: [] };
    const plain = buildReviewPrompt(input);
    expect(buildReviewPrompt({ ...input, packText: "" })).toEqual(plain);
    const packed = buildReviewPrompt({ ...input, packText: "PACK-REVIEW-ZQ" });
    expect(packed.system.startsWith(plain.system)).toBe(true);
    expect(packed.system).toContain("PACK-REVIEW-ZQ");
    expect(packed.user).toBe(plain.user);
  });
});
