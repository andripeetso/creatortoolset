import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Edit, EditSummary } from "../../contracts/editor";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "editor-routes-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-routes-test-secret";

const { createUser, findUser, setOff } = await import("../users");
const app = (await import("../boot")).default;
// A loaded plug-in that replaces /api/editor answers the root itself, so these tests (which drive the built-in root) run only without one.
const rootReplaced = (await import("../lib/plugin")).pluginReplaces("/api/editor");
const { libraryDb } = await import("../library/db");
const { enqueueJob } = await import("../library/jobs");
const { NeedsKey } = await import("../library/transcribe");
const { STEPS, tick } = await import("./worker");
const { readStep, saveDraft, saveStep } = await import("./store");

const cookies: Record<string, string> = {};
async function login(username: string) {
  setOff(createUser(username, "password1", { role: "user" }), []);
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
  for (const u of ["maker", "other"]) await login(u);
  libraryDb().exec(`
    INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'maker', 'A', 'local', 0), ('lib_b', 'other', 'B', 'local', 0);
    INSERT INTO assets (id, library_id, kind, title, created_by, created_at, trashed_at) VALUES
      ('ast_a1', 'lib_a', 'video', 'Take 1', 'maker', 0, NULL), ('ast_a2', 'lib_a', 'video', 'Take 2', 'maker', 0, NULL),
      ('ast_t', 'lib_a', 'video', 'Old', 'maker', 0, 1), ('ast_b', 'lib_b', 'video', 'Theirs', 'other', 0, NULL);
    INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES
      ('ver_a1', 'ast_a1', 1, 'k1', 1, 'x1', 'ready', 'maker', 0), ('ver_a2', 'ast_a2', 1, 'k2', 1, 'x2', 'ready', 'maker', 0),
      ('ver_t', 'ast_t', 1, 'k3', 1, 'x3', 'ready', 'maker', 0), ('ver_b', 'ast_b', 1, 'k4', 1, 'x4', 'ready', 'other', 0);
    INSERT INTO collections (id, library_id, name, kind, created_at) VALUES ('col_b', 'lib_b', 'B-roll', 'manual', 0);
  `);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(rootReplaced)("AI Editor: edits and who sees them", () => {
  it("refuses footage the creator can't read, from another account, or across two: 404 like a missing one", async () => {
    expect((await create("maker", ["ver_t"])).status).toBe(404); // in the trash
    expect((await create("maker", ["ver_b"])).status).toBe(404); // another account's library
    expect((await create("maker", ["ver_a1", "ver_b"])).status).toBe(404);
    expect((await create("maker", ["ver_nope"])).status).toBe(404);
    expect((await create("maker", ["ver_a1"], { brollCollectionId: "col_b" })).status).toBe(404);
    expect((await create("maker", [])).status).toBe(404);
  });

  it("makes an edit with clamped settings and lists it for its creator only", async () => {
    const { id } = await json<{ id: string }>(create("maker", ["ver_a1", "ver_a2"], { versions: 9, targetS: -5 }));
    const e = await json<Edit>(call("maker", "GET", `/api/editor/${id}`));
    expect(e).toMatchObject({ name: "Hook test", sources: ["ver_a1", "ver_a2"], versions: 5, targetS: 0, workspaceId: "maker", jobs: [] });

    const names = async (user: string) => (await json<EditSummary[]>(call(user, "GET", "/api/editor"))).map((s) => s.createdBy).sort();
    expect(await names("maker")).toEqual(["maker"]);
    expect(await names("other")).toEqual([]);
    expect((await call("other", "GET", `/api/editor/${id}`)).status).toBe(404);
  });

  it("an edit carries the language spoken in it: set, changed, cleared back to the person's; a word that is no code is ignored", async () => {
    const { id } = await json<{ id: string }>(create("maker", ["ver_a1"], { languages: ["et", "et"] }));
    const get = async () => (await json<Edit>(call("maker", "GET", `/api/editor/${id}`))).languages;
    expect(await get()).toEqual(["et"]);
    await call("maker", "PATCH", `/api/editor/${id}`, { languages: ["Estonian"] });
    expect(await get()).toEqual(["et"]);
    await call("maker", "PATCH", `/api/editor/${id}`, { languages: ["fi"] });
    expect(await get()).toEqual(["fi"]);
    await call("maker", "PATCH", `/api/editor/${id}`, { languages: null });
    expect(await get()).toEqual([]);
  });

  it("the creator runs, stops and deletes an edit; nobody else reaches it", async () => {
    const { id } = await json<{ id: string }>(create("maker", ["ver_a1"]));
    expect((await call("other", "POST", `/api/editor/${id}/run`, {})).status).toBe(404);
    expect((await call("other", "PATCH", `/api/editor/${id}`, { name: "x" })).status).toBe(404);
    const ran = await json<Edit>(call("maker", "POST", `/api/editor/${id}/run`, {}));
    expect(ran.jobs).toMatchObject([{ kind: "analyze", variant: "", state: "queued" }]);
    expect((await call("other", "POST", `/api/editor/${id}/stop`)).status).toBe(404);
    const stopped = await json<Edit>(call("maker", "POST", `/api/editor/${id}/stop`));
    expect(stopped.jobs).toMatchObject([{ state: "failed", error: "Stopped" }]);
    // the list says it was stopped, so Home does not call it a failure
    expect((await json<EditSummary[]>(call("maker", "GET", "/api/editor"))).find((s) => s.id === id)?.last).toEqual({ kind: "analyze", state: "failed", stopped: true });
    expect((await call("maker", "DELETE", `/api/editor/${id}`)).status).toBe(200);
    expect((await call("maker", "GET", `/api/editor/${id}`)).status).toBe(404);
  });

  it("the creator sets a source's eye line; nobody else can, a source not in the edit is 404, a y off the picture 400", async () => {
    const { id } = await json<{ id: string }>(create("maker", ["ver_a1"]));
    expect((await json<Edit>(call("maker", "GET", `/api/editor/${id}`))).eyeline).toEqual({});
    expect((await json<Edit>(call("maker", "PUT", `/api/editor/${id}/eyeline/ver_a1`, { y: 0.3 }))).eyeline).toEqual({ ver_a1: 0.3 });
    expect((await call("other", "PUT", `/api/editor/${id}/eyeline/ver_a1`, { y: 0.4 })).status).toBe(404);
    expect((await call("maker", "PUT", `/api/editor/${id}/eyeline/ver_a2`, { y: 0.4 })).status).toBe(404);
    expect((await call("maker", "PUT", `/api/editor/${id}/eyeline/ver_a1`, { y: 1.5 })).status).toBe(400);
    expect((await call("maker", "GET", `/api/editor/${id}/drafts/v1`)).status).toBe(404);
  });

  it("PUT lines changes a version's takes and order and redrafts only it, with no AI; a take the line lacks is 400", async () => {
    const { id } = await json<{ id: string }>(create("maker", ["ver_a1"]));
    const t = (first: number, score: number) => ({ first, last: first, score });
    const lines = [
      { id: "L1", text: "we roll", takes: [t(1, 1), t(3, 0.8)] },
      { id: "L2", text: "join us", takes: [t(2, 1), t(4, 0.7)] },
    ];
    const plans = [
      { name: "v1", title: "A", lines: [{ line: "L1", take: t(1, 1) }, { line: "L2", take: t(2, 1) }] },
      { name: "v2", title: "B", lines: [{ line: "L1", take: t(3, 0.8) }, { line: "L2", take: t(4, 0.7) }] },
    ];
    await saveStep(id, "plan", { lines, plans, notes: [] });
    await saveStep(id, "analysis", { sentences: [{ n: 1, src: "ver_a1", text: "we roll", s: 0.5, e: 1, w0: 0, w1: 1 }], notes: [] });
    expect(await json(call("maker", "GET", `/api/editor/${id}/sentences`))).toMatchObject([{ n: 1, s: 0.5 }]);

    const body = { plans: [{ name: "v2", lines: [{ line: "L2", take: { first: 2, last: 2 } }, { line: "L1", take: { first: 3, last: 3 } }] }] };
    expect((await call("other", "PUT", `/api/editor/${id}/lines`, body)).status).toBe(404);
    expect((await call("maker", "PUT", `/api/editor/${id}/lines`, { plans: [{ name: "v2", lines: [{ line: "L1", take: { first: 2, last: 2 } }] }] })).status).toBe(400);
    expect((await call("maker", "PUT", `/api/editor/${id}/lines`, { plans: [{ name: "v9", lines: body.plans[0]!.lines }] })).status).toBe(400);
    const e = await json<Edit>(call("maker", "PUT", `/api/editor/${id}/lines`, body));
    expect(e.plans[0]).toEqual(plans[0]);
    expect(e.plans[1]!.lines).toEqual([{ line: "L2", take: t(2, 1) }, { line: "L1", take: t(3, 0.8) }]);
    expect(e.jobs.map((j) => [j.kind, j.variant, j.state])).toEqual([["draft", "v2", "queued"]]);
    expect(readStep(id, "plan")!.plans[1]!.title).toBe("B");
  });

  it("POST drafts/:name/review queues the version's preview for the creator only; no draft is 404", async () => {
    const { id } = await json<{ id: string }>(create("maker", ["ver_a1"]));
    expect((await call("maker", "POST", `/api/editor/${id}/drafts/v1/review`)).status).toBe(404);
    await saveDraft(id, "v1", { timeline: {} as never, notes: [] });
    expect((await call("other", "POST", `/api/editor/${id}/drafts/v1/review`)).status).toBe(404);
    const e = await json<Edit>(call("maker", "POST", `/api/editor/${id}/drafts/v1/review`));
    expect(e.jobs.map((j) => [j.kind, j.variant, j.state])).toEqual([["preview", "v1", "queued"]]);
    expect(e.previews).toEqual({});
    await call("maker", "POST", `/api/editor/${id}/stop`);
  });

  it("export refuses a version whose newest post step did not finish, and takes it again once post is done", async () => {
    const { id } = await json<{ id: string }>(create("maker", ["ver_a2"]));
    await saveDraft(id, "v1", { timeline: { sources: { ver_a2: {} }, tracks: {}, markers: [], fps: 25, width: 1080, height: 1920, name: "v1" } as never, notes: [] });
    enqueueJob(libraryDb(), "ws", `${id}:v1`, "post", "maker", true, "edit_jobs");
    libraryDb().prepare("UPDATE edit_jobs SET state = 'failed' WHERE edit_id = ? AND kind = 'post'").run(id);
    const refused = await call("maker", "GET", `/api/editor/${id}/drafts/v1/export?format=otio`);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe("Post-processing did not finish on this version: run it again before you export");
    // nor is a preview made from the older copies (it would be filed in Review as this cut)
    const { previewStep } = await import("./preview");
    const { readEdit } = await import("./store");
    await expect(previewStep({ edit: readEdit(id)!, variant: "v1", signal: new AbortController().signal } as never)).rejects.toThrow("Post-processing did not finish");
    libraryDb().prepare("UPDATE edit_jobs SET state = 'done' WHERE edit_id = ? AND kind = 'post'").run(id);
    // past the hold (this fixture's source has no file, so the export itself goes no further)
    expect((await call("maker", "GET", `/api/editor/${id}/drafts/v1/export?format=otio`)).status).not.toBe(409);
  });

  it("export reads the footage again: a source trashed since is 404, no links or download URLs made", async () => {
    const { id } = await json<{ id: string }>(create("maker", ["ver_a2"]));
    await saveDraft(id, "v1", { timeline: { sources: { ver_a2: {} } } as never, notes: [] });
    libraryDb().prepare("UPDATE assets SET trashed_at = 1 WHERE id = 'ast_a2'").run();
    try {
      expect((await call("maker", "GET", `/api/editor/${id}/drafts/v1/export?format=otio`)).status).toBe(404);
      expect((await call("other", "GET", `/api/editor/${id}/drafts/v1/export`)).status).toBe(404);
    } finally {
      libraryDb().prepare("UPDATE assets SET trashed_at = NULL WHERE id = 'ast_a2'").run();
    }
  });

  it("is 403 for an account with the AI Editor switched off", async () => {
    findUser("other")!.off = ["editor"];
    const res = await call("other", "GET", "/api/editor");
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ code: "TOOL_ACCESS" });
    findUser("other")!.off = [];
  });
});

