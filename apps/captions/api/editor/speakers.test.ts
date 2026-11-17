import { describe, expect, it } from "vitest";
import { alignFace, follow, frontal, mouthPatch, runsOf, samePeople, turnsOf, type SeenFrame } from "./speakers";

/** Frames 10 a second with two faces; in each run of words [start, end, face] that face's mouth moves (0: neither's). */
function scene(to: number, runs: [number, number, number][]): SeenFrame[] {
  const frames: SeenFrame[] = [];
  for (let i = 0; i / 10 <= to; i++) {
    const t = i / 10;
    const jitter = 0.05 + 0.03 * ((i * 7) % 5) / 5; // landmarks are never still
    const who = runs.find(([s, e]) => t >= s && t <= e)?.[2];
    frames.push({ t, faces: [1, 2].map((id) => ({ x: id === 1 ? 0.2 : 0.6, y: 0.3, w: 0.1, h: 0.15, id, mouth: jitter + (who === id ? 0.3 + 0.2 * ((i * 3) % 4) / 4 : 0) })) });
  }
  return frames;
}
const said = (spans: [number, number, number][]) => spans.flatMap(([s, e]) => Array.from({ length: Math.round((e - s) / 0.25) }, (_, i) => ({ s: s + i * 0.25, e: s + i * 0.25 + 0.2 })));

describe("who talks when", () => {
  it("groups words into runs at pauses", () => {
    expect(runsOf([{ s: 0, e: 0.3 }, { s: 0.4, e: 0.8 }, { s: 1.5, e: 2 }])).toEqual([[0, 0.8], [1.5, 2]]);
  });

  it("finds each turn from whose mouth moves, numbered in the order they first talk", () => {
    const runs: [number, number, number][] = [[0, 3.8, 2], [4.3, 8.2, 1], [8.8, 12, 2]];
    const { turns, tracks } = turnsOf(scene(12, runs), said(runs));
    expect(turns.map((x) => x.speaker)).toEqual([1, 2, 1]);
    expect(tracks).toEqual({ 1: [2], 2: [1] });
    expect(turns[1]).toMatchObject({ s: 4.3, e: 8.25 });
  });

  it("says nobody on screen when words are heard and no mouth moves", () => {
    const runs: [number, number, number][] = [[0, 2.8, 1], [3.4, 6, 0]];
    const { turns } = turnsOf(scene(6, runs), said(runs));
    expect(turns.map((x) => x.speaker)).toEqual([1, 0]);
  });

  it("gives a short answer between two long ones its own turn, and keeps one face's twitch in another's run with the talker", () => {
    const runs: [number, number, number][] = [[0, 3.8, 1], [4.3, 6, 2], [6.5, 9, 1]];
    expect(turnsOf(scene(9, runs), said(runs)).turns.map((x) => x.speaker)).toEqual([1, 2, 1]);
    // face 2 moves its mouth for 0.3 s inside face 1's run: still face 1's
    const frames = scene(9, [[0, 9, 1]]).map((f) => (f.t >= 4 && f.t < 4.3 ? { ...f, faces: f.faces.map((x) => (x.id === 2 ? { ...x, mouth: 0.6 } : x)) } : f));
    expect(turnsOf(frames, said([[0, 9, 1]])).turns.map((x) => x.speaker)).toEqual([1]);
  });

  it("follows each face from frame to frame and measures its mouth only against its own last frame, at steadied points", () => {
    const tracks = new Map();
    const next = { id: 1 };
    // the patch read is the mouth corner's x: the change seen is how far the read point moved
    const read = (k: number[]) => new Float32Array(4).fill(k[6]!);
    const face = (x: number, mouthX: number) => ({ x, y: 0.1, w: 0.1, h: 0.1, kps: [0, 0, 10, 0, 5, 5, 0, 10, 10, 10].map((v, i) => (i === 6 ? mouthX : v)) });
    const a = follow(0, [face(0.1, 0), face(0.6, 0)], tracks, next, read);
    const b = follow(0.1, [face(0.61, 10), face(0.11, 0)], tracks, next, read);
    expect(a.map((f) => [f.id, f.mouth])).toEqual([[1, undefined], [2, undefined]]);
    // face 2's point jumped 10 px: the track takes STEADY of it
    expect(b.map((f) => [f.id, f.mouth])).toEqual([[2, 3], [1, 0]]);
    // a face far from every track starts a new one
    expect(follow(0.2, [{ x: 0.9, y: 0.8, w: 0.05, h: 0.05 }], tracks, next)[0]!.id).toBe(3);
  });

  it("reads the mouth patch turned with the eyes, the same for a brighter picture", () => {
    const w = 64;
    const h = 64;
    const px = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.fill((x * 3 + y * 5) % 200, (y * w + x) * 3, (y * w + x) * 3 + 3);
    const bright = px.map((v) => Math.min(255, v + 40));
    const kps = [20, 20, 40, 20, 30, 30, 22, 40, 38, 40];
    const p = mouthPatch(px, w, h, kps);
    const q = mouthPatch(bright, w, h, kps);
    expect(Math.max(...p.map((v, i) => Math.abs(v - q[i]!)))).toBeLessThan(0.05);
    expect(p.reduce((n, v) => n + v, 0) / p.length).toBeCloseTo(0, 5);
  });
});

