import { describe, expect, it } from "vitest";
import { choosableSlots } from "./EditorDefaultsDialog";

const item = { id: "x", title: "X" };

describe("choosableSlots (when the AI Editor Defaults button shows)", () => {
  it("lists only the slots with more than one choice", () => {
    const items = { designSystem: [item], grade: [item, { id: "y", title: "Y" }], voiceMix: [item], sfxSet: [] } as never;
    expect(choosableSlots({ items })).toEqual(["grade"]);
  });

  it("is empty when every slot has at most one choice (no button)", () => {
    const items = { designSystem: [item], grade: [item], voiceMix: [item], sfxSet: [item] } as never;
    expect(choosableSlots({ items })).toEqual([]);
  });
});
