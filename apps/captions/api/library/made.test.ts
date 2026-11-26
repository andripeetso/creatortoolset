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
const { engineOf, libraryMade, makeMissing, PICTURE_RETRY_DAYS, retryEmptyPictures, retryFailed, retryFailedPictures, STILLS_FIXED_AT, stopQueued } = await import("./made");
const { queueLook, sweepLook } = await import("./shots");
const { mirrorBlurred } = await import("./blur-mirror");
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

  it("a card picture or strip that failed this week goes again by itself; one from before then stays failed", () => {
    const now = Date.now();
    const weekAgo = now - (PICTURE_RETRY_DAYS + 1) * 86_400_000;
    const recent = clip("ast-pic-recent", { at: now - 3600_000 }), old = clip("ast-pic-old", { at: weekAgo });
    d.prepare("INSERT INTO jobs (library_id, version_id, kind, state, actor, error, started_at) VALUES ('lib_m', ?, 'thumb', 'failed', 'local', 'x', ?)").run(recent, now - 3600_000);
    d.prepare("INSERT INTO jobs (library_id, version_id, kind, state, actor, error, started_at) VALUES ('lib_m', ?, 'sprite', 'failed', 'local', 'x', ?)").run(old, now - (PICTURE_RETRY_DAYS + 1) * 86_400_000);
    expect(retryFailedPictures(now)).toBe(1);
    expect(job(recent, "thumb")?.state).toBe("queued");
    expect(job(old, "sprite")?.state).toBe("failed");
    // a file from last month that was retried (and failed) an hour ago: each try restamps started_at, so the week counts from when it came in
    d.prepare("UPDATE jobs SET state = 'failed', started_at = ? WHERE version_id = ?").run(now - 3600_000, old);
    d.prepare("UPDATE jobs SET state = 'failed' WHERE version_id = ?").run(recent);
    expect(retryFailedPictures(now)).toBe(1);
    expect(job(old, "sprite")?.state).toBe("failed");
    d.prepare("DELETE FROM jobs WHERE version_id IN (?, ?)").run(recent, old);
    d.prepare("DELETE FROM asset_versions WHERE id IN (?, ?)").run(recent, old);
    d.prepare("DELETE FROM assets WHERE id IN ('ast-pic-recent', 'ast-pic-old')").run();
  });

  it("Library status lists each unreadable file with the step that failed, and Retry queues it again", async () => {
    const broken = clip("ast-broken", { kind: "image" });
    d.prepare("UPDATE asset_versions SET state = 'failed' WHERE id = ?").run(broken);
    const empty = "ENOENT: no such file or directory, rename '/x/thumb.jpg.part.jpg' -> '/x/thumb.jpg'";
    d.prepare("INSERT INTO jobs (library_id, version_id, kind, state, actor, error) VALUES ('lib_m', ?, 'send', 'failed', 'local', ?)").run(broken, empty);
    const list = (await (await app.request("/api/library/lib_m/unreadable")).json()) as { items: { id: string; step: string; error: string }[] };
    expect(list.items).toEqual([{ id: "ast-broken", title: "ast-broken", step: "send", error: empty }]);
    expect(await (await app.request("/api/library/lib_m/unreadable/retry", { method: "POST" })).json()).toEqual({ files: 1 });
    expect(job(broken, "send")?.state).toBe("queued");
    d.prepare("UPDATE jobs SET state = 'done' WHERE version_id = ?").run(broken);
    d.prepare("UPDATE asset_versions SET state = 'ready' WHERE id = ?").run(broken);
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

  it("a blurred copy's shot descriptions are its original's: queued there once, and never again by the sweep", async () => {
    const orig = clip("ast-blur", { at: Date.now() + 3000 });
    d.prepare("UPDATE asset_versions SET full_sha256 = 'sha-filmed' WHERE id = ?").run(orig);
    // Face Blur's render of it, now the clip's current version
    d.prepare(
      `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, blurred_of, probe, state, created_by, created_at)
       SELECT 'ver-ast-blur-2', asset_id, 2, 'libraries/lib_m/v/ver-ast-blur-2/source', bytes, 'sha-blurred', 'sha-filmed', probe, 'ready', created_by, created_at FROM asset_versions WHERE id = ?`,
    ).run(orig);
    d.prepare("UPDATE assets SET current_version_id = 'ver-ast-blur-2' WHERE id = 'ast-blur'").run();
    d.prepare("UPDATE jobs SET state = 'done' WHERE state = 'queued'").run();
    const sweep = async (at: number) => {
      while (await sweepLook(d, at)) {
        /* each pass queues what it may */
      }
    };
    await sweep(Date.now() + 4000);
    expect(job("ver-ast-blur-2", "look")).toBeUndefined();
    expect(job(orig, "look")?.state).toBe("queued");
    // it fails for good there: an hour on, the sweep leaves it (a failed look waits for Retry, as any other)
    d.prepare("UPDATE jobs SET state = 'failed' WHERE version_id = ? AND kind = 'look'").run(orig);
    await sweep(Date.now() + 3_600_000);
    expect(job(orig, "look")?.state).toBe("failed");
    // made there at last: the copy takes it and reads done, and no sweep makes it again
    d.prepare("UPDATE jobs SET state = 'done' WHERE version_id = ? AND kind = 'look'").run(orig);
    d.prepare("INSERT INTO stretches (version_id, seg, a, b, motion, text, source, created_at) VALUES (?, 0, 0, 2, 0.1, 'Spins', 'ai', 1)").run(orig);
    mirrorBlurred(d);
    expect(job("ver-ast-blur-2", "look")?.state).toBe("done");
    await sweep(Date.now() + 7_200_000);
    expect(job(orig, "look")?.state).toBe("done");
    d.prepare("UPDATE assets SET trashed_at = 1 WHERE id = 'ast-blur'").run(); // out of the counts the next tests read
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
    const printed = clip("ast-print");
    enqueueJob(d, "lib_m", printed, "fingerprint", "local");
    expect(stopQueued("lib_m", "fingerprint", "local")).toBe(0); // made as the file comes in: Stop leaves it
    expect(job(printed, "fingerprint")?.state).toBe("queued");
    d.prepare("DELETE FROM jobs WHERE version_id = ?").run(printed);
    d.prepare("DELETE FROM asset_versions WHERE id = ?").run(printed);
    d.prepare("DELETE FROM assets WHERE id = 'ast-print'").run();
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
