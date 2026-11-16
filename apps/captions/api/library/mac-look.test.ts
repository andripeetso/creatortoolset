// Shot descriptions of a file kept on a Mac (mac-look.ts) on the device routes: only the Mac the file is on takes its
// look, with its own token; the picture it sends gives the stretches; the sheets it sends are looked at once by the look
// lane and never kept; a usage limit gives the look back to that Mac, which sends its kept sheets again.
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceJob } from "../../contracts/devices";

vi.mock("../ai-complete", async (real) => {
  const m = await real<typeof import("../ai-complete")>();
  return { ...m, aiFor: vi.fn(() => ({ only: ["mac"] })) };
});
vi.mock("../ai-vision", () => ({ completeVisionWithFallback: vi.fn() }));

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-mac-look-"));
process.env.DATA_DIR = dir;
process.env.LIBRARY_SCRATCH_DIR = path.join(dir, "scratch");
delete process.env.APP_SECRET;
delete process.env.ANTHROPIC_API_KEY;

const app = (await import("../boot")).default;
const { pairDevice } = await import("../lib/devices");
const { libraryDb } = await import("./db");
const { enqueueJob } = await import("./jobs");
const { tick } = await import("./worker");
const { stretchesOf } = await import("./stretches");
const { MAC_WAITS, queueLook } = await import("./shots");
const { takeMacSheets } = await import("./mac-look");
const { aiFor } = await import("../ai-complete");
const { completeVisionWithFallback } = await import("../ai-vision");
const { MacClaudeError } = await import("../lib/mac-claude");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const mac = pairDevice("local", "Tiny's Mac");
const second = pairDevice("local", "Tiny's laptop");
const stranger = pairDevice("bo", "Bo's Mac");
const post = (url: string, body: unknown, token = mac.token) =>
  app.request(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
const claim = async (token = mac.token) => ((await (await post("/api/devices/relay/editor/claim", { kinds: ["library-look"] }, token)).json()) as { job: DeviceJob | null }).job;
const road = (id: number) => `/api/devices/relay/job/library-look/${id}`;

const job = (v: string) =>
  libraryDb().prepare("SELECT id, state, error, attempts, run_after FROM jobs WHERE version_id = ? AND kind = 'look'").get(v) as { id: number; state: string; error: string | null; attempts: number; run_after: number };
const runLooks = async () => {
  while (await tick(Date.now(), ["look"]));
};

beforeAll(() => {
  libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_m', 'local', 'M', 'local', 0)").run();
});

/** A B-roll video indexed where it is on `device`, added by `by`, described, its look parked for that Mac. */
async function seed(id: string, device = mac.device.id, by = "local") {
  const d = libraryDb();
  const v = `ver-${id}`;
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at, roll) VALUES (?, 'lib_m', 'video', ?, ?, ?, 1, 'b')").run(id, `Clip ${id}`, v, by);
  d.prepare(
    `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at, mac_path, mac_device)
     VALUES (?, ?, 1, ?, 1, ?, ?, 'ready', ?, 1, ?, ?)`,
  ).run(v, id, `mac:${v}`, `mac:${id}`, JSON.stringify({ duration: 12, vcodec: "mac", width: 160, height: 90, fps: 0, rotation: 0 }), by, `/Users/tiny/${id}.mov`, device);
  d.prepare("INSERT INTO descriptions (version_id, source, text, provider, created_at, roll) VALUES (?, 'ai', 'Colour bars.', 'test', 1, 'b')").run(v);
  enqueueJob(d, "lib_m", v, "look", "local");
  await runLooks();
  return v;
}

