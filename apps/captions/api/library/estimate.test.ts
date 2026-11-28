import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("../ai-complete", async (real) => {
  const m = await real<typeof import("../ai-complete")>();
  return { ...m, aiFor: vi.fn(() => ({ only: ["mac"] })) };
});

// the versions a plug-in's computer work is still making ready (Face Blur's blurred copies)
const preparing = vi.hoisted(() => ({ ids: [] as { versionId: string; running?: true; waiting?: true; failed?: true }[] }));
vi.mock("../lib/plugin", async (real) => ({ ...(await real<typeof import("../lib/plugin")>()), pluginDeviceJobs: () => [{ preparing: () => preparing.ids }] }));

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-estimate-"));
process.env.DATA_DIR = dir;
delete process.env.APP_SECRET; // the solo install: "local" is the admin, the server's Deepgram key is theirs
delete process.env.ANTHROPIC_API_KEY;
process.env.DEEPGRAM_API_KEY = "dg-test";
const { libraryDb } = await import("./db");
const { claimJob, enqueueJob, folderWalks, watchedFolders } = await import("./jobs");
const { estimate, libraryStatus, progress } = await import("./estimate");
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
    // measured: 20 s each, three at a time on a connected AI (one slot kept for its person)
    expect(step("describe").route).toBe("provider");
    expect(step("describe").seconds).toBeCloseTo(2000 / 3, 5);
    expect(step("embed").route).toBe("none"); // on by default, no OpenAI key
    expect(e.seconds).toBe(Math.max(...e.steps.map((s) => s.seconds)));
    // the person's own computer makes them with no key
    process.env.CT_LOCAL = "1";
    const here = await estimate("lib_e", "local", { clips: 100, bytes: 100 * 30_000_000 });
    delete process.env.CT_LOCAL;
    expect(here.steps.find((x) => x.step === "embed")).toMatchObject({ route: "device", seconds: 200 });
  });

  it("leaves out a blurred copy's job that only took its original's result", async () => {
    // done when copied over (blur-mirror.ts), its start from a try days before: no work, and no hours of pace
    d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES ('ab', 'lib_e', 'video', 'c', 'vb', 'local', 1)").run();
    d.prepare(
      `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at, blurred_of)
       VALUES ('vb', 'ab', 1, 'k', 30000000, 'sb', '{"duration":60,"vcodec":"h264"}', 'ready', 'local', 1, 's1')`,
    ).run();
    d.prepare("INSERT INTO jobs (library_id, version_id, kind, state, actor, started_at, done_at) VALUES ('lib_e', 'vb', 'describe', 'done', 'local', 0, 900000000)").run();
    d.prepare("INSERT INTO descriptions (version_id, source, text, provider, created_at) VALUES ('vb', 'ai', 'x', 'mac-instance', 1)").run();
    try {
      const e = await estimate("lib_e", "local", { clips: 100, bytes: 100 * 30_000_000 });
      expect(e.steps.find((x) => x.step === "describe")!.seconds).toBeCloseTo(2000 / 3, 5);
    } finally {
      // whatever the check says: left behind, these rows fail the tests after it too
      for (const t of ["descriptions", "jobs", "asset_versions"]) d.prepare(`DELETE FROM ${t} WHERE ${t === "asset_versions" ? "id" : "version_id"} = 'vb'`).run();
      d.prepare("DELETE FROM assets WHERE id = 'ab'").run();
    }
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
    // Stop leaves what is made as a file comes in (thumbnail, footage fingerprints): nothing to stop, so no Stop
    enqueueJob(d, "lib_e", "v1", "fingerprint", "local");
    expect((await progress("lib_e", "local")).canStop).toBe(false);
    enqueueJob(d, "lib_e", "v1", "sprite", "local");
    expect((await progress("lib_e", "local")).canStop).toBe(true);
    d.prepare("DELETE FROM jobs WHERE kind IN ('thumb', 'fingerprint', 'sprite')").run();
  });

  it("a clip in the trash is never work left, even one trashed partway through a run: its jobs wait for it to come back", async () => {
    const checks = async () => {
      const p = await progress("lib_e", "local");
      return { left: p.left, share: p.share, line: p.stages?.find((s) => s.kind === "fingerprint") };
    };
    enqueueJob(d, "lib_e", "v1", "fingerprint", "local");
    enqueueJob(d, "lib_e", "v2", "fingerprint", "local");
    try {
      expect(await checks()).toMatchObject({ left: 2, line: { done: 0, of: 2 } });
      // trashed while the run is on: its line leaves with it and it counts as through (v2 has done none of this run's
      // steps, its description from before not counted: 1 of 2)
      d.prepare("UPDATE assets SET trashed_at = 1 WHERE id = 'a1'").run();
      expect(await checks()).toMatchObject({ left: 1, line: { done: 0, of: 1 }, share: 0.5 });
      d.prepare("UPDATE assets SET trashed_at = 1 WHERE id = 'a2'").run();
      expect(await checks()).toEqual({ left: 0, share: 0, line: undefined });
      d.prepare("UPDATE assets SET trashed_at = NULL WHERE id IN ('a1', 'a2')").run();
      expect((await checks()).left).toBe(2);
    } finally {
      d.prepare("UPDATE assets SET trashed_at = NULL WHERE id IN ('a1', 'a2')").run();
      d.prepare("DELETE FROM jobs WHERE kind = 'fingerprint'").run();
    }
  });

  it("the whole library's status counts every clip in it, never the trash", () => {
    d.prepare("INSERT INTO jobs (library_id, version_id, kind, state) VALUES ('lib_e', 'v1', 'transcribe', 'failed'), ('lib_e', 'v2', 'transcribe', 'needs_key')").run();
    expect(libraryStatus("lib_e")).toEqual({
      clips: 3,
      unreadable: 0,
      stages: [
        { kind: "transcribe", done: 0, failed: 1, open: 1, of: 2 },
        { kind: "describe", done: 3, failed: 0, open: 0, of: 3 },
      ],
    });
    d.prepare("UPDATE assets SET trashed_at = 1 WHERE id = 'a1'").run();
    expect(libraryStatus("lib_e").stages[0]).toMatchObject({ failed: 0, of: 1 });
    d.prepare("UPDATE assets SET trashed_at = NULL WHERE id = 'a1'").run();
    d.prepare("DELETE FROM jobs WHERE kind = 'transcribe'").run();
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
  it("each step since this run began, in the order they run: a clip that is through stays counted, so no number goes down; what it finished before is not counted", async () => {
    d.prepare("DELETE FROM jobs WHERE state != 'done'").run();
    for (const v of ["v1", "v2", "v3"]) for (const k of ["proxy", "thumb", "transcribe"]) enqueueJob(d, "lib_e", v, k, "local");
    const counts = async () => (await progress("lib_e", "local")).stages!.map((s) => `${s.kind} ${s.done}/${s.of}`);
    // their descriptions were made before (the setup above): not this run's work, so no line (548 clips joining for a
    // duplicate check once showed as "509 of 509 descriptions")
    expect(await counts()).toEqual(["thumb 0/3", "proxy 0/3", "transcribe 0/3"]);
    // v1 is through every step, v2 and v3 have their pictures
    d.prepare("UPDATE jobs SET state = 'done', done_at = ? WHERE state = 'queued' AND (version_id = 'v1' OR kind = 'thumb')").run(Date.now());
    expect(await counts()).toEqual(["thumb 3/3", "proxy 1/3", "transcribe 1/3"]);
    const running = d.prepare("UPDATE jobs SET state = 'running', started_at = ? WHERE version_id = 'v2' AND kind = 'proxy' RETURNING id").get(Date.now()) as { id: number };
    expect((await progress("lib_e", "local")).stages!.find((s) => s.kind === "proxy")).toMatchObject({ done: 1, of: 3, now: "c" });
    d.prepare("UPDATE jobs SET state = 'failed' WHERE id = ?").run(running.id);
    expect((await progress("lib_e", "local")).stages!.find((s) => s.kind === "proxy")).toMatchObject({ done: 1, of: 3, failed: 1 });
    // one that parks for a key is still to do on its line (and said in `waiting`): the line does not shrink
    d.prepare("UPDATE jobs SET state = 'needs_key', error = 'Add your Deepgram key' WHERE kind = 'transcribe' AND version_id = 'v2'").run();
    expect((await progress("lib_e", "local")).stages!.find((s) => s.kind === "transcribe")).toMatchObject({ done: 1, of: 3 });
    // the queue empties: the next run counts from nothing
    d.prepare("UPDATE jobs SET state = 'done', done_at = ? WHERE state = 'queued'").run(Date.now() - 3_600_000);
    expect(await progress("lib_e", "local")).toMatchObject({ left: 0, stages: [] });
    enqueueJob(d, "lib_e", "v3", "embed", "local", true);
    // search by meaning has no key here: it is no line (it waits for a key in `waiting`, once claimed); v3's earlier
    // steps were the run before
    expect(await counts()).toEqual([]);
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
    const done = (v: string, kind: string) => d.prepare("UPDATE jobs SET state = 'done', done_at = ? WHERE version_id = ? AND kind = ?").run(Date.now(), v, kind);
    // the folder holds three clips, none handed over yet
    watchedFolders.set("lib_e", new Set(["/Volumes/Card/Trip"]));
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
    // a folder taken off the watch list while clips were still to come: they are no longer counted, and the run ends
    d.prepare("DELETE FROM jobs WHERE state != 'done'").run();
    folderWalks.set("lib_e\0/Volumes/Card/Trip", { files: 3, adding: 2 });
    expect((await progress("lib_e", "local")).left).toBe(2);
    watchedFolders.set("lib_e", new Set());
    expect(await progress("lib_e", "local")).toMatchObject({ left: 0, clips: 0 });
    } finally {
      folderWalks.clear();
      watchedFolders.clear();
      d.prepare("DELETE FROM jobs WHERE state != 'done'").run();
    }
  });
});

