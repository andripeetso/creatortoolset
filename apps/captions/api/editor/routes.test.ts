import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Edit, EditSummary } from "../../contracts/editor";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "editor-routes-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-routes-test-secret";

const { createUser, findUser, newApiKey, setOff } = await import("../users");
const app = (await import("../boot")).default;
// A loaded plug-in that replaces /api/editor answers the root itself, so these tests (which drive the built-in root) run only without one.
const rootReplaced = (await import("../lib/plugin")).pluginReplaces("/api/editor");
const { libraryDb } = await import("../library/db");
const { enqueueJob } = await import("../library/jobs");
const { NeedsKey } = await import("../library/transcribe");
const { STEPS, tick } = await import("./worker");
const { readDraft, readStep, saveDraft, saveFiled, saveStep } = await import("./store");
const { emptyTracks } = await import("./timeline");

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
    INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_a', 'maker', 'A', 'local', '{"upload":"all"}', 0), ('lib_b', 'other', 'B', 'local', '{}', 0);
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
    // once analyze has run, changing the spoken language re-queues analyze so the footage is read in that language
    enqueueJob(libraryDb(), "maker", `${id}:`, "analyze", "maker", false, "edit_jobs");
    libraryDb().prepare("UPDATE edit_jobs SET state = 'done' WHERE edit_id = ? AND kind = 'analyze'").run(id);
    const after = await json<Edit>(call("maker", "PATCH", `/api/editor/${id}`, { languages: ["fi"] }));
    expect(after.jobs).toMatchObject([{ kind: "analyze", state: "queued" }]);
    // patching the same language again does not re-queue a done analyze
    libraryDb().prepare("UPDATE edit_jobs SET state = 'done' WHERE edit_id = ? AND kind = 'analyze'").run(id);
    const same = await json<Edit>(call("maker", "PATCH", `/api/editor/${id}`, { languages: ["fi"] }));
    expect(same.jobs).toMatchObject([{ kind: "analyze", state: "done" }]);
    // changing language while analyze is already running stops it and queues it again
    libraryDb().prepare("UPDATE edit_jobs SET state = 'running' WHERE edit_id = ? AND kind = 'analyze'").run(id);
    const mid = await json<Edit>(call("maker", "PATCH", `/api/editor/${id}`, { languages: ["sv"] }));
    expect(mid.jobs).toMatchObject([{ kind: "analyze", state: "queued" }]);
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

  it("POST drafts/:name/cut cuts Review's timeline edits into the draft and queues its next version; the edits as made, or none", async () => {
    const { id } = await json<{ id: string }>(create("maker", ["ver_a1"]));
    await call("maker", "POST", `/api/editor/${id}/stop`);
    const tracks = emptyTracks();
    for (const k of [0, 1, 2]) {
      tracks.V1.items.push({ src: "ver_a1", in: k * 100, len: 30, rec: k * 30, link: `c${k}` });
      tracks.A1.items.push({ src: "ver_a1", in: k * 100, len: 30, rec: k * 30, link: `c${k}` });
    }
    const timeline = { name: "Hook v1", fps: 30, width: 1080, height: 1920, tracks, markers: [], sources: { ver_a1: { versionId: "ver_a1", name: "Take", fps: 30, tc: 0, dur: 900, w: 1080, h: 1920 } } };
    await saveDraft(id, "v1", { timeline, notes: ["A note the draft step wrote"] });
    const cut = (body: object, user = "maker") => call(user, "POST", `/api/editor/${id}/drafts/v1/cut`, body);
    const edits = [{ key: "V1:30", label: "Second line", remove: true }, { key: "V1:60", label: "Third line", head: -10 }];
    // not filed in Review yet, then filed as version 2 of its Review video
    expect((await cut({ asset: "rev-1", n: 2, edits })).status).toBe(409);
    await saveStep(id, "review", { v1: { assetId: "rev-1", n: 2 } });
    expect(await json(cut({ asset: "rev-1", n: 2, edits }))).toMatchObject({ code: "conflict", error: expect.stringContaining("filed before") });
    await saveFiled(id, "rev-1", 2, { variant: "v1", timeline });
    expect((await cut({ asset: "rev-1", n: 2, edits }, "other")).status).toBe(404);
    // an older version's edits, no edits, and an edit that can't be made change nothing
    expect((await cut({ asset: "rev-1", n: 1, edits })).status).toBe(409);
    expect((await cut({ asset: "rev-1", n: 2, edits: [] })).status).toBe(400);
    const refused = await cut({ asset: "rev-1", n: 2, edits: [...edits, { key: "A1:0", label: "First voice", move: 5 }] });
    expect(refused.status).toBe(400);
    expect((await json(refused)).error).toBe("First voice: a voice stays with its picture, it can only be cut or removed");
    expect(readDraft(id, "v1")!.timeline.tracks.V1.items).toHaveLength(3);

    const e = await json<Edit>(cut({ asset: "rev-1", n: 2, edits }));
    expect(e.jobs.filter((j) => j.state === "queued").map((j) => [j.kind, j.variant])).toEqual([["post", "v1"]]);
    const d = readDraft(id, "v1")!;
    expect(d.timeline.tracks.V1.items.map((i) => [i.rec, i.len, i.in])).toEqual([[0, 30, 0], [30, 20, 210]]);
    expect(d.notes).toEqual(["A note the draft step wrote", "Cut by hand in Review: 2 timeline edits on version 2 (Second line on V1: taken out with its voice, what follows moves up; Third line on V1: 10 f off the start)"]);
    // while that version is being made, a second cut waits
    expect(await json(cut({ asset: "rev-1", n: 2, edits }))).toMatchObject({ code: "conflict", error: "This version is still being made" });
    await call("maker", "POST", `/api/editor/${id}/stop`);
  });

  it("export refuses a version whose newest post step did not finish, and takes it again once post is done", async () => {
    const { id } = await json<{ id: string }>(create("maker", ["ver_a2"]));
    await saveDraft(id, "v1", { timeline: { sources: { ver_a2: {} }, tracks: {}, markers: [], fps: 25, width: 1080, height: 1920, name: "v1" } as never, notes: [] });
    enqueueJob(libraryDb(), "ws", `${id}:v1`, "post", "maker", true, "edit_jobs");
    libraryDb().prepare("UPDATE edit_jobs SET state = 'failed' WHERE edit_id = ? AND kind = 'post'").run(id);
    const refused = await call("maker", "GET", `/api/editor/${id}/drafts/v1/export?format=otio`);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe("Post-processing did not finish on this version: run it again before exporting");
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

  it("set to Read, the AI Editor opens but refuses every change (READ_ONLY)", async () => {
    findUser("other")!.read = ["editor"];
    try {
      expect((await call("other", "GET", "/api/editor")).status).toBe(200);
      const res = await call("other", "POST", "/api/editor", { sources: ["ver_a1"] });
      expect(res.status).toBe(403);
      expect(await json(res)).toMatchObject({ code: "READ_ONLY" });
    } finally {
      findUser("other")!.read = [];
    }
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
      expect((await json<Edit>(call("maker", "GET", `/api/editor/${id}`))).jobs[0]).toMatchObject({ state: "failed", error: expect.stringMatching(/cannot be read by this account/) });
    } finally {
      STEPS.analyze = real!;
      libraryDb().prepare("UPDATE assets SET trashed_at = NULL WHERE id = 'ast_a2'").run();
    }
  });
});

