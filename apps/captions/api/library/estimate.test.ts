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
const { claimJob, enqueueJob, folderWalks } = await import("./jobs");
const { estimate, progress } = await import("./estimate");
const { describeSlot } = await import("./describe");
const { holdForLimit, releaseLimit, tick } = await import("./worker");

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

describe("this computer's transcripts", () => {
  it("are paced by the time each took, not the time it waited for the one before (they run one at a time)", async () => {
    process.env.CT_LOCAL = "1";
    delete process.env.DEEPGRAM_API_KEY;
    try {
      // four claimed at once, each done 10 s after the one before: 10 s each, not 10, 20, 30 and 40
      for (const [i, v] of ["v1", "v2", "v3"].entries()) {
        d.prepare("INSERT INTO jobs (library_id, version_id, kind, state, actor, started_at, done_at) VALUES ('lib_e', ?, 'transcribe', 'done', 'local', 0, ?)").run(v, (i + 1) * 10_000);
        d.prepare("INSERT INTO transcripts (version_id, provider, language, text, segments, created_at) VALUES (?, 'device', 'en', '', '[]', 1)").run(v);
      }
      const e = await estimate("lib_e", "local", { clips: 6, bytes: 6 * 30_000_000 });
      expect(e.steps.find((s) => s.step === "transcript")).toMatchObject({ route: "device", seconds: 60, measured: true });
    } finally {
      process.env.DEEPGRAM_API_KEY = "dg-test";
      delete process.env.CT_LOCAL;
      d.prepare("DELETE FROM jobs WHERE kind = 'transcribe'").run();
      d.prepare("DELETE FROM transcripts").run();
    }
  });
});

describe("what the page counts", () => {
  it("each step since this run began, in the order they run: a clip that is through stays counted, so no number goes down", async () => {
    d.prepare("DELETE FROM jobs WHERE state != 'done'").run();
    for (const v of ["v1", "v2", "v3"]) for (const k of ["proxy", "thumb", "transcribe"]) enqueueJob(d, "lib_e", v, k, "local");
    const counts = async () => (await progress("lib_e", "local")).stages!.map((s) => `${s.kind} ${s.done}/${s.of}`);
    // their descriptions were made before (the setup above): done work of a clip in the run counts
    expect(await counts()).toEqual(["thumb 0/3", "proxy 0/3", "transcribe 0/3", "describe 3/3"]);
    // v1 is through every step, v2 and v3 have their pictures
    d.prepare("UPDATE jobs SET state = 'done' WHERE state = 'queued' AND (version_id = 'v1' OR kind = 'thumb')").run();
    expect(await counts()).toEqual(["thumb 3/3", "proxy 1/3", "transcribe 1/3", "describe 3/3"]);
    const running = d.prepare("UPDATE jobs SET state = 'running', started_at = ? WHERE version_id = 'v2' AND kind = 'proxy' RETURNING id").get(Date.now()) as { id: number };
    expect((await progress("lib_e", "local")).stages!.find((s) => s.kind === "proxy")).toMatchObject({ done: 1, of: 3, now: "c" });
    d.prepare("UPDATE jobs SET state = 'failed' WHERE id = ?").run(running.id);
    expect((await progress("lib_e", "local")).stages!.find((s) => s.kind === "proxy")).toMatchObject({ done: 1, of: 3, failed: 1 });
    // one that parks for a key is still to do on its line (and said in `waiting`): the line does not shrink
    d.prepare("UPDATE jobs SET state = 'needs_key', error = 'Add your Deepgram key' WHERE kind = 'transcribe' AND version_id = 'v2'").run();
    expect((await progress("lib_e", "local")).stages!.find((s) => s.kind === "transcribe")).toMatchObject({ done: 1, of: 3 });
    // the queue empties: the next run counts from nothing
    d.prepare("UPDATE jobs SET state = 'done' WHERE state = 'queued'").run();
    expect(await progress("lib_e", "local")).toMatchObject({ left: 0, stages: [] });
    enqueueJob(d, "lib_e", "v3", "embed", "local", true);
    // search by meaning has no key here: it is no line (it waits for a key in `waiting`, once claimed)
    expect(await counts()).toEqual(["thumb 1/1", "proxy 1/1", "transcribe 1/1", "describe 1/1"]);
    d.prepare("DELETE FROM jobs WHERE kind != 'describe'").run();
  });
});

