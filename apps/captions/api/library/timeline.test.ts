import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ffmpegCommand } from "../ffmpeg-runtime";

vi.mock("../ai-complete", async (real) => {
  const m = await real<typeof import("../ai-complete")>();
  return { ...m, aiFor: vi.fn(() => ({ only: ["mac"] })), completeWithFallback: vi.fn(m.completeWithFallback) };
});
// the person's AI providers: none, unless a test gives them Antigravity (agy)
vi.mock("../lib/providers", async (real) => {
  const m = await real<typeof import("../lib/providers")>();
  return { ...m, ownSettings: vi.fn(m.ownSettings), routeForInstance: vi.fn(m.routeForInstance) };
});
vi.mock("../ai-vision", () => ({ completeVisionWithFallback: vi.fn() }));

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-timeline-"));
process.env.DATA_DIR = dir;
process.env.LIBRARY_SCRATCH_DIR = path.join(dir, "scratch");
delete process.env.APP_SECRET;
delete process.env.GEMINI_API_KEY;
const { blobs, libraryDb } = await import("./db");
const { tick } = await import("./worker");
const { searchLibrary, assetDetail } = await import("./search");
const { queueLook, WATCH_LABEL } = await import("./shots");
const { askedWatch, watchStopped, holesOf, parked, parseTimeline, PART_S, RETRY_MS, secondsOf, storeTimeline, sweepWatch, timelineOf, wantsWatch, watchAfter, watching, watchTiming, watchUsdPerHour, watchVersion, WATCH_LEVELS } = await import("./timeline");
const { clock } = await import("./look");
watchTiming.backoffMs = 0;
// the long call goes through the stubbed fetch, so each test sees and answers it
watchTiming.post = (url, headers, body) => fetch(url, { method: "POST", headers, body });
/** Waits for the watches running beside the look lane. */
const watched = () => Promise.all([...watching.values()]);
const { embedChunks } = await import("./embed");
const { saveMyKey } = await import("../my-keys");
const { currentSeq } = await import("../lib/sync");
const { enqueueJob } = await import("./jobs");
const { completeVisionWithFallback } = await import("../ai-vision");
const { MacClaudeError, macUsageSince } = await import("../lib/mac-claude");
const { completeWithFallback } = await import("../ai-complete");
const providers = await import("../lib/providers");
const { antigravityRoute, askAntigravity, canWatch } = await import("./timeline");

afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

// a picture with a sound track (a tone), and the same picture with none
const cuts = path.join(dir, "cuts.mp4");
const silent = path.join(dir, "silent.mp4");
beforeAll(() => {
  const ff = (...a: string[]) => execFileSync(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-y", ...a]);
  ff("-f", "lavfi", "-i", "testsrc=duration=12:size=160x90:rate=10", "-f", "lavfi", "-i", "sine=frequency=440:duration=12", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", cuts);
  ff("-i", cuts, "-an", "-c:v", "copy", silent);
  libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_t', 'local', 'T', 'local', 0)").run();
});

async function seed(id: string, duration = 12, from = cuts) {
  const d = libraryDb();
  const v = `ver-${id}`;
  const key = `libraries/lib_t/v/${v}/source`;
  const file = path.join(dir, `src-${id}.mp4`);
  copyFileSync(from, file);
  await blobs.put(key, file);
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at, roll) VALUES (?, 'lib_t', 'video', ?, ?, 'local', 1, 'b')").run(id, `Tiny Acrobatics ${id}`, v);
  d.prepare(
    `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at)
     VALUES (?, ?, 1, ?, 1, ?, ?, 'ready', 'local', 1)`,
  ).run(v, id, key, `sha-${id}`, JSON.stringify({ duration, vcodec: "h264", acodec: "aac", width: 160, height: 90, fps: 10, rotation: 0 }));
  d.prepare("INSERT INTO descriptions (version_id, source, text, provider, created_at, roll) VALUES (?, 'ai', 'A boss fight.', 'test', 1, 'b')").run(v);
  return { v, file: await blobs.localCopy(key) };
}

/** Gemini, mocked: the upload, its state, each part's events (from `events(a, b)`), the delete. Every request kept. */
/** One event over the whole part, its times counted from the part's start (the answer the shift is for). */
const wholePart = (a: number, b: number) => [{ start: "0:00", end: clock(b - a), what: "the boss dies", sound: "a roar", change: "a cut to wide" }];

function gemini(events: (a: number, b: number) => unknown[] = wholePart, fail?: number, busy: ("503" | "drop")[] = []) {
  const calls: { url: string; init: RequestInit & { headers?: Record<string, string> } }[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit & { headers?: Record<string, string> } = {}) => {
    calls.push({ url, init });
    if (fail) return new Response(JSON.stringify({ error: { message: "API key not valid" } }), { status: fail });
    if (url.endsWith("/upload/v1beta/files")) return new Response("{}", { headers: { "x-goog-upload-url": "https://upload.test/1" } });
    if (url === "https://upload.test/1") return Response.json({ file: { name: "files/abc", uri: "https://files.test/abc", state: "ACTIVE" } });
    if (url.endsWith("/v1beta/files/abc") && init.method === "DELETE") return new Response("{}");
    if (url.endsWith("/v1beta/files/abc")) return Response.json({ name: "files/abc", uri: "https://files.test/abc", state: "ACTIVE" });
    if (url.includes(":generateContent") && busy.length) {
      if (busy.shift() === "drop") throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ error: { message: "This model is currently experiencing high demand." } }), { status: 503 });
    }
    if (url.includes(":generateContent")) {
      const body = JSON.parse(String(init.body)) as { contents: { parts: { videoMetadata?: { startOffset: string; endOffset: string } }[] }[] };
      const m = body.contents[0]!.parts[0]!.videoMetadata!;
      const text = JSON.stringify({ events: events(parseInt(m.startOffset, 10), parseInt(m.endOffset, 10)) });
      return Response.json({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 100_000, candidatesTokenCount: 1000 } });
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  return calls;
}

