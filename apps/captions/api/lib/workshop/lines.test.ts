import { describe, expect, it } from "vitest";
import { buildLinesPrompt, parseLines } from "./lines";

describe("other ways to say this", () => {
  const doc = {
    kind: "carousel" as const,
    blocks: [
      { id: "b1", text: "This is why your sample needs a clear plan", author: "user" as const, at: 1 },
      { id: "b2", text: "Every position asks their body for something different", author: "ai" as const, at: 1 },
    ],
  };

  it("marks the selection in its slide and shows the rest of the piece as it is", () => {
    const text = doc.blocks[1]!.text;
    const { system, user } = buildLinesPrompt({ doc, blockId: "b2", text, start: 0, end: text.length, notes: ["No asks."] });
    expect(user).toContain("Slide 1\nThis is why your sample needs a clear plan");
    expect(user).toContain("Slide 2 (the one with the selection)\n«Every position asks their body for something different»");
    expect(user).toContain("- No asks.");
    expect(system).toContain('{"options": [string, string, string]}');
  });

  it("takes three clean options, without quote marks or repeats", () => {
    expect(parseLines('{"options": ["«On their tummy they lift their head»", "\\"They push up on their arms\\"", "They push up on their arms", "four"]}')).toEqual([
      "On their tummy they lift their head",
      "They push up on their arms",
      "four",
    ]);
    expect(() => parseLines('{"options": []}')).toThrow("No options came back");
  });
});
