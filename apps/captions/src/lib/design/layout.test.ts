import { describe, expect, it } from "vitest";
import type { GroupLayer, Layer, ShapeLayer, TextLayer } from "../../../contracts/design";
import { addAutoLayout, fixedBy, flowInsert, flowSlot, guessWidth, layoutLayers, withSizing, withoutLayout, wordsSize } from "./layout";
import { sizedCopy } from "./resize";

// every letter half its size wide: "Hi" at 20px is 20 wide; a line is 20 × 1.15 = 23 high
const measure = (font: string, s: string) => Number(/([\d.]+)px/.exec(font)![1]) * 0.5 * Array.from(s).length;
const rect = (id: string, w: number, h: number, more: Partial<ShapeLayer> = {}): ShapeLayer => ({ id, type: "shape", shape: "rect", fill: "#000000", x: 0, y: 0, w, h, ...more });
const text = (id: string, words: string, more: Partial<TextLayer> = {}): TextLayer => ({ id, type: "text", text: words, font: "Inter", size: 20, color: "#000000", align: "left", x: 0, y: 0, w: 10, h: 10, sizing: { w: "hug", h: "hug" }, ...more });
const box = (layers: Layer[], layout: GroupLayer["layout"], more: Partial<GroupLayer> = {}): GroupLayer => ({ id: "b", type: "group", box: true, x: 0, y: 0, w: 100, h: 100, layers, layout, ...more });
const one = (l: Layer, notes?: string[]) => layoutLayers([l], measure, notes && ((n) => notes.push(n)))[0] as GroupLayer;
const places = (g: GroupLayer) => g.layers.map((l) => [l.x, l.y, l.w, l.h]);

