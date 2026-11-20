import { Canvas, DOMMatrix } from "@napi-rs/canvas";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DesignPage, Layer } from "@contracts/design";
import { drawPage, type Loaded } from "./draw";
import { maskedIn } from "@/components/design/LayersPanel";

/** Combined shapes and masks drawn on a real canvas and read back pixel by pixel (the sheets they are made on are the same kind). */
beforeAll(() => {
  vi.stubGlobal("OffscreenCanvas", Canvas);
  vi.stubGlobal("DOMMatrix", DOMMatrix);
});
afterAll(() => vi.unstubAllGlobals());

const W = 80;
const H = 60;
/** A picture of the design: all blue. */
const photo = () => {
  const c = new Canvas(40, 40);
  const g = c.getContext("2d");
  g.fillStyle = "#0000ff";
  g.fillRect(0, 0, 40, 40);
  return c;
};
function draw(layers: Layer[], more: Partial<DesignPage> = {}, scale = 1) {
  const canvas = new Canvas(W * scale, H * scale);
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  const loaded = new Map([["pic", photo()]]) as unknown as Loaded;
  drawPage(ctx as unknown as CanvasRenderingContext2D, { id: "p", background: "#ffffff", layers, ...more } as DesignPage, W, H, loaded, true);
  const data = ctx.getImageData(0, 0, W * scale, H * scale).data;
  return { data, at: (x: number, y: number) => Array.from(data.slice((y * scale * W * scale + x * scale) * 4, (y * scale * W * scale + x * scale) * 4 + 4)) };
}
const circle = (id: string, x: number, y: number, d: number, more: object = {}): Layer => ({ id, type: "shape", shape: "ellipse", fill: "#00ff00", x, y, w: d, h: d, ...more }) as Layer;
const red = { type: "solid", color: "#ff0000" } as const;
const combined = (boolean: string, layers: Layer[], more: object = {}): Layer => ({ id: "g", type: "group", boolean, x: 0, y: 0, w: W, h: H, fills: [red], layers, ...more }) as Layer;
const WHITE = [255, 255, 255, 255];
const RED = [255, 0, 0, 255];
const BLUE = [0, 0, 255, 255];

describe("combined shapes", () => {
  // a disc 40 across at (10, 10), and one 20 across in its middle
  const big = circle("a", 10, 10, 40);
  const small = circle("b", 20, 20, 20);

  it("a subtract ring has a hole, in the group's own fill (its layers' own colours are not drawn)", () => {
    const ring = draw([combined("subtract", [big, small])]);
    expect(ring.at(30, 30)).toEqual(WHITE);
    expect(ring.at(14, 30)).toEqual(RED);
    expect(ring.at(5, 30)).toEqual(WHITE);
    // at twice the pixels it is as sharp: the hole's middle still bare, the ring still red
    const fine = draw([combined("subtract", [big, small])], {}, 2);
    expect([fine.at(30, 30), fine.at(14, 30)]).toEqual([WHITE, RED]);
  });

  it("union, intersect and exclude keep all, the overlap and what is not overlapped", () => {
    const left = circle("a", 5, 10, 40);
    const right = circle("b", 35, 10, 40);
    const at = (op: string) => {
      const d = draw([combined(op, [left, right])]);
      // only the left disc, the overlap, only the right disc
      return [d.at(12, 30), d.at(40, 30), d.at(68, 30)];
    };
    expect(at("union")).toEqual([RED, RED, RED]);
    expect(at("intersect")).toEqual([WHITE, RED, WHITE]);
    expect(at("exclude")).toEqual([RED, WHITE, RED]);
  });

  it("leaves out its hidden layers, and lines the combined shape, not each layer", () => {
    expect(draw([combined("subtract", [big, { ...small, hidden: true }])]).at(30, 30)).toEqual(RED);
    const lined = draw([combined("subtract", [big, small], { strokes: [{ color: "#0000ff", width: 4 }] })]);
    // on the hole's edge (r 10 from the middle) and on the outer edge (r 20); none across the ring's middle
    expect(lined.at(30, 20)).toEqual(BLUE);
    expect(lined.at(30, 10)).toEqual(BLUE);
    expect(lined.at(30, 15)).toEqual(RED);
  });
});

