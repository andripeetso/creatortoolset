import { afterEach, describe, expect, it, vi } from "vitest";
import { PEAKS_PER_SECOND, heightOf, holdWaves, idleLevels, levels, levelsOf, scaleOf } from "./waveform";

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

describe("a video file's waveform", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("is read only while nothing plays, one file at a time, stopped by playback and shared by URL", async () => {
    const asked: string[] = [];
    const aborts: string[] = [];
    vi.stubGlobal("requestIdleCallback", (f: () => void) => setTimeout(f, 0));
    vi.stubGlobal("fetch", (u: string, o: RequestInit) => new Promise((done, fail) => {
      asked.push(u);
      o.signal?.addEventListener("abort", () => (aborts.push(u), fail(new DOMException("stopped", "AbortError"))));
      setTimeout(() => done({ ok: true, headers: new Headers({ "content-length": "8" }), arrayBuffer: async () => new ArrayBuffer(8) }), 30);
    }));
    vi.stubGlobal("OfflineAudioContext", class {
      decodeAudioData = async () => ({ numberOfChannels: 1, sampleRate: 8000, getChannelData: () => new Float32Array(80).fill(0.5) });
    });
    const tick = () => new Promise((done) => setTimeout(done, 5));
    const release = holdWaves();
    const a = idleLevels("/tiny/a.mov", 100);
    const b = idleLevels("/tiny/b.mov", 100);
    await tick();
    expect(asked).toEqual([]); // playing: nothing read
    release();
    await tick();
    expect(asked).toEqual(["/tiny/a.mov"]); // one at a time
    const again = holdWaves(); // playback starts: the read stops
    await tick();
    expect(aborts).toEqual(["/tiny/a.mov"]);
    again();
    expect((await a).peak[0]).toBeCloseTo(0.5);
    expect(asked).toEqual(["/tiny/a.mov", "/tiny/a.mov", "/tiny/b.mov"].slice(0, asked.length));
    await b;
    expect(asked).toEqual(["/tiny/a.mov", "/tiny/a.mov", "/tiny/b.mov"]);
    // the same file's levels for anyone else, not read again
    expect(await levels("/tiny/a.mov")).toBe(await a);
    expect(asked).toHaveLength(3);
  });
});