describe.skipIf(rootReplaced)("Editor: projects, versions and the timeline page", () => {
  const take = (n: number) => ({ versionId: "ver_a1", name: "Take", fps: 30, tc: 0, dur: 900 + n, w: 1080, h: 1920 });
  const cutOf = () => {
    const tracks = emptyTracks();
    for (const k of [0, 1]) {
      tracks.V1.items.push({ src: "ver_a1", in: k * 100, len: 30, rec: k * 30, link: `c${k}` });
      tracks.A1.items.push({ src: "ver_a1", in: k * 100, len: 30, rec: k * 30, link: `c${k}` });
    }
    return { name: "Tiny v1", fps: 30, width: 1080, height: 1920, tracks, markers: [], sources: { ver_a1: take(0) } };
  };
  const made = async (name = "Tiny cartwheel") => {
    const { id } = await json<{ id: string }>(create("maker", ["ver_a1"], { name }));
    await call("maker", "POST", `/api/editor/${id}/stop`);
    return id;
  };
  const stopAll = (id: string) => call("maker", "POST", `/api/editor/${id}/stop`);
  const queued = (e: Edit) => e.jobs.filter((j) => j.state === "queued").map((j) => [j.kind, j.variant]);

  it("files the versions of one video into one project folder when they are made; the list counts versions and shows the newest still", async () => {
    const a = await made("Tiny Flip");
    const b = await made("Tiny Flip 25s v2");
    const { read } = await import("../folders");
    const d = await read("editor", "maker");
    expect(d.items[a]).toBeTruthy();
    expect(d.items[b]).toBe(d.items[a]);
    // (cut from the same take as the other edits here, so they all share that video's folder: projects.test.ts names it)
    await saveDraft(a, "v1", { timeline: cutOf(), notes: [] });
    await saveDraft(a, "v2", { timeline: cutOf(), notes: [] });
    await saveStep(a, "review", { v1: { assetId: "rev-old", n: 1 }, v2: { assetId: "rev-new", n: 3 } });
    await saveFiled(a, "rev-old", 1, { variant: "v1", timeline: cutOf() });
    await new Promise((r) => setTimeout(r, 15));
    await saveFiled(a, "rev-new", 3, { variant: "v2", timeline: cutOf() });
    const row = async () => (await json<EditSummary[]>(call("maker", "GET", "/api/editor"))).find((s) => s.id === a)!;
    expect(await row()).toMatchObject({ versionCount: 2, still: { asset: "rev-new", n: 3 } });
    // a deleted version is off the count and the still; Undo brings it back
    expect(await json(call("maker", "PATCH", `/api/editor/${a}/versions/v2`, { trashed: true }))).toEqual({ v2: { trashedAt: expect.any(Number) } });
    expect(await row()).toMatchObject({ versionCount: 1, still: { asset: "rev-old", n: 1 } });
    expect(await json(call("maker", "PATCH", `/api/editor/${a}/versions/v2`, { trashed: false }))).toEqual({});
  });

  it("renames a version (\"\" takes the name off), refuses others and a version that is not there; GET shows the marks", async () => {
    const id = await made();
    await saveDraft(id, "v1", { timeline: cutOf(), notes: [] });
    expect((await call("maker", "PATCH", `/api/editor/${id}/versions/v4`, { label: "x" })).status).toBe(404);
    expect((await call("other", "PATCH", `/api/editor/${id}/versions/v1`, { label: "x" })).status).toBe(404);
    expect((await call("maker", "PATCH", `/api/editor/${id}/versions/v1`, { label: 5 })).status).toBe(400);
    expect(await json(call("maker", "PATCH", `/api/editor/${id}/versions/v1`, { label: "  Hook first  " }))).toEqual({ v1: { label: "Hook first" } });
    expect((await json<Edit>(call("maker", "GET", `/api/editor/${id}`))).marks).toEqual({ v1: { label: "Hook first" } });
    expect(await json(call("maker", "PATCH", `/api/editor/${id}/versions/v1`, { label: "" }))).toEqual({});
  });

  it("duplicates a version as the next free one, named its copy, and makes its post-processing and preview; no draft is 404", async () => {
    const id = await made();
    expect((await call("maker", "POST", `/api/editor/${id}/drafts/v1/duplicate`)).status).toBe(404);
    await saveDraft(id, "v1", { timeline: cutOf(), notes: ["a note"], due: 1 });
    await saveDraft(id, "v2", { timeline: cutOf(), notes: [] });
    await call("maker", "PATCH", `/api/editor/${id}/versions/v1`, { label: "Hook first" });
    expect((await call("other", "POST", `/api/editor/${id}/drafts/v1/duplicate`)).status).toBe(404);
    const res = await call("maker", "POST", `/api/editor/${id}/drafts/v1/duplicate`);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ name: "v3" });
    expect(readDraft(id, "v3")).toEqual({ timeline: { ...cutOf(), name: "Tiny v3" }, notes: ["a note"] });
    const e = await json<Edit>(call("maker", "GET", `/api/editor/${id}`));
    expect(e.marks?.v3).toEqual({ label: "Hook first copy" });
    expect(queued(e)).toEqual([["post", "v3"]]);
    await stopAll(id);
  });

  it("the timeline page: a draft's view and the Review version it is; edits cut in without a Review version; a changed draft renders as it is", async () => {
    const id = await made();
    const timeline = cutOf();
    await saveDraft(id, "v1", { timeline, notes: ["Cut by hand in Review: 1 timeline edit on version 1"] });
    const draft = async () => json<{ view: { tracks: { id: string; items: { key: string }[] }[] }; filed: unknown }>(call("maker", "GET", `/api/editor/${id}/drafts/v1`));
    let d = await draft();
    expect(d.view.tracks.find((t) => t.id === "V1")!.items.map((i) => i.key)).toEqual(["V1:0", "V1:30"]);
    expect(d.filed).toBeNull();
    await saveStep(id, "review", { v1: { assetId: "rev-t", n: 2 } });
    await saveFiled(id, "rev-t", 2, { variant: "v1", timeline });
    expect((await draft()).filed).toEqual({ assetId: "rev-t", n: 2 });
    const cut = (body: object) => call("maker", "POST", `/api/editor/${id}/drafts/v1/cut`, body);
    // the draft is what Review has: nothing to render without edits
    expect((await cut({ edits: [] })).status).toBe(400);
    const e = await json<Edit>(cut({ edits: [{ key: "V1:30", label: "Second line", remove: true }] }));
    expect(queued(e)).toEqual([["post", "v1"]]);
    const after = readDraft(id, "v1")!;
    expect(after.timeline.tracks.V1.items.map((i) => i.rec)).toEqual([0]);
    const handNotes = ["Cut by hand in Review: 1 timeline edit on version 1", "Cut by hand on the timeline: 1 timeline edit (Second line on V1: taken out with its voice, what follows moves up)"];
    expect(after.notes).toEqual(handNotes);
    expect(await json(cut({ edits: [] }))).toMatchObject({ error: "This version is still being made" });
    await stopAll(id);
    // changed since Review: no edits renders it as it is, with no new revision
    expect((await draft()).filed).toBeNull();
    expect(queued(await json<Edit>(cut({ edits: [] })))).toEqual([["post", "v1"]]);
    expect(readDraft(id, "v1")!.notes).toEqual(handNotes);
    await stopAll(id);
    // an AI key's cut (a chat's editor_cut) is noted as the AI's; the last five cut notes stay, other notes too
    const cuts = [1, 2, 3, 4, 5].map((k) => `Cut by hand on the timeline: cut ${k}`);
    await saveDraft(id, "v1", { ...readDraft(id, "v1")!, notes: ["a note", ...cuts] });
    const byKey = await app.request(`/api/editor/${id}/drafts/v1/cut`, {
      method: "POST",
      headers: { authorization: `Bearer ${newApiKey(findUser("maker")!, "full")}`, "content-type": "application/json" },
      body: JSON.stringify({ edits: [{ key: "V1:0", label: "First line", head: -10 }] }),
    });
    expect(byKey.status).toBe(200);
    expect(readDraft(id, "v1")!.notes).toEqual(["a note", ...cuts.slice(1), "Cut by the AI on the timeline: 1 timeline edit (First line on V1: 10 f off the start)"]);
    await stopAll(id);
  });

  it("an empty timeline: an edit with no footage and v1; a clip as the editor lays it, with its sound or none", async () => {
    libraryDb().prepare("UPDATE asset_versions SET probe = ? WHERE id = 'ver_a1'").run(JSON.stringify({ duration: 2, width: 1920, height: 1080, fps: 25, rotation: 0, format: "mp4", vcodec: "h264", pixFmt: "yuv420p", acodec: "aac" }));
    const res = await call("maker", "POST", "/api/editor/empty", { name: "Tiny blank" });
    expect(res.status).toBe(201);
    const { id, draft } = (await res.json()) as { id: string; draft: string };
    expect(draft).toBe("v1");
    const e = await json<Edit>(call("maker", "GET", `/api/editor/${id}`));
    expect(e).toMatchObject({ name: "Tiny blank", sources: [], drafts: ["v1"], jobs: [], workspaceId: "maker" });
    expect(readDraft(id, "v1")!.timeline).toMatchObject({ fps: 25, width: 1080, height: 1920, sources: {} });
    const clip = (c: string, user = "maker") => call(user, "GET", `/api/editor/${id}/clips/${c}`);
    expect((await clip("ver_b")).status).toBe(404); // another workspace's
    expect((await clip("ver_a1", "other")).status).toBe(404);
    expect((await clip("ver_a2")).status).toBe(409); // no probe yet
    expect(await json(clip("ver_a1"))).toEqual({ source: { versionId: "ver_a1", name: "Take 1", fps: 25, tc: 0, dur: 50, w: 1920, h: 1080 }, sound: true });
  });

  it("the editor's whole timeline: judged, kept with every field it doesn't know; version 2 and fields the renders don't draw refused", async () => {
    const id = await made();
    const timeline = { ...cutOf(), speakers: [{ rec: 0, len: 30, speaker: 1 }] };
    // gain on a picture clip: not drawn, but the draft came with it, so it stays
    Object.assign(timeline.tracks.V1.items[0]!, { gainDb: -3, zoom: 1.2, fx: [{ kind: "shake" }] });
    await saveDraft(id, "v1", { timeline, notes: [] });
    const { rendersOf } = await import("./preview");
    expect((await json(call("maker", "GET", `/api/editor/${id}/drafts/v1`))).renders).toEqual(rendersOf(timeline));
    expect(rendersOf(timeline).tracks.V1).not.toContain("rot");
    const { toNle } = await import("../../src/lib/nle/draft");
    const nle = toNle(timeline as never);
    nle.tracks.V1.items[1]!.len = 20; // a trim
    nle.tracks.V1.items[0]!.mine = "kept";
    const put = (tl: unknown, user = "maker") => call(user, "PUT", `/api/editor/${id}/drafts/v1/timeline`, { timeline: tl });
    expect((await put(nle, "other")).status).toBe(404);
    expect((await put({})).status).toBe(400);
    // keys are version 2: refused, never saved down; the draft as it was
    const keyed = structuredClone(nle);
    keyed.tracks.V1.items[0]!.keys = { zoom: [[0, 1, "ease"], [20, 1.5, "ease"]] };
    expect(await json(put(keyed))).toMatchObject({ code: "invalid", error: expect.stringContaining("Not in this server's renders yet") });
    expect(await json(put({ ...nle, edj_version: 7 }))).toMatchObject({ error: expect.stringContaining("version 7") });
    const turned = structuredClone(nle);
    turned.tracks.V1.items[0]!.rot = 10;
    expect(await json(put(turned))).toMatchObject({ error: expect.stringContaining("Not in this server's renders yet: V1 rot") });
    const v3 = structuredClone(nle);
    v3.tracks.V3 = { items: [{ src: "ver_a1", rec: 0, in: 0, len: 10 }] };
    expect((await json(put(v3))).error).toContain("Not in this server's renders yet: V3");
    const over = structuredClone(nle);
    over.tracks.V1.items[1]!.rec = 10;
    expect((await json(put(over))).error).toContain("starts on top of the clip before it on V1");
    expect(readDraft(id, "v1")!.timeline).toEqual(timeline);
    // clips new to the draft: another workspace's is refused, one of this workspace's not probed yet waits
    expect((await put({ ...nle, sources: { ...nle.sources, ver_b: { name: "Theirs" } } })).status).toBe(400);
    expect((await put({ ...nle, sources: { ...nle.sources, ver_a2: { name: "Take 2" } } })).status).toBe(409);

    nle.tracks.V1.items[0]!.fade_in = 5; // drawn by the renders
    const e = await json<Edit>(put(nle));
    expect(queued(e)).toEqual([["post", "v1"]]);
    const d = readDraft(id, "v1")!;
    expect(d.timeline.speakers).toEqual(timeline.speakers);
    expect(d.timeline.tracks.V1.items[0]).toEqual({ ...timeline.tracks.V1.items[0], mine: "kept", fade_in: 5 });
    expect(d.timeline.tracks.V1.items[1]!.len).toBe(20);
    expect(d.notes).toEqual(["Cut by hand on the timeline: the whole timeline saved"]);
    expect(await json(put(nle))).toMatchObject({ code: "conflict", error: "This version is still being made" });
    await stopAll(id);
    // a new library clip: its rate, length and size come from the library, and it joins the edit's footage
    libraryDb().prepare("UPDATE asset_versions SET probe = ? WHERE id = 'ver_a2'").run(JSON.stringify({ duration: 4, width: 1920, height: 1080, fps: 25, rotation: 0, format: "mp4", vcodec: "h264", pixFmt: "yuv420p" }));
    // a picture with no sound: the bin lays it with no voice clip
    expect((await json(call("maker", "GET", `/api/editor/${id}/clips/ver_a2`))).sound).toBe(false);
    const added = structuredClone(nle);
    added.sources.ver_a2 = { versionId: "ver_a2", name: "Take 2", fps: 30, dur: 1 };
    added.tracks.V2!.items.push({ src: "ver_a2", rec: 0, in: 0, len: 25 });
    expect((await put(added)).status).toBe(200);
    expect(readDraft(id, "v1")!.timeline.sources.ver_a2).toMatchObject({ versionId: "ver_a2", name: "Take 2", fps: 25, dur: 100, w: 1920, h: 1080 });
    expect((await json<Edit>(call("maker", "GET", `/api/editor/${id}`))).sources).toEqual(["ver_a1", "ver_a2"]);
    await stopAll(id);
  });

  it("restore takes an edit out of the trash, for its maker only", async () => {
    const id = await made();
    expect((await call("maker", "POST", `/api/editor/${id}/restore`)).status).toBe(404); // not in the trash
    await call("maker", "DELETE", `/api/editor/${id}`);
    expect((await call("other", "POST", `/api/editor/${id}/restore`)).status).toBe(404);
    expect((await call("maker", "POST", `/api/editor/${id}/restore`)).status).toBe(200);
    expect((await call("maker", "GET", `/api/editor/${id}`)).status).toBe(200);
  });

  it("POST /empty with sources lays probed clips end to end on v1 and skips unprobed ones", async () => {
    libraryDb()
      .prepare("UPDATE asset_versions SET probe = ? WHERE id = 'ver_a1'")
      .run(JSON.stringify({ duration: 3, width: 1080, height: 1920, fps: 30, rotation: 0, format: "mp4", vcodec: "h264", pixFmt: "yuv420p", acodec: "aac" }));
    libraryDb()
      .prepare("UPDATE asset_versions SET probe = ? WHERE id = 'ver_a2'")
      .run(JSON.stringify({ duration: 2, width: 1920, height: 1080, fps: 25, rotation: 0, format: "mp4", vcodec: "h264", pixFmt: "yuv420p" }));
    const res = await call("maker", "POST", "/api/editor/empty", { name: "All clips", sources: ["ver_a1", "ver_a2"] });
    expect(res.status).toBe(201);
    const made = await json<{ id: string; draft: string; placed: number }>(res);
    expect(made).toMatchObject({ draft: "v1", placed: 2 });
    const tl = readDraft(made.id, "v1")!.timeline;
    expect(tl).toMatchObject({ fps: 30, width: 1080, height: 1920 });
    expect(tl.tracks.V1.items).toEqual([
      { src: "ver_a1", in: 0, len: 90, rec: 0, link: "c1" },
      { src: "ver_a2", in: 0, len: 60, rec: 90 },
    ]);
    expect(tl.tracks.A1.items).toEqual([{ src: "ver_a1", in: 0, len: 90, rec: 0, link: "c1" }]);
    // another account's clip is refused
    expect((await call("maker", "POST", "/api/editor/empty", { sources: ["ver_b"] })).status).toBe(404);
    // clips still waiting for probe return 409 instead of opening an empty timeline
    libraryDb().prepare("UPDATE asset_versions SET probe = NULL WHERE id = 'ver_a2'").run();
    expect((await call("maker", "POST", "/api/editor/empty", { sources: ["ver_a2"] })).status).toBe(409);
  });

  it("POST /:id/proxies queues proxies for heavy/unplayable clips, skips playable/proxied ones, and reports pending", async () => {
    const db = libraryDb();
    db.exec(`
      INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at, trashed_at) VALUES
        ('ast_4k', 'lib_a', 'video', 'OBS 4K', 'ver_4k', 'maker', 0, NULL),
        ('ast_mkv', 'lib_a', 'video', 'Capture', 'ver_mkv', 'maker', 0, NULL),
        ('ast_hd', 'lib_a', 'video', 'HD H264', 'ver_hd', 'maker', 0, NULL),
        ('ast_hasp', 'lib_a', 'video', 'Has Proxy', 'ver_hasp', 'maker', 0, NULL);
      INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at, probe) VALUES
        ('ver_4k', 'ast_4k', 1, 'k4k', 1000, 'x4k', 'ready', 'maker', 0, '{"duration":5,"width":3840,"height":2160,"fps":30,"rotation":0,"format":"mov,mp4","vcodec":"h264","pixFmt":"yuv420p","acodec":"aac"}'),
        ('ver_mkv', 'ast_mkv', 1, 'kmkv', 1000, 'xmkv', 'ready', 'maker', 0, '{"duration":5,"width":1920,"height":1080,"fps":30,"rotation":0,"format":"matroska,webm","vcodec":"h264","pixFmt":"yuv420p","acodec":"aac"}'),
        ('ver_hd', 'ast_hd', 1, 'khd', 1000, 'xhd', 'ready', 'maker', 0, '{"duration":5,"width":1920,"height":1080,"fps":30,"rotation":0,"format":"mov,mp4","vcodec":"h264","pixFmt":"yuv420p","acodec":"aac"}'),
        ('ver_hasp', 'ast_hasp', 1, 'khasp', 1000, 'xhasp', 'ready', 'maker', 0, '{"duration":5,"width":3840,"height":2160,"fps":30,"rotation":0,"format":"mov,mp4","vcodec":"hevc","pixFmt":"yuv420p10le","acodec":"aac"}');
      INSERT INTO derivatives (version_id, kind, storage_key, bytes) VALUES
        ('ver_hasp', 'proxy', 'p/ver_hasp.mp4', 100);
    `);
    const { id } = await json<{ id: string }>(create("maker", ["ver_4k", "ver_hd", "ver_hasp"]));
    await saveDraft(id, "v1", {
      timeline: {
        name: "Hook v1", fps: 30, width: 1080, height: 1920, tracks: emptyTracks(), markers: [],
        sources: {
          ver_4k: { versionId: "ver_4k", name: "OBS 4K", fps: 30, tc: 0, dur: 150, w: 3840, h: 2160 },
          ver_mkv: { versionId: "ver_mkv", name: "Capture", fps: 30, tc: 0, dur: 150, w: 1920, h: 1080 },
          card_1: { versionId: "card_1", name: "Card", fps: 30, tc: 0, dur: 30, w: 1080, h: 1920, file: "cards/1" },
        },
      },
      notes: [],
    });
    // another user gets 404
    expect((await call("other", "POST", `/api/editor/${id}/proxies`, {})).status).toBe(404);
    // default collects edit sources + draft non-own-file sources; queues 4K + MKV, skips 1080p H264 + already-proxied + own-file card
    const first = await json<{ queued: string[]; pending: string[] }>(call("maker", "POST", `/api/editor/${id}/proxies`, {}));
    expect(first.queued.sort()).toEqual(["ver_4k", "ver_mkv"]);
    expect(first.pending.sort()).toEqual(["ver_4k", "ver_mkv"]);
    // calling again while active reports them pending without re-queueing
    const again = await json<{ queued: string[]; pending: string[] }>(call("maker", "POST", `/api/editor/${id}/proxies`, { versions: ["ver_4k", "ver_mkv"] }));
    expect(again).toEqual({ queued: [], pending: ["ver_4k", "ver_mkv"] });
    // once ver_4k gets a proxy and ver_mkv fails, check: true reports neither pending and does NOT re-queue failed jobs
    db.prepare("INSERT INTO derivatives (version_id, kind, storage_key, bytes) VALUES ('ver_4k', 'proxy', 'p/ver_4k.mp4', 100)").run();
    db.prepare("UPDATE jobs SET state = 'done' WHERE version_id = 'ver_4k' AND kind = 'proxy'").run();
    db.prepare("UPDATE jobs SET state = 'failed', error = 'bad' WHERE version_id = 'ver_mkv' AND kind = 'proxy'").run();
    const checked = await json<{ queued: string[]; pending: string[] }>(call("maker", "POST", `/api/editor/${id}/proxies`, { versions: ["ver_4k", "ver_mkv"], check: true }));
    expect(checked).toEqual({ queued: [], pending: [] });
    expect((db.prepare("SELECT state FROM jobs WHERE version_id = 'ver_mkv' AND kind = 'proxy'").get() as { state: string }).state).toBe("failed");
    // oversized version lists are rejected with 400
    const tooMany = Array.from({ length: 201 }, (_, i) => `ver_${i}`);
    expect((await call("maker", "POST", `/api/editor/${id}/proxies`, { versions: tooMany })).status).toBe(400);
    // left-hidden assets are excluded
    db.exec(`
      INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at, trashed_at, left_hidden_at) VALUES
        ('ast_hidden', 'lib_a', 'video', 'Hidden 4K', 'ver_hidden', 'maker', 0, NULL, 123);
      INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at, probe) VALUES
        ('ver_hidden', 'ast_hidden', 1, 'khidden', 1000, 'xhidden', 'ready', 'maker', 0, '{"duration":5,"width":3840,"height":2160,"fps":30,"rotation":0,"format":"mov,mp4","vcodec":"h264","pixFmt":"yuv420p","acodec":"aac"}');
    `);
    expect(await json<{ queued: string[]; pending: string[] }>(call("maker", "POST", `/api/editor/${id}/proxies`, { versions: ["ver_hidden"] }))).toEqual({ queued: [], pending: [] });
  });
});

