import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import type { FootageIndex } from "../../contracts/edit-plan";

// What the plan step asks the AI for footage the Media Library has no shot descriptions of, with no notes from the
// person: compared character for character with a golden written by this same test on the commit before the shot
// descriptions and the notes reached the plan (PLAN.md D11: nothing new enters a job the person didn't change).
// UPDATE_GOLDEN=1 writes it; only on that older commit.

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "editor-plan-same-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-plan-same-test-secret";
const { planPrompt } = await import("./plan");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const beats = Array.from({ length: 120 }, (_, k) => 2 + k * 0.5);
const index: FootageIndex = {
  sources: [
    { id: "ver_run", title: "Tiny Acrobatics run.mp4", dur: 900, fps: 29.97, w: 1920, h: 1080, speech: false, sound: true, shots: Array.from({ length: 300 }, (_, k) => ({ a: k * 3, b: k * 3 + 3, motion: ((k * 37) % 100) / 100, ...(k % 7 ? {} : { desc: `a jump off the beam, take ${k}` }) })) },
    { id: "ver_talk", title: "Coach talk", dur: 40, fps: 25, w: 1080, h: 1920, speech: true, sound: true, shots: [{ a: 0, b: 20, motion: 0.1 }, { a: 20, b: 40, motion: 0.3, desc: "the coach points at the mat" }] },
    { id: "ver_song", title: "Theme", dur: 64, fps: 0, w: 0, h: 0, speech: false, sound: true, shots: [] },
  ],
  song: { source: "ver_song", startS: 2, bpm: 120, beats, downbeats: beats.filter((_, k) => k % 4 === 0), strong: beats.filter((_, k) => k % 8 === 0), sections: [{ a: 2, b: 20, energy: 0.4 }, { a: 20, b: 62, energy: 1 }] },
  story: "Tiny Acrobatics warm up, then the coach talks them through the beam.",
};
const asked = {
  brief: "An overdone hard edit, max 20 s, start with S1 when it says jump",
  versions: 2,
  targetS: 0,
  setup: "Tiny Acrobatics: trick videos. Voice: warm, plain.",
  index,
  words: { ver_talk: "[0.0] Feet together. [3.2] Now jump." },
  song: { id: "ver_song", key: "k", title: "Theme", dur: 64, from: "a song among the sources" },
  gen: [{ id: "plasma", line: "soft moving colour" }],
  packText: "Keep cuts on the beat.",
};

it("asks what it asked before for footage with no shot descriptions and no notes", () => {
  const file = path.join(import.meta.dirname, "golden", "plan-prompt.json");
  const now = planPrompt(asked);
  if (process.env.UPDATE_GOLDEN) writeFileSync(file, `${JSON.stringify(now, null, 1)}\n`);
  expect(now).toEqual(JSON.parse(readFileSync(file, "utf8")));
});
