import { describe, expect, it } from "vitest";
import type { DesignPage, Layer } from "@contracts/design";
import { drawingUrl, fontOf, inLayer, layerAt, lineHeightOf, shapePoints, shownText, sourceOf, textWidth, wrapLines } from "./draw";

/** Every letter 10 wide: widths a test can count. */
const measure = (s: string) => s.length * 10;
const box = (more: Partial<Layer> = {}): Layer => ({ id: "a", type: "shape", shape: "rect", fill: "#000000", x: 100, y: 100, w: 200, h: 100, ...more }) as Layer;

describe("drawing a design", () => {
  it("wraps between words inside the box, keeps the text's own line breaks, and leaves a word wider than the box whole", () => {
    expect(wrapLines("Roll the mat out", 80, measure)).toEqual(["Roll the", "mat out"]);
    expect(wrapLines("Roll the mat out", 1000, measure)).toEqual(["Roll the mat out"]);
    expect(wrapLines("One\n\nTwo  three", 1000, measure)).toEqual(["One", "", "Two three"]);
    expect(wrapLines("Supercalifragilistic mat", 50, measure)).toEqual(["Supercalifragilistic", "mat"]);
    expect(wrapLines("", 50, measure)).toEqual([""]);
  });

  it("measures a line with its letter spacing (between the letters, not after the last), so it wraps where it is drawn", () => {
    expect(textWidth({}, "Roll", measure)).toBe(40);
    expect(textWidth({ spacing: 5 }, "Roll", measure)).toBe(55);
    expect(textWidth({ spacing: 5 }, "", measure)).toBe(0);
    // an emoji is one letter
    expect(textWidth({ spacing: 5 }, "a👶", (s) => Array.from(s).length * 10)).toBe(25);
    const spaced = (s: string) => textWidth({ spacing: 10 }, s, measure);
    expect(wrapLines("Roll the mat", 120, measure)).toEqual(["Roll the mat"]);
    expect(wrapLines("Roll the mat", 120, spaced)).toEqual(["Roll", "the", "mat"]);
  });

  it("gives the shapes with straight sides their corners inside the box: a triangle up, an arrow to the right, a five-pointed star", () => {
    expect(shapePoints("triangle", 200, 100)).toEqual([[100, 0], [200, 100], [0, 100]]);
    const arrow = shapePoints("arrow", 300, 100);
    expect(arrow[3]).toEqual([300, 50]);
    expect(arrow[2]).toEqual([200, 0]);
    // a short arrow's head is at most half of it
    expect(shapePoints("arrow", 100, 100)[2]).toEqual([50, 0]);
    const star = shapePoints("star", 200, 200);
    expect(star).toHaveLength(10);
    expect(star[0]![0]).toBeCloseTo(100);
    expect(star[0]![1]).toBeCloseTo(0);
    for (const [x, y] of star) expect(x >= 0 && x <= 200 && y >= 0 && y <= 200).toBe(true);
  });

  it("names a text's font at its real weight and size, its line height and its shown letters", () => {
    expect(fontOf({ font: "Montserrat ExtraBold", size: 96 })).toBe('800 96px "Montserrat ExtraBold"');
    expect(fontOf({ font: "Anton", size: 50 }, 0.5)).toBe('400 25px "Anton"');
    expect(lineHeightOf({ size: 100 })).toBeCloseTo(115);
    expect(lineHeightOf({ size: 100, lineHeight: 1.3 })).toBe(130);
    expect(shownText({ text: "Roll it", upper: true })).toBe("ROLL IT");
  });

  it("finds the topmost layer under a point, through a layer's rotation", () => {
    const under = box({ id: "under" });
    const over = box({ id: "over", x: 250, y: 150, w: 100, h: 100 });
    const page: DesignPage = { id: "p1", background: "#ffffff", layers: [under, over] };
    expect(layerAt(page, 120, 120)?.id).toBe("under");
    expect(layerAt(page, 280, 180)?.id).toBe("over");
    expect(layerAt(page, 10, 10)).toBeNull();
    // a 200 × 100 box turned a quarter: its corners are no longer in it, a point above its middle now is
    const turned = box({ rotate: 90 });
    expect(inLayer(turned, 105, 105).inside).toBe(false);
    expect(inLayer(turned, 200, 60).inside).toBe(true);
    expect(inLayer(box(), 200, 60).inside).toBe(false);
    const local = inLayer(box(), 150, 130);
    expect([local.x, local.y]).toEqual([50, 30]);
  });

  it("lets a press through a hidden or a locked layer to what is under it", () => {
    const page = (over: Partial<Layer>): DesignPage => ({ id: "p1", background: "#ffffff", layers: [box({ id: "under" }), box({ id: "over", ...over })] });
    expect(layerAt(page({}), 150, 150)?.id).toBe("over");
    expect(layerAt(page({ hidden: true }), 150, 150)?.id).toBe("under");
    expect(layerAt(page({ locked: true }), 150, 150)?.id).toBe("under");
  });

  it("names what a layer needs loaded: a picture's id, a drawing's markup as a picture address, nothing for words and shapes", () => {
    expect(sourceOf({ id: "i", type: "image", picture: "ab12cd34.jpg", fit: "cover", x: 0, y: 0, w: 1, h: 1 })).toBe("ab12cd34.jpg");
    expect(sourceOf(box())).toBeNull();
    expect(drawingUrl('<svg viewBox="0 0 1 1"><rect fill="#f90"/></svg>')).toBe("data:image/svg+xml;charset=utf-8,%3Csvg%20viewBox%3D%220%200%201%201%22%3E%3Crect%20fill%3D%22%23f90%22%2F%3E%3C%2Fsvg%3E");
  });
});
