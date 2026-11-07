import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AuthVars } from "./auth";
import type { SessionUser } from "./users";

const dir = mkdtempSync(path.join(tmpdir(), "my-keys-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "test-secret-123"; // accounts on; boots the "admin" account
const { createUser } = await import("./users");
const { keyFor, myKeysApp, saveMyKey } = await import("./my-keys");
const { transcribeApp, cloudTranscribeBlock } = await import("./transcribe");
const { aiFor } = await import("./ai-complete");
createUser("lee", "password1");

describe("keyFor: whose key pays", () => {
  it("own key wins; the server's key only for the admin, never for another account or a share-link visitor", () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "server-dg");
    // an account with no key: nothing, and the message says where to add one
    expect(keyFor("lee", "DEEPGRAM_API_KEY")).toEqual({ key: "", missing: "Add your Deepgram key in Settings → My API keys" });
    // their own key wins
    saveMyKey("lee", "DEEPGRAM_API_KEY", "lee-dg-1234");
    expect(keyFor("lee", "DEEPGRAM_API_KEY")).toEqual({ key: "lee-dg-1234" });
    expect(statSync(path.join(dir, "my-keys", "lee.json")).mode & 0o777).toBe(0o600);
    // the platform admin: the server's
    expect(keyFor({ username: "admin", role: "admin" }, "DEEPGRAM_API_KEY")).toEqual({ key: "server-dg" });
    // nobody named, or a visitor on a share link: never the server's
    expect(keyFor(undefined, "DEEPGRAM_API_KEY").key).toBe("");
    expect(keyFor({ username: "visitor", role: "visitor" }, "DEEPGRAM_API_KEY").key).toBe("");
  });

  it("the server's Anthropic key is never an admin's AI", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "server-ai");
    const admin = { username: "admin", role: "admin" as const };
    // no provider of their own: no AI, and it says where to add one
    expect(aiFor(admin, "captions", "Caption Studio")).toEqual({ only: [], off: expect.stringMatching(/^No AI provider for your account: add one in Settings → AI providers/) });
    expect(keyFor(admin, "ANTHROPIC_API_KEY").key).toBe("");
    // their own key is their choice
    saveMyKey("admin", "ANTHROPIC_API_KEY", "admin-own-1234");
    expect(aiFor(admin, "captions", "Caption Studio")).toMatchObject({ only: ["anthropic"], apiKey: "admin-own-1234" });
    saveMyKey("admin", "ANTHROPIC_API_KEY", null);
  });

  it("Settings → My API keys never sends a key back, and is not for a share-link visitor", async () => {
    let who: SessionUser = { username: "lee", role: "user", cloud: true, off: [] };
    const app = new Hono<{ Variables: AuthVars }>();
    app.use("*", async (c, next) => (c.set("user", who), next()));
    app.route("/", myKeysApp);
    const put = (env: string, value: unknown) => app.request(`/${env}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }) });
    const value = ["not", "real", "9876"].join("-");
    expect((await put("PERPLEXITY_API_KEY", value)).status).toBe(200);
    expect((await put("LIBRARY_S3_SECRET_KEY", "x")).status).toBe(404);
    const body = await (await app.request("/")).text();
    expect(body).not.toContain(value);
    expect(JSON.parse(body).find((k: { env: string }) => k.env === "PERPLEXITY_API_KEY")).toMatchObject({ set: true, last4: "9876" });
    expect((await put("PERPLEXITY_API_KEY", null)).status).toBe(200);
    expect(keyFor("lee", "PERPLEXITY_API_KEY").key).toBe("");
    who = { username: "visitor", role: "visitor", cloud: false, off: [] };
    expect((await app.request("/")).status).toBe(403);
  });

  it("transcription: an account without a key is told which key to add, and nothing reaches Deepgram", async () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "server-dg");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const kim: SessionUser = { username: "kim", role: "user", cloud: true, off: [] };
    const app = new Hono<{ Variables: AuthVars }>();
    app.use("*", async (c, next) => (c.set("user", kim), next()));
    app.route("/", transcribeApp);
    expect(await (await app.request("/available")).json()).toMatchObject({ available: false, why: "Add your Deepgram key in Settings → My API keys" });
    const res = await app.request("/", { method: "POST", headers: { "content-type": "audio/wav" }, body: new Uint8Array(100) });
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "Add your Deepgram key in Settings → My API keys", code: "NEEDS_KEY" });
    expect(fetchMock).not.toHaveBeenCalled();
    // the Analyzer's and Clips' transcripts say the same
    expect(cloudTranscribeBlock(kim)).toBe("Add your Deepgram key in Settings → My API keys");
    vi.unstubAllGlobals();
  });
});