describe("masks", () => {
  const pic = (more: object = {}): Layer => ({ id: "pic", type: "image", picture: "pic", fit: "cover", x: 0, y: 0, w: W, h: H, ...more }) as Layer;
  const blob = (more: object = {}): Layer => circle("m", 20, 10, 40, { mask: "alpha", ...more });

  it("shows the layers above a mask only where it is, and is not drawn itself", () => {
    const d = draw([blob(), pic()]);
    expect(d.at(40, 30)).toEqual(BLUE);
    expect(d.at(5, 5)).toEqual(WHITE);
    // a layer under the mask is not cut
    const under = draw([circle("u", 0, 0, 20, { fill: "#ff0000" }), blob(), pic()]);
    expect(under.at(5, 10)).toEqual(RED);
  });

  it("a text mask cuts a photo to its letters", () => {
    const words = { id: "t", type: "text", text: "HOP", font: "Inter", size: 40, weight: 900, color: "#000000", align: "left", x: 2, y: 5, w: 76, h: 50 } as Layer;
    const letters = draw([words], { fills: [] });
    const cut = draw([{ ...words, mask: "alpha" } as Layer, pic()]);
    let inked = 0;
    for (let i = 0; i < letters.data.length; i += 4) {
      const a = letters.data[i + 3]!;
      if (a === 255) inked++;
      // the photo as solid as the letter is there, over the white page (no letter: the page)
      expect(Math.abs(cut.data[i]! - (255 - a))).toBeLessThanOrEqual(3);
      expect(cut.data[i + 2]).toBe(255);
    }
    expect(inked).toBeGreaterThan(100);
  });

  it("alpha, shape and luminance: how solid it is, its shape whatever its fill, how light it is", () => {
    const black = { fill: "#000000" };
    const faint = { fill: "#ffffff80" };
    // a black mask: whole by its alpha, nothing by its light
    expect(draw([blob({ ...black, mask: "alpha" }), pic()]).at(40, 30)).toEqual(BLUE);
    expect(draw([blob({ ...black, mask: "luminance" }), pic()]).at(40, 30)).toEqual(WHITE);
    // a white mask at half: half by its alpha and its light, whole by its shape
    const half = draw([blob({ ...faint, mask: "alpha" }), pic()]).at(40, 30);
    expect(half[0]).toBeGreaterThan(110);
    expect(half[0]).toBeLessThan(145);
    expect(draw([blob({ ...faint, mask: "luminance" }), pic()]).at(40, 30)[0]).toBeCloseTo(half[0]!, -1);
    expect(draw([blob({ ...faint, mask: "vector" }), pic()]).at(40, 30)).toEqual(BLUE);
  });

  it("a hidden mask masks nothing; the next mask starts its own run; a mask in a box cuts only that box's layers", () => {
    expect(draw([blob({ hidden: true }), pic()]).at(5, 5)).toEqual(BLUE);
    // the second mask (the left strip) takes over from the first for the layers above it
    const strip = { id: "s", type: "shape", shape: "rect", fill: "#000000", x: 0, y: 0, w: 10, h: H, mask: "alpha" } as Layer;
    const two = draw([blob(), pic({ id: "p1", w: 1, h: 1 }), strip, pic({ id: "p2" })]);
    expect([two.at(5, 30), two.at(40, 30)]).toEqual([BLUE, WHITE]);
    const box = { id: "bx", type: "group", box: true, x: 0, y: 0, w: W, h: H, layers: [blob(), pic()] } as Layer;
    const outside = draw([box, circle("o", 0, 0, 12, { fill: "#ff0000" })]);
    expect([outside.at(40, 30), outside.at(5, 5), outside.at(70, 5)]).toEqual([BLUE, RED, WHITE]);
  });
});

describe("the layers list", () => {
  it("sits in the layers a shown mask cuts, up to the next mask, none in a boolean group", () => {
    const l = (id: string, more: object = {}) => ({ id, type: "shape", shape: "rect", fill: "#000000", x: 0, y: 0, w: 1, h: 1, ...more }) as Layer;
    const list = [l("under"), l("m1", { mask: "alpha" }), l("a"), l("b"), l("m2", { mask: "vector", hidden: true }), l("c")];
    expect([...maskedIn(list)]).toEqual(["a", "b"]);
    expect([...maskedIn(list, true)]).toEqual([]);
  });
});
