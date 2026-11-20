import { describe, expect, it } from "vitest";
import { cleanAids } from "./design-aids";
import { cleanPages } from "./design-check";

describe("a frame's aids, checked", () => {
  it("keeps guides as whole pixels on a known axis, once each", () => {
    expect(cleanAids({ guides: [{ axis: "x", at: 100.4 }, { axis: "x", at: 100 }, { axis: "y", at: -5 }, { axis: "z", at: 3 }, { axis: "y", at: "9" }, null] })).toEqual({ guides: [{ axis: "x", at: 100 }, { axis: "y", at: 0 }] });
    expect(cleanAids({ guides: Array.from({ length: 60 }, (_, n) => ({ axis: "x", at: n })) }).guides).toHaveLength(40);
  });

  it("brings grids inside what they can be and fills what they leave out", () => {
    expect(cleanAids({ grids: [{ kind: "columns", count: 0, gutter: -3, margin: 64.6, color: "#FF00AA" }, { kind: "grid", size: 0, color: "blue" }, { kind: "hexagons" }, { kind: "rows", hidden: true }] })).toEqual({
      grids: [
        { kind: "columns", count: 1, gutter: 0, margin: 65, color: "#ff00aa" },
        { kind: "grid", size: 1, color: "#ff0000" },
        { kind: "rows", count: 4, gutter: 0, margin: 0, color: "#ff0000", hidden: true },
      ],
    });
  });

  it("keeps known safe zones in their own order, and nothing for empty lists", () => {
    expect(cleanAids({ safe: ["reel", "nope", "feed", "reel"] })).toEqual({ safe: ["feed", "reel"] });
    expect(cleanAids({ guides: [], grids: [], safe: [] })).toEqual({});
  });

  it("goes through with a frame saved by the person or the AI", () => {
    const [p] = cleanPages([{ id: "p1", background: "#ffffff", layers: [], guides: [{ axis: "y", at: 270 }], grids: [{ kind: "columns", count: 4, gutter: 24, margin: 80, color: "#ff0000" }], safe: ["grid"] }], { w: 1080, h: 1350, pictures: [] }).pages;
    expect(p).toMatchObject({ guides: [{ axis: "y", at: 270 }], grids: [{ kind: "columns", count: 4 }], safe: ["grid"] });
  });
});
