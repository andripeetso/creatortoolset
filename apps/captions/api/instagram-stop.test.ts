import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "./auth";

// Stop on the Content Analyzer: a post's analysis, an account's pull and the idea board end as "Stopped", and what they
// had stays.

const dataDir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "ig-stop-"));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = ""; // background work runs as the local user
process.env.INSTAGRAM_CONCURRENCY = "16"; // a stopped run whose read never ends keeps its place; the next tests still run
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

// every read of the network hangs, so a run is still going when Stop is pressed
vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
// the AI hangs until its run is stopped, failing `lag` ms after (a step slow to unwind); with `answer` it answers, and
// with `hold` it waits for it and answers whatever the Stop said (a step that swallows the abort)
const ai = vi.hoisted(() => ({ lag: 0, answer: undefined as unknown, hold: null as Promise<void> | null }));
vi.mock("./ai-complete", async (real) => ({
  ...(await real<typeof import("./ai-complete")>()),
  anyAiConfigured: () => true,
  completeWithFallback: (_system: string, _user: string, signal: AbortSignal) => {
    if (ai.hold) return ai.hold.then(() => ai.answer);
    if (ai.answer !== undefined) return Promise.resolve(ai.answer);
    return new Promise((_, fail) => {
      const end = () => setTimeout(() => fail(new Error("aborted")), ai.lag);
      if (signal.aborted) end();
      else signal.addEventListener("abort", end);
    });
  },
}));
// one write held until the test lets it go, so a Stop lands in that moment
const disk = vi.hoisted(() => ({ hold: null as null | { match: (file: string, data: unknown) => boolean; reached: () => void; gate: Promise<void> } }));
vi.mock("node:fs/promises", async (real) => {
  const fs = await real<typeof import("node:fs/promises")>();
  const writeFile = (async (file: Parameters<typeof fs.writeFile>[0], data: Parameters<typeof fs.writeFile>[1], ...rest: [never?]) => {
    const h = disk.hold;
    if (h && h.match(String(file), data)) {
      disk.hold = null;
      h.reached();
      await h.gate;
    }
    return fs.writeFile(file, data, ...rest);
  }) as typeof fs.writeFile;
  return { ...fs, default: { ...fs, writeFile }, writeFile };
});
const holdWrite = (match: (file: string, data: unknown) => boolean) => {
  let release!: () => void;
  let reached!: () => void;
  const at = new Promise<void>((r) => (reached = r));
  disk.hold = { match, reached, gate: new Promise<void>((r) => (release = r)) };
  return { at, release };
};
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

const { instagramApp, analyzerWork } = await import("./instagram");
const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "local", role: "user", cloud: true, off: [] });
  await next();
});
app.route("/", instagramApp);

const igDir = path.join(dataDir, "instagram");
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf-8"));
const post = (extra: Record<string, unknown>): string => {
  const id = randomUUID();
  const url = `https://www.instagram.com/p/TINY${id.slice(0, 6)}/`;
  mkdirSync(path.join(igDir, id), { recursive: true });
  writeFileSync(
    path.join(igDir, id, "meta.json"),
    JSON.stringify({
      id, owner: "local", status: "ready", progress: 1, input: url, url, shortcode: `TINY${id.slice(0, 6)}`, mediaId: "1", kind: "post",
      creator: { id: "1", username: "tinyacrobatics" }, takenAt: 1, caption: "Three tumbles for a rainy day",
      counts: { likes: 1, comments: 0, fetchedAt: 1 }, comments: { status: "skipped", count: 0, replies: 0 }, bytes: 0, createdAt: 1, updatedAt: 1,
      recipe: { preset: "watch", jobs: ["info", "stats", "media"] },
      jobs: [{ type: "info", status: "done" }, { type: "stats", status: "done" }, { type: "media", status: "pending" }],
      slides: [{ index: 0, kind: "image", file: "", mime: "", width: 10, height: 10, bytes: 0, transcript: { status: "skipped" }, vision: { status: "skipped" } }],
      tags: [],
      ...extra,
    }),
  );
  writeFileSync(path.join(igDir, id, "info.json"), JSON.stringify({ shortCode: "TINY", type: "Image", url, ownerUsername: "tinyacrobatics" }));
  return id;
};
mkdirSync(path.join(igDir, "users", "local"), { recursive: true });
writeFileSync(path.join(igDir, "users", "local", "apify.json"), JSON.stringify({ token: "test-token", savedAt: 1, savedBy: "local", valid: true, source: "file" }));

