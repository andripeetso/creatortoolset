import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "./auth";

// Stop on the Content Analyzer: a post's analysis, an account's pull and the idea board end as "Stopped", and what they
// had stays.

const dataDir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "ig-stop-"));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = ""; // background work runs as the local user
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

// every read of the network hangs, so a run is still going when Stop is pressed
vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
// the AI hangs until its run is stopped
vi.mock("./ai-complete", async (real) => ({
  ...(await real<typeof import("./ai-complete")>()),
  anyAiConfigured: () => true,
  completeWithFallback: (_system: string, _user: string, signal: AbortSignal) =>
    new Promise((_, fail) => signal.addEventListener("abort", () => fail(new Error("aborted")))),
}));

const { instagramApp } = await import("./instagram");
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
    const second = send("/ideas");
    await new Promise((r) => setTimeout(r, 50));
    await stop("/ideas/stop");
    expect(await (await second).json()).toEqual({ error: "Stopped" });
  });
});
