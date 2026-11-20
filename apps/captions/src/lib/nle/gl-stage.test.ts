import { describe, expect, it } from "vitest";
import { filterOf, rgba, toCodes } from "./gl-stage";

describe("what the graphics stage reads from 2D canvas state", () => {
  it("colours, premultiplied", () => {
    expect(rgba("#000")).toEqual([0, 0, 0, 1]);
    expect(rgba("#fff")).toEqual([1, 1, 1, 1]);
    expect(rgba("#8f1414").map((v) => Math.round(v * 255))).toEqual([143, 20, 20, 255]);
    expect(rgba("rgba(255,255,255,0.25)")).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(rgba("rgb(51, 102, 0)").map((v) => Math.round(v * 255))).toEqual([51, 102, 0, 255]);
  });
  it("the looks' filters: invert and blur", () => {
    expect(filterOf("invert(1) blur(3.5px)")).toEqual({ invert: true, blur: 3.5 });
    expect(filterOf("none")).toEqual({ invert: false, blur: 0 });
  });
});

describe("stills, text and fills through the display step", () => {
  // present()'s step for video codes on Apple's WebKit: gamma 1.961, then sRGB
  const shown = (v: number) => {
    const l = v ** 1.961;
    return l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055;
  };
  it("come out as a 2D canvas shows them: grey 0.5 stays 0.5, the offline red stays red, black and white stay", () => {
    for (const v of [0, 0.02, 0.18, 0.5, 0.9, 1]) expect(shown(toCodes([v, v, v, 1], 1.961)[0])).toBeCloseTo(v, 6);
    const red = rgba("#8f1414");
    expect(toCodes(red, 1.961).slice(0, 3).map((v) => Math.round(shown(v) * 255))).toEqual([143, 20, 20]);
    // premultiplied: a half-seen white is still white at half
    const [r, , , a] = toCodes([0.5, 0.5, 0.5, 0.5], 1.961);
    expect([shown(r / a), a]).toEqual([expect.closeTo(1, 6), 0.5]);
    expect(toCodes([0.5, 0.5, 0.5, 1], 0)).toEqual([0.5, 0.5, 0.5, 1]);
  });
});
