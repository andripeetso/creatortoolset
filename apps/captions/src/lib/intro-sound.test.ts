import { describe, expect, it } from "vitest";
import { BEATS } from "@/components/HomeIntro";
import { CEILING, hitsFor, introSound, step } from "./intro-sound";

const n = { stages: 3, tiles: 6, extras: 7, chips: 4 };

describe("the welcome's sound", () => {
  it("has one note for each thing that pops in", () => {
    const notes = (beat: (typeof BEATS)[number]["id"], counts = n) => hitsFor(beat, counts).filter((h) => h.kind === "note").length;
    expect(notes("hello")).toBe("CreatorToolset".length);
    expect(notes("stages")).toBe(3);
    expect(notes("tools")).toBe(6 + 7);
    expect(notes("tools", { stages: 3, tiles: 4, extras: 2, chips: 0 })).toBe(6);
    // a Home with one box switched off: two stages pop up, two boxes open
    expect(notes("stages", { ...n, stages: 2 })).toBe(2);
    expect(hitsFor("tools", { ...n, stages: 2 }).filter((h) => h.kind === "thud")).toHaveLength(2);
    expect(notes("connect")).toBe(4);
    expect(hitsFor("tools", n).filter((h) => h.kind === "thud")).toHaveLength(3); // a box opening, three boxes
  });

  it("starts every sound inside its own beat, so a shorter beat never leaves a sound for the next", () => {
    for (const b of BEATS) for (const h of hitsFor(b.id, n)) expect(h.at).toBeLessThan(b.ms / 1000);
  });

  it("climbs: each run of notes goes up the scale", () => {
    expect(step(0)).toBeCloseTo(293.66);
    expect(step(5)).toBeCloseTo(587.32);
    expect(step(-5)).toBeCloseTo(146.83);
    // nothing bright: no note is written above D5 except the quick run over the Extras
    for (const b of BEATS) for (const h of hitsFor(b.id, { ...n, extras: 0 })) for (const hz of h.kind === "note" ? [h.hz] : h.kind === "bell" ? h.hz : []) expect(hz).toBeLessThan(1000);
    for (const beat of ["hello", "tools", "connect"] as const) {
      const hz = hitsFor(beat, n).flatMap((h) => (h.kind === "note" ? [h.hz] : []));
      const tiles = beat === "tools" ? hz.slice(0, n.tiles) : hz;
      expect([...tiles].sort((a, b) => a - b)).toEqual(tiles);
    }
  });
});

/**
 * A stand-in audio context that only writes down what is asked of it: every gain made, what its value was when its
 * first timed step was set, and every time anything was timed for. Enough to check how the sounds start.
 */
function fakeContext(now: number) {
  const times: number[] = [];
  const gains: { atFirstStep: number | null }[] = [];
  const param = (value: number, seen?: { atFirstStep: number | null }) => {
    const p = {
      value,
      ...Object.fromEntries(
        ["setValueAtTime", "linearRampToValueAtTime", "exponentialRampToValueAtTime", "setTargetAtTime", "cancelScheduledValues"].map((m) => [
          m,
          (...a: number[]) => {
            times.push(m === "cancelScheduledValues" ? a[0]! : a[1]!);
            if (seen && seen.atFirstStep === null) seen.atFirstStep = p.value;
          },
        ]),
      ),
    };
    return p;
  };
  const node = <T extends object>(more: T) => {
    const made = { ...more, connect: (to: unknown) => ((to === ctx.destination ? (ctx.last = made) : 0), to) };
    return made;
  };
  const timed = () => ({ start: (t: number) => void times.push(t), stop: () => {} });
  const ctx = {
    currentTime: now,
    sampleRate: 100,
    destination: {},
    last: null as object | null,
    createGain: () => {
      const seen = { atFirstStep: null as number | null };
      gains.push(seen);
      return node({ gain: param(1, seen) });
    },
    createOscillator: () => node({ type: "sine", frequency: param(440), ...timed() }),
    createBufferSource: () => node({ buffer: null, ...timed() }),
    createBiquadFilter: () => node({ type: "lowpass", Q: param(1), frequency: param(350) }),
    createDynamicsCompressor: () => node({ threshold: param(-24), ratio: param(12) }),
    createConvolver: () => node({ buffer: null }),
    createWaveShaper: () => node({ curve: null as Float32Array | null }),
    createBuffer: (_ch: number, length: number) => ({ getChannelData: () => new Float32Array(length) }),
  };
  return { ctx, times, gains };
}

describe("the welcome's sound, played live", () => {
  // 2026-11-10: a held chord came out at more than four times full scale in WebKit, because its fade-in was timed for
  // "now" and so began from a gain's default, which is full volume
  it("starts no sound from a gain's default (full volume), and times nothing for now or earlier", () => {
    const { ctx, times, gains } = fakeContext(10);
    const score = introSound(ctx as unknown as BaseAudioContext);
    BEATS.forEach((b, i) => score.beat(b.id, n, { len: b.ms / 1000, last: i === BEATS.length - 1 }));
    score.end();
    const stepped = gains.filter((g) => g.atFirstStep !== null);
    expect(stepped.length).toBeGreaterThan(40);
    for (const g of stepped) expect(g.atFirstStep).not.toBe(1);
    for (const t of times) expect(t).toBeGreaterThan(10);
  });

  it("puts a hard ceiling last before the speakers", () => {
    const { ctx } = fakeContext(0);
    introSound(ctx as unknown as BaseAudioContext);
    const curve = (ctx.last as { curve?: Float32Array } | null)?.curve;
    expect(curve).toBeInstanceOf(Float32Array);
    expect(Math.max(...curve!)).toBeCloseTo(CEILING);
    expect(Math.min(...curve!)).toBeCloseTo(-CEILING);
    expect(curve![1024 + 512]).toBeCloseTo(0.5); // under the ceiling it passes sound as it is
  });
});
