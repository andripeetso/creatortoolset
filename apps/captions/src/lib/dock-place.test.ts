import { describe, expect, it } from "vitest";
import { cornerHeight, cornerOf, settle } from "./dock-place";

describe("settle", () => {
  const W = 1400;
  const H = 900;
  it("drops on the nearest corner", () => {
    expect(settle(100, 100, 0, 0, W, H, true)).toEqual({ mode: "float", corner: "tl" });
    expect(settle(1300, 800, 0, 0, W, H, true)).toEqual({ mode: "float", corner: "br" });
    expect(settle(800, 300, 0, 0, W, H, true)).toEqual({ mode: "float", corner: "tr" });
  });
  it("a throw lands where it was heading", () => {
    // released left of centre, thrown hard right and down
    expect(settle(600, 300, 1500, 1200, W, H, true)).toEqual({ mode: "float", corner: "br" });
  });
  it("docks the card at the right edge, never the bubble", () => {
    expect(settle(1395, 400, 0, 0, W, H, true)).toEqual({ mode: "dock" });
    expect(settle(1100, 400, 2000, 0, W, H, true)).toEqual({ mode: "dock" });
    expect(settle(10, 400, 0, 0, W, H, true)).toEqual({ mode: "float", corner: "tl" });
    expect(settle(1395, 400, 0, 0, W, H, false)).toEqual({ mode: "float", corner: "tr" });
  });
  it("a docked chat closes to the bubble bottom right", () => {
    expect(cornerOf({ mode: "dock" })).toBe("br");
    expect(cornerOf({ mode: "float", corner: "tr" })).toBe("tr");
  });
});

describe("cornerHeight", () => {
  const W = 1440;
  const H = 900;
  it("a box in the bottom right corner stands as high as from its top to the window's bottom", () => {
    // a Workshop session's message box, stacked: the chat card runs to 9px from the right edge and 8px from the bottom
    expect(cornerHeight({ top: 690, right: 1431, bottom: 892 }, W, H)).toBe(210);
    // a Review video's comment box, flush with both edges
    expect(cornerHeight({ top: 710, right: 1440, bottom: 900 }, W, H)).toBe(190);
  });
  it("says nothing where the layout puts the box elsewhere", () => {
    expect(cornerHeight({ top: 690, right: 887, bottom: 892 }, W, H)).toBe(0); // the Content card stands to its right
    expect(cornerHeight({ top: 300, right: 1431, bottom: 500 }, W, H)).toBe(0); // not at the bottom
  });
});