describe("a run of timelines", () => {
  it("counts every clip that wants one from the start, paces the time left by the timelines made, and Stop ends it: the waiting looks go back to done, nothing is queued again, and a look that ends later still brings its timeline", async () => {
    const { saveMyKey } = await import("../my-keys");
    const { stopQueued } = await import("./made");
    const { sweepWatch, wantsWatch } = await import("./timeline");
    const { MAC_WAITS } = await import("./shots");
    const { leaveToComputers } = await import("./worker");
    d.prepare("DELETE FROM jobs WHERE state != 'done'").run();
    saveMyKey("local", "GEMINI_API_KEY", "gk-test");
    // a B-roll clip with its shot descriptions and no timeline yet, its look ended at `at`
    const clip = (id: string, at: number, started: number | null = null) => {
      d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at, roll) VALUES (?, 'lib_e', 'video', ?, ?, 'local', 1, 'b')").run(`ast-${id}`, id, `ver-${id}`);
      d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at) VALUES (?, ?, 1, 'k', 1, ?, '{\"duration\":30}', 'ready', 'local', 1)").run(`ver-${id}`, `ast-${id}`, `sha-${id}`);
      d.prepare("INSERT INTO stretches (version_id, seg, a, b, motion, text, created_at) VALUES (?, 0, 0, 4, 0.5, 'A jump.', 1)").run(`ver-${id}`);
      d.prepare("INSERT INTO jobs (library_id, version_id, kind, state, actor, started_at, done_at) VALUES ('lib_e', ?, 'look', 'done', 'local', ?, ?)").run(`ver-${id}`, started, at);
    };
    const look = (id: string) => d.prepare("SELECT id, state FROM jobs WHERE version_id = ? AND kind = 'look'").get(`ver-${id}`) as { id: number; state: string };
    const status = leaveToComputers.status;
    for (const id of ["t1", "t2", "t3"]) clip(id, 1);
    try {
      expect(await progress("lib_e", "local")).toMatchObject({ left: 3, clips: 3, canStop: true });
      // one being watched now is not to queue any more and not made yet: still a clip of the run (left out, the strip
      // said 47 clips beside "of 51")
      const { watching } = await import("./timeline");
      watching.set("ver-t2", Promise.resolve());
      expect(await progress("lib_e", "local")).toMatchObject({ left: 3, clips: 3 });
      watching.delete("ver-t2");
      // the sweep queues the first one's look again: still three, one of them on its way
      d.prepare("UPDATE jobs SET state = 'queued' WHERE version_id = 'ver-t1' AND kind = 'look'").run();
      const p = await progress("lib_e", "local");
      expect(p).toMatchObject({ left: 3, canStop: true });
      expect(p.stages?.find((x) => x.kind === "look")).toMatchObject({ of: 3 });
      // the time left is the pace timelines come in at (one every 30 s here), not the moment a look takes this server:
      // from the run before too (an hour ago), so a run says its time from its first clip, not "under a minute"
      const at = Date.now();
      for (const [i, id] of ["p1", "p2", "p3"].entries()) {
        d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at, roll) VALUES (?, 'lib_e', 'video', ?, ?, 'local', 1, 'b')").run(`ast-${id}`, id, `ver-${id}`);
        d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES (?, ?, 1, 'k', 1, ?, 'ready', 'local', 1)").run(`ver-${id}`, `ast-${id}`, `sha-${id}`);
        d.prepare("INSERT INTO timelines (version_id, events, error, at) VALUES (?, '[]', NULL, ?)").run(`ver-${id}`, at - 3_600_000 + i * 30_000);
      }
      expect((await progress("lib_e", "local")).seconds).toBeCloseTo(90, 0);
      // the sweep has queued them all and each waits for its Mac, which lists them: none still to queue, and the run is
      // the same three at the same pace, with Stop
      d.prepare("UPDATE jobs SET state = 'needs_key', error = ? WHERE kind = 'look' AND version_id IN ('ver-t1', 'ver-t2', 'ver-t3')").run(MAC_WAITS);
      const ids = ["t1", "t2", "t3"].map((id) => look(id).id);
      leaveToComputers.status = (() => ({ at: Date.now(), byJob: new Map(), queuedIds: [], waitingIds: [], queuedLookIds: ids, queuedLookVersions: [] })) as never;
      const tail = await progress("lib_e", "local");
      expect(tail).toMatchObject({ left: 3, canStop: true });
      expect(tail.seconds).toBeCloseTo(90, 0);
      leaveToComputers.status = status;
      d.prepare("UPDATE jobs SET state = 'queued', error = NULL WHERE version_id = 'ver-t1' AND kind = 'look'").run();
      d.prepare("UPDATE jobs SET state = 'done', error = NULL WHERE kind = 'look' AND version_id IN ('ver-t2', 'ver-t3')").run();
      // Cancel on shot descriptions leaves a look that runs again for its timeline; Cancel on the timelines ends the run
      stopQueued("lib_e", "look", "local");
      expect(look("t1").state).toBe("queued");
      const stopped = Date.now() + 1000;
      stopQueued("lib_e", "timeline", "local", stopped);
      expect(look("t1").state).toBe("done");
      expect(await progress("lib_e", "local")).toMatchObject({ left: 0, clips: 0 });
      expect(sweepWatch(d, () => true)).toBe(false);
      // a clip whose look ends after the Stop (its first, or a new clip's) is the sweep's again: Timelines is still on
      clip("t4", stopped + 1);
      // a look already running at the Stop ends after it, and brings no timeline: not by itself, not by the sweep
      clip("t5", stopped + 2, stopped - 1);
      expect(wantsWatch(d, "ver-t5", "local")).toBe(false);
      expect(wantsWatch(d, "ver-t4", "local")).toBe(true);
      const taken: string[] = [];
      expect(sweepWatch(d, (id) => !!taken.push(id))).toBe(true);
      expect(taken).toEqual(["ver-t4"]);
    } finally {
      leaveToComputers.status = status;
      saveMyKey("local", "GEMINI_API_KEY", null);
      d.prepare("UPDATE assets SET trashed_at = 1 WHERE id IN ('ast-t1', 'ast-t2', 'ast-t3', 'ast-t4', 'ast-t5', 'ast-p1', 'ast-p2', 'ast-p3')").run();
      d.prepare("UPDATE libraries SET settings = json_remove(settings, '$.timelineStopped') WHERE id = 'lib_e'").run();
    }
  });
});