describe("auto layout", () => {
  it("hugs its layers, their gaps and its padding", () => {
    const g = one(box([rect("a", 10, 10), rect("c", 10, 20), rect("d", 10, 10)], { dir: "row", gap: 5, pad: 10 }, { sizing: { w: "hug", h: "hug" } }));
    expect([g.w, g.h]).toEqual([60, 40]);
    expect(places(g)).toEqual([[10, 10, 10, 10], [25, 10, 10, 20], [40, 10, 10, 10]]);
  });

  it("keeps a fixed size and places the layers by its alignment", () => {
    const g = one(box([rect("a", 10, 10), rect("c", 10, 10)], { dir: "row", gap: 10, align: "center", cross: "end" }));
    expect([g.w, g.h]).toEqual([100, 100]);
    expect(places(g)).toEqual([[35, 90, 10, 10], [55, 90, 10, 10]]);
  });

  it("pads each side on its own, in a column", () => {
    const g = one(box([rect("a", 10, 10), rect("c", 10, 10)], { dir: "column", gap: 4, pad: [1, 2, 3, 4] }, { sizing: { w: "hug", h: "hug" } }));
    expect([g.w, g.h]).toEqual([16, 28]);
    expect(places(g)).toEqual([[4, 1, 10, 10], [4, 15, 10, 10]]);
  });

  it("shares what is left among the layers that fill, each kept to its least and most", () => {
    const g = one(box([rect("a", 20, 10), rect("c", 1, 10, { sizing: { w: "fill" } }), rect("d", 1, 10, { sizing: { w: "fill" }, max: { w: 10 } })], { dir: "row" }));
    expect(g.layers.map((l) => l.w)).toEqual([20, 70, 10]);
    expect(g.layers.map((l) => l.x)).toEqual([0, 20, 90]);
    const least = one(box([rect("a", 90, 10), rect("c", 1, 10, { sizing: { w: "fill" }, min: { w: 30 } })], { dir: "row" }));
    expect(least.layers[1]!.w).toBe(30);
  });

  it("spreads the layers evenly between its ends", () => {
    const g = one(box([rect("a", 10, 10), rect("c", 10, 10), rect("d", 10, 10)], { dir: "row", gap: 3, between: true }));
    expect(g.layers.map((l) => l.x)).toEqual([0, 45, 90]);
    // hugging that way, it uses its gap
    expect(one(box([rect("a", 10, 10), rect("c", 10, 10)], { dir: "row", gap: 3, between: true }, { sizing: { w: "hug" } })).w).toBe(23);
  });

  it("wraps onto new lines at a fixed width and hugs the lines' height", () => {
    const g = one(box([0, 1, 2, 3, 4].map((n) => rect(`r${n}`, 20, 10)), { dir: "row", gap: 5, wrap: true, lineGap: 2 }, { w: 50, sizing: { h: "hug" } }));
    expect(places(g).map(([x, y]) => [x, y])).toEqual([[0, 0], [25, 0], [0, 12], [25, 12], [0, 24]]);
    expect(g.h).toBe(34);
  });

  it("keeps a layer out of the flow where it is, following the box's edge by its pin", () => {
    const g = one(box([rect("a", 10, 10), rect("tag", 4, 4, { x: 16, y: 0, absolute: true, pin: { x: "right" } }), rect("free", 4, 4, { x: 3, y: 5, absolute: true })], { dir: "row" }, { x: 300, y: 200, w: 20, h: 10, sizing: { w: "hug" } }));
    // one without a pin stays where it is in the box, wherever the box lies
    expect([g.layers[2]!.x, g.layers[2]!.y]).toEqual([3, 5]);
    expect(g.layers[0]!.x).toBe(0);
    expect(g.w).toBe(10);
    expect([g.layers[1]!.x, g.layers[1]!.y]).toEqual([6, 0]);
    // hidden layers take no room
    expect(one(box([rect("a", 10, 10), rect("c", 10, 10, { hidden: true })], { dir: "row", gap: 5 }, { sizing: { w: "hug" } })).w).toBe(10);
  });

  it("a pill grows with its word, and the list holding it with the pill", () => {
    const pill = box([text("t", "Hi")], { dir: "row", pad: [8, 16, 8, 16] }, { id: "pill", sizing: { w: "hug", h: "hug" } });
    const list = box([pill, rect("r", 30, 30)], { dir: "column", gap: 10 }, { id: "list", sizing: { w: "hug", h: "hug" } });
    const a = one(list);
    const p = a.layers[0] as GroupLayer;
    expect([p.w, p.h, p.layers[0]!.w, p.layers[0]!.h]).toEqual([52, 39, 20, 23]);
    expect([a.w, a.h]).toEqual([52, 79]);
    const longer = { ...a, layers: [{ ...p, layers: [{ ...p.layers[0]!, text: "Hello there" } as Layer] }, a.layers[1]!] };
    const b = one(longer);
    expect([b.layers[0]!.w, b.w]).toEqual([142, 142]);
    expect(b.layers[1]!.y).toBe(49);
  });

  it("wraps a hugging text at its most width", () => {
    const t = layoutLayers([text("t", "aaaa bbbb", { max: { w: 45 } })], measure)[0]!;
    expect([t.w, t.h]).toEqual([45, 46]);
  });

  it("stretches a layer that fills across to the line, the box still hugging", () => {
    const notes: string[] = [];
    const g = one(box([text("t", "One\nTwo\nThree"), rect("r", 10, 5, { sizing: { h: "fill" } })], { dir: "row", gap: 4, pad: 6 }, { sizing: { w: "hug", h: "hug" } }), notes);
    expect(g.layers.map((l) => l.h)).toEqual([69, 69]);
    expect(g.h).toBe(81);
    expect(notes).toEqual([]);
  });

  it("a text that fills a column's width wraps there and the column grows with it", () => {
    const g = one(box([text("t", "aaaa bbbb", { sizing: { w: "fill", h: "hug" } })], { dir: "column" }, { w: 45, sizing: { h: "hug" } }));
    expect([g.layers[0]!.w, g.layers[0]!.h, g.h]).toEqual([45, 46, 46]);
  });

  it("fixes a hugging box that a layer fills along its flow, and one that every layer fills across, saying so", () => {
    const notes: string[] = [];
    const g = one(box([rect("a", 10, 10, { sizing: { w: "fill", h: "fill" } })], { dir: "row" }, { name: "Card", w: 80, h: 30, sizing: { w: "hug", h: "hug" } }), notes);
    expect(g.sizing).toBeUndefined();
    expect([g.layers[0]!.w, g.layers[0]!.h]).toEqual([80, 30]);
    expect(notes).toEqual(["Width set to Fixed for Card", "Height set to Fixed for Card"]);
  });

  it("is never smaller than its padding", () => {
    expect([one(box([], { dir: "row", pad: 12 }, { sizing: { w: "hug", h: "hug" } })).w, one(box([rect("a", 5, 5)], { dir: "row", pad: 12 }, { w: 4, h: 4 })).w]).toEqual([24, 24]);
  });

  it("settles in one pass: a second leaves everything as it is", () => {
    const deep = box([box([text("t", "Hello"), rect("r", 4, 4, { sizing: { h: "fill" } })], { dir: "row", gap: 6, pad: 4 }, { id: "in", sizing: { w: "fill", h: "hug" } }), text("u", "Two lines\nhere", { sizing: { w: "fill", h: "hug" } })], { dir: "column", gap: 8, pad: 10, wrap: true }, { w: 300, sizing: { h: "hug" } });
    const a = layoutLayers([deep], measure);
    expect(layoutLayers(a, measure)).toBe(a);
    expect(layoutLayers(a, null)).toBe(a);
  });

  it("fixes a side resized by hand, saying so", () => {
    const notes: string[] = [];
    const t = text("t", "Hi", { name: "Badge", w: 20, h: 23 });
    const out = fixedBy(t, { ...t, w: 50 }, (n) => notes.push(n));
    expect(out.sizing).toEqual({ h: "hug" });
    expect(notes).toEqual(["Width set to Fixed for Badge"]);
    expect(fixedBy(t, { ...t, x: 5 })).toEqual({ ...t, x: 5 });
  });

  it("sets hug only where it applies, and a box hugging along its flow fixes its layers that filled that way", () => {
    const notes: string[] = [];
    expect(withSizing(rect("a", 1, 1), "w", "hug", true).sizing).toBeUndefined();
    expect(withSizing(rect("a", 1, 1), "w", "fill", false).sizing).toBeUndefined();
    const g = withSizing(box([rect("a", 1, 1, { name: "Bar", sizing: { w: "fill" } })], { dir: "row" }), "w", "hug", false, (n) => notes.push(n)) as GroupLayer;
    expect([g.sizing, g.layers[0]!.sizing]).toEqual([{ w: "hug" }, undefined]);
    expect(notes).toEqual(["Width set to Fixed for Bar"]);
    const plain = withoutLayout(box([rect("a", 1, 1, { sizing: { w: "fill", h: "fill" } })], { dir: "row" }, { sizing: { w: "hug" } }));
    expect([plain.layout, plain.sizing, plain.layers[0]!.sizing]).toEqual([undefined, undefined, undefined]);
  });

  it("adds auto layout round picked layers: their direction, mean gap, order and hugging words", () => {
    const layers = [text("c", "Three", { x: 0, y: 100, w: 60, h: 23, sizing: undefined }), text("a", "One", { x: 0, y: 0, w: 60, h: 23, sizing: undefined }), text("b", "Two", { x: 0, y: 46, w: 60, h: 23, sizing: undefined })];
    const out = addAutoLayout(layers, ["a", "b", "c"], "box1", measure)!;
    const g = out.layers[0] as GroupLayer;
    expect(out.id).toBe("box1");
    expect(g.layout).toEqual({ dir: "column", gap: 27 });
    expect(g.sizing).toEqual({ w: "hug", h: "hug" });
    expect(g.layers.map((l) => [l.id, l.sizing])).toEqual([["a", { w: "hug", h: "hug" }], ["b", { w: "hug", h: "hug" }], ["c", { w: "hug", h: "hug" }]]);
    const laid = layoutLayers(out.layers, measure)[0] as GroupLayer;
    expect(laid.layers.map((l) => l.y)).toEqual([0, 50, 100]);
    expect(laid.w).toBe(50);
    // a group given auto layout in place keeps its id, its padding worked out from where its layers lie
    const grp: GroupLayer = { id: "g", type: "group", x: 0, y: 0, w: 100, h: 40, layers: [rect("p", 20, 20, { x: 10, y: 10 }), rect("q", 20, 20, { x: 50, y: 10 })] };
    const conv = addAutoLayout([grp], ["g"], "unused", measure)!;
    expect(conv.id).toBe("g");
    expect((conv.layers[0] as GroupLayer).layout).toEqual({ dir: "row", gap: 20, pad: [10, 30, 10, 10] });
  });

  it("finds the place a dragged layer goes in the flow, and moves it there", () => {
    const g = one(box([rect("a", 10, 10), rect("b2", 10, 10), rect("c", 10, 10)], { dir: "row", gap: 10 }, { sizing: { w: "hug", h: "hug" } }));
    const others = g.layers.filter((l) => l.id !== "a");
    expect(flowSlot(g.layout!, others, { x: 26, y: 0, w: 10, h: 10 }).index).toBe(1);
    expect(flowSlot(g.layout!, others, { x: 26, y: 0, w: 10, h: 10 }).line).toEqual({ x1: 35, y1: 0, x2: 35, y2: 10 });
    expect(flowSlot(g.layout!, others, { x: 60, y: 0, w: 10, h: 10 }).index).toBe(2);
    const moved = flowInsert([{ ...g, layers: g.layers.map((l) => (l.id === "a" ? { ...l, x: 60 } : l)) }], "b", ["a"]);
    expect((moved[0] as GroupLayer).layers.map((l) => l.id)).toEqual(["b2", "c", "a"]);
  });

  it("a copy in another size lays its fill layers out again", () => {
    const g = box([rect("a", 1, 50, { sizing: { w: "fill" } }), rect("c", 1, 50, { sizing: { w: "fill" } })], { dir: "row", gap: 20 }, { w: 1000, h: 50, pin: { x: "both" } });
    const page = { id: "p", w: 1000, h: 500, background: "#ffffff", layers: layoutLayers([g], measure) };
    const copy = sizedCopy(page, { w: 500, h: 500 }, "q");
    const laid = layoutLayers(copy.layers, measure)[0] as GroupLayer;
    expect(laid.w).toBe(500);
    expect(laid.layers.map((l) => [l.x, l.w])).toEqual([[0, 240], [260, 240]]);
  });

  it("guesses words wider for wide letters and capitals", () => {
    expect(guessWidth('700 100px "Inter"', "MW")).toBeGreaterThan(guessWidth('700 100px "Inter"', "il"));
    expect(wordsSize(text("t", "Hello"), guessWidth).w).toBeGreaterThan(40);
  });
});
