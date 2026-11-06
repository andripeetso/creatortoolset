import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { field1, frame, lagOf, readWav, SR, studioVoice, unfield1, unframe, wav16 } from "./nvidia-voice";

describe("NVIDIA Studio Voice client", () => {
  it("encodes the one bytes field both ways and gRPC's frames", () => {
    for (const n of [0, 5, 127, 128, 65536, 300_000]) {
      const data = Buffer.alloc(n, 7);
      expect(unfield1(field1(data)).equals(data)).toBe(true);
    }
    const msgs = [Buffer.from("a"), Buffer.alloc(70_000, 1), Buffer.from("xyz")];
    expect(unframe(Buffer.concat(msgs.map(frame))).map((m) => m.length)).toEqual([1, 70_000, 3]);
  });

  it("writes and reads a mono 16-bit WAV", () => {
    const x = new Float32Array([0, 0.5, -0.5, 0.25]);
    const back = readWav(wav16(x));
    expect(back.sr).toBe(SR);
    expect(Array.from(back.x).map((v) => Math.round(v * 100) / 100)).toEqual([0, 0.5, -0.5, 0.25]);
  });

  it("finds how late the answer runs from the voice's rhythm", () => {
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    const x = new Float32Array(SR * 20);
    for (let s = 0; s < 200; s++) {            // speech-like bursts: 100 ms on or off
      const on = rnd() > -0.2;
      for (let k = 0; k < SR / 10; k++) x[s * (SR / 10) + k] = on ? rnd() * 0.5 : rnd() * 0.001;
    }
    const late = new Float32Array(x.length);
    late.set(x.subarray(0, x.length - 6960), 6960); // 145 ms, as NVIDIA
    expect(Math.abs(lagOf(x, late) - 6960)).toBeLessThanOrEqual(48);
    expect(lagOf(x, x)).toBe(0);
  });

  // NVIDIA_LIVE=<a mono 48 kHz WAV> with NVIDIA_API_KEY set: the real service, lined up
  it.runIf(!!process.env.NVIDIA_LIVE && !!process.env.NVIDIA_API_KEY)("enhances a real file, same length, on time", async () => {
    const { x } = readWav(readFileSync(process.env.NVIDIA_LIVE!));
    const y = await studioVoice(process.env.NVIDIA_API_KEY!, x);
    expect(y.length).toBe(x.length);
    expect(lagOf(x, y)).toBeLessThanOrEqual(48);
  }, 120_000);
});
