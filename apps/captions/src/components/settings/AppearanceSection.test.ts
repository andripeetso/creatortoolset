import { describe, expect, it } from "vitest";
import { TOOLS, onHome, type Tool } from "@contracts/tools";
import { hiddenAfter } from "./AppearanceSection";

describe("Home shows every tool except the ones switched off", () => {
  it("default: nothing hidden, so every tool shows (and every switch starts on)", () => {
    for (const t of TOOLS) expect(onHome([], t)).toBe(true);
    for (const t of TOOLS) expect(onHome(undefined, t)).toBe(true);
  });

  it("one hidden: that one is gone, the rest stay", () => {
    const hidden: Tool[] = ["notes"];
    expect(onHome(hidden, "notes")).toBe(false);
    for (const t of TOOLS.filter((x) => x !== "notes")) expect(onHome(hidden, t)).toBe(true);
  });

  it("old saved data with a short makes list still shows every tool (that list no longer decides the tiles)", () => {
    // an account saved only "workshop" and "editor" as its tools before this change: no hidden list, so nothing is hidden
    const oldTools: Tool[] = ["workshop", "editor"];
    expect(oldTools.length).toBeLessThan(TOOLS.length);
    for (const t of TOOLS) expect(onHome(undefined, t)).toBe(true);
  });
});

describe("the switches save the hidden list", () => {
  it("turning a tool off hides it, turning it back on shows it again, other hidden tools stay as they were", () => {
    expect(hiddenAfter([], "notes", false)).toEqual(["notes"]);
    expect(hiddenAfter(["enhance"], "notes", false)).toEqual(["enhance", "notes"]);
    expect(hiddenAfter(["enhance", "notes"], "notes", true)).toEqual(["enhance"]);
    expect(hiddenAfter(["enhance"], "notes", true)).toEqual(["enhance"]);
  });
});
