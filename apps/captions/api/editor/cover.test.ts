import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Line, Sentence, VersionPlan } from "../../contracts/editor";
import type { TimedWord } from "../library/transcribe";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "editor-cover-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-cover-test-secret";

const { libraryDb } = await import("../library/db");
const { enqueueJob } = await import("../library/jobs");
const { indexAsset } = await import("../library/query");
const { saveTranscript } = await import("../library/transcribe");
const { ENERGY_PER_SECOND, energyFile } = await import("./analyze");
const { NO_COVER, rankByWords } = await import("./broll");
const { createEdit, readDraft, readEdit, saveStep, viewOf } = await import("./store");
const { sourceOf } = await import("./timeline");
const { tick } = await import("./worker");

/** A voice recording with no picture: two sentences, 2 s and 3 s long. */
const words: TimedWord[] = [
  { w: "Roll", s: 0.2, e: 0.6 },
  { w: "the", s: 0.7, e: 0.9 },
  { w: "mat", s: 1.0, e: 1.4 },
  { w: "out.", s: 1.5, e: 2.2 },
  { w: "Then", s: 3.2, e: 3.6 },
  { w: "the", s: 3.7, e: 3.9 },
  { w: "ramp", s: 4.0, e: 4.6 },
  { w: "goes", s: 4.7, e: 5.2 },
  { w: "down.", s: 5.3, e: 6.2 },
];
const sentences: Sentence[] = [
  { n: 1, src: "ver_voice", text: "Roll the mat out.", s: 0.2, e: 2.2, w0: 0, w1: 3 },
  { n: 2, src: "ver_voice", text: "Then the ramp goes down.", s: 3.2, e: 6.2, w0: 4, w1: 8 },
];
const lines: Line[] = [
  { id: "L1", text: "Roll the mat out", takes: [{ first: 1, last: 1, score: 1 }] },
  { id: "L2", text: "Then the ramp goes down", takes: [{ first: 2, last: 2, score: 1 }] },
];
const plans: VersionPlan[] = [{ name: "v1", title: "Only", lines: [{ line: "L1", take: { first: 1, last: 1, score: 1 } }, { line: "L2", take: { first: 2, last: 2, score: 1 } }] }];
const sound = { duration: 7, width: 0, height: 0, fps: 0, rotation: 0, format: "mp3", vcodec: "", pixFmt: "", acodec: "mp3" };
const video = { duration: 20, width: 1080, height: 1920, fps: 30, rotation: 0, format: "mov", vcodec: "h264", pixFmt: "yuv420p", acodec: "aac" };

const clips: [string, string, string][] = [
  ["ver_park", "Tiny Acrobatics park", "Children run across the grass in a park"],
  ["ver_ramp", "Tiny Acrobatics ramp", "A foam ramp is pushed down onto the floor"],
  ["ver_mat", "Tiny Acrobatics mat", "Two hands unroll a blue mat"],
];

