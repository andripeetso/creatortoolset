import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "../auth";

// What's made (made.ts): the counts per kind, Make for the missing, a kind a file has never queued again (jobs.ts HAVE),
// and a switch turned on making for new files only (db.ts SINCE).
vi.mock("../lib/devices", async (real) => {
  const m = await real<typeof import("../lib/devices")>();
  const own: Record<string, { id: string; name: string; owner: string }> = { dev_mine: { id: "dev_mine", name: "Studio Mac", owner: "local" }, dev_theirs: { id: "dev_theirs", name: "Anna's Mac", owner: "anna" } };
  return { ...m, deviceOf: (id: string) => own[id] ?? m.deviceOf(id) };
});
vi.mock("../ai-complete", async (real) => {
  const m = await real<typeof import("../ai-complete")>();
  return { ...m, aiFor: vi.fn(() => ({ only: ["mac"] })) };
});

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-made-"));
process.env.DATA_DIR = dir;
delete process.env.APP_SECRET; // the solo install: "local" is the admin
const { libraryDb } = await import("./db");
const { enqueueJob } = await import("./jobs");
const { engineOf, libraryMade, makeMissing, remakePictures, retryEmptyPictures, retryFailed, STILLS_FIXED_AT, stopQueued } = await import("./made");
const { queueLook, sweepLook } = await import("./shots");
const { libraryApp } = await import("./routes");
const { leaveToComputers } = await import("./worker");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: "local", role: "admin" } as never);
  return next();
});
app.route("/api/library", libraryApp);

const d = libraryDb();
d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_m', 'local', 'Made', 'local', ?, 0)").run(
  JSON.stringify({ look: false, proxy: false, describe: false }),
);

/** A ready B-roll video of `seconds`, added at `at`, 4K so it wants a proxy. */
function clip(id: string, o: { at?: number; seconds?: number; kind?: string } = {}) {
  const v = `ver-${id}`;
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at, roll) VALUES (?, 'lib_m', ?, ?, ?, 'local', ?, 'b')").run(id, o.kind ?? "video", id, v, o.at ?? 1);
  d.prepare(
    `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at) VALUES (?, ?, 1, ?, 1000, ?, ?, 'ready', 'local', ?)`,
  ).run(v, id, `libraries/lib_m/v/${v}/source`, `sha-${id}`, JSON.stringify({ duration: o.seconds ?? 30, format: "mov,mp4,m4a,3gp,3g2,mj2", vcodec: "hevc", acodec: "aac", width: 3840, height: 2160 }), o.at ?? 1);
  return v;
}
const job = (v: string, kind: string) => d.prepare("SELECT state, error FROM jobs WHERE version_id = ? AND kind = ?").get(v, kind) as { state: string; error: string | null } | undefined;
const row = async (kind: string) => (await libraryMade("lib_m", "local")).find((m) => m.kind === kind)!;

// an archive's clip, brought in with its transcript, description and thumbnail; and a clip with none
const archived = clip("ast-old");
d.prepare("INSERT INTO transcripts (version_id, provider, language, text, segments, created_at) VALUES (?, 'archive', 'en', 'Hello', '[]', 1)").run(archived);
d.prepare("INSERT INTO descriptions (version_id, source, text, provider, created_at) VALUES (?, 'user', 'A cartwheel.', NULL, 1)").run(archived);
d.prepare("INSERT INTO derivatives (version_id, kind, storage_key, bytes) VALUES (?, 'thumb', 'k', 1)").run(archived);
const bare = clip("ast-bare");

