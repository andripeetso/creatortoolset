import { describe, expect, it } from "vitest";
import { filterOf, rgba } from "./gl-stage";

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
