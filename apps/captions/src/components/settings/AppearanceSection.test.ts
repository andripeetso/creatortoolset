import { describe, expect, it } from "vitest";
import { HOME_TILES, TOOLS, onHome, type Tool } from "@contracts/tools";
import { accentFor } from "@/lib/workspace";
import { hiddenAfter } from "./ToolsSection";

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

describe("every Home tile has a switch", () => {
  it("lists every tool once, in Home's order, and the Screen Recorder last", () => {
    expect(HOME_TILES.slice(0, -1).slice().sort()).toEqual([...TOOLS].sort());
    expect(HOME_TILES.at(-1)).toBe("record");
    expect(onHome(["record"], "record")).toBe(false);
    expect(onHome(["record"], "review")).toBe(true);
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

describe("the colour the app wears", () => {
  it("follows the project while that is the choice, whatever colour was picked before", () => {
    expect(accentFor(true, "rose", "sky")).toBe("sky");
    expect(accentFor(true, "rose", null)).toBe("violet");
  });

  it("is the person's own colour once they pick one, whatever the project's is", () => {
    expect(accentFor(false, "rose", "sky")).toBe("rose");
    expect(accentFor(false, "violet", "sky")).toBe("violet");
  });

  it("falls back to violet for a saved colour that is not one of ours", () => {
    expect(accentFor(false, "chartreuse", "sky")).toBe("violet");
    expect(accentFor(false, "toString", null)).toBe("violet");
  });
});
