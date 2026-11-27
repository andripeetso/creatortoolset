import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// A blurred copy is its original's footage (blur-mirror.ts): its analysis runs on the original, and the copy takes it.
const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "blur-mirror-"));
process.env.DATA_DIR = dir;
const { libraryDb } = await import("./db");
const { enqueueJob, finishJob, claimJob } = await import("./jobs");
const { mirrorBlurred } = await import("./blur-mirror");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const d = libraryDb();
d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_b', 'local', 'Blur', 'local', '{}', 0)").run();
// a clip with its original (v1, filmed) and Face Blur's render of it (v2, current)
d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES ('ast', 'lib_b', 'video', 'C0001', 'v2', 'local', 1)").run();
const version = d.prepare(
  "INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, full_sha256, blurred_of, state, created_by, created_at) VALUES (?, 'ast', ?, ?, 1000, ?, ?, ?, 'ready', 'local', 1)",
);
version.run("v1", 1, "mac:v1", "mac:q1", "sha-orig", null);
version.run("v2", 2, "mac:v2", "mac:q2", "sha-blur", "sha-orig");
const jobOf = (v: string, kind: string) => d.prepare("SELECT state FROM jobs WHERE version_id = ? AND kind = ?").get(v, kind) as { state: string } | undefined;

describe("a blurred copy and its original", () => {
  it("takes what the original has: nothing is queued for the copy, and its job reads done", () => {
    d.prepare("INSERT INTO transcripts (version_id, provider, language, text, segments, created_at) VALUES ('v1', 'deepgram', 'en', 'Hello there', '[]', 1)").run();
    d.prepare("INSERT INTO search_segments (version_id, seg, text) VALUES ('v1', 0, 'Hello there')").run();
    d.prepare("INSERT INTO descriptions (version_id, source, text, provider, created_at) VALUES ('v1', 'ai', 'A cartwheel on the lawn.', 'claude', 1)").run();
    enqueueJob(d, "lib_b", "v2", "transcribe", "local");
    enqueueJob(d, "lib_b", "v2", "describe", "local");
    // nothing runs for the copy: its job reads done with the original's result, so no sweep sees it missing
    expect(jobOf("v2", "transcribe")?.state).toBe("done");
    expect(jobOf("v1", "transcribe")?.state).toBe("done");
    expect(d.prepare("SELECT text FROM transcripts WHERE version_id = 'v2'").get()).toEqual({ text: "Hello there" });
    expect(d.prepare("SELECT text FROM search_segments WHERE version_id = 'v2'").get()).toEqual({ text: "Hello there" });
    expect(d.prepare("SELECT text FROM descriptions WHERE version_id = 'v2'").get()).toEqual({ text: "A cartwheel on the lawn." });
  });

  it("what the original has not made yet runs on the original once, and lands on the copy when done", () => {
    enqueueJob(d, "lib_b", "v2", "look", "local");
    expect(jobOf("v2", "look")).toBeUndefined();
    expect(jobOf("v1", "look")?.state).toBe("queued");
    const j = claimJob(d, 300, Date.now(), "jobs", ["look"])!;
    expect(j.version_id).toBe("v1");
    d.prepare("INSERT INTO stretches (version_id, seg, a, b, motion, text, source, created_at) VALUES ('v1', 0, 0, 2, 0.1, 'Spins', 'ai', 1)").run();
    finishJob(d, j.id, true, undefined, undefined, "jobs", j.claim_id);
    expect(d.prepare("SELECT text FROM stretches WHERE version_id = 'v2'").get()).toEqual({ text: "Spins" });
  });

  it("a result made again on the original replaces the copy's made one, never what the person wrote", () => {
    d.prepare("INSERT INTO descriptions (version_id, source, text, provider, created_at) VALUES ('v2', 'user', 'My words', NULL, 2)").run();
    d.prepare("UPDATE descriptions SET text = 'A cartwheel, then a bow.' WHERE version_id = 'v1' AND source = 'ai'").run();
    enqueueJob(d, "lib_b", "v2", "describe", "local", true);
    const j = claimJob(d, 300, Date.now(), "jobs", ["describe"])!;
    expect(j.version_id).toBe("v1");
    finishJob(d, j.id, true, undefined, undefined, "jobs", j.claim_id);
    expect(d.prepare("SELECT source, text FROM descriptions WHERE version_id = 'v2' ORDER BY source").all()).toEqual([
      { source: "ai", text: "A cartwheel, then a bow." },
      { source: "user", text: "My words" },
    ]);
  });

  it("the minute's pass brings what lands without a job (a timeline)", () => {
    d.prepare("INSERT INTO timelines (version_id, events, level, model, at) VALUES ('v1', '[]', 'standard', 'gemini', 1)").run();
    expect(mirrorBlurred(d)).toBe(1);
    expect(d.prepare("SELECT model FROM timelines WHERE version_id = 'v2'").get()).toEqual({ model: "gemini" });
  });
});
