import { Canvas, DOMMatrix } from "@napi-rs/canvas";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DesignPage, Layer } from "@contracts/design";
import { drawPage, type Loaded } from "./draw";
import { syncInstances } from "./components";
import { styled, unlinked, withStyle } from "./styles";

/**
 * drawPage on a real canvas, read back pixel by pixel: what a layer's fills, lines and effects come out as. The
 * canvas a layer is worked on for its effects is the same kind (as a browser's OffscreenCanvas).
 */
beforeAll(() => {
  vi.stubGlobal("OffscreenCanvas", Canvas);
  vi.stubGlobal("DOMMatrix", DOMMatrix);
});
afterAll(() => vi.unstubAllGlobals());

const W = 80;
const H = 60;
/** The page drawn on a W × H canvas: its pixels, and one pixel's RGBA. */
function draw(layers: Layer[], more: Partial<DesignPage> = {}, designing = false) {
  const canvas = new Canvas(W, H);
  const ctx = canvas.getContext("2d");
  const page = { id: "p", background: "#ffffff", layers, ...more } as DesignPage;
  drawPage(ctx as unknown as CanvasRenderingContext2D, page, W, H, new Map() as Loaded, true, designing);
  const data = ctx.getImageData(0, 0, W, H).data;
  return { data, at: (x: number, y: number) => Array.from(data.slice((y * W + x) * 4, (y * W + x) * 4 + 4)) };
}
const rect = (more: object = {}): Layer => ({ id: "r", type: "shape", shape: "rect", fill: "#ff0000", x: 10, y: 10, w: 30, h: 20, ...more }) as Layer;
const red = { type: "solid", color: "#ff0000" } as const;
const shadow = { type: "shadow", color: "#000000", opacity: 0.35, blur: 0, x: 30, y: 25 } as const;

