import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Sentence } from "../../contracts/editor";
import type { TimedWord } from "../library/transcribe";

vi.mock("../ai-complete", async (real) => {
  const m = await real<typeof import("../ai-complete")>();
  return { ...m, aiFor: vi.fn(m.aiFor), completeWithFallback: vi.fn(m.completeWithFallback) };
});

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "editor-moments-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-moments-test-secret";
delete process.env.ANTHROPIC_API_KEY;

const { aiFor, completeWithFallback } = await import("../ai-complete");
const { MAX_MOMENTS } = await import("../../contracts/editor");
const { libraryDb } = await import("../library/db");
const { enqueueJob } = await import("../library/jobs");
const { saveTranscript } = await import("../library/transcribe");
const { ENERGY_PER_SECOND, energyFile } = await import("./analyze");
const { MOMENTS_SYSTEM, momentMap, momentRange, momentsPrompt, parseMoments } = await import("./moments");
const { createEdit, readDraft, readEdit, readStep, saveStep, viewOf } = await import("./store");
const { STEPS, tick } = await import("./worker");

/** A long talk: 40 sentences of 5 s, one every 6 s (1-30 in the first file, 31-40 in a second one), four words each. */
const sentences: Sentence[] = Array.from({ length: 40 }, (_, k) => ({
  n: k + 1,
  src: k < 30 ? "ver_talk" : "ver_more",
  text: `this is sentence ${k + 1}.`,
  s: (k < 30 ? k : k - 30) * 6,
  e: (k < 30 ? k : k - 30) * 6 + 5,
  w0: (k < 30 ? k : k - 30) * 4,
  w1: (k < 30 ? k : k - 30) * 4 + 3,
}));
const words = (n: number): TimedWord[] =>
  Array.from({ length: n }, (_, k) => ["this", "is", "sentence", `${k + 1}.`].map((w, j) => ({ w, s: k * 6 + j * 1.2, e: k * 6 + j * 1.2 + 1.1 }))).flat();
const probe = { duration: 180, width: 1920, height: 1080, fps: 25, rotation: 0, format: "mov", vcodec: "h264", pixFmt: "yuv420p", acodec: "aac" };

