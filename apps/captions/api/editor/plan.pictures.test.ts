import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { FootageIndex, IndexShot } from "../../contracts/edit-plan";

// the library's picture vectors, as they score against the brief: S1's shot at 8 s looks like it
vi.mock("../library/pictures", async (real) => ({
  ...(await real<typeof import("../library/pictures")>()),
  pictureScores: vi.fn(async () => new Map([["v1", [0, 4, 8, 12].map((start) => ({ start, score: start === 8 ? 0.2 : 0.05 }))]])),
}));

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "editor-plan-pictures-"));
process.env.DATA_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const { matchPictures, shotPool } = await import("./plan");

const shots = (): IndexShot[] => [0, 4, 8, 12, 16].map((a) => ({ a, b: a + 4, motion: a === 0 ? 0.9 : 0.1 }));

describe("the plan's picture match", () => {
  it("marks the shot whose picture looks like the brief, by the library's stretch it starts in, and offers it first", async () => {
    const index: FootageIndex = { sources: [{ id: "v1", title: "beach.mov", dur: 20, fps: 30, w: 1920, h: 1080, speech: false, shots: shots() }] };
    await matchPictures(index, "a handstand on the beach", "local");
    const s = index.sources[0]!;
    // 16 s starts in the stretch from 12: under the floor like the rest
    expect(s.shots.map((x) => x.pic)).toEqual([0, 0, 1, 0, 0]);
    // one shot offered: the match, over the one that moves most
    expect(shotPool(s, 1).map((x) => x.a)).toEqual([8]);
    // without the match, the moving one
    expect(shotPool({ ...s, shots: shots() }, 1).map((x) => x.a)).toEqual([0]);
  });
});
