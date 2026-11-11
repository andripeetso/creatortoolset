import { describe, expect, it } from "vitest";
import { choosableSlots } from "./EditorDefaultsDialog";

const item = { id: "x", title: "X" };

describe("choosableSlots (when the AI Editor Defaults button shows)", () => {
  it("lists only the slots with more than one choice", () => {
    const items = { designSystem: [item], grade: [item, { id: "y", title: "Y" }], voiceMix: [item], sfxSet: [] } as never;
    expect(choosableSlots({ items })).toEqual(["grade"]);
  });

  it("a page that passes its own slots gets only those; with none passed it is every slot, as before", () => {
    const two = [item, { id: "y", title: "Y" }];
    const items = { designSystem: two, grade: two, voiceMix: two, sfxSet: two } as never;
    expect(choosableSlots({ items }, ["grade"])).toEqual(["grade"]);
    expect(choosableSlots({ items })).toEqual(["designSystem", "grade", "voiceMix", "sfxSet"]);
    expect(choosableSlots({ items: { designSystem: [item], grade: [item], voiceMix: two, sfxSet: two } as never }, ["grade"])).toEqual([]);
  });

  it("is empty when every slot has at most one choice (no button)", () => {
    const items = { designSystem: [item], grade: [item], voiceMix: [item], sfxSet: [item] } as never;
    expect(choosableSlots({ items })).toEqual([]);
  });
});
