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
const { LOOK_BYTES_MAX, macLookJob, takeMacSheets, TOO_BIG } = await import("./mac-look");
const { deviceOf } = await import("../lib/devices");
const { emptyKept, keptView } = await import("../kept");
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
    const cutsBy = () => (libraryDb().prepare("SELECT cuts_by FROM asset_versions WHERE id = ?").get(v) as { cuts_by: string | null }).cuts_by;
    expect(cutsBy()).toBeNull();
    // a Mac that ran the cut model sends each frame's odds: the cuts are found from them (it marks 6.9 s: a cut at 7 s,
    // none where the picture jumps at 5 s), and the version keeps that the model found them
    expect((await post(road(got.id), { signal: { ...signal, one: Array(120).fill(2), many: Array(120).fill(0) } })).status).toBe(400);
    const odds = { one: Array.from({ length: 120 }, (_, i) => (i === 69 ? 0.95 : 0.01)), many: Array(120).fill(0.01) };
    expect(((await (await post(road(got.id), { signal: { ...signal, ...odds } })).json()) as typeof found).stretches).toEqual([
      { seg: 0, a: 0, b: 7 },
      { seg: 1, a: 7, b: 12 },
    ]);
    expect(cutsBy()).toBe("transnetv2");
    await post(road(got.id), { signal });
    expect(cutsBy()).toBeNull();
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

  it("with a Gemini key the claim asks for a copy to watch; the copy goes to Gemini and is deleted, and a Mac that sends none is named", async () => {
    const { saveMyKey } = await import("../my-keys");
    const { timelineOf, watching, watchTiming } = await import("./timeline");
    const longPost = watchTiming.post;
    watchTiming.post = (url, headers, body) => fetch(url, { method: "POST", headers, body });
    saveMyKey("local", "GEMINI_API_KEY", "gk-test");
    const asked: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        asked.push(`${init.method ?? "GET"} ${url}`);
        if (url.endsWith("/upload/v1beta/files")) return new Response("{}", { headers: { "x-goog-upload-url": "https://upload.test/m" } });
        if (url === "https://upload.test/m") return Response.json({ file: { name: "files/m", uri: "https://files.test/m", state: "ACTIVE" } });
        if (url.includes(":generateContent"))
          return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ events: [{ start: "0:03", end: "0:06", what: "a jump" }] }) }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });
        return new Response("{}");
      }),
    );
    vi.mocked(completeVisionWithFallback).mockImplementation(answerAll as never);
    try {
      for (const sends of [true, false]) {
        const v = await seed(`ast-m-w${sends ? 1 : 2}`);
        const got = (await claim())!;
        expect(got.options).toMatchObject({ watch: "1" });
        await post(road(got.id), { signal });
        await post(road(got.id), { sheet: sheet([0, 1]) });
        if (sends) {
          const r = await app.request(`${road(got.id)}/file?name=watch.mp4`, { method: "POST", headers: { authorization: `Bearer ${mac.token}`, "content-type": "video/mp4" }, body: Buffer.from("tiny video") });
          expect(r.status).toBe(200);
        }
        await post(road(got.id), { done: true, format: "3x16" });
        await runLooks();
        await Promise.all([...watching.values()]); // the watch runs beside the look lane; its copy goes right after
        await new Promise((go) => setTimeout(go, 20));
        expect(job(v).state).toBe("done");
        if (sends) {
          expect(timelineOf(libraryDb(), v)).toEqual([{ a: 3, b: 6, what: "a jump" }]);
          expect(asked.some((a) => a.startsWith("DELETE"))).toBe(true);
          expect(files(dir).filter((f) => f.includes("watch-"))).toEqual([]);
        } else {
          expect((libraryDb().prepare("SELECT error FROM timelines WHERE version_id = ?").get(v) as { error: string }).error).toContain("needs an update");
        }
      }
    } finally {
      watchTiming.post = longPost;
      saveMyKey("local", "GEMINI_API_KEY", null);
      vi.unstubAllGlobals();
    }
  });

  it("an account with no AI connected waits for that, and the Mac reads nothing", async () => {
    vi.mocked(aiFor).mockReturnValueOnce({ off: "Connect an AI" } as never);
    const v = await seed("ast-m-30");
    expect(job(v)).toMatchObject({ state: "needs_key", error: "Connect an AI" });
    expect(await claim()).toBeNull();
  });
});

