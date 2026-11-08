import { describe, expect, it } from "vitest";
import { cornerOf, settle } from "./dock-place";

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
