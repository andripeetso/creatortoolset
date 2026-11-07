import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AuthVars } from "./auth";
import type { SessionUser } from "./users";

const dir = mkdtempSync(path.join(tmpdir(), "my-keys-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "test-secret-123"; // accounts on; boots the "admin" account
const member = (username: string, ai: "own" | "budget", budgetUsd = 0) => ({ username, role: "member", ai, budgetUsd, joinedAt: 1 });
writeFileSync(
  path.join(dir, "workspaces.json"),
  JSON.stringify({
    workspaces: [{ id: "w1", name: "Tiny Acrobatics", plan: "team", comped: false, createdAt: 1, members: [{ ...member("admin", "own"), role: "owner" }, member("mia", "budget", 5), member("lee", "own")] },
      // a signed-up account's own team: its owner is no platform admin, so a budget here has nothing to pay with
      { id: "w2", name: "Tiny Fans", plan: "team", comped: false, createdAt: 1, members: [{ ...member("nina", "own"), role: "owner" }, member("omar", "budget", 50)] }],
    invites: [],
    spend: {},
  }),
);
const { createUser } = await import("./users");
const { keyFor, myKeysApp, saveMyKey } = await import("./my-keys");
const { addSpend, createInvite, updateMember, workspaceById } = await import("./lib/workspaces");
const { saveSettings } = await import("./lib/providers");
const { DEFAULT_SETTINGS } = await import("../contracts/providers");
const { transcribeApp, cloudTranscribeBlock } = await import("./transcribe");
const { aiFor } = await import("./ai-complete");
createUser("mia", "password1");
createUser("lee", "password1");
createUser("nina", "password1");
createUser("omar", "password1");

describe("keyFor: whose key pays", () => {
  it("own key wins; the server's key only for the admin, a budget member (billed) or a guest switched on", async () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "server-dg");
    vi.stubEnv("NVIDIA_API_KEY", "server-nv");
    // member, no key, no budget: nothing, and the message says where to add one
    expect(keyFor("lee", "DEEPGRAM_API_KEY")).toEqual({ key: "", missing: "Add your Deepgram key in Settings → My API keys" });
    // their own key wins
    saveMyKey("lee", "DEEPGRAM_API_KEY", "lee-dg-1234");
    expect(keyFor("lee", "DEEPGRAM_API_KEY")).toEqual({ key: "lee-dg-1234" });
    expect(statSync(path.join(dir, "my-keys", "lee.json")).mode & 0o777).toBe(0o600);
    // the platform admin: the server's
    expect(keyFor({ username: "admin", role: "admin" }, "DEEPGRAM_API_KEY")).toEqual({ key: "server-dg" });
    // a budget member: the server's, billed to them, for what the budget can price; never audio
    expect(keyFor("mia", "DEEPGRAM_API_KEY")).toEqual({ key: "server-dg", bill: "mia" });
    expect(keyFor("mia", "NVIDIA_API_KEY").missing).toMatch(/Add your NVIDIA key/);
    addSpend("mia", 5);
    expect(keyFor("mia", "DEEPGRAM_API_KEY").missing).toMatch(/budget for this month is used up/);
    // nobody named: never the server's
    expect(keyFor(undefined, "DEEPGRAM_API_KEY").key).toBe("");
    // guests and the demo: only when an admin switched them on
    const guest: SessionUser = { username: "guest-0123456789ab", role: "guest", cloud: false, off: [] };
    expect(keyFor(guest, "DEEPGRAM_API_KEY").key).toBe("");
    expect(keyFor("demo-0123456789ab", "DEEPGRAM_API_KEY").key).toBe("");
    await saveSettings({ ...DEFAULT_SETTINGS, api: { ...DEFAULT_SETTINGS.api, guests: true } });
    expect(keyFor(guest, "DEEPGRAM_API_KEY")).toEqual({ key: "server-dg" });
    expect(keyFor("demo-0123456789ab", "DEEPGRAM_API_KEY").key).toBe("");
  });

  it("an API budget spends the server's keys only in the platform admin's workspace", () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "server-dg");
    vi.stubEnv("ANTHROPIC_API_KEY", "server-ai");
    // a budget set in someone else's workspace (before this check, or by hand): never the server's key
    expect(keyFor("omar", "DEEPGRAM_API_KEY")).toEqual({ key: "", missing: "Add your Deepgram key in Settings → My API keys" });
    expect(keyFor("omar", "ANTHROPIC_API_KEY").key).toBe("");
    // and its owner can't give one, to a member, to themselves, or in an invite
    const w2 = workspaceById("w2")!;
    expect(() => updateMember(w2, "omar", "owner", { ai: "budget", budgetUsd: 10_000 })).toThrow(/only the server admin's workspace/);
    expect(() => updateMember(w2, "nina", "owner", { ai: "budget" })).toThrow(/only the server admin's workspace/);
    expect(() => createInvite(w2, { username: "nina", role: "owner" }, { ai: "budget", budgetUsd: 10_000 })).toThrow(/only the server admin's workspace/);
    expect(keyFor("nina", "DEEPGRAM_API_KEY").key).toBe("");
    // the admin's workspace still can
    expect(() => updateMember(workspaceById("w1")!, "lee", "owner", { ai: "own" })).not.toThrow();
  });

  it("the server's Anthropic key is never an admin's AI; guests switched on and budget members still get it", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "server-ai");
    await saveSettings({ ...DEFAULT_SETTINGS, api: { ...DEFAULT_SETTINGS.api, guests: true } });
    const admin = { username: "admin", role: "admin" as const };
    // no provider of their own: no AI, and it says where to add one
    expect(aiFor(admin, "captions", "Caption Studio")).toEqual({ only: [], off: expect.stringMatching(/^No AI provider for your account: add one in Settings → AI providers/) });
    expect(keyFor(admin, "ANTHROPIC_API_KEY").key).toBe("");
    // their own key is their choice
    saveMyKey("admin", "ANTHROPIC_API_KEY", "admin-own-1234");
    expect(aiFor(admin, "captions", "Caption Studio")).toMatchObject({ only: ["anthropic"], apiKey: "admin-own-1234" });
    saveMyKey("admin", "ANTHROPIC_API_KEY", null);
    // the server's key still serves a guest when switched on, and a budget member, billed to them
    expect(aiFor({ username: "guest-0123456789ab", role: "guest" }, "captions", "Caption Studio")).toMatchObject({ only: ["anthropic"], apiKey: "server-ai" });
    updateMember(workspaceById("w1")!, "mia", "owner", { budgetUsd: 100 });
    expect(aiFor("mia", "captions", "Caption Studio")).toMatchObject({ only: ["anthropic"], apiKey: "server-ai", bill: "mia" });
  });

  it("Settings → My API keys never sends a key back, and is not for guests", async () => {
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
    who = { username: "guest-0123456789ab", role: "guest", cloud: false, off: [] };
    expect((await app.request("/")).status).toBe(403);
  });

  it("transcription: a member without a key is told which key to add, and nothing reaches Deepgram", async () => {
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
