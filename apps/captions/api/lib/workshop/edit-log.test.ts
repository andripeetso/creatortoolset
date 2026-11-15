import { describe, expect, it } from "vitest";
import { chatPairs, editsFile, mergeLog, pairsOf, renderPairs } from "./edit-log";
import { buildTurnPrompt } from "./chat-prompt";
import { newDocument } from "./doc";

const ai = "Fine for the bus. It's the whole trip in one that adds up.";
const his = "They're fine a short bus ride but not for the whole afternoon (that adds up)";

describe("the author's rewrites of the AI's text", () => {
  const doc = { id: "d1", kind: "carousel" as const, title: "Strength training", userEdits: [
    { blockId: "caption", from: ai, fromAuthor: "ai" as const, to: his, at: 5 },
    { blockId: "b3", from: "Chest, back, side", fromAuthor: "ai" as const, to: "Chest, back, sides", at: 6 }, // a typo fix
    { blockId: "b4", from: "My own line", fromAuthor: "user" as const, to: "My own line, again", at: 7 }, // the author's own text
  ] };

  it("keeps the AI text and the author's version word for word, nothing else", () => {
    const pairs = pairsOf(doc);
    expect(pairs).toEqual([{ key: `d1:caption:${ai.slice(0, 60)}`, kind: "description", docKind: "carousel", docTitle: "Strength training", from: ai, to: his, at: 5 }]);
  });

  it("keeps what the author cut out of the AI's text as a cut, and never the author's own removed text", () => {
    const cut = { id: "d2", kind: "carousel" as const, title: "Cuts", userEdits: [
      { blockId: "b2", from: "Nobody needs a second hour of the same drill", fromAuthor: "ai" as const, at: 8 },
      { blockId: "b5", from: "A line I wrote myself, then cut", fromAuthor: "user" as const, at: 9 },
    ] };
    const pairs = pairsOf(cut);
    expect(pairs).toEqual([{ key: "d2:b2:Nobody needs a second hour of the same drill", kind: "slide", docKind: "carousel", docTitle: "Cuts", from: "Nobody needs a second hour of the same drill", to: "", at: 8 }]);
    expect(renderPairs(pairs, "slides")).toContain("--- The author made it:\n(cut)");
    expect(editsFile(pairs)).toContain("The author made it:\n\n(cut)");
  });

  it("replaces a later save of the same rewrite instead of piling up keystrokes", () => {
    const first = mergeLog([], pairsOf(doc));
    const again = mergeLog(first, pairsOf({ ...doc, userEdits: [{ ...doc.userEdits[0]!, to: `${his}!`, at: 9 }] }));
    expect(again).toHaveLength(1);
    expect(again[0]!.to).toBe(`${his}!`);
  });

  it("shows the writer the raw pairs, no labels or rules", () => {
    const pairs = pairsOf(doc);
    const block = renderPairs(pairs, "post descriptions");
    expect(block).toContain(`--- AI wrote:\n${ai}\n--- The author made it:\n${his}\n---`);
    expect(editsFile(pairs)).toContain(`AI wrote:\n\n${ai}\n\nThe author made it:\n\n${his}`);
    const { user } = buildTurnPrompt({
      frameworks: [],
      rules: [],
      doc: newDocument("d1", "s1", "carousel", "C", { text: "x", now: 1 }),
      pinned: [],
      sources: [],
      history: [],
      message: "Write the post description",
      rewrites: { descriptions: pairs, pieces: [] },
    });
    expect(user).toContain("How the author rewrote the AI's post descriptions");
    expect(user).toContain(his);
  });
});

describe("a version of his own given in the chat (owner, 2026-11-15: \"we don't do rules\")", () => {
  const slogan = "Raw takes in, first cut out. That's actually how this video started.";
  const pieces = [
    { id: "s1", kind: "reel", title: "Launch video script", blocks: [{ id: "b1", text: slogan, author: "ai" }, { id: "b2", text: "I made this one myself on a Sunday.", author: "user" }] },
    { id: "t1", kind: "thread", title: "Launch thread", blocks: [{ id: "b1", text: "No tiers. No credits. There's no way to pay me.", author: "ai" }] },
  ] as unknown as Parameters<typeof chatPairs>[2];
  const said = (text: string, extra: { pasted?: string[]; quotes?: string[] } = {}) => ({ text, pasted: extra.pasted ?? [], quotes: extra.quotes ?? [] });
  const his = `shit like "${slogan}"\n\nIn reality we'd say so you put the raw takes in here, wait a second and then you get your first or final cut out, however you wanna work best.`;

  it("a line he quoted and his version of it are kept, with wanna spelled out and nothing else of his changed", () => {
    const kept = chatPairs([{ from: slogan, to: "so you put the raw takes in here, wait a second and then you get your first or final cut out, however you wanna work best." }], said(his), pieces, 7);
    expect(kept).toEqual([{ key: `s1:chat:${slogan.slice(0, 60)}`, kind: "script", docKind: "reel", docTitle: "Launch video script", from: slogan, to: "so you put the raw takes in here, wait a second and then you get your first or final cut out, however you want to work best.", at: 7 }]);
  });

  it("a complaint with no version of his own keeps nothing, and the writer's own rewrite is never the after", () => {
    const complaint = said('your twitter one still uses slogans like "No tiers. No credits. There\'s no way to pay me." jesus christ i hate those');
    expect(chatPairs([{ from: "No tiers. No credits. There's no way to pay me.", to: "It's free, and there isn't a paid version of it at all." }], complaint, pieces, 1)).toEqual([]);
    // his message only quoted the piece back: no version of his
    expect(chatPairs([{ from: "No tiers. No credits.", to: "No tiers. No credits. There's no way to pay me." }], complaint, pieces, 1)).toEqual([]);
  });

  it("only a line of the AI's that he quoted or pointed at: not his own line, not one he never mentioned", () => {
    expect(chatPairs([{ from: "I made this one myself on a Sunday.", to: "I made this one on a Sunday afternoon" }], said('"I made this one myself on a Sunday." I made this one on a Sunday afternoon'), pieces, 1)).toEqual([]);
    expect(chatPairs([{ from: slogan, to: "you put the raw takes in here" }], said("you put the raw takes in here and wait"), pieces, 1)).toEqual([]);
    // pointed at on the page (a selected line), his version in what he wrote next to it
    const pointed = chatPairs([{ from: "No tiers. No credits. There's no way to pay me.", to: "it's completely free and I made it that way on purpose" }], said("\n\nit's completely free and I made it that way on purpose", { quotes: ["No tiers. No credits."] }), pieces, 2);
    expect(pointed.map((p) => [p.docTitle, p.from, p.to])).toEqual([["Launch thread", "No tiers. No credits. There's no way to pay me.", "it's completely free and I made it that way on purpose"]]);
  });
});