/** 120 frames at 10 a second, one cut at frame 50: stretches 0–5 s and 5–12 s. */
const signal = { fps: 10, step: Array.from({ length: 120 }, (_, i) => (i === 50 ? 0.6 : 0.01)), cut: Array.from({ length: 120 }, (_, i) => (i === 50 ? 2.4 : 0.04)), lag: Array(120).fill(0.02) };
/** A sheet as the Mac sends it: a few JPEG bytes (the AI is a stand-in here) and a hash a stretch. */
const sheet = (segs: number[]) => ({ segs, jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64"), ph: segs.map((s) => `${s}`.repeat(16).slice(0, 16)) });

/** The AI's answer: a line for every numbered tile in the prompt. */
const answerAll = async (_s: string, user: string, images: unknown[], _sig: unknown, parse: (t: string) => unknown) => {
  const tiles = [...user.matchAll(/(\d+) \(\d+:\d\d–\d+:\d\d\)/g)].map((m) => Number(m[1]));
  expect(images.length && images.every((i) => (i as { jpegBase64: string }).jpegBase64 === sheet([0]).jpeg)).toBeTruthy();
  return { value: parse(JSON.stringify({ shots: tiles.map((n) => ({ n, text: `shot ${n}`, action: 3, clear: true, tags: ["bars"] })) })), provider: "test" } as never;
};

/** Every file under `root`, relative. */
const files = (root: string): string[] =>
  readdirSync(root, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(root, e.name)).map((f) => `${e.name}/${f}`) : [e.name]));

beforeEach(() => {
  vi.mocked(completeVisionWithFallback).mockReset();
});

