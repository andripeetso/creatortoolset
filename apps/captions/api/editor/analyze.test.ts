import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ffmpegCommand } from "../ffmpeg-runtime";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "editor-analyze-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-analyze-test-secret";
writeFileSync(
  path.join(dir, "workspaces.json"),
  JSON.stringify({
    workspaces: [{ id: "ws_a", name: "Tiny Acrobatics", plan: "team", comped: false, createdAt: 0, members: [{ username: "mem-a", role: "owner", ai: "own", budgetUsd: 0, joinedAt: 0 }] }],
    invites: [],
    spend: {},
  }),
);

const { blobs, libraryDb } = await import("../library/db");
const { enqueueJob } = await import("../library/jobs");
const { saveTranscript } = await import("../library/transcribe");
const { createEdit, readStep } = await import("./store");
const { ENERGY_PER_SECOND, energyFile, readEnergy, sentencesOf } = await import("./analyze");
const { tick } = await import("./worker");

const wav = path.join(dir, "tone.wav");
const word = (w: string, s: number, e: number) => ({ w, s, e });

/** A source version: the tone fixture, with this probe (null = not probed yet). */
async function seed(id: string, title: string, probe: object | null) {
  const key = `libraries/lib_a/v/${id}/source`;
  const file = path.join(dir, `src-${id}.wav`);
  copyFileSync(wav, file);
  await blobs.put(key, file);
  const d = libraryDb();
  d.prepare("INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES (?, 'lib_a', 'video', ?, 'mem-a', 0)").run(`a-${id}`, title);
  d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at) VALUES (?, ?, 1, ?, 1, ?, ?, ?, 'mem-a', 0)").run(
    id,
    `a-${id}`,
    key,
    `sha-${id}`,
    probe ? JSON.stringify(probe) : null,
    probe ? "ready" : "processing",
  );
}

/** Queues analyze for a new edit of `sources` and runs one step at `now`; returns the edit id and its analyze job. */
async function analyze(sources: string[], now: number) {
  const e = (await createEdit("mem-a", { sources }))!;
  enqueueJob(libraryDb(), "ws_a", `${e.id}:`, "analyze", "mem-a", true, "edit_jobs");
  await tick(now);
  return { id: e.id, job: () => libraryDb().prepare("SELECT state, error, attempts, run_after FROM edit_jobs WHERE edit_id = ? AND kind = 'analyze'").get(e.id) as Record<string, unknown> };
}
const transcribeJob = (v: string) => libraryDb().prepare("SELECT state, actor FROM jobs WHERE version_id = ? AND kind = 'transcribe'").get(v) as { state: string; actor: string } | undefined;

beforeAll(async () => {
  // tone 0-1 s, silence 1-2 s, tone 2-3 s: "speech" with one pause; a .wav so no encoder delay moves the edges
  execFileSync(ffmpegCommand(), ["-v", "error", "-f", "lavfi", "-i", "aevalsrc=if(between(t\\,1\\,2)\\,0\\,0.5*sin(2*PI*440*t)):s=8000:d=3", "-y", wav]);
  libraryDb().exec("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'ws_a', 'A', 'local', 0)");
  const p = { duration: 3, width: 0, height: 0, fps: 30, rotation: 0, format: "wav", vcodec: "", pixFmt: "", acodec: "pcm_s16le" };
  await seed("ver_late", "Take B", { ...p, capturedAt: 2000 });
  await seed("ver_early", "Take A", { ...p, capturedAt: 1000 });
  await seed("ver_mute", "Silent clip", { ...p, acodec: "" });
  await seed("ver_new", "Uploading", null);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("AI Editor analyze", () => {
  it("splits words into sentences at a pause of 0.7 s or a full stop, numbered on from `first`", () => {
    const words = [word("so", 0, 0.2), word("this", 0.25, 0.4), word("is", 0.45, 0.5), word("it.", 0.55, 0.8), word("and", 0.9, 1), word("then", 1.75, 2), word("more", 2.1, 2.3)];
    expect(sentencesOf(words, "v", 5)).toEqual([
      { n: 5, src: "v", text: "so this is it.", s: 0, e: 0.8, w0: 0, w1: 3 },
      { n: 6, src: "v", text: "and", s: 0.9, e: 1, w0: 4, w1: 4 },
      { n: 7, src: "v", text: "then more", s: 1.75, e: 2.3, w0: 5, w1: 6 },
    ]);
  });

  it("reads silence where the tone stops and starts again, to within a frame", async () => {
    const e = await readEnergy(wav);
    expect(e.length).toBe(3 * ENERGY_PER_SECOND);
    const quietFrom = e.findIndex((x) => x < 0.01);
    const loudAgain = e.findIndex((x, i) => i > quietFrom && x > 0.01);
    const frame = ENERGY_PER_SECOND / 30;
    expect(Math.abs(quietFrom - 1 * ENERGY_PER_SECOND)).toBeLessThanOrEqual(frame);
    expect(Math.abs(loudAgain - 2 * ENERGY_PER_SECOND)).toBeLessThanOrEqual(frame);
    expect(e[50]).toBeCloseTo(0.5 / Math.SQRT2, 2);
  });

  it("a source with no words queues the library's transcribe as the creator and waits; one still uploading just waits", async () => {
    const now = Date.now();
    const { job } = await analyze(["ver_late", "ver_new"], now);
    expect(transcribeJob("ver_late")).toEqual({ state: "queued", actor: "mem-a" });
    expect(transcribeJob("ver_new")).toBeUndefined();
    expect(job()).toMatchObject({ state: "queued", attempts: 0, run_after: now + 30_000 });
  });

  it("a transcribe parked for the creator's missing key parks the edit with the same message", async () => {
    const why = "Add your Deepgram (or OpenAI) key in Settings → My API keys";
    libraryDb().prepare("UPDATE jobs SET state = 'needs_key', error = ? WHERE version_id = 'ver_late' AND kind = 'transcribe'").run(why);
    const { job } = await analyze(["ver_late"], Date.now());
    expect(job()).toMatchObject({ state: "needs_key", error: why });
  });

  it("numbers sentences across sources in recording order, caches each source's energy and notes a source with no sound", async () => {
    const d = libraryDb();
    saveTranscript(d, "ver_late", "deepgram", "en", [], [word("second", 0, 0.5), word("file.", 0.6, 0.9)]);
    saveTranscript(d, "ver_early", "deepgram", "en", [], [word("first", 0, 0.5), word("one", 2, 2.4)]);
    const { id, job } = await analyze(["ver_late", "ver_early", "ver_mute"], Date.now());
    expect(job()).toMatchObject({ state: "done" });
    const a = readStep(id, "analysis")!;
    expect(a.sentences.map((s) => [s.n, s.src, s.text])).toEqual([
      [1, "ver_early", "first"],
      [2, "ver_early", "one"],
      [3, "ver_late", "second file."],
    ]);
    expect(a.notes).toEqual(["“Silent clip” has no sound: left out"]);
    expect(existsSync(energyFile("ver_early")) && existsSync(energyFile("ver_late"))).toBe(true);
    // the step queues the script next
    expect(d.prepare("SELECT kind, state FROM edit_jobs WHERE edit_id = ? ORDER BY id").all(id)).toEqual([
      { kind: "analyze", state: "done" },
      { kind: "script", state: "queued" },
    ]);
    d.prepare("DELETE FROM edit_jobs").run();
  });
});
