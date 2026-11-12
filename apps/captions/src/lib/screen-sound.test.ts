import { describe, expect, it } from "vitest";
import { TrackReader, VoiceMono, heardTracks, soundTracks, stereoMix, type SoundChunk } from "./screen-sound";
import { normalizeLook, type ScreenEvents } from "./screen-recording";

const fill = (n: number, v: number) => new Float32Array(n).fill(v);

describe("screen recording sound", () => {
  it("finds the voice and the recorded sound among the file's tracks", () => {
    expect(soundTracks({ audio: ["mic", "system"] })).toEqual({ voice: 0, sound: 1 });
    expect(soundTracks({ audio: ["system"] })).toEqual({ voice: null, sound: 0 });
    expect(soundTracks({ audio: ["mic", "device"] })).toEqual({ voice: 0, sound: 1 }); // an iPhone's sound
    expect(soundTracks({})).toEqual({ voice: 0, sound: null }); // a log from before the tracks were named
    expect(heardTracks({ voice: false }, { audio: ["mic", "system"] })).toEqual({ voice: null, sound: 1 });
    expect(heardTracks({ sound: false }, { audio: ["mic", "system"] })).toEqual({ voice: 0, sound: null });
    expect(heardTracks({}, { audio: ["mic"] })).toEqual({ voice: 0, sound: null });
  });

  it("keeps the switches of a saved look", () => {
    const events: ScreenEvents = { v: 1, width: 100, height: 100, moves: [], clicks: [], audio: ["mic", "system"] };
    expect(normalizeLook({ voice: false, sound: true }, events, 10)).toMatchObject({ voice: false, sound: true });
    const plain = normalizeLook(null, events, 10);
    expect(heardTracks(plain, events)).toEqual({ voice: 0, sound: 1 }); // a new recording: everything recorded is heard
  });

  it("puts the voice in both ears from the channels that carry it, at its own level", () => {
    const n = 64;
    // an interface: the voice on one input, the other empty (the owner's recordings until the voice went mono)
    expect([...new VoiceMono().mix([fill(n, 0.5), fill(n, 0)])].every((s) => Math.abs(s - 0.5) < 1e-6)).toBe(true);
    expect([...new VoiceMono().mix([fill(n, 0), fill(n, 0.5)])].every((s) => Math.abs(s - 0.5) < 1e-6)).toBe(true);
    // the same voice on both: once
    expect([...new VoiceMono().mix([fill(n, 0.5), fill(n, 0.5)])].every((s) => Math.abs(s - 0.5) < 1e-6)).toBe(true);
    // one channel: as it is
    expect([...new VoiceMono().mix([fill(n, 0.3)])].every((s) => Math.abs(s - 0.3) < 1e-6)).toBe(true);
    // an empty input's hum stays out once the voice is heard
    const voice = new VoiceMono();
    voice.mix([fill(n, 0.003), fill(n, 0.002)]);
    expect([...voice.mix([fill(n, 0.5), fill(n, 0.002)])].every((s) => Math.abs(s - 0.5) < 1e-6)).toBe(true);
    // the mix: the voice in both ears, the recorded sound in its own
    const [l, r] = stereoMix(fill(n, 0.25), [fill(n, 0.5), fill(n, 0.125)], n);
    expect([l[0], r[0]]).toEqual([0.75, 0.375]);
    expect(stereoMix(fill(n, 0.25), null, n).map((ear) => ear[0])).toEqual([0.25, 0.25]);
    expect(stereoMix(null, [fill(n, 0.5)], n).map((ear) => ear[0])).toEqual([0.5, 0.5]);
    expect(stereoMix(fill(n, 0.8), [fill(n, 0.8), fill(n, -0.9)], n).map((ear) => ear[0])).toEqual([1, expect.closeTo(-0.1)]);
  });

  it("reads a track by time across the stretches it was decoded in, silent where it has nothing", async () => {
    // stretches of 10 frames at 10 frames a second, each frame's value its own time
    const chunks: SoundChunk[] = [0, 1, 2].map((s) => ({
      at: s,
      rate: 10,
      planes: [Float32Array.from({ length: 10 }, (_, i) => s + i / 10), Float32Array.from({ length: 10 }, (_, i) => -(s + i / 10))],
    }));
    let asked = 0;
    const reader = new TrackReader(async () => chunks[asked++] ?? null, 2);
    const [l, r] = await reader.read(0.5, 10, 10); // 0.5 to 1.5: across two stretches
    expect([...l].map((v) => Math.round(v * 10) / 10)).toEqual([0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4]);
    expect(r[0]).toBeCloseTo(-0.5);
    expect(asked).toBe(2); // read no further than needed
    const [tail] = await reader.read(2.5, 10, 10); // past the end: silent
    expect([...tail].map((v) => Math.round(v * 10) / 10)).toEqual([2.5, 2.6, 2.7, 2.8, 2.9, 0, 0, 0, 0, 0]);
    // a one-channel track read as two gives the same channel twice
    const mono = new TrackReader(async () => (asked++ < 10 ? { at: 0, rate: 10, planes: [fill(10, 0.4)] } : null), 2);
    const [a, b] = await mono.read(0, 5, 10);
    expect([a[0], b[0]]).toEqual([expect.closeTo(0.4), expect.closeTo(0.4)]);
  });
});
