import { describe, expect, it } from "vitest";
import { blocksIn, gated, tooShort, kPre, kRlb, LoudnessMeter, lowerUnderVoice, lufsToEnergy, merge, normalize, normTarget, speechSpans, type Measured } from "./loudness";
import type { NleTimeline } from "./model";

/**
 * The test signal (stereo, 21 s), the same samples as the WAV ffmpeg measured (EBU numbers below): a 1 kHz tone, noise,
 * silence, a low tone left with a high one right, a pulsing tone, and a tone at a quarter of the rate whose samples miss
 * its peaks (true peak above sample peak).
 */
function signal(sr: number): [Float32Array, Float32Array] {
  const n = sr * 21;
  const l = new Float32Array(n), r = new Float32Array(n);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let a = 0, b = 0;
    if (t < 4) a = b = 0.1 * Math.sin(2 * Math.PI * 1000 * t);
    else if (t < 9) (a = 0.3 * rnd()), (b = 0.15 * rnd());
    else if (t < 11) a = b = 0;
    else if (t < 16) (a = 0.5 * Math.sin(2 * Math.PI * 200 * t)), (b = 0.05 * Math.sin(2 * Math.PI * 5000 * t));
    else if (t < 20) a = b = 0.3 * Math.sin(2 * Math.PI * 300 * t) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t));
    else a = b = 0.9 * Math.sin((Math.PI / 2) * i + Math.PI / 4);
    l[i] = a;
    r[i] = b;
  }
  return [l, r];
}

// ffmpeg 9.0 `-af ebur128=peak=true` on signal(sr) written as a float WAV (2026-11-19): Integrated (LUFS) and True
// peak (dBTP), as it prints them, to 0.1
const EBU: Record<number, { i: number; tp: number }> = {
  48000: { i: -7.9, tp: -0.8 },
  44100: { i: -7.9, tp: -0.8 },
};

/** Fed as an AudioWorklet feeds it: 128 frames at a time. */
function meterOf(sr: number) {
  const [l, r] = signal(sr);
  const m = new LoudnessMeter(sr, 2);
  const blocks: number[] = [];
  m.onBlock = (e) => blocks.push(e);
  for (let i = 0; i < l.length; i += 128) m.process([l.subarray(i, i + 128), r.subarray(i, i + 128)]);
  return { m, blocks };
}

describe("loudness meter (BS.1770-4)", () => {
  it("K-weighting at 48 kHz is the recommendation's table", () => {
    const pre = kPre(48000), rlb = kRlb(48000);
    [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585].forEach((c, i) => expect(pre[i]).toBeCloseTo(c, 10));
    [1, -2, 1, -1.99004745483398, 0.99007225036621].forEach((c, i) => expect(rlb[i]).toBeCloseTo(c, 10));
  });

  it("a 1 kHz tone peaking at -20 dBFS in both channels reads -20 LUFS", () => {
    const sr = 48000;
    const x = Float32Array.from({ length: sr * 5 }, (_, i) => 0.1 * Math.sin((2 * Math.PI * 1000 * i) / sr));
    const m = new LoudnessMeter(sr, 2);
    m.process([x, x]);
    expect(m.integrated).toBeCloseTo(-20, 1);
    expect(m.momentary).toBeCloseTo(-20, 1);
    expect(m.shortTerm).toBeCloseTo(-20, 1);
  });

  for (const sr of [48000, 44100]) {
    it(`Integrated within 0.5 LU and True Peak within 0.3 dB of ffmpeg ebur128 at ${sr} Hz`, () => {
      const { m, blocks } = meterOf(sr);
      expect(Math.abs(m.integrated - EBU[sr]!.i)).toBeLessThan(0.5);
      expect(Math.abs(m.truePeakDb - EBU[sr]!.tp)).toBeLessThan(0.3);
      // the blocks a source keeps give the same integrated value without the histogram
      expect(gated(blocks)).toBeCloseTo(m.integrated, 1);
      // 10 blocks a second, from the fourth sub-block on
      expect(blocks.length).toBe(21 * 10 - 3);
    });
  }

  it("starts over on reset; silence reads nothing", () => {
    const { m } = meterOf(48000);
    m.reset();
    m.process([new Float32Array(48000), new Float32Array(48000)]);
    expect(m.integrated).toBe(-Infinity);
    expect(m.momentary).toBe(-Infinity);
    expect(m.truePeak).toBe(0);
  });
});

const block = (lufs: number) => lufsToEnergy(lufs);
/** a source of `s` seconds at `lufs` throughout */
const flat = (s: number, lufs: number): { blocks: number[] } => ({ blocks: Array.from({ length: s * 10 - 3 }, () => block(lufs)) });

function tl(): NleTimeline {
  return {
    timeline: { fps: 25 },
    sources: { voice: { fps: 25 }, quiet: { fps: 25 }, song: { fps: 25 } },
    tracks: {
      V1: { items: [] },
      A1: { items: [{ src: "voice", rec: 0, len: 250, in: 0, _k: "v1" }, { src: "quiet", rec: 250, len: 250, in: 0, _k: "v2" }] },
      A4: { items: [{ src: "song", rec: 0, len: 500, in: 0, gain_db: -2, _k: "s1" }] },
    },
  };
}

