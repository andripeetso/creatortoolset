import type { InferenceSession } from "onnxruntime-node";
import { describe, expect, it } from "vitest";
import { cutModel, cutsFromModel, modelWindows, TH, TW } from "./cuts";
import { shotsOf, type PictureRead } from "./look";

const F = TW * TH * 3;

describe("cutsFromModel", () => {
  const at = (n: number, on: Record<number, number>) => Array.from({ length: n }, (_, i) => on[i] ?? 0.01);
  it("puts a hard cut on the frame after the one the model marks, as cutsOf does", () => {
    expect(cutsFromModel(at(300, { 59: 0.97 }), at(300, {}), 30)).toEqual([60]);
  });
  it("puts a dissolve's cut after its most likely frame, and reads either output", () => {
    expect(cutsFromModel(at(300, { 100: 0.6, 101: 0.7 }), at(300, { 102: 0.9, 103: 0.8, 104: 0.55 }), 30)).toEqual([103]);
  });
  it("keeps one of two cuts closer than a shot, and none at either end", () => {
    expect(cutsFromModel(at(300, { 3: 0.9, 100: 0.9, 104: 0.9, 296: 0.9 }), at(300, {}), 30)).toEqual([101]);
  });
});

describe("modelWindows", () => {
  it("shows the model 100 frames at a time, padded with the first and last, and keeps every frame's answer", async () => {
    const seen: number[][] = [];
    // a fake model whose answer for each frame is that frame's own value (frames are filled with their number)
    const session = {
      inputNames: ["input"],
      outputNames: ["one", "many"],
      run: async (feeds: Record<string, { data: Float32Array }>) => {
        const x = feeds.input!.data;
        const vals = Array.from({ length: 100 }, (_, j) => x[j * F]!);
        seen.push(vals);
        const v = Float32Array.from(vals);
        return { one: { data: v }, many: { data: v.map((y) => -y) } };
      },
    } as unknown as InferenceSession;
    const w = modelWindows(session);
    const n = 137;
    for (let i = 0; i < n; i++) w.push(Buffer.alloc(F, i));
    const { one, many } = await w.end();
    expect(one).toEqual(Array.from({ length: n }, (_, i) => i));
    expect(many[10]).toBe(-10);
    expect(seen).toHaveLength(3);
    expect(seen[0]!.slice(0, 26)).toEqual([...Array(25).fill(0), 0]);
    expect(seen[2]!.slice(-1)).toEqual([n - 1]);
  });
  it("throws a failed run at the end", async () => {
    const session = { inputNames: ["input"], outputNames: ["one", "many"], run: async () => Promise.reject(new Error("out of memory")) } as unknown as InferenceSession;
    const w = modelWindows(session);
    for (let i = 0; i < 120; i++) w.push(Buffer.alloc(F));
    await expect(w.end()).rejects.toThrow("out of memory");
  });
});

it("cutModel stays off where it is turned off (the tests) or there is no NVIDIA card on Linux", async () => {
  expect(await cutModel()).toBeNull();
});

it("shotsOf takes the model's cuts when the read has them", () => {
  const n = 300;
  const read: PictureRead = { fps: 30, step: new Float32Array(n).fill(0.01), cut: new Float32Array(n), lag: new Float32Array(n), cuts: [120] };
  read.cut[200] = 5; // a jump cutsOf would cut at
  expect(shotsOf(read, 10).map((s) => [s.a, s.b])).toEqual([
    [0, 4],
    [4, 10],
  ]);
});