describe("a layer drawn on a canvas", () => {
  it("throws one shadow however many fills it has, as strong as its strongest fill", () => {
    // on a see-through page, so the shadow's own alpha is read
    const page = { fills: [] } as Partial<DesignPage>;
    const one = draw([rect({ fills: [red], effects: [shadow] })], page);
    const two = draw([rect({ fills: [red, { type: "solid", color: "#0000ff" }], effects: [shadow] })], page);
    // (50, 45) is under the shadow only
    expect(one.at(50, 45)[3]).toBeGreaterThan(80);
    expect(two.at(50, 45)).toEqual(one.at(50, 45));
    // fills at half: the shadow at half too, not two halves laid over each other
    const half = draw([rect({ fills: [{ ...red, opacity: 0.5 }, { type: "solid", color: "#0000ff", opacity: 0.5 }], effects: [shadow] })], page);
    expect(Math.abs(half.at(50, 45)[3]! - one.at(50, 45)[3]! / 2)).toBeLessThanOrEqual(1);
    // the layer itself still shows both fills, the top one over the bottom one
    expect(two.at(20, 20)).toEqual([0, 0, 255, 255]);
  });

  it("throws one shadow for its fills and lines together, however many lines it has", () => {
    const page = { fills: [] } as Partial<DesignPage>;
    const line = { color: "#00ff00", width: 4 };
    const one = draw([rect({ fills: [red], strokes: [line], effects: [shadow] })], page);
    const two = draw([rect({ fills: [red], strokes: [line, { ...line, color: "#0000ff" }], effects: [shadow] })], page);
    // (40, 45) is under the shadow of the line along the layer's left edge, (55, 45) under its middle
    expect(two.at(40, 45)).toEqual(one.at(40, 45));
    expect(one.at(40, 45)).toEqual(one.at(55, 45));
    expect(one.at(55, 45)[3]).toBeGreaterThan(80);
    // the top line is drawn over the bottom one, on the layer itself
    expect(two.at(10, 20)).toEqual([0, 0, 255, 255]);
  });

  it("a line outside a layer's edge throws its shadow too, and is drawn whole on a layer worked for its effects", () => {
    const page = { fills: [] } as Partial<DesignPage>;
    const outside = { color: "#00ff00", width: 6, side: "outside" as const };
    // the line runs 4 to 10 and 40 to 46 across: its shadow falls 34 to 40 and 70 to 76
    const cast = draw([rect({ fills: [red], strokes: [outside], effects: [shadow] })], page);
    expect(cast.at(36, 45)[3]).toBeGreaterThan(80);
    expect(cast.at(73, 45)[3]).toBeGreaterThan(80);
    // grain on it: worked in a box of its own, with room for the line
    const worked = draw([rect({ fills: [red], strokes: [outside], effects: [{ type: "noise", amount: 1 }] })], page);
    expect(worked.at(7, 20)[1]).toBeGreaterThan(200);
    expect(worked.at(43, 20)[1]).toBeGreaterThan(200);
  });

  it("a blur, or a background blur, of 0 draws the layer as sharp as with none", () => {
    const plain = draw([rect()]);
    expect(draw([rect({ effects: [{ type: "blur", blur: 0 }] })]).data).toEqual(plain.data);
    expect(draw([rect({ effects: [{ type: "progressive-blur", blur: 0, from: 0, to: 1, angle: 90 }] })]).data).toEqual(plain.data);
    // a see-through panel over stripes: a background blur of 0 leaves the stripes as they are
    const stripes = Array.from({ length: 8 }, (_, k) => rect({ id: `s${k}`, x: k * 10, y: 0, w: 5, h: H, fill: "#000000" }));
    const glass = (blur: number) => ({ id: "g", type: "shape", shape: "rect", fill: "#ffffff", fills: [{ type: "solid", color: "#ffffff", opacity: 0.2 }], x: 10, y: 10, w: 60, h: 40, effects: [{ type: "background-blur", blur }] }) as Layer;
    const none = draw([...stripes, { ...glass(0), effects: [] } as Layer]);
    expect(draw([...stripes, glass(0)]).data).toEqual(none.data);
    // and a blur of 6 does blur them
    expect(draw([...stripes, glass(6)]).data).not.toEqual(none.data);
  });

  it("a line with only a width a side draws nothing round a text, a path or an ellipse (they have no sides)", () => {
    const sides = { color: "#00ff00", width: 0, sides: [0, 6, 0, 6] as [number, number, number, number] };
    const layers: Layer[] = [
      { id: "e", type: "shape", shape: "ellipse", fill: "#ff0000", x: 5, y: 5, w: 30, h: 20 } as Layer,
      { id: "p", type: "path", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], closed: false, x: 40, y: 5, w: 30, h: 20 } as Layer,
      { id: "t", type: "text", text: "Hop", font: "Inter", size: 24, weight: 700, color: "#ff0000", align: "left", x: 5, y: 30, w: 70, h: 28 } as Layer,
    ];
    const bare = draw(layers);
    // the text drew letters at all
    expect(bare.data.some((v, i) => i % 4 === 1 && v < 200)).toBe(true);
    const lined = draw(layers.map((l) => ({ ...l, strokes: [sides] }) as Layer));
    expect(lined.data).toEqual(bare.data);
    // on a box it is a bar along the sides that have one
    const box = draw([rect({ strokes: [sides] })]);
    expect(box.at(10, 20)).toEqual([0, 255, 0, 255]);
    expect(box.at(25, 10)).toEqual([255, 0, 0, 255]);
  });

  it("smooth corners start their curve further along the sides and keep within the box", () => {
    const filled = (smooth: number) => {
      const { data } = draw([rect({ x: 0, y: 0, w: W, h: H, radius: 20, smooth })]);
      // red pixels in the top left 30 × 30
      let n = 0;
      for (let y = 0; y < 30; y++) for (let x = 0; x < 30; x++) if (data[(y * W + x) * 4 + 1]! < 128) n++;
      return { n, corner: data[1], side: data[(0 * W + 40) * 4 + 1], edge: data[(21 * W + 0) * 4 + 1] };
    };
    const round = filled(0);
    const smooth = filled(1);
    // the corner itself empty and the middle of the sides full either way
    expect([round.corner, smooth.corner]).toEqual([255, 255]);
    expect([round.side, smooth.side]).toEqual([0, 0]);
    // smooth: 21 down the left side is still curving in; a plain corner of 20 has met the side by then
    expect(round.edge).toBe(0);
    expect(smooth.edge).toBeGreaterThan(0);
    expect(smooth.n).toBeLessThan(round.n);
  });

  it("draws a layer's shadow under it, then what a background blur shows, then the layer worked for its effects", () => {
    // stripes, and over them a see-through red panel with a shadow, a background blur and grain
    const stripes = Array.from({ length: 8 }, (_, k) => rect({ id: `s${k}`, x: k * 10, y: 0, w: 5, h: H, fill: "#000000" }));
    const panel = { id: "g", type: "shape", shape: "rect", fill: "#ff0000", fills: [{ type: "solid", color: "#ff0000", opacity: 0.3 }], x: 10, y: 10, w: 40, h: 30, effects: [{ ...shadow, opacity: 1, x: 20, y: 10 }, { type: "background-blur", blur: 8 }, { type: "noise", amount: 1 }] } as Layer;
    const { at } = draw([...stripes, panel]);
    const grey = (x: number, y: number) => at(x, y)[0]!;
    // under the panel the stripes are blurred into greys (the shadow under it is blurred in with them, so they are dark)
    const inside = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20].map((x) => grey(x, 15));
    expect(Math.max(...inside) - Math.min(...inside)).toBeLessThan(120);
    // the panel's own tint lies over that
    expect([11, 15, 19].every((x) => at(x, 15)[0]! > at(x, 15)[1]! + 20)).toBe(true);
    // outside the panel the stripes are sharp; where only the shadow falls, as dark as the panel's fill is strong (0.3)
    expect([grey(1, 5), grey(6, 5)]).toEqual([0, 255]);
    expect(Math.abs(grey(66, 45) - 255 * 0.7)).toBeLessThanOrEqual(2);
  });

  it("a diamond gradient is darkest in the middle and lightest at the corners, the same in all four quarters", () => {
    const { at } = draw([rect({ x: 0, y: 0, w: W, h: H, fills: [{ type: "gradient", kind: "diamond", angle: 0, stops: [{ at: 0, color: "#000000" }, { at: 1, color: "#ffffff" }] }] })]);
    const v = (x: number, y: number) => at(x, y)[0]!;
    expect(v(40, 30)).toBeLessThan(20);
    expect(v(1, 1)).toBeGreaterThan(230);
    expect([v(W - 2, 1), v(1, H - 2), v(W - 2, H - 2)].every((n) => Math.abs(n - v(1, 1)) <= 3)).toBe(true);
    // halfway along each side: between the middle and a corner, and alike on opposite sides
    expect(v(40, 1)).toBeGreaterThan(v(40, 30));
    expect(v(40, 1)).toBeLessThan(v(1, 1));
    expect(Math.abs(v(40, 1) - v(40, H - 2))).toBeLessThanOrEqual(3);
    expect(Math.abs(v(1, 30) - v(W - 2, 30))).toBeLessThanOrEqual(3);
  });
});