describe("clips being blurred", () => {
  it("counts each clip once, and a clip still being blurred from the start", async () => {
    d.prepare("DELETE FROM jobs WHERE state != 'done'").run();
    // a1's blurred copy is in: its analysis runs on the original, its picture on the copy
    d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at) VALUES ('v1b', 'a1', 2, 'k', 1, 's1b', '{}', 'ready', 'local', 1)").run();
    enqueueJob(d, "lib_e", "v1", "transcribe", "local", true);
    enqueueJob(d, "lib_e", "v1b", "thumb", "local");
    preparing.ids = [{ versionId: "v2", running: true }, { versionId: "v3" }];
    try {
      const first = await progress("lib_e", "local");
      expect(first).toMatchObject({ clips: 3 });
      // the Mac's blurring is a step of its own: the clip it is on, and how many of the run are through
      expect(first.stages![0]).toMatchObject({ kind: "blur", done: 0, of: 2, failed: 0 });
      expect(first.stages![0]!.now).toBeTruthy();
      // a1 through before the next copy is in, only the Mac blurring: still said, and the run goes on (its line stays)
      d.prepare("UPDATE jobs SET state = 'done', done_at = ? WHERE version_id IN ('v1', 'v1b') AND state != 'done'").run(Date.now());
      const between = await progress("lib_e", "local");
      expect(between).toMatchObject({ clips: 2 });
      expect(between.stages!.find((s) => s.kind === "transcribe")).toMatchObject({ done: 1, of: 1 });
      expect(between.share).toBeGreaterThan(0);
      // v2's copy is in (off the queue); v3's Mac went offline: waiting, not done, and its clip no longer counted
      preparing.ids = [{ versionId: "v3", waiting: true }, { versionId: "v9", failed: true }];
      enqueueJob(d, "lib_e", "v2", "transcribe", "local", true);
      const later = await progress("lib_e", "local");
      expect(later).toMatchObject({ clips: 1 });
      expect(later.stages![0]).toMatchObject({ kind: "blur", done: 1, of: 2, failed: 0 });
      d.prepare("DELETE FROM jobs WHERE state != 'done'").run();
      preparing.ids = [];
      expect(await progress("lib_e", "local")).toMatchObject({ left: 0, clips: 0 });
    } finally {
      preparing.ids = [];
      d.prepare("DELETE FROM jobs WHERE state != 'done'").run();
      d.prepare("DELETE FROM asset_versions WHERE id = 'v1b'").run();
    }
  });
});