describe("what's made", () => {
  it("counts per kind how many files have it and lack it, with its cost", async () => {
    expect(await row("transcribe")).toMatchObject({ have: 1, missing: 1, queued: 0 });
    expect(await row("describe")).toMatchObject({ have: 1, missing: 1, cost: "tokens" });
    expect(await row("thumb")).toMatchObject({ have: 1, missing: 1, cost: "free" });
    expect(await row("proxy")).toMatchObject({ have: 0, missing: 2 });
    expect(await row("embed")).toMatchObject({ have: 0, missing: 1 }); // only a file with words to search
  });

  it("Make for the missing queues only the files that lack it", async () => {
    expect(makeMissing("lib_m", "transcribe", "local")).toBe(1);
    expect(job(bare, "transcribe")?.state).toBe("queued");
    expect(job(archived, "transcribe")).toBeUndefined();
    expect(await row("transcribe")).toMatchObject({ have: 1, missing: 0, queued: 1 });
  });

  it("a file that has a kind is never queued for it again, by ingest or by Retry", () => {
    enqueueJob(d, "lib_m", archived, "describe", "local");
    expect(job(archived, "describe")?.state).toBe("done");
    enqueueJob(d, "lib_m", bare, "describe", "local");
    expect(job(bare, "describe")?.state).toBe("queued");
    d.prepare("INSERT INTO jobs (library_id, version_id, kind, state, actor) VALUES ('lib_m', ?, 'thumb', 'failed', 'local')").run(archived);
    expect(retryFailed("lib_m", "thumb")).toBe(1);
    expect(job(archived, "thumb")?.state).toBe("done");
    // asked for by name, it is made again
    enqueueJob(d, "lib_m", archived, "transcribe", "local", true);
    expect(job(archived, "transcribe")?.state).toBe("queued");
  });

  it("at start, a photo whose card picture came out empty is sent again; other failures stay", () => {
    const empty = "ENOENT: no such file or directory, rename '/x/thumb.jpg.part.jpg' -> '/x/thumb.jpg'";
    d.prepare("INSERT INTO jobs (library_id, version_id, kind, state, actor, error) VALUES ('lib_m', ?, 'send', 'failed', 'local', ?)").run(bare, empty);
    d.prepare("INSERT INTO jobs (library_id, version_id, kind, state, actor, error) VALUES ('lib_m', ?, 'send', 'failed', 'local', 'Moov atom not found')").run(archived);
    expect(retryEmptyPictures()).toBe(1);
    expect(job(bare, "send")?.state).toBe("queued");
    expect(job(archived, "send")?.state).toBe("failed");
    // one that failed again on a fixed computer is a failure of its own: never sent again at each start
    d.prepare("UPDATE jobs SET state = 'failed', error = ?, started_at = ? WHERE version_id = ? AND kind = 'send'").run(empty, STILLS_FIXED_AT + 1, bare);
    expect(retryEmptyPictures()).toBe(0);
  });

  it("turning a switch on makes for new files only, never the ones already here", async () => {
    const patch = (settings: Record<string, unknown>) =>
      app.request("/api/library/lib_m", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ settings }) });
    expect((await patch({ look: true, proxy: true })).status).toBe(200);
    expect(job(bare, "proxy")).toBeUndefined();
    expect(job(archived, "proxy")).toBeUndefined();
    d.prepare("UPDATE jobs SET state = 'done' WHERE state = 'queued'").run(); // a busy clip waits for its own steps
    while (await sweepLook(d)) {
      /* the sweep queues what it may */
    }
    expect(job(bare, "look")).toBeUndefined();
    // a description made for an older file (Make for the missing) brings no look with it
    expect(queueLook(d, bare, "local")).toBe(false);
    const fresh = clip("ast-new", { at: Date.now() + 1000 });
    while (await sweepLook(d, Date.now() + 2000)) {
      /* the new file gets its look */
    }
    expect(job(fresh, "look")?.state).toBe("queued");
    // and the old one only when asked
    expect(makeMissing("lib_m", "look", "local")).toBe(2);
    expect(job(bare, "look")?.state).toBe("queued");
  });

  it("timelines: a press covers the files with none once; a watch that fails after it is missing again", async () => {
    const v = clip("ast-tl", { at: 5 });
    d.prepare("INSERT INTO stretches (version_id, seg, a, b, motion, text, created_at) VALUES (?, 0, 0, 4, 0.5, 'A jump.', 1)").run(v);
    const before = await row("timeline");
    expect(before.missing).toBeGreaterThanOrEqual(1);
    makeMissing("lib_m", "timeline", "local", Date.now() - 10);
    expect(await row("timeline")).toMatchObject({ missing: 0, queued: before.queued + before.missing });
    d.prepare("INSERT INTO timelines (version_id, events, error, at) VALUES (?, '[]', 'failed', ?)").run(v, Date.now());
    expect((await row("timeline")).missing).toBe(1);
  });

  it("a video indexed on a Mac counts for transcripts (its probe has no sound codec)", async () => {
    const before = (await row("transcribe")).missing;
    const v = "ver-ast-mac";
    d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES ('ast-mac', 'lib_m', 'video', 'mac', ?, 'local', 1)").run(v);
    d.prepare(
      `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at) VALUES (?, 'ast-mac', 1, 'mac:/Movies/a.mov', 1000, 'sha-mac', ?, 'ready', 'local', 1)`,
    ).run(v, JSON.stringify({ duration: 3, format: "mov,mp4,m4a,3gp,3g2,mj2", vcodec: "h264", width: 1280, height: 720 }));
    expect((await row("transcribe")).missing).toBe(before + 1);
  });

  it("a failed job is counted as failed (Retry), not missing, and Make for the missing leaves it", async () => {
    const v = clip("ast-fail", { seconds: 4 });
    d.prepare("INSERT INTO jobs (library_id, version_id, kind, state, actor) VALUES ('lib_m', ?, 'sprite', 'failed', 'local')").run(v);
    const r = await row("sprite");
    expect(r.failed).toBe(1);
    expect(makeMissing("lib_m", "sprite", "local")).toBe(r.missing);
    expect(job(v, "sprite")?.state).toBe("failed");
    expect((await row("sprite")).failed).toBe(1);
  });

  it("music or sound effect, and A-roll or B-roll: counted, sorted by themselves, with no Make", async () => {
    clip("ast-song", { kind: "audio" });
    d.prepare("INSERT INTO asset_tags (asset_id, tag, source) VALUES ('ast-song', 'music', 'ai')").run();
    clip("ast-talk", { kind: "audio" }); // Gemini heard talk: both tags turned down, settled
    d.prepare("INSERT INTO tag_rejections (asset_id, tag) VALUES ('ast-talk', 'music'), ('ast-talk', 'sound effect')").run();
    clip("ast-hum", { kind: "audio" });
    expect(await row("sound")).toMatchObject({ have: 2, missing: 1, cost: "free" });
    expect(stopQueued("lib_m", "thumb", "local")).toBe(0); // a file is ready once it has one: no Cancel
    const before = (await row("roll")).missing;
    clip("ast-unsorted");
    d.prepare("UPDATE assets SET roll = NULL WHERE id = 'ast-unsorted'").run();
    expect((await row("roll")).missing).toBe(before + 1);
    expect((await app.request("/api/library/lib_m/made/sound", { method: "POST" })).status).toBe(400);
  });

  it("says why the queued wait, or which of the person's computers makes them; another person's computer is never named", async () => {
    const v = clip("ast-wait");
    const id = Number(d.prepare("INSERT INTO jobs (library_id, version_id, kind, state, actor) VALUES ('lib_m', ?, 'fingerprint', 'queued', 'local')").run(v).lastInsertRowid);
    const before = leaveToComputers.status;
    const snap = (c: object) => () => ({ at: Date.now(), byJob: new Map([[id, c]]), queuedIds: [], waitingIds: [], queuedLookIds: [], queuedLookVersions: [] }) as never;
    try {
      leaveToComputers.status = snap({ wait: "offline", reason: "Studio Mac is offline", href: "/settings/devices", actor: "local" });
      expect(await row("fingerprint")).toMatchObject({ queued: 1, why: "Studio Mac is offline", href: "/settings/devices" });
      leaveToComputers.status = snap({ wait: "queued", device: "dev_mine", actor: "local" });
      expect(await row("fingerprint")).toMatchObject({ queued: 1, by: "Studio Mac" });
      leaveToComputers.status = snap({ wait: "queued", device: "dev_theirs", actor: "local" });
      expect((await row("fingerprint")).by).toBeUndefined();
      d.prepare("UPDATE jobs SET state = 'running', held_by = 'dev_mine' WHERE id = ?").run(id);
      expect(await row("fingerprint")).toMatchObject({ queued: 1, by: "Studio Mac" });
    } finally {
      leaveToComputers.status = before;
      d.prepare("UPDATE jobs SET state = 'done', held_by = NULL WHERE id = ?").run(id);
    }
  });

  it("says what makes each kind and where, which files it skips and why, and Cancel takes the queued off", async () => {
    expect(engineOf("lib_m", "wave", "local")).toMatchObject({ engine: "FFmpeg" });
    expect(engineOf("lib_m", "timeline", "local").engine).toMatch(/Gemini|Antigravity/);
    const silent = "ver-ast-silent";
    d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at, roll) VALUES ('ast-silent', 'lib_m', 'video', 'silent', ?, 'local', 1, 'b')").run(silent);
    d.prepare(
      `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at) VALUES (?, 'ast-silent', 1, 'libraries/lib_m/v/s/source', 1000, 'sha-silent', ?, 'ready', 'local', 1)`,
    ).run(silent, JSON.stringify({ duration: 9, format: "mov,mp4,m4a,3gp,3g2,mj2", vcodec: "h264", width: 1280, height: 720 }));
    const t = await row("transcribe");
    expect(t.skipped?.why).toBe("no sound, or music");
    expect(t.skipped!.n).toBeGreaterThanOrEqual(1);
    const v = clip("ast-stop");
    enqueueJob(d, "lib_m", v, "sprite", "local");
    expect(job(v, "sprite")?.state).toBe("queued");
    expect(stopQueued("lib_m", "sprite", "local")).toBeGreaterThanOrEqual(1);
    // ended, not deleted: a sweep queues a file with no job row again
    expect(job(v, "sprite")).toMatchObject({ state: "stopped", error: null });
    // stopped is its own count: not failed, not missing (Make for the missing leaves it), and Retry takes it
    const sprite = (await libraryMade("lib_m", "local")).find((m) => m.kind === "sprite")!;
    expect(sprite.stopped).toBeGreaterThanOrEqual(1);
    expect(makeMissing("lib_m", "sprite", "local")).toBe(sprite.missing);
    expect(job(v, "sprite")?.state).toBe("stopped");
    expect(retryFailed("lib_m", "sprite")).toBeGreaterThanOrEqual(1);
    expect(job(v, "sprite")?.state).toBe("queued");
    // stopping pressed timelines leaves shot descriptions queued
    const look = clip("ast-look", { seconds: 120 });
    d.prepare("INSERT INTO jobs (library_id, version_id, kind, state, actor) VALUES ('lib_m', ?, 'look', 'queued', 'local')").run(look);
    stopQueued("lib_m", "timeline", "local");
    expect(job(look, "look")?.state).toBe("queued");
  });
});

describe("pictures made again", () => {
  it("a clip whose picture was never kept while it waited for its blur gets one once it may show it", () => {
    clip("ast-waited");
    const v = "ver-ast-waited";
    d.prepare("UPDATE assets SET blur = 'yes' WHERE id = 'ast-waited'").run();
    d.prepare("INSERT INTO jobs (library_id, version_id, kind, state) VALUES ('lib_m', ?, 'thumb', 'done')").run(v);
    remakePictures("lib_m");
    expect(job(v, "thumb")?.state).toBe("done"); // still waiting for its blur: no picture
    d.prepare("UPDATE asset_versions SET blurred_of = 'sha-ast-waited' WHERE id = ?").run(v); // marked Already blurred
    expect(remakePictures("lib_m")).toBeGreaterThan(0);
    expect(job(v, "thumb")?.state).toBe("queued");
    expect(job(v, "sprite")?.state).toBe("queued");
    expect(remakePictures()).toBe(0); // queued once, never again
  });
});
