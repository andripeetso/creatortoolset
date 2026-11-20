import { Canvas, DOMMatrix, loadImage } from "@napi-rs/canvas";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DesignPage, Layer, PictureSpec } from "@contracts/design";
import { pagePicture } from "./picture";

/**
 * pagePicture as the drawing browser runs it, on a real canvas: a PNG that keeps what is see-through at any size up
 * to a UHD frame at twice its size, a JPEG (the AI's look) by default, and never a reference layer.
 */
beforeAll(() => {
  vi.stubGlobal("OffscreenCanvas", Canvas);
  vi.stubGlobal("DOMMatrix", DOMMatrix);
  vi.stubGlobal("document", { createElement: () => new Canvas(1, 1), fonts: { load: async () => [], [Symbol.iterator]: [][Symbol.iterator] } });
});
afterAll(() => vi.unstubAllGlobals());

const red: Layer = { id: "r", type: "shape", shape: "rect", fill: "#ff0000", x: 100, y: 100, w: 200, h: 100 };
/** a video's frame to design over, covering the whole page */
const frameGrab = (w: number, h: number): Layer => ({ id: "ref", type: "shape", shape: "rect", fill: "#00ff00", x: 0, y: 0, w, h, reference: true });
const spec = (w: number, h: number, more: Partial<PictureSpec> = {}): PictureSpec => ({ width: w, height: h, scale: 1, pictures: {}, page: { id: "p", background: "#ffffff", fills: [], layers: [frameGrab(w, h), red] } as DesignPage, ...more });
/** A PNG's own width and height, from its header. */
const sizeOf = (b64: string) => {
  const b = Buffer.from(b64, "base64");
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
};
async function pixel(b64: string, x: number, y: number) {
  const img = await loadImage(Buffer.from(b64, "base64"));
  const c = new Canvas(img.width, img.height);
  const g = c.getContext("2d");
  g.drawImage(img, 0, 0);
  return Array.from(g.getImageData(x, y, 1, 1).data);
}

describe("a page's picture", () => {
  it("is a UHD PNG with alpha when asked: see-through where the frame has no fill, the reference left out", async () => {
    const got = await pagePicture(spec(3840, 2160, { png: true }));
    expect(got.jpeg).toBeUndefined();
    expect(sizeOf(got.png!)).toEqual({ w: 3840, h: 2160 });
    expect(await pixel(got.png!, 10, 10)).toEqual([0, 0, 0, 0]);
    expect(await pixel(got.png!, 150, 150)).toEqual([255, 0, 0, 255]);
  });

  it("is drawn `scale` times the frame's size: a full HD title at the editor's 2× zoom is UHD", async () => {
    const got = await pagePicture(spec(1920, 1080, { png: true, scale: 2 }));
    expect(sizeOf(got.png!)).toEqual({ w: 3840, h: 2160 });
    expect(await pixel(got.png!, 300, 300)).toEqual([255, 0, 0, 255]);
  });

  it("is a JPEG by default, white where the frame is see-through and the reference left out", async () => {
    const got = await pagePicture(spec(400, 300));
    expect(got.png).toBeUndefined();
    const [r, g, b] = await pixel(got.jpeg!, 10, 10);
    expect(Math.min(r!, g!, b!)).toBeGreaterThan(245);
  });

  it("is never wider or taller than PICTURE_SIDE_MAX", async () => {
    await expect(pagePicture(spec(4096, 2160, { png: true, scale: 4 }))).rejects.toThrow(/8192 pixels a side/);
  });
});