beforeEach(() => {
  parked.clear();
  saveMyKey("local", "GEMINI_API_KEY", null);
  vi.mocked(completeVisionWithFallback).mockImplementation(async (_s, user, _i, _sig, parse) => {
    const shots = [...user.matchAll(/(\d+) \(\d+:\d\d–\d+:\d\d\)/g)].map((m) => ({ n: Number(m[1]), text: "bars", action: 1, clear: true, tags: [] }));
    return { value: parse(JSON.stringify({ shots })), provider: "test" } as never;
  });
});

describe("a timeline's answer", () => {
  it("reads clock times, keeps order, caps words, clamps to the part", () => {
    expect(secondsOf("1:02")).toBe(62);
    expect(secondsOf("1:00:03")).toBe(3603);
    expect(secondsOf("12.5s")).toBe(12.5);
    expect(secondsOf("soon")).toBeNaN();
    const e = parseTimeline(JSON.stringify({ events: [{ start: "0:30", end: "0:40", what: "x".repeat(500) }, { start: "0:10", end: "0:20", what: " a  hit ", sound: "bang" }, { start: "0:50", what: "" }] }), 0, 35);
    expect(e.map((x) => [x.a, x.b])).toEqual([[10, 20], [30, 35]]);
    expect(e[0]).toMatchObject({ what: "a hit", sound: "bang" });
    expect(e[1]!.what).toHaveLength(200);
  });

  it("moves a part's times counted from the part's own start", () => {
    const e = parseTimeline(JSON.stringify({ events: [{ start: "0:05", end: "0:09", what: "late" }] }), 1200, 2400);
    expect(e[0]).toMatchObject({ a: 1205, b: 1209 });
    // counted from the video's start already: kept
    expect(parseTimeline(JSON.stringify({ events: [{ start: "20:05", end: "20:09", what: "late" }] }), 1200, 2400)[0]).toMatchObject({ a: 1205 });
  });

  it("an hour costs cents, more at Detailed, less on Flash-Lite", () => {
    expect(watchUsdPerHour("standard", "gemini-3.5-flash-lite")).toBeCloseTo(0.14, 2);
    expect(watchUsdPerHour("standard", "gemini-3.8-flash")).toBeCloseTo(0.38, 2);
    for (const m of ["gemini-3.8-flash", "gemini-3.5-flash-lite"] as const) {
      expect(watchUsdPerHour("detailed", m)).toBeGreaterThan(watchUsdPerHour("standard", m));
      expect(watchUsdPerHour("light", m)).toBeLessThan(watchUsdPerHour("standard", m));
    }
    expect(watchUsdPerHour("standard")).toBe(watchUsdPerHour("standard", "gemini-3.8-flash"));
    expect(watchUsdPerHour("standard", "gemini-3.5-flash-lite")).toBeLessThan(watchUsdPerHour("standard"));
  });

  it("drops the sound notes of a file with no sound track", () => {
    const text = JSON.stringify({ events: [{ start: "0:01", end: "0:04", what: "a jump", sound: "giggling", change: "a cut" }] });
    expect(parseTimeline(text, 0, 12, false)).toEqual([{ a: 1, b: 4, what: "a jump", change: "a cut" }]);
    expect(parseTimeline(text, 0, 12)[0]).toMatchObject({ sound: "giggling" });
  });

  it("its moments are search-by-meaning chunks with their time", () => {
    const c = embedChunks("T", null, [], [{ a: 61, b: 64, what: "the boss dies", sound: "a roar" }]);
    expect(c[1]).toEqual({ start: 61, text: "the boss dies. Sound: a roar" });
  });
});

describe("watching a video", () => {
  it("uploads once, asks in parts at the level's frame rate, stores, tallies and drops the upload", async () => {
    const { v, file } = await seed("long", 2 * PART_S + 30);
    saveMyKey("local", "GEMINI_API_KEY", "gk-test");
    const calls = gemini();
    const r = await watchVersion(libraryDb(), v, file, "local");
    const asks = calls.filter((c) => c.url.includes(":generateContent"));
    expect(asks).toHaveLength(3);
    expect(asks[0]!.url).toContain("/models/gemini-3.8-flash:generateContent");
    const body = JSON.parse(String(asks[1]!.init.body)) as { contents: { parts: { videoMetadata: unknown }[] }[]; generationConfig: { mediaResolution: string } };
    expect(body.contents[0]!.parts[0]!.videoMetadata).toEqual({ startOffset: `${PART_S}s`, endOffset: `${2 * PART_S}s`, fps: WATCH_LEVELS.standard.fps });
    expect(body.generationConfig.mediaResolution).toBe("MEDIA_RESOLUTION_LOW");
    expect(calls.filter((c) => c.url.includes("upload")).length).toBe(2);
    expect(calls.at(-1)).toMatchObject({ url: expect.stringContaining("/v1beta/files/abc"), init: { method: "DELETE" } });
    expect(calls.every((c) => (c.init.headers?.["x-goog-api-key"] ?? "gk-test") === "gk-test")).toBe(true);
    expect(r.events).toBe(3);
    // the second part's times came from its own start: moved there
    expect(timelineOf(libraryDb(), v).map((e) => e.a)).toEqual([0, PART_S, 2 * PART_S]);
    expect(r.usd).toBeCloseTo(3 * ((100_000 * 0.75 + 1000 * 3.75) / 1e6), 6);
    await new Promise((go) => setTimeout(go, 50));
    const hour = Object.values(await macUsageSince(Date.now() - 3600_000));
    expect(hour.some((h) => (h[WATCH_LABEL]?.calls ?? 0) >= 3)).toBe(true);
    // search finds the moment, with its second
    const hits = searchLibrary("lib_t", "boss dies");
    expect(hits.some((h) => h.asset.id === "long" && h.seconds === PART_S)).toBe(true);
    expect(assetDetail("lib_t", "long")?.timeline?.[0]).toMatchObject({ what: "the boss dies", sound: "a roar" });
  });
});

