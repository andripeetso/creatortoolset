import { describe, expect, it } from "vitest";
import { zoomView, autoZooms, backgroundStops, bubbleRect, cameraAt, defaultCamera, defaultLook, drawFrame, layout, normalizeLook, outputSize, pointerAt, pointerPath, shadowOf, sideRects, trimOf, type ScreenEvents, type ScreenLook } from "./screen-recording";

const events: ScreenEvents = {
  v: 1,
  width: 3840,
  height: 2160,
  moves: [[0, 0.1, 0.1], [0.4, 0.2, 0.2], [0.8, 0.3, 0.3]],
  clicks: [[5, 0.8, 0.2], [6, 0.9, 0.3], [20, 0.5, 0.5], [21, 1.4, 0.5]],
};

describe("screen recording", () => {
  it("makes one zoom per burst of clicks, ignoring clicks on another display", () => {
    const zooms = autoZooms(events, 30);
    expect(zooms).toHaveLength(2);
    expect(zooms[0]).toMatchObject({ start: 4.4, end: 8.5, scale: 2 }); // just before the first click, 2.5 s after the last
    expect(zooms[0].x).toBeCloseTo(0.85);
    expect(zooms[1]).toMatchObject({ start: 19.4, end: 22.5 }); // the click at 21 s was on another display
  });

  it("makes no zoom for the press that stopped the recording", () => {
    // his 3.5 s recording: one press, 0.1 s before the end
    expect(autoZooms({ clicks: [[3.379, 0.5, 0.5]], moves: [] }, 3.485)).toEqual([]);
    expect(autoZooms({ clicks: [[1, 0.5, 0.5], [3.379, 0.5, 0.5]], moves: [] }, 3.485)).toHaveLength(1);
  });

  it("lays click zooms out by the measured times: 4.6 s apart share one, 5.7 s apart do not", () => {
    const at = (...ts: number[]) => ({ clicks: ts.map((t) => [t, 0.5, 0.5] as [number, number, number]), moves: [] });
    const spans = (ts: number[]) => autoZooms(at(...ts), 240).map((z) => [z.start, z.end]);
    // from the measured recording: two clicks, then a run of seven, then the next run 8 s later
    expect(spans([27.06, 28.09])).toEqual([[26.46, 30.59]]);
    expect(spans([39.41, 39.7, 41.3, 42.2, 42.5, 46.1, 46.64, 54.69])).toEqual([[38.81, 49.14], [54.09, 57.19]]);
    expect(spans([10, 14.6])).toHaveLength(1);
    expect(spans([10, 15.7])).toHaveLength(2);
    expect(spans([0.2])).toEqual([[0, 2.7]]); // never before the start
    expect(spans([238])).toEqual([[237.4, 240]]); // never past the end
  });

  it("holds a zoom through a drag: the release counts, and the next press is measured from it", () => {
    const press = (t: number): [number, number, number] => [t, 0.4, 0.4];
    // a press at 10 s held until 14.7 s, the next press at 15.75 s: 5.75 s after the press, 1 s after the release
    const dragged = autoZooms({ clicks: [press(10), press(15.75)], releases: [[14.7, 0.6, 0.6], [15.9, 0.4, 0.4]], moves: [] }, 60);
    expect(dragged.map((z) => [z.start, z.end])).toEqual([[9.4, 18.4]]);
    expect(dragged[0].x).toBeCloseTo(0.4); // aimed by the presses
    // the same presses from an app that logs no releases: two zooms
    expect(autoZooms({ clicks: [press(10), press(15.75)], moves: [] }, 60)).toHaveLength(2);
    // a release with no press near it starts nothing
    expect(autoZooms({ clicks: [press(10)], releases: [[30, 0.5, 0.5]], moves: [] }, 60)).toHaveLength(1);
  });

  it("with no click in the picture, zooms where the pointer was at work", () => {
    const line = (from: number, to: number, x0: number, x1: number, y = 0.5) =>
      Array.from({ length: Math.round((to - from) * 10) + 1 }, (_, i) => {
        const k = i / Math.round((to - from) * 10);
        return [from + (to - from) * k, x0 + (x1 - x0) * k, y] as [number, number, number];
      });
    // 5 s of moving across the picture: one zoom, from half a second before to a second after, aimed at its middle
    const worked = autoZooms({ clicks: [], moves: line(2, 7, 0.2, 0.6) }, 20);
    expect(worked.map((z) => [z.start, z.end])).toEqual([[1.5, 8]]);
    expect(worked[0].x).toBeCloseTo(0.4);
    // a pointer left lying makes none, however long
    expect(autoZooms({ clicks: [], moves: line(2, 12, 0.5, 0.5) }, 20)).toEqual([]);
    // nor does one outside the recorded window (his 3.5 s recording: the pointer sat on the recorder's own bar)
    expect(autoZooms({ clicks: [], moves: line(0.2, 3.3, 1.02, 1.04, 0.04) }, 3.485)).toEqual([]);
    // a 2 s pause ends a stretch; two stretches far enough apart are two zooms
    expect(autoZooms({ clicks: [], moves: [...line(1, 4, 0.2, 0.5), ...line(9, 13, 0.6, 0.9)] }, 20)).toHaveLength(2);
    // a click in the picture decides alone: movement elsewhere adds nothing
    expect(autoZooms({ clicks: [[15, 0.5, 0.5]], moves: line(2, 7, 0.2, 0.6) }, 20).map((z) => [z.start, z.end])).toEqual([[14.4, 17.5]]);
  });

  it("reads a look saved before the newer fields existed as it was", () => {
    // what the editor saved on 2026-11-10, before shadowAmount, trim, colors and pointerHidden
    const old = { zooms: [], follow: true, pointer: 2, smooth: 0.2, hideIdle: true, clickRings: true, background: "violet", padding: 0.065, radius: 0.018, shadow: true, shape: "source", fill: false } as ScreenLook;
    const look = normalizeLook(old, events, 30);
    expect(look).toMatchObject(old);
    expect(shadowOf(look)).toBe(0.45); // the shadow it always had
    expect(look.zoomFit).toBe("inside"); // and a zoom keeps its window as it was
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

  it("lets a zoom's window grow into the space beside it before it crops, or zooms the whole frame", () => {
    // a square recording in a wide frame, no padding: at rest a 1080 square in the middle of 1920×1080
    const base = { ...defaultLook(events, 30), shape: "16:9" as const, padding: 0, follow: false };
    const at = (zoomFit: "inside" | "space" | "frame", scale: number, x = 0.5, y = 0.5) =>
      layout({ ...base, zoomFit, zooms: [{ start: -10, end: 10, x, y, scale }] }, [], 0, 2000, 2000, 1920, 1080);
    // inside: the window stays 1080 wide and half of each side is cut off at 2×
    expect(at("inside", 2)).toMatchObject({ box: { x: 420, y: 0, w: 1080, h: 1080 }, src: { w: 1000, h: 1000 } });
    // space at 1.5×: the window is 1620 wide and shows the recording's whole width; only the height is cut
    const grown = at("space", 1.5);
    expect(grown.box).toEqual({ x: 150, y: 0, w: 1620, h: 1080 });
    expect(grown.src.w).toBeCloseTo(2000);
    expect(grown.src.h).toBeCloseTo(2000 / 1.5);
    // space at 2×: it has reached the frame's sides and shows 1920 of 2160, not 1080
    const full = at("space", 2);
    expect(full.box).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    expect(full.src.w).toBeCloseTo((1920 / 2160) * 2000);
    // looking at the left edge: no gap opens on the left
    expect(at("space", 2, 0, 0.5).src.x).toBe(0);
    // with padding, space stops at the padding and frame goes past it, growing its corners
    const padded = (zoomFit: "space" | "frame") =>
      layout({ ...base, padding: 0.1, zoomFit, zooms: [{ start: -10, end: 10, x: 0.5, y: 0.5, scale: 3 }] }, [], 0, 2000, 2000, 1920, 1080);
    expect(padded("space").box).toEqual({ x: 108, y: 108, w: 1704, h: 864 });
    expect(padded("space").grown).toBe(1);
    expect(padded("frame").box).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    expect(padded("frame").grown).toBe(3);
    // a frame that is filled has no window to grow: as before
    expect(layout({ ...base, fill: true, zoomFit: "frame", zooms: [{ start: -10, end: 10, x: 0.5, y: 0.5, scale: 2 }] }, [], 0, 2000, 2000, 1920, 1080).box).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    // the aim pad's box is the part shown
    expect(zoomView({ ...base, zoomFit: "space" }, { start: 1, end: 5, x: 0.5, y: 0.5, scale: 1.5 }, 2000, 2000, 1920, 1080)).toMatchObject({ x: 0, w: 1 });
  });

  it("keeps the trim inside the recording", () => {
    expect(trimOf({ trim: { start: 2, end: 9 } }, 15)).toEqual({ start: 2, end: 9 });
    expect(trimOf({ trim: { start: -3, end: 99 } }, 15)).toEqual({ start: 0, end: 15 });
    expect(trimOf({ trim: { start: 14.95, end: 15 } }, 15)).toEqual({ start: 14.8, end: 15 });
  });

  it("joins zooms that would overlap their ramps", () => {
    expect(autoZooms({ clicks: [[5, 0.5, 0.5], [8, 0.5, 0.5]], moves: [] }, 30)).toHaveLength(1);
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
