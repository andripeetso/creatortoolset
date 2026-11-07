import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Edit, EditSummary } from "../../contracts/editor";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "editor-routes-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-routes-test-secret";
writeFileSync(
  path.join(dir, "workspaces.json"),
  JSON.stringify({
    workspaces: [
      { id: "ws_a", name: "Tiny Acrobatics", plan: "team", comped: false, createdAt: 0, members: [
        { username: "owner-a", role: "owner", ai: "own", budgetUsd: 0, joinedAt: 0 },
        { username: "mem-a", role: "member", ai: "own", budgetUsd: 0, joinedAt: 0 },
        { username: "mem-b", role: "member", ai: "own", budgetUsd: 0, joinedAt: 0 },
      ] },
      { id: "ws_b", name: "b", plan: "team", comped: false, createdAt: 0, members: [
        { username: "owner-b", role: "owner", ai: "own", budgetUsd: 0, joinedAt: 0 },
      ] },
    ],
    invites: [],
    spend: {},
  }),
);

const { createUser, findUser, setOff } = await import("../users");
const app = (await import("../boot")).default;
const { libraryDb } = await import("../library/db");
const { enqueueJob } = await import("../library/jobs");
const { NeedsKey } = await import("../library/transcribe");
const { STEPS, tick } = await import("./worker");

