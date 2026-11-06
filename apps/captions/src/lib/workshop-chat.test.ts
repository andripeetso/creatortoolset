import { describe, expect, it } from "vitest";
import { turnDocChange, type ChatMessage } from "./workshop";

const msg = (patch: Partial<ChatMessage>): Pick<ChatMessage, "edits" | "revertedTo"> => patch;

describe("turnDocChange", () => {
  it("does not treat a provider-only reply as an edit", () => {
    expect(turnDocChange(msg({ provider: "Kimi", status: "done", text: "Here's a question." }))).toBeNull();
  });

  it("ignores an edits object with no docId or block list", () => {
    expect(turnDocChange(msg({ edits: undefined }))).toBeNull();
    expect(turnDocChange(msg({ edits: { docId: "", blockIds: ["b1"] } }))).toBeNull();
  });

  it("counts created and edited turns even when blockIds is missing", () => {
    expect(turnDocChange(msg({ edits: { docId: "d1", blockIds: ["b1", "b2"], created: true } }))).toEqual({
      kind: "created",
      docId: "d1",
      blocks: 2,
      versionBefore: undefined,
    });
    expect(turnDocChange(msg({ edits: { docId: "d1", blockIds: undefined as unknown as string[] } }))).toEqual({
      kind: "edited",
      docId: "d1",
      blocks: 0,
      versionBefore: undefined,
    });
  });

  it("prefers a revert over edits", () => {
    expect(turnDocChange(msg({ revertedTo: "v3", edits: { docId: "d1", blockIds: ["b1"] } }))).toEqual({
      kind: "reverted",
      version: "v3",
    });
  });
});
