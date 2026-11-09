import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { cameraIn, clampCrop, RecropBox } from "./RecropBox";

const flat = { zoom: 1, pan: 0, tilt: 0 };
const zoomed = { zoom: 2, pan: 0, tilt: 0 };

describe("RecropBox maths", () => {
  it("puts the camera frame exactly on the window when the box is the whole frame", () => {
    expect(cameraIn(flat, { x: 0, y: 0, k: 1 }, 1000, 1000)).toEqual({ x: 0, y: 0, s: 1 });
  });

  it("keeps a box inside the camera frame", () => {
    expect(clampCrop(flat, { x: 0.9, y: 0.9, k: 0.5 }, 1000, 1000)).toEqual({ x: 0.5, y: 0.5, k: 0.5 });
  });

  it("keeps the zoom between 1x and 3x", () => {
    expect(clampCrop(flat, { x: 0, y: 0, k: 2 }, 1000, 1000).k).toBe(1);
    expect(clampCrop(flat, { x: 0, y: 0, k: 0.01 }, 1000, 1000).k).toBeCloseTo(1 / 3, 5);
  });

  it("stops the box at the camera frame's edge when the render is zoomed in", () => {
    expect(clampCrop(zoomed, { x: -1, y: -1, k: 1 }, 1000, 1000)).toEqual({ x: -0.5, y: -0.5, k: 1 });
  });

  it("draws the dashed camera frame inside the window", () => {
    const html = renderToStaticMarkup(
      <RecropBox box={{ x: 0, y: 0, k: 1 }} framing={flat} w={1000} h={1000}
        onChange={() => {}} onApply={() => {}} onCancel={() => {}} />,
    );
    expect(html).toContain("border-dashed");
    expect(html).toContain("left:0%;top:0%;width:100%;height:100%");
  });
});
