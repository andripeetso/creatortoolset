import { describe, expect, it } from "vitest";
import { editsFile, mergeLog, pairsOf, renderPairs } from "./edit-log";
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