beforeAll(() => {
  const d = libraryDb();
  d.exec(`
    INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'mem-a', 'A', 'local', 0);
    INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('ast_talk', 'lib_a', 'video', 'Tiny Acrobatics talk', 'mem-a', 0), ('ast_more', 'lib_a', 'video', 'Tiny Acrobatics talk, part two', 'mem-a', 0);
  `);
  for (const [v, a, n] of [["ver_talk", "ast_talk", 30], ["ver_more", "ast_more", 10]] as const) {
    d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at) VALUES (?, ?, 1, ?, 1, ?, ?, 'ready', 'mem-a', 0)").run(v, a, `libraries/lib_a/v/${v}/source`, `sha-${v}`, JSON.stringify(probe));
    saveTranscript(d, v, "deepgram", "en", [], words(n));
    const energy = new Float32Array(180 * ENERGY_PER_SECOND);
    for (const w of words(n)) energy.fill(0.5, Math.round(w.s * ENERGY_PER_SECOND), Math.round(w.e * ENERGY_PER_SECOND));
    mkdirSync(path.dirname(energyFile(v)), { recursive: true });
    writeFileSync(energyFile(v), energy);
  }
  // the preview and its filing need real files and Review: here they only finish
  for (const k of ["preview", "file"]) STEPS[k] = async () => {};
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("short videos from a long recording: the AI's moments, checked", () => {
  it("asks for the task and the answer's shape, with the person's brief, how many and how long, and every sentence by number", () => {
    const { system, user } = momentsPrompt({ sentences, titles: { ver_talk: "Tiny Acrobatics talk", ver_more: "Part two" }, brief: "The clearest advice for new parents.", count: 8, targetS: 30 });
    expect(system).toBe(MOMENTS_SYSTEM);
    expect(user).toContain("Brief:\nThe clearest advice for new parents.");
    expect(user).toContain("Moments: up to 8, the best ones");
    expect(user).toContain("Length: about 30 seconds each, between 15 and 60 seconds");
    expect(user).toContain('S1 = "Tiny Acrobatics talk"\nS2 = "Part two"');
    expect(user).toContain("31 S2 0.0-5.0 this is sentence 31.");
    // no length asked for: 15 to 90 seconds; the style's own notes go after the task, and nothing else does
    expect(momentsPrompt({ sentences, titles: {}, brief: "", count: 3, targetS: 0 }).user).toContain("Brief:\n(none)\n\nMoments: up to 3, the best ones\n\nLength: between 15 and 90 seconds");
    expect(momentsPrompt({ sentences, titles: {}, brief: "", count: 3, targetS: 0, styleText: "STYLE-NOTES-ZQ" }).system).toBe(`${MOMENTS_SYSTEM}\n\nSTYLE-NOTES-ZQ`);
    expect(momentRange(0)).toEqual([15, 90]);
    expect(momentRange(40)).toEqual([20, 80]);
    expect(momentRange(6)).toEqual([5, 12]);
  });

  it("reads the answer's list; no list, or an empty one, is refused", () => {
    expect(parseMoments('Here you go: {"moments":[{"first":1,"last":4,"title":"  The  first\\nrule ","score":0.9},{"first":"x"},"nonsense"]}')).toEqual([
      { first: 1, last: 4, title: "The first rule", score: 0.9 },
      { first: NaN, last: NaN, title: "", score: NaN },
    ]);
    expect(() => parseMoments('{"moments":[]}')).toThrow("The AI's answer has no moments");
    expect(() => parseMoments('{"lines":[]}')).toThrow("The AI's answer has no moments");
  });

  it("keeps the best first, each a version of one line with its own words; drops what is outside the recording, across two files, too short, too long or over a better one", () => {
    const raw = [
      { first: 1, last: 5, title: "Opening", score: 0.6 }, // 29 s
      { first: 10, last: 16, title: "The story", score: 0.9 }, // 41 s
      { first: 14, last: 18, title: "Half the story again", score: 0.8 }, // over the story
      { first: 20, last: 20, title: "One sentence", score: 0.95 }, // 5 s: too short
      { first: 1, last: 30, title: "Everything", score: 0.7 }, // 179 s: too long
      { first: 29, last: 33, title: "Across the files", score: 0.99 },
      { first: 38, last: 44, title: "Past the end", score: 0.5 },
      { first: 31, last: 35, title: "", score: 2 }, // a score over 1 counts as 1
    ];
    const { lines, plans, notes } = momentMap(raw, sentences, 10, 0);
    expect(plans.map((p) => [p.name, p.title, p.lines])).toEqual([
      ["m1", "Moment 1", [{ line: "M1", take: { first: 31, last: 35, score: 1 } }]],
      ["m2", "The story", [{ line: "M2", take: { first: 10, last: 16, score: 0.9 } }]],
      ["m3", "Opening", [{ line: "M3", take: { first: 1, last: 5, score: 0.6 } }]],
    ]);
    expect(lines[1]).toEqual({ id: "M2", text: "this is sentence 10. this is sentence 11. this is sentence 12. this is sentence 13. this is sentence 14. this is sentence 15. this is sentence 16.", takes: [{ first: 10, last: 16, score: 0.9 }] });
    expect(notes).toEqual([
      "Moment 29-33 runs across two files: dropped",
      "Moment 20-20 is 5 s, outside 15-90 s: dropped",
      "Moment 14-18 runs over a better one: dropped",
      "Moment 1-30 is 179 s, outside 15-90 s: dropped",
      "Moment 38-44 is not in sentences 1-40: dropped",
    ]);
    // never more than asked for, and never more than the most there can be
    expect(momentMap(raw, sentences, 2, 0).plans.map((p) => p.title)).toEqual(["Moment 1", "The story"]);
    const many = Array.from({ length: 30 }, (_, k) => ({ first: k + 1, last: k + 1, title: `T${k}`, score: 0.5 }));
    expect(momentMap(many, sentences, 99, 5).plans).toHaveLength(MAX_MOMENTS);
    // the length asked for moves the range: a 5 s sentence fits "about 6 seconds", the 41 s story does not
    expect(momentMap(raw, sentences, 10, 6).plans.map((p) => p.title)).toEqual(["One sentence"]);
  });
});

describe("short videos from a long recording: the step", () => {
  const start = async (body: Record<string, unknown>) => {
    const e = (await createEdit("mem-a", { sources: ["ver_talk", "ver_more"], name: "Tiny talk", brief: "The clearest advice.", ...body }))!;
    await saveStep(e.id, "analysis", { sentences, notes: [] });
    return e;
  };
  const run = async (id: string) => {
    enqueueJob(libraryDb(), "mem-a", `${id}:`, "script", "mem-a", true, "edit_jobs");
    while (await tick());
    return viewOf(readEdit(id)!);
  };

  it("an edit that asks for none is as it always was: no moments key, and the script step asks for lines and versions", async () => {
    const e = await start({});
    expect("moments" in e).toBe(false);
    expect((await start({ moments: 0 })).moments).toBe(1); // a number under 1 is the fewest there can be; no number, none
    expect((await start({ moments: 99 })).moments).toBe(MAX_MOMENTS);
    vi.mocked(aiFor).mockReturnValueOnce({ only: ["anthropic"], apiKey: "test", mac: { label: "AI Editor script" } });
    vi.mocked(completeWithFallback).mockImplementationOnce(async (system, _u, _c, parse) => {
      expect(system).not.toBe(MOMENTS_SYSTEM);
      return parse(JSON.stringify({ lines: [{ id: "L1", text: "this is sentence 1.", takes: [{ first: 1, last: 1, score: 1 }] }], versions: [{ name: "One", lines: ["L1"] }] }));
    });
    expect((await run(e.id)).plans.map((p) => p.name)).toEqual(["v1"]);
  });

  it("finds the moments on the creator's AI, then cuts each as its own version through the same chain as any edit", async () => {
    const e = await start({ moments: 5, targetS: 30 });
    vi.mocked(aiFor).mockReturnValueOnce({ only: ["anthropic"], apiKey: "test", mac: { label: "AI Editor script" } });
    vi.mocked(completeWithFallback).mockImplementationOnce(async (system, user, _c, parse) => {
      expect(system).toBe(MOMENTS_SYSTEM);
      expect(user).toContain("Moments: up to 5, the best ones");
      expect(user).toContain("Brief:\nThe clearest advice.");
      return parse(JSON.stringify({ moments: [{ first: 3, last: 7, title: "Tuck the chin", score: 0.7 }, { first: 32, last: 36, title: "Soft landings", score: 0.9 }, { first: 5, last: 9, title: "Over the first", score: 0.5 }] }));
    });
    const view = await run(e.id);
    expect(view.plans.map((p) => [p.name, p.title])).toEqual([["m1", "Soft landings"], ["m2", "Tuck the chin"]]);
    expect(view.notes).toContain("Moment 5-9 runs over a better one: dropped");
    expect(readStep(e.id, "first")!.plans.map((p) => p.name)).toEqual(["m1", "m2"]);
    // each moment: its own draft, B-roll step, post, preview and filing
    expect(view.jobs.filter((j) => j.variant).map((j) => `${j.kind} ${j.variant} ${j.state}`).sort()).toEqual(
      ["m1", "m2"].flatMap((m) => ["broll", "draft", "file", "post", "preview"].map((k) => `${k} ${m} done`)).sort(),
    );
    expect(view.drafts).toEqual(["m1", "m2"]);
    // m1 is sentences 32-36 of the second file: about 29 s of it, pauses taken out, in the recording's own shape
    const tl = readDraft(e.id, "m1")!.timeline;
    expect([tl.width, tl.height]).toEqual([1920, 1080]);
    expect(new Set(tl.tracks.V1.items.map((i) => i.src))).toEqual(new Set(["ver_more"]));
    const seconds = tl.tracks.V1.items.reduce((n, i) => n + i.len, 0) / tl.fps;
    expect(seconds).toBeGreaterThan(20);
    expect(seconds).toBeLessThanOrEqual(29.5);
    expect(tl.markers).toHaveLength(1);
  });

  it("an answer with nothing usable fails the step in words", async () => {
    const e = await start({ moments: 3 });
    vi.mocked(aiFor).mockReturnValue({ only: ["anthropic"], apiKey: "test", mac: { label: "AI Editor script" } });
    vi.mocked(completeWithFallback).mockImplementation(async (_s, _u, _c, parse) => parse(JSON.stringify({ moments: [{ first: 1, last: 1, title: "Too short", score: 1 }] })));
    const view = await run(e.id);
    vi.mocked(aiFor).mockReset();
    vi.mocked(completeWithFallback).mockReset();
    expect(view.jobs.find((j) => j.kind === "script")!.error).toBe("The AI found no part of the recording that can stand alone (Moment 1-1 is 5 s, outside 15-90 s: dropped)");
    expect(view.plans).toEqual([]);
  });
});
