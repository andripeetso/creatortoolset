import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Line, Sentence, TimelineSource, VersionPlan } from "../../contracts/editor";
import type { TimedWord } from "../library/transcribe";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "editor-timeline-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-timeline-test-secret";
writeFileSync(
  path.join(dir, "workspaces.json"),
  JSON.stringify({
    workspaces: [{ id: "ws_a", name: "Tiny Acrobatics", plan: "team", comped: false, createdAt: 0, members: [{ username: "mem-a", role: "owner", ai: "own", budgetUsd: 0, joinedAt: 0 }] }],
    invites: [],
    spend: {},
  }),
);

const { libraryDb } = await import("../library/db");
const { enqueueJob } = await import("../library/jobs");
const { saveTranscript } = await import("../library/transcribe");
const { ENERGY_PER_SECOND, energyFile } = await import("./analyze");
const { createEdit, readDraft, saveDraft, saveStep, viewOf, readEdit } = await import("./store");
const { buildTimeline, sourceOf, timecodeFrames } = await import("./timeline");
const { tick } = await import("./worker");

/** Two sentences per file, each two 0.25 s words with a 0.1 s gap, sentences 1 s apart. */
const words: TimedWord[] = [
  { w: "we", s: 0.5, e: 0.75 },
  { w: "roll.", s: 0.85, e: 1.1 },
  { w: "join", s: 2.1, e: 2.35 },
  { w: "us.", s: 2.45, e: 2.7 },
];
const energy = new Float32Array(4 * ENERGY_PER_SECOND);
for (const w of words) energy.fill(0.5, Math.round(w.s * ENERGY_PER_SECOND), Math.round(w.e * ENERGY_PER_SECOND));
const sentences: Sentence[] = [
  { n: 1, src: "ver_a", text: "we roll.", s: 0.5, e: 1.1, w0: 0, w1: 1 },
  { n: 2, src: "ver_a", text: "join us.", s: 2.1, e: 2.7, w0: 2, w1: 3 },
  { n: 3, src: "ver_b", text: "we roll.", s: 0.5, e: 1.1, w0: 0, w1: 1 },
  { n: 4, src: "ver_b", text: "join us.", s: 2.1, e: 2.7, w0: 2, w1: 3 },
];
const lines: Line[] = [
  { id: "L1", text: "we roll", takes: [{ first: 1, last: 1, score: 1 }, { first: 3, last: 3, score: 0.9 }] },
  { id: "L2", text: "join us", takes: [{ first: 4, last: 4, score: 1 }, { first: 2, last: 2, score: 0.9 }] },
];
const plans: VersionPlan[] = [
  { name: "v1", title: "First", lines: [{ line: "L1", take: { first: 1, last: 1, score: 1 } }, { line: "L2", take: { first: 4, last: 4, score: 1 } }] },
  { name: "v2", title: "Second", lines: [{ line: "L2", take: { first: 2, last: 2, score: 0.9 } }, { line: "L1", take: { first: 3, last: 3, score: 0.9 } }] },
];
const probe = { duration: 4, width: 1920, height: 1080, fps: 25, rotation: 90, format: "mov", vcodec: "h264", pixFmt: "yuv420p", acodec: "aac", timecode: "01:00:00:00" };

