import { describe, expect, it } from "vitest";
import { autoZooms, backgroundStops, bubbleRect, cameraAt, defaultCamera, defaultLook, drawFrame, layout, normalizeLook, outputSize, pointerAt, pointerPath, shadowOf, sideRects, trimOf, type ScreenEvents, type ScreenLook } from "./screen-recording";

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

  it("makes no zoom for the press that stopped the recording", () => {
    // his 3.5 s recording: one press, 0.1 s before the end
    expect(autoZooms([[3.379, 0.5, 0.5]], 3.485)).toEqual([]);
    expect(autoZooms([[1, 0.5, 0.5], [3.379, 0.5, 0.5]], 3.485)).toHaveLength(1);
  });

  it("reads a look saved before the newer fields existed as it was", () => {
    // what the editor saved on 2026-11-10, before shadowAmount, trim, colors and pointerHidden
    const old = { zooms: [], follow: true, pointer: 2, smooth: 0.2, hideIdle: true, clickRings: true, background: "violet", padding: 0.065, radius: 0.018, shadow: true, shape: "source", fill: false } as ScreenLook;
    const look = normalizeLook(old, events, 30);
    expect(look).toMatchObject(old);
    expect(shadowOf(look)).toBe(0.45); // the shadow it always had
    expect(shadowOf({ shadow: false })).toBe(0);
    expect(backgroundStops(look)).toEqual(["#7c3aed", "#db2777"]);
    expect(trimOf(look, 30)).toEqual({ start: 0, end: 30 });
    expect(normalizeLook(null, events, 30)).toEqual(defaultLook(events, 30));
  });

  it("puts a broken look's zooms in order, apart and inside the recording", () => {
    const z = (start: number, end: number) => ({ start, end, x: 0.5, y: 0.5, scale: 2 });
    const look = normalizeLook({ zooms: [z(8, 12), z(1, 4), z(3, 6), z(28, 40), z(20, 20.2), { ...z(14, 16), x: Number.NaN }], padding: 9, pointer: -1 }, events, 30);
    expect(look.zooms.map((o) => [o.start, o.end])).toEqual([[1, 4], [4, 6], [8, 12], [28, 30]]);
    expect(look.padding).toBe(0.15);
    expect(look.pointer).toBe(0.8);
  });

  it("takes the background from a preset, one color or your own two", () => {
    expect(backgroundStops({ background: "color", color: "#112233" })).toEqual(["#112233", "#112233"]);
    expect(backgroundStops({ background: "custom", stops: ["#000000", "#ffffff"] })).toEqual(["#000000", "#ffffff"]);
    expect(backgroundStops({ background: "custom", stops: ["red", "#ffffff"] as [string, string] })).toEqual(["#7c3aed", "#db2777"]);
    expect(backgroundStops({ background: "gone" })).toEqual(["#7c3aed", "#db2777"]);
  });

  it("keeps the trim inside the recording", () => {
    expect(trimOf({ trim: { start: 2, end: 9 } }, 15)).toEqual({ start: 2, end: 9 });
    expect(trimOf({ trim: { start: -3, end: 99 } }, 15)).toEqual({ start: 0, end: 15 });
    expect(trimOf({ trim: { start: 14.95, end: 15 } }, 15)).toEqual({ start: 14.8, end: 15 });
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

  it("places the camera bubble in each corner with a 4% margin", () => {
    const cam = { ...defaultCamera(), size: 0.24 };
    const d = 0.24 * 1080;
    const m = 0.04 * 1080;
    expect(bubbleRect({ ...cam, corner: "tl" }, 1920, 1080)).toEqual({ x: m, y: m, w: d, h: d });
    expect(bubbleRect({ ...cam, corner: "tr" }, 1920, 1080)).toEqual({ x: 1920 - m - d, y: m, w: d, h: d });
    expect(bubbleRect({ ...cam, corner: "bl" }, 1920, 1080)).toEqual({ x: m, y: 1080 - m - d, w: d, h: d });
    expect(bubbleRect({ ...cam, corner: "br" }, 1920, 1080)).toEqual({ x: 1920 - m - d, y: 1080 - m - d, w: d, h: d });
  });

  it("splits side by side into 62% screen and 38% camera", () => {
    const { screen, camera } = sideRects(1920, 1080, 0);
    const gap = 1080 * 0.012;
    expect(screen.x).toBe(0);
    expect(screen.w).toBeCloseTo(1920 * 0.62 - gap / 2);
    expect(camera.x).toBeCloseTo(1920 * 0.62 + gap / 2);
    expect(camera.x + camera.w).toBeCloseTo(1920);
    expect(camera.w).toBeCloseTo(1920 * 0.38 - gap / 2);
    expect(camera.h).toBe(1080);
  });

  it("draws no camera when the layout is hidden", () => {
    const calls: unknown[][] = [];
    const ctx = fakeContext(1920, 1080, calls);
    const screen = { screen: true };
    const look = { ...defaultLook(events, 30), camera: { ...defaultCamera(), layout: "hidden" as const } };
    drawFrame(ctx, screen as unknown as CanvasImageSource, 3840, 2160, 1, look, pointerPath(events), events.clicks, { image: { cam: true } as unknown as CanvasImageSource, width: 640, height: 480 });
    const drawn = calls.filter((c) => c[0] === "drawImage").map((c) => c[1]);
    expect(drawn).toEqual([screen]);
  });
});

/** A canvas context that records drawImage calls and ignores everything else. */
function fakeContext(width: number, height: number, calls: unknown[][]): CanvasRenderingContext2D {
  const noop = (...args: unknown[]) => {
    calls.push(args);
    return grad;
  };
  const grad = { addColorStop: () => {} };
  const target: Record<string, unknown> = { canvas: { width, height } };
  return new Proxy(target, {
    get(t, key: string) {
      if (key in t) return t[key];
      if (key === "drawImage") return (...args: unknown[]) => calls.push(["drawImage", args[0]]);
      return (...args: unknown[]) => noop(key, ...args);
    },
    set(t, key: string, value) {
      t[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}
