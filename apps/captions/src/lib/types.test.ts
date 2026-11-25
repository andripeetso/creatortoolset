import { describe, expect, it } from "vitest";
import { DEFAULT_STYLE, STYLE_PRESETS, placeForReel } from "./types";

describe("placeForReel", () => {
  const low = STYLE_PRESETS.find((p) => p.name === "Classic Low")!.style;

  it("moves a box under the reel's buttons up to end at 65 % on a vertical video", () => {
    const s = placeForReel(low, 1080, 1920);
    expect(s.boxY + s.boxH / 2).toBeCloseTo(65);
    expect(s.boxH).toBe(low.boxH);
  });

  it("keeps the preset's place on landscape and 4:5", () => {
    expect(placeForReel(low, 1920, 1080)).toBe(low);
    expect(placeForReel(low, 1080, 1350)).toBe(low);
  });

  it("raises an edge-placed style's margin to the band", () => {
    const s = placeForReel({ ...DEFAULT_STYLE, fitBox: false, position: "bottom", marginVPct: 6 }, 1080, 1920);
    expect(s.marginVPct).toBe(35);
  });

  it("names every preset once", () => {
    const names = STYLE_PRESETS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
