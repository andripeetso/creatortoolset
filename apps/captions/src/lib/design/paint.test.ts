import { describe, expect, it } from "vitest";
import type { DesignPage, Layer, Paint, Stroke } from "@contracts/design";
import { colourAt, fillsOf, hexOf, moved, paintPictures, rgba, solidGround, strokesOf, withFills, withStrokes } from "./paint";
import { pathEnds, picturePlace } from "./paint-draw";

const shape = (more: Partial<Layer> = {}) => ({ id: "s", type: "shape", shape: "rect", fill: "#ff0000", x: 0, y: 0, w: 100, h: 50, ...more }) as Extract<Layer, { type: "shape" }>;
const text = (more: Partial<Layer> = {}) => ({ id: "t", type: "text", text: "Hi", font: "Inter", size: 40, color: "#111111", align: "left", x: 0, y: 0, w: 100, h: 50, ...more }) as Extract<Layer, { type: "text" }>;
const path = (more: Partial<Layer> = {}) => ({ id: "p", type: "path", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], x: 0, y: 0, w: 100, h: 100, ...more }) as Extract<Layer, { type: "path" }>;
const frame = (more: Partial<DesignPage> = {}): DesignPage => ({ id: "p1", background: "#ffffff", layers: [], ...more });

describe("fills and lines as lists", () => {
  it("reads an old design's one fill and one line as a list of one, drawn as before", () => {
    expect(fillsOf(shape())).toEqual([{ type: "solid", color: "#ff0000" }]);
    expect(fillsOf(shape({ gradient: { to: "#000000", angle: 90, via: "#888888", kind: "radial" } }))).toEqual([
      { type: "gradient", kind: "radial", angle: 90, stops: [{ at: 0, color: "#ff0000" }, { at: 0.5, color: "#888888" }, { at: 1, color: "#000000" }] },
    ]);
    expect(fillsOf(text())).toEqual([{ type: "solid", color: "#111111" }]);
    expect(fillsOf(frame())).toEqual([{ type: "solid", color: "#ffffff" }]);
    // a path without a fill is a line alone
    expect(fillsOf(path())).toEqual([]);
    expect(strokesOf(shape({ stroke: { color: "#000000", width: 4, dash: [8, 4] } }))).toEqual([{ color: "#000000", width: 4, dash: [8, 4] }]);
    expect(strokesOf(text({ outline: { color: "#000000", width: 6 } }))).toEqual([{ color: "#000000", width: 6 }]);
    expect(strokesOf(frame())).toEqual([]);
    // a list there is the whole truth: the old fields are only for whatever reads them alone
    expect(fillsOf(shape({ fills: [] }))).toEqual([]);
  });

  it("writes one plain colour or line back the old way, and anything more as a list", () => {
    const red: Paint = { type: "solid", color: "#00ff00" };
    expect(withFills(shape({ gradient: { to: "#000000", angle: 0 } }), [red])).toEqual(shape({ fill: "#00ff00" }));
    const two: Paint[] = [red, { type: "solid", color: "#0000ff80", blend: "multiply" }];
    const s = withFills(shape(), two);
    expect(s.fills).toEqual(two);
    expect(s.fill).toBe("#00ff00");
    expect(fillsOf(s)).toEqual(two);
    // a see-through colour still says itself in one field
    expect(withFills(text(), [{ type: "solid", color: "#00000099" }])).toEqual(text({ color: "#00000099" }));
    // one with an opacity of its own needs the list
    expect(withFills(frame(), [{ type: "solid", color: "#000000", opacity: 0.5 }]).fills).toHaveLength(1);
    // a path with no fills left has no fill at all
    const filled = path({ fill: "#ff0000", gradient: { to: "#000000", angle: 0 } });
    expect(withFills(filled, [])).toEqual(path());
    expect(fillsOf(withFills(filled, []))).toEqual([]);

    const line: Stroke = { color: "#000000", width: 4 };
    expect(withStrokes(shape(), [line])).toEqual(shape({ stroke: line }));
    expect(withStrokes(text({ outline: { color: "#ff0000", width: 2 } }), [line])).toEqual(text({ outline: line }));
    const sticker = [{ color: "#ffffff", width: 18 }, { color: "#000000", width: 8 }];
    const t = withStrokes(text({ outline: { color: "#ff0000", width: 2 } }), sticker);
    expect(t.outline).toBeUndefined();
    expect(strokesOf(t)).toEqual(sticker);
    expect(withStrokes(shape({ stroke: line }), [])).toEqual(shape());
    expect(withStrokes(shape(), [{ ...line, end: "arrow" }]).strokes).toEqual([{ ...line, end: "arrow" }]);
  });

  it("moves an item of a list, reads and writes see-through colours, and finds a gradient's colour between its stops", () => {
    expect(moved(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moved(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(rgba("#ff000080")).toEqual([255, 0, 0, 128 / 255]);
    expect(rgba("#f00")).toEqual([255, 0, 0, 1]);
    expect(hexOf(255, 0, 0, 0.5)).toBe("#ff000080");
    expect(hexOf(255, 0, 0)).toBe("#ff0000");
    const stops = [{ at: 1, color: "#ffffff" }, { at: 0, color: "#000000" }];
    expect(colourAt(stops, 0.5)).toBe("#808080");
    expect(colourAt(stops, -1)).toBe("#000000");
    expect(colourAt(stops, 2)).toBe("#ffffff");
    expect(colourAt([{ at: 0, color: "#000000" }, { at: 1, color: "#00000000" }], 0.5)).toBe("#00000080");
  });

  it("names the pictures fills show, so they are loaded before the frame is drawn", () => {
    const pic: Paint = { type: "image", picture: "a.jpg", mode: "fill" };
    const page = frame({ fills: [pic], layers: [text({ fills: [{ ...pic, picture: "b.png" }] }), shape({ hidden: true, fills: [{ ...pic, picture: "c.png" }] }), shape({ fills: [{ ...pic, picture: "d.png", hidden: true }] })] });
    expect(paintPictures(page)).toEqual(["a.jpg", "b.png"]);
  });

  it("lays a picture fill in its box: filling it, fitting in it, one part of it filling it, or tiled a part of its width", () => {
    const pic = (more: object) => ({ type: "image", picture: "a", mode: "fill", ...more }) as Extract<Paint, { type: "image" }>;
    // a 200 × 100 picture in a 100 × 100 box
    expect(picturePlace(pic({}), 200, 100, 100, 100)).toEqual({ k: 1, x: -50, y: 0 });
    expect(picturePlace(pic({ mode: "fit" }), 200, 100, 100, 100)).toEqual({ k: 0.5, x: 0, y: 25 });
    // its left half, in the middle of the box
    expect(picturePlace(pic({ mode: "crop", crop: { x: 0, y: 0, w: 0.5, h: 1 } }), 200, 100, 100, 100)).toEqual({ k: 1, x: 0, y: 0 });
    expect(picturePlace(pic({ mode: "tile", scale: 0.5 }), 200, 100, 100, 100)).toEqual({ k: 0.25, x: 0, y: 0 });
  });

  it("finds an open path's ends and the way the line runs into each, past handles that sit on their point", () => {
    const ends = pathEnds([{ x: 0, y: 0 }, { x: 1, y: 0, in: [0, 0] }], 100, 50)!;
    expect(ends.end).toEqual({ at: [100, 0], dir: [1, 0] });
    expect(ends.start).toEqual({ at: [0, 0], dir: [-1, 0] });
    // a curve comes into its end along its last handle
    const curved = pathEnds([{ x: 0, y: 0 }, { x: 1, y: 1, in: [0, -0.5] }], 100, 100)!;
    expect(curved.end.dir).toEqual([0, 1]);
  });
});

describe("a frame's ground", () => {
  const page = (more: Partial<DesignPage>) => ({ id: "p", background: "#ffffff", layers: [], ...more }) as DesignPage;
  it("hides what is under it only with a solid fill of full colour", () => {
    expect(solidGround(page({}))).toBe(true);
    expect(solidGround(page({ background: "#ffffffff" }))).toBe(true);
    expect(solidGround(page({ fills: [] }))).toBe(false);
    expect(solidGround(page({ background: "#ffffff80" }))).toBe(false);
    expect(solidGround(page({ fills: [{ type: "solid", color: "#000000", hidden: true }] }))).toBe(false);
    expect(solidGround(page({ fills: [{ type: "solid", color: "#000000", opacity: 0.5 }] }))).toBe(false);
  });
});
