import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "assistant-"));
process.env.APP_SECRET = "assistant-test-secret";

const { createUser, newApiKey } = await import("./users");
const app = (await import("./boot")).default;
const { mintJobToken, jobTokenUser, revokeJobToken, JOB_TOKEN_MS } = await import("./auth");
const { pairDevice } = await import("./lib/devices");
const { saveSettings } = await import("./lib/providers");
const { DEFAULT_SETTINGS } = await import("../contracts/providers");

const ana = createUser("ana", "password1");
const noAi = createUser("nico", "password1");
const fullKey = `Bearer ${newApiKey(ana, "full")}`;

const cookieOf = async (username: string) => {
  const r = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "password1" }) });
  return r.headers.get("set-cookie")!.split(";")[0]!;
};

/** Ana's Mac, paired and running Claude Code as her own provider. */
const mac = pairDevice("ana", "Ana's Mac");
await saveSettings(
  { ...structuredClone(DEFAULT_SETTINGS), instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: mac.device.id }] },
  "ana",
);

const json = (body: unknown, extra: Record<string, string> = {}) => ({ headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
const rpc = (token: string, name: string, args: Record<string, unknown> = {}) =>
  app.request("/api/mcp", { method: "POST", ...json({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { authorization: `Bearer ${token}` }) });
/** A tool's answer as text; a refused call (401 from the gate, no JSON-RPC result) counts as an error. */
const toolOf = async (token: string, name: string, args: Record<string, unknown> = {}) => {
  const r = (await (await rpc(token, name, args)).json()) as { result?: { content: Array<{ text: string }>; isError?: boolean }; error?: unknown };
  if (!r.result) return { error: true, text: JSON.stringify(r) };
  return { error: !!r.result.isError, text: r.result.content[0]!.text };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("the assistant's job token", () => {
  it("opens /api/mcp and nothing else, and not a Full key's routes", async () => {
    const token = mintJobToken("ana", "turn-1");
    expect(token).toMatch(/^ctj_[a-f0-9]{48}$/);
    const job = `Bearer ${token}`;
    expect((await app.request("/api/mcp", { method: "POST", ...json({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: job }) })).status).toBe(200);
    // not a Full key, so never a key that could rotate: and nothing outside /api/mcp
    expect((await app.request("/api/workshop/projects", { headers: { authorization: job } })).status).toBe(401);
    expect((await app.request("/api/service-keys", { headers: { authorization: job } })).status).toBe(401);
    expect((await app.request("/api/providers", { headers: { authorization: job } })).status).toBe(401);
    expect((await app.request("/api/devices", { headers: { authorization: job } })).status).toBe(401);
    expect((await app.request("/api/my-keys/DEEPGRAM_API_KEY", { method: "PUT", ...json({ value: "x" }, { authorization: job }) })).status).toBe(401);
    expect((await app.request("/api/assistant", { headers: { authorization: job } })).status).toBe(401);
    revokeJobToken(token);
  });

  it("is refused once it expires or is revoked, and a Full key still works", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const token = mintJobToken("ana", "turn-2");
    expect(jobTokenUser(`Bearer ${token}`)?.username).toBe("ana");
    vi.setSystemTime(Date.now() + JOB_TOKEN_MS + 1000);
    expect(jobTokenUser(`Bearer ${token}`)).toBeNull();
    expect((await app.request("/api/mcp", { method: "POST", ...json({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: `Bearer ${token}` }) })).status).toBe(401);
    vi.useRealTimers();
    const live = mintJobToken("ana", "turn-3");
    revokeJobToken(live);
    expect(jobTokenUser(`Bearer ${live}`)).toBeNull();
    expect((await app.request("/api/mcp", { method: "POST", ...json({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: fullKey }) })).status).toBe(200);
  });

  it("the assistant tools are for the job alone, and the Full key doesn't see them", async () => {
    const list = (await (await app.request("/api/mcp", { method: "POST", ...json({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: fullKey }) })).json()) as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map((t) => t.name)).not.toContain("navigate");
    expect((await toolOf(newApiKey(ana, "full"), "navigate", { path: "/workshop" })).error).toBe(true);
  });
});

describe("before an AI is connected", () => {
  it("no model call, no job, and the dock says to connect one", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    process.env.ANTHROPIC_API_KEY = "sk-test-not-used";
    const cookie = await cookieOf("nico");
    const view = (await (await app.request("/api/assistant", { headers: { cookie } })).json()) as { provider: string; messages: unknown[] };
    expect(view.provider).toBe("none");
    const r = await app.request("/api/assistant/turn", { method: "POST", ...json({ text: "hello" }, { cookie }) });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { code: string }).code).toBe("NO_PROVIDER");
    expect(spy).not.toHaveBeenCalled();
    delete process.env.ANTHROPIC_API_KEY;
    spy.mockRestore();
  });

  it("another provider than Claude Code is refused with no model call", async () => {
    const nicoMac = pairDevice("nico", "Nico's Mac");
    await saveSettings({ ...structuredClone(DEFAULT_SETTINGS), instances: [{ id: "codex", driver: "codex", name: "Codex", enabled: true, device: nicoMac.device.id }], default: { instance: "codex", model: "gpt-x", effort: "high" } }, "nico");
    const cookie = await cookieOf("nico");
    const r = await app.request("/api/assistant/turn", { method: "POST", ...json({ text: "hello" }, { cookie }) });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { code: string }).code).toBe("NOT_CLAUDE");
  });
});