describe("a look of a file kept on a Mac", () => {
  it("waits for the Mac the file is on, and only that Mac of the account that added it takes it", async () => {
    const v = await seed("ast-m-01");
    expect(job(v)).toMatchObject({ state: "needs_key", error: MAC_WAITS });
    expect(await claim(stranger.token)).toBeNull();
    expect(await claim(second.token)).toBeNull();
    const elsewhere = await seed("ast-m-02", second.device.id, "bo"); // on the laptop, added by someone else
    expect(await claim(second.token)).toBeNull();
    const got = (await claim())!;
    expect(got).toMatchObject({ id: job(v).id, kind: "library-look", options: { path: "/Users/tiny/ast-m-01.mov", version: v, duration: "12", format: "3x16", stretches: "[]" } });
    expect(job(v).state).toBe("running");
    // one at a time: a second look of this Mac's waits for the first
    const later = await seed("ast-m-03");
    expect(await claim()).toBeNull();
    // the road is its own: another device's token, or none, gets nothing
    expect((await post(road(got.id), { beat: true }, second.token)).status).toBe(404);
    expect((await app.request(road(got.id), { method: "POST", body: "{}" })).status).toBe(401);
    expect((await post(road(got.id), { beat: true })).status).toBe(200);
    // the Mac couldn't read it: a try, with its words
    expect(await (await post(`${road(got.id)}/fail`, { error: "The file is not on this Mac at /Users/tiny/ast-m-01.mov." })).json()).toMatchObject({ ok: true });
    expect(job(v)).toMatchObject({ state: "queued", attempts: 1, error: "The file is not on this Mac at /Users/tiny/ast-m-01.mov." });
    expect((await claim())!.options!.version).toBe(later);
    libraryDb().prepare("DELETE FROM jobs WHERE version_id IN (?, ?, ?)").run(v, elsewhere, later);
  });

  it("finds the stretches from the picture, looks at the sheets once, stores the lines and keeps nothing of them", async () => {
    const v = await seed("ast-m-10");
    const got = (await claim())!;
    expect((await post(road(got.id), { signal: { ...signal, lag: [1] } })).status).toBe(400);
    const found = (await (await post(road(got.id), { signal })).json()) as { stretches: { seg: number; a: number; b: number }[] };
    expect(found.stretches).toEqual([
      { seg: 0, a: 0, b: 5 },
      { seg: 1, a: 5, b: 12 },
    ]);
    expect((await post(road(got.id), { sheet: { segs: [0, 1], jpeg: "bm90IGEganBlZw==" } })).status).toBe(400);
    // not every stretch is on a sheet yet
    expect((await post(road(got.id), { sheet: sheet([0]) })).status).toBe(200);
    expect((await post(road(got.id), { done: true, format: "3x16" })).status).toBe(409);
    expect((await post(road(got.id), { sheet: sheet([1]) })).status).toBe(200);
    expect((await post(road(got.id), { done: true, format: "2x9" })).status).toBe(409);
    expect(await (await post(road(got.id), { done: true, format: "3x16" })).json()).toMatchObject({ ok: true });
    // the Mac's part is over; the look lane asks the AI from what it sent
    expect(job(v).state).toBe("queued");
    expect((await post(road(got.id), { beat: true })).status).toBe(404);
    vi.mocked(completeVisionWithFallback).mockImplementation(answerAll as never);
    await runLooks();
    expect(job(v)).toMatchObject({ state: "done", error: null });
    expect(completeVisionWithFallback).toHaveBeenCalledTimes(1);
    expect(stretchesOf(libraryDb(), v)).toMatchObject([
      { seg: 0, text: "shot 1", action: 3, ph: "0000000000000000" },
      { seg: 1, text: "shot 2", ph: "1111111111111111" },
    ]);
    // nothing of the sheets stays: no kept sheets, nothing in memory, no file
    expect(libraryDb().prepare("SELECT kind FROM derivatives WHERE version_id = ?").all(v)).toEqual([]);
    expect(takeMacSheets(v)).toBeNull();
    expect(files(dir).filter((f) => /\.(jpe?g|png)$|looksheets/.test(f))).toEqual([]);
  });

  it("a usage limit gives the look back to the Mac, which sends its sheets again; a new context asks it again, the same way", async () => {
    const v = await seed("ast-m-20");
    let got = (await claim())!;
    await post(road(got.id), { signal });
    await post(road(got.id), { sheet: sheet([0, 1]) });
    await post(road(got.id), { done: true, format: "3x16" });
    vi.mocked(completeVisionWithFallback).mockRejectedValueOnce(new MacClaudeError("Your usage limit is reached, it resets at 5pm", "limit"));
    const before = Date.now();
    await runLooks();
    expect(job(v)).toMatchObject({ state: "queued", error: expect.stringMatching(/limit is reached/) });
    expect(job(v).run_after).toBeGreaterThan(before + 14 * 60_000);
    expect(takeMacSheets(v)).toBeNull(); // dropped: they come again from the Mac
    expect(await claim()).toBeNull(); // held until the reset
    // the reset: the lane finds no sheets and waits for the Mac, which now gets the stretches the server has
    libraryDb().prepare("UPDATE jobs SET run_after = 0 WHERE id = ?").run(job(v).id);
    await runLooks();
    expect(job(v)).toMatchObject({ state: "needs_key", error: MAC_WAITS });
    got = (await claim())!;
    expect(JSON.parse(got.options!.stretches!)).toEqual([
      [0, 5],
      [5, 12],
    ]);
    await post(road(got.id), { sheet: sheet([0, 1]) });
    await post(road(got.id), { done: true, format: "3x16" });
    vi.mocked(completeVisionWithFallback).mockImplementation(answerAll as never);
    await runLooks();
    expect(job(v).state).toBe("done");
    expect(stretchesOf(libraryDb(), v).map((s) => s.text)).toEqual(["shot 1", "shot 2"]);
    // the AI Editor's gate asks again (the lines are current): the Mac sends its sheets, and no line is written again
    expect(queueLook(libraryDb(), v, "local", true)).toBe(true);
    await runLooks();
    got = (await claim())!;
    await post(road(got.id), { sheet: sheet([0, 1]) });
    await post(road(got.id), { done: true, format: "3x16" });
    await runLooks();
    expect(job(v).state).toBe("done");
    expect(completeVisionWithFallback).toHaveBeenCalledTimes(2); // the one the limit stopped, and the one that wrote the lines
  });

  it("an account with no AI connected waits for that, and the Mac reads nothing", async () => {
    vi.mocked(aiFor).mockReturnValueOnce({ off: "Connect an AI" } as never);
    const v = await seed("ast-m-30");
    expect(job(v)).toMatchObject({ state: "needs_key", error: "Connect an AI" });
    expect(await claim()).toBeNull();
  });
});