beforeAll(() => {
  const d = libraryDb();
  d.exec(`
    INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'ws_a', 'A', 'local', 0);
    INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('ast_a', 'lib_a', 'video', 'Take A', 'mem-a', 0), ('ast_b', 'lib_a', 'video', 'Take B', 'mem-a', 0);
  `);
  for (const [v, a, fps] of [["ver_a", "ast_a", 25], ["ver_b", "ast_b", 50]] as const) {
    d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at) VALUES (?, ?, 1, ?, 1, ?, ?, 'ready', 'mem-a', 0)").run(
      v,
      a,
      `libraries/lib_a/v/${v}/source`,
      `sha-${v}`,
      JSON.stringify({ ...probe, fps }),
    );
    saveTranscript(d, v, "deepgram", "en", [], words);
    mkdirSync(path.dirname(energyFile(v)), { recursive: true });
    writeFileSync(energyFile(v), energy);
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("AI Editor timeline", () => {
  it("reads start timecode, drop frame too, and turns a rotated source upright", () => {
    expect(timecodeFrames("01:00:00:00", 25)).toBe(90_000);
    expect(timecodeFrames("00:10:00;00", 29.97)).toBe(17_982);
    expect(timecodeFrames(undefined, 25)).toBe(0);
    expect(sourceOf("v", "Take A", { ...probe, fps: 25 })).toEqual({ versionId: "v", name: "Take A", fps: 25, tc: 90_000, dur: 100, w: 1080, h: 1920 });
  });

  it("lays each line's pieces on V1 and A1, linked, punches every other shot, a marker per line, frames at each rate", () => {
    const sources: Record<string, TimelineSource> = { ver_a: sourceOf("ver_a", "Take A", { ...probe, fps: 25 }), ver_b: sourceOf("ver_b", "Take B", { ...probe, fps: 50 }) };
    const { timeline: t, notes } = buildTimeline({
      name: "Tiny v1",
      plan: plans[0]!,
      lines,
      sentences,
      sources,
      words: { ver_a: words, ver_b: words },
      energy: { ver_a: energy, ver_b: energy },
      punch: 1.15,
      eyeline: {},
    });
    expect(notes).toEqual([]);
    expect([t.fps, t.width, t.height]).toEqual([25, 1080, 1920]);
    expect(t.markers.map((m) => [m.rec, m.name, m.note])).toEqual([[0, "L1", "we roll"], [t.tracks.V1.items[1]!.rec, "L2", "join us"]]);
    const [a, b] = t.tracks.V1.items;
    expect(a).toMatchObject({ src: "ver_a", rec: 0, link: "c1" });
    expect(a!.zoom).toBeUndefined();
    expect(b).toMatchObject({ src: "ver_b", rec: a!.len, link: "c2", zoom: 1.15 });
    // ver_b runs at 50 fps: its source frames are twice its timeline frames
    expect(b!.in).toBeGreaterThan(2 * 50);
    expect(t.tracks.A1.items.map((i) => [i.src, i.in, i.len, i.rec, i.link])).toEqual(t.tracks.V1.items.map((i) => [i.src, i.in, i.len, i.rec, i.link]));
    // the first take opens a little before "we" and closes a little after "roll."
    expect(a!.in).toBeLessThanOrEqual(Math.round(0.5 * 25));
    expect(a!.in + a!.len).toBeGreaterThanOrEqual(Math.round(1.1 * 25));
  });

  it("the whole-edit draft queues one per version and drops drafts of versions no longer planned; each saves its timeline", async () => {
    const e = (await createEdit("mem-a", { sources: ["ver_a", "ver_b"], versions: 2 }))!;
    await saveStep(e.id, "analysis", { sentences, notes: [] });
    await saveStep(e.id, "plan", { lines, plans, notes: [] });
    await saveDraft(e.id, "v3", { timeline: {} as never, notes: [] });
    enqueueJob(libraryDb(), "ws_a", `${e.id}:`, "draft", "mem-a", true, "edit_jobs");
    while (await tick());
    const jobs = viewOf(readEdit(e.id)!, "mem-a").jobs.map((j) => [j.kind, j.variant, j.state]);
    expect(jobs).toEqual([
      ["draft", "", "done"],
      ["draft", "v1", "done"],
      ["draft", "v2", "done"],
    ]);
    expect(viewOf(readEdit(e.id)!, "mem-a").drafts).toEqual(["v1", "v2"]);
    const v2 = readDraft(e.id, "v2")!.timeline;
    expect(v2.tracks.V1.items.map((i) => i.src)).toEqual(["ver_a", "ver_b"]);
    expect(Object.keys(v2.sources).sort()).toEqual(["ver_a", "ver_b"]);
  });
});