describe("the dock's prompt", () => {
  it("carries facts about the app and its tools, no writing or style rules", async () => {
    const { SYSTEM } = await import("./assistant");
    expect(SYSTEM).toContain("Creator Toolset");
    expect(SYSTEM).toContain("ask_secret");
    expect(SYSTEM).not.toMatch(/one sentence|one step|one thing/i);
  });
});

describe("a turn", () => {
  it("queues a relay job with mcp set, and the Mac's answer lands; the token is revoked after", async () => {
    const cookie = await cookieOf("ana");
    const r = await app.request("/api/assistant/turn", { method: "POST", ...json({ text: "Set me up" }, { cookie }) });
    expect(r.status).toBe(202);
    const wait = await app.request("/api/devices/relay/wait", { method: "POST", ...json({}, { authorization: `Bearer ${mac.token}` }) });
    expect(wait.status).toBe(200);
    const job = (await wait.json()) as { id: string; mcp?: { url: string; token: string }; user: string };
    expect(job.mcp?.url).toMatch(/\/api\/mcp$/);
    expect(job.mcp?.token).toMatch(/^ctj_/);
    expect(job.user).toContain("Set me up");
    expect(job.user).not.toContain(job.mcp!.token);
    // the job's token opens the MCP tools for this account
    expect((await toolOf(job.mcp!.token, "setup_status")).error).toBe(false);
    // each tool it uses shows under the reply as it works; the same tool again stays one line
    await toolOf(job.mcp!.token, "setup_status");
    await toolOf(job.mcp!.token, "navigate", { path: "/review" });
    const working = (await (await app.request("/api/assistant", { headers: { cookie } })).json()) as { messages: Array<{ steps?: string[] }> };
    expect(working.messages.at(-1)?.steps).toEqual(["Checking what's set up", "Opening Review"]);
    const done = await app.request(`/api/devices/relay/${job.id}/done`, { method: "POST", ...json({ text: "Hello, let's start." }, { authorization: `Bearer ${mac.token}` }) });
    expect(done.status).toBe(200);
    const view = (await (await app.request("/api/assistant", { headers: { cookie } })).json()) as { messages: Array<{ role: string; text: string; status?: string }> };
    expect(view.messages.at(-1)).toMatchObject({ role: "assistant", text: "Hello, let's start.", status: "done" });
    expect((await toolOf(job.mcp!.token, "setup_status")).error).toBe(true);
    const onDisk = readFileSync(path.join(process.env.DATA_DIR!, "assistant", "ana.json"), "utf-8");
    expect(onDisk).not.toContain(job.mcp!.token);
  });
});

