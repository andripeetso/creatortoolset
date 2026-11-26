import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "../auth";
import { ffmpegCommand } from "../ffmpeg-runtime";

vi.mock("../ai-complete", async (real) => {
  const m = await real<typeof import("../ai-complete")>();
  return { ...m, aiFor: vi.fn(() => ({ only: ["mac"] })) };
});
vi.mock("../ai-vision", () => ({ completeVisionWithFallback: vi.fn() }));
vi.mock("../work/offline", async (real) => {
  const m = await real<typeof import("../work/offline")>();
  return { ...m, mayRead: vi.fn(m.mayRead) };
});

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-shots-"));
process.env.DATA_DIR = dir;
process.env.LIBRARY_SCRATCH_DIR = path.join(dir, "scratch");
delete process.env.APP_SECRET; // the solo install: "local" is the admin
delete process.env.ANTHROPIC_API_KEY;
const { blobs, libraryDb } = await import("./db");
const { enqueueJob } = await import("./jobs");
const { tick } = await import("./worker");
const { searchApp, searchLibrary } = await import("./search");
const { stretchesOf, setUserLine } = await import("./stretches");
const { mayRead } = await import("../work/offline");
const { BUDGET_WAITS, budgetPause, LOOK_LABEL, lookBudgetWaits, lookable, lookFromSheets, lookSpent, lookStamp, MAC_WAITS, NO_ACCESS, queueLook, redoLook, releaseBudget, sheetHashes, sweepLook } = await import("./shots");
const { DESCRIBE_LABEL, libraryWorkspaceId } = await import("./describe");
const { askedWatch, watchAfter } = await import("./timeline");
const { saveMyKey } = await import("../my-keys");
const { storeStretches } = await import("./stretches");
const { lookPrompt, RULE, samePicture, stretchSheet } = await import("./look");
const { describePrompt } = await import("./describe");
const { estimate, progress } = await import("./estimate");
const { footageProfile } = await import("../lib/workshop/context");
const { completeVisionWithFallback } = await import("../ai-vision");
const { MacClaudeError, recordUsage } = await import("../lib/mac-claude");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: c.req.header("x-user") ?? "", role: "user" } as never);
  return next();
});
app.route("/api/library", searchApp);
const call = (user: string, url: string, method = "GET", body?: unknown) =>
  app.request(url, { method, headers: { "x-user": user, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

// made here, nothing large committed: three shots (cuts at 7 s and 13 s), and one 20-second take with no cut
const cuts = path.join(dir, "cuts.mp4");
const take = path.join(dir, "take.mp4");
const ff = (...args: string[]) => execFileSync(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-y", ...args]);
beforeAll(() => {
  ff(
    ...["-f", "lavfi", "-i", "testsrc=duration=7:size=160x90:rate=10", "-f", "lavfi", "-i", "smptebars=duration=6:size=160x90:rate=10"],
    ...["-f", "lavfi", "-i", "mandelbrot=size=160x90:rate=10", "-filter_complex", "[2:v]trim=duration=7,setpts=PTS-STARTPTS[m];[0:v][1:v][m]concat=n=3:v=1"],
    ...["-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "10", cuts],
  );
  ff("-f", "lavfi", "-i", "testsrc2=duration=20:size=160x90:rate=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", take);
  libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_s', 'local', 'S', 'local', 0)").run();
});

/** A ready video whose source is `from`: B-roll, `duration` long, described by the AI unless `described` is false. */
async function seed(id: string, o: { from?: string; duration?: number; roll?: "a" | "b"; described?: boolean; macPath?: string } = {}) {
  const d = libraryDb();
  const v = `ver-${id}`;
  const key = o.macPath ? `mac:${v}` : `libraries/lib_s/v/${v}/source`;
  if (!o.macPath) {
    const file = path.join(dir, `src-${id}`);
    copyFileSync(o.from ?? cuts, file);
    await blobs.put(key, file);
  }
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at, roll) VALUES (?, 'lib_s', 'video', ?, ?, 'local', 1, ?)").run(
    id,
    `Clip ${id}`,
    v,
    o.roll ?? "b",
  );
  d.prepare(
    `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at, mac_path)
     VALUES (?, ?, 1, ?, 1, ?, ?, 'ready', 'local', 1, ?)`,
  ).run(v, id, key, `sha-${id}`, JSON.stringify({ duration: o.duration ?? 20, vcodec: "h264", width: 160, height: 90, fps: 10, rotation: 0 }), o.macPath ?? null);
  if (o.described !== false) d.prepare("INSERT INTO descriptions (version_id, source, text, provider, created_at, roll) VALUES (?, 'ai', 'Colour bars.', 'test', 1, ?)").run(v, o.roll ?? "b");
  return v;
}

const job = (v: string, kind = "look") =>
  libraryDb().prepare("SELECT state, error, attempts, run_after FROM jobs WHERE version_id = ? AND kind = ?").get(v, kind) as
    | { state: string; error: string | null; attempts: number; run_after: number }
    | undefined;

/** The AI's answer: a line for every numbered tile in the prompt (or the first `only` of them), "shot <n>" with action n % 6. */
function answerAll(words = (n: number) => `shot ${n} on the bars`, only?: number) {
  return async (_s: string, user: string, images: unknown[], _sig: unknown, parse: (t: string) => unknown) => {
    const tiles = [...user.matchAll(/(\d+) \(\d+:\d\d–\d+:\d\d\)/g)].map((m) => Number(m[1])).slice(0, only);
    const shots = tiles.map((n) => ({ n, text: words(n), action: n % 6, clear: n % 2 === 1, tags: ["Bars", "bars", "colour", "test", "extra"] }));
    expect(images.length).toBeGreaterThan(0);
    return { value: parse(JSON.stringify({ shots })), provider: "test" } as never;
  };
}

const runLooks = async () => {
  while (await tick(Date.now(), ["look"]));
};

beforeEach(() => {
  vi.mocked(completeVisionWithFallback).mockReset();
});
// every look here is real work on real video (ffmpeg cuts the sheets, the picture hashes are read off them): ~1 s a look
// alone, several under a loaded full run, and a test runs up to two. The default 5 s timed out on load alone
vi.setConfig({ testTimeout: 20_000 });

describe("the look job", () => {
  it("writes one row per stretch from the AI's answer, with the context stamp, and keeps the sheets", async () => {
    const v = await seed("ast-look-01");
    vi.mocked(completeVisionWithFallback).mockImplementation(answerAll());
    enqueueJob(libraryDb(), "lib_s", v, "look", "local");
    await runLooks();
    expect(job(v)?.state).toBe("done");
    const rows = stretchesOf(libraryDb(), v);
    expect(rows.map((r) => Math.round(r.a))).toEqual([0, 7, 13]);
    expect(rows.map((r) => r.text)).toEqual(["shot 1 on the bars", "shot 2 on the bars", "shot 3 on the bars"]);
    expect(rows[1]).toMatchObject({ action: 2, clear: false, tags: ["bars", "colour", "test"], source: "ai" });
    expect(rows.every((r) => /^[0-9a-f]{16}$/.test(r.stamp) && /^[0-9a-f]{16}$/.test(r.ph))).toBe(true);
    expect(samePicture(rows[0]!.ph, rows[1]!.ph)).toBe(false); // the bars are not the test card
    const [, , , opts] = vi.mocked(completeVisionWithFallback).mock.calls[0]!.slice(3) as unknown[];
    expect(opts).toMatchObject({ label: LOOK_LABEL });
    expect(libraryDb().prepare("SELECT kind FROM derivatives WHERE version_id = ? AND kind = 'looksheets'").get(v)).toBeDefined();
    // nothing changed in the context: writing again asks nothing
    expect(await redoLook(libraryDb(), v, "local")).toBe(0);
    // the AI Editor's gate compares with the same stamp, and asks a done look again as a job: nothing stale, no call
    expect(rows[0]!.stamp).toBe(await lookStamp(libraryDb(), v));
    expect(queueLook(libraryDb(), v, "local", true)).toBe(true);
    expect(job(v)?.state).toBe("queued");
    await runLooks();
    expect(job(v)?.state).toBe("done");
    expect(completeVisionWithFallback).toHaveBeenCalledTimes(1);
  });

  it("reads the file the description reads: the proxy when there is one", async () => {
    // the original is one long take; the proxy has the three shots
    const v = await seed("ast-look-02", { from: take });
    const key = `libraries/lib_s/v/${v}/proxy.mp4`;
    await blobs.put(key, (copyFileSync(cuts, path.join(dir, "proxy-02.mp4")), path.join(dir, "proxy-02.mp4")));
    libraryDb().prepare("INSERT INTO derivatives (version_id, kind, storage_key, bytes) VALUES (?, 'proxy', ?, 1)").run(v, key);
    vi.mocked(completeVisionWithFallback).mockImplementation(answerAll());
    enqueueJob(libraryDb(), "lib_s", v, "look", "local");
    await runLooks();
    expect(stretchesOf(libraryDb(), v).map((r) => Math.round(r.a))).toEqual([0, 7, 13]);
  });

  it("a call that leaves stretches without a line is asked once more for those only; still missing waits for the next run", async () => {
    const v = await seed("ast-look-06");
    vi.mocked(completeVisionWithFallback).mockImplementationOnce(answerAll(undefined, 1)).mockImplementationOnce(answerAll(undefined, 1));
    enqueueJob(libraryDb(), "lib_s", v, "look", "local");
    await runLooks();
    const calls = vi.mocked(completeVisionWithFallback).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]![1]).toMatch(/Answer only for shots 2, 3\.\n\nAnswer as/);
    // the second ask answered its first tile, the test card again: only the asked-for ones are kept
    expect(stretchesOf(libraryDb(), v).map((r) => r.text)).toEqual(["shot 1 on the bars", "", ""]);
    // the next run asks for the one sheet again
    vi.mocked(completeVisionWithFallback).mockImplementation(answerAll());
    expect(await redoLook(libraryDb(), v, "local")).toBe(1);
    expect(stretchesOf(libraryDb(), v).every((r) => r.text)).toBe(true);
  });

  it("parks on a usage limit with the try not counted, holds the account's other looks, and resumes from the kept sheets", async () => {
    const v = await seed("ast-look-03");
    const other = await seed("ast-look-04");
    vi.mocked(completeVisionWithFallback).mockRejectedValueOnce(new MacClaudeError("Your usage limit is reached, it resets at 5pm", "limit"));
    enqueueJob(libraryDb(), "lib_s", v, "look", "local");
    enqueueJob(libraryDb(), "lib_s", other, "look", "local");
    const before = Date.now();
    await tick(Date.now(), ["look"]);
    const held = job(v)!;
    expect(held).toMatchObject({ state: "queued", attempts: 0 });
    expect(held.run_after).toBeGreaterThan(before + 14 * 60_000);
    expect(job(other)).toMatchObject({ state: "queued", error: expect.stringMatching(/limit is reached/) });
    expect((await progress("lib_s", "local")).waiting).toContainEqual(expect.objectContaining({ step: "look", limit: true, count: 2 }));
    // the reset: the look picks up from its kept sheets, without the video
    await blobs.delete(`libraries/lib_s/v/${v}/source`);
    libraryDb().prepare("UPDATE jobs SET run_after = 0 WHERE kind = 'look'").run();
    vi.mocked(completeVisionWithFallback).mockImplementation(answerAll());
    await runLooks();
    expect(job(v)?.state).toBe("done");
    expect(stretchesOf(libraryDb(), v).map((r) => r.text)).toHaveLength(3);
    expect(job(other)).toMatchObject({ state: "done", error: null });
  });

  it("a limit that says when it opens holds the account's looks until then; one that gets through sooner lets the rest go at once", async () => {
    const v = await seed("ast-limit-01");
    const other = await seed("ast-limit-02");
    const until = Date.now() + 2 * 24 * 3600_000;
    vi.mocked(completeVisionWithFallback).mockRejectedValueOnce(Object.assign(new MacClaudeError("Your Claude plan's weekly limit is reached; it resets Nov 18, 5pm", "limit"), { limited: { until } }));
    enqueueJob(libraryDb(), "lib_s", v, "look", "local");
    enqueueJob(libraryDb(), "lib_s", other, "look", "local");
    await tick(Date.now(), ["look"]);
    // held for the two days, not asked again every 15 minutes
    expect(job(v)!.run_after).toBeGreaterThan(until - 60_000);
    expect(job(other)!.run_after).toBeGreaterThan(until - 60_000);
    // the plan answers again before that (a new clip's look gets through): the held ones are work again now
    vi.mocked(completeVisionWithFallback).mockImplementation(answerAll());
    const fresh = await seed("ast-limit-03");
    enqueueJob(libraryDb(), "lib_s", fresh, "look", "local");
    await tick(Date.now(), ["look"]);
    expect(job(fresh)?.state).toBe("done");
    expect(job(v)).toMatchObject({ state: "queued", run_after: 0, error: null });
    expect(job(other)).toMatchObject({ state: "queued", run_after: 0, error: null });
    await runLooks();
    expect([job(v)?.state, job(other)?.state]).toEqual(["done", "done"]);
  });

  it("a file kept on a Mac waits for that Mac, never fails, and the progress line says so", async () => {
    const v = await seed("ast-look-05", { macPath: "/Volumes/Card/clip.mov" });
    enqueueJob(libraryDb(), "lib_s", v, "look", "local");
    await runLooks();
    expect(job(v)).toMatchObject({ state: "needs_key", error: MAC_WAITS });
    expect((await progress("lib_s", "local")).waiting).toContainEqual(expect.objectContaining({ step: "look", count: 1, computer: true }));
    expect(completeVisionWithFallback).not.toHaveBeenCalled();
  });
});

describe("which clips get a look", () => {
  it("B-roll over 8 s does; a talking take, a short clip and one the AI called a talking take don't", async () => {
    const d = libraryDb();
    expect(queueLook(d, await seed("ast-q-01", { described: false }), "local")).toBe(true);
    expect(queueLook(d, await seed("ast-q-02", { roll: "a" }), "local")).toBe(false);
    expect(queueLook(d, await seed("ast-q-03", { duration: 8 }), "local")).toBe(false);
    const ai = await seed("ast-q-04", { described: false });
    d.prepare("INSERT INTO descriptions (version_id, source, text, provider, created_at, roll) VALUES (?, 'ai', 'Someone talks.', 'test', 1, 'a')").run(ai);
    expect(queueLook(d, ai, "local")).toBe(false);
    d.prepare(`UPDATE libraries SET settings = json_set(settings, '$.look', json('false')) WHERE id = 'lib_s'`).run();
    expect(queueLook(d, await seed("ast-q-05", { described: false }), "local")).toBe(false);
    d.prepare(`UPDATE libraries SET settings = '{}' WHERE id = 'lib_s'`).run();
  });

  it("a clip described for the first time gets one; a clip described before gets none when it is described again", async () => {
    const answer = async (_s: string, _u: string, _i: unknown[], _c: unknown, parse: (t: string) => unknown) =>
      ({ value: parse('{"description": "Colour bars, then a fractal.", "tags": ["bars"], "roll": "b", "kind": "Test Pattern"}'), provider: "test" }) as never;
    vi.mocked(completeVisionWithFallback).mockImplementation(answer);
    const fresh = await seed("ast-d-01", { described: false });
    const old = await seed("ast-d-02");
    enqueueJob(libraryDb(), "lib_s", fresh, "describe", "local");
    enqueueJob(libraryDb(), "lib_s", old, "describe", "local", true);
    while (await tick(Date.now(), ["describe"]));
    expect(job(fresh, "describe")?.state).toBe("done");
    expect(job(fresh)?.state).toBe("queued");
    expect(job(old)).toBeUndefined(); // describing again queues none: the look lane's sweep gives it one (sweepLook)
    const row = libraryDb().prepare("SELECT kind, stamp FROM descriptions WHERE version_id = ? AND source = 'ai'").get(fresh) as { kind: string; stamp: string };
    expect(row.kind).toBe("test pattern");
    expect(row.stamp).toMatch(/^[0-9a-f]{16}$/);
    libraryDb().prepare("DELETE FROM jobs WHERE version_id = ?").run(fresh);
  });
});

describe("the background index", () => {
  /** Runs the sweep until it queues nothing more. */
  const sweepAll = async (now = Date.now()) => {
    let n = 0;
    while (await sweepLook(libraryDb(), now)) n++;
    return n;
  };

  it("a video with no look gets one; a talking take, one with a step still to run and one waiting for its Mac don't", async () => {
    const d = libraryDb();
    const missed = await seed("ast-sw-01");
    const talking = await seed("ast-sw-02", { roll: "a" });
    const busy = await seed("ast-sw-03");
    enqueueJob(d, "lib_s", busy, "describe", "local", true);
    const mac = await seed("ast-sw-04", { macPath: "/Volumes/Card/sw.mov" });
    enqueueJob(d, "lib_s", mac, "look", "local");
    await runLooks(); // the Mac's look parks, waiting for it
    vi.mocked(completeVisionWithFallback).mockReset();
    await sweepAll();
    expect(job(missed)).toMatchObject({ state: "queued" });
    expect(job(talking)).toBeUndefined();
    expect(job(busy)).toBeUndefined(); // its description queues its look itself
    expect(job(mac)).toMatchObject({ state: "needs_key", error: MAC_WAITS });
    expect(await sweepLook(d)).toBe(false); // nothing left: the lane idles
    // the earlier tests' clips the sweep queued too, and these: the next tests start from an empty queue. Marked done, not
    // deleted: a clip whose look is gone is the sweep's again, so every later sweep queued them all (12 real looks in the
    // access test, past the 5 s limit). The busy clip leaves the library; the Mac's parked look stays (the sweep skips it)
    d.prepare("UPDATE jobs SET state = 'done' WHERE kind = 'look' AND state = 'queued'").run();
    d.prepare("DELETE FROM jobs WHERE version_id = ?").run(busy);
    d.prepare("UPDATE assets SET trashed_at = 1 WHERE current_version_id = ?").run(busy);
  });

  it("a clip hidden while it waits on Folders left out (report.ts) gets no look", async () => {
    const d = libraryDb();
    const hid = await seed("ast-sw-hid");
    d.prepare("UPDATE assets SET left_hidden_at = 1 WHERE current_version_id = ?").run(hid);
    d.prepare("DELETE FROM jobs WHERE version_id = ? AND kind = 'look'").run(hid);
    await sweepAll();
    expect(job(hid)).toBeUndefined();
    d.prepare("UPDATE assets SET trashed_at = 1, left_hidden_at = NULL WHERE current_version_id = ?").run(hid);
  });

  it("an uploader who lost the clip between queue and run gets nothing read or asked; with access again, the sweep queues it and it runs", async () => {
    const d = libraryDb();
    const v = await seed("ast-acc-01");
    await sweepAll(); // queued: the uploader sees it
    expect(job(v)).toMatchObject({ state: "queued" });
    vi.mocked(completeVisionWithFallback).mockImplementation(answerAll());
    vi.mocked(mayRead).mockResolvedValue(false); // access taken away before the lane runs it
    await runLooks();
    expect(job(v)).toMatchObject({ state: "needs_key", error: NO_ACCESS });
    expect(completeVisionWithFallback).not.toHaveBeenCalled();
    expect(stretchesOf(d, v)).toEqual([]); // no picture read either
    const later = Date.now() + 11 * 60_000;
    expect(await sweepLook(d, later)).toBe(false); // still no access: the sweep leaves it
    vi.mocked(mayRead).mockImplementation((await vi.importActual<typeof import("../work/offline")>("../work/offline")).mayRead);
    await sweepAll(later + 11 * 60_000);
    expect(job(v)).toMatchObject({ state: "queued" });
    await runLooks();
    expect(job(v)?.state).toBe("done");
    expect(stretchesOf(d, v).every((r) => r.text)).toBe(true);
  });

  it("a spent monthly budget holds looks, saying so; raised, they run", async () => {
    const d = libraryDb();
    const v = await seed("ast-bud-01");
    vi.mocked(completeVisionWithFallback).mockImplementation(answerAll());
    await recordUsage(LOOK_LABEL, { tokens: 1000, costUsd: 21 }, undefined, "workspace", (await libraryWorkspaceId(d, "lib_s")) ?? null);
    enqueueJob(d, "lib_s", v, "look", "local");
    await tick(Date.now(), ["look"]);
    expect(job(v)).toMatchObject({ state: "queued", error: BUDGET_WAITS });
    expect(job(v)!.run_after).toBeGreaterThan(Date.now());
    expect(completeVisionWithFallback).not.toHaveBeenCalled();
    expect((await progress("lib_s", "local")).waiting).toContainEqual(expect.objectContaining({ step: "look", count: 1, missing: budgetPause(), limit: true }));
    expect((await estimate("lib_s", "local", { clips: 1, bytes: 1 })).lookSpent).toBeGreaterThanOrEqual(21);
    d.prepare(`UPDATE libraries SET settings = json_set(settings, '$.lookBudget', 50) WHERE id = 'lib_s'`).run();
    releaseBudget(d, "lib_s");
    await runLooks();
    expect(job(v)?.state).toBe("done");
    d.prepare(`UPDATE libraries SET settings = json_set(settings, '$.lookBudget', json('null')) WHERE id = 'lib_s'`).run();
  });

  it("a description counts in the monthly budget on its own label and the API's; an edit's own ask is not held", async () => {
    const d = libraryDb();
    const v = await seed("ast-bud-02");
    const ws = (await libraryWorkspaceId(d, "lib_s")) ?? null;
    const before = await lookSpent(ws ?? undefined);
    await recordUsage(DESCRIBE_LABEL, { tokens: 1000, costUsd: 1 }, undefined, "workspace", ws);
    await recordUsage(`${DESCRIBE_LABEL} (API)`, { tokens: 1000, costUsd: 2 }, undefined, "workspace", ws);
    expect((await lookSpent(ws ?? undefined)) - before).toBeCloseTo(3);
    d.prepare(`UPDATE libraries SET settings = json_set(settings, '$.lookBudget', 1) WHERE id = 'lib_s'`).run();
    expect(await lookBudgetWaits(d, v)).toBe(BUDGET_WAITS);
    expect(await lookBudgetWaits(d, v, [v])).toBeNull();
    d.prepare(`UPDATE libraries SET settings = json_set(settings, '$.lookBudget', json('null')) WHERE id = 'lib_s'`).run();
  });

  it("a held description waits for the budget, and is released with the looks", async () => {
    const d = libraryDb();
    const v = await seed("ast-bud-03", { described: false }); // one described already would read done (jobs.ts HAVE)
    await recordUsage(DESCRIBE_LABEL, { tokens: 1000, costUsd: 5 }, undefined, "workspace", (await libraryWorkspaceId(d, "lib_s")) ?? null);
    d.prepare(`UPDATE libraries SET settings = json_set(settings, '$.lookBudget', 1) WHERE id = 'lib_s'`).run();
    enqueueJob(d, "lib_s", v, "describe", "local");
    await tick(Date.now(), ["describe"]);
    expect(job(v, "describe")).toMatchObject({ state: "queued", error: BUDGET_WAITS });
    d.prepare(`UPDATE libraries SET settings = json_set(settings, '$.lookBudget', json('null')) WHERE id = 'lib_s'`).run();
    releaseBudget(d, "lib_s");
    expect(job(v, "describe")?.error).toBeNull();
  });

  it("a computer's stills are held by a spent budget too: describeFromStills throws before any AI call", async () => {
    const { describeFromStills } = await import("./worker");
    const { BudgetSpent } = await import("./shots");
    const d = libraryDb();
    const v = await seed("ast-bud-04");
    await recordUsage(DESCRIBE_LABEL, { tokens: 1000, costUsd: 5 }, undefined, "workspace", (await libraryWorkspaceId(d, "lib_s")) ?? null);
    d.prepare(`UPDATE libraries SET settings = json_set(settings, '$.lookBudget', 1) WHERE id = 'lib_s'`).run();
    try {
      await expect(describeFromStills(d, "lib_s", v, "local", [])).rejects.toBeInstanceOf(BudgetSpent);
    } finally {
      d.prepare(`UPDATE libraries SET settings = json_set(settings, '$.lookBudget', json('null')) WHERE id = 'lib_s'`).run();
    }
  });

  it("a timeline watch is held by a spent budget: it does not read the file or ask Gemini", async () => {
    const d = libraryDb();
    const v = await seed("ast-watch-01");
    await recordUsage(LOOK_LABEL, { tokens: 1000, costUsd: 5 }, undefined, "workspace", (await libraryWorkspaceId(d, "lib_s")) ?? null);
    d.prepare(`UPDATE libraries SET settings = json_set(settings, '$.lookBudget', 1) WHERE id = 'lib_s'`).run();
    saveMyKey("local", "GEMINI_API_KEY", "test-gemini");
    const src = vi.fn(async () => cuts);
    askedWatch.add(v);
    await watchAfter(d, v, src, "local");
    expect(src).not.toHaveBeenCalled();
    askedWatch.delete(v);
    saveMyKey("local", "GEMINI_API_KEY", null);
    d.prepare(`UPDATE libraries SET settings = json_set(settings, '$.lookBudget', json('null')) WHERE id = 'lib_s'`).run();
  });

  it("a talking take gets a look only where the library's Max level reads them (lookTalking)", async () => {
    const d = libraryDb();
    const v = await seed("ast-talk-01", { roll: "a", duration: 30, described: false });
    expect(lookable(d, v)).toBeNull();
    try {
      d.prepare(`UPDATE libraries SET settings = json_set(settings, '$.lookTalking', json('true')) WHERE id = 'lib_s'`).run();
      expect(lookable(d, v)).toBe("lib_s");
    } finally {
      d.prepare(`UPDATE libraries SET settings = json_remove(settings, '$.lookTalking') WHERE id = 'lib_s'`).run();
    }
  });

  it("at Max a talking take the AI also calls one gets its look; below Max it still doesn't", async () => {
    const d = libraryDb();
    const v = await seed("ast-talk-02", { roll: "a", duration: 30 });
    expect(lookable(d, v)).toBeNull();
    try {
      d.prepare(`UPDATE libraries SET settings = json_set(settings, '$.lookTalking', json('true')) WHERE id = 'lib_s'`).run();
      expect(lookable(d, v)).toBe("lib_s");
    } finally {
      d.prepare(`UPDATE libraries SET settings = json_remove(settings, '$.lookTalking') WHERE id = 'lib_s'`).run();
    }
  });

  it("an edit's own ask gets its shot descriptions though the library's Shot descriptions switch is off", async () => {
    const d = libraryDb();
    const v = await seed("ast-off-01");
    d.prepare(`UPDATE libraries SET settings = json_set(settings, '$.look', json('false')) WHERE id = 'lib_s'`).run();
    expect(queueLook(d, v, "local")).toBe(false);
    expect(queueLook(d, v, "local", false, true)).toBe(true);
    // only the switch goes back: a '{}' here would bring back the default budget for the tests after this one
    d.prepare(`UPDATE libraries SET settings = json_remove(settings, '$.look') WHERE id = 'lib_s'`).run();
    // its look is only asked, never run here: left queued, the next test's runLooks ran it as well (a real look, ~1 s)
    d.prepare("UPDATE jobs SET state = 'done' WHERE version_id = ? AND kind = 'look'").run(v);
  });

  it("a file's calls run side by side, all three at once on an AI provider", async () => {
    const d = libraryDb();
    const v = await seed("ast-par-01", { macPath: "/Volumes/Card/par.mov", duration: 3600 });
    storeStretches(d, v, Array.from({ length: 200 }, (_, i) => ({ a: i * 18, b: i * 18 + 18, motion: 0.5 })));
    const sheets = Array.from({ length: 13 }, (_, k) => ({ segs: Array.from({ length: 16 }, (_, i) => k * 16 + i).filter((x) => x < 200), jpeg: "/9j/" }));
    let now = 0;
    let most = 0;
    const answer = answerAll();
    vi.mocked(completeVisionWithFallback).mockImplementation(async (...a) => {
      most = Math.max(most, ++now);
      await new Promise((r) => setTimeout(r, 20));
      now--;
      return answer(...(a as unknown as Parameters<typeof answer>));
    });
    expect(await lookFromSheets(d, v, "local", sheets)).toBe(3); // 13 sheets, 6 a call
    expect(most).toBe(3);
    expect(stretchesOf(d, v).every((s) => s.text)).toBe(true);
  });

  it("the level is part of the stamp, and a look at another level finds its stretches again", async () => {
    const d = libraryDb();
    const v = await seed("ast-lvl-01", { from: take });
    vi.mocked(completeVisionWithFallback).mockImplementation(answerAll());
    enqueueJob(d, "lib_s", v, "look", "local");
    await runLooks();
    const standard = stretchesOf(d, v);
    const stamp = await lookStamp(d, v);
    d.prepare(`UPDATE libraries SET settings = json_set(settings, '$.lookLevel', 'detailed') WHERE id = 'lib_s'`).run();
    expect(await lookStamp(d, v)).not.toBe(stamp);
    expect(queueLook(d, v, "local", true)).toBe(true);
    await runLooks();
    const detailed = stretchesOf(d, v);
    expect(detailed.length).toBeGreaterThan(standard.length);
    expect(detailed.every((s) => s.text && s.stamp === detailed[0]!.stamp && s.stamp !== stamp)).toBe(true);
    d.prepare(`UPDATE libraries SET settings = json_remove(settings, '$.lookLevel') WHERE id = 'lib_s'`).run();
    expect(await lookStamp(d, v)).toBe(stamp); // Standard keeps the stamp lines had before levels
  });
});

describe("the prompt", () => {
  it("carries the description's no-names rule word for word", () => {
    expect(describePrompt({ title: "x", frames: 4 }).system).toContain(RULE);
    expect(lookPrompt(["Picture 1"], false, "", true).system).toContain(RULE);
    // the measured rubric, word for word; nothing between 0 and 5 is defined
    expect(lookPrompt(["Picture 1"], false, "", true).system).toContain(
      "For each shot also give action from 0 to 5: 0 nothing changes (a menu, loading, standing), 5 a peak; clear: the main subject is easy to see; and up to three tags, free words.",
    );
    expect(lookPrompt(["Picture 1"], false, "Tiny Acrobatics", true).user).toMatch(/^The workspace the footage is for[\s\S]*Tiny Acrobatics\n\nPicture 1\n\nAnswer as \{"shots": \[\{"n": 1, /);
  });

  it("is the AI Editor's prompt, byte for byte, when not rated", () => {
    const p = lookPrompt(["Picture 1: its tiles are shots 1 (0:00–0:04)"], true, "Tiny Acrobatics");
    expect(p.system).toBe(
      "You look at contact sheets of footage for a video editor, so it can pick shots without watching them. For each numbered shot say in a few words what is seen: the subject, the action, the setting and the kind of shot (wide, close, screen, text). " +
        'A shot that shows no action, only a map, an inventory, a menu, character select, a loading screen, a chat window, a desktop, a dark or empty frame, or mostly a game\'s buttons and bars, begins with "junk:" and that kind ("junk: map", "junk: menu", "junk: loading", "junk: dark", "junk: ui"). ' +
        `${RULE} Answer with JSON only.`,
    );
    expect(p.user.split("\n\n").at(-1)).toBe(
      'Answer as {"shots": {"1": "a few words", "2": "…"}, "story": "what happens across all of the footage, in order, told from the pictures alone, in a few sentences"}',
    );
    expect(lookPrompt([], false).user).toBe('Answer as {"shots": {"1": "a few words", "2": "…"}}');
  });
});

describe("shot lines", () => {
  it("the person's own line wins on the clip and in search, and search opens the clip at the shot", async () => {
    const v = await seed("ast-line-01");
    vi.mocked(completeVisionWithFallback).mockImplementation(answerAll((n) => (n === 2 ? "a boss fight on the bridge" : `a quiet field ${n}`)));
    enqueueJob(libraryDb(), "lib_s", v, "look", "local");
    await runLooks();
    const hit = searchLibrary("lib_s", "boss").find((h) => h.asset.id === "ast-line-01");
    expect(hit).toMatchObject({ seconds: 7, snippet: "a boss fight on the bridge" });
    const r = await call("local", "/api/library/lib_s/assets/ast-line-01/shots/2", "PATCH", { text: "the dragon wakes" });
    expect(r.status).toBe(200);
    const shots = ((await r.json()) as { shots: { seg: number; text: string; source: string }[] }).shots;
    expect(shots[2]).toMatchObject({ text: "the dragon wakes", source: "user" });
    expect(stretchesOf(libraryDb(), v)[2]).toMatchObject({ text: "the dragon wakes", action: 3 }); // the AI's rating stays
    expect(searchLibrary("lib_s", "dragon").find((h) => h.asset.id === "ast-line-01")?.seconds).toBe(13);
    expect(setUserLine(libraryDb(), v, 2, "")).toBe(true);
    expect(stretchesOf(libraryDb(), v)[2]!.source).toBe("ai");
    expect((await call("stranger", "/api/library/lib_s/assets/ast-line-01/shots/2", "PATCH", { text: "x" })).status).toBe(404);
    expect((await call("local", "/api/library/lib_s/assets/ast-line-01/shots/99", "PATCH", { text: "x" })).status).toBe(404);
  });
});

describe("routes for other computers", () => {
  const signal = (n: number, cutAt: number) => {
    const step = Array.from({ length: n }, (_, i) => (i === cutAt ? 0.6 : 0.01));
    return { fps: 10, step, cut: step.map((x) => x * 4), lag: step.map(() => 0.02) };
  };

  it("picture: checked, then the stretches found from it are stored and answered", async () => {
    const v = await seed("ast-pic-01", { macPath: "/Volumes/Card/far.mov", duration: 12 });
    const url = `/api/library/lib_s/versions/${v}/picture`;
    expect((await call("local", url, "POST", { fps: 0, step: [], cut: [], lag: [] })).status).toBe(400);
    expect((await call("local", url, "POST", { ...signal(120, 50), lag: [1] })).status).toBe(400);
    expect((await call("stranger", url, "POST", signal(120, 50))).status).toBe(404);
    const r = await call("local", url, "POST", signal(120, 50));
    expect(r.status).toBe(200);
    const { stretches } = (await r.json()) as { stretches: { seg: number; a: number; b: number }[] };
    expect(stretches.map((s) => [s.seg, s.a, s.b])).toEqual([
      [0, 0, 5],
      [1, 5, 12],
    ]);
    expect(stretchesOf(libraryDb(), v).map((s) => s.text)).toEqual(["", ""]);
  });

  it("stretches: lines are checked and capped like the server's own, and only for stretches the version has", async () => {
    const v = "ver-ast-pic-01";
    const url = `/api/library/lib_s/versions/${v}/stretches`;
    expect((await call("local", url, "POST", { stamp: "no spaces allowed", lines: [] })).status).toBe(400);
    const long = "x".repeat(500);
    const r = await call("local", url, "POST", {
      stamp: "abc123",
      lines: [
        { seg: 0, text: "  a menu   screen ", action: 9, clear: true, tags: ["Menu", "ui", "start", "four"], ph: "00FF00FF00FF00FF" },
        { seg: 1, text: long, action: -2, clear: "yes", tags: "fight" },
        { seg: 7, text: "no such stretch", action: 1, clear: false, tags: [] },
        { seg: 1.5, text: "not a whole number" },
      ],
    });
    expect(await r.json()).toEqual({ saved: 2 });
    const [a, b] = stretchesOf(libraryDb(), v);
    expect(a).toMatchObject({ text: "a menu screen", action: 5, clear: true, tags: ["menu", "ui", "start"], ph: "00ff00ff00ff00ff", stamp: "abc123" });
    expect(b).toMatchObject({ action: 0, clear: false, tags: [] });
    expect(b!.text).toHaveLength(200);
  });
});

describe("footage profile", () => {
  it("says what a workspace holds by kind, and nothing for a workspace with no footage", async () => {
    mkdirSync(path.join(dir, "workshop", "projects"), { recursive: true });
    // the oldest workspace is the first brand: the libraries from before workspaces (this file's other clips) are its
    const ws = (id: string, createdAt: number) => ({ id, owner: "local", name: id, audience: "", voice: "", cta: "", notes: "", createdAt, updatedAt: 1 });
    for (const [id, at] of [["p-first", 1], ["p-game", 2], ["p-empty", 3]] as const) writeFileSync(path.join(dir, "workshop", "projects", `${id}.json`), JSON.stringify(ws(id, at)));
    const d = libraryDb();
    d.prepare(`INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_p', 'local', 'P', 'local', '{"projectId":"p-game"}', 0)`).run();
    const add = (id: string, kind: string, duration: number, what: string | null, roll: string | null, tag?: string) => {
      d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at, roll) VALUES (?, 'lib_p', ?, ?, ?, 'local', 1, ?)").run(id, kind, id, `v-${id}`, roll);
      d.prepare(`INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at) VALUES (?, ?, 1, 'k', 1, ?, ?, 'ready', 'local', 1)`).run(
        `v-${id}`,
        id,
        `s-${id}`,
        JSON.stringify({ duration }),
      );
      if (what) d.prepare("INSERT INTO descriptions (version_id, source, text, provider, created_at, kind) VALUES (?, 'ai', 'x', 't', 1, ?)").run(`v-${id}`, what);
      if (tag) d.prepare("INSERT INTO asset_tags (asset_id, tag, source) VALUES (?, ?, 'ai')").run(id, tag);
    };
    add("g1", "video", 3600, "gameplay", "b");
    add("g2", "video", 2460, "gameplay", "b");
    add("sr", "video", 90, "screen recording", "b");
    add("song", "audio", 200, null, null, "music");
    expect(await footageProfile("p-game")).toBe("Footage here: 2 gameplay recordings (1 h 41 min), 1 screen recording (2 min), 1 song, no talking takes.");
    add("talk", "video", 600, "talking head", "a");
    expect(await footageProfile("p-game")).toMatch(/, 1 talking take \(10 min\)\.$/);
    expect(await footageProfile("p-empty")).toBe("");
    expect(await footageProfile("p-first")).toMatch(/^Footage here: .*test pattern recording/);
    expect(await footageProfile("nope")).toBe("");
    // the chat's note for a turn in the workspace ends with it (assistant.ts workspaceNote); one with no footage, nothing
    const { workspaceNote } = await import("../assistant");
    expect(await workspaceNote("local", "p-game")).toMatch(/\n\nFootage here: 2 gameplay recordings \(1 h 41 min\).*\.$/);
    expect(await workspaceNote("local", "p-empty")).not.toMatch(/Footage here|Finished here/);
  });
});

describe("estimate", () => {
  it("counts shot descriptions for videos over 8 s, on the person's AI, and none for short clips", async () => {
    // a library with no footage of its own yet: its bytes read at the starting guess, 1.5 MB a second
    libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_new', 'local', 'N', 'local', 0)").run();
    const long = await estimate("lib_new", "local", { clips: 2, bytes: 2 * 600 * 1.5e6 });
    const look = long.steps.find((s) => s.step === "look")!;
    expect(look).toMatchObject({ route: "provider", measured: false });
    expect(look.seconds).toBeGreaterThan(0);
    expect(look.usd).toBeGreaterThan(0);
    const short = await estimate("lib_new", "local", { clips: 2, bytes: 2 * 5 * 1.5e6 });
    expect(short.steps.find((s) => s.step === "look")!.route).toBe("off");
  });
});

describe("sheets and picture hashes", () => {
  it("a sheet holds three frames a stretch, two across; the hash read off it shows the same picture as the same", async () => {
    const out = path.join(dir, "sheet.jpg");
    await stretchSheet(cuts, [{ a: 0, b: 7 }, { a: 7, b: 13 }, { a: 7.5, b: 12.5 }], 20, true, out);
    // width and height from the JPEG's frame header
    const jpeg = readFileSync(out);
    let i = 2;
    while (jpeg[i + 1] !== 0xc0 && jpeg[i + 1] !== 0xc2) i += 2 + jpeg.readUInt16BE(i + 2);
    expect([jpeg.readUInt16BE(i + 7), jpeg.readUInt16BE(i + 5)]).toEqual([2 * 3 * (256 + 8), 2 * (144 + 8)]);
    const [card, bars, barsAgain] = await sheetHashes(out, 3, true);
    expect(card).toMatch(/^[0-9a-f]{16}$/);
    expect(samePicture(bars!, barsAgain!)).toBe(true);
    expect(samePicture(card!, bars!)).toBe(false);
  });
});