const stop = (p: string) => app.request(p, { method: "POST" });
const send = (p: string, body: object = {}) => app.request(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// a post whose run needs no network: everything done but its on-screen text, which has no slide to read
const offline = () =>
  post({
    status: "error", error: "Could not read every slide", recipe: { preset: "watch", jobs: ["info", "media", "vision"] },
    jobs: [{ type: "info", status: "done" }, { type: "media", status: "done" }, { type: "idea", status: "done" }, { type: "vision", status: "error" }],
  });
// a post whose run waits on the AI for its idea
const ideaPost = () =>
  post({
    status: "error", error: "Stopped", recipe: { preset: "watch", jobs: ["info", "media", "idea"] },
    jobs: [{ type: "info", status: "done" }, { type: "media", status: "done" }, { type: "idea", status: "error", error: "Stopped" }],
  });
const metaOf = (id: string) => readJson(path.join(igDir, id, "meta.json"));
afterEach(() => {
  ai.lag = 0;
  ai.answer = undefined;
  ai.hold = null;
  disk.hold = null;
});

describe("Stop in the Content Analyzer", () => {
  it("ends a post's running analysis as Stopped and keeps its files; one waiting for a computer too", async () => {
    const live = post({ status: "error", error: "Download failed", jobs: [{ type: "info", status: "done" }, { type: "media", status: "error", error: "Download failed" }] });
    expect((await send(`/${live}/retry`)).status).toBe(202);
    await vi.waitFor(() => expect(readJson(path.join(igDir, live, "meta.json")).status).toBe("processing"));
    expect((await stop(`/${live}/stop`)).status).toBe(200);
    await vi.waitFor(() => expect(readJson(path.join(igDir, live, "meta.json"))).toMatchObject({ status: "error", error: "Stopped" }));
    expect(existsSync(path.join(igDir, live, "info.json"))).toBe(true);

    const away = post({ status: "processing", step: "computer" });
    expect((await stop(`/${away}/stop`)).status).toBe(200);
    expect(readJson(path.join(igDir, away, "meta.json"))).toMatchObject({ status: "error", error: "Stopped" });
    expect((await stop(`/${randomUUID()}/stop`)).status).toBe(404);
  });

  it("ends an account's pull as Stopped", async () => {
    const id = randomUUID();
    const dir = path.join(igDir, "accounts", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id, igUserId: "", username: "tinyacrobatics", owner: "local", tags: [], counts: { fetchedAt: 0 }, status: "ready", progress: 1, createdAt: 1, updatedAt: 1 }));
    expect((await send(`/accounts/${id}/jobs`, { types: ["catalog"] })).status).toBe(202);
    expect((await stop(`/accounts/${id}/stop`)).status).toBe(200);
    await vi.waitFor(() => expect(readJson(path.join(dir, "meta.json"))).toMatchObject({ status: "error", error: "Stopped" }));
  });

  it("ends the idea board being found, and the next one runs", async () => {
    post({});
    const first = send("/ideas");
    await new Promise((r) => setTimeout(r, 50));
    expect((await stop("/ideas/stop")).status).toBe(200);
    const r = await first;
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "Stopped" });
    // the lock went with it: a new run starts (and is stopped in turn)
    const second = Promise.resolve(send("/ideas"));
    await new Promise((r) => setTimeout(r, 50));
    await stop("/ideas/stop");
    expect(await (await second).json()).toEqual({ error: "Stopped" });
  });

  it("a Retry after Stop runs to the end", async () => {
    const id = ideaPost();
    expect((await send(`/${id}/retry`)).status).toBe(202);
    await vi.waitFor(() => expect(metaOf(id).step).toBe("idea"));
    await stop(`/${id}/stop`);
    await vi.waitFor(() => expect(metaOf(id)).toMatchObject({ status: "error", error: "Stopped" }));
    ai.answer = { title: "Rainy day tumbles", takeaway: "Three tumbles indoors" };
    expect((await send(`/${id}/retry`)).status).toBe(202);
    await vi.waitFor(() => expect(metaOf(id)).toMatchObject({ status: "ready", idea: { title: "Rainy day tumbles" } }));
  });

  it("a Retry pressed while the stopped run still unwinds keeps its own run", async () => {
    ai.lag = 150;
    const id = ideaPost();
    expect((await send(`/${id}/retry`)).status).toBe(202);
    await vi.waitFor(() => expect(metaOf(id).step).toBe("idea"));
    await stop(`/${id}/stop`);
    expect((await send(`/${id}/retry`)).status).toBe(202);
    await settle(300); // the stopped run has ended by now
    expect(analyzerWork("local").some((w) => w.id === id)).toBe(true);
    // and it can be stopped in turn
    await stop(`/${id}/stop`);
    await vi.waitFor(() => expect(metaOf(id)).toMatchObject({ status: "error", error: "Stopped" }));
  });

  it("a Stop during a post's last writes keeps it Stopped", async () => {
    const id = offline();
    const held = holdWrite((file) => file.endsWith(path.join(id, "search.txt")));
    expect((await send(`/${id}/retry`)).status).toBe(202);
    await held.at;
    expect((await stop(`/${id}/stop`)).status).toBe(200);
    held.release();
    await settle();
    expect(metaOf(id)).toMatchObject({ status: "error", error: "Stopped" });
  });

  it("a Stop as the run ends Ready answers ok and leaves it Ready", async () => {
    const id = offline();
    const held = holdWrite((file, data) => file.includes(path.join(id, "meta.json")) /* written as a temp file, then renamed */ && String(data).includes('"status":"ready"'));
    expect((await send(`/${id}/retry`)).status).toBe(202);
    await held.at;
    expect((await stop(`/${id}/stop`)).status).toBe(200);
    held.release();
    await vi.waitFor(() => expect(metaOf(id).status).toBe("ready"));
  });

  it("an account pull whose step swallows the Stop still ends Stopped, not Ready", async () => {
    const id = randomUUID();
    const dir = path.join(igDir, "accounts", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id, igUserId: "", username: "tinyacrobatics", owner: "local", tags: [], counts: { fetchedAt: 0 }, status: "ready", progress: 1, createdAt: 1, updatedAt: 1 }));
    let answer!: () => void;
    ai.hold = new Promise<void>((r) => (answer = r));
    ai.answer = [{ id: "t1", label: "tumbles", kind: "topic", source: "ai" }];
    expect((await send(`/accounts/${id}/jobs`, { types: ["tags"] })).status).toBe(202);
    await vi.waitFor(() => expect(readJson(path.join(dir, "meta.json")).step).toBe("tags"));
    await stop(`/accounts/${id}/stop`);
    answer();
    await settle();
    expect(readJson(path.join(dir, "meta.json"))).toMatchObject({ status: "error", error: "Stopped" });
  });

  it("Find ideas right after Stop starts a new run, not the stopped one", async () => {
    ai.lag = 150;
    post({});
    const first = send("/ideas");
    await settle(50);
    await stop("/ideas/stop");
    const second = Promise.resolve(send("/ideas"));
    // the stopped run fails at 150 ms; a new run is still finding ideas then
    expect(await Promise.race([second.then(() => "answered"), settle(300).then(() => "running")])).toBe("running");
    await stop("/ideas/stop");
    expect(await (await second).json()).toEqual({ error: "Stopped" });
    expect((await first).status).toBe(400);
  });
});