describe("sound", () => {
  type Ask = { systemInstruction: { parts: { text: string }[] }; contents: { parts: { text?: string }[] }[]; generationConfig: { responseJsonSchema: { properties: { events: { items: { properties: Record<string, unknown> } } } } } };
  const asked = (calls: ReturnType<typeof gemini>) => calls.filter((c) => c.url.includes(":generateContent")).map((c) => JSON.parse(String(c.init.body)) as Ask);

  it("a file with no sound track: the model is told so, asked for no sound notes, and one sent anyway is dropped", async () => {
    const { v, file } = await seed("silent", 12, silent);
    saveMyKey("local", "GEMINI_API_KEY", "gk-test");
    const calls = gemini();
    const r = await watchVersion(libraryDb(), v, file, "local");
    expect(r.sound).toBe(false);
    const [ask] = asked(calls);
    expect(ask!.systemInstruction.parts[0]!.text).toContain("no sound track");
    expect(ask!.systemInstruction.parts[0]!.text).not.toContain("what the sound adds");
    expect(ask!.contents[0]!.parts[1]!.text).toContain("with no sound");
    expect(ask!.contents[0]!.parts[1]!.text).not.toContain('"sound"');
    expect(ask!.generationConfig.responseJsonSchema.properties.events.items.properties).not.toHaveProperty("sound");
    // the mocked answer says "a roar": dropped
    expect(timelineOf(libraryDb(), v)).toEqual([{ a: 0, b: 12, what: "the boss dies", change: "a cut to wide" }]);
  });

  it("a file with sound: asked for what the sound adds, and it is kept", async () => {
    const { v, file } = await seed("tone");
    saveMyKey("local", "GEMINI_API_KEY", "gk-test");
    const calls = gemini();
    expect((await watchVersion(libraryDb(), v, file, "local")).sound).toBe(true);
    const [ask] = asked(calls);
    expect(ask!.systemInstruction.parts[0]!.text).toContain("with its sound");
    expect(ask!.generationConfig.responseJsonSchema.properties.events.items.properties).toHaveProperty("sound");
    expect(timelineOf(libraryDb(), v)[0]).toMatchObject({ sound: "a roar" });
  });
});

describe("the model", () => {
  it("a library set to Flash-Lite watches with it, at its price, and stores which", async () => {
    const { v, file } = await seed("lite");
    saveMyKey("local", "GEMINI_API_KEY", "gk-test");
    libraryDb().prepare(`UPDATE libraries SET settings = json_set(settings, '$.timelineModel', 'gemini-3.5-flash-lite') WHERE id = 'lib_t'`).run();
    try {
      const calls = gemini();
      const r = await watchVersion(libraryDb(), v, file, "local");
      expect(calls.find((c) => c.url.includes(":generateContent"))!.url).toContain("/models/gemini-3.5-flash-lite:generateContent");
      expect(r.usd).toBeCloseTo((100_000 * 0.3 + 1000 * 2.5) / 1e6, 6);
      expect((libraryDb().prepare("SELECT model FROM timelines WHERE version_id = ?").get(v) as { model: string }).model).toBe("gemini-3.5-flash-lite");
    } finally {
      libraryDb().prepare(`UPDATE libraries SET settings = json_remove(settings, '$.timelineModel') WHERE id = 'lib_t'`).run();
    }
  });
});

describe("a busy or patchy answer", () => {
  it("finds the stretches no event covers, cut to parts", () => {
    expect(holesOf([], 1500, 0)).toEqual([[0, PART_S], [PART_S, 2 * PART_S], [2 * PART_S, 1500]]);
    const e = (a: number, b: number) => ({ a, b, what: "x" });
    expect(holesOf([e(0, 30), e(200, 260), e(250, 280)], 300, 60)).toEqual([[30, 200]]);
    expect(holesOf([e(0, 30)], 1500, 60)).toEqual([[30, 30 + PART_S], [30 + PART_S, 30 + 2 * PART_S], [30 + 2 * PART_S, 1500]]);
    expect(holesOf([e(0, 299)], 300, 60)).toEqual([]);
  });

  it("a 503 and a dropped connection are asked again; a part answered for its first minute only is asked once more for the rest", async () => {
    const { v, file } = await seed("patchy", 400);
    saveMyKey("local", "GEMINI_API_KEY", "gk-test");
    const calls = gemini((a, b) => (a === 0 ? [{ start: "0:00", end: "1:00", what: "the start" }] : [{ start: clock(a), end: clock(b), what: "the rest" }]), undefined, ["503", "drop"]);
    await watchVersion(libraryDb(), v, file, "local");
    const asks = calls.filter((c) => c.url.includes(":generateContent")).map((c) => (JSON.parse(String(c.init.body)) as { contents: { parts: { videoMetadata: { startOffset: string } }[] }[] }).contents[0]!.parts[0]!.videoMetadata.startOffset);
    expect(asks).toEqual(["0s", "0s", "0s", "60s"]);
    expect(timelineOf(libraryDb(), v).map((e) => [e.a, e.b, e.what])).toEqual([[0, 60, "the start"], [60, 400, "the rest"]]);
  });
});

