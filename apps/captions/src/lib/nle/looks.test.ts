import { describe, expect, it, vi } from "vitest";
import { convert, cube, readCube } from "@contracts/camera";
import { gradeOf, hasLook, lutOf } from "./looks";

describe("the camera conversion's table", () => {
  it("is the engine's own .cube for a curve, read back (the same 33 points)", () => {
    const t = lutOf({ curve: "slog3", on: true }, () => {})!;
    const want = readCube(cube(convert("slog3")));
    expect("error" in want).toBe(false);
    expect(t.size).toBe(33);
    expect(t.values).toEqual((want as { values: Float32Array }).values);
    expect(lutOf({ curve: "slog3", on: false }, () => {})).toBeNull();
    expect(lutOf({ curve: "notacurve", on: true }, () => {})).toBeNull();
  });

  it("fetches an added LUT once, draws again when it lands, and refuses one with a 1D shaper", async () => {
    const get = vi.fn(async (url: string) => new Response(url.includes("lut_aaaaaaaaaaaa") ? "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n" : "LUT_1D_SIZE 2\n0 0 0\n1 1 1\n"));
    const loaded = vi.fn();
    const good = { lut: "lut_aaaaaaaaaaaa", on: true };
    expect(lutOf(good, loaded, get as unknown as typeof fetch)).toBeNull();
    expect(lutOf(good, loaded, get as unknown as typeof fetch)).toBeNull(); // still loading: not asked twice
    await vi.waitFor(() => expect(loaded).toHaveBeenCalledTimes(1));
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toBe("/api/edit-steps/luts/lut_aaaaaaaaaaaa");
    expect(lutOf(good, loaded, get as unknown as typeof fetch)?.size).toBe(2);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const shaper = { lut: "lut_bbbbbbbbbbbb", on: true };
    lutOf(shaper, loaded, get as unknown as typeof fetch);
    await vi.waitFor(() => expect(loaded).toHaveBeenCalledTimes(2));
    expect(lutOf(shaper, loaded, get as unknown as typeof fetch)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("whether a picture takes a colour change", () => {
  it("the camera conversion only on a log file (not said = log, as an original), a grade unless neutral", () => {
    const cam = { curve: "slog3", on: true };
    expect(hasLook(cam, undefined, undefined)).toBe(true);
    expect(hasLook(cam, true, undefined)).toBe(true);
    expect(hasLook(cam, false, undefined)).toBe(false); // a 709 proxy: no double conversion
    expect(hasLook({ ...cam, on: false }, undefined, undefined)).toBe(false);
    expect(hasLook(undefined, false, { sat: 1.2 })).toBe(true);
    expect(hasLook(undefined, undefined, { sat: 1, gain: [1, 1, 1] })).toBe(false);
    expect(gradeOf({ lift: [0, 0, 0] })).toBeNull();
    expect(gradeOf({ gamma: [0.1, 0, 0] })?.power[0]).toBeCloseTo(2 ** -0.1);
  });
});
