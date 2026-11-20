import { describe, expect, it } from "vitest";
import type { GroupLayer, Layer, ShapeLayer, TextLayer } from "../../../contracts/design";
import { addAutoLayout, dropSlot, fixedBy, settledBoxes, forgetWords, flowInsert, flowSlot, guessWidth, layoutLayers, layoutPages, withSizing, withoutLayout, wordsSize } from "./layout";
import { mergeFrames } from "./hands";
import { fitContents } from "./resize";
import { sizedCopy } from "./resize";
import { everyLayer } from "./tree";

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
    const moved = flowInsert([{ ...g, layers: g.layers.map((l) => (l.id === "a" ? { ...l, x: 60 } : l)) }], "b", ["a"], measure);
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

  it("measures words once while they and their font's widths are the same", () => {
    let calls = 0;
    let wide = 0.5;
    const counted = (font: string, s: string) => (calls++, Number(/([\d.]+)px/.exec(font)![1]) * wide * Array.from(s).length);
    const pill = () => box([text("t", "Hello there")], { dir: "row", pad: 8 }, { sizing: { w: "hug", h: "hug" } });
    const a = layoutLayers([pill()], counted)[0] as GroupLayer;
    const first = calls;
    // a copy of the same words (new objects, as every edit makes) is not measured again
    expect(layoutLayers([pill()], counted)[0]).toEqual(a);
    expect(calls).toBe(first);
    // a font that arrived and draws them wider: measured again once the sizes are forgotten
    wide = 0.6;
    expect(layoutLayers([pill()], counted)[0]).toEqual(a);
    forgetWords();
    expect((layoutLayers([pill()], counted)[0] as GroupLayer).w).toBeGreaterThan(a.w);
    expect(calls).toBeGreaterThan(first);
  });

  it("places a dragged layer by the others as they are shown without it, not where they were", () => {
    // A B C, 100 wide each: A dragged, B shows at 0 and C at 100; let go with its middle at 110 it goes before C
    const g = one(box([rect("a", 100, 10), rect("b2", 100, 10), rect("c", 100, 10)], { dir: "row" }, { sizing: { w: "hug", h: "hug" } }));
    const at = dropSlot(g as Parameters<typeof dropSlot>[0], ["a"], { x: 60, y: 0, w: 100, h: 10 }, measure);
    expect([at.index, at.line.x1]).toEqual([1, 100]);
    const moved = flowInsert([{ ...g, layers: g.layers.map((l) => (l.id === "a" ? { ...l, x: 60 } : l)) }], "b", ["a"], measure);
    expect((moved[0] as GroupLayer).layers.map((l) => l.id)).toEqual(["b2", "a", "c"]);
  });

  it("takes fill and a place out of the flow from a layer that is in no flow (moved out, ungrouped, pasted)", () => {
    const loose = layoutLayers([rect("a", 10, 10, { sizing: { w: "fill", h: "fill" }, absolute: true }), { id: "g", type: "group", box: true, x: 0, y: 0, w: 50, h: 50, layers: [rect("b2", 10, 10, { sizing: { w: "fill" } })] }], measure);
    expect([loose[0]!.sizing, loose[0]!.absolute, (loose[1] as GroupLayer).layers[0]!.sizing]).toEqual([undefined, undefined, undefined]);
    // and a plain group never fills
    expect(withSizing({ id: "g", type: "group", x: 0, y: 0, w: 1, h: 1, layers: [rect("a", 1, 1)] }, "w", "fill", true).sizing).toBeUndefined();
  });

  it("moves only what lies out of the flow by its pin when an auto layout box is resized; the layout places the rest", () => {
    const g = one(box([rect("a", 100, 10, { pin: { x: "both" } }), rect("tag", 10, 10, { x: 390, absolute: true, pin: { x: "right" } })], { dir: "row" }, { w: 400, h: 10 }));
    const wider = one(fitContents(g, { ...g, w: 600 }));
    expect([wider.layers[0]!.w, wider.layers[1]!.x]).toEqual([100, 590]);
  });

  it("a copy in another size scales the layout's gaps, padding, least and most with it", () => {
    const g = box([text("t", "Hi", { max: { w: 600 } })], { dir: "row", gap: 10, pad: [14, 32, 14, 32] }, { x: 100, y: 100, w: 400, h: 100, sizing: { w: "hug", h: "hug" } });
    const copy = sizedCopy({ id: "p", w: 1080, h: 1080, background: "#ffffff", layers: [g] }, { w: 540, h: 540 }, "q").layers[0] as GroupLayer;
    expect([copy.layout, copy.layers[0]!.max]).toEqual([{ dir: "row", gap: 5, pad: [7, 16, 7, 16] }, { w: 300 }]);
  });

  it("a text held to a number of lines hugs the height of those lines", () => {
    const t = layoutLayers([text("t", "aaaa bbbb cccc dddd", { w: 45, lines: 2, sizing: { h: "hug" } })], measure)[0]!;
    expect(t.h).toBeLessThanOrEqual(46);
  });

  it("a fixed box past its own most settles in one pass, its layers fitted to the size it is held to", () => {
    const a = layoutLayers([box([rect("a", 10, 10, { sizing: { w: "fill" } })], { dir: "column" }, { w: 100, max: { w: 80 } })], measure);
    expect([(a[0] as GroupLayer).w, (a[0] as GroupLayer).layers[0]!.w]).toEqual([80, 80]);
    expect(layoutLayers(a, measure)).toBe(a);
  });

  it("lays a turned layer out by the upright box round it", () => {
    const g = one(box([rect("a", 300, 50, { rotate: 90 }), rect("b2", 10, 10)], { dir: "row", gap: 10 }, { sizing: { w: "hug", h: "hug" } }));
    // 50 along the row, 300 across: its middle at 25, 150
    expect([g.layers[0]!.x + 150, g.layers[0]!.y + 25, g.layers[1]!.x, g.w, g.h]).toEqual([25, 150, 60, 70, 300]);
  });

  it("an empty box with a gap below 0 is only its padding", () => {
    expect(one(box([], { dir: "row", gap: -20, pad: 5 }, { sizing: { w: "hug", h: "hug" } })).w).toBe(10);
  });

  it("frames laid out as the window lays them out: a second AI write to a frame is taken, not mistaken for this window's change", () => {
    const page = (word: string) => ({ id: "p", w: 500, h: 500, background: "#ffffff", layers: [box([text("t", word, { w: 10 })], { dir: "row", pad: 8 }, { sizing: { w: "hug", h: "hug" } })] });
    // the server's guess of the words' widths is not this window's
    const v1 = layoutPages([page("NEW")], guessWidth);
    const v2 = layoutPages([page("LIMITED OFFER")], guessWidth);
    const mine = layoutPages(v1, measure);
    expect(JSON.stringify(mergeFrames(mine, v1, v2))).toBe(JSON.stringify(mine));
    expect(mergeFrames(mine, layoutPages(v1, measure), layoutPages(v2, measure))[0]!.layers).toEqual(layoutPages(v2, measure)[0]!.layers);
  });

  describe("an AI's write: boxes laid out before at their size (settled) and new ones", () => {
    // a card hugging a title, its footer filling its width round wrapping words, a tag pinned to the footer's bottom
    const card = (title: string) =>
      box(
        [
          text("title", title),
          box([text("words", "bbbbbbbbbbbbbbbbb ccccccccccccccccc", { w: 300, h: 46, sizing: { w: "fill", h: "hug" } }), rect("tag", 10, 10, { x: 0, y: 36, absolute: true, pin: { y: "bottom" } })], { dir: "column" }, { id: "footer", w: 300, h: 46, sizing: { w: "fill", h: "hug" } }),
        ],
        { dir: "column" },
        { id: "card", w: 300, h: 69, sizing: { w: "hug", h: "hug" } },
      );
    const inside = (g: Layer, id: string): Layer => everyLayer([g]).find((l) => l.id === id)!;

    it("a saved box stretched by its parent and hugging less keeps its tag on its bottom", () => {
      const saved = layoutLayers([card("a".repeat(30))], measure);
      const footer = inside(saved[0]!, "footer");
      expect([footer.w, footer.h, inside(saved[0]!, "tag").y]).toEqual([300, 46, 36]);
      const settled = settledBoxes([{ id: "p", background: "#ffffff", layers: saved }]).get("p")!;
      // a longer title: the card 400 wide, the footer with it, its words on one line, 23 high
      const longer = layoutLayers([{ ...(saved[0] as GroupLayer), layers: (saved[0] as GroupLayer).layers.map((l) => (l.id === "title" ? { ...l, text: "a".repeat(40) } : l)) as Layer[] }], measure, undefined, settled);
      expect([inside(longer[0]!, "footer").w, inside(longer[0]!, "footer").h, inside(longer[0]!, "tag").y]).toEqual([400, 23, 13]);
    });

    it("a new box stretched by its parent keeps its layer out of the flow where it was given", () => {
      const footer = box([rect("dot", 10, 10, { x: 570, y: 0, absolute: true, pin: { x: "right" } })], { dir: "row" }, { id: "f", w: 10, h: 30, sizing: { w: "fill" } });
      const laid = layoutLayers([box([footer], { dir: "column" }, { id: "par", w: 590, h: 100 })], measure, undefined, new Map())[0]!;
      expect([inside(laid, "f").w, inside(laid, "dot").x]).toEqual([590, 570]);
    });

    it("a size given rounded to whole pixels is the size it was laid out at; a frame's boxes are its own", () => {
      const b = box([text("t", "a".repeat(20)), rect("dot", 4, 4, { x: 183.44, absolute: true, pin: { x: "right" } })], { dir: "row" }, { id: "b", w: 187.44, h: 23, sizing: { w: "hug" } });
      // the box hugs 200: the dot keeps its distance to the right edge
      expect(inside(layoutLayers([b], measure, undefined, new Map([["b", [{ w: 187, h: 23 }]]]))[0]!, "dot").x).toBe(196);
      expect(inside(layoutLayers([b], measure, undefined, new Map([["b", [{ w: 300, h: 23 }]]]))[0]!, "dot").x).toBe(183.44);
      const two = settledBoxes([{ id: "p1", background: "#ffffff", layers: [b] }, { id: "p2", background: "#ffffff", layers: [] }]);
      expect([[...two.get("p1")!], [...two.get("p2")!]]).toEqual([[["b", [{ w: 187.44, h: 23 }]]], []]);
    });

    it("a size within a pixel of the one laid out at is that size, either side of a half pixel", () => {
      const b = (w: number) => box([text("t", "a".repeat(20)), rect("dot", 4, 4, { x: w - 4, absolute: true, pin: { x: "right" } })], { dir: "row" }, { id: "b", w, h: 23, sizing: { w: "hug" } });
      const saved = new Map([["b", [{ w: 187.46, h: 23 }]]]);
      // given back as 187.5 (rounded the other way): still laid out at it, so the dot follows the right edge to 196
      expect(inside(layoutLayers([b(187.5)], measure, undefined, saved)[0]!, "dot").x).toBe(196);
      expect(inside(layoutLayers([b(187.46)], measure, undefined, saved)[0]!, "dot").x).toBe(196);
      // two pixels off: a new size, the dot stays where it is given
      expect(inside(layoutLayers([b(189.5)], measure, undefined, saved)[0]!, "dot").x).toBe(185.5);
    });
  });

  it("guesses words wider for wide letters and capitals", () => {
    expect(guessWidth('700 100px "Inter"', "MW")).toBeGreaterThan(guessWidth('700 100px "Inter"', "il"));
    expect(wordsSize(text("t", "Hello"), guessWidth).w).toBeGreaterThan(40);
  });
});