describe("a quota", () => {
  it("a free key's daily quota parks the watch: no next part, no other video, kept to try later, said once for the library", async () => {
    const { v, file } = await seed("quota", 2 * PART_S);
    const { v: other, file: otherFile } = await seed("quota-2");
    saveMyKey("local", "GEMINI_API_KEY", "gk-test");
    const calls = gemini();
    let asked = 0;
    const post = watchTiming.post;
    const said = "You exceeded your current quota. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20. Please retry in 4h2m59s.";
    // one part at a time here, so "the next part" is a call that would come after the quota answer
    watchTiming.post = async () => (asked++, Response.json({ error: { message: said, details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "14579s" }] } }, { status: 429 }));
    try {
      expect(watchStopped(libraryDb(), "lib_t")).toBe(null);
      await watchAfter(libraryDb(), v, async () => file, "local");
      // two parts of ten minutes were asked at once; each was told once, neither asked again
      expect(asked).toBe(2);
      const uploads = calls.filter((c) => c.url.endsWith("/upload/v1beta/files")).length;
      await watchAfter(libraryDb(), other, async () => otherFile, "local");
      expect(asked).toBe(2);
      expect(calls.filter((c) => c.url.endsWith("/upload/v1beta/files")).length).toBe(uploads);
      // kept with Gemini's words, tried again later, never failed for good
      expect((libraryDb().prepare("SELECT error FROM timelines WHERE version_id = ?").get(v) as { error: string }).error).toContain("Please retry in 4h2m59s");
      expect(wantsWatch(libraryDb(), v, "local", Date.now() + RETRY_MS + 1000)).toBe(true);
      expect(watchStopped(libraryDb(), "lib_t")).toBe("free");
      // the wait over, the next watch asks again
      parked.clear();
      gemini();
      watchTiming.post = post;
      await watchVersion(libraryDb(), other, otherFile, "local");
      expect(watchStopped(libraryDb(), "lib_t")).toBe(null);
    } finally {
      watchTiming.post = post;
    }
  });

  it("an empty prepaid credit parks the key until the next try, tells its owner once, and clears when a call works", async () => {
    const { creditGone } = await import("../credits");
    const { v, file } = await seed("credit", 2 * PART_S);
    const { v: other, file: otherFile } = await seed("credit-2");
    saveMyKey("local", "GEMINI_API_KEY", "gk-test");
    const calls = gemini();
    let asked = 0;
    const post = watchTiming.post;
    const said = "Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.";
    watchTiming.post = async () => (asked++, Response.json({ error: { code: 402, message: said } }, { status: 402 }));
    try {
      await watchAfter(libraryDb(), v, async () => file, "local");
      expect(asked).toBe(2);
      const uploads = calls.filter((c) => c.url.endsWith("/upload/v1beta/files")).length;
      // another video: nothing uploaded, nothing asked
      await watchAfter(libraryDb(), other, async () => otherFile, "local");
      expect(asked).toBe(2);
      expect(calls.filter((c) => c.url.endsWith("/upload/v1beta/files")).length).toBe(uploads);
      expect(parked.get("gk-test")!.until).toBeGreaterThan(Date.now() + RETRY_MS - 60_000);
      expect(watchStopped(libraryDb(), "lib_t")).toBe("credit");
      expect([...creditGone.values()]).toMatchObject([{ name: "GEMINI_API_KEY", stopped: "Media Library video breakdowns", owners: ["local"] }]);
      // queued, tried again later
      expect(wantsWatch(libraryDb(), v, "local", Date.now() + RETRY_MS + 1000)).toBe(true);
      // topped up: the next try works, the warning goes
      parked.clear();
      gemini();
      watchTiming.post = post;
      await watchVersion(libraryDb(), other, otherFile, "local");
      expect(creditGone.size).toBe(0);
      expect(watchStopped(libraryDb(), "lib_t")).toBe(null);
    } finally {
      watchTiming.post = post;
      parked.clear();
    }
  });
});

