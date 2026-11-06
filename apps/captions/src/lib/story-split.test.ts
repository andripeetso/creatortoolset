import { describe, expect, it } from "vitest";
import { analyse, crc32, planCuts, snapCut, zipStored, type Analysis, type Spot } from "./story-split";

const HZ = 100;
const loud = (seconds: number, level = 0.9) => new Float32Array(seconds * HZ).fill(level);
const clip = (duration: number, spots: Spot[], energy = loud(duration)): Analysis => ({
  duration,
  energy,
  spots,
  shots: 0,
  pauses: 0,
  bpm: null,
});

describe("story splitter", () => {
  it("finds hard cuts, pauses and a beat", () => {
    const frames = Array.from({ length: 30 * 30 }, (_, i) => ({ t: i / 30, diff: i === 300 ? 0.2 : 0.004 }));
    // speech: short, irregular gaps between words, and one 0.6 s pause
    const db = new Float32Array(30 * HZ).fill(-20);
    for (let i = 0, seed = 7; i < db.length; i += 25 + (seed % 40)) {
      db.fill(-50, i, i + 8);
      seed = (seed * 48271) % 2147483647;
    }
    db.fill(-50, 20 * HZ, 20.6 * HZ);
    const a = analyse({ duration: 30, frames, db });
    expect(a.spots.find((s) => s.why === "shot")?.t).toBe(10);
    expect(a.spots.find((s) => s.why === "pause")?.t).toBeCloseTo(20.3, 1);
    expect(a.bpm).toBeNull();

    const beat = new Float32Array(30 * HZ).fill(-40);
    for (let i = 0; i < beat.length; i += 50) beat.fill(-10, i, i + 5);
    expect(analyse({ duration: 30, frames, db: beat }).bpm).toBe(120);
  });

  it("cuts at the best spots near the target length, through the owner's cuts", () => {
    const a = clip(60, [
      { t: 19, score: 1, why: "pause" },
      { t: 30, score: 0.8, why: "shot" },
      { t: 41, score: 1, why: "pause" },
    ]);
    expect(planCuts(a, 20)).toEqual([19, 41]);
    expect(planCuts(a, 20, [30])).toEqual([19, 30, 41]);
    expect(planCuts(clip(25, []), 20)).toEqual([]);
    expect(snapCut(a, 17.5)).toBe(19);
    expect(snapCut(a, 25)).toBe(25); // nothing good within reach: stays where asked

    const long = planCuts(clip(200, [], loud(200, 0)), 20);
    const lengths = [0, ...long, 200].slice(1).map((t, i, all) => t - (i ? all[i - 1] : 0));
    expect(Math.max(...lengths)).toBeLessThanOrEqual(21);
    expect(Math.min(...lengths)).toBeGreaterThanOrEqual(19);
  });

  it("zips the stories so an unzipper finds each file", async () => {
    expect(crc32(new TextEncoder().encode("hello"))).toBe(0x3610a686);
    const files = [
      { name: "a-01.mp4", data: new TextEncoder().encode("first") },
      { name: "a-02.mp4", data: new TextEncoder().encode("second story") },
    ];
    const zip = new DataView(await zipStored(files).arrayBuffer());
    const end = zip.byteLength - 22;
    expect(zip.getUint32(end, true)).toBe(0x06054b50);
    expect(zip.getUint16(end + 10, true)).toBe(2);
    let at = zip.getUint32(end + 16, true);
    for (const f of files) {
      expect(zip.getUint32(at, true)).toBe(0x02014b50);
      const local = zip.getUint32(at + 42, true);
      const nameLen = zip.getUint16(local + 26, true);
      const data = new Uint8Array(zip.buffer, local + 30 + nameLen, zip.getUint32(local + 18, true));
      expect(new TextDecoder().decode(data)).toBe(new TextDecoder().decode(f.data));
      expect(crc32(data)).toBe(zip.getUint32(at + 16, true));
      at += 46 + zip.getUint16(at + 28, true);
    }
  });
});
