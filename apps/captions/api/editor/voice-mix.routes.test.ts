import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Edit } from "../../contracts/editor";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "editor-voice-routes-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-voice-routes-test-secret";

const { createUser, setOff } = await import("../users");
const app = (await import("../boot")).default;
const rootReplaced = (await import("../lib/plugin")).pluginReplaces("/api/editor");
const { libraryDb } = await import("../library/db");
const { saveDraft } = await import("./store");
const { emptyTracks } = await import("./timeline");
const { stemKey } = await import("./voice-mix");

const cookies: Record<string, string> = {};
async function login(username: string) {
  setOff(createUser(username, "password1", { role: "user" }), []);
  const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "password1" }) });
  cookies[username] = res.headers.get("set-cookie")!.split(";")[0]!;
}
const call = (user: string, method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { cookie: cookies[user]!, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const soundJobs = (id: string) => (libraryDb().prepare("SELECT version_id FROM edit_jobs WHERE edit_id = ? AND kind = 'sound' AND state = 'queued'").all(id) as { version_id: string }[]).map((r) => r.version_id);

let id = "";
beforeAll(async () => {
  for (const u of ["maker", "other"]) await login(u);
  libraryDb().exec(`
    INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_a', 'maker', 'A', 'local', '{"upload":"all"}', 0);
    INSERT INTO assets (id, library_id, kind, title, created_by, created_at, trashed_at) VALUES ('ast_a1', 'lib_a', 'video', 'Take 1', 'maker', 0, NULL);
    INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES ('ver_a1', 'ast_a1', 1, 'k1', 1, 'x1', 'ready', 'maker', 0);
  `);
  id = ((await (await call("maker", "POST", "/api/editor", { name: "Hook", sources: ["ver_a1"] })).json()) as { id: string }).id;
  libraryDb().prepare("DELETE FROM edit_jobs WHERE edit_id = ?").run(id); // nothing runs here: only what these routes queue
  const tracks = emptyTracks();
  tracks.V1.items = [{ src: "ver_a1", in: 0, rec: 0, len: 60, link: "a" }];
  tracks.A1.items = [{ src: "ver_a1", in: 0, rec: 0, len: 60, link: "a" }];
  await saveDraft(id, "v1", { timeline: { name: "v1", fps: 30, width: 1080, height: 1920, sources: { ver_a1: { versionId: "ver_a1", name: "Take 1", fps: 30, tc: 0, dur: 300, w: 1920, h: 1080 } }, tracks, markers: [] }, notes: [] });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(rootReplaced)("AI Editor: the voice the person picks", () => {
  it("keeps Review's voice controls for the edit, by the recording behind each part, and cuts that version's sound again", async () => {
    const url = `/api/editor/${id}/drafts/v1/voice`;
    expect((await call("maker", "POST", url, { voice: "../x" })).status).toBe(400);
    expect((await call("maker", "POST", url, { mix: { deadbeef: 0.5 } })).status).toBe(400); // no part of this cut
    expect((await call("other", "POST", url, { voice: "nvidia" })).status).toBe(404);
    expect((await call("maker", "POST", `/api/editor/${id}/drafts/v9/voice`, { voice: "nvidia" })).status).toBe(404);
    expect(soundJobs(id)).toEqual([]);
    const r = await call("maker", "POST", url, { voice: "nvidia", mix: { [stemKey("ver_a1")]: 0.42, deadbeef: 1 } });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ voice: { fx: "nvidia", mix: { ver_a1: 0.4 } } });
    expect(soundJobs(id)).toEqual([`${id}:v1`]);
    // a share alone keeps the enhancer
    await call("maker", "POST", url, { mix: { [stemKey("ver_a1")]: 1 } });
    const e = (await (await call("maker", "GET", `/api/editor/${id}`)).json()) as Edit;
    expect(e.voice).toEqual({ fx: "nvidia", mix: { ver_a1: 1 } });
  });

  it("a voice picked on the edit makes every version's sound again; the same voice again makes nothing", async () => {
    libraryDb().prepare("DELETE FROM edit_jobs WHERE edit_id = ?").run(id);
    const patch = (voice: unknown) => call("maker", "PATCH", `/api/editor/${id}`, { voice });
    expect(((await (await patch({ fx: "off" })).json()) as Edit).voice).toEqual({ fx: "off" });
    expect(soundJobs(id)).toEqual([`${id}:v1`]);
    libraryDb().prepare("DELETE FROM edit_jobs WHERE edit_id = ?").run(id);
    await patch({ fx: "off" });
    await patch({ fx: "Not an id" }); // ignored, as any field of the wrong shape is
    expect(soundJobs(id)).toEqual([]);
    expect(((await (await call("maker", "GET", `/api/editor/${id}`)).json()) as Edit).voice).toEqual({ fx: "off" });
  });
});