const cookies: Record<string, string> = {};
async function login(username: string) {
  createUser(username, "password1", { role: "user" });
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "password1" }),
  });
  cookies[username] = res.headers.get("set-cookie")!.split(";")[0]!;
}
const call = (user: string, method: string, url: string, body?: unknown) =>
  app.request(url, {
    method,
    headers: { cookie: cookies[user]!, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = async <T = any>(r: Response | Promise<Response>): Promise<T> => (await r).json() as Promise<T>;
const create = (user: string, sources: string[], extra: object = {}) => call(user, "POST", "/api/editor", { name: "Hook test", sources, ...extra });
const jobState = (id: number) => libraryDb().prepare("SELECT state, error FROM edit_jobs WHERE id = ?").get(id) as { state: string; error: string | null };
/** Runs queued steps until the queue is empty. */
const drain = async () => {
  while (await tick(10 ** 13));
};

beforeAll(async () => {
  for (const u of ["owner-a", "mem-a", "mem-b", "owner-b"]) await login(u);
  libraryDb().exec(`
    INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'ws_a', 'A', 'local', 0), ('lib_b', 'ws_b', 'B', 'local', 0);
    INSERT INTO assets (id, library_id, kind, title, created_by, created_at, trashed_at) VALUES
      ('ast_a1', 'lib_a', 'video', 'Take 1', 'mem-a', 0, NULL), ('ast_a2', 'lib_a', 'video', 'Take 2', 'mem-a', 0, NULL),
      ('ast_t', 'lib_a', 'video', 'Old', 'mem-a', 0, 1), ('ast_b', 'lib_b', 'video', 'Theirs', 'owner-b', 0, NULL);
    INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES
      ('ver_a1', 'ast_a1', 1, 'k1', 1, 'x1', 'ready', 'mem-a', 0), ('ver_a2', 'ast_a2', 1, 'k2', 1, 'x2', 'ready', 'mem-a', 0),
      ('ver_t', 'ast_t', 1, 'k3', 1, 'x3', 'ready', 'mem-a', 0), ('ver_b', 'ast_b', 1, 'k4', 1, 'x4', 'ready', 'owner-b', 0);
    INSERT INTO collections (id, library_id, name, kind, created_at) VALUES ('col_b', 'lib_b', 'B-roll', 'manual', 0);
  `);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("AI Editor: edits and who sees them", () => {
  it("refuses footage the creator can't read, from another workspace, or across two: 404 like a missing one", async () => {
    expect((await create("mem-a", ["ver_t"])).status).toBe(404); // in the trash
    expect((await create("mem-a", ["ver_b"])).status).toBe(404); // another workspace's library
    expect((await create("mem-a", ["ver_a1", "ver_b"])).status).toBe(404);
    expect((await create("mem-a", ["ver_nope"])).status).toBe(404);
    expect((await create("mem-a", ["ver_a1"], { brollCollectionId: "col_b" })).status).toBe(404);
    expect((await create("mem-a", [])).status).toBe(404);
  });

  it("makes an edit with clamped settings, and lists mine; the workspace owner sees every member's", async () => {
    const { id } = await json<{ id: string }>(create("mem-a", ["ver_a1", "ver_a2"], { versions: 9, targetS: -5 }));
    await create("mem-b", ["ver_a2"]);
    const e = await json<Edit>(call("mem-a", "GET", `/api/editor/${id}`));
    expect(e).toMatchObject({ name: "Hook test", sources: ["ver_a1", "ver_a2"], versions: 5, targetS: 0, workspaceId: "ws_a", mine: true, jobs: [] });

    const names = async (user: string) => (await json<EditSummary[]>(call(user, "GET", "/api/editor"))).map((s) => s.createdBy).sort();
    expect(await names("mem-a")).toEqual(["mem-a"]);
    expect(await names("mem-b")).toEqual(["mem-b"]);
    expect(await names("owner-a")).toEqual(["mem-a", "mem-b"]);
    expect(await names("owner-b")).toEqual([]);
    expect((await call("mem-b", "GET", `/api/editor/${id}`)).status).toBe(404);
    expect((await call("owner-b", "GET", `/api/editor/${id}`)).status).toBe(404);
  });

  it("the owner sees and stops a member's edit but never runs or changes it (it runs on the member's AI)", async () => {
    const { id } = await json<{ id: string }>(create("mem-a", ["ver_a1"]));
    expect((await json<Edit>(call("owner-a", "GET", `/api/editor/${id}`))).mine).toBe(false);
    expect((await call("owner-a", "POST", `/api/editor/${id}/run`, {})).status).toBe(403);
    expect((await call("owner-a", "PATCH", `/api/editor/${id}`, { name: "x" })).status).toBe(403);
    const ran = await json<Edit>(call("mem-a", "POST", `/api/editor/${id}/run`, {}));
    expect(ran.jobs).toMatchObject([{ kind: "analyze", variant: "", state: "queued" }]);
    const stopped = await json<Edit>(call("owner-a", "POST", `/api/editor/${id}/stop`));
    expect(stopped.jobs).toMatchObject([{ state: "failed", error: "Stopped" }]);
    expect((await call("mem-a", "DELETE", `/api/editor/${id}`)).status).toBe(200);
    expect((await call("mem-a", "GET", `/api/editor/${id}`)).status).toBe(404);
  });

  it("is 403 for an account with the AI Editor switched off", async () => {
    setOff(findUser("mem-b")!, ["editor"]);
    const res = await call("mem-b", "GET", "/api/editor");
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ code: "TOOL_ACCESS" });
    setOff(findUser("mem-b")!, []);
  });
});

describe("AI Editor: the worker", () => {
  it("parks a step that names no account, and fails a step that isn't built yet", async () => {
    const { id } = await json<{ id: string }>(create("mem-a", ["ver_a1"]));
    enqueueJob(libraryDb(), "ws_a", `${id}:`, "draft", null, false, "edit_jobs");
    await drain();
    const [job] = (await json<Edit>(call("mem-a", "GET", `/api/editor/${id}`))).jobs;
    expect(job).toMatchObject({ state: "needs_key", error: expect.stringMatching(/names no account/) });

    await call("mem-a", "POST", `/api/editor/${id}/run`, { from: "draft" }); // as the creator now
    await drain();
    expect(jobState(job!.id)).toEqual({ state: "failed", error: "No draft step yet" });
  });

  it("runs a step as the creator, queues the next one, parks on a missing key, and Retry queues it again", async () => {
    const seen: string[] = [];
    const real = { ...STEPS };
    STEPS.analyze = async ({ job }) => void seen.push(`analyze:${job.actor}`);
    STEPS.script = async () => {
      throw new NeedsKey("Add your Anthropic key in Settings → My API keys");
    };
    try {
      const { id } = await json<{ id: string }>(create("mem-a", ["ver_a1"]));
      await call("mem-a", "POST", `/api/editor/${id}/run`, { from: "analyze" });
      await drain();
      const jobs = (await json<Edit>(call("mem-a", "GET", `/api/editor/${id}`))).jobs;
      expect(seen).toEqual(["analyze:mem-a"]);
      expect(jobs.map((j) => [j.kind, j.state])).toEqual([["analyze", "done"], ["script", "needs_key"]]);
      expect(jobs[1]!.error).toMatch(/Anthropic key/);

      const retried = await json<Edit>(call("mem-a", "POST", `/api/editor/${id}/jobs/${jobs[1]!.id}/retry`));
      expect(retried.jobs[1]!.state).toBe("queued");
    } finally {
      Object.assign(STEPS, real);
      await drain();
    }
  });

  it("checks the footage again at every step: a source trashed since fails the step", async () => {
    const real = STEPS.analyze;
    STEPS.analyze = async () => {};
    try {
      const { id } = await json<{ id: string }>(create("mem-a", ["ver_a2"]));
      libraryDb().prepare("UPDATE assets SET trashed_at = 1 WHERE id = 'ast_a2'").run();
      await call("mem-a", "POST", `/api/editor/${id}/run`, {});
      await drain();
      expect((await json<Edit>(call("mem-a", "GET", `/api/editor/${id}`))).jobs[0]).toMatchObject({ state: "failed", error: expect.stringMatching(/no longer yours/) });
    } finally {
      STEPS.analyze = real!;
      libraryDb().prepare("UPDATE assets SET trashed_at = NULL WHERE id = 'ast_a2'").run();
    }
  });
});