describe("history", () => {
  it("New chat keeps the old one; it opens again (the current one kept in its place) and deletes for good", async () => {
    const cookie = await cookieOf("ana");
    const get = async (r: Promise<Response> | Response) => (await (await r).json()) as { messages: Array<{ text: string }>; past: Array<{ id: string; title: string; count: number }> };
    const before = await get(app.request("/api/assistant", { headers: { cookie } }));
    expect(before.messages.length).toBeGreaterThan(0);
    const fresh = await get(app.request("/api/assistant", { method: "DELETE", headers: { cookie } }));
    expect(fresh.messages).toEqual([]);
    const kept = fresh.past[0]!;
    expect(kept.count).toBe(before.messages.length);
    expect(kept.title).toBe(before.messages.find((m) => (m as { role?: string }).role === "user")!.text);
    // a new chat with nothing in it isn't kept
    expect((await get(app.request("/api/assistant", { method: "DELETE", headers: { cookie } }))).past.length).toBe(fresh.past.length);
    const back = await get(app.request(`/api/assistant/past/${kept.id}/open`, { method: "POST", headers: { cookie } }));
    expect(back.messages.map((m) => m.text)).toEqual(before.messages.map((m) => m.text));
    expect(back.past.find((p) => p.id === kept.id)).toBeUndefined();
    await app.request("/api/assistant", { method: "DELETE", headers: { cookie } });
    const again = await get(app.request("/api/assistant", { headers: { cookie } }));
    const gone = await get(app.request(`/api/assistant/past/${again.past[0]!.id}`, { method: "DELETE", headers: { cookie } }));
    expect(gone.past.length).toBe(again.past.length - 1);
    expect((await app.request(`/api/assistant/past/${again.past[0]!.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(404);
  });
});

describe("stop", () => {
  it("stops the running reply: it ends as stopped and the next message can go", async () => {
    const cookie = await cookieOf("ana");
    expect((await app.request("/api/assistant/turn", { method: "POST", ...json({ text: "Long one" }, { cookie }) })).status).toBe(202);
    const r = await app.request("/api/assistant/stop", { method: "POST", headers: { cookie } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { messages: Array<{ text: string; status?: string }> }).messages.at(-1)).toMatchObject({ text: "*Stopped.*", status: "done" });
    expect((await app.request("/api/assistant/stop", { method: "POST", headers: { cookie } })).status).toBe(404);
    expect((await app.request("/api/assistant/turn", { method: "POST", ...json({ text: "Next" }, { cookie }) })).status).toBe(202);
    await app.request("/api/assistant/stop", { method: "POST", headers: { cookie } });
  });
});

describe("ask_secret and navigate", () => {
  it("ask_secret never stores or forwards a value; the saved key is recorded as its last four", async () => {
    const token = mintJobToken("ana", "turn-secret");
    const asked = await toolOf(token, "ask_secret", { env: "DEEPGRAM_API_KEY", why: "transcripts", value: "sk-LEAK-value-ab12" });
    expect(asked.error).toBe(false);
    expect(asked.text).not.toContain("LEAK");
    expect((await toolOf(token, "ask_secret", { env: "NOT_A_KEY", why: "x" })).error).toBe(true);
    const cookie = await cookieOf("ana");
    const pending = (await (await app.request("/api/assistant", { headers: { cookie } })).text());
    expect(pending).toContain("DEEPGRAM_API_KEY");
    expect(pending).not.toContain("LEAK");
    // the dock saves the key itself, straight to my-keys
    await app.request("/api/my-keys/DEEPGRAM_API_KEY", { method: "PUT", ...json({ value: "sk-SAVED-key-ab12" }, { cookie }) });
    const saved = await app.request("/api/assistant/saved", { method: "POST", ...json({ env: "DEEPGRAM_API_KEY" }, { cookie }) });
    const body = await saved.text();
    expect(body).toContain("Deepgram key saved (…ab12)");
    expect(body).not.toContain("SAVED-key");
    const onDisk = readFileSync(path.join(process.env.DATA_DIR!, "assistant", "ana.json"), "utf-8");
    expect(onDisk).not.toContain("LEAK");
    expect(onDisk).not.toContain("SAVED-key");
    revokeJobToken(token);
  });

  it("navigate takes only a relative path of this app", async () => {
    const token = mintJobToken("ana", "turn-nav");
    for (const bad of ["https://evil.example/x", "//evil.example", "/\\evil.example", "javascript:alert(1)", "workshop", "/a b"]) {
      expect((await toolOf(token, "navigate", { path: bad })).error, bad).toBe(true);
    }
    const ok = await toolOf(token, "navigate", { path: "/workshop/sessions/abc?tab=1" });
    expect(ok.error).toBe(false);
    expect(ok.text).toContain("/workshop/sessions/abc?tab=1");
    const cookie = await cookieOf("ana");
    expect(((await (await app.request("/api/assistant", { headers: { cookie } })).json()) as { navigate: string }).navigate).toBe("/workshop/sessions/abc?tab=1");
    await app.request("/api/assistant/navigated", { method: "POST", headers: { cookie } });
    expect(((await (await app.request("/api/assistant", { headers: { cookie } })).json()) as { navigate: string | null }).navigate).toBeNull();
    revokeJobToken(token);
  });
});
