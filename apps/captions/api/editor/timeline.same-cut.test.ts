import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { energy, FPS, lines, plans, probe, sentences, words } from "./golden/pauses";

// The cut of an edit made the plain way: the timeline the draft step saves for each version, and the steps it queues,
// compared with a golden file. The golden was written by this same test before an edit could be made any other way, so
// this file must keep running as it is on an older checkout: it imports nothing newer than the draft step itself.
// UPDATE_GOLDEN=1 writes the file; never do that on a branch that changes the cut.

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "editor-same-cut-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-same-cut-test-secret";

const { libraryDb } = await import("../library/db");
const { enqueueJob } = await import("../library/jobs");
const { saveTranscript } = await import("../library/transcribe");
const { ENERGY_PER_SECOND, energyFile } = await import("./analyze");
const { createEdit, readDraft, readEdit, saveStep, viewOf } = await import("./store");
const { tick } = await import("./worker");

const file = path.join(import.meta.dirname, "golden", "plain-cut.json");

beforeAll(() => {
  const d = libraryDb();
  d.exec(`
    INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'mem-a', 'A', 'local', 0);
    INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('ast_a', 'lib_a', 'video', 'Take A', 'mem-a', 0), ('ast_b', 'lib_a', 'video', 'Take B', 'mem-a', 0);
  `);
  for (const [v, a] of [["ver_a", "ast_a"], ["ver_b", "ast_b"]] as const) {
    d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at) VALUES (?, ?, 1, ?, 1, ?, ?, 'ready', 'mem-a', 0)").run(
      v,
      a,
      `libraries/lib_a/v/${v}/source`,
      `sha-${v}`,
      JSON.stringify({ ...probe, fps: FPS[v] }),
    );
    saveTranscript(d, v, "deepgram", "en", [], words);
    mkdirSync(path.dirname(energyFile(v)), { recursive: true });
    writeFileSync(energyFile(v), energy(ENERGY_PER_SECOND));
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("AI Editor draft: the cut of a plain edit stays what it was", () => {
  it("each version's timeline, its notes and the steps queued after it match the golden file", async () => {
    const e = (await createEdit("mem-a", { sources: ["ver_a", "ver_b"], name: "Tiny Acrobatics hook", versions: 2 }))!;
    await saveStep(e.id, "analysis", { sentences, notes: [] });
    await saveStep(e.id, "plan", { lines, plans, notes: [] });
    enqueueJob(libraryDb(), "mem-a", `${e.id}:`, "draft", "mem-a", true, "edit_jobs");
    while (await tick());
    const got = {
      // the preview has no footage to read here and fails; which steps were queued, and in what order, is what counts
      jobs: viewOf(readEdit(e.id)!).jobs.map((j) => `${j.kind} ${j.variant}`.trim()),
      v1: readDraft(e.id, "v1"),
      v2: readDraft(e.id, "v2"),
    };
    const text = `${JSON.stringify(got, null, 1)}\n`;
    if (process.env.UPDATE_GOLDEN) writeFileSync(file, text);
    expect(text).toBe(readFileSync(file, "utf8"));
    // the fixture does make the cut work: both pauses of the first line are cut, so it is three shots, the middle one punched in
    const v1 = got.v1!.timeline.tracks.V1.items;
    expect(v1.map((i) => [i.src, i.zoom ?? 1])).toEqual([["ver_a", 1], ["ver_a", 1.15], ["ver_a", 1], ["ver_b", 1.15], ["ver_b", 1]]);
  });
});