describe("Normalize Audio Levels", () => {
  const m = new Map<string, Measured>([["voice", flat(20, -20)], ["quiet", flat(20, -26)]]);
  it("targets by track", () => {
    expect([normTarget("A1"), normTarget("A4"), normTarget("A2")]).toEqual([-15, -30, -14]);
  });
  it("Independent: each clip to the target", () => {
    const out = normalize(tl(), ["v1", "v2"], -15, false, m);
    expect(out.tracks.A1!.items.map((i) => i.norm_db)).toEqual([5, 11]);
  });
  it("Relative: one gain from both gated together", () => {
    const out = normalize(tl(), ["v1", "v2"], -15, true, m);
    const together = gated([...blocksIn(m.get("voice")!, 0, 10), ...blocksIn(m.get("quiet")!, 0, 10)]);
    const g = Math.round((-15 - together) * 10) / 10;
    expect(out.tracks.A1!.items.map((i) => i.norm_db)).toEqual([g, g]);
  });
  it("leaves a clip not measured as it is", () => {
    const out = normalize(tl(), ["s1"], -30, false, m);
    expect(out.tracks.A4!.items[0]!.norm_db).toBeUndefined();
  });
  it("a clip too short to measure is left as it is, and said so", () => {
    const t = tl();
    const short = new Map<string, Measured>([["voice", { blocks: new Float32Array(0) }], ["quiet", flat(20, -26)]]);
    const out = normalize(t, ["v1", "v2"], -15, false, short);
    expect(out.tracks.A1!.items.map((i) => i.norm_db)).toEqual([undefined, 11]);
    expect(tooShort(t, ["v1", "v2"], short)).toEqual(["v1"]);
    // a clip under 0.4 s of a long source has no whole block either
    t.tracks.A1!.items[1]!.len = 8;
    expect(tooShort(t, ["v1", "v2"], short)).toEqual(["v1", "v2"]);
  });

  it("reads only the blocks the clip plays", () => {
    const two: Measured = { blocks: [...flat(10, -30).blocks, ...flat(10, -10).blocks] };
    const t = tl();
    t.tracks.A1!.items[0]!.in = 250; // from 10 s on: the loud half
    const out = normalize(t, ["v1"], -14, false, new Map([["voice", two]]));
    expect(out.tracks.A1!.items[0]!.norm_db).toBeCloseTo(-4, 0);
  });
});

describe("Lower Under Voice", () => {
  it("speech from words, in timeline frames", () => {
    const spans = speechSpans(tl(), new Map([["voice", [[1, 2], [2.1, 3], [30, 31]]], ["quiet", [[0, 1]]]]), new Map());
    // voice from 0, quiet from frame 250; a word outside the clip is left out
    expect(spans).toEqual([[25, 50], [52.5, 75], [250, 275]]);
  });

  it("speech from a level gate when there are no words", () => {
    const loud = flat(4, -20).blocks;
    const m = new Map<string, Measured>([["voice", { blocks: [...loud.slice(0, 20), ...Array(20).fill(block(-60)), ...loud.slice(0, 20)] }]]);
    const spans = speechSpans(tl(), new Map(), m);
    // blocks 0–19 (0–2.3 s) and 40–59 (4–6.3 s) speak
    expect(spans).toEqual([[0, 57.5], [100, 157.5]]);
  });

  it("volume keys around each span, back to the clip's own gain; a short gap stays down", () => {
    const out = lowerUnderVoice(tl(), "A4", [[100, 200], [205, 210], [400, 450]], { amount: -12, attackMs: 200, releaseMs: 400 });
    const keys = out.tracks.A4!.items[0]!.keys!.gain_db!;
    expect(keys.map((k) => [k[0], k[1]])).toEqual([[95, -2], [100, -14], [210, -14], [220, -2], [395, -2], [400, -14], [450, -14], [460, -2]]);
    expect(keys.every((k) => k[2] === "linear")).toBe(true);
  });

  it("replaces earlier volume keys, never on A1 or a locked track", () => {
    const t = tl();
    t.tracks.A4!.items[0]!.keys = { gain_db: [[10, 0, "linear"]], zoom: [[0, 1, "ease"]] };
    const out = lowerUnderVoice(t, "A4", [[100, 120]]);
    expect(out.tracks.A4!.items[0]!.keys!.gain_db!.some((k) => k[0] === 10)).toBe(false);
    expect(out.tracks.A4!.items[0]!.keys!.zoom).toEqual([[0, 1, "ease"]]);
    t.tracks.A4!.locked = true;
    expect(lowerUnderVoice(t, "A4", [[100, 120]])).toBe(t);
  });

  it("no speech or A1 as the target: the timeline as it was, its keys kept", () => {
    const t = tl();
    t.tracks.A4!.items[0]!.keys = { gain_db: [[10, 0, "linear"]] };
    expect(lowerUnderVoice(t, "A4", [])).toBe(t);
    expect(lowerUnderVoice(t, "A1", [[100, 120]])).toBe(t);
  });

  it("attack and release of 0 still ramp over a frame, so the clip comes back up after the speech", () => {
    const keys = lowerUnderVoice(tl(), "A4", [[100, 200], [300, 350]], { amount: -12, attackMs: 0, releaseMs: 0 }).tracks.A4!.items[0]!.keys!.gain_db!;
    expect(keys.map((k) => [k[0], k[1]])).toEqual([[99, -2], [100, -14], [200, -14], [201, -2], [299, -2], [300, -14], [350, -14], [351, -2]]);
  });

  it("merge joins spans closer than the gap", () => {
    expect(merge([[10, 20], [0, 5], [22, 30]], 2)).toEqual([[0, 5], [10, 30]]);
  });
});
