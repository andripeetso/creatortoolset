import { describe, expect, it } from "vitest";
import { PEAKS_PER_SECOND, heightOf, levelsOf, scaleOf } from "./waveform";

describe("waveform levels", () => {
  it("keeps each bucket's loudest sample and its loudness, over every channel", () => {
    const rate = PEAKS_PER_SECOND * 4;
    const left = new Float32Array([0.5, -0.5, 0.5, -0.5, 0, 0, 0, 0.1]);
    const right = new Float32Array([0.5, -0.5, 0.5, -0.5, 0, 0, 0, -0.9]);
    const lv = levelsOf([left, right], rate);
    expect(Array.from(lv.peak).map((v) => +v.toFixed(2))).toEqual([0.5, 0.9]);
    expect(lv.rms[0]).toBeCloseTo(0.5, 5);
    expect(lv.rms[1]).toBeCloseTo(Math.sqrt((0.01 + 0.81) / 8), 5);
  });

  it("a song mastered loud still shows its beats: the scale runs from its peak down to its quiet floor", () => {
    // a beat every 10 buckets at -8 dB loudness, -18 dB between, every peak near the top
    const n = 600;
    const lv = {
      peak: new Float32Array(n).fill(0.95),
      rms: Float32Array.from({ length: n }, (_, i) => (i % 10 < 3 ? 0.4 : 0.125)),
    };
    const s = scaleOf(lv);
    const beat = heightOf(0.4, s);
    const between = heightOf(0.125, s);
    expect(heightOf(0.95, s)).toBe(1);
    expect(beat - between).toBeGreaterThan(0.4);
    expect(between).toBeGreaterThanOrEqual(0);
    expect(heightOf(0, s)).toBe(0);
  });
});
