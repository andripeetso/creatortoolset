import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkPackage, WorkResult } from "../../contracts/work";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "work-computer-"));
process.env.DATA_DIR = dir;

const { classify, reportLeftover, runJob, startComputerWorker, STOPPED_LINE } = await import("./computer");
const { STEPS } = await import("../editor/worker");
const { Waiting } = await import("../editor/analyze");
const { NeedsKey } = await import("../library/transcribe");
const { enqueueJob } = await import("../library/jobs");
const { libraryDb } = await import("../library/db");
const { editDir } = await import("../editor/store");
const { onComputer } = await import("./on-computer");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const EDIT = "0b6f3c2a-1d2e-4f50-8a9b-0c1d2e3f4a5b";
const R = "/api/devices/relay";

/** The server's work routes, as a computer sees them: records every call. */
let calls: { at: string; body?: unknown }[] = [];
let beatOk = true;
let claims: unknown[] = [];
let claimed: Record<string, unknown>[] = [];
const uploads: Record<string, Buffer> = {};
const fake = new Hono()
  .post(`${R}/work/claim`, async (c) => (claimed.push(await c.req.json()), c.json(claims.shift() ?? { pkg: null })))
  .post(`${R}/work/lib/:id/fail`, async (c) => (calls.push({ at: `lib fail ${c.req.param("id")}`, body: await c.req.json() }), c.json({ ok: true })))
  .post(`${R}/work/:id/beat`, async (c) => (calls.push({ at: `beat ${c.req.param("id")}`, body: await c.req.json() }), c.json({ ok: beatOk })))
  .post(`${R}/work/:id/:what`, async (c) => (calls.push({ at: `${c.req.param("what")} ${c.req.param("id")}`, body: await c.req.json() }), c.json({ ok: true })))
  .put(`${R}/work/:id/file`, async (c) => ((uploads[c.req.query("path")!] = Buffer.from(await c.req.arrayBuffer())), c.json({ ok: true })))
  .get(`${R}/work/:id/own`, (c) => c.body(`own:${c.req.query("path")}`))
  .get(`${R}/editor/job/:id/footage/:v`, (c) => (calls.push({ at: `footage ${c.req.param("v")}` }), c.body("proxy")));
const o = { server: "http://server.test", token: "ctd_test", fetch: (u: string, i?: RequestInit) => Promise.resolve(fake.request(u, i)), beatMs: 20, downloadBeatMs: 20, retryMs: 10 };

const pkg = (kind: string): WorkPackage => ({
  v: 1,
  job: { id: 11, kind, editId: EDIT, variant: "v1", actor: "tinyacrobatics", workspaceId: "ws1" },
  edit: {
    "edit.json": JSON.stringify({ id: EDIT, name: "Tiny Acrobatics", sources: [], createdBy: "tinyacrobatics", workspaceId: "ws1" }),
    "plan.json": JSON.stringify({ a: 1 }),
    "old.json": "{}",
  },
  own: [{ path: "previews/v0.mp4", bytes: 21, sha256: "" }],
  rows: { edit_jobs: [{ id: 11, library_id: "ws1", version_id: `${EDIT}:v1`, kind, state: "running", attempts: 1, run_after: 0, actor: "tinyacrobatics", edit_id: EDIT }] },
  files: [],
  caches: { "va.energy.f32": Buffer.from("old").toString("base64") },
  ai: { editor: null, analyzer: null },
});

const held = () => existsSync(path.join(dir, "held.json"));
const saved = { ...STEPS };
beforeEach(() => {
  calls = [];
  beatOk = true;
});
afterEach(() => Object.assign(STEPS, saved));

