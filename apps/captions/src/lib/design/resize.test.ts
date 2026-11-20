import { describe, expect, it } from "vitest";
import type { DesignPage, ShapeLayer, TextLayer } from "../../../contracts/design";
import { fillRow, pinAxis, resized, sizedCopy } from "./resize";

const rect = (id: string, x: number, y: number, w: number, h: number, more: Partial<ShapeLayer> = {}): ShapeLayer => ({ id, type: "shape", shape: "rect", fill: "#000000", x, y, w, h, ...more });
const text = (id: string, more: Partial<TextLayer> = {}): TextLayer => ({ id, type: "text", text: "Hello", font: "Inter", size: 60, color: "#111111", align: "left", x: 100, y: 100, w: 400, h: 100, ...more });
const frame = (layers: DesignPage["layers"], more: Partial<DesignPage> = {}): DesignPage => ({ id: "p1", x: 0, y: 0, w: 1080, h: 1350, background: "#ffffff", layers, ...more });

describe("pinAxis", () => {
  it("places one side of a layer as its pin says, the frame going from 1000 to 1500", () => {
    expect(pinAxis("left", 100, 200, 1000, 1500)).toEqual([100, 200]);
    expect(pinAxis("right", 700, 200, 1000, 1500)).toEqual([1200, 200]);
    expect(pinAxis("both", 100, 800, 1000, 1500)).toEqual([100, 1300]);
    expect(pinAxis("center", 400, 200, 1000, 1500)).toEqual([650, 200]);
    expect(pinAxis("scale", 100, 200, 1000, 1500)).toEqual([150, 300]);
    // stretched to nothing, it keeps a pixel
    expect(pinAxis("both", 0, 100, 1000, 500)).toEqual([0, 1]);
  });
});

describe("resized (by hand or by an AI)", () => {
  it("moves pinned layers with the frame's edges and leaves unpinned ones where they are", () => {
    const page = frame([rect("a", 900, 1200, 100, 100, { pin: { x: "right", y: "bottom" } }), rect("b", 100, 100, 100, 100), rect("c", 0, 0, 1080, 200, { pin: { x: "both" } })]);
    const out = resized(page, { w: 1280, h: 1920 });
    expect(out.layers.map((l) => [l.x, l.y, l.w, l.h])).toEqual([
      [1100, 1770, 100, 100],
      [100, 100, 100, 100],
      [0, 0, 1280, 200],
    ]);
    expect([out.w, out.h]).toEqual([1280, 1920]);
  });

  it("pulled from its left edge: an unpinned layer stays put on the canvas, a left-pinned one goes with the edge", () => {
    const page = frame([rect("a", 100, 100, 100, 100), rect("b", 100, 100, 100, 100, { pin: { x: "left" } })]);
    const out = resized(page, { x: -200, y: 0, w: 1280, h: 1350 });
    expect(out.layers.map((l) => l.x)).toEqual([300, 100]);
    expect(out.x).toBe(-200);
  });
});

