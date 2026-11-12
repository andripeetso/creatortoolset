import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "editor-eyeline-"));
process.env.DATA_DIR = dir;

const { eyelineOf, eyesOf, saneEyeline } = await import("./eyeline");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** YuNet's outputs with nothing found, plus `faces` on the stride-32 grid: [row, col, score, box side (log), eyes' row offset]. */
function outputs(faces: [number, number, number, number, number][]) {
  const out: Record<string, { data: Float32Array }> = {};
  for (const s of [8, 16, 32]) {
    const n = (640 / s) ** 2;
    out[`cls_${s}`] = { data: new Float32Array(n) };
    out[`obj_${s}`] = { data: new Float32Array(n) };
    out[`bbox_${s}`] = { data: new Float32Array(n * 4) };
    out[`kps_${s}`] = { data: new Float32Array(n * 10) };
  }
  for (const [r, c, score, side, dy] of faces) {
    const i = r * 20 + c;
    out.cls_32!.data[i] = score;
    out.obj_32!.data[i] = score;
    out.bbox_32!.data.set([0, 0, side, side], i * 4);
    out.kps_32!.data.set([0, dy, 0.5, dy], i * 10);
  }
  return out;
}

describe("eye line", () => {
  it("keeps only a line in the sane band", () => {
    expect([0.1, 0.15, 0.38, 0.6, 0.65, null].map(saneEyeline)).toEqual([null, 0.15, 0.38, 0.6, null, null]);
  });

  it("reads the eyes of the biggest face sure enough to count", () => {
    expect(eyesOf(outputs([]))).toBeNull();
    expect(eyesOf(outputs([[5, 3, 0.5, 2, 0]]))).toBeNull(); // below the score
    // the eyes' row: (0.5 + 5) × 32
    expect(eyesOf(outputs([[5, 3, 0.9, 2, 0.5]]))).toBe(176);
    expect(eyesOf(outputs([[5, 3, 0.9, 1, 0.5], [9, 3, 0.7, 2, 0]]))).toBe(288);
  });

  it("is found once per version and kept, no face too; a failure is not kept; never off this computer", async () => {
    const dims = { w: 1080, h: 1920, duration: 6 };
    const src = async () => "/clip.mov";
    const find = vi.fn(async () => 0.31);
    expect(await eyelineOf("ver_x", src, dims, undefined, find)).toBeNull(); // not this computer
    expect(find).not.toHaveBeenCalled();
    process.env.CT_LOCAL = "1";
    try {
      expect(await eyelineOf("ver_x", src, dims, undefined, find)).toBe(0.31);
      expect(await eyelineOf("ver_x", src, dims, undefined, find)).toBe(0.31);
      expect(find).toHaveBeenCalledTimes(1);
      const none = vi.fn(async () => null);
      expect(await eyelineOf("ver_none", src, dims, undefined, none)).toBeNull();
      expect(await eyelineOf("ver_none", src, dims, undefined, none)).toBeNull();
      expect(none).toHaveBeenCalledTimes(1);
      // found, but too low for a speaker's eyes: kept, and the default stays
      expect(await eyelineOf("ver_low", src, dims, undefined, async () => 0.7)).toBeNull();
      const fails = vi.fn(async (): Promise<number | null> => {
        throw new Error("offline");
      });
      vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(await eyelineOf("ver_fail", src, dims, undefined, fails)).toBeNull();
      expect(await eyelineOf("ver_fail", src, dims, undefined, fails)).toBeNull();
      expect(fails).toHaveBeenCalledTimes(2);
    } finally {
      delete process.env.CT_LOCAL;
    }
    // a kept line is read even where nothing would be looked for
    expect(await eyelineOf("ver_x", src, dims, undefined, find)).toBe(0.31);
  });
});