describe("the computer worker", () => {
  it("runs a step on the package and sends what changed: JSON files, new media, caches, queued steps", async () => {
    let seams = false;
    STEPS.preview = async ({ edit, job, variant }) => {
      seams = onComputer.on;
      const d = editDir(edit.id);
      await writeFile(path.join(d, "plan.json"), JSON.stringify({ a: 2 }));
      rmSync(path.join(d, "old.json"));
      await mkdir(path.join(d, "previews"), { recursive: true });
      await writeFile(path.join(d, "previews", `${variant}.mp4`), "rendered");
      await writeFile(path.join(dir, "editor", "cache", "va.index.json"), "[]");
      await writeFile(path.join(d, "previews", `${variant}.jpg`), "thumb");
      await writeFile(path.join(d, "previews", `${variant}.wave.json`), "[1,2]");
      (onComputer.server as unknown as { review(r: unknown): void }).review({ variant, fails: [], thumb: path.join(d, "previews", `${variant}.jpg`), wave: path.join(d, "previews", `${variant}.wave.json`) });
      enqueueJob(libraryDb(), "ws1", job.version_id!, "critique", job.actor, true, "edit_jobs");
    };
    expect(await runJob(pkg("preview"), o)).toBe("done");
    expect(seams).toBe(true);
    expect(onComputer.on).toBe(false);
    const done = calls.find((c) => c.at === "done 11")!.body as WorkResult;
    expect(done.outcome).toEqual({ done: true });
    expect(done.edit).toEqual({ put: { "plan.json": JSON.stringify({ a: 2 }) }, gone: ["old.json"] });
    const media = `editor/${EDIT}/previews`;
    expect(done.uploads.sort()).toEqual([`${media}/v1.jpg`, `${media}/v1.mp4`, `${media}/v1.wave.json`, "editor/cache/va.index.json"]);
    expect(uploads[`${media}/v1.mp4`]!.toString()).toBe("rendered");
    expect(uploads[`${media}/v1.wave.json`]!.toString()).toBe("[1,2]");
    expect(done.effects.review).toEqual({ variant: "v1", fails: [], thumb: `${media}/v1.jpg`, wave: `${media}/v1.wave.json` });
    expect(done.effects.queue).toEqual([{ version: `${EDIT}:v1`, kind: "critique" }]);
    expect(held()).toBe(false);
  });

  it("a beat answered ok: false stops the step and sends nothing", async () => {
    let aborted = false;
    // the lease is lost while the step runs
    STEPS.preview = ({ signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
        beatOk = false;
      });
    expect(await runJob(pkg("preview"), o)).toBe("stopped");
    expect(aborted).toBe(true);
    // lost before the step starts (the beat came while the files did): it never runs
    let ran = false;
    beatOk = false;
    STEPS.preview = async () => void (ran = true);
    const slow = { ...o, fetch: async (u: string, i?: RequestInit) => (u.includes("/own") && (await new Promise((r) => setTimeout(r, 100))), fake.request(u, i)) };
    expect(await runJob(pkg("preview"), slow)).toBe("stopped");
    expect(ran).toBe(false);
    expect(calls.filter((c) => !c.at.startsWith("beat"))).toEqual([]);
    expect(held()).toBe(false);
  }, 20_000); // waits for a real beat: slow when the whole suite runs at once

  it("a step the package can't get its files for fails with that line, never asking for an original", async () => {
    STEPS.post = async () => {};
    const p = { ...pkg("post"), files: [{ id: "vo", title: "o.mov", bytes: 5, proxy: { bytes: 5 }, original: true as const }] };
    expect(await runJob(p, o)).toBe("failed");
    expect(calls.filter((c) => c.at.startsWith("footage"))).toEqual([]);
    expect((calls.find((c) => c.at === "fail 11")!.body as { error: string }).error).toMatch(/needs the original of o\.mov/);
  });

  it("reports a step a crash left behind", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "held.json"), JSON.stringify({ id: 7 }));
    await reportLeftover(o);
    expect(calls).toEqual([{ at: "fail 7", body: { error: STOPPED_LINE } }]);
    expect(held()).toBe(false);
  });

  it("stops claiming when the server needs a newer app", async () => {
    claims = [{ pkg: null }, { pkg: null, update: true }];
    expect(await startComputerWorker(o)).toBe("update");
  });

  it("CT_WORKER_KINDS=library: sweeps its scratch, asks for library work only with its machine, and stops for a newer package", async () => {
    process.env.CT_WORKER_KINDS = "library";
    process.env.CT_LIBRARY_SCRATCH_GB = "0";
    try {
      mkdirSync(path.join(dir, "library-work", "99"), { recursive: true });
      claimed = [];
      claims = [{ pkg: null }, { pkg: null, lib: { v: 99, job: { id: 5, kind: "proxy" } } }];
      expect(await startComputerWorker(o)).toBe("update");
      expect(existsSync(path.join(dir, "library-work"))).toBe(false);
      expect(claimed[0]).toMatchObject({ steps: [], library: true, libraryOnly: true });
      expect(claimed[0]!.pictures).toBeUndefined();
      expect((claimed[0]!.machine as { cpus: number }).cpus).toBeGreaterThan(0);
      expect(calls).toContainEqual({ at: "lib fail 5", body: { error: "This computer needs a newer Creator Toolset" } });
    } finally {
      delete process.env.CT_WORKER_KINDS;
      delete process.env.CT_LIBRARY_SCRATCH_GB;
    }
  });

  it("files a throw as the server's loop does", () => {
    const now = 1_000_000;
    expect(classify(new Waiting(20, "Waits for transcripts"), now)).toEqual({ wait: { seconds: 20, line: "Waits for transcripts" } });
    expect(classify(Object.assign(new Error("limit"), { limited: { until: now + 60_000 } }), now)).toMatchObject({ limit: { seconds: 60 } });
    expect(classify(new NeedsKey("Add an AI key"), now)).toEqual({ needsKey: "Add an AI key" });
    expect(classify(new Error("boom"), now)).toEqual({ error: "boom" });
  });
});