describe("sizedCopy (a copy in another size)", () => {
  it("turns a 4:5 slide into 9:16: the background stretches, the words keep their size and their share of the height", () => {
    const page = frame([rect("bg", 0, 0, 1080, 1350), text("t", { x: 140, y: 1000, w: 800, h: 200, fit: "shrink" })], { block: "s1", name: "Slide" });
    const out = sizedCopy(page, { w: 1080, h: 1920 }, "p2", "Slide story");
    const [bg, t] = out.layers as [ShapeLayer, TextLayer];
    expect([bg.x, bg.y, bg.w, bg.h]).toEqual([0, 0, 1080, 1920]);
    // its middle at 1100 of 1350 is now at 1100 / 1350 of 1920
    expect([t.x, t.w, t.h, t.size]).toEqual([140, 800, 200, 60]);
    expect(t.y).toBeCloseTo((1100 * 1920) / 1350 - 100, 1);
    expect(t.fit).toBe("shrink");
    expect(out).toMatchObject({ id: "p2", name: "Slide story", w: 1080, h: 1920 });
    // the copy draws no slide: its words are its own
    expect(out.block).toBeUndefined();
  });

  it("into a smaller wide size, a layer shrinks whole by the lesser change, its words and lines with it", () => {
    const page = frame([text("t", { x: 140, y: 575, w: 800, h: 200, size: 100, outline: { color: "#000000", width: 10 } }), rect("r", 440, 100, 200, 200, { radius: 20, stroke: { color: "#000000", width: 8 } })]);
    const out = sizedCopy(page, { w: 1280, h: 720 }, "p3");
    const [t, r] = out.layers as [TextLayer, ShapeLayer];
    const k = 720 / 1350;
    expect(t.size).toBeCloseTo(100 * k, 1);
    expect(t.outline!.width).toBeCloseTo(10 * k, 1);
    expect(t.w).toBeCloseTo(800 * k, 1);
    // its middle keeps its share of the width
    expect(t.x + t.w / 2).toBeCloseTo((540 * 1280) / 1080, 1);
    expect([r.w, r.h]).toEqual([round(200 * k), round(200 * k)]);
    expect(r.radius).toBeCloseTo(20 * k, 1);
    expect(r.stroke!.width).toBeCloseTo(8 * k, 1);
  });

  it("a copy scales a layer's effects and its runs' size and spacing with it", () => {
    const page = frame([text("t", { x: 140, y: 575, w: 800, h: 200, size: 100, runs: [{ start: 0, end: 2, size: 160, spacing: 10 }], effects: [{ type: "shadow", color: "#000000", opacity: 0.3, blur: 40, x: 10, y: 20, spread: 6 }, { type: "background-blur", blur: 30 }, { type: "noise", amount: 12, size: 2 }] })]);
    const t = sizedCopy(page, { w: 540, h: 675 }, "p5").layers[0] as TextLayer;
    expect(t.runs).toEqual([{ start: 0, end: 2, size: 80, spacing: 5 }]);
    expect(t.effects).toEqual([{ type: "shadow", color: "#000000", opacity: 0.3, blur: 20, x: 5, y: 10, spread: 3 }, { type: "background-blur", blur: 15 }, { type: "noise", amount: 12, size: 2 }]);
  });

  it("a pinned layer in a copy follows its pin and draws at its own size", () => {
    const page = frame([text("t", { x: 80, y: 1200, w: 300, h: 80, pin: { x: "left", y: "bottom" } })]);
    const t = sizedCopy(page, { w: 1080, h: 1920 }, "p4").layers[0] as TextLayer;
    expect([t.x, t.y, t.size]).toEqual([80, 1770, 60]);
  });
});

describe("fillRow (one row of data onto a copy)", () => {
  it("sets the named layers' words, colour and whether they show, and names the copy", () => {
    const page = frame([text("h", { name: "Headline" }), rect("b", 0, 0, 10, 10, { name: "Badge" }), text("x", { name: "Other" })]);
    const { page: out, missing } = fillRow(page, { name: "02-proof", headline: "Loads in under a second", Badge: { visible: false, color: "#ff0000" }, Price: "9" });
    expect(out.name).toBe("02-proof");
    expect((out.layers[0] as TextLayer).text).toBe("Loads in under a second");
    expect(out.layers[1]).toMatchObject({ hidden: true, fill: "#ff0000" });
    expect((out.layers[2] as TextLayer).text).toBe("Hello");
    expect(missing).toEqual(["Price"]);
    // shown again
    expect(fillRow(out, { Badge: { visible: true } }).page.layers[1]!.hidden).toBeUndefined();
  });

  it("a text's runs move with its new words, never left on the letters they were at", () => {
    const page = frame([text("p", { name: "Price", text: "Only €49 today", runs: [{ start: 5, end: 8, strike: true }] })]);
    const out = fillRow(page, { Price: "Now just €29" }).page.layers[0] as TextLayer;
    expect(out.text).toBe("Now just €29");
    expect(out.runs).toBeUndefined();
    const kept = fillRow(page, { Price: "Only €49 today!" }).page.layers[0] as TextLayer;
    expect(kept.runs).toEqual([{ start: 5, end: 8, strike: true }]);
  });
});

const round = (n: number) => Math.round(n * 100) / 100;
