import { describe, expect, it } from "vitest";
import { buildAsidePrompt } from "./aside";
import { buildTurnPrompt } from "./chat-prompt";
import { parseQuotes } from "./validate";

const doc = {
  kind: "carousel" as const,
  blocks: [
    { id: "b1", text: "This is why your sample needs a clear plan\n\nEven beyond the first month, the second and the third", author: "user" as const, at: 1 },
    { id: "b2", text: "BUT before your sample can start...", author: "user" as const, at: 1 },
  ],
};

describe("ask about this", () => {
  it("sees only the slide, where it sits and the best openings; nothing else", () => {
    const { system, user } = buildAsidePrompt({
      doc,
      blockId: "b1",
      text: doc.blocks[0]!.text,
      question: "Is this a good written hook?",
      history: [],
      best: [{ date: "2025-12-08", views: 1_234_567, keptPer1k: 92, text: "Sample review of the app. Very happy, 10/10.\nmore" }],
    });
    expect(system).toContain("designed slides people read on their phone and swipe, not something said out loud");
    expect(system).toContain("You can't change the piece");
    expect(user).toContain("Slide 1 of 2:\nThis is why your sample needs a clear plan");
    expect(user).not.toContain("BUT before");
    expect(user).toContain("- 1,234,567 views, 92.0 saves+shares per 1,000: Sample review of the app. Very happy, 10/10.");
    expect(user).not.toContain("more");
    expect(user.endsWith("Author now: Is this a good written hook?")).toBe(true);
  });

  it("marks a selection and carries its own side chat", () => {
    const text = doc.blocks[0]!.text;
    const { system, user } = buildAsidePrompt({ doc, blockId: "b1", text, start: 0, end: 4, question: "and now?", history: [{ role: "user", text: "first?" }, { role: "assistant", text: "Yes." }], best: [] });
    expect(system).toContain("marked «like this»");
    expect(user).toContain("«This» is why");
    expect(user).toContain("So far in this side chat:\nAuthor: first?\nYou: Yes.");
  });
});

describe("comments on the piece", () => {
  it("parse to what was selected, where, and the note", () => {
    expect(parseQuotes([{ blockId: "b2", slide: 1, text: " BUT before ", comment: "too shouty?" }, { text: "" }, { blockId: "../x", text: "kept" }])).toEqual([
      { blockId: "b2", slide: 1, text: "BUT before", comment: "too shouty?" },
      { text: "kept" },
    ]);
  });

  it("keep a cited video's post id and handle, and drop a malformed id", () => {
    expect(parseQuotes([{ postId: "C8xYz_aBc", handle: "coach", text: "SAMPLE HOOK ONE" }, { postId: "../etc", text: "bad id" }])).toEqual([
      { postId: "C8xYz_aBc", handle: "coach", text: "SAMPLE HOOK ONE" },
      { text: "bad id" },
    ]);
  });

  it("reach the writer right above the message, and stay with it in the history", () => {
    const quotes = [{ blockId: "b2", slide: 1, text: "BUT before", comment: "too shouty?" }, { from: "reply" as const, text: "Slides 1 and 5 give different numbers" }];
    const { user } = buildTurnPrompt({
      frameworks: [],
      rules: [],
      doc: { ...doc, id: "d1", sessionId: "s1", title: "C", frameworkIds: [], versions: [], nextBlock: 3, nextVersion: 1, createdAt: 1, updatedAt: 1 } as never,
      pinned: [],
      sources: [],
      history: [{ id: "m1", role: "user", text: "look at this", at: 1, docId: "d1", quotes }],
      message: "fix it",
      quotes,
    });
    expect(user).toContain("The author cited these with this message:\n- ⟦1⟧ slide 2 (b2): «BUT before»\n  their note: too shouty?\n- ⟦2⟧ from your earlier reply: «Slides 1 and 5 give different numbers»");
    expect(user).toContain("Author: look at this [about «BUT before»: too shouty?]");
    expect(user.indexOf("The author cited")).toBeLessThan(user.indexOf("Author now: fix it"));
  });
});
