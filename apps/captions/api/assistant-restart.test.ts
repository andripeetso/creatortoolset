import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// A restart of the server (a deploy) while the Mac writes a reply: the reply goes on in the new process.
// "Restart" here = every module loaded again over the same DATA_DIR, as a new process would find it.
const DATA = (process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "assistant-restart-")));
process.env.APP_SECRET = "assistant-test-secret";

type View = import("../contracts/assistant").AssistantView;
type Job = { id: string; user: string; asks?: boolean; mcp: { token: string } };
const json = (body: unknown, extra: Record<string, string> = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** The server as a new process finds it: fresh modules, nothing in memory, the same files. */
async function boot() {
  vi.resetModules();
  const app = (await import("./boot")).default;
  const assistant = await import("./assistant");
  assistant.resumeFromDisk(); // what boot.ts does before it listens (not under tests)
  return { app, ...(await import("./users")), ...(await import("./lib/devices")), ...(await import("./lib/providers")), ...(await import("./lib/mac-claude")), ...(await import("../contracts/providers")) };
}
type Server = Awaited<ReturnType<typeof boot>>;

/** An account with its own Mac running Claude Code; `on(server)` is that person and that Mac talking to one server process. */
async function person(s: Server, name: string) {
  s.createUser(name, "password1");
  const mac = s.pairDevice(name, `${name}'s Mac`);
  await s.saveSettings({ ...structuredClone(s.DEFAULT_SETTINGS), instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: mac.device.id }] }, name);
  const login = await s.app.request("/api/auth/login", json({ username: name, password: "password1" }));
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const device = { authorization: `Bearer ${mac.token}` };
  return (on: Server) => ({
    send: (text: string) => on.app.request("/api/assistant/turn", json({ text }, { cookie })),
    stop: () => on.app.request("/api/assistant/stop", json({}, { cookie })),
    claim: async () => (await (await on.app.request("/api/devices/relay/wait", json({}, device))).json()) as Job,
    relay: (id: string, what: string, body: unknown) => on.app.request(`/api/devices/relay/${id}/${what}`, json(body, device)),
    tools: (token: string) => on.app.request("/api/mcp", json({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: `Bearer ${token}` })),
    reply: async () => ((await (await on.app.request("/api/assistant", { headers: { cookie } })).json()) as View).messages.at(-1)!,
  });
}

describe("a restart of the server while the Mac writes a reply", () => {
  it("the reply goes on: the same request, the same tools, its text and its end land in the chat", async () => {
    const before = await boot();
    const ana = await person(before, "ana");
    await ana(before).send("What failed?");
    const job = await ana(before).claim();
    expect((await ana(before).relay(job.id, "text", { text: "Looking" })).status).toBe(200);
    expect((await ana(before).tools(job.mcp.token)).status).toBe(200);
    // what is kept for the restart names the request and its reply: never the prompt or the token
    const kept = readdirSync(path.join(DATA, "mac-claude-open")).map((f) => readFileSync(path.join(DATA, "mac-claude-open", f), "utf-8")).join("") + readFileSync(path.join(DATA, "job-tokens.json"), "utf-8");
    expect(kept).toContain(job.id);
    expect(kept).not.toContain(job.mcp.token);
    expect(kept).not.toContain("What failed?");
    // a deploy needn't wait for this reply: a restart doesn't lose it
    expect(await (await before.app.request("/api/health")).json()).toMatchObject({ answering: 0 });
    await tick(1100); // the old process's last save of the chat

    const after = await boot();
    expect(await ana(after).reply()).toMatchObject({ status: "thinking", text: "Looking" });
    // the Mac noticed nothing: its next posts find the request, and its tools still open
    expect((await ana(after).relay(job.id, "text", { text: "Looking at the edit" })).status).toBe(200);
    expect((await ana(after).tools(job.mcp.token)).status).toBe(200);
    expect(await ana(after).reply()).toMatchObject({ status: "thinking", text: "Looking at the edit" });
    expect((await ana(after).relay(job.id, "done", { text: "Version V1A failed.", usage: { input: 10, output: 5, cost_usd: 0.1 } })).status).toBe(200);
    await tick();
    expect(await ana(after).reply()).toMatchObject({ status: "done", text: "Version V1A failed." });
    // ended: nothing is kept, and the token no longer opens the tools
    expect(readdirSync(path.join(DATA, "mac-claude-open"))).toEqual([]);
    expect((await ana(after).tools(job.mcp.token)).status).toBe(401);
    expect(Object.values(await after.macUsageSince(Date.now() - 3_600_000))).toMatchObject([{ Assistant: { calls: 1, tokens: 15 } }]);
  });

  it("Stop still stops it, and a permission question still reaches the person", async () => {
    const before = await boot();
    const ben = await person(before, "ben");
    await ben(before).send("Tidy my folder");
    const job = await ben(before).claim();
    expect(job.asks).toBe(true);
    await tick(1100);

    const after = await boot();
    const ask = await ben(after).relay(job.id, "ask", { ask_id: "toolu_1", tool: "Bash", description: "List the folder", detail: "ls" });
    expect(await ask.json()).toEqual({ status: "waiting" });
    expect((await ben(after).reply()).approvals).toMatchObject([{ id: "toolu_1", status: "waiting" }]);
    expect((await ben(after).stop()).status).toBe(200);
    await tick();
    expect(await ben(after).reply()).toMatchObject({ status: "done", text: "*Stopped.*" });
    expect((await ben(after).relay(job.id, "text", { text: "late" })).status).toBe(404); // the Mac stops
  });

  it("a reply no Mac had started on says the server restarted, in words", async () => {
    const before = await boot();
    const cy = await person(before, "cy");
    await cy(before).send("Hello");
    await tick(); // sent, waiting for its Mac: nothing runs anywhere yet

    const after = await boot();
    expect(await cy(after).reply()).toMatchObject({ status: "error", text: "The server restarted while this was being written. Send your message again." });
  });

  it("an answer whose caller can't take it up again is dropped: the Mac is told to stop", async () => {
    const before = await boot();
    before.createUser("dee", "password1");
    const mac = before.pairDevice("dee", "Dee's Mac");
    const device = { authorization: `Bearer ${mac.token}` };
    const provider = { instance: "claude", driver: "claude" as const, model: "claude-opus-5-5", effort: "high" as const, device: mac.device.id, scope: "workspace" as const };
    const plain = before.streamMacClaude("sys", "one", undefined, () => {}, undefined, { provider });
    plain.catch(() => {});
    const orphan = before.streamMacClaude("sys", "two", undefined, () => {}, undefined, { provider, keep: { kind: "nobody" } });
    orphan.catch(() => {});
    const claim = async () => ((await (await before.app.request("/api/devices/relay/wait", json({}, device))).json()) as Job).id;
    const ids = [await claim(), await claim()];
    await tick(200); // the pairing is on disk
    // the first one streams to its caller alone: a deploy waits for it
    expect(await (await before.app.request("/api/health")).json()).toMatchObject({ answering: 1 });

    const after = await boot();
    for (const id of ids) expect((await after.app.request(`/api/devices/relay/${id}/text`, json({ text: "x" }, device))).status).toBe(404);
    expect(readdirSync(path.join(DATA, "mac-claude-open"))).toEqual([]);
  });
});
