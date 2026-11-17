import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { EditPlan } from "../../contracts/edit-plan";
import type { TimelineSource } from "../../contracts/editor";
import { toFcpxml } from "./fcpxml";
import { exportGaps } from "./carry";
import { toOtio } from "./otio";
import { placeSfx, SFX_DB, SFX_GAP_S, sfxMoments, typeOf, type SfxSound } from "./sfx";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "editor-sfx-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-sfx-test-secret";
const { planTimeline } = await import("./plan");

const sound = (id: string, type: SfxSound["type"], durS = 1.5): SfxSound => ({
  type,
  src: { versionId: id, name: id, fps: 30, tc: 0, dur: Math.round(durS * 30), w: 0, h: 0 },
});
const FPS = 30;

describe("a sound's type", () => {
  it("is its tag when the tag is one of the types, else a word of its file name", () => {
    expect(typeOf(["whoosh"], "Pop 01")).toBe("whoosh");
    expect(typeOf(["sound effect"], "Soft Whoosh 03")).toBe("whoosh");
    expect(typeOf([], "metal_hit-2")).toBe("hit");
    expect(typeOf([], "whitewash")).toBeNull();
    expect(typeOf([], "rain on a roof")).toBeNull();
  });
});

describe("where sounds go", () => {
  it("keeps sounds at least about one every 2 s, never the same file twice in a row, and each sound's type", () => {
    const sounds = [sound("w1", "whoosh"), sound("w2", "whoosh"), sound("t1", "transition")];
    const moments = Array.from({ length: 41 }, (_, i) => ({ at: i * 0.5, prio: 1, types: ["whoosh", "transition"] as const }));
    const placed = placeSfx(moments, sounds, FPS, 30 * FPS);
    expect(placed.length).toBeGreaterThan(3);
    for (let i = 1; i < placed.length; i++) {
      expect(placed[i]!.rec - placed[i - 1]!.rec).toBeGreaterThanOrEqual(SFX_GAP_S * FPS);
      expect(placed[i]!.sound.versionId).not.toBe(placed[i - 1]!.sound.versionId);
    }
    expect(placed.every((p) => ["w1", "w2", "t1"].includes(p.sound.versionId))).toBe(true);
  });

  it("gives the higher-priority moment the slot when two are too close", () => {
    const placed = placeSfx(
      [{ at: 1, prio: 1, types: ["transition"] }, { at: 2, prio: 4, types: ["hit"] }],
      [sound("hit", "hit"), sound("tr", "transition")],
      FPS,
      10 * FPS,
    );
    expect(placed.map((p) => [p.rec, p.sound.versionId])).toEqual([[60, "hit"]]);
  });

  it("matches the type to the moment: a pop-in takes a pop, never a whoosh", () => {
    expect(placeSfx([{ at: 1, prio: 3, types: ["pop", "click", "ding"] }], [sound("w", "whoosh")], FPS, 10 * FPS)).toEqual([]);
    const placed = placeSfx([{ at: 1, prio: 3, types: ["pop", "click", "ding"] }], [sound("w", "whoosh"), sound("p", "pop")], FPS, 10 * FPS);
    expect(placed.map((p) => p.sound.versionId)).toEqual(["p"]);
  });

  it("does not repeat a single sound back to back", () => {
    const placed = placeSfx(
      [{ at: 1, prio: 1, types: ["hit"] }, { at: 4, prio: 1, types: ["hit"] }],
      [sound("h", "hit")],
      FPS,
      10 * FPS,
    );
    expect(placed.map((p) => p.rec)).toEqual([30]);
  });

  it("trims a sound to SFX_MAX_S and to the cut's end", () => {
    const [long] = placeSfx([{ at: 1, prio: 1, types: ["hit"] }], [sound("h", "hit", 5)], FPS, 10 * FPS);
    expect(long!.len).toBe(2 * FPS);
    const [end] = placeSfx([{ at: 3.5, prio: 1, types: ["hit"] }], [sound("h", "hit", 5)], FPS, 4 * FPS);
    expect(end!.len).toBe(Math.round(0.5 * FPS));
  });
});

describe("the moments a plan marks", () => {
  const shots = [
    { at: 0, dur: 4, src: { source: "speaker", inS: 0 } },
    { at: 4, dur: 4, src: { source: "broll", inS: 0 }, enter: "whip" as const },
    { at: 8, dur: 4, src: { source: "speaker", inS: 0 }, enter: "flash" as const },
  ];
  it("marks text pop-ins, B-roll in and out, and each shot's entry, but not the first shot's", () => {
    const got = sfxMoments({ shots, texts: [{ at: 1, dur: 1, text: "Hi" }] }, new Set(["broll"]), 12);
    // the text's pop; B-roll in at 4 and out at 8 (a whoosh each); the whip at 4; the flash at 8. Nothing at 0.
    expect(got.map((m) => [m.at, m.types[0]]).sort()).toEqual([
      [1, "pop"],
      [4, "whoosh"],
      [4, "whoosh"],
      [8, "hit"],
      [8, "whoosh"],
    ].sort());
    expect(got.some((m) => m.at === 0)).toBe(false);
  });
});

describe("the timeline's sound effects", () => {
  const plan = {
    kind: "hard edit",
    w: 1920,
    h: 1080,
    fps: FPS,
    lead: { type: "sources" as const },
    texts: [{ at: 1, dur: 1, text: "Tiny Acrobatics" }],
    shots: [
      { at: 0, dur: 4, src: { source: "game", inS: 0 }, sound: "off" as const },
      { at: 4, dur: 4, src: { source: "game", inS: 0 }, sound: "off" as const, enter: "flash" as const },
      { at: 8, dur: 4, src: { source: "game", inS: 0 }, sound: "off" as const, enter: "whip" as const },
    ],
  } satisfies EditPlan;
  const game: TimelineSource = { versionId: "game", name: "Run", fps: FPS, tc: 0, dur: 1800, w: 1920, h: 1080 };
  const sounds = [sound("s_pop", "pop", 0.6), sound("s_hit", "hit", 9), sound("s_whoosh", "whoosh", 1.5)];

  it("places text, flash and whip sounds on A3 at their moments, each sound a source the timeline carries", () => {
    const tl = planTimeline(plan, { game }, "Run v1", { sounds, broll: new Set() });
    expect(tl.tracks.A3.items.map((i) => [i.rec, i.src, i.len, i.gainDb])).toEqual([
      [30, "s_pop", 18, SFX_DB],
      [120, "s_hit", 60, SFX_DB],
      [240, "s_whoosh", 45, SFX_DB],
    ]);
    for (const i of tl.tracks.A3.items) expect(tl.sources[i.src]).toBeDefined();
  });

  it("places nothing when the sound set is none (no sound choice)", () => {
    const tl = planTimeline(plan, { game }, "Run v1", null);
    expect(tl.tracks.A3.items).toEqual([]);
    expect(Object.keys(tl.sources)).toEqual(["game"]);
  });

  it("carries A3 into the exports: the FCPXML and OTIO name the sound's file, and no gap is reported", () => {
    const tl = planTimeline(plan, { game }, "Run v1", { sounds, broll: new Set() });
    const files = { game: "/tiny/game.mp4", s_pop: "/tiny/sfx-pop.wav", s_hit: "/tiny/sfx-hit.wav", s_whoosh: "/tiny/sfx-whoosh.wav" };
    expect(toFcpxml(tl, files)).toContain("sfx-hit.wav");
    expect(JSON.stringify(toOtio(tl, files))).toContain("sfx-whoosh.wav");
    expect(exportGaps(tl)).not.toHaveProperty("sfx");
  });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));
