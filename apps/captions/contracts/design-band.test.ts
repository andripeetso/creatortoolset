import { describe, expect, it } from "vitest";
import { intoBand, intoBandMargin, isVertical } from "./design";

const box = (boxY: number, boxH = 14, boxX = 50, boxW = 80) => ({ boxX, boxY, boxW, boxH, keep: 1 });

describe("reel band", () => {
  it("knows a vertical video by its shown size", () => {
    expect(isVertical(1080, 1920)).toBe(true);
    expect(isVertical(1080, 1350)).toBe(false); // 4:5
    expect(isVertical(1920, 1080)).toBe(false);
  });

  it("moves a box under the buttons up to end at 65 %", () => {
    const b = intoBand(box(84), 1080, 1920);
    expect(b.boxY + b.boxH / 2).toBeCloseTo(65);
    expect(b.keep).toBe(1);
  });

  it("leaves a box inside the band, and every box on landscape and 4:5", () => {
    const inside = box(50);
    expect(intoBand(inside, 1080, 1920)).toBe(inside);
    expect(intoBand(box(84), 1920, 1080).boxY).toBe(84);
    expect(intoBand(box(84), 1080, 1350).boxY).toBe(84);
  });

  it("centres a box taller than the band, and never moves it sideways", () => {
    expect(intoBand(box(50, 60), 1080, 1920).boxY).toBeCloseTo(39.5);
    expect(intoBand(box(84, 10, 80, 30), 1080, 1920).boxX).toBe(80);
  });

  it("raises an edge-placed style's margin into the band", () => {
    expect(intoBandMargin("bottom", 6, 1080, 1920)).toBe(35);
    expect(intoBandMargin("top", 5, 1080, 1920)).toBe(14);
    expect(intoBandMargin("center", 6, 1080, 1920)).toBe(6);
    expect(intoBandMargin("bottom", 6, 1920, 1080)).toBe(6);
  });
});
