import { describe, expect, it } from "vitest";
import { atLevel52, h264Level } from "./h264-level";

describe("H.264 level in a codec name", () => {
  it("reads the level", () => {
    expect(h264Level("avc1.64003c")).toBe(0x3c); // 6.0: a 3008×3130 window at 60 fps
    expect(h264Level("avc1.640034")).toBe(0x34); // 5.2: 4K at 60 fps
    expect(h264Level("avc3.4D0028")).toBe(0x28);
    expect(h264Level("hvc1.1.6.L153.B0")).toBe(0);
    expect(h264Level("avc1")).toBe(0);
  });

  it("writes the same name at level 5.2", () => {
    expect(atLevel52("avc1.64003c")).toBe("avc1.640034");
    expect(atLevel52("avc1.64003e")).toBe("avc1.640034");
  });
});
