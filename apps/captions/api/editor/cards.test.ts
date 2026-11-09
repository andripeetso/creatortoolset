import { describe, expect, it } from "vitest";
import type { InstalledPack } from "../../contracts/packs";
import { cardsInstructions } from "./cards";

/** An installed pack record with only the fields the card slot reads. */
function installed(id: string, level: 0 | 1, text: string | undefined): InstalledPack {
  return {
    id, name: `Tiny ${id}`, version: "1.0.0", author: "tinyacrobatics", license: "MIT", description: "fixture",
    installedAt: 1, updatedAt: 1, level, off: [], items: { frameworks: [], presets: [] },
    instructions: text === undefined ? {} : { "editor.cards": text },
  };
}

describe("cardsInstructions", () => {
  it("reads the editor.cards slot only from level 1 packs", () => {
    const packs = [
      installed("plain-text", 0, "level 0 card text"),
      installed("kit-pack", 1, "level 1 card text"),
    ];
    const text = cardsInstructions(packs);
    expect(text).toContain("level 1 card text");
    expect(text).not.toContain("level 0 card text");
  });

  it("is empty when no level 1 pack sets the slot", () => {
    expect(cardsInstructions([installed("plain-text", 0, "level 0 card text")])).toBe("");
    expect(cardsInstructions([installed("kit-pack", 1, undefined)])).toBe("");
    expect(cardsInstructions([])).toBe("");
  });

  it("honours a pack switched off for the project", () => {
    const pack = { ...installed("kit-pack", 1, "level 1 card text"), off: ["project-a"] };
    expect(cardsInstructions([pack], "project-a")).toBe("");
    expect(cardsInstructions([pack], "project-b")).toContain("level 1 card text");
  });
});
