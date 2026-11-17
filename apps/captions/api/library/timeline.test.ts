import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ffmpegCommand } from "../ffmpeg-runtime";

vi.mock("../ai-complete", async (real) => {
  const m = await real<typeof import("../ai-complete")>();
  return { ...m, aiFor: vi.fn(() => ({ only: ["mac"] })) };
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
const { holesOf, parseTimeline, PART_S, RETRY_MS, secondsOf, sweepWatch, timelineOf, wantsWatch, watchTiming, watchUsdPerHour, watchVersion, WATCH_LEVELS, WATCH_MODEL } = await import("./timeline");
const { clock } = await import("./look");
watchTiming.backoffMs = 0;
const { embedChunks } = await import("./embed");
const { saveMyKey } = await import("../my-keys");
const { completeVisionWithFallback } = await import("../ai-vision");
const { macUsageSince } = await import("../lib/mac-claude");

afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

const cuts = path.join(dir, "cuts.mp4");
beforeAll(() => {
  execFileSync(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=12:size=160x90:rate=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", cuts]);
  libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_t', 'local', 'T', 'local', 0)").run();
});

async function seed(id: string, duration = 12) {
  const d = libraryDb();
  const v = `ver-${id}`;
  const key = `libraries/lib_t/v/${v}/source`;
  const file = path.join(dir, `src-${id}.mp4`);
  copyFileSync(cuts, file);
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

  it("an hour costs cents, more at Detailed", () => {
    expect(watchUsdPerHour("standard")).toBeCloseTo(0.16, 2);
    expect(watchUsdPerHour("detailed")).toBeGreaterThan(watchUsdPerHour("standard"));
    expect(watchUsdPerHour("light")).toBeLessThan(watchUsdPerHour("standard"));
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
    expect(asks[0]!.url).toContain(WATCH_MODEL);
    const body = JSON.parse(String(asks[1]!.init.body)) as { contents: { parts: { videoMetadata: unknown }[] }[]; generationConfig: { mediaResolution: string } };
    expect(body.contents[0]!.parts[0]!.videoMetadata).toEqual({ startOffset: `${PART_S}s`, endOffset: `${2 * PART_S}s`, fps: WATCH_LEVELS.standard.fps });
    expect(body.generationConfig.mediaResolution).toBe("MEDIA_RESOLUTION_LOW");
    expect(calls.filter((c) => c.url.includes("upload")).length).toBe(2);
    expect(calls.at(-1)).toMatchObject({ url: expect.stringContaining("/v1beta/files/abc"), init: { method: "DELETE" } });
    expect(calls.every((c) => (c.init.headers?.["x-goog-api-key"] ?? "gk-test") === "gk-test")).toBe(true);
    expect(r.events).toBe(3);
    // the second part's times came from its own start: moved there
    expect(timelineOf(libraryDb(), v).map((e) => e.a)).toEqual([0, PART_S, 2 * PART_S]);
    expect(r.usd).toBeCloseTo(3 * ((100_000 * 0.3 + 1000 * 2.5) / 1e6), 6);
    await new Promise((go) => setTimeout(go, 50));
    const hour = Object.values(await macUsageSince(Date.now() - 3600_000));
    expect(hour.some((h) => (h[WATCH_LABEL]?.calls ?? 0) >= 3)).toBe(true);
    // search finds the moment, with its second
    const hits = searchLibrary("lib_t", "boss dies");
    expect(hits.some((h) => h.asset.id === "long" && h.seconds === PART_S)).toBe(true);
    expect(assetDetail("lib_t", "long")?.timeline?.[0]).toMatchObject({ what: "the boss dies", sound: "a roar" });
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

describe("in the look job", () => {
  it("no key: the look runs as before and Gemini is never called", async () => {
    const { v } = await seed("nokey");
    const calls = gemini();
    queueLook(libraryDb(), v, "local");
    while (await tick(Date.now(), ["look"]));
    expect((libraryDb().prepare("SELECT state FROM jobs WHERE version_id = ? AND kind = 'look'").get(v) as { state: string }).state).toBe("done");
    expect(calls).toHaveLength(0);
    expect(libraryDb().prepare("SELECT 1 FROM timelines WHERE version_id = ?").get(v)).toBeUndefined();
    // a key added later: the sweep queues its look again, which goes on to the watch
    saveMyKey("local", "GEMINI_API_KEY", "gk-test");
    expect(sweepWatch(libraryDb(), (id, actor) => queueLook(libraryDb(), id, actor, true))).toBe(true);
    while (await tick(Date.now(), ["look"]));
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
    } finally {
      libraryDb().prepare(`UPDATE libraries SET settings = json_remove(settings, '$.timeline') WHERE id = 'lib_t'`).run();
    }
  });

  it("a watch that fails leaves the look done, keeps why, and is tried again later", async () => {
    const { v } = await seed("fails");
    saveMyKey("local", "GEMINI_API_KEY", "gk-bad");
    gemini(undefined, 400);
    queueLook(libraryDb(), v, "local");
    while (await tick(Date.now(), ["look"]));
    expect((libraryDb().prepare("SELECT state FROM jobs WHERE version_id = ? AND kind = 'look'").get(v) as { state: string }).state).toBe("done");
    expect((libraryDb().prepare("SELECT error FROM timelines WHERE version_id = ?").get(v) as { error: string }).error).toContain("API key not valid");
    expect(wantsWatch(libraryDb(), v, "local")).toBe(false);
    expect(wantsWatch(libraryDb(), v, "local", Date.now() + RETRY_MS + 1000)).toBe(true);
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
