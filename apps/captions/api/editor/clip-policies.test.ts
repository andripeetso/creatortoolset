import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Edit } from "../../contracts/editor";
import type { JobRow } from "../library/jobs";

// A teammate's edits ask the library's own policies (store.ts seesClip): a plug-in policy that refuses a viewer a clip
// (one that shows members only blurred footage, say) keeps that clip out of every edit they make, run or watch. ana
// owns the team; bo and fay are given FIRST with Read & write. The stand-in policy shows the raw take to fay only.
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "editor-clip-policies-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-clip-policies-test-secret";
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const FIRST = "cccccccc-0000-4000-8000-000000000011";
mkdirSync(path.join(dir, "workshop", "projects"), { recursive: true });
writeFileSync(path.join(dir, "workshop", "projects", `${FIRST}.json`), JSON.stringify({ id: FIRST, owner: "ana", name: "Tiny Acrobatics", createdAt: 1, updatedAt: 1 }));
const member = (username: string, workspaces?: string[]) => ({ username, role: "member", ai: "own", budgetUsd: 0, joinedAt: 0, ...(workspaces ? { workspaces } : {}) });
writeFileSync(
  path.join(dir, "workspaces.json"),
  JSON.stringify({
    workspaces: [{ id: "t", name: "Team", plan: "team", comped: false, createdAt: 0, members: [{ ...member("ana"), role: "owner" }, member("bo", [FIRST]), member("fay", [FIRST])] }],
    invites: [],
    spend: {},
  }),
);

const { createUser, setOff } = await import("../users");
const app = (await import("../boot")).default;
const rootReplaced = (await import("../lib/plugin")).pluginReplaces("/api/editor");
const { libraryDb } = await import("../library/db");
const { registerLibrarySlot, resetLibrarySlots } = await import("../library/sources");
const { STEPS, tick } = await import("./worker");
const { editDir, readEdit } = await import("./store");

