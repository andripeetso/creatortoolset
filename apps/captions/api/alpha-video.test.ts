import { describe, expect, it } from "vitest";
import { hasTransparentPixels } from "./alpha-video";

describe("hasTransparentPixels", () => {
  it("rejects an empty or fully opaque alpha sample", () => {
    expect(hasTransparentPixels(new Uint8Array())).toBe(false);
    expect(hasTransparentPixels(new Uint8Array([255, 255, 255]))).toBe(false);
  });

  it("accepts a sample containing transparent pixels", () => {
    expect(hasTransparentPixels(new Uint8Array([255, 249, 255]))).toBe(true);
    expect(hasTransparentPixels(new Uint8Array([255, 0, 255]))).toBe(true);
  });
});