describe("in the look job", () => {
  it("no key: the look runs as before and Gemini is never called", async () => {
    const { v } = await seed("nokey");
    const calls = gemini();
    queueLook(libraryDb(), v, "local");
    while (await tick(Date.now(), ["look"]));
    expect((libraryDb().prepare("SELECT state FROM jobs WHERE version_id = ? AND kind = 'look'").get(v) as { state: string }).state).toBe("done");
    expect(calls).toHaveLength(0);
    expect(libraryDb().prepare("SELECT 1 FROM timelines WHERE version_id = ?").get(v)).toBeUndefined();
    // swept while there is no key: passed over, not set aside for RETRY_MS
    expect(sweepWatch(libraryDb(), (id) => id === v)).toBe(false);
    // a key added later: the next sweep queues its look again, which goes on to the watch
    saveMyKey("local", "GEMINI_API_KEY", "gk-test");
    expect(sweepWatch(libraryDb(), (id, actor) => id === v && queueLook(libraryDb(), id, actor, true))).toBe(true);
    while (await tick(Date.now(), ["look"]));
    await watched();
    expect(timelineOf(libraryDb(), v)).toHaveLength(1);
    expect(calls.some((c) => c.url.includes(":generateContent"))).toBe(true);
  });

  it("Timelines off: no watch, with a key", async () => {
    const { v } = await seed("off");
    saveMyKey("local", "GEMINI_API_KEY", "gk-test");
    libraryDb().prepare(`UPDATE libraries SET settings = json_set(settings, '$.timeline', json('false')) WHERE id = 'lib_t'`).run();
    try {
      const calls = gemini();
      expect(wantsWatch(libraryDb(), v, "local")).toBe(false);
      queueLook(libraryDb(), v, "local");
      while (await tick(Date.now(), ["look"]));
      expect(calls).toHaveLength(0);
      // Make timeline on the clip: watched anyway, once, and the ask goes when its watch ends
      askedWatch.add(v);
      expect(wantsWatch(libraryDb(), v, "local")).toBe(true);
      queueLook(libraryDb(), v, "local", true);
      while (await tick(Date.now(), ["look"]));
      await watched();
      expect(timelineOf(libraryDb(), v)).toHaveLength(1);
      expect(askedWatch.has(v)).toBe(false);
    } finally {
      libraryDb().prepare(`UPDATE libraries SET settings = json_remove(settings, '$.timeline') WHERE id = 'lib_t'`).run();
    }
  });

  it("a watch that stores a timeline tells the open pages", async () => {
    const { v, file } = await seed("tells");
    saveMyKey("local", "GEMINI_API_KEY", "gk-test");
    gemini();
    askedWatch.add(v);
    const before = currentSeq();
    await watchAfter(libraryDb(), v, async () => file, "local");
    expect(timelineOf(libraryDb(), v)).toHaveLength(1);
    expect(currentSeq()).toBeGreaterThan(before);
  });

  it("an asked look that fails for good drops the ask; one tried again keeps it", async () => {
    const { v } = await seed("lookfails");
    saveMyKey("local", "GEMINI_API_KEY", "gk-test");
    vi.mocked(completeVisionWithFallback).mockRejectedValue(new Error("the model broke"));
    askedWatch.add(v);
    queueLook(libraryDb(), v, "local", true);
    await tick(Date.now(), ["look"]);
    expect(askedWatch.has(v)).toBe(true);
    for (let i = 1; i < 5; i++) await tick(Date.now() + i * 600_000, ["look"]);
    expect((libraryDb().prepare("SELECT state FROM jobs WHERE version_id = ? AND kind = 'look'").get(v) as { state: string }).state).toBe("failed");
    expect(askedWatch.has(v)).toBe(false);
  });

  it("a watch that fails leaves the look done, keeps why, and is tried again later", async () => {
    const { v } = await seed("fails");
    saveMyKey("local", "GEMINI_API_KEY", "gk-bad");
    gemini(undefined, 400);
    queueLook(libraryDb(), v, "local");
    while (await tick(Date.now(), ["look"]));
    await watched();
    expect((libraryDb().prepare("SELECT state FROM jobs WHERE version_id = ? AND kind = 'look'").get(v) as { state: string }).state).toBe("done");
    expect((libraryDb().prepare("SELECT error FROM timelines WHERE version_id = ?").get(v) as { error: string }).error).toContain("API key not valid");
    expect(wantsWatch(libraryDb(), v, "local")).toBe(false);
    expect(wantsWatch(libraryDb(), v, "local", Date.now() + RETRY_MS + 1000)).toBe(true);
    // a real failure keeps its wait in the sweep too
    expect(sweepWatch(libraryDb(), (id) => id === v)).toBe(false);
    // Make for the missing pressed since: What's made counts it queued, so the sweep takes it now, not RETRY_MS later
    const press = (at: number) => libraryDb().prepare(`UPDATE libraries SET settings = json_set(settings, '$.timelineAsked', ?) WHERE id = 'lib_t'`).run(at);
    const pressed = Date.now() + 1;
    press(pressed);
    try {
      expect(sweepWatch(libraryDb(), (id) => id === v, pressed + 10)).toBe(true);
      // the sweep queued it a moment ago: the same press does not queue it twice, a press since then does
      expect(sweepWatch(libraryDb(), (id) => id === v, pressed + 20)).toBe(false);
      press(pressed + 30);
      expect(sweepWatch(libraryDb(), (id) => id === v, pressed + 40)).toBe(true);
      // one Gemini turned down is settled: not by the wait, not by a press (each try uploads it to be turned down again),
      // only asked for by name
      libraryDb().prepare("UPDATE timelines SET error = 'Refused by Gemini: PROHIBITED_CONTENT' WHERE version_id = ?").run(v);
      press(pressed + 50);
      expect(sweepWatch(libraryDb(), (id) => id === v, pressed + 60)).toBe(false);
      expect(wantsWatch(libraryDb(), v, "local", pressed + RETRY_MS * 2)).toBe(false);
      askedWatch.add(v);
      expect(wantsWatch(libraryDb(), v, "local")).toBe(true);
      askedWatch.delete(v);
    } finally {
      libraryDb().prepare(`UPDATE libraries SET settings = json_remove(settings, '$.timelineAsked') WHERE id = 'lib_t'`).run();
    }
  });

  it("an answer with nothing in it keeps Gemini's own reason: a refusal is named as one, anything else as no answer", async () => {
    const { answerOf, REFUSED } = await import("./timeline");
    const answer = (body: unknown) => answerOf(new Response(JSON.stringify(body)), "gemini-3.8-flash" as never, 0, 10, true);
    await expect(answer({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } })).rejects.toThrow(`${REFUSED}: PROHIBITED_CONTENT`);
    await expect(answer({ candidates: [{ finishReason: "SAFETY" }] })).rejects.toThrow(`${REFUSED}: SAFETY`);
    await expect(answer({ candidates: [{ finishReason: "MAX_TOKENS" }] })).rejects.toThrow("Gemini gave no answer (MAX_TOKENS)");
    await expect(answer({ candidates: [{ content: { parts: [{ text: "not json" }] }, finishReason: "STOP" }] })).rejects.toThrow("could not be read (STOP)");
  });

  it("a blurred copy's watch is its original's: one that failed there leaves the sweep, which goes on to the next clip", async () => {
    // each clip as Face Blur leaves it: the original, and its blurred render as the current version with the look mirrored done
    const pair = async (id: string) => {
      const { v } = await seed(id);
      const d = libraryDb();
      d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, blurred_of, state, created_by, created_at) VALUES (?, ?, 2, ?, 1, ?, ?, 'ready', 'local', 2)").run(`${v}-b`, id, `libraries/lib_t/v/${v}-b/source`, `shab-${id}`, `sha-${id}`);
      d.prepare("UPDATE assets SET current_version_id = ? WHERE id = ?").run(`${v}-b`, id);
      for (const x of [v, `${v}-b`]) d.prepare("INSERT OR REPLACE INTO jobs (library_id, version_id, kind, state, actor) VALUES ('lib_t', ?, 'look', 'done', 'local')").run(x);
      return v;
    };
    const failed = await pair("pair-failed");
    const fresh = await pair("pair-fresh");
    saveMyKey("local", "GEMINI_API_KEY", "gk-test");
    storeTimeline(libraryDb(), failed, { error: "Gemini said no" });
    const mine = new Set([failed, `${failed}-b`, fresh, `${fresh}-b`]);
    const taken: string[] = [];
    while (sweepWatch(libraryDb(), (id) => mine.has(id) && !!taken.push(id)));
    // the watch runs on the original, so that is the look queued; the failed one waits RETRY_MS as any failed watch does
    expect(taken).toEqual([fresh]);
    expect(wantsWatch(libraryDb(), fresh, "local")).toBe(true);
  });

  it("more clips passed over than one sweep reads never keep an older clip from its turn", async () => {
    const d = libraryDb();
    const { v } = await seed("behind");
    d.prepare("INSERT OR REPLACE INTO jobs (library_id, version_id, kind, state, actor) VALUES ('lib_t', ?, 'look', 'done', 'local')").run(v);
    saveMyKey("local", "GEMINI_API_KEY", "gk-test");
    // 60 newer clips of someone with no key: passed over on every sweep, never set aside
    for (let i = 0; i < 60; i++) {
      d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at, roll) VALUES (?, 'lib_t', 'video', 'nokey', ?, 'carol', 9, 'b')").run(`nokey-${i}`, `ver-nokey-${i}`);
      d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at) VALUES (?, ?, 1, 'k', 1, ?, '{\"duration\":12}', 'ready', 'carol', 9)").run(`ver-nokey-${i}`, `nokey-${i}`, `sha-nokey-${i}`);
      d.prepare("INSERT INTO jobs (library_id, version_id, kind, state, actor) VALUES ('lib_t', ?, 'look', 'done', 'carol')").run(`ver-nokey-${i}`);
    }
    try {
      let took = false;
      for (let i = 0; i < 4 && !took; i++) took = sweepWatch(libraryDb(), (id) => id === v);
      expect(took).toBe(true);
    } finally {
      d.prepare("UPDATE assets SET trashed_at = 1 WHERE id LIKE 'nokey-%'").run();
    }
  });

  it("the sweep watches on the uploader's own key, never another account's", async () => {
    const { v } = await seed("bobs");
    libraryDb().prepare("UPDATE asset_versions SET created_by = 'bob' WHERE id = ?").run(v);
    enqueueJob(libraryDb(), "lib_t", v, "look", "bob");
    libraryDb().prepare("UPDATE jobs SET state = 'done' WHERE version_id = ? AND kind = 'look'").run(v);
    saveMyKey("local", "GEMINI_API_KEY", "gk-test");
    try {
      expect(sweepWatch(libraryDb(), (id) => id === v)).toBe(false);
      // bob saves his own: the next sweep takes the clip
      saveMyKey("bob", "GEMINI_API_KEY", "gk-bob");
      expect(sweepWatch(libraryDb(), (id) => id === v)).toBe(true);
    } finally {
      saveMyKey("bob", "GEMINI_API_KEY", null);
    }
  });

  it("a watch waiting on a busy Gemini holds no look: the job is done, the next look runs, the sweep waits for it", async () => {
    const { v } = await seed("slow");
    const { v: next } = await seed("after-slow");
    saveMyKey("local", "GEMINI_API_KEY", "gk-test");
    gemini();
    const answers: ((r: Response) => void)[] = [];
    const post = watchTiming.post;
    watchTiming.post = (url, headers, body) => (url.includes(":generateContent") ? new Promise<Response>((go) => answers.push(go)) : post(url, headers, body, 0));
    try {
      queueLook(libraryDb(), v, "local");
      while (await tick(Date.now(), ["look"]));
      expect((libraryDb().prepare("SELECT state FROM jobs WHERE version_id = ? AND kind = 'look'").get(v) as { state: string }).state).toBe("done");
      expect(watching.has(v)).toBe(true);
      // the sweep never queues the one being watched again
      expect(sweepWatch(libraryDb(), (id) => id === v)).toBe(false);
      queueLook(libraryDb(), next, "local");
      while (await tick(Date.now(), ["look"]));
      expect((libraryDb().prepare("SELECT state FROM jobs WHERE version_id = ? AND kind = 'look'").get(next) as { state: string }).state).toBe("done");
      // both watches wait on Gemini at once; answered, both end
      expect(watching.has(next)).toBe(true);
      while (answers.length < 2) await new Promise((go) => setTimeout(go, 10));
      for (const go of answers) go(Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ events: wholePart(0, 12) }) }] } }], usageMetadata: {} }));
      while (watching.size) await watched();
      expect(timelineOf(libraryDb(), v)).toHaveLength(1);
    } finally {
      watchTiming.post = post;
    }
  });

  it("on a Gemini key more than three videos are watched at once", async () => {
    const vs = [];
    for (const n of ["w1", "w2", "w3", "w4"]) vs.push((await seed(n)).v);
    saveMyKey("local", "GEMINI_API_KEY", "gk-test");
    gemini();
    const answers: ((r: Response) => void)[] = [];
    const post = watchTiming.post;
    watchTiming.post = (url, headers, body) => (url.includes(":generateContent") ? new Promise<Response>((go) => answers.push(go)) : post(url, headers, body, 0));
    try {
      for (const v of vs) {
        queueLook(libraryDb(), v, "local");
        while (await tick(Date.now(), ["look"]));
      }
      expect(vs.every((v) => watching.has(v))).toBe(true);
      while (answers.length < 4) await new Promise((go) => setTimeout(go, 10));
      for (const go of answers) go(Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ events: wholePart(0, 12) }) }] } }], usageMetadata: {} }));
      while (watching.size) await watched();
    } finally {
      watchTiming.post = post;
    }
  });
});

