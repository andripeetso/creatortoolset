import { describe, expect, it, vi } from "vitest";
import type { Layer } from "@contracts/design";
import { blurPixels } from "./retouch";
import { addNoise, effectsOf, fullAlpha, innerShadow, progressiveBlur, reachOf, spreadAlpha, withEffects, worksPixels } from "./effects";

const shape = (more: object = {}): Layer => ({ id: "a", type: "shape", shape: "rect", fill: "#000000", x: 0, y: 0, w: 10, h: 10, ...more }) as Layer;
/** A w × h picture, every pixel `rgba` (or what `at` gives it). */
const pixels = (w: number, h: number, at: (x: number, y: number) => [number, number, number, number]) => {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(at(x, y), (y * w + x) * 4);
  return d;
};
const alphas = (d: Uint8ClampedArray, w: number) => Array.from({ length: d.length / 4 / w }, (_, y) => Array.from({ length: w }, (_, x) => d[(y * w + x) * 4 + 3]));

describe("a layer's effects", () => {
  it("reads the old shadow and blur as a list, until the layer has one of its own; a picture's blur stays one of its colour changes", () => {
    const old = shape({ shadow: { color: "#000000", opacity: 0.5, blur: 10, x: 0, y: 4 }, blur: 6 });
    expect(effectsOf(old)).toEqual([{ type: "shadow", color: "#000000", opacity: 0.5, blur: 10, x: 0, y: 4 }, { type: "blur", blur: 6 }]);
    expect(effectsOf({ ...old, type: "image", picture: "p", fit: "cover" } as Layer)).toEqual([effectsOf(old)[0]]);
    expect(effectsOf(shape({ effects: [{ type: "noise", amount: 5 }], blur: 6 }))).toEqual([{ type: "noise", amount: 5 }]);
    const set = withEffects(old, [{ type: "blur", blur: 2 }]);
    expect(set).toMatchObject({ effects: [{ type: "blur", blur: 2 }], shadow: undefined, blur: undefined });
    expect(withEffects(old, []).effects).toBeUndefined();
    expect(withEffects({ ...old, type: "image", picture: "p", fit: "cover" } as Layer, []).blur).toBe(6);
  });

  it("works a layer pixel by pixel only for what a canvas cannot draw itself, with room for what its blur spreads", () => {
    expect(worksPixels([{ type: "shadow", color: "#000000", opacity: 1, blur: 4, x: 0, y: 0 }, { type: "background-blur", blur: 9 }])).toBe(false);
    expect(worksPixels([{ type: "noise", amount: 4 }])).toBe(true);
    expect(reachOf([{ type: "blur", blur: 10 }, { type: "progressive-blur", blur: 90, from: 0, to: 1, angle: 90 }])).toBe(30);
    expect(reachOf([])).toBe(0);
  });

  it("grows and shrinks a shape by its spread, square, whatever the spread", () => {
    const dot = pixels(7, 7, (x, y) => [0, 0, 0, x === 3 && y === 3 ? 255 : 0]);
    spreadAlpha(dot, 7, 7, 1);
    expect(alphas(dot, 7)[2]).toEqual([0, 0, 255, 255, 255, 0, 0]);
    expect(alphas(dot, 7).flat().filter(Boolean)).toHaveLength(9);
    spreadAlpha(dot, 7, 7, -1);
    expect(alphas(dot, 7).flat().filter(Boolean)).toHaveLength(1);
    // past the edges counts as see-through: a full picture shrinks from its sides
    const full = pixels(5, 5, () => [0, 0, 0, 255]);
    spreadAlpha(full, 5, 5, -2);
    expect(alphas(full, 5).flat().filter(Boolean)).toHaveLength(1);
    // a wide spread on a big picture costs no more than a narrow one (blocks, not a search of the square)
    const big = pixels(600, 600, (x, y) => [0, 0, 0, x === 300 && y === 300 ? 255 : 0]);
    const t = performance.now();
    spreadAlpha(big, 600, 600, 150);
    expect(performance.now() - t).toBeLessThan(500);
    expect(alphas(big, 600)[150]![150]).toBe(255);
    expect(alphas(big, 600)[149]![150]).toBe(0);
  });

  it("lays an inner shadow inside the shape only, from the side it falls from, and leaves its alpha as it was", () => {
    // a white square of 6 in a see-through 10 × 10, the shadow falling 2 down with no blur
    const sq = pixels(10, 10, (x, y) => (x >= 2 && x < 8 && y >= 2 && y < 8 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
    const before = alphas(sq, 10);
    innerShadow(sq, 10, 10, { color: "#ff0000", opacity: 1, blur: 0 }, 0, 2);
    expect(alphas(sq, 10)).toEqual(before);
    const px = (x: number, y: number) => Array.from(sq.slice((y * 10 + x) * 4, (y * 10 + x) * 4 + 4));
    // its top two rows in the shadow's colour, below them as it was; outside it, nothing
    expect([px(4, 2), px(4, 3), px(4, 4), px(4, 7)]).toEqual([[255, 0, 0, 255], [255, 0, 0, 255], [255, 255, 255, 255], [255, 255, 255, 255]]);
    expect(px(0, 0)).toEqual([0, 0, 0, 0]);
    // a spread grows it in: a third row
    const grown = pixels(10, 10, (x, y) => (x >= 2 && x < 8 && y >= 2 && y < 8 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
    innerShadow(grown, 10, 10, { color: "#ff0000", opacity: 0.5, blur: 0, spread: 1 }, 0, 2);
    expect(Array.from(grown.slice((4 * 10 + 4) * 4, (4 * 10 + 4) * 4 + 3))).toEqual([255, 128, 128]);
  });

  it("lays grain on the layer only, the same grains wherever the layer is drawn", () => {
    const at = (x: number, _y: number): [number, number, number, number] => [128, 128, 128, x < 6 ? 255 : 0];
    const a = pixels(8, 4, at);
    addNoise(a, 8, 4, 50, 1, 0, 0);
    expect(alphas(a, 8)).toEqual(alphas(pixels(8, 4, at), 8));
    expect(a[(0 * 8 + 7) * 4]).toBe(128);
    const grains = new Set(Array.from({ length: 6 }, (_, x) => a[x * 4]));
    expect(grains.size).toBeGreaterThan(2);
    // the same picture two pixels further right, with its box two further right: the same grains on it
    const b = pixels(10, 4, (x, y) => at(x - 2, y));
    addNoise(b, 10, 4, 50, 1, 2, 0);
    expect(Array.from({ length: 6 }, (_, x) => b[(x + 2) * 4])).toEqual(Array.from({ length: 6 }, (_, x) => a[x * 4]));
    // grains 2 across: neighbours in pairs
    const c = pixels(8, 1, () => [128, 128, 128, 255]);
    addNoise(c, 8, 1, 80, 2, 0, 0);
    expect([c[0], c[8], c[16]]).toEqual([c[4], c[12], c[20]]);
  });

  it("blurs a layer more and more along its box, sharp before `from`, keeping its edges", () => {
    // stripes four pixels high, black and white, 20 × 80
    const at = (_x: number, y: number): [number, number, number, number] => (Math.floor(y / 4) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]);
    const d = pixels(20, 80, at);
    progressiveBlur(d, 20, 80, { blur: 8, from: 0.5, to: 1, angle: 90 }, { x: 0, y: 0, w: 20, h: 80 });
    const row = (y: number) => d[(y * 20 + 10) * 4]!;
    /** How far apart the darkest and the lightest are in 8 rows from y. */
    const range = (y: number) => {
      const v = Array.from({ length: 8 }, (_, k) => row(y + k));
      return Math.max(...v) - Math.min(...v);
    };
    // the top half as it was; the stripes run together further down, and most at the bottom
    expect([row(8), row(12), range(16)]).toEqual([0, 255, 255]);
    expect(range(46)).toBeLessThan(255);
    expect(range(70)).toBeLessThan(range(46) / 2);
    expect(alphas(d, 20).flat().every((a) => a === 255)).toBe(true);
  });

  it("a progressive blur keeps no full-size copy of a layer when it is wide, and comes out as each level blurred whole would", () => {
    // a white disc on see-through, 120 × 90, blurred up to 40: every level is worked on a smaller copy
    const at = (x: number, y: number): [number, number, number, number] => (Math.hypot(x - 60, y - 45) < 30 ? [250, 240, 10, 255] : [0, 0, 0, 0]);
    const e = { blur: 40, from: 0.2, to: 0.9, angle: 30 };
    const box = { x: 10, y: 5, w: 100, h: 80 };
    const d = pixels(120, 90, at);
    const copies = vi.spyOn(d, "slice");
    progressiveBlur(d, 120, 90, e, box);
    expect(copies).not.toHaveBeenCalled();
    // the same as every level blurred whole and each pixel taken between the two nearest
    const src = pixels(120, 90, at);
    const levels = [src.slice(), ...[0.25, 0.5, 1].map((f) => {
      const c = src.slice();
      blurPixels(c, 120, 90, e.blur * f);
      return c;
    })];
    const want = src.slice();
    const a = (e.angle * Math.PI) / 180;
    const half = (Math.abs(Math.cos(a)) * box.w + Math.abs(Math.sin(a)) * box.h) / 2;
    for (let y = 0; y < 90; y++)
      for (let x = 0; x < 120; x++) {
        const along = ((x + 0.5 - 60) * Math.cos(a) + (y + 0.5 - 45) * Math.sin(a)) / (2 * half) + 0.5;
        const t = Math.min(1, Math.max(0, (along - e.from) / (e.to - e.from)));
        if (!t) continue;
        const lo = Math.min(2, Math.floor(t * 3));
        const f = t * 3 - lo;
        const i = (y * 120 + x) * 4;
        for (let c = 0; c < 3; c++) want[i + c] = levels[lo]![i + c]! + (levels[lo + 1]![i + c]! - levels[lo]![i + c]!) * f;
      }
    expect(Array.from(d)).toEqual(Array.from(want));
  });

  it("a blur of 0 is no blur: the layer is not worked for it, and a progressive blur of 0 leaves it as it was", () => {
    expect(worksPixels([{ type: "blur", blur: 0 }])).toBe(false);
    expect(worksPixels([{ type: "progressive-blur", blur: 0, from: 0, to: 1, angle: 90 }])).toBe(false);
    expect(worksPixels([{ type: "blur", blur: 0 }, { type: "noise", amount: 4 }])).toBe(true);
    const at = (x: number): [number, number, number, number] => [x % 2 ? 255 : 0, 0, 0, 255];
    const d = pixels(6, 6, at);
    progressiveBlur(d, 6, 6, { blur: 0, from: 0, to: 1, angle: 0 }, { x: 0, y: 0, w: 6, h: 6 });
    expect(Array.from(d)).toEqual(Array.from(pixels(6, 6, at)));
  });

  it("makes a see-through mask whole, its soft edges in proportion", () => {
    const m = new Uint8ClampedArray([0, 0, 0, 51, 0, 0, 0, 25, 0, 0, 0, 0]);
    fullAlpha(m);
    expect([m[3], m[7], m[11]]).toEqual([255, 125, 0]);
  });
});
