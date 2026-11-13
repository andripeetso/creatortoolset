import { afterEach, describe, expect, it, vi } from "vitest";
import { zoomAt } from "./hands";
import { between, framePlan, keptScale, viewStore, zoomStop, FRAME_PIXELS } from "./view";

describe("the view's store", () => {
  it("tells who listens when the view moves, and not when it is set to where it is", () => {
    const s = viewStore({ x: 0, y: 0, z: 1 });
    let heard = 0;
    const off = s.subscribe(() => heard++);
    s.set({ x: 10, y: 0, z: 1 });
    s.set({ x: 10, y: 0, z: 1 });
    s.set((v) => ({ ...v, z: 2 }));
    expect(heard).toBe(2);
    expect(s.get()).toEqual({ x: 10, y: 0, z: 2 });
    off();
    s.set({ x: 0, y: 0, z: 1 });
    expect(heard).toBe(2);
  });

  it("a glide lands at once where no picture of the screen is shown", () => {
    // under the tests there is no window: the end state must not wait for a picture that never comes
    const s = viewStore();
    s.glide({ x: 50, y: 60, z: 3 });
    expect(s.get()).toEqual({ x: 50, y: 60, z: 3 });
    expect(s.aim()).toEqual({ x: 50, y: 60, z: 3 });
  });

  describe("with a window", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });
    const windowed = () => {
      vi.useFakeTimers();
      const frames: ((at: number) => void)[] = [];
      vi.stubGlobal("document", { hidden: false });
      vi.stubGlobal("requestAnimationFrame", (f: (at: number) => void) => frames.push(f));
      return { frame: (ms: number) => (vi.advanceTimersByTime(ms), frames.shift()?.(performance.now())), waiting: () => frames.length };
    };

    it("glides there in steps, is headed there meanwhile, and ends exactly there", () => {
      const w = windowed();
      const s = viewStore({ x: 0, y: 0, z: 1 });
      s.glide({ x: 100, y: 0, z: 1 }, 160);
      expect(s.get().x).toBe(0);
      expect(s.aim().x).toBe(100);
      w.frame(80);
      expect(s.get().x).toBeGreaterThan(50); // easing out: more than half the way at half the time
      expect(s.get().x).toBeLessThan(100);
      w.frame(100);
      expect(s.get()).toEqual({ x: 100, y: 0, z: 1 });
      expect(w.waiting()).toBe(0);
    });

    it("a set from somewhere else ends the glide where that set put the view", () => {
      const w = windowed();
      const s = viewStore({ x: 0, y: 0, z: 1 });
      s.glide({ x: 100, y: 0, z: 1 }, 160);
      w.frame(40);
      s.set({ x: 7, y: 7, z: 1 });
      w.frame(40);
      vi.advanceTimersByTime(1000);
      expect(s.get()).toEqual({ x: 7, y: 7, z: 1 });
      expect(s.aim()).toEqual({ x: 7, y: 7, z: 1 });
    });

    it("ends there even when no picture of the screen ever comes", () => {
      windowed();
      const s = viewStore({ x: 0, y: 0, z: 1 });
      s.glide({ x: 100, y: 0, z: 2 }, 160);
      vi.advanceTimersByTime(400);
      expect(s.get()).toEqual({ x: 100, y: 0, z: 2 });
    });
  });
});

describe("between two views", () => {
  it("a zoom about a point keeps that point of the canvas under the same spot of the screen all the way", () => {
    const a = { x: 40, y: -30, z: 0.5 };
    const b = zoomAt(a, 4, 300, 200);
    const under = (v: { x: number; y: number; z: number }) => [(300 - v.x) / v.z, (200 - v.y) / v.z];
    for (const t of [0.1, 0.5, 0.9]) {
      const v = between(a, b, t);
      expect(under(v)[0]).toBeCloseTo(under(a)[0]!, 6);
      expect(under(v)[1]).toBeCloseTo(under(a)[1]!, 6);
    }
    // by equal factors: half the way is the zoom whose square is the product of the two
    expect(between(a, b, 0.5).z).toBeCloseTo(Math.sqrt(0.5 * 4), 6);
  });
  it("a scroll at one zoom goes straight, and the ends are the views themselves", () => {
    const a = { x: 0, y: 0, z: 2 };
    const b = { x: 100, y: -50, z: 2 };
    expect(between(a, b, 0.25)).toEqual({ x: 25, y: -12.5, z: 2 });
    expect(between(a, b, 0)).toBe(a);
    expect(between(a, b, 1)).toBe(b);
  });
});

