import { describe, expect, it } from "vitest";
import type { DesignPage } from "@contracts/design";
import { aidTargets, gridOf, rulerTicks, safeOf } from "./aids";
import { mergeFrame, snapMove } from "./hands";

describe("the designer's aids on a frame", () => {
  it("lays columns and rows across the frame inside its margins, with gutters between", () => {
    const g = gridOf({ kind: "columns", count: 4, gutter: 20, margin: 60, color: "#ff0000" }, 1080, 1350);
    // (1080 - 120 - 60) / 4 = 225 each
    expect(g.bands.map((b) => [b.x, b.w])).toEqual([[60, 225], [305, 225], [550, 225], [795, 225]]);
    expect(g.bands[3]!.x + g.bands[3]!.w).toBe(1020);
    expect(g.x).toHaveLength(8);
    expect(g.y).toEqual([]);
    const r = gridOf({ kind: "rows", count: 2, gutter: 0, margin: 0, color: "#ff0000" }, 100, 200);
    expect(r.bands).toEqual([{ x: 0, y: 0, w: 100, h: 100 }, { x: 0, y: 100, w: 100, h: 100 }]);
    // a margin wider than the frame leaves no room, never a band of negative size
    expect(gridOf({ kind: "columns", count: 3, gutter: 10, margin: 900, color: "#ff0000" }, 1080, 1350).bands.every((b) => b.w >= 0)).toBe(true);
  });

  it("draws a square grid's lines every cell, edges included", () => {
    const g = gridOf({ kind: "grid", size: 100, color: "#ff0000" }, 1080, 250);
    expect(g.x).toEqual([0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
    expect(g.y).toEqual([0, 100, 200]);
    expect(g.bands).toEqual([]);
  });

  it("shows where Instagram cuts a tall cover and covers a reel", () => {
    // a 9:16 cover in the feed: only the middle 4:5 shows
    const feed = safeOf("feed", 1080, 1920);
    expect(feed.safe).toEqual({ x: 0, y: 285, w: 1080, h: 1350 });
    expect(feed.covered).toEqual([{ x: 0, y: 0, w: 1080, h: 285 }, { x: 0, y: 1635, w: 1080, h: 285 }]);
    // a 4:5 post in the 3:4 profile grid loses a little of each side
    const grid = safeOf("grid", 1080, 1350);
    expect(grid.safe.y).toBe(0);
    expect(grid.safe.w).toBeCloseTo(1012.5);
    expect(grid.safe.x).toBeCloseTo(33.75);
    // a frame already as wide as the crop loses nothing
    expect(safeOf("feed", 1080, 1350).covered.every((c) => c.w * c.h === 0) || safeOf("feed", 1080, 1350).covered.length === 0).toBe(true);
    const reel = safeOf("reel", 1080, 1920);
    expect(reel.safe.y).toBeCloseTo(268.8);
    expect(reel.safe.y + reel.safe.h).toBeCloseTo(1920 * 0.65);
    expect(reel.covered).toHaveLength(4);
  });

  it("gives guides, shown grids and safe parts to snapMove, each catching on its own axis only", () => {
    const page: Pick<DesignPage, "guides" | "grids" | "safe"> = { guides: [{ axis: "x", at: 300 }, { axis: "y", at: 500 }] };
    const targets = aidTargets(page, 1080, 1350, true);
    // a box 4 px off the vertical guide snaps onto it across, not down
    const s = snapMove({ x: 304, y: 900, w: 100, h: 100 }, targets, 6);
    expect(s).toMatchObject({ dx: -4, x: 300, dy: 0 });
    expect(s.y).toBeUndefined();
    const t = snapMove({ x: 700, y: 397, w: 100, h: 100 }, targets, 6);
    expect(t).toMatchObject({ dy: 3, y: 500 });
    // a column edge catches; a hidden grid, or grids turned off, do not
    const cols = { grids: [{ kind: "columns" as const, count: 2, gutter: 0, margin: 100, color: "#ff0000" }] };
    expect(snapMove({ x: 103, y: 0, w: 50, h: 50 }, aidTargets(cols, 1080, 1350, true), 6).x).toBe(100);
    expect(aidTargets(cols, 1080, 1350, false)).toEqual([]);
    expect(aidTargets({ grids: [{ ...cols.grids[0]!, hidden: true }] }, 1080, 1350, true)).toEqual([]);
    // a 1-pixel grid is too many lines to catch on
    expect(aidTargets({ grids: [{ kind: "grid", size: 1, color: "#ff0000" }] }, 1080, 1350, true)).toEqual([]);
    // the reel's safe box: its top edge catches
    expect(snapMove({ x: 500, y: 271, w: 10, h: 10 }, aidTargets({ safe: ["reel"] }, 1080, 1920, true), 6).dy).toBeCloseTo(-2.2);
  });

  it("numbers a ruler at round steps at least 50 screen pixels apart", () => {
    expect(rulerTicks(0, 500, 1)).toEqual({ step: 50, at: [0, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500] });
    expect(rulerTicks(-120, 400, 0.25).step).toBe(200);
    expect(rulerTicks(-120, 400, 0.25).at).toEqual([0, 200, 400]);
    expect(rulerTicks(10, 20, 16).step).toBe(5);
    expect(rulerTicks(10, 12, 32).step).toBe(2);
  });

  it("keeps a guide moved in this window when the server changed the frame's layers meanwhile", () => {
    const base: DesignPage = { id: "p1", background: "#ffffff", layers: [] };
    const mine = { ...base, guides: [{ axis: "x" as const, at: 40 }] };
    const theirs = { ...base, layers: [{ id: "l1", type: "shape" as const, shape: "rect" as const, fill: "#000000", x: 0, y: 0, w: 10, h: 10 }] };
    expect(mergeFrame(mine, base, theirs)).toMatchObject({ guides: [{ axis: "x", at: 40 }], layers: [{ id: "l1" }] });
  });
});
