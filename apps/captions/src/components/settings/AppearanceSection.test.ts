import { describe, expect, it } from "vitest";
import { HOME_TILES, TOOLS, TOOL_NEEDS, onHome, type Tool } from "@contracts/tools";
import { accentFor, accentTones, customTintCss, shadesOf } from "@/lib/workspace";
import { hiddenAfter, missingNeeds, needFix, needLabel } from "./ToolsSection";

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

describe("a colour of the person's own", () => {
  it("is the accent once picked, and the project's again when they follow the project", () => {
    expect(accentFor(false, "#12AB9F", "sky")).toBe("#12ab9f");
    expect(accentFor(true, "#12ab9f", "sky")).toBe("sky");
    expect(accentFor(false, "#12ab9", "sky")).toBe("violet"); // not a whole colour
  });

  it("makes eleven shades from the picked colour: itself at 500, white-wards below, black-wards above", () => {
    const s = shadesOf("#ff0000");
    expect(s[500]).toBe("255 0 0");
    expect(s[50]).toBe("255 242 242");
    expect(s[950]).toBe("71 0 0");
    const light = (rgb: string) => rgb.split(" ").reduce((n, v) => n + Number(v), 0);
    const order = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;
    for (let i = 1; i < order.length; i++) expect(light(s[order[i]!])).toBeLessThan(light(s[order[i - 1]!]));
    expect(accentTones("#ff0000")).toEqual({ rgb: s[600], text: s[400] });
    expect(accentTones("sky")).toMatchObject({ rgb: "2 132 199" });
  });

  it("writes the same variables a project colour has, with pale and deep swapped for the light theme", () => {
    const css = customTintCss("#ff0000");
    const s = shadesOf("#ff0000");
    const [light, dark] = css.split(".dark[data-tint=\"custom\"]");
    expect(light).toContain(':root[data-tint="custom"]{');
    for (const part of [light, dark]) expect(part).toContain(`--violet-500:${s[500]}`);
    expect(dark).toContain(`--t-violet-300:${s[300]}`);
    expect(light).toContain(`--t-violet-300:${s[700]}`);
    expect(dark).toContain(`--s-violet-900:${s[900]}`);
    expect(light).toContain(`--s-violet-900:${s[100]}`);
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

describe("a tool's row says what stops it and where that is fixed", () => {
  const labels = (tile: Parameters<typeof missingNeeds>[0], have: Parameters<typeof missingNeeds>[1]) => missingNeeds(tile, have).map(needLabel);

  it("lists only what is missing and required: one line each, nothing once it is set up", () => {
    expect(labels("enhance", [])).toEqual(["Needs an ElevenLabs or NVIDIA key"]);
    expect(labels("enhance", ["NVIDIA_API_KEY"])).toEqual([]);
    expect(labels("instagram", [])).toEqual(["Needs a project", "Needs an Apify key"]);
    expect(labels("instagram", ["project", "instagram"])).toEqual([]); // its own Instagram login reads the posts too
  });

  it("says nothing for a tool that works: no list of what it has, nothing optional, nothing for one that needs nothing", () => {
    expect(labels("captions", [])).toEqual([]); // Deepgram and AI are optional there
    expect(labels("review", [])).toEqual([]);
    expect(labels("record", [])).toEqual([]);
    for (const t of TOOLS) expect(labels(t, ["project", "ai", "ownAi", "library", "apify", "DEEPGRAM_API_KEY", "ELEVENLABS_API_KEY"])).toEqual([]);
  });

  it("sends each kind of need to the place that sets it up", () => {
    const need = (tool: Tool, i: number) => TOOL_NEEDS[tool][i]!;
    expect(needFix(need("enhance", 0))).toEqual({ label: "Add key", to: "/settings/keys#api-key-ELEVENLABS_API_KEY" });
    expect(needFix(need("instagram", 0))).toEqual({ label: "New project", to: "/projects" });
    expect(needFix(need("instagram", 1))).toEqual({ label: "Add key", to: "/settings/keys#apify-key" });
    expect(needFix(need("workshop", 1))).toEqual({ label: "Add AI", to: "/settings/providers" });
    expect(needFix(need("media", 0))).toEqual({ label: "Open Media Library", to: "/library" });
  });
});