describe.skipIf(rootReplaced)("AI Editor: the worker", () => {
  it("parks a step that names no account, and a whole-edit B-roll step (no draft) does nothing and is done", async () => {
    const { id } = await json<{ id: string }>(create("maker", ["ver_a1"]));
    enqueueJob(libraryDb(), "maker", `${id}:`, "broll", null, false, "edit_jobs");
    await drain();
    const [job] = (await json<Edit>(call("maker", "GET", `/api/editor/${id}`))).jobs;
    expect(job).toMatchObject({ state: "needs_key", error: expect.stringMatching(/names no account/) });

    await call("maker", "POST", `/api/editor/${id}/run`, { from: "broll" }); // as the creator now
    await drain();
    expect(jobState(job!.id)).toEqual({ state: "done", error: null });
  });

  it("runs a step as the creator, queues the next one, parks on a missing key, and Retry queues it again", async () => {
    const seen: string[] = [];
    const real = { ...STEPS };
    STEPS.analyze = async ({ job }) => void seen.push(`analyze:${job.actor}`);
    STEPS.script = async () => {
      throw new NeedsKey("Add your Anthropic key in Settings → API keys");
    };
    try {
      const { id } = await json<{ id: string }>(create("maker", ["ver_a1"]));
      await call("maker", "POST", `/api/editor/${id}/run`, { from: "analyze" });
      await drain();
      const jobs = (await json<Edit>(call("maker", "GET", `/api/editor/${id}`))).jobs;
      expect(seen).toEqual(["analyze:maker"]);
      expect(jobs.map((j) => [j.kind, j.state])).toEqual([["analyze", "done"], ["script", "needs_key"]]);
      expect(jobs[1]!.error).toMatch(/Anthropic key/);

      const retried = await json<Edit>(call("maker", "POST", `/api/editor/${id}/jobs/${jobs[1]!.id}/retry`));
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
      const { id } = await json<{ id: string }>(create("maker", ["ver_a2"]));
      libraryDb().prepare("UPDATE assets SET trashed_at = 1 WHERE id = 'ast_a2'").run();
      await call("maker", "POST", `/api/editor/${id}/run`, {});
      await drain();
      expect((await json<Edit>(call("maker", "GET", `/api/editor/${id}`))).jobs[0]).toMatchObject({ state: "failed", error: expect.stringMatching(/no longer yours/) });
    } finally {
      STEPS.analyze = real!;
      libraryDb().prepare("UPDATE assets SET trashed_at = NULL WHERE id = 'ast_a2'").run();
    }
  });
});