describe("what one look may send", () => {
  it("past 100 MB of sheets the look is refused with why, fails for good and is not offered again", async () => {
    const v = await seed("ast-m-40");
    const got = (await claim())!;
    await post(road(got.id), { signal });
    // the biggest sheet there may be, sent as many times as fit (the same string: the test holds one copy)
    const big = Buffer.alloc(4 * 1024 * 1024, 7);
    big[0] = 0xff;
    big[1] = 0xd8;
    const jpeg = big.toString("base64");
    const fit = Math.floor(LOOK_BYTES_MAX / big.length);
    for (let i = 0; i < fit; i++) expect(await macLookJob.answer(mac.device.id, got.id, { sheet: { segs: [i % 2], jpeg } })).toEqual({ reply: {} });
    const over = await post(road(got.id), { sheet: { segs: [1], jpeg } });
    expect(over.status).toBe(413);
    expect(await over.json()).toEqual({ error: TOO_BIG });
    expect(job(v)).toMatchObject({ state: "failed", error: TOO_BIG });
    // nothing held: the Mac's next word on it is not its own any more, and no look waits for it
    expect((await post(road(got.id), { done: true, format: "3x16" })).status).toBe(404);
    expect(takeMacSheets(v)).toBeNull();
    expect(await claim()).toBeNull();
    await runLooks();
    expect(job(v).state).toBe("failed");
  });
});

describe("the sheets a Mac keeps", () => {
  /** A version on `device` with no look job, as a clip whose look is done. */
  const clip = async (id: string, device = mac.device.id) => {
    const v = await seed(id, device);
    libraryDb().prepare("DELETE FROM jobs WHERE version_id = ?").run(v);
    return v;
  };
  const claimWith = async (looks: unknown, token = mac.token) =>
    (await (await post("/api/devices/relay/editor/claim", { kinds: ["library-look"], ...(looks === undefined ? {} : { looks }) }, token)).json()) as { job: DeviceJob | null; looks?: { gone: string[]; clear?: true } };

  it("a claim lists them and is answered with the gone, trashed and no longer this Mac's; Storage counts the rest", async () => {
    const mine = await clip("ast-k-01");
    const trashed = await clip("ast-k-02");
    libraryDb().prepare("UPDATE assets SET trashed_at = 1 WHERE id = 'ast-k-02'").run();
    const laptops = await clip("ast-k-03", second.device.id);
    const answer = await claimWith({ [mine]: 1000, [trashed]: 300, [laptops]: 200, "ver-deleted": 500, "../x": 9 });
    expect(answer).toEqual({ job: null, looks: { gone: [trashed, laptops, "ver-deleted"] } });
    expect(deviceOf(mac.device.id)!.looks).toEqual({ bytes: 1000, items: 1 });
    expect((await keptView({ username: "local" })).rows.find((r) => r.kind === "look-sheets")).toEqual({ kind: "look-sheets", bytes: 1000, items: 1 });
    expect((await keptView({ username: "bo" })).rows.find((r) => r.kind === "look-sheets")).toMatchObject({ bytes: 0, items: 0 });
    // an older Mac app says nothing of sheets: nothing is answered or changed
    expect(await claimWith(undefined)).toEqual({ job: null });
    expect(deviceOf(mac.device.id)!.looks).toEqual({ bytes: 1000, items: 1 });
  });

  it("Empty in Settings → Storage tells each Mac on its next claim to drop them all, and counts nothing from then", async () => {
    expect(macLookJob.waits("local", mac.device.id)).toBe(false);
    await emptyKept("look-sheets", { username: "local" });
    expect((await keptView({ username: "local" })).rows.find((r) => r.kind === "look-sheets")).toMatchObject({ bytes: 0, items: 0 });
    // its long poll is answered with the hint, so it claims now
    expect(macLookJob.waits("local", mac.device.id)).toBe(true);
    expect(macLookJob.waits("local", second.device.id)).toBe(false); // it kept none
    expect((await claimWith({ "ver-ast-k-01": 1000 })).looks).toEqual({ gone: [], clear: true });
    expect(deviceOf(mac.device.id)!.looks).toEqual({ bytes: 0, items: 0 });
    expect(macLookJob.waits("local", mac.device.id)).toBe(false);
    // through the page's route, as any other kind Empty clears
    const r = await app.request("/api/devices/storage/kept/look-sheets/empty", { method: "POST" });
    expect(r.status).toBe(200);
  });
});
