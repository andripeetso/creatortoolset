import { describe, expect, it } from "vitest";
import { buildReviewPrompt, parsePersonaDraft, parsePersonas, pieceAsPosted, renderAudienceComments, renderAudienceNumbers } from "./review";
import { newDocument } from "./doc";
import { buildTurnPrompt } from "./chat-prompt";

const carousel = () => {
  const d = newDocument("d1", "s1", "carousel", "Carousel", { text: "This is why your sample needs a clear plan", now: 1 });
  d.blocks.push({ id: "b2", text: "BUT before your sample can start...", author: "user" } as never);
  return d;
};

describe("a follower's read", () => {
  it("sees the piece as posted, the persona and the best posts, nothing else", () => {
    const { system, user } = buildReviewPrompt({
      doc: carousel(),
      handle: "tinyacrobatics",
      persona: { name: "New parent", about: "You have a puppy of 0–24 months." },
      best: [{ date: "2025-12-08", views: 1_234_567, keptPer1k: 92, text: "Sample review of the app. Very happy, 10/10." }],
    });
    expect(system).toContain("You're one of the people @tinyacrobatics posts for: New parent. You have a puppy of 0–24 months.");
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
    expect(buildReviewPrompt({ doc: d, persona: { name: "Stranger", about: "You don't follow." }, best: [] }).system).toContain("stop watching");
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
    const input = { doc: carousel(), handle: "tinyacrobatics", persona: { name: "Parent", about: "You have a puppy." }, best: [] };
    const plain = buildReviewPrompt(input);
    expect(buildReviewPrompt({ ...input, packText: "" })).toEqual(plain);
    const packed = buildReviewPrompt({ ...input, packText: "PACK-REVIEW-ZQ" });
    expect(packed.system.startsWith(plain.system)).toBe(true);
    expect(packed.system).toContain("PACK-REVIEW-ZQ");
    expect(packed.user).toBe(plain.user);
  });
});

describe("personas", () => {
  it("keep a name and a paragraph each, drop empty ones and stop at four", () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ name: ` P${i} `, about: "You watch." }));
    expect(parsePersonas([{ name: "", about: "x" }, { name: "Stranger", about: " " }, ...six, "junk", null])).toEqual(
      ["P0", "P1", "P2", "P3"].map((name) => ({ name, about: "You watch." })),
    );
    expect(parsePersonas("not a list")).toEqual([]);
  });

  it("are read from the drafted answer, with or without text around the JSON", () => {
    const one = [{ name: "Stranger", about: "You don't follow yet." }];
    expect(parsePersonaDraft(`Here:\n{"personas":${JSON.stringify(one)}}\nDone`)).toEqual(one);
    expect(parsePersonaDraft(JSON.stringify(one))).toEqual(one);
    expect(() => parsePersonaDraft("no json")).toThrow("Could not read");
    expect(() => parsePersonaDraft('{"personas":[]}')).toThrow("Could not read");
  });
});

describe("what personas are drafted from", () => {
  it("keeps the evidence line with each persona", () => {
    expect(parsePersonas([{ name: "Stranger", about: "You don't follow.", basis: " Non-followers are 70% of views " }])).toEqual([{ name: "Stranger", about: "You don't follow.", basis: "Non-followers are 70% of views" }]);
  });

  it("turns the audience numbers into shares, biggest first", () => {
    const text = renderAudienceNumbers({ ages: [{ label: "18-24", value: 10 }, { label: "25-34", value: 30 }], viewsByFollower: [{ label: "Non-followers", value: 3 }, { label: "Followers", value: 1 }] });
    expect(text).toContain("Ages: 25-34 75%, 18-24 25%");
    expect(text).toContain("Views, last 30 days: Non-followers 75%, Followers 25%");
    expect(renderAudienceNumbers(undefined)).toBe("");
  });

  it("quotes viewers' comments, most-liked first, and leaves out the account's own replies", () => {
    const c = (username: string, text: string, likeCount: number) => ({ text, user: { username }, likeCount });
    const { text, count } = renderAudienceComments(
      [{ post: "Puppy sleep tips", comments: [c("viewer1", "Does this work at 4 months?", 1), c("TinyAcrobatics", "Yes!", 9), c("viewer2", "Saved this", 5)] }],
      "tinyacrobatics",
    );
    expect(count).toBe(2);
    expect(text).toContain('Under "Puppy sleep tips":\n- Saved this\n- Does this work at 4 months?');
    expect(text).not.toContain("Yes!");
  });
});