beforeAll(() => {
  const d = libraryDb();
  d.exec(`
    INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'mem-a', 'A', 'local', 0);
    INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('ast_voice', 'lib_a', 'audio', 'Voice', 'mem-a', 0);
    INSERT INTO collections (id, library_id, parent_id, name, kind, query, created_at, created_by) VALUES ('col_two', 'lib_a', NULL, 'Two clips', 'manual', NULL, 0, 'mem-a');
  `);
  const version = d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at) VALUES (?, ?, 1, ?, 1, ?, ?, 'ready', 'mem-a', 0)");
  version.run("ver_voice", "ast_voice", "libraries/lib_a/v/ver_voice/source", "sha-voice", JSON.stringify(sound));
  d.prepare("UPDATE assets SET current_version_id = 'ver_voice' WHERE id = 'ast_voice'").run();
  saveTranscript(d, "ver_voice", "deepgram", "en", [], words);
  const energy = new Float32Array(7 * ENERGY_PER_SECOND);
  for (const w of words) energy.fill(0.5, Math.round(w.s * ENERGY_PER_SECOND), Math.round(w.e * ENERGY_PER_SECOND));
  mkdirSync(path.dirname(energyFile("ver_voice")), { recursive: true });
  writeFileSync(energyFile("ver_voice"), energy);
  clips.forEach(([v, title, text], k) => {
    const a = v.replace("ver_", "ast_");
    d.prepare("INSERT INTO assets (id, library_id, kind, title, created_by, created_at, roll) VALUES (?, 'lib_a', 'video', ?, 'mem-a', ?, 'b')").run(a, title, k);
    version.run(v, a, `libraries/lib_a/v/${v}/source`, `sha-${v}`, JSON.stringify(video));
    d.prepare("UPDATE assets SET current_version_id = ? WHERE id = ?").run(v, a);
    d.prepare("INSERT INTO descriptions (version_id, source, text, created_at) VALUES (?, 'ai', ?, 0)").run(v, text);
    indexAsset(d, a);
  });
  // a folder of its own with two of the three
  d.prepare("INSERT INTO collection_items (collection_id, asset_id, position, added_by) VALUES ('col_two', 'ast_park', 0, 'mem-a'), ('col_two', 'ast_ramp', 1, 'mem-a')").run();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Runs an edit of the voice from its draft on; the preview fails here (the fixture has no files), the B-roll does not need them. */
async function cut(body: Record<string, unknown> = {}) {
  const e = (await createEdit("mem-a", { sources: ["ver_voice"], ...body }))!;
  await saveStep(e.id, "analysis", { sentences, notes: [] });
  await saveStep(e.id, "plan", { lines, plans, notes: [] });
  enqueueJob(libraryDb(), "mem-a", `${e.id}:`, "draft", "mem-a", true, "edit_jobs");
  while (await tick());
  return { e, jobs: viewOf(readEdit(e.id)!).jobs, tl: readDraft(e.id, "v1")?.timeline };
}
const coveredTo = (items: { rec: number; len: number }[]) => [...items].sort((a, b) => a.rec - b.rec).reduce((at, i) => (i.rec === at ? at + i.len : -1), 0);

describe("AI Editor: an edit of a voice with no picture", () => {
  it("a recording with only cover art counts as sound only", () => {
    expect(sourceOf("v", "Song", { ...video, cover: true })).toMatchObject({ w: 0, h: 0 });
    expect(sourceOf("v", "Voice", sound)).toMatchObject({ w: 0, h: 0, fps: 30, dur: 210 });
  });

  it("ranks a folder's clips by the words a line shares with their title and description; none shared: none named", () => {
    const rank = rankByWords(clips.map(([id]) => ({ id })));
    expect(rank("Roll the mat out")[0]).toBe("ver_mat");
    expect(rank("Then the ramp goes down")[0]).toBe("ver_ramp");
    expect(rank("Subscribe today")).toEqual([]);
    expect(rank("")).toEqual([]);
    // only the clips it was given
    expect(rankByWords([{ id: "ver_park" }])("the ramp and the mat")).toEqual([]);
  });

  it("with no B-roll folder chosen, the whole picture comes from every clip sorted B-roll, each line on the clip that fits its words", async () => {
    const { jobs, tl } = await cut();
    expect(jobs.find((j) => j.kind === "broll")).toMatchObject({ state: "done" });
    const end = Math.max(...tl!.tracks.V1.items.map((i) => i.rec + i.len));
    expect(coveredTo(tl!.tracks.V2.items)).toBe(end);
    expect(tl!.width).toBe(1080);
    expect(tl!.height).toBe(1920);
    const at = (rec: number) => tl!.tracks.V2.items.find((i) => i.rec <= rec && rec < i.rec + i.len)!.src;
    expect(at(0)).toBe("ver_mat");
    expect(at(tl!.markers[1]!.rec)).toBe("ver_ramp");
    // the voice is one spine on V1 and A1, with no punch-in on a picture that is not there
    expect(tl!.tracks.V1.items.every((i) => i.src === "ver_voice" && !i.zoom && !i.tilt)).toBe(true);
  });

  it("with a folder chosen, only its clips are used", async () => {
    const { tl } = await cut({ brollCollectionId: "col_two" });
    expect(new Set(tl!.tracks.V2.items.map((i) => i.src))).toEqual(new Set(["ver_park", "ver_ramp"]));
    expect(coveredTo(tl!.tracks.V2.items)).toBe(Math.max(...tl!.tracks.V1.items.map((i) => i.rec + i.len)));
  });

  it("with nothing to show, the B-roll step fails in words and no preview of a black video is made", async () => {
    libraryDb().prepare("UPDATE assets SET roll = NULL WHERE kind = 'video'").run();
    const { jobs } = await cut();
    // parked as Needs setup, not tried again and again: Retry runs it once there is footage
    expect(jobs.find((j) => j.kind === "broll")).toMatchObject({ state: "needs_key", error: NO_COVER });
    expect(jobs.some((j) => j.kind === "preview")).toBe(false);
    libraryDb().prepare("UPDATE assets SET roll = 'b' WHERE kind = 'video'").run();
  });
});
