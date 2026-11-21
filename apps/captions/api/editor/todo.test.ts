import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Edit, Line, Sentence, VersionPlan } from "../../contracts/editor";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "editor-todo-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-todo-test-secret";

const { createUser, setOff } = await import("../users");
const app = (await import("../boot")).default;
const rootReplaced = (await import("../lib/plugin")).pluginReplaces("/api/editor");
const { libraryDb } = await import("../library/db");
const { enqueueJob } = await import("../library/jobs");
const { readEdit, readStep, saveDraft, saveStep, spending } = await import("./store");
const { recordUsage } = await import("../lib/mac-claude");
const { readCards, saveCards, sheetFile } = await import("./cards/state");
const { cardsStep, SHEET_LINE } = await import("./cards/step");
const { Waiting } = await import("./analyze");
const { STEPS, tick } = await import("./worker");
import type { Todo } from "./todo";

const sentences: Sentence[] = [{ n: 1, src: "ver_a", text: "we roll.", s: 0.5, e: 1.1, w0: 0, w1: 1 }];
const take = { first: 1, last: 1, score: 1 };
const lines: Line[] = [{ id: "L1", text: "we roll", takes: [take] }];
const plans: VersionPlan[] = ["v1", "v2"].map((name) => ({ name, title: name, lines: [{ line: "L1", take }] }));

