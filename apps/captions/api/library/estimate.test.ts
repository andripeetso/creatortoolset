import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("../ai-complete", async (real) => {
  const m = await real<typeof import("../ai-complete")>();
  return { ...m, aiFor: vi.fn(() => ({ only: ["mac"] })) };
});

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-estimate-"));
process.env.DATA_DIR = dir;
delete process.env.APP_SECRET; // the solo install: "local" is the admin, the server's Deepgram key is theirs
delete process.env.ANTHROPIC_API_KEY;
process.env.DEEPGRAM_API_KEY = "dg-test";
const { libraryDb } = await import("./db");
const { claimJob, enqueueJob } = await import("./jobs");
const { estimate, progress } = await import("./estimate");
const { describeSlot } = await import("./describe");
const { tick } = await import("./worker");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const d = libraryDb();
d.prepare(`INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_e', 'local', 'L', 'local', '{"describe":true}', 1)`).run();
for (const i of [1, 2, 3]) {
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, 'lib_e', 'video', 'c', ?, 'local', 1)").run(`a${i}`, `v${i}`);
  // 60 s of footage in 30 MB: this library's own 0.5 MB a second
  d.prepare(
    `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at)
     VALUES (?, ?, 1, 'k', 30000000, ?, '{"duration":60,"vcodec":"h264"}', 'ready', 'local', 1)`,
  ).run(`v${i}`, `a${i}`, `s${i}`);
  // each described on the connected AI in 20 s
  d.prepare("INSERT INTO jobs (library_id, version_id, kind, state, actor, started_at, done_at) VALUES ('lib_e', ?, 'describe', 'done', 'local', 0, 20000)").run(`v${i}`);
  d.prepare("INSERT INTO descriptions (version_id, source, text, provider, created_at) VALUES (?, 'ai', 'x', 'mac-instance', 1)").run(`v${i}`);
}

describe("estimate", () => {
  it("prices a drop on this library's own footage and this server's own pace", async () => {
    const e = await estimate("lib_e", "local", { clips: 100, bytes: 100 * 30_000_000 });
    expect(e.minutes).toBeCloseTo(100, 5);
    const step = (s: string) => e.steps.find((x) => x.step === s)!;
    expect(step("transcript")).toMatchObject({ route: "deepgram", measured: false });
    expect(step("transcript").usd).toBeCloseTo(100 * 0.0043, 5);
    // measured: 20 s each, two at a time on a connected AI
    expect(step("describe")).toMatchObject({ route: "provider", seconds: 1000 });
    expect(step("embed").route).toBe("none"); // on by default, no OpenAI key
    expect(e.seconds).toBe(Math.max(...e.steps.map((s) => s.seconds)));
    // the person's own computer makes them with no key
    process.env.CT_LOCAL = "1";
    const here = await estimate("lib_e", "local", { clips: 100, bytes: 100 * 30_000_000 });
    delete process.env.CT_LOCAL;
    expect(here.steps.find((x) => x.step === "embed")).toMatchObject({ route: "device", seconds: 200 });
  });

  it("a music folder costs nobody AI or keys; sound-only files are never described", async () => {
    const songs = await estimate("lib_e", "local", { clips: 50, bytes: 50 * 4_000_000, audio: 50, audioBytes: 50 * 4_000_000, music: true });
    expect(songs.minutes).toBeCloseTo((50 * 4_000_000) / 16_000 / 60, 5); // at a song's bitrate, not the footage's
    expect(songs.steps.filter((s) => s.route !== "off").map((s) => s.step)).toEqual(["files"]);
    expect(songs.steps.reduce((n, s) => n + s.usd, 0)).toBe(0);
    expect(songs.withApiKey).toBeUndefined();
    const memos = await estimate("lib_e", "local", { clips: 30, bytes: 30 * 1_000_000, audio: 30, audioBytes: 30 * 1_000_000 });
    expect(memos.steps.find((s) => s.step === "transcript")!.route).toBe("deepgram"); // a voice memo is still searchable by what is said
    expect(memos.steps.find((s) => s.step === "describe")!.route).toBe("off");
  });

  it("says what is left, and nothing once the queue is empty", async () => {
    expect((await progress("lib_e", "local")).left).toBe(0);
    enqueueJob(d, "lib_e", "v1", "thumb", "local");
    const p = await progress("lib_e", "local");
    expect(p).toMatchObject({ left: 1, clips: 1 });
    expect(p.seconds).toBeGreaterThan(0);
    d.prepare("DELETE FROM jobs WHERE kind = 'thumb'").run();
  });
});

describe("parallel lanes", () => {
  it("a lane claims only its own kinds", () => {
    enqueueJob(d, "lib_e", "v2", "thumb", "local");
    enqueueJob(d, "lib_e", "v2", "embed", "local");
    expect(claimJob(d, 300, Date.now(), "jobs", ["describe", "embed"])?.kind).toBe("embed");
    d.prepare("DELETE FROM jobs WHERE kind IN ('thumb', 'embed')").run();
  });

  it("a description waits while its clip's transcript is still to come", async () => {
    d.prepare("DELETE FROM jobs WHERE version_id = 'v3'").run();
    enqueueJob(d, "lib_e", "v3", "transcribe", "local");
    enqueueJob(d, "lib_e", "v3", "describe", "local");
    expect(await tick(Date.now(), ["describe"])).toBe(false);
    const j = d.prepare("SELECT state, attempts, run_after FROM jobs WHERE version_id = 'v3' AND kind = 'describe'").get() as { state: string; attempts: number; run_after: number };
    expect(j).toMatchObject({ state: "queued", attempts: 0 });
    expect(j.run_after).toBeGreaterThan(Date.now());
  });

  it("a connected AI takes two descriptions at a time", () => {
    const a = describeSlot("local");
    const b = describeSlot("local");
    expect(a && b).toBeTruthy();
    expect(describeSlot("local")).toBeNull();
    a!();
    a!(); // giving a turn back twice frees one
    const c = describeSlot("local");
    expect(c).toBeTruthy();
    expect(describeSlot("local")).toBeNull();
    b!();
    c!();
  });
});