describe("one person across camera cuts", () => {
  const look = (...v: number[]) => {
    const x = new Float32Array(v);
    const n = Math.hypot(...x);
    return x.map((y) => y / n);
  };

  it("joins tracks that read alike, never two on screen together, each to its first track", () => {
    const looks = new Map([[1, look(1, 0, 0)], [2, look(0, 1, 0)], [5, look(0.95, 0.1, 0)], [7, look(0.1, 0.97, 0)], [9, look(0, 0, 1)]]);
    const person = samePeople(looks, new Set(["2-5"]));
    expect([...person]).toEqual([[1, 1], [2, 2], [5, 1], [7, 2], [9, 9]]);
    // 5 is on screen with 1: they stay two people, and 7 (like both) joins only one of them
    const apart = samePeople(new Map([[1, look(1, 0, 0)], [5, look(0.95, 0.1, 0)], [7, look(0.97, 0.05, 0)]]), new Set(["1-5"]));
    expect(apart.get(5)).not.toBe(apart.get(1));
    expect([apart.get(5), apart.get(1)]).toContain(apart.get(7));
  });

  it("numbers one person's tracks as one speaker, the turns found by person", () => {
    const runs: [number, number, number][] = [[0, 3.8, 1], [4.3, 8.2, 2], [8.8, 12, 1]];
    // after a cut at 6 s face 1 is seen again as track 3, the same person
    const frames = scene(12, runs).map((f) => (f.t >= 6 ? { ...f, faces: f.faces.map((x) => (x.id === 1 ? { ...x, id: 3, who: 1 } : x)) } : f));
    const { turns, tracks } = turnsOf(frames, said(runs));
    expect(turns.map((x) => x.speaker)).toEqual([1, 2, 1]);
    expect(tracks).toEqual({ 1: [1, 3], 2: [2] });
  });

  it("lays a face's five points on the model's template", () => {
    // a 200 × 200 picture, black but for bright dots where the points are, the face turned 30° and twice the template's size
    const [w, h] = [200, 200];
    const px = new Uint8Array(w * h * 3);
    const T = [38.2946, 51.6963, 73.5318, 51.5014, 56.0252, 71.7366, 41.5493, 92.3655, 70.7299, 92.2041];
    const [c, s] = [Math.cos(Math.PI / 6) * 2, Math.sin(Math.PI / 6) * 2];
    const kps = Array.from({ length: 5 }, (_, k) => [c * (T[2 * k]! - 56) - s * (T[2 * k + 1]! - 72) + 100, s * (T[2 * k]! - 56) + c * (T[2 * k + 1]! - 72) + 100]).flat();
    for (let k = 0; k < 5; k++)
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) px.fill(255, ((Math.round(kps[2 * k + 1]!) + dy) * w + Math.round(kps[2 * k]!) + dx) * 3, ((Math.round(kps[2 * k + 1]!) + dy) * w + Math.round(kps[2 * k]!) + dx) * 3 + 3);
    const out = alignFace(px, w, h, kps);
    for (let k = 0; k < 5; k++) expect(out[Math.round(T[2 * k + 1]!) * 112 + Math.round(T[2 * k]!)]).toBeGreaterThan(200);
    expect(out[10 * 112 + 10]).toBe(0);
    expect(frontal(kps)).toBe(true);
    expect(frontal([0, 0, 10, 0, 12, 5, 0, 10, 10, 10])).toBe(false); // the nose past an eye: a profile
  });
});