describe("in an edit's plan", () => {
  it("each source's timeline is lines with their times, spread when there are too many", async () => {
    const { planPrompt, timelineLines, TIMELINE_MAX } = await import("../editor/plan");
    const many = Array.from({ length: TIMELINE_MAX + 10 }, (_, i) => ({ a: i, b: i + 1, what: `moment ${i}` }));
    const index = {
      sources: [
        { id: "v1", title: "Tiny Acrobatics fight", dur: 90, fps: 30, w: 1920, h: 1080, speech: false, shots: [{ a: 0, b: 90, motion: 0.5 }], timeline: [{ a: 61, b: 64.5, what: "the boss dies", sound: "a roar", change: "a cut" }] },
        { id: "v2", title: "Long", dur: 2000, fps: 30, w: 1920, h: 1080, speech: false, shots: [{ a: 0, b: 2000, motion: 0.5 }], timeline: many },
      ],
    };
    const lines = timelineLines(index);
    expect(lines.get("v1")).toEqual(["  t 1:01.0–1:04.5 the boss dies · sound: a roar · change: a cut"]);
    expect(lines.get("v2")!.length).toBe(TIMELINE_MAX / 2);
    const { user } = planPrompt({ brief: "", setup: "", versions: 1, index, words: {}, gen: [], targetS: 0 } as never);
    expect(user).toContain("Timeline lines:");
    expect(user).toContain("the boss dies · sound: a roar");
  });
});

/** A watch stopped by an empty Gemini credit, kept on the version. */
const storeTimelineError = (v: string) =>
  libraryDb().prepare("INSERT OR REPLACE INTO timelines (version_id, events, error, at) VALUES (?, '[]', 'The Gemini credit ran out: depleted', ?)").run(v, Date.now());

