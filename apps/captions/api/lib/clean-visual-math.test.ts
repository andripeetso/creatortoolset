import { describe, expect, it } from "vitest";
import {
  matchVpdq,
  motionWindow,
  readPpm,
  visualDifference,
  type RgbImage,
} from "./clean-visual-math";

const solid = (r: number, g = r, b = r): RgbImage => ({
  width: 1,
  height: 1,
  data: Uint8Array.from([r, g, b]),
});
describe("visual diagnostics", () => {
  it("preserves whitespace-valued first pixels and rejects truncated PPMs", () => {
    const bytes = Buffer.concat([
      Buffer.from("P6\n# frame\n1 1\n255\n"),
      Buffer.from([10, 32, 13]),
    ]);
    expect([...readPpm(bytes).data]).toEqual([10, 32, 13]);
    expect(() => readPpm(bytes.subarray(0, -1))).toThrow("Incomplete");
    expect(() => readPpm(Buffer.from("P6\n999999 999999\n255\n"))).toThrow();
  });
  it("measures color and brightness independently of file hashes", () => {
    expect(visualDifference(solid(32), solid(32)).colorDeltaE).toBe(0);
    const blackWhite = visualDifference(solid(0), solid(255));
    expect(blackWhite.colorDeltaE).toBeCloseTo(100, 3);
    expect(blackWhite.brightnessBefore).toBe(0);
    expect(blackWhite.brightnessAfter).toBeCloseTo(100);
    expect(blackWhite.contrastBefore).toBe(0);
    expect(blackWhite.contrastAfter).toBeCloseTo(0, 4);
    expect(
      visualDifference(solid(255, 0, 0), solid(0, 255, 0)).colorDeltaE,
    ).toBeGreaterThan(150);
  });
  it("detects contrast spread without changing mean brightness", () => {
    const data = Uint8Array.from({ length: 64 * 64 * 3 }, (_, i) =>
      Math.floor(i / 3) % 2 ? 255 : 0,
    );
    const result = visualDifference(solid(127.5), {
      width: 64,
      height: 64,
      data,
    });
    expect(result.contrastAfter).toBeCloseTo(50);
    expect(result.brightnessAfter).toBeCloseTo(50);
    expect(result.contrastBefore).toBeCloseTo(0);
  });
});
describe("vPDQ directional matching", () => {
  const a = { hash: "0".repeat(64), quality: 100 },
    b = { hash: "f".repeat(64), quality: 100 };
  it("deduplicates, ignores ordering, and retains asymmetric coverage", () => {
    const result = matchVpdq([a, b, a], [a, a]);
    expect(result.before).toMatchObject({
      sampled: 3,
      unique: 2,
      matched: 1,
      percent: 50,
    });
    expect(result.after.percent).toBe(100);
    expect(matchVpdq([b, a], [a, b]).before.percent).toBe(100);
  });
  it("uses the inclusive 31-bit boundary and excludes low detail", () => {
    const near = { ...a, hash: "0".repeat(56) + "7fffffff" };
    expect(matchVpdq([a], [near]).before.percent).toBe(100);
    expect(
      matchVpdq([a], [{ ...near, hash: "0".repeat(56) + "ffffffff" }]).before
        .percent,
    ).toBe(0);
    expect(matchVpdq([a], [{ ...a, quality: 49 }]).before.percent).toBeNull();
    expect(matchVpdq([], []).after.percent).toBeNull();
  });
});
describe("motion translation proxy", () => {
  const texture = Uint8Array.from(
    { length: 80 * 80 },
    (_, i) => (Math.imul(i + 17, 1103515245) >>> 8) % 256,
  );
  const frame = (x: number) =>
    Uint8Array.from(
      { length: 4096 },
      (_, i) => texture[(Math.floor(i / 64) + 8) * 80 + (i % 64) + 8 + x],
    );
  it("distinguishes steady translations from alternating motion", () => {
    const steady = motionWindow([0, 1, 2, 3].map(frame));
    const jitter = motionWindow([0, 1, 0, 1].map(frame));
    expect(steady.validTriples).toBe(2);
    expect(steady.squaredAcceleration).toBe(0);
    expect(jitter.squaredAcceleration).toBeGreaterThan(0);
  });
  it("rejects detail-free frames without reporting perfect stability", () => {
    const result = motionWindow([
      new Uint8Array(4096),
      new Uint8Array(4096),
      new Uint8Array(4096),
    ]);
    expect(result.validTriples).toBe(0);
    expect(result.rejectedPairs).toBe(2);
  });
});
