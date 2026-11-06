import { describe, expect, it } from "vitest";
import {
  CLIP_SPEEDS,
  DEFAULT_CLIP_SPEED,
  atWindowEnd,
  clampToWindow,
  clipPlayWindow,
  formatClipSpeed,
  isClipSpeed,
  nudgeClipSpeed,
  parseClipRangeParams,
  releaseVideo,
} from "./clip-playback";

describe("clip playback speed", () => {
  it("defaults to Loom's 1.2x", () => {
    expect(DEFAULT_CLIP_SPEED).toBe(1.2);
    expect(CLIP_SPEEDS).toContain(DEFAULT_CLIP_SPEED);
  });

  it("nudges along Loom's speed ladder", () => {
    expect(nudgeClipSpeed(1.2, -1)).toBe(1);
    expect(nudgeClipSpeed(1.2, 1)).toBe(1.5);
    expect(nudgeClipSpeed(0.8, -1)).toBe(0.8);
    expect(nudgeClipSpeed(2.5, 1)).toBe(2.5);
    expect(nudgeClipSpeed(1.3, 1)).toBe(1.5);
  });

  it("formats like the player chrome", () => {
    expect(formatClipSpeed(1)).toBe("1x");
    expect(formatClipSpeed(1.2)).toBe("1.2x");
    expect(isClipSpeed(1.7)).toBe(true);
    expect(isClipSpeed(3)).toBe(false);
  });
});

describe("releaseVideo", () => {
  it("drops src, not just pause", () => {
    const calls: string[] = [];
    const v = {
      pause: () => calls.push("pause"),
      removeAttribute: (n: string) => calls.push(`remove:${n}`),
      load: () => calls.push("load"),
    } as unknown as HTMLVideoElement;
    releaseVideo(v);
    expect(calls).toEqual(["pause", "remove:src", "load"]);
  });
});

describe("clip play window", () => {
  it("parses t and end from a clip URL", () => {
    expect(parseClipRangeParams("?t=12&end=18")).toEqual({
      start: 12,
      end: 18,
    });
    expect(parseClipRangeParams("")).toEqual({});
  });

  it("clamps seek into the range and detects the end", () => {
    expect(clipPlayWindow(40, 12, 18)).toEqual({ lo: 12, hi: 18 });
    expect(clampToWindow(5, 12, 18)).toBe(12);
    expect(clampToWindow(20, 12, 18)).toBe(18);
    expect(atWindowEnd(17.96, 12, 18)).toBe(true);
    expect(atWindowEnd(15, 12, 18)).toBe(false);
  });

  it("plays through to the end when only t is set", () => {
    expect(clipPlayWindow(40, 12)).toEqual({ lo: 12, hi: 40 });
  });
});