describe("Antigravity", () => {
  const inst = { id: "agy", driver: "antigravity" as const, name: "Antigravity", enabled: true, device: "mac-1" };
  /** The actor has Antigravity on their Mac; the library watches with it. */
  function withAntigravity() {
    vi.mocked(providers.ownSettings).mockReturnValue({ instances: [inst], default: { instance: "agy", model: "", effort: "medium" }, jobs: {} } as never);
    vi.mocked(providers.routeForInstance).mockReturnValue({ scope: "local", selection: { instance: "agy", model: "", effort: "medium" }, instance: inst, device: "mac-1" } as never);
    libraryDb().prepare(`UPDATE libraries SET settings = json_set(settings, '$.timelineModel', 'antigravity') WHERE id = 'lib_t'`).run();
  }
  /** Each run Antigravity is asked: its prompt, its route, and what the video part it got holds. */
  function runs(answer: (n: number) => unknown = () => ({ events: [{ start: "0:01", end: "0:04", what: "a jump", sound: "giggling", change: "a cut" }] })) {
    const asked: { system: string; user: string; opts: Parameters<typeof completeWithFallback>[4]; audio: string; height: number }[] = [];
    vi.mocked(completeWithFallback).mockImplementation(async (system, user, _c, parse, opts) => {
      const part = path.join(dir, `part-${asked.length}.mp4`);
      writeFileSync(part, Buffer.from(opts!.mac!.files!["video.mp4"]!.slice(7), "base64"));
      // a part past the end of the 12-second test file is an empty copy: nothing to read in it
      const probe = (what: string) => {
        try {
          return execFileSync("ffprobe", ["-v", "error", "-show_entries", what, "-of", "csv=p=0", part]).toString().trim();
        } catch {
          return "";
        }
      };
      asked.push({ system, user, opts, audio: probe("stream=codec_type").includes("audio") ? "yes" : "no", height: Number(probe("stream=height")) });
      const a = answer(asked.length - 1);
      if (a instanceof Error) throw a;
      return parse(JSON.stringify(a));
    });
    return asked;
  }
  afterEach(() => {
    vi.mocked(providers.ownSettings).mockReset();
    vi.mocked(providers.routeForInstance).mockReset();
    vi.mocked(completeWithFallback).mockReset();
    libraryDb().prepare(`UPDATE libraries SET settings = json_remove(settings, '$.timelineModel') WHERE id = 'lib_t'`).run();
  });

  it("the Gemini credit out and Antigravity picked on Home's Activity: the waiting videos and the next ones are watched there until the key works again", async () => {
    const { chooseCredit, creditBack } = await import("../credits");
    const { creditWaitsChosen } = await import("./timeline");
    const { v, file } = await seed("agy-credit");
    const { v: next, file: nextFile } = await seed("agy-credit-2");
    withAntigravity();
    libraryDb().prepare(`UPDATE libraries SET settings = json_remove(settings, '$.timelineModel') WHERE id = 'lib_t'`).run();
    saveMyKey("local", "GEMINI_API_KEY", "gk-test");
    gemini();
    const asked = runs();
    const post = watchTiming.post;
    watchTiming.post = async () => Response.json({ error: { code: 402, message: "Your prepayment credits are depleted." } }, { status: 402 });
    const model = (id: string) => (libraryDb().prepare("SELECT model, error FROM timelines WHERE version_id = ?").get(id) as { model: string | null; error: string | null });
    try {
      await watchAfter(libraryDb(), v, async () => file, "local");
      expect(model(v).error).toMatch(/^The Gemini credit ran out/);
      expect(wantsWatch(libraryDb(), v, "local")).toBe(false);
      // picked: the wait ends now, and the watch goes to Antigravity
      chooseCredit("GEMINI_API_KEY", "local", "antigravity");
      creditWaitsChosen(libraryDb(), "local", "antigravity");
      expect(wantsWatch(libraryDb(), v, "local")).toBe(true);
      await watchAfter(libraryDb(), v, async () => file, "local");
      expect(model(v)).toEqual({ model: "antigravity", error: null });
      // not made again with sound while the credit is out
      expect(wantsWatch(libraryDb(), v, "local")).toBe(false);
      // the key's wait over and still empty: the next video tries it once, then goes to Antigravity at once
      parked.clear();
      await watchAfter(libraryDb(), next, async () => nextFile, "local");
      expect(model(next)).toEqual({ model: "antigravity", error: null });
      expect(asked).toHaveLength(2);
      // topped up: back to the key, the picture-only ones made again with their sound
      creditBack("GEMINI_API_KEY", "gk-test");
      expect(wantsWatch(libraryDb(), v, "local")).toBe(true);
    } finally {
      watchTiming.post = post;
      creditBack("GEMINI_API_KEY", "gk-test");
    }
  });

  it("three videos at once on Antigravity: the fourth waits, however many a Gemini key may run", async () => {
    const vs: { v: string; file: string }[] = [];
    for (const n of ["agy-1", "agy-2", "agy-3", "agy-4"]) vs.push(await seed(n));
    withAntigravity();
    const answers: (() => void)[] = [];
    vi.mocked(completeWithFallback).mockImplementation((_s, _u, _c, parse) => new Promise((go) => answers.push(() => go(parse(JSON.stringify({ events: [{ start: "0:01", end: "0:04", what: "a jump" }] }))))));
    const runs = vs.map(({ v, file }) => watchAfter(libraryDb(), v, async () => file, "local"));
    expect(vs.map(({ v }) => watching.has(v))).toEqual([true, true, true, false]);
    while (answers.length < 3) await new Promise((go) => setTimeout(go, 10));
    for (const go of answers) go();
    await Promise.all(runs);
  });

  it("a key two people share: one person's pick moves only their own waiting videos", async () => {
    const { creditWaitsChosen } = await import("./timeline");
    const { v: mine } = await seed("credit-mine");
    const { v: theirs } = await seed("credit-theirs");
    libraryDb().prepare("UPDATE asset_versions SET created_by = 'other' WHERE id = ?").run(theirs);
    storeTimelineError(mine);
    storeTimelineError(theirs);
    const at = (id: string) => (libraryDb().prepare("SELECT at FROM timelines WHERE version_id = ?").get(id) as { at: number }).at;
    const was = at(theirs);
    creditWaitsChosen(libraryDb(), "local", "antigravity");
    expect(at(mine)).toBe(0);
    expect(at(theirs)).toBe(was);
  });

  it("Continue without: Timelines go off in the person's libraries with a video waiting on the credit", async () => {
    const { creditWaitsChosen } = await import("./timeline");
    const { librarySetting } = await import("./db");
    const { v } = await seed("credit-without");
    storeTimelineError(v);
    try {
      expect(creditWaitsChosen(libraryDb(), "someone", "without")).toEqual([]);
      expect(creditWaitsChosen(libraryDb(), "local", "without")).toEqual(["lib_t"]);
      expect(librarySetting("lib_t", "timeline")).toBe(false);
      expect(wantsWatch(libraryDb(), v, "local", Date.now() + RETRY_MS + 1000)).toBe(false);
    } finally {
      libraryDb().prepare(`UPDATE libraries SET settings = json_remove(settings, '$.timeline') WHERE id = 'lib_t'`).run();
    }
  });

  it("watches a small soundless copy in its run folder: picture only, no sound note kept, no key, no Gemini call", async () => {
    const { v, file } = await seed("agy");
    withAntigravity();
    const calls = gemini();
    const asked = runs();
    expect(canWatch(libraryDb(), "lib_t", "local")).toBe(true);
    expect(wantsWatch(libraryDb(), v, "local")).toBe(true);
    const r = await watchVersion(libraryDb(), v, file, "local");
    expect(calls).toHaveLength(0);
    expect(r).toMatchObject({ sound: false, usd: 0 });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ audio: "no", height: 90 });
    expect(asked[0]!.opts).toMatchObject({ only: ["mac"], fixed: true, mac: { once: true, background: true, provider: { driver: "antigravity", device: "mac-1" } } });
    expect(asked[0]!.system).toContain("no sound track");
    expect(asked[0]!.system).toContain("counted from the start of the file");
    expect(asked[0]!.user).toContain("The file video.mp4 in the current folder is its part from 0:00 to 0:12");
    expect(timelineOf(libraryDb(), v)).toEqual([{ a: 1, b: 4, what: "a jump", change: "a cut" }]);
    expect((libraryDb().prepare("SELECT model FROM timelines WHERE version_id = ?").get(v) as { model: string }).model).toBe("antigravity");
    // a key added and the library back on Gemini: the picture-only timeline is made again with its sound
    saveMyKey("local", "GEMINI_API_KEY", "gk-test");
    libraryDb().prepare(`UPDATE libraries SET settings = json_remove(settings, '$.timelineModel') WHERE id = 'lib_t'`).run();
    expect(wantsWatch(libraryDb(), v, "local")).toBe(true);
  });

  it("a part's times come back from the file's start and are moved to the video's", async () => {
    const { file } = await seed("agy-part");
    withAntigravity();
    runs();
    const e = await askAntigravity(antigravityRoute("local")!, "p", file, { title: "T", workspace: "", level: "standard", a: 4, b: 12, dur: 12 });
    expect(e).toEqual([{ a: 5, b: 8, what: "a jump", change: "a cut" }]);
  });

  it("picked with no Antigravity: nothing runs, a Gemini key or not", async () => {
    const { v } = await seed("agy-none");
    saveMyKey("local", "GEMINI_API_KEY", "gk-test");
    libraryDb().prepare(`UPDATE libraries SET settings = json_set(settings, '$.timelineModel', 'antigravity') WHERE id = 'lib_t'`).run();
    expect(antigravityRoute("local")).toBeNull();
    expect(wantsWatch(libraryDb(), v, "local")).toBe(false);
  });

  it("signed out and too big say so in plain words; a too-big part is asked as two halves", async () => {
    const { v, file } = await seed("agy-errors");
    withAntigravity();
    runs(() => new Error("Antigravity: Authentication required"));
    await expect(watchVersion(libraryDb(), v, file, "local")).rejects.toThrow("Antigravity is signed out: sign in to it again in Settings → Providers");
    const big = runs((n) => (n === 0 ? new Error("Request payload size exceeds the limit") : { events: [{ start: "0:00", end: "0:02", what: `half ${n}` }] }));
    const e = await askAntigravity(antigravityRoute("local")!, "p", file, { title: "T", workspace: "", level: "standard", a: 0, b: 120, dur: 120 });
    expect(big.map((b) => b.user.match(/part from (\S+) to (\S+),/)!.slice(1))).toEqual([["0:00", "2:00"], ["0:00", "1:00"], ["1:00", "2:00"]]);
    expect(e.map((x) => [x.a, x.what])).toEqual([[0, "half 1"], [60, "half 2"]]);
  });

  it("a used-up quota parks it: no other video asked, kept to try later, never moved to the Gemini key", async () => {
    const { v, file } = await seed("agy-quota");
    const { v: other, file: otherFile } = await seed("agy-quota-2");
    withAntigravity();
    saveMyKey("local", "GEMINI_API_KEY", "gk-test");
    const calls = gemini();
    const asked = runs(() => Object.assign(new MacClaudeError("Antigravity: RESOURCE_EXHAUSTED: quota", "limit"), { limited: { until: null } }));
    await watchAfter(libraryDb(), v, async () => file, "local");
    await watchAfter(libraryDb(), other, async () => otherFile, "local");
    expect(asked).toHaveLength(1);
    expect(calls).toHaveLength(0);
    expect((libraryDb().prepare("SELECT error FROM timelines WHERE version_id = ?").get(v) as { error: string }).error).toBe("Antigravity's quota is used up for now: the watch is tried again later");
    expect(parked.get("antigravity:local")!.until).toBeGreaterThan(Date.now());
    expect(wantsWatch(libraryDb(), v, "local", Date.now() + RETRY_MS + 1000)).toBe(true);
  });
});