const cookies: Record<string, string> = {};
async function login(username: string) {
  setOff(createUser(username, "password1", { role: "user" }), []);
  const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "password1" }) });
  cookies[username] = res.headers.get("set-cookie")!.split(";")[0]!;
}
const call = (user: string, method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { cookie: cookies[user]!, "content-type": "application/json", "x-ct-workspace": FIRST }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const json = async <T = any>(r: Response | Promise<Response>): Promise<T> => (await r).json() as Promise<T>;
const make = (user: string, sources: string[]) => call(user, "POST", "/api/editor", { name: `${user}'s cut`, sources, projectId: FIRST });
const drain = async () => {
  while (await tick(10 ** 13));
};
const lastJob = (edit: string, actor: string) => libraryDb().prepare("SELECT state, error FROM edit_jobs WHERE edit_id = ? AND actor = ? AND kind = 'analyze' ORDER BY id DESC LIMIT 1").get(edit, actor) as { state: string; error: string | null };

let anasRaw = "";
let fays = "";

beforeAll(async () => {
  for (const u of ["ana", "bo", "fay"]) await login(u);
  libraryDb().exec(`
    INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_one', 't', 'One', 'local', '{"projectId":"${FIRST}"}', 0);
    INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('ast_ok', 'lib_one', 'video', 'Blurred take', 'ana', 0), ('ast_raw', 'lib_one', 'video', 'Raw take', 'ana', 0);
    INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES
      ('ver_ok', 'ast_ok', 1, 'k1', 1, 'x1', 'ready', 'ana', 0), ('ver_raw', 'ast_raw', 1, 'k2', 1, 'x2', 'ready', 'ana', 0);
  `);
  // refuses everyone but fay the raw take, the owner too: the owner's own edits never ask it
  registerLibrarySlot("test-blur", { policies: [{ sourceId: "library", canSee: (v, a) => a.assetId !== "ast_raw" || v.username === "fay" }] });
  anasRaw = (await json<{ id: string }>(make("ana", ["ver_raw"]))).id;
  fays = (await json<{ id: string }>(make("fay", ["ver_ok"]))).id;
});
afterAll(() => resetLibrarySlots());

describe.skipIf(rootReplaced)("AI Editor: a teammate's edits ask the library's policies", () => {
  it("a refused teammate can't make an edit from the clip or add it as the song; an allowed one can; the owner is never stopped", async () => {
    expect(anasRaw).toBeTruthy();
    expect((await make("bo", ["ver_raw"])).status).toBe(404);
    expect((await make("bo", ["ver_ok", "ver_raw"])).status).toBe(404);
    expect((await make("fay", ["ver_raw"])).status).toBe(200);
    const bos = (await json<{ id: string }>(make("bo", ["ver_ok"]))).id;
    expect((await call("bo", "PATCH", `/api/editor/${bos}`, { song: "ver_raw" })).status).toBe(200);
    expect(readEdit(bos)!.song).toBeUndefined();
    expect((await call("fay", "PATCH", `/api/editor/${fays}`, { song: "ver_raw" })).status).toBe(200);
    expect(readEdit(fays)!.song).toBe("ver_raw");
    await call("fay", "PATCH", `/api/editor/${fays}`, { song: null });
  });

  it("a refused teammate can't run or change the owner's edit made from it; an allowed one can", async () => {
    const real = STEPS.analyze;
    STEPS.analyze = async () => {};
    try {
      for (const [method, url, body] of [["POST", "run", {}], ["POST", "feedback", { text: "Shorter" }], ["PATCH", "", { brief: "Faster start" }]] as const) {
        expect((await call("bo", method, `/api/editor/${anasRaw}${url ? `/${url}` : ""}`, body)).status).toBe(404);
      }
      // one at a time: a run queued while another waits joins it
      expect((await call("fay", "POST", `/api/editor/${anasRaw}/run`, {})).status).toBe(200);
      await drain();
      expect(lastJob(anasRaw, "fay").state).toBe("done");
      expect((await call("ana", "POST", `/api/editor/${anasRaw}/run`, {})).status).toBe(200);
      await drain();
      expect(lastJob(anasRaw, "ana").state).toBe("done");
    } finally {
      STEPS.analyze = real!;
    }
  });

  it("a draft's B-roll counts: a teammate refused a cutaway in it is refused the edit", async () => {
    mkdirSync(path.join(editDir(fays), "drafts"), { recursive: true });
    writeFileSync(path.join(editDir(fays), "drafts", "v1.json"), JSON.stringify({ timeline: { sources: { ver_ok: {}, ver_raw: {} } }, notes: [] }));
    try {
      expect((await call("bo", "POST", `/api/editor/${fays}/run`, {})).status).toBe(404);
      expect((await call("fay", "POST", `/api/editor/${fays}/run`, {})).status).toBe(200);
    } finally {
      rmSync(path.join(editDir(fays), "drafts"), { recursive: true, force: true });
      libraryDb().prepare("DELETE FROM edit_jobs WHERE edit_id = ?").run(fays);
    }
  });

  it("a refused teammate's queued step fails once the edit uses the clip; an allowed one's runs", async () => {
    const real = STEPS.analyze;
    STEPS.analyze = async () => {};
    try {
      expect((await call("bo", "POST", `/api/editor/${fays}/run`, {})).status).toBe(200);
      // the owner puts the raw take in as the song before the step runs
      expect((await call("ana", "PATCH", `/api/editor/${fays}`, { song: "ver_raw" })).status).toBe(200);
      await drain();
      expect(lastJob(fays, "bo")).toMatchObject({ state: "failed", error: expect.stringMatching(/no longer yours/) });
      expect((await call("fay", "POST", `/api/editor/${fays}/run`, {})).status).toBe(200);
      await drain();
      expect(lastJob(fays, "fay").state).toBe("done");
      expect((await json<Edit>(call("ana", "GET", `/api/editor/${fays}`))).id).toBe(fays);
    } finally {
      STEPS.analyze = real!;
    }
  });

  it("a teammate's step on their computer stops mid-step when the edit takes in a clip refused to them: its AI calls and reads too", async () => {
    const { serveAi, serveCall, Refused } = await import("../work/serve");
    const step = { version_id: `${fays}:`, actor: "bo" } as JobRow;
    await call("ana", "PATCH", `/api/editor/${fays}`, { song: null }); // the step before left the raw take in
    expect(await serveCall(step, "grade", [])).toHaveProperty("cdl");
    // the owner puts the raw take in as the song while bo's computer runs the step
    expect((await call("ana", "PATCH", `/api/editor/${fays}`, { song: "ver_raw" })).status).toBe(200);
    try {
      await expect(serveCall(step, "grade", [])).rejects.toBeInstanceOf(Refused);
      expect(await serveAi(step, { system: "s", user: "u" })).toEqual({ error: { name: "Error", message: "Not this account's edit" } });
      expect(await serveCall({ ...step, actor: "fay" }, "grade", [])).toHaveProperty("cdl");
    } finally {
      await call("ana", "PATCH", `/api/editor/${fays}`, { song: null });
    }
  });

  it("a refused teammate can't play the preview of the owner's edit made from it; the owner and an allowed teammate can", async () => {
    const asset = "cccccccc-0000-4000-8000-0000000000bb";
    mkdirSync(path.join(dir, "review", asset), { recursive: true });
    const version = { n: 1, name: "ana's cut v1.mp4", mime: "video/mp4", bytes: 1, duration: 1, fps: 30, width: 1, height: 1, status: "processing", progress: 0, createdAt: 0, draft: { edit: anasRaw, name: "v1", by: "ana" } };
    writeFileSync(path.join(dir, "review", asset, "meta.json"), JSON.stringify({ id: asset, name: "ana's cut v1.mp4", owner: "ana", versions: [version], approval: { status: "needs_review" }, createdAt: 0, updatedAt: 0 }));
    const play = (u: string) => call(u, "GET", `/api/review/assets/${asset}/v/1/play`);
    // seen (not ready yet: 409) by the owner and fay; bo gets the 404 of a preview not shared
    for (const u of ["ana", "fay"]) expect((await play(u)).status).toBe(409);
    expect((await play("bo")).status).toBe(404);
  });
});