describe("the plan's usage limit", () => {
  it("holds every queued description, says why, and counts them as waiting, not as work left", async () => {
    d.prepare("DELETE FROM jobs WHERE state != 'done'").run();
    d.prepare("DELETE FROM jobs WHERE kind = 'describe'").run();
    for (const v of ["v1", "v2", "v3"]) enqueueJob(d, "lib_e", v, "describe", "local", true); // described before (the pace fixture): asked again
    enqueueJob(d, "lib_e", "v1", "describe", "someone-else"); // already queued: stays local's
    holdForLimit(d, "local", "Your Claude plan's weekly limit is reached; it resets 5pm.", Date.now() + 60_000);
    const p = await progress("lib_e", "local");
    expect(p.left).toBe(0);
    expect(p.waiting).toEqual([
      { step: "describe", count: 3, missing: "Your Claude plan's weekly limit is reached; it resets 5pm. They continue then.", limit: true },
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
    enqueueJob(d, "lib_e", "v3", "describe", "local", true); // described before (the pace fixture): asked again
    expect(await tick(Date.now(), ["describe"])).toBe(false);
    const j = d.prepare("SELECT state, attempts FROM jobs WHERE version_id = 'v3' AND kind = 'describe'").get() as { state: string; attempts: number };
    expect(j).toMatchObject({ state: "queued", attempts: 0 }); // never claimed, so no attempt spent
  });

  it("a connected AI takes four descriptions at a time", () => {
    const a = describeSlot("local");
    const b = describeSlot("local");
    const b2 = describeSlot("local");
    const b3 = describeSlot("local");
    expect(a && b && b2 && b3).toBeTruthy();
    expect(describeSlot("local")).toBeNull();
    a!();
    a!(); // giving a turn back twice frees one
    const c = describeSlot("local");
    expect(c).toBeTruthy();
    expect(describeSlot("local")).toBeNull();
    b!();
    b2!();
    b3!();
    c!();
  });

  it("the Effort row: ready footage with no describe done yet, and an hour's cost at this library's effort", async () => {
    // Low (describe only): the step left to analyze is the description
    d.prepare(`INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_u', 'local', 'U', 'local', '{"describe":true,"look":false}', 1)`).run();
    d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES ('au1', 'lib_u', 'video', 'c', 'vu1', 'local', 1)").run();
    d.prepare(
      `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at)
       VALUES ('vu1', 'au1', 1, 'k', 1, 'su1', '{"duration":3600,"vcodec":"h264"}', 'ready', 'local', 1)`,
    ).run();
    const before = await estimate("lib_u", "local", { clips: 0, bytes: 0 });
    expect(before.unanalyzed?.seconds).toBe(3600);
    expect(Number.isFinite(before.unanalyzed?.hourUsd)).toBe(true);
    // once described, nothing is left to analyze
    d.prepare("INSERT INTO jobs (library_id, version_id, kind, state, actor, started_at, done_at) VALUES ('lib_u', 'vu1', 'describe', 'done', 'local', 0, 1)").run();
    expect((await estimate("lib_u", "local", { clips: 0, bytes: 0 })).unanalyzed?.seconds).toBe(0);
  });

  it("a flying timeline keeps share < 1, ETA > 0, and a timeline stage even when its look finished before the run; trashed relooks do not enable Stop", async () => {
    const { watching } = await import("./timeline");
    const { saveMyKey } = await import("../my-keys");
    d.prepare("DELETE FROM jobs WHERE state != 'done'").run();
    saveMyKey("local", "GEMINI_API_KEY", "gk-test");
    // clear run state so runSince starts fresh now
    await progress("lib_e", "local");
    // seed 3 past timelines for a 30 s watchPace, plus one clip whose look finished long ago (done_at = 1)
    const now = Date.now();
    for (const [i, id] of ["f1", "f2", "f3"].entries()) {
      d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at, roll) VALUES (?, 'lib_e', 'video', ?, ?, 'local', 1, 'b')").run(`ast-${id}`, id, `ver-${id}`);
      d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at) VALUES (?, ?, 1, 'k', 1, ?, '{\"duration\":30}', 'ready', 'local', 1)").run(`ver-${id}`, `ast-${id}`, `sha-${id}`);
      d.prepare("INSERT INTO timelines (version_id, events, error, at) VALUES (?, '[]', NULL, ?)").run(`ver-${id}`, now - 90_000 + i * 30_000);
    }
    d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at, roll) VALUES ('ast-fly', 'lib_e', 'video', 'Flying clip', 'ver-fly', 'local', 1, 'b')").run();
    d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at) VALUES ('ver-fly', 'ast-fly', 1, 'k', 1, 'sha-fly', '{\"duration\":30}', 'ready', 'local', 1)").run();
    d.prepare("INSERT INTO stretches (version_id, seg, a, b, motion, text, created_at) VALUES ('ver-fly', 0, 0, 4, 0.5, 'A jump.', 1)").run();
    d.prepare("INSERT INTO jobs (library_id, version_id, kind, state, actor, done_at) VALUES ('lib_e', 'ver-fly', 'look', 'done', 'local', 1)").run();
    // also a trashed asset with a queued relook job: must not set canStop
    d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at, roll, trashed_at) VALUES ('ast-trelook', 'lib_e', 'video', 'Trashed', 'ver-trelook', 'local', 1, 'b', 10)").run();
    d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at) VALUES ('ver-trelook', 'ast-trelook', 1, 'k', 1, 'sha-tr', '{\"duration\":30}', 'ready', 'local', 1)").run();
    d.prepare("INSERT INTO stretches (version_id, seg, a, b, motion, text, created_at) VALUES ('ver-trelook', 0, 0, 4, 0.5, 'Old.', 1)").run();
    d.prepare("INSERT INTO jobs (library_id, version_id, kind, state, actor) VALUES ('lib_e', 'ver-trelook', 'look', 'queued', 'local')").run();
    watching.set("ver-fly", Promise.resolve());
    try {
      const p = await progress("lib_e", "local");
      expect(p).toMatchObject({ left: 1, clips: 1, canStop: false });
      expect(p.share).toBeLessThan(1);
      expect(p.seconds).toBeCloseTo(30, 0);
      expect(p.stages).toContainEqual({ kind: "timeline", done: 0, of: 1, failed: 0, now: "Flying clip" });
    } finally {
      watching.delete("ver-fly");
      saveMyKey("local", "GEMINI_API_KEY", null);
      d.prepare("DELETE FROM jobs WHERE version_id IN ('ver-fly', 'ver-trelook')").run();
      d.prepare("UPDATE assets SET trashed_at = 1 WHERE id IN ('ast-f1', 'ast-f2', 'ast-f3', 'ast-fly')").run();
    }
  });
});
