import { describe, expect, it } from "vitest";
import { blurPixels, channelTables, retouch, retouches } from "./retouch";

/** `w` × `h` pixels of one colour. */
const flat = (w: number, h: number, rgba: [number, number, number, number]) => {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < d.length; i += 4) d.set(rgba, i);
  return d;
};
const at = (d: Uint8ClampedArray, w: number, x: number, y: number) => [...d.slice((y * w + x) * 4, (y * w + x) * 4 + 4)];

describe("a picture layer's colour changes", () => {
  it("leaves a picture alone when nothing is set, and says so, so it is drawn straight from the picture", () => {
    expect(retouches({})).toBe(false);
    expect(retouches({ adjust: { exposure: 0, contrast: 0 } })).toBe(false);
    expect(retouches({ adjust: { warmth: 5 } })).toBe(true);
    expect(retouches({ grain: 10 })).toBe(true);
    const [r, g, b] = channelTables({});
    for (const t of [r, g, b]) expect([t[0], t[64], t[128], t[255]]).toEqual([0, 64, 128, 255]);
  });

  it("exposure brightens or darkens and keeps black; contrast pulls the tones apart and keeps black, mid-grey and white", () => {
    const [up] = channelTables({ exposure: 50 });
    const [down] = channelTables({ exposure: -50 });
    expect(up[0]).toBe(0);
    expect(up[100]!).toBeGreaterThan(130);
    expect(down[100]!).toBeLessThan(75);
    const [more] = channelTables({ contrast: 60 });
    const [less] = channelTables({ contrast: -60 });
    expect([more[0], more[255], less[0], less[255]]).toEqual([0, 255, 0, 255]);
    expect(Math.abs(more[128]! - 128)).toBeLessThanOrEqual(1);
    expect(more[64]!).toBeLessThan(64);
    expect(more[192]!).toBeGreaterThan(192);
    expect(less[64]!).toBeGreaterThan(64);
    expect(less[192]!).toBeLessThan(192);
  });

  it("warmth moves red up and blue down (tint: green down), about as bright as before; shadows and highlights move their own end", () => {
    const [r, g, b] = channelTables({ warmth: 60 });
    expect(r[128]!).toBeGreaterThan(g[128]!);
    expect(g[128]!).toBeGreaterThan(b[128]!);
    const grey = (t: [Uint8Array, Uint8Array, Uint8Array]) => 0.2126 * t[0][128]! + 0.7152 * t[1][128]! + 0.0722 * t[2][128]!;
    expect(Math.abs(grey([r, g, b]) - 128)).toBeLessThan(6);
    const [, tinted] = channelTables({ tint: 60 });
    expect(tinted[128]!).toBeLessThan(128);
    const [lifted] = channelTables({ shadows: 80 });
    expect(lifted[40]!).toBeGreaterThan(50);
    expect(Math.abs(lifted[230]! - 230)).toBeLessThanOrEqual(2);
    const [held] = channelTables({ highlights: -80 });
    expect(held[215]!).toBeLessThan(205);
    expect(Math.abs(held[30]! - 30)).toBeLessThanOrEqual(2);
  });

  it("saturation moves a colour to or from its grey; two colours put the darks on one and the lights on the other; a see-through pixel is not touched", () => {
    const d = flat(2, 1, [200, 100, 50, 255]);
    retouch(d, 2, 1, 1, { adjust: { saturation: -100 } });
    const [r, g, b] = at(d, 2, 0, 0);
    expect(r).toBe(g);
    expect(g).toBe(b);
    const vivid = flat(1, 1, [200, 100, 50, 255]);
    retouch(vivid, 1, 1, 1, { adjust: { saturation: 50 } });
    expect(vivid[0]! - vivid[2]!).toBeGreaterThan(150);

    const two = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 128, 128, 128, 128, 9, 9, 9, 0]);
    retouch(two, 4, 1, 1, { duotone: { dark: "#102030", light: "#f0e0d0" } });
    expect(at(two, 4, 0, 0)).toEqual([0x10, 0x20, 0x30, 255]);
    expect(at(two, 4, 1, 0)).toEqual([0xf0, 0xe0, 0xd0, 255]);
    // half see-through: coloured, and as see-through as before; fully see-through: as it was
    expect(at(two, 4, 2, 0)[3]).toBe(128);
    expect(at(two, 4, 2, 0)[0]).toBe(128);
    expect(at(two, 4, 3, 0)).toEqual([9, 9, 9, 0]);
  });

  it("a vignette darkens (or lightens) the corners and leaves the middle; grain is the same at every size the picture is drawn at", () => {
    const d = flat(40, 30, [200, 200, 200, 255]);
    retouch(d, 40, 30, 1, { vignette: 80 });
    expect(at(d, 40, 20, 15)[0]).toBe(200);
    expect(at(d, 40, 0, 0)[0]!).toBeLessThan(90);
    const lit = flat(40, 30, [100, 100, 100, 255]);
    retouch(lit, 40, 30, 1, { vignette: -80 });
    expect(at(lit, 40, 39, 29)[0]!).toBeGreaterThan(180);
    expect(at(lit, 40, 20, 15)[0]).toBe(100);

    // one design pixel as one pixel, and as 2 × 2: the same grain at the same place of the design
    const small = flat(16, 16, [128, 128, 128, 255]);
    const big = flat(32, 32, [128, 128, 128, 255]);
    retouch(small, 16, 16, 1, { grain: 60 });
    retouch(big, 32, 32, 2, { grain: 60 });
    const seen = new Set<number>();
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        expect(at(big, 32, x * 2, y * 2)[0]).toBe(at(small, 16, x, y)[0]);
        seen.add(at(small, 16, x, y)[0]!);
      }
    expect(seen.size).toBeGreaterThan(8);
    // and no brighter or darker on the whole
    const mean = small.reduce((n, v, i) => (i % 4 === 0 ? n + v : n), 0) / 256;
    expect(Math.abs(mean - 128)).toBeLessThan(6);
  });

  it("a blur spreads a dot evenly and keeps the picture as bright; its width is in design pixels; a flat picture stays flat to its edges", () => {
    const dot = (w: number) => {
      const d = flat(w, w, [0, 0, 0, 255]);
      d.set([255, 255, 255, 255], ((w >> 1) * w + (w >> 1)) * 4);
      return d;
    };
    const d = dot(41);
    blurPixels(d, 41, 41, 6);
    expect(at(d, 41, 20, 20)[0]!).toBeLessThan(40);
    expect(at(d, 41, 23, 20)[0]!).toBeGreaterThan(0);
    expect(at(d, 41, 17, 20)[0]).toBe(at(d, 41, 23, 20)[0]);
    expect(at(d, 41, 0, 0)[0]).toBe(0);
    // through the layer: twice the pixels a design pixel, twice as wide in pixels
    const one = dot(41);
    const twice = dot(81);
    retouch(one, 41, 41, 1, { blur: 4 });
    retouch(twice, 81, 81, 2, { blur: 4 });
    const reach = (p: Uint8ClampedArray, w: number) => {
      let n = 0;
      while (at(p, w, (w >> 1) + n + 1, w >> 1)[0]! > 0) n++;
      return n;
    };
    // (a single dot thins out to nothing sooner at the bigger size, so not quite twice)
    expect(reach(twice, 81)).toBeGreaterThan(reach(one, 41));
    const even = flat(20, 20, [90, 120, 150, 255]);
    blurPixels(even, 20, 20, 8);
    expect(at(even, 20, 0, 0)).toEqual([90, 120, 150, 255]);
    expect(at(even, 20, 19, 10)).toEqual([90, 120, 150, 255]);
    // a cut-out: its see-through edge blurs soft, and the colour beside it is the subject's, not a dark fringe
    const cut = flat(40, 10, [220, 40, 40, 255]);
    for (let y = 0; y < 10; y++) for (let x = 20; x < 40; x++) cut.set([0, 0, 0, 0], (y * 40 + x) * 4);
    blurPixels(cut, 40, 10, 6);
    const edge = at(cut, 40, 21, 5);
    expect(edge[3]!).toBeGreaterThan(20);
    expect(edge[3]!).toBeLessThan(200);
    expect(Math.abs(edge[0]! - 220)).toBeLessThan(12);
    expect(at(cut, 40, 2, 5)).toEqual([220, 40, 40, 255]);
    expect(at(cut, 40, 38, 5)[3]).toBe(0);
  });

  it("a wide blur, worked on a smaller copy: a flat picture stays flat, an edge becomes an even slope, about as wide as the same blur worked whole", () => {
    // sizes that are no multiple of what it is made smaller by
    const even = flat(61, 43, [90, 120, 150, 255]);
    blurPixels(even, 61, 43, 30);
    for (const [x, y] of [[0, 0], [60, 42], [30, 20], [60, 0]] as const) expect(at(even, 61, x, y)).toEqual([90, 120, 150, 255]);
    // black on the left half, white on the right
    const half = (w: number, h: number) => {
      const d = flat(w, h, [0, 0, 0, 255]);
      for (let y = 0; y < h; y++) for (let x = w >> 1; x < w; x++) d.set([255, 255, 255, 255], (y * w + x) * 4);
      return d;
    };
    const wide = half(200, 12);
    blurPixels(wide, 200, 12, 24);
    const line = Array.from({ length: 200 }, (_, x) => at(wide, 200, x, 6)[0]!);
    for (let x = 1; x < 200; x++) expect(line[x]!).toBeGreaterThanOrEqual(line[x - 1]!);
    expect(Math.abs(line[100]! - 128)).toBeLessThan(16);
    expect([line[40], line[160]]).toEqual([0, 255]);
    // how far from the edge the slope is a tenth of the way: within a quarter of a blur of 7 (worked whole) scaled up
    const reach = (l: number[], mid: number) => mid - l.findIndex((v) => v > 25);
    const whole = half(100, 12);
    blurPixels(whole, 100, 12, 7);
    const small = reach(Array.from({ length: 100 }, (_, x) => at(whole, 100, x, 6)[0]!), 50) * (24 / 7);
    expect(Math.abs(reach(line, 100) - small)).toBeLessThan(small * 0.25);
    // a cut-out's edge keeps the subject's colour
    const cut = flat(120, 12, [220, 40, 40, 255]);
    for (let y = 0; y < 12; y++) for (let x = 60; x < 120; x++) cut.set([0, 0, 0, 0], (y * 120 + x) * 4);
    blurPixels(cut, 120, 12, 18);
    const edge = at(cut, 120, 62, 6);
    expect(edge[3]!).toBeGreaterThan(20);
    expect(edge[3]!).toBeLessThan(200);
    expect(Math.abs(edge[0]! - 220)).toBeLessThan(12);
    expect(at(cut, 120, 110, 6)[3]).toBe(0);
  });
});
