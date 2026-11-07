import { describe, expect, it } from "vitest";
import type { TimelineSource } from "../../contracts/editor";
import { fitted, framingOf, maxPunch, tiltFor } from "./framing";

const src = (w: number, h: number): TimelineSource => ({ versionId: "v", name: "Take A", fps: 25, tc: 0, dur: 100, w, h });
const W = 1080;
const H = 1920;
/** Where the picture's top and bottom edges land on screen (y down), and a source line at fraction y. */
function onScreen(s: TimelineSource, zoom: number, tilt: number, y: number) {
  const { h } = fitted(s, W, H);
  const at = (f: number) => H / 2 + zoom * (f - 0.5) * h - tilt;
  return { top: at(0), bottom: at(1), line: at(y) };
}

describe("AI Editor framing", () => {
  it("punches in on every other shot, holding the eye line where it was", () => {
    const s = src(1080, 1920);
    expect(framingOf(0, s, W, H, 1.15, 0.38)).toEqual({});
    const f = framingOf(1, s, W, H, 1.15, 0.38);
    expect(f.zoom).toBe(1.15);
    expect(onScreen(s, f.zoom!, f.tilt!, 0.38).line).toBeCloseTo(onScreen(s, 1, 0, 0.38).line, 1);
    expect(framingOf(2, s, W, H, 1.15, 0.38)).toEqual({});
  });

  it("caps the punch by the source's size: 1.5 under 4K, 2.0 from 4K", () => {
    expect(maxPunch(src(1080, 1920))).toBe(1.5);
    expect(maxPunch(src(2160, 3840))).toBe(2);
    expect(framingOf(1, src(1080, 1920), W, H, 2, 0.5)).toEqual({ zoom: 1.5 });
  });

  it("never shows an edge at the clamp, with the eye line at the very top or bottom", () => {
    for (const s of [src(1080, 1920), src(2160, 3840)]) {
      const z = maxPunch(s);
      for (const y of [0, 1]) {
        const e = onScreen(s, z, tiltFor(s, W, H, z, y), y);
        expect(e.top).toBeLessThanOrEqual(0.01);
        expect(e.bottom).toBeGreaterThanOrEqual(H - 0.01);
      }
    }
  });

  it("keeps a wide shot in a tall frame inside the frame", () => {
    const s = src(1920, 1080);
    for (const y of [0, 1]) {
      const e = onScreen(s, 1.5, tiltFor(s, W, H, 1.5, y), y);
      expect(e.top).toBeGreaterThanOrEqual(-0.01);
      expect(e.bottom).toBeLessThanOrEqual(H + 0.01);
    }
  });
});