describe("the zoom's stops", () => {
  it("in goes to the next stop above, out to the next below, and a zoom on a stop moves off it", () => {
    expect(zoomStop(0.35, true)).toBe(0.5);
    expect(zoomStop(0.35, false)).toBe(0.25);
    expect(zoomStop(0.5, true)).toBe(1);
    expect(zoomStop(0.5, false)).toBe(0.25);
    expect(zoomStop(0.4999, true)).toBe(1);
    expect(zoomStop(32, true)).toBe(32);
    expect(zoomStop(0.02, false)).toBe(0.02);
  });
});

describe("how a frame gets onto the canvas", () => {
  const finest = keptScale(1080, 1350);
  const plan = (o: Partial<Parameters<typeof framePlan>[0]>) => framePlan({ want: 0.7, finest, content: "a", had: undefined, viewMoved: false, exact: false, ...o });

  it("a frame with no picture kept gets one at the very scale it is shown at", () => {
    expect(plan({})).toEqual({ how: "make", scale: 0.7 });
  });
  it("while the view moves, the picture kept is used as it is: a zoom that glides makes none on the way", () => {
    const had = { content: "a", scale: 0.7 };
    expect(plan({ had, viewMoved: true })).toEqual({ how: "kept", scale: 0.7 });
    expect(plan({ had, viewMoved: true, want: 1.4 })).toEqual({ how: "kept", scale: 0.7 });
    expect(plan({ had, viewMoved: true, want: 0.1 })).toEqual({ how: "kept", scale: 0.7 });
  });
  it("more than four times too coarse, it is made again", () => {
    expect(plan({ had: { content: "a", scale: 0.1 }, viewMoved: true, want: 0.7 })).toEqual({ how: "make", scale: 0.7 });
  });
  it("a frame whose content changed is made again, the others are not", () => {
    expect(plan({ had: { content: "before", scale: 0.7 } })).toEqual({ how: "make", scale: 0.7 });
    expect(plan({ had: { content: "a", scale: 0.7 } })).toEqual({ how: "kept", scale: 0.7 });
  });
  it("a moment after the last move every frame is exact: a picture at the very scale", () => {
    expect(plan({ had: { content: "a", scale: 0.7 }, want: 1.4, exact: true })).toEqual({ how: "make", scale: 1.4 });
    expect(plan({ had: { content: "a", scale: 1.4 }, want: 1.4, exact: true })).toEqual({ how: "kept", scale: 1.4 });
  });
  it("zoomed in further than a picture may be big: drawn directly when the view is still, kept coarse only while it moves", () => {
    const deep = finest * 3;
    expect(plan({ want: deep, exact: true })).toEqual({ how: "direct" });
    expect(plan({ want: deep })).toEqual({ how: "direct" });
    expect(plan({ want: deep, had: { content: "a", scale: finest } })).toEqual({ how: "direct" });
    expect(plan({ want: deep, viewMoved: true })).toEqual({ how: "make", scale: finest });
    expect(plan({ want: deep, viewMoved: true, had: { content: "a", scale: finest } })).toEqual({ how: "kept", scale: finest });
  });
  it("no kept picture is bigger than its share of memory, or longer than a canvas may be", () => {
    expect(1080 * 1350 * finest ** 2).toBeCloseTo(FRAME_PIXELS, 0);
    expect(4096 * keptScale(4096, 16)).toBeLessThanOrEqual(8192);
  });
});