const cookies: Record<string, string> = {};
const call = (user: string, method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { cookie: cookies[user]!, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const json = async <T = any>(r: Response | Promise<Response>): Promise<T> => (await r).json() as Promise<T>;
const todo = () => json<Todo>(call("maker", "GET", "/api/editor/todo"));
const view = (id: string) => json<Edit>(call("maker", "GET", `/api/editor/${id}`));
const rowOf = (id: string, vid: string, kind: string) =>
  libraryDb().prepare("SELECT id, state, run_after FROM edit_jobs WHERE version_id = ? AND kind = ?").get(`${id}:${vid}`, kind) as { id: number; state: string; run_after: number };

let id = "";
let animId = "";

beforeAll(async () => {
  for (const u of ["maker", "other"]) {
    setOff(createUser(u, "password1", { role: "user" }), []);
    const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: u, password: "password1" }) });
    cookies[u] = res.headers.get("set-cookie")!.split(";")[0]!;
  }
  const d = libraryDb();
  d.exec(`
    INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'maker', 'A', 'local', 0);
    INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('ast_a', 'lib_a', 'video', 'Take A', 'maker', 0);
    INSERT INTO collections (id, library_id, name, kind, created_at) VALUES ('col_a', 'lib_a', 'Tiny B-roll', 'manual', 0);
  `);
  const probe = { duration: 4, width: 1080, height: 1920, fps: 25, format: "mov", vcodec: "h264", pixFmt: "yuv420p", acodec: "aac" };
  d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at) VALUES ('ver_a', 'ast_a', 1, 'k', 1, 'x', ?, 'ready', 'maker', 0)").run(JSON.stringify(probe));
  // no step runs here: the rows are what the to-do reads
  for (const k of Object.keys(STEPS)) STEPS[k] = async () => {};
  animId = (await json<{ id: string }>(call("maker", "POST", "/api/editor/animation-styles", { name: "Tiny cards" }))).id;
  const style = await json<{ id: string }>(call("maker", "POST", "/api/editor/styles", { name: "Tiny passes", passes: true, brollCollectionId: "col_a", animation: animId }));
  id = (await json<{ id: string }>(call("maker", "POST", "/api/editor", { sources: ["ver_a"], style: style.id, versions: 2 }))).id;
  await saveStep(id, "analysis", { sentences, notes: [] });
  await saveStep(id, "plan", { lines, plans, notes: [] });
  const tl = { name: "v", fps: 25, width: 1080, height: 1920, sources: {}, tracks: { V1: { items: [] }, V2: { items: [] }, A1: { items: [] }, A2: { items: [] }, A3: { items: [] } }, markers: [] };
  for (const v of ["v1", "v2"]) await saveDraft(id, v, { timeline: tl as never, notes: [] });
  // what a run left: each version's first cut drafted and filed in Review (the preview step is stubbed out here)
  for (const v of ["v1", "v2"]) enqueueJob(d, "maker", `${id}:${v}`, "preview", "maker", true, "edit_jobs");
  while (await tick(10 ** 13));
  await saveStep(id, "review", { v1: { assetId: "rv_1", n: 1 }, v2: { assetId: "rv_2", n: 1 } });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(rootReplaced)("AI Editor: to-do, go, jobs", () => {
  it("a held pass waits for the go, and the go queues it", async () => {
    const t = await todo();
    expect(Object.keys(t).sort()).toEqual(["changes", "failed", "queued", "review", "running", "sheets", "worker"]);
    expect(t.worker).toEqual({ online: false });
    const held = t.sheets.find((s) => s.target === "v1")!;
    expect(held).toMatchObject({ edit: id, kind: "broll", status: "waiting", hold: true });
    const job = held.key.split(":").at(-1)!;
    // somebody else's go finds no such edit; a note is not a go on a pass
    expect((await call("other", "POST", `/api/editor/${id}/jobs/${job}/go`, {})).status).toBe(404);
    expect((await call("maker", "POST", `/api/editor/${id}/jobs/${job}/go`, { note: "tighter" })).status).toBe(400);
    expect((await call("maker", "POST", `/api/editor/${id}/jobs/${job}/go`, {})).status).toBe(200);
    expect(rowOf(id, "v1", "broll").state).toBe("queued");
    expect(readStep(id, "passes")).toEqual({ v1: ["broll"] });
    // something of the edit runs: nothing waits for a go, and the same go again is refused
    expect((await todo()).sheets).toEqual([]);
    expect((await todo()).queued.map((j) => `${j.kind} ${j.target}`)).toEqual(["broll v1"]);
    expect((await call("maker", "POST", `/api/editor/${id}/jobs/${job}/go`, {})).status).toBe(409);
    while (await tick(10 ** 13));
  });

  it("a cards look sheet waits on the step, its picture shows, a note makes the cards again and the go lays them", async () => {
    const d = libraryDb();
    enqueueJob(d, "maker", `${id}:v2`, "cards", "maker", true, "edit_jobs");
    d.prepare("UPDATE edit_jobs SET run_after = ? WHERE version_id = ? AND kind = 'cards'").run(Date.now() + 300_000, `${id}:v2`);
    await saveCards(id, "v2", { style: animId, calls: 2, draws: 1, drawn: ["c1"], liked: [], done: true, cards: [{ id: "c1", text: "Roll", first: 1, last: 1, line: "we roll.", seconds: 1 }], width: 1080, height: 1920, fps: 25, sheet: { at: 5 } });
    writeFileSync(sheetFile(id, "v2"), Buffer.from([0xff, 0xd8, 0xff]));
    const job = rowOf(id, "v2", "cards").id;

    // the step itself holds while the sheet waits
    const ctx = { edit: readEdit(id)!, job: { actor: "maker" } as never, variant: "v2", signal: new AbortController().signal };
    const held = await cardsStep(ctx).catch((e: unknown) => e);
    expect(held).toBeInstanceOf(Waiting);
    expect((held as InstanceType<typeof Waiting>).line).toBe(SHEET_LINE);

    expect((await todo()).sheets).toEqual([expect.objectContaining({ key: `j:${id}:${job}`, kind: "cards", target: "v2", sheet: { at: 5 } })]);
    expect((await view(id)).jobs.find((j) => j.id === job)?.sheet).toEqual({ at: 5 });
    const pic = await call("maker", "GET", `/api/editor/${id}/jobs/${job}/sheet.jpg`);
    expect(pic.status).toBe(200);
    expect(pic.headers.get("content-type")).toBe("image/jpeg");
    expect((await call("other", "GET", `/api/editor/${id}/jobs/${job}/sheet.jpg`)).status).toBe(404);

    // a note: the cards go, made again with it, and the step wakes now
    expect((await call("maker", "POST", `/api/editor/${id}/jobs/${job}/go`, { note: "Bigger words" })).status).toBe(200);
    expect(readCards(id, "v2")).toEqual({ style: animId, calls: 0, draws: 0, drawn: [], liked: [], sheetNote: "Bigger words" });
    expect(rowOf(id, "v2", "cards").run_after).toBe(0);
    expect((await call("maker", "POST", `/api/editor/${id}/jobs/${job}/go`, {})).status).toBe(409); // no sheet out now

    // the next sheet, then the go: laid on the cut, the step no longer holds
    await saveCards(id, "v2", { style: animId, calls: 2, draws: 1, drawn: ["c1"], liked: [], done: true, sheet: { at: 9 } });
    expect((await call("maker", "POST", `/api/editor/${id}/jobs/${job}/go`, {})).status).toBe(200);
    expect(readCards(id, "v2")?.go).toBe(true);
    await expect(cardsStep(ctx)).resolves.toBeUndefined();
    d.prepare("UPDATE edit_jobs SET state = 'done' WHERE id = ?").run(job);
  });

  it("a failed step shows until marked read; a stopped one never", async () => {
    const d = libraryDb();
    for (const [kind, error] of [["sound", "No voice"], ["post", "Stopped"]]) {
      enqueueJob(d, "maker", `${id}:v1`, kind, "maker", true, "edit_jobs");
      d.prepare("UPDATE edit_jobs SET state = 'failed', error = ?, done_at = ? WHERE version_id = ? AND kind = ?").run(error, Date.now(), `${id}:v1`, kind);
    }
    const failed = (await todo()).failed;
    expect(failed.map((j) => `${j.kind} ${j.error}`)).toEqual(["sound No voice"]);
    expect((await call("maker", "POST", "/api/editor/todo/read", { keys: "x" })).status).toBe(400);
    expect((await call("maker", "POST", "/api/editor/todo/read", { keys: [failed[0]!.key] })).status).toBe(200);
    expect((await todo()).failed).toEqual([]);
    // read marks are each person's own
    expect((await json<Todo>(call("other", "GET", "/api/editor/todo"))).failed).toEqual([]);
  });

  it("a step queued by hand: known kinds and versions only, once at a time", async () => {
    const post = (b: unknown) => call("maker", "POST", `/api/editor/${id}/jobs`, b);
    expect((await post({ kind: "file", variant: "v1" })).status).toBe(400);
    expect((await post({ kind: "preview", variant: "v9" })).status).toBe(400);
    const made = await post({ kind: "preview", draft: "v1" });
    expect(made.status).toBe(201);
    expect(await made.json()).toMatchObject({ kind: "preview", variant: "v1", state: "queued" });
    expect((await post({ kind: "preview", variant: "v1" })).status).toBe(409);
    expect((await call("other", "POST", `/api/editor/${id}/jobs`, { kind: "analyze" })).status).toBe(404);
    while (await tick(10 ** 13));
  });

  it("a version's preview is its Review video", async () => {
    const r = await call("maker", "GET", `/api/editor/${id}/drafts/v1/preview`);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/api/review/assets/rv_1/v/1/play");
    expect((await call("maker", "GET", `/api/editor/${id}/drafts/v7/preview`)).status).toBe(404);
  });

  it("what a step's AI calls spent is kept on its job and summed on the edit", async () => {
    const job = rowOf(id, "v1", "preview").id;
    await spending({ id: job, version_id: `${id}:v1` }, async () => {
      await recordUsage("test", { tokens: 100, costUsd: 0.25 });
      await recordUsage("test", { tokens: 50, costUsd: 0.5 });
    });
    // a step that throws keeps what it spent
    await spending({ id: job, version_id: `${id}:v1` }, async () => {
      await recordUsage("test", { tokens: 1, costUsd: 0.25 });
      throw new Error("no");
    }).catch(() => {});
    expect((await view(id)).jobs.find((j) => j.id === job)?.usage).toEqual({ calls: 3, tokens: 151, costUsd: 1 });
    expect((await json<Edit[]>(call("maker", "GET", "/api/editor"))).find((e) => e.id === id)?.costUsd).toBe(1);
  });
});
