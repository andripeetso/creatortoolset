import { describe, expect, it } from "vitest";
import { packContents, slugify } from "./packs-helpers";

describe("packContents", () => {
  it("lists instruction slots in the app's slot order, with their labels, and leaves out ones this app doesn't use", () => {
    const c = packContents({
      instructions: { "editor.cards": "cards text", "editor.script": "script text", "workshop.write": "write text" },
      frameworks: [{ name: "Hook, proof, ask", role: "persuasion", summary: "", steps: [], whenToUse: "" }],
      captionStyles: [{ name: "Bold", kind: "caption", style: {} }],
    });
    expect(c.slots.map((s) => s.slot)).toEqual(["workshop.write", "editor.script"]);
    expect(c.slots[0].label).toBe("Content Workshop: writing and editing pieces");
    expect(c.frameworks).toEqual([{ name: "Hook, proof, ask", role: "persuasion" }]);
    expect(c.captionStyles).toEqual(["Bold"]);
  });

  it("is empty for a pack with nothing in it", () => {
    expect(packContents({})).toEqual({ slots: [], frameworks: [], captionStyles: [] });
  });
});

describe("slugify", () => {
  it("turns a name into a pack id", () => {
    expect(slugify("  Punchy Hooks, LinkedIn!  ")).toBe("punchy-hooks-linkedin");
  });
});
