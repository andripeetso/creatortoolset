import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkPackage, WorkResult } from "../../contracts/work";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "work-computer-"));
process.env.DATA_DIR = dir;

const { classify, client, idleFor, reportLeftover, runJob, startComputerWorker, STOPPED_LINE } = await import("./computer");
const { claimLook } = await import("./look");
const { takeTurn } = await import("./turn");
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
      expect(calls).toContainEqual({ at: "lib fail 5", body: { error: "This computer needs a newer Creator Toolset", update: true } });
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

describe("the claim loop never spins, hangs or loops for good (G4)", () => {
  /** A server that answers every claim with `answer` and counts them, each with its time. */
  const answering = (answer: () => Response | Promise<Response>) => {
    const at: number[] = [];
    const fetch = async (u: string, i?: RequestInit) => {
      if (u.endsWith("/work/claim") || u.endsWith("/editor/claim")) {
        at.push(Date.now());
        return answer();
      }
      return fake.request(u, i);
    };
    return { at, fetch };
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const quiet = () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    return warn;
  };
  afterEach(() => vi.restoreAllMocks());

  it("PRD 23: a refused token logs once, backs off doubling, and stops 'refused' after refusedMs (exit 78)", async () => {
    const warn = quiet();
    const s = answering(() => json({ error: "Unauthorized" }, 401));
    const t0 = Date.now();
    expect(await startComputerWorker({ ...o, fetch: s.fetch, refusedWaitMs: 40, refusedMs: 300 })).toBe("refused");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
    // 40, 80, 160, then the rest of 300: a handful, never a spin
    expect(s.at.length).toBeLessThanOrEqual(6);
    const gaps = s.at.slice(1).map((t, i) => t - s.at[i]!);
    expect(gaps[1]!).toBeGreaterThan(gaps[0]! * 1.5);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("token was refused"))).toHaveLength(1);
    expect(warn.mock.calls[0]![0]).toBe("[work] this computer's token was refused: add it again in Settings → Computers");
  });

  it("PRD 23: a 401 then an answer within refusedMs keeps it running", async () => {
    quiet();
    let n = 0;
    const s = answering(() => (n++ < 2 ? json({ error: "Unauthorized" }, 401) : json({ pkg: null })));
    expect(await startComputerWorker({ ...o, fetch: s.fetch, refusedWaitMs: 20, refusedMs: 200, idleMs: 400 })).toBe("idle");
    expect(n).toBeGreaterThan(3);
  });

  it("PRD 23: the same through a look's claim", async () => {
    quiet();
    const s = answering(() => json({ error: "Unauthorized" }, 401));
    await expect(claimLook(client({ ...o, fetch: s.fetch }))).rejects.toThrow("token was refused");
    // a Linux library worker claims looks first: refused there too, it stops
    const was = { platform: process.platform, kinds: process.env.CT_WORKER_KINDS };
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env.CT_WORKER_KINDS = "library";
    process.env.CT_LIBRARY_SCRATCH_GB = "0";
    try {
      expect(await startComputerWorker({ ...o, fetch: s.fetch, refusedWaitMs: 20, refusedMs: 100 })).toBe("refused");
    } finally {
      Object.defineProperty(process, "platform", { value: was.platform });
      delete process.env.CT_WORKER_KINDS;
      delete process.env.CT_LIBRARY_SCRATCH_GB;
    }
  });

  it("PRD 24: a refused claim waits retryMs; a step's {error} is data; a 502 page is retried and never counts as refused", async () => {
    quiet();
    const refused = answering(() => json({ error: "v: a number, steps: a list of step ids" }, 400));
    await startComputerWorker({ ...o, fetch: refused.fetch, retryMs: 100, idleMs: 250 });
    expect(refused.at.length).toBeLessThanOrEqual(3);
    expect(await client(o).post("work/11/ai", {})).toEqual({ ok: true });
    const err = client({ ...o, fetch: async () => json({ error: "No key" }, 400) });
    expect(await err.post("work/11/ai", {})).toEqual({ error: "No key" });
    const page = answering(() => new Response("<html>Bad gateway</html>", { status: 502 }));
    expect(await startComputerWorker({ ...o, fetch: page.fetch, retryMs: 10, refusedMs: 20, idleMs: 200 })).toBe("idle");
    expect(page.at.length).toBeGreaterThan(5);
  });

  it("PRD 25: a claim never answered is aborted at claimTimeoutMs and asked again", async () => {
    quiet();
    const at: number[] = [];
    const fetch = (u: string, i?: RequestInit) => {
      if (!u.endsWith("/work/claim")) return Promise.resolve(fake.request(u, i));
      at.push(Date.now());
      return new Promise<Response>((_, reject) => i?.signal?.addEventListener("abort", () => reject(i.signal!.reason)));
    };
    await startComputerWorker({ ...o, fetch, claimTimeoutMs: 50, retryMs: 10, idleMs: 300 });
    expect(at.length).toBeGreaterThanOrEqual(2);
    expect(at[1]! - at[0]!).toBeLessThan(200);
  });

  it("PRD 26: idleFor is a day for a service and 10 min under the Mac; only under the Mac it says it is alive", async () => {
    expect(idleFor({})).toBe(24 * 3600_000);
    expect(idleFor({ CT_EXIT_WITH_PARENT: "1" })).toBe(10 * 60_000);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    claims = [];
    await startComputerWorker({ ...o, idleMs: 120, aliveMs: 20 });
    expect(log.mock.calls.some((c) => c[0] === "[work:alive]")).toBe(false);
    process.env.CT_EXIT_WITH_PARENT = "1";
    try {
      // a slow step whose line never changes still shows the loop moves
      STEPS.preview = () => new Promise((r) => setTimeout(r, 150));
      claims = [{ pkg: pkg("preview") }];
      await startComputerWorker({ ...o, idleMs: 50, aliveMs: 20 });
      expect(log.mock.calls.filter((c) => c[0] === "[work:alive]").length).toBeGreaterThanOrEqual(5);
    } finally {
      delete process.env.CT_EXIT_WITH_PARENT;
    }
  });

  it("PRD 26: short of disk, it posts one lowDisk claim per wait and takes nothing", async () => {
    quiet();
    process.env.CT_WORKER_KINDS = "library";
    process.env.CT_LIBRARY_SCRATCH_GB = "1000000";
    try {
      claimed = [];
      await startComputerWorker({ ...o, lowDiskMs: 40, idleMs: 150 });
      expect(claimed.length).toBeGreaterThanOrEqual(2);
      expect(claimed.length).toBeLessThanOrEqual(5);
      for (const b of claimed) expect(b).toEqual({ v: 1, steps: [], library: true, libraryOnly: true, lowDisk: true });
    } finally {
      delete process.env.CT_WORKER_KINDS;
      delete process.env.CT_LIBRARY_SCRATCH_GB;
    }
  });

  it("PRD 26: a newer library package is handed back with update: true", async () => {
    claims = [{ pkg: null, lib: { v: 99, job: { id: 6, kind: "proxy" } } }];
    expect(await startComputerWorker(o)).toBe("update");
    expect(calls).toContainEqual({ at: "lib fail 6", body: { error: "This computer needs a newer Creator Toolset", update: true } });
  });
});

