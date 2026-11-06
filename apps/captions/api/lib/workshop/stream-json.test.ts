import { describe, expect, it } from "vitest";
import { partialTurn } from "./stream-json";

const full = '{"reply": "Tightened the hook — say \\"no\\" to fluff.\\nDone.", "newDocument": null, "revertTo": null, "edits": [{"op":"replace","id":"b1","text":"New hook"},{"op":"append","text":"CTA"}], "learned": []}';

describe("partialTurn", () => {
  it("reads the reply as it is written, escapes included", () => {
    expect(partialTurn("")).toMatchObject({ reply: "", replyDone: false, editsReady: false });
    expect(partialTurn('{"reply": "Tigh')).toMatchObject({ reply: "Tigh", replyDone: false });
    expect(partialTurn('{"reply": "say \\"no\\" to \\')).toMatchObject({ reply: 'say "no" to ', replyDone: false });
    expect(partialTurn('{"reply": "line\\nbreak"')).toMatchObject({ reply: "line\nbreak", replyDone: true });
  });

  it("hands out edits only once complete, and only after newDocument and revertTo are known", () => {
    const cut = full.slice(0, full.indexOf('{"op":"append"') + 12);
    const p = partialTurn(cut);
    expect(p.editsReady).toBe(true);
    expect(p.newDocument).toBeNull();
    expect(p.revertTo).toBeNull();
    expect(p.edits).toEqual([{ op: "replace", id: "b1", text: "New hook" }]);
    const done = partialTurn(full);
    expect(done.edits).toHaveLength(2);
    expect(done.replyDone).toBe(true);
    // edits before newDocument: not safe to apply yet
    const early = partialTurn('{"reply":"x","edits":[{"op":"append","text":"A"}],"newDocument":null,"revertTo":null}');
    expect(early.editsReady).toBe(false);
    expect(early.edits).toEqual([]);
    // a new document: the edits belong to it, never to the open one
    const fresh = partialTurn('```json\n{"reply":"x","newDocument":{"kind":"carousel","title":"Carousel version"},"revertTo":null,"edits":[{"op":"append","text":"A"}]');
    expect(fresh.editsReady).toBe(true);
    expect(fresh.newDocument).toEqual({ kind: "carousel", title: "Carousel version" });
    expect(fresh.edits).toHaveLength(1);
    expect(partialTurn('{"reply":"x","newDocument":null,"revertTo":"v3","edits":[]}').revertTo).toBe("v3");
  });
});