describe("what only the designer's canvas shows", () => {
  it("a reference layer is drawn while designing and in no picture made of the page (an export, a thumbnail, the AI's look)", () => {
    const ref = rect({ id: "ref", reference: true });
    expect(draw([ref], {}, true).at(20, 20)).toEqual([255, 0, 0, 255]);
    // every caller but the canvas draws with the default: an export, a thumbnail, pagePicture
    expect(draw([ref]).at(20, 20)).toEqual([255, 255, 255, 255]);
    // the layers over it are drawn as ever
    expect(draw([ref, rect({ id: "b", fill: "#0000ff", x: 15, y: 15, w: 5, h: 5 })]).at(17, 17)).toEqual([0, 0, 255, 255]);
  });

  it("a frame with no fill is see-through: only its layers have colour", () => {
    const { at } = draw([rect()], { fills: [] });
    expect(at(2, 2)[3]).toBe(0);
    expect(at(20, 20)).toEqual([255, 0, 0, 255]);
  });
});

describe("a container drawn on a canvas", () => {
  const blue = (more: object = {}): Layer => ({ id: "b", type: "shape", shape: "rect", fill: "#0000ff", x: 10, y: 0, w: 20, h: 20, ...more }) as Layer;
  const holder = (layers: Layer[], more: object = {}): Layer => ({ id: "g", type: "group", x: 10, y: 10, w: 30, h: 20, layers, ...more }) as Layer;

  it("cuts its layers at its edges when it clips them, and shows them past it when it does not", () => {
    // a red bar in the box's own pixels, running 30 pixels past its right edge (40 on the page)
    const bar = rect({ x: 0, y: 0, w: 60, h: 20 });
    expect(draw([holder([bar], { box: true, clip: true })]).at(55, 15)).toEqual([255, 255, 255, 255]);
    expect(draw([holder([bar], { box: true, clip: true })]).at(20, 15)).toEqual([255, 0, 0, 255]);
    expect(draw([holder([bar], { box: true })]).at(55, 15)).toEqual([255, 0, 0, 255]);
    // its fill under its layers, its lines over them
    const boxed = draw([holder([rect({ x: 10, y: 5, w: 5, h: 5 })], { box: true, fills: [{ type: "solid", color: "#00ff00" }] })]);
    expect(boxed.at(12, 12)).toEqual([0, 255, 0, 255]);
    expect(boxed.at(22, 17)).toEqual([255, 0, 0, 255]);
  });

  it("fades its layers once, as one: where they overlap, the one under does not show through", () => {
    // red under blue, overlapping from x 20 to 30 on the page
    const faded = draw([holder([rect({ x: 0, y: 0, w: 20, h: 20 }), blue()], { opacity: 0.5 })]);
    const [r, g, b] = faded.at(25, 15);
    expect(r).toBeGreaterThan(120);
    expect(r).toBeLessThan(135);
    expect(Math.abs(r! - g!)).toBeLessThanOrEqual(2);
    expect(b).toBe(255);
    // each layer alone at half would let the red through under the blue
    const each = draw([holder([rect({ x: 0, y: 0, w: 20, h: 20, opacity: 0.5 }), blue({ opacity: 0.5 })])]);
    expect(each.at(25, 15)[1]).toBeLessThan(g! - 20);
  });

  it("throws one shadow from all its layers together: as strong where they overlap as where one lies alone", () => {
    const shade = { type: "shadow", color: "#000000", opacity: 0.5, blur: 0, x: 0, y: 25 } as const;
    // red at 10 to 30 on the page, blue at 20 to 40; their shadow 25 lower, read on a see-through page
    const d = draw([holder([rect({ x: 0, y: 0, w: 20, h: 20 }), blue()], { effects: [shade] })], { fills: [] });
    expect(d.at(25, 45)[3]).toBeGreaterThan(100);
    expect(Math.abs(d.at(25, 45)[3]! - d.at(15, 45)[3]!)).toBeLessThanOrEqual(2);
  });

  it("works a faded container on the canvas at the canvas's own detail, never at a saved file's", () => {
    const made: number[] = [];
    vi.stubGlobal(
      "OffscreenCanvas",
      class extends Canvas {
        constructor(w: number, h: number) {
          super(w, h);
          made.push(w * h);
        }
      },
    );
    const canvas = new Canvas(W, H);
    const ctx = canvas.getContext("2d");
    // zoomed in three times on a big faded card: its own picture would be 2400 pixels a side
    ctx.scale(3, 3);
    drawPage(ctx as unknown as CanvasRenderingContext2D, { id: "z", background: "#ffffff", layers: [holder([rect({ x: 0, y: 0, w: 800, h: 800 })], { w: 800, h: 800, opacity: 0.5 })] } as DesignPage, W, H, new Map() as Loaded, false);
    vi.stubGlobal("OffscreenCanvas", Canvas);
    expect(made.length).toBeGreaterThan(0);
    expect(Math.max(...made)).toBeLessThanOrEqual(3_000_000 * 1.01);
  });

  it("turns and moves its layers with it, and leaves out a hidden or reference layer of its own where a frame does", () => {
    const turned = draw([holder([rect({ x: 0, y: 0, w: 10, h: 20 })], { rotate: 180 })]);
    // turned half round its middle (25, 20): the bar at its left is at its right now
    expect(turned.at(35, 15)).toEqual([255, 0, 0, 255]);
    expect(turned.at(15, 15)).toEqual([255, 255, 255, 255]);
    const kept = [rect({ x: 0, y: 0, w: 10, h: 20, reference: true }), rect({ id: "h", x: 20, y: 0, w: 10, h: 20, hidden: true })];
    expect(draw([holder(kept)]).at(15, 15)).toEqual([255, 255, 255, 255]);
    expect(draw([holder(kept)], {}, true).at(15, 15)).toEqual([255, 0, 0, 255]);
    expect(draw([holder(kept)], {}, true).at(35, 15)).toEqual([255, 255, 255, 255]);
  });

  it("draws an instance as its main, pixel for pixel, and with its own words where it overrides them", () => {
    const words = { id: "t", type: "text", text: "W", font: "Inter", size: 30, color: "#ffffff", align: "center", x: 0, y: 0, w: 60, h: 40, bind: { text: "Label" } } as Layer;
    const main = { id: "m", type: "group", box: true, component: "chip", x: 10, y: 10, w: 60, h: 40, fills: [{ type: "solid", color: "#2255ff" }], layers: [words] } as Layer;
    const made = (props?: Record<string, string>) => syncInstances([{ id: "a", background: "#ffffff", layers: [{ ...main, x: -500 }] }, { id: "b", background: "#ffffff", layers: [{ id: "i", type: "group", x: 10, y: 10, w: 1, h: 1, layers: [], instance: { of: "chip", ...(props ? { props } : {}) } } as Layer] }] as DesignPage[])[1]!.layers;
    const asMain = draw([main]);
    const plain = draw(made());
    expect(Buffer.from(plain.data).equals(Buffer.from(asMain.data))).toBe(true);
    const other = draw(made({ Label: "." }));
    // the box is the main's, the words are its own
    expect(other.at(12, 12)).toEqual(asMain.at(12, 12));
    expect(Buffer.from(other.data).equals(Buffer.from(asMain.data))).toBe(false);
  });
});

describe("styles drawn", () => {
  it("changing Accent recolours both slides that name it, and only what names it", () => {
    const styles = { colors: { accent: { name: "Accent", color: "#ff0000" } } };
    const pages = styled([{ id: "p1", background: "#ffffff", layers: [rect({ colorStyle: "accent" })] }, { id: "p2", background: "#ffffff", colorStyle: "accent", layers: [rect({ fill: "#00ff00" })] }] as DesignPage[], styles);
    const shown = (ps: DesignPage[]) => ps.map((p) => {
      const { layers, ...more } = p;
      const d = draw(layers, more);
      return [d.at(20, 20), d.at(70, 50)];
    });
    expect(shown(pages)).toEqual([[[255, 0, 0, 255], [255, 255, 255, 255]], [[0, 255, 0, 255], [255, 0, 0, 255]]]);
    const next = withStyle(styles, "colors", "accent", { name: "Accent", color: "#0000ff" });
    expect(shown(styled(unlinked(pages, pages, next), next))).toEqual([[[0, 0, 255, 255], [255, 255, 255, 255]], [[0, 255, 0, 255], [0, 0, 255, 255]]]);
  });
});
