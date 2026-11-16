import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WORK_V, type LibraryPackage } from "../../contracts/work";

/**
 * A library job whose account a library policy refuses after it was queued: the claim hands it to no computer, and the
 * routes of a job already held (the server's proxy, the original, the hearing) answer 404. Either way the job fails.
 */

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "work-unseen-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "work-unseen-test-secret";
vi.mock("../plugins.gen", () => ({ serverPlugins: [] }));
// a transcript on the person's key, heard by a stand-in: the job and its route are what this tests
vi.mock("../library/transcribe", async (orig) => ({
  ...(await orig<typeof import("../library/transcribe")>()),
  keySound: () => "wav",
  hearSound: async () => ({ provider: "test", language: null, segments: [], words: [] }),
}));

const { createUser } = await import("../users");
const app = (await import("../boot")).default;
const { pairDevice } = await import("../lib/devices");
const { blobs, libraryDb } = await import("../library/db");
const { enqueueJob } = await import("../library/jobs");
const { LIBRARY_SOURCE, registerLibrarySlot } = await import("../library/sources");
const { UNSEEN } = await import("./library-package");
const { CLAIM_POLL } = await import("./routes");
CLAIM_POLL.holdMs = 0;

afterAll(() => rmSync(dir, { recursive: true, force: true }));

// the studio's kind of gate: a second policy on the built-in library, here switched by the test
let refused = false;
registerLibrarySlot("test-gate", { policies: [{ sourceId: LIBRARY_SOURCE, canSee: () => !refused }] });

const db = () => libraryDb();
const pc = pairDevice("tiny", "Tiny PC");
const call = (p: string, init: RequestInit = {}) =>
  app.request(`/api/devices/relay/work/${p}`, { ...init, headers: { authorization: `Bearer ${pc.token}`, "content-type": "application/json", ...(init.headers as Record<string, string>) } });
const claim = async () => ((await (await call("claim", { method: "POST", body: JSON.stringify({ v: WORK_V, steps: [], library: true }) })).json()) as { lib?: LibraryPackage }).lib;
const stateOf = (id: number) => db().prepare("SELECT state, error FROM jobs WHERE id = ?").get(id) as { state: string; error: string | null };
const queue = (kind: string) => {
  enqueueJob(db(), "lib_t", "ver_t", kind, "tiny", true);
  return (db().prepare("SELECT id FROM jobs WHERE kind = ? ORDER BY id DESC").get(kind) as { id: number }).id;
};

beforeAll(async () => {
  createUser("tiny", "password1");
  db().exec(`INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_t', 'tiny', 'Tiny Acrobatics', 'local', '{"embed":false,"describe":false}', 0);
    INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES ('ast_t', 'lib_t', 'video', 'tiny-flip.mp4', 'ver_t', 'tiny', 0);
    INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES ('ver_t', 'ast_t', 1, 'k_t', 8, 'x', 'ready', 'tiny', 0);
    INSERT INTO derivatives (version_id, kind, storage_key, bytes) VALUES ('ver_t', 'proxy', 'p_t', 5);`);
  for (const [key, text] of [["k_t", "original"], ["p_t", "proxy"]]) {
    const f = path.join(dir, `${key}.bin`);
    writeFileSync(f, text);
    await blobs.put(key, f);
  }
});

describe("a library job whose account may no longer see the clip", () => {
  it("is handed to no computer, and fails with a plain reason", async () => {
    const id = queue("wave");
    refused = true;
    expect(await claim()).toBeUndefined();
    expect(stateOf(id)).toEqual({ state: "failed", error: UNSEEN });
    refused = false;
    expect(await claim()).toBeUndefined(); // it stays failed: access back means queueing it again
  });

  it.each([
    ["wave", "light", "GET"],
    ["proxy", "original", "GET"],
    ["transcribe", "hear", "POST"],
  ])("held already (%s): its %s route answers 404 once the policy refuses, and the job fails", async (kind, route, method) => {
    const id = queue(kind);
    expect((await claim())?.job).toMatchObject({ id, kind });
    const ask = () => call(`lib/${id}/${route}`, method === "POST" ? { method, body: "sound" } : {});
    expect((await ask()).status).toBe(200);
    refused = true;
    expect((await ask()).status).toBe(404);
    refused = false;
    expect(stateOf(id)).toEqual({ state: "failed", error: UNSEEN });
    expect((await ask()).status).toBe(404); // and it is no longer this computer's job
  });
});
