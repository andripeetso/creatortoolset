import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "../auth";

// What's made (made.ts): the counts per kind, Make for the missing, a kind a file has never queued again (jobs.ts HAVE),
// and a switch turned on making for new files only (db.ts SINCE).
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
const { libraryMade, makeMissing, retryFailed } = await import("./made");
const { sweepLook } = await import("./shots");
const { libraryApp } = await import("./routes");

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
const job = (v: string, kind: string) => d.prepare("SELECT state FROM jobs WHERE version_id = ? AND kind = ?").get(v, kind) as { state: string } | undefined;
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
    const fresh = clip("ast-new", { at: Date.now() + 1000 });
    while (await sweepLook(d, Date.now() + 2000)) {
      /* the new file gets its look */
    }
    expect(job(fresh, "look")?.state).toBe("queued");
    // and the old one only when asked
    expect(makeMissing("lib_m", "look", "local")).toBe(2);
    expect(job(bare, "look")?.state).toBe("queued");
  });
});
