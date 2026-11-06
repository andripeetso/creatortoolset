import { describe, expect, it } from "vitest";
import {
  dhashFromGray,
  fingerprintFrameTimes,
  hamming,
  isDegenerate,
  sameMedia,
  samePost,
  HASH_H,
  HASH_W,
} from "./fingerprint";

function gray(fn: (x: number, y: number) => number): Uint8Array {
  const px = new Uint8Array(HASH_W * HASH_H);
  for (let y = 0; y < HASH_H; y++) for (let x = 0; x < HASH_W; x++) px[y * HASH_W + x] = fn(x, y);
  return px;
}

const rising = gray((x) => x * 20);
const falling = gray((x) => 200 - x * 20);
const checker = gray((x, y) => ((x + y) % 2 ? 220 : 30));

describe("dhashFromGray / hamming", () => {
  it("hashes a 9×8 gray tile into 16 hex chars", () => {
    expect(dhashFromGray(rising)).toBe("ffffffffffffffff");
    expect(dhashFromGray(falling)).toBe("0000000000000000");
    expect(dhashFromGray(checker)).toHaveLength(16);
  });

  it("counts differing bits", () => {
    expect(hamming("ffffffffffffffff", "0000000000000000")).toBe(64);
    expect(hamming("ffffffffffffffff", "fffffffffffffffe")).toBe(1);
    expect(hamming("abc", "abcd")).toBe(Number.POSITIVE_INFINITY);
  });

  it("refuses a short buffer", () => {
    expect(() => dhashFromGray(new Uint8Array(10))).toThrow(/expected 72/);
  });

  it("treats flat tiles as degenerate", () => {
    expect(isDegenerate(dhashFromGray(rising))).toBe(true);
    expect(isDegenerate(dhashFromGray(falling))).toBe(true);
    expect(isDegenerate(dhashFromGray(checker))).toBe(false);
  });
});

describe("fingerprintFrameTimes", () => {
  it("samples start, middle and end", () => {
    expect(fingerprintFrameTimes(30)).toEqual([0.5, 15, 29]);
  });
  it("collapses very short clips", () => {
    expect(fingerprintFrameTimes(1)).toEqual([0.5]);
    expect(fingerprintFrameTimes(2)).toEqual([0.5, 1]);
  });
});

const a = dhashFromGray(checker);
const invert = (hex: string) => [...hex].map((c) => (15 - parseInt(c, 16)).toString(16)).join("");
// Inverting one nibble moves 4 bits; inverting eight moves 32.
const near = a.slice(0, 15) + invert(a[15]!);
const far = invert(a.slice(0, 8)) + a.slice(8);

describe("sameMedia / samePost", () => {
  it("matches images within a few bits", () => {
    expect(hamming(a, near)).toBeLessThanOrEqual(8);
    expect(sameMedia({ h: [a] }, { h: [near] })).toBe(true);
    expect(sameMedia({ h: [a] }, { h: [far] })).toBe(false);
  });

  it("never matches degenerate images", () => {
    const flat = dhashFromGray(rising);
    expect(sameMedia({ h: [flat] }, { h: [flat] })).toBe(false);
  });

  it("needs a close duration and most frames for videos", () => {
    const v = { h: [a, a, a], d: 30 };
    expect(sameMedia(v, { h: [near, a, far], d: 30.4 })).toBe(true);
    expect(sameMedia(v, { h: [near, far, far], d: 30 })).toBe(false);
    expect(sameMedia(v, { h: [a, a, a], d: 34 })).toBe(false);
    expect(sameMedia(v, { h: [a] })).toBe(false);
  });

  it("compares carousels slide by slide", () => {
    expect(samePost([{ h: [a] }, { h: [a], d: 10 }], [{ h: [near] }, { h: [a, a], d: 10.5 }])).toBe(true);
    expect(samePost([{ h: [a] }, { h: [a] }], [{ h: [a] }])).toBe(false);
    expect(samePost([{ h: [a] }, undefined], [{ h: [a] }, { h: [a] }])).toBe(false);
    expect(samePost([], [])).toBe(false);
  });
});