describe("one set of numbers while clips come in", () => {
  it("counts the folder's clips from the moment they are found, never goes back, and leaves out a clip whose only step is held", async () => {
    d.prepare("DELETE FROM jobs WHERE state != 'done'").run();
    const seen: number[] = [];
    const look = async () => {
      const p = await progress("lib_e", "local");
      seen.push(p.share);
      return p;
    };
    const done = (v: string, kind: string) => d.prepare("UPDATE jobs SET state = 'done' WHERE version_id = ? AND kind = ?").run(v, kind);
    // the folder holds three clips, none handed over yet
    folderWalks.set("lib_e\0/Volumes/Card/Trip", { files: 3, adding: 3 });
    try {
    expect(await look()).toMatchObject({ clips: 3, left: 3, share: 0 });
    for (const [i, v] of ["v1", "v2", "v3"].entries()) {
      enqueueJob(d, "lib_e", v, "probe", "local");
      folderWalks.set("lib_e\0/Volumes/Card/Trip", { files: 3, adding: 2 - i });
      expect((await look()).clips).toBe(3);
      // read: its steps appear all at once, which must not pull the share back
      done(v, "probe");
      for (const k of ["thumb", "wave", "proxy", "transcribe"]) enqueueJob(d, "lib_e", v, k, "local");
      await look();
      done(v, "thumb");
      await look();
    }
    for (const v of ["v1", "v2", "v3"]) for (const k of ["wave", "proxy", "transcribe"]) done(v, k);
    // v3's description waits for the plan's limit: v3 is not being prepared, and the run is through
    d.prepare("DELETE FROM jobs WHERE version_id = 'v3' AND kind = 'describe'").run();
    enqueueJob(d, "lib_e", "v3", "describe", "local");
    holdForLimit(d, "local", "Your Claude plan's weekly limit is reached; it resets 5pm.", Date.now() + 60_000);
    enqueueJob(d, "lib_e", "v1", "embed", "local", true);
    expect(await look()).toMatchObject({ clips: 1 });
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]!);
    expect(seen.at(-1)).toBeGreaterThan(0.9);
    } finally {
      folderWalks.clear();
      d.prepare("DELETE FROM jobs WHERE state != 'done'").run();
    }
  });
});

describe("the plan's usage limit", () => {
  it("holds every queued description, says why, and counts them as waiting, not as work left", async () => {
    d.prepare("DELETE FROM jobs WHERE state != 'done'").run();
    d.prepare("DELETE FROM jobs WHERE kind = 'describe'").run();
    for (const v of ["v1", "v2", "v3"]) enqueueJob(d, "lib_e", v, "describe", "local");
    enqueueJob(d, "lib_e", "v1", "describe", "someone-else"); // already queued: stays local's
    holdForLimit(d, "local", "Your Claude plan's weekly limit is reached; it resets 5pm.", Date.now() + 60_000);
    const p = await progress("lib_e", "local");
    expect(p.left).toBe(0);
    expect(p.waiting).toEqual([
      { step: "describe", count: 3, missing: "Your Claude plan's weekly limit is reached; it resets 5pm. They carry on by themselves then.", limit: true },
    ]);
    expect(claimJob(d, 300, Date.now(), "jobs", ["describe"])).toBeNull(); // none asks the closed plan meanwhile
    // the hold is over and one asks again: still waiting, no time left shown, until one gets through
    d.prepare("UPDATE jobs SET run_after = 0 WHERE kind = 'describe'").run();
    claimJob(d, 300, Date.now(), "jobs", ["describe"]);
    expect(await progress("lib_e", "local")).toMatchObject({ left: 0, seconds: 0, waiting: [{ count: 3, limit: true }] });
    // one got through: the rest are work again
    d.prepare("UPDATE jobs SET state = 'done', error = NULL WHERE kind = 'describe' AND state = 'running'").run();
    releaseLimit(d, "local");
    expect(await progress("lib_e", "local")).toMatchObject({ left: 2, waiting: [] });
    d.prepare("DELETE FROM jobs WHERE state != 'done'").run();
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
    const j = d.prepare("SELECT state, attempts FROM jobs WHERE version_id = 'v3' AND kind = 'describe'").get() as { state: string; attempts: number };
    expect(j).toMatchObject({ state: "queued", attempts: 0 }); // never claimed, so no attempt spent
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