describe("the Mac-wide turn (turn.ts, PRD 26)", () => {
  const turnDir = () => mkdtempSync(path.join(dir, "turn-"));

  it("without CT_TURN_DIR nothing waits", async () => {
    const give = await takeTurn({ dir: undefined });
    give();
  });

  it("never two at once; waiters take it in ticket order; an idle worker holds none", async () => {
    const d = turnDir();
    const alive = () => true;
    const a = await takeTurn({ dir: d, pid: 101, everyMs: 5, alive });
    let bGot = false;
    let cGot = false;
    const b = takeTurn({ dir: d, pid: 102, everyMs: 5, alive }).then((g) => ((bGot = true), g));
    await new Promise((r) => setTimeout(r, 5));
    const c = takeTurn({ dir: d, pid: 103, everyMs: 5, alive }).then((g) => ((cGot = true), g));
    await new Promise((r) => setTimeout(r, 50));
    expect([bGot, cGot]).toEqual([false, false]);
    a();
    const gb = await b;
    await new Promise((r) => setTimeout(r, 30));
    expect(cGot).toBe(false);
    gb();
    (await c)();
    // nobody waits or holds: nothing left in the folder
    expect(readdirSync(d)).toEqual([]);
  });

  it("an empty turn file a dead worker left (older than 5 s) is free", async () => {
    const d = turnDir();
    writeFileSync(path.join(d, "turn"), "");
    utimesSync(path.join(d, "turn"), new Date(Date.now() - 10_000), new Date(Date.now() - 10_000));
    (await takeTurn({ dir: d, pid: 104, everyMs: 5, alive: () => true }))();
    expect(readdirSync(d)).toEqual([]);
  });

  it("A and B alternate per job; a dead holder's turn and a dead waiter's ticket are taken", async () => {
    const d = turnDir();
    const ran: string[] = [];
    let busy = 0;
    const job = async (who: string, pid: number) => {
      const give = await takeTurn({ dir: d, pid, everyMs: 5, alive: () => true });
      busy++;
      expect(busy).toBe(1);
      ran.push(who);
      await new Promise((r) => setTimeout(r, 15));
      busy--;
      give();
    };
    const worker = async (who: string, pid: number) => {
      for (let i = 0; i < 3; i++) {
        await job(who, pid);
        await new Promise((r) => setTimeout(r, 1)); // the next claim
      }
    };
    await Promise.all([worker("A", 201), worker("B", 202)]);
    expect(ran.join("")).toMatch(/^(AB|BA){3}$/);

    const dead = new Set([301, 302]);
    writeFileSync(path.join(d, "turn"), "301");
    writeFileSync(path.join(d, "wait-1-302-0"), "");
    const give = await takeTurn({ dir: d, pid: 303, everyMs: 5, alive: (p) => !dead.has(p) });
    expect(readFileSync(path.join(d, "turn"), "utf8")).toBe("303");
    give();
  });

  it("a worker waiting for the turn keeps beating its held step, and runs it once the turn is free", async () => {
    const d = turnDir();
    process.env.CT_TURN_DIR = d;
    try {
      const other = await takeTurn({ pid: process.ppid, dir: d }); // another server's worker runs a job
      let ran = false;
      STEPS.preview = async () => void (ran = true);
      const run = runJob(pkg("preview"), o);
      await new Promise((r) => setTimeout(r, 120));
      expect(ran).toBe(false);
      const beats = calls.filter((c) => c.at === "beat 11");
      expect(beats.length).toBeGreaterThan(2);
      expect(beats[0]!.body).toMatchObject({ line: "Waiting for this Mac's other work" });
      other();
      expect(await run).toBe("done");
      expect(ran).toBe(true);
    } finally {
      delete process.env.CT_TURN_DIR;
    }
  }, 10_000);
});
