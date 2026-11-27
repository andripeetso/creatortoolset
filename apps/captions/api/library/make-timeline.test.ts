import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";

// Make timeline on one clip: POST /:id/assets/:assetId/jobs { kinds: ["timeline"] } queues its look and asks for the watch.
const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-make-timeline-"));
process.env.DATA_DIR = dir;
delete process.env.GEMINI_API_KEY;
const { libraryDb } = await import("./db");
const { searchApp } = await import("./search");
const { askedWatch } = await import("./timeline");
const { saveMyKey } = await import("../my-keys");

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: "local", role: "member" } as never);
  return next();
});
app.route("/api/library", searchApp);

const ask = (assetId: string, kinds: string[]) =>
  Promise.resolve(app.request(`/api/library/lib_mt/assets/${assetId}/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kinds }) }));
const looks = (v: string) => (libraryDb().prepare("SELECT COUNT(*) AS n FROM jobs WHERE version_id = ? AND kind = 'look' AND state = 'queued'").get(v) as { n: number }).n;
const jobsOf = (v: string) => (libraryDb().prepare("SELECT COUNT(*) AS n FROM jobs WHERE version_id = ?").get(v) as { n: number }).n;

function seed(id: string, { roll = "b", duration = 12 } = {}) {
  const d = libraryDb();
  const v = `ver-${id}`;
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at, roll) VALUES (?, 'lib_mt', 'video', ?, ?, 'local', 1, ?)").run(id, `Tiny Acrobatics ${id}`, v, roll);
  d.prepare(
    `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at)
     VALUES (?, ?, 1, ?, 1, ?, ?, 'ready', 'local', 1)`,
  ).run(v, id, `libraries/lib_mt/v/${v}/source`, `sha-${id}`, JSON.stringify({ duration, vcodec: "h264", width: 160, height: 90, fps: 10, rotation: 0 }));
  return v;
}

beforeAll(() => {
  libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_mt', 'local', 'T', 'local', 0)").run();
});
afterEach(() => ["ver-nokey", "ver-aroll", "ver-short", "ver-broll", "ver-blurred"].forEach((v) => askedWatch.delete(v)));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("Make timeline on one clip", () => {
  it("refuses with needs_key when the caller has no Gemini key, and queues nothing", async () => {
    saveMyKey("local", "GEMINI_API_KEY", null);
    const v = seed("nokey");
    const r = await ask("nokey", ["timeline"]);
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ code: "needs_key" });
    expect(jobsOf(v)).toBe(0);
    expect(askedWatch.has(v)).toBe(false);
  });

  it("refuses a clip that gets no shot descriptions (A-roll, too short), and queues nothing", async () => {
    saveMyKey("local", "GEMINI_API_KEY", "gk-test");
    for (const [id, opts] of [["aroll", { roll: "a" }], ["short", { duration: 3 }]] as const) {
      const v = seed(id, opts);
      expect((await ask(id, ["timeline"])).status).toBe(400);
      expect(jobsOf(v)).toBe(0);
      expect(askedWatch.has(v)).toBe(false);
    }
  });

  it("queues one look for a B-roll video and asks for its watch", async () => {
    saveMyKey("local", "GEMINI_API_KEY", "gk-test");
    const v = seed("broll");
    expect((await ask("broll", ["timeline", "look"])).status).toBe(200);
    expect(looks(v)).toBe(1);
    expect(jobsOf(v)).toBe(1);
    expect(askedWatch.has(v)).toBe(true);
  });

  it("a blurred copy: the look and the ask are its original's, where the watch runs", async () => {
    saveMyKey("local", "GEMINI_API_KEY", "gk-test");
    const v = seed("blurred");
    const d = libraryDb();
    d.prepare(
      "INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, blurred_of, state, created_by, created_at) SELECT id || '-b', asset_id, 2, source_key || '-b', 1, 'shab', probe, sha256, 'ready', 'local', 2 FROM asset_versions WHERE id = ?",
    ).run(v);
    d.prepare("UPDATE assets SET current_version_id = ? WHERE id = 'blurred'").run(`${v}-b`);
    expect((await ask("blurred", ["timeline"])).status).toBe(200);
    expect(looks(v)).toBe(1);
    expect(askedWatch.has(v)).toBe(true);
    expect(askedWatch.has(`${v}-b`)).toBe(false);
  });
});
