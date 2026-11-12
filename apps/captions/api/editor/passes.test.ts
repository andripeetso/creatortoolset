import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Edit, Line, Sentence, VersionPlan } from "../../contracts/editor";
import type { TimedWord } from "../library/transcribe";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "editor-passes-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-passes-test-secret";

const { createUser, setOff } = await import("../users");
const app = (await import("../boot")).default;
const rootReplaced = (await import("../lib/plugin")).pluginReplaces("/api/editor");
const { libraryDb } = await import("../library/db");
const { enqueueJob } = await import("../library/jobs");
const { saveTranscript } = await import("../library/transcribe");
const { ENERGY_PER_SECOND, energyFile } = await import("./analyze");
const { readStep, saveStep } = await import("./store");
const { STEPS, tick } = await import("./worker");

const words: TimedWord[] = [
  { w: "we", s: 0.5, e: 0.75 },
  { w: "roll.", s: 0.85, e: 1.1 },
];
const sentences: Sentence[] = [{ n: 1, src: "ver_a", text: "we roll.", s: 0.5, e: 1.1, w0: 0, w1: 1 }];
const take = { first: 1, last: 1, score: 1 };
const lines: Line[] = [{ id: "L1", text: "we roll", takes: [take] }];
const plans: VersionPlan[] = ["v1", "v2"].map((name) => ({ name, title: name, lines: [{ line: "L1", take }] }));

const cookies: Record<string, string> = {};
const call = (user: string, method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { cookie: cookies[user]!, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const json = async <T = any>(r: Response | Promise<Response>): Promise<T> => (await r).json() as Promise<T>;
const drain = async () => {
  while (await tick(10 ** 13));
};
/** The steps run after `from` (a job id), as "kind variant". */
const since = (e: Edit, from: number) => e.jobs.filter((j) => j.id > from).map((j) => `${j.kind} ${j.variant}`);
const view = (id: string) => json<Edit>(call("maker", "GET", `/api/editor/${id}`));

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
  saveTranscript(d, "ver_a", "deepgram", "en", [], words);
  const energy = new Float32Array(4 * ENERGY_PER_SECOND).fill(0.5, Math.round(0.5 * ENERGY_PER_SECOND), Math.round(1.1 * ENERGY_PER_SECOND));
  mkdirSync(path.dirname(energyFile("ver_a")), { recursive: true });
  writeFileSync(energyFile("ver_a"), energy);
  // the preview, filing and cards need footage, Review and a Mac: here they only finish
  for (const k of ["preview", "file", "cards"]) STEPS[k] = async () => {};
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(rootReplaced)("AI Editor: edit in passes", () => {
  it("the first cut waits in Review; Carry on runs the B-roll, then the cards, each to a new preview; then nothing is left", async () => {
    const anim = await json<{ id: string }>(call("maker", "POST", "/api/editor/animation-styles", { name: "Tiny cards" }));
    const style = await json<{ id: string; passes?: boolean }>(call("maker", "POST", "/api/editor/styles", { name: "Tiny passes", passes: true, brollCollectionId: "col_a", animation: anim.id }));
    expect(style.passes).toBe(true);
    const { id } = await json<{ id: string }>(call("maker", "POST", "/api/editor", { sources: ["ver_a"], style: style.id, versions: 2 }));
    expect((await view(id)).style).toMatchObject({ passes: true, animation: anim.id });
    expect((await view(id)).passes).toEqual({ waiting: false, next: null }); // no cut yet
    await saveStep(id, "analysis", { sentences, notes: [] });
    await saveStep(id, "plan", { lines, plans, notes: [] });
    enqueueJob(libraryDb(), "maker", `${id}:`, "draft", "maker", true, "edit_jobs");
    await drain();

    // pass 1: each version's draft → post → preview → file, and no B-roll
    let e = await view(id);
    expect(since(e, 0)).toEqual(["draft ", "draft v1", "draft v2", "post v1", "post v2", "preview v1", "preview v2", "file v1", "file v2"]);
    expect(e.passes).toEqual({ waiting: true, next: "broll" });

    // the creator only: anyone else is told there is no such edit
    expect((await call("other", "POST", `/api/editor/${id}/pass`)).status).toBe(404);
    let last = Math.max(...e.jobs.map((j) => j.id));
    e = await json<Edit>(call("maker", "POST", `/api/editor/${id}/pass`));
    expect(e.passes).toEqual({ waiting: false, next: "cards" });
    expect(readStep(id, "passes")).toEqual({ v1: ["broll"], v2: ["broll"] });
    const busy = await call("maker", "POST", `/api/editor/${id}/pass`);
    expect([busy.status, ((await busy.json()) as { error: string }).error]).toEqual([409, "This edit is still being made"]);
    await drain();
    e = await view(id);
    expect(since(e, last)).toEqual(["broll v1", "broll v2"]);
    // done rows are queued again in place (one row per kind and version): what ran is in their order of state
    expect(e.jobs.filter((j) => j.variant === "v1").map((j) => j.kind)).toEqual(["draft", "post", "preview", "file", "broll"]);
    expect(e.jobs.every((j) => j.state === "done")).toBe(true);
    expect(e.jobs.some((j) => j.kind === "cards")).toBe(false);
    expect(e.passes).toEqual({ waiting: true, next: "cards" });

    last = Math.max(...e.jobs.map((j) => j.id));
    await call("maker", "POST", `/api/editor/${id}/pass`);
    await drain();
    e = await view(id);
    expect(since(e, last)).toEqual(["cards v1", "cards v2"]);
    expect(e.jobs.every((j) => j.state === "done")).toBe(true);
    expect(e.passes).toEqual({ waiting: false, next: null });
    const none = await call("maker", "POST", `/api/editor/${id}/pass`);
    expect([none.status, ((await none.json()) as { error: string }).error]).toEqual([409, "Nothing left to do"]);

    // a version cut again starts its passes over; the other keeps its record
    enqueueJob(libraryDb(), "maker", `${id}:v1`, "draft", "maker", true, "edit_jobs");
    await drain();
    expect(readStep(id, "passes")).toEqual({ v2: ["broll", "cards"] });
    e = await view(id);
    expect(e.passes).toEqual({ waiting: true, next: "broll" });
    await call("maker", "POST", `/api/editor/${id}/pass`);
    expect(readStep(id, "passes")).toEqual({ v1: ["broll"], v2: ["broll", "cards"] });
  });

  it("an edit not in passes has no Carry on: 409, and no passes in its view", async () => {
    const { id } = await json<{ id: string }>(call("maker", "POST", "/api/editor", { sources: ["ver_a"], brollCollectionId: "col_a" }));
    await saveStep(id, "analysis", { sentences, notes: [] });
    await saveStep(id, "plan", { lines, plans: plans.slice(0, 1), notes: [] });
    enqueueJob(libraryDb(), "maker", `${id}:`, "draft", "maker", true, "edit_jobs");
    await drain();
    const e = await view(id);
    expect(e.jobs.map((j) => `${j.kind} ${j.variant}`)).toEqual(["draft ", "draft v1", "broll v1", "post v1", "preview v1", "file v1"]);
    expect(e.passes).toBeUndefined();
    expect((await call("maker", "POST", `/api/editor/${id}/pass`)).status).toBe(409);
    expect(readStep(id, "passes")).toBeNull();
  });
});
