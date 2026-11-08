import { describe, expect, it } from "vitest";
import { autoZooms, cameraAt, defaultLook, layout, outputSize, pointerAt, pointerPath, type ScreenEvents } from "./screen-recording";

const events: ScreenEvents = {
  v: 1,
  width: 3840,
  height: 2160,
  moves: [[0, 0.1, 0.1], [0.4, 0.2, 0.2], [0.8, 0.3, 0.3]],
  clicks: [[5, 0.8, 0.2], [6, 0.9, 0.3], [20, 0.5, 0.5], [21, 1.4, 0.5]],
};

describe("screen recording", () => {
  it("makes one zoom per burst of clicks, ignoring clicks on another display", () => {
    const zooms = autoZooms(events.clicks, 30);
    expect(zooms).toHaveLength(2);
    expect(zooms[0]).toMatchObject({ start: 4, end: 7.5, scale: 2 });
    expect(zooms[0].x).toBeCloseTo(0.85);
    expect(zooms[1]).toMatchObject({ start: 19, end: 21.5 }); // at least 2.5 s
  });

  it("joins zooms that would overlap their ramps", () => {
    expect(autoZooms([[5, 0.5, 0.5], [8, 0.5, 0.5]], 30)).toHaveLength(1);
  });

  it("interpolates the pointer and holds it across a pause", () => {
    const path = pointerPath(events);
    expect(pointerAt(path, 0.2)).toEqual({ x: expect.closeTo(0.15), y: expect.closeTo(0.15) });
    expect(pointerAt(path, 3)).toEqual({ x: 0.3, y: 0.3 }); // 3 s gap to the next point: still
  });

  it("zooms in fully inside a zoom and not at all outside", () => {
    const look = { ...defaultLook(events, 30), follow: false };
    const path = pointerPath(events);
    expect(cameraAt(look, path, 1).scale).toBe(1);
    const mid = cameraAt(look, path, 5.75);
    expect(mid.scale).toBe(2);
    expect(mid.x).toBeCloseTo(0.85);
  });

  it("keeps the zoomed view inside the picture", () => {
    const look = { ...defaultLook(events, 30), follow: false, padding: 0 };
    const { src, box } = layout(look, pointerPath(events), 5.75, 3840, 2160, 1920, 1080);
    expect(box).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    expect(src.w).toBe(1920);
    expect(src.x + src.w).toBeLessThanOrEqual(3840); // aimed at x 0.85: clamped to the right edge
    expect(src.x).toBe(1920);
  });

  it("sizes output frames", () => {
    expect(outputSize("9:16", 3840, 2160, false)).toEqual({ width: 1080, height: 1920 });
    expect(outputSize("source", 3024, 1964, false)).toEqual({ width: 1662, height: 1080 });
    expect(outputSize("16:9", 0, 0, true)).toEqual({ width: 3840, height: 2160 });
  });
});
