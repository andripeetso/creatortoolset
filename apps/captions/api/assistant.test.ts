import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { copyFile } from "node:fs/promises";
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

/** The newest "assistant" notice this account's open docks were sent (the change stream's hello, api/lib/sync.ts). */
const noticed = async (cookie: string) => {
  const reader = (await app.request("/api/sync/events", { headers: { cookie } })).body!.getReader();
  const hello = new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  return (JSON.parse(/^data: (.*)$/m.exec(hello)![1]!) as { topics: Record<string, number> }).topics.assistant ?? 0;
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

  it("a Codex-only user gets an answer with the app's tools: a job token for the turn, revoked after, and no asks", async () => {
    const { NO_TOOLS_NOTE } = await import("./assistant");
    const nicoMac = pairDevice("nico", "Nico's Mac");
    const ai = (driver: string, name: string) => saveSettings({ ...structuredClone(DEFAULT_SETTINGS), instances: [{ id: driver, driver, name, enabled: true, device: nicoMac.device.id }], default: { instance: driver, model: "gpt-x", effort: "high" } }, "nico");
    await ai("codex", "Codex");
    const cookie = await cookieOf("nico");
    const r = await app.request("/api/assistant/turn", { method: "POST", ...json({ text: "hello" }, { cookie }) });
    expect(r.status).toBe(202);
    const device = { authorization: `Bearer ${nicoMac.token}` };
    type Job = { id: string; driver?: string; model?: string; system: string; mcp?: { url: string; token: string }; asks?: boolean };
    const job = (await (await app.request("/api/devices/relay/wait", { method: "POST", ...json({}, device) })).json()) as Job;
    expect(job.driver).toBe("codex");
    expect(job.model).toBe("gpt-x");
    expect(job.mcp?.url).toMatch(/\/api\/mcp$/);
    expect(jobTokenUser(`Bearer ${job.mcp!.token}`)?.username).toBe("nico");
    expect(job.asks).toBeUndefined();
    expect(job.system).not.toContain(NO_TOOLS_NOTE.trim());
    // the dock shows no "· no app tools" (AssistantDock: only for an AI with none)
    expect(((await (await app.request("/api/assistant", { headers: { cookie } })).json()) as { aiName: string; tools: boolean })).toMatchObject({ aiName: "Codex", tools: true });
    await app.request(`/api/devices/relay/${job.id}/done`, { method: "POST", ...json({ text: "Hi from Codex." }, device) });
    // the turn's reply is written once its promise settles, a tick after the Mac's answer
    let last: { role: string; text: string; status?: string } | undefined;
    for (let i = 0; i < 50 && last?.status !== "done"; i++) {
      await new Promise((res) => setTimeout(res, 20));
      last = ((await (await app.request("/api/assistant", { headers: { cookie } })).json()) as { messages: Array<{ role: string; text: string; status?: string }> }).messages.at(-1);
    }
    expect(last).toMatchObject({ role: "assistant", text: "Hi from Codex.", status: "done" });
    expect(jobTokenUser(`Bearer ${job.mcp!.token}`)).toBeNull();
    // Gemini CLI and Grok get the app's tools the same way: a job token for the turn, no asks
    for (const [driver, name] of [["gemini", "Gemini"], ["grok", "Grok"]]) {
      await ai(driver, name);
      await app.request("/api/assistant/turn", { method: "POST", ...json({ text: `hello ${driver}` }, { cookie }) });
      const turn = (await (await app.request("/api/devices/relay/wait", { method: "POST", ...json({}, device) })).json()) as Job;
      expect(turn).toMatchObject({ driver });
      expect(jobTokenUser(`Bearer ${turn.mcp!.token}`)?.username).toBe("nico");
      expect(turn.asks).toBeUndefined();
      expect(turn.system).not.toContain(NO_TOOLS_NOTE.trim());
      await app.request(`/api/devices/relay/${turn.id}/done`, { method: "POST", ...json({ text: "Hi." }, device) });
      await vi.waitFor(() => expect(jobTokenUser(`Bearer ${turn.mcp!.token}`)).toBeNull());
    }
    // an AI with no tools (OpenCode) answers from the message alone: no token, the note, and the dock says so
    await ai("opencode", "OpenCode");
    await app.request("/api/assistant/turn", { method: "POST", ...json({ text: "hello again" }, { cookie }) });
    const plain = (await (await app.request("/api/devices/relay/wait", { method: "POST", ...json({}, device) })).json()) as Job;
    expect(plain.mcp).toBeUndefined();
    expect(plain.system).toContain(NO_TOOLS_NOTE.trim());
    expect(((await (await app.request("/api/assistant", { headers: { cookie } })).json()) as { tools: boolean }).tools).toBe(false);
    await app.request(`/api/devices/relay/${plain.id}/done`, { method: "POST", ...json({ text: "Hi." }, device) });
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
    const sent = await noticed(cookie);
    await toolOf(job.mcp!.token, "setup_status");
    await toolOf(job.mcp!.token, "navigate", { path: "/review" });
    const working = (await (await app.request("/api/assistant", { headers: { cookie } })).json()) as { messages: Array<{ steps?: string[] }> };
    expect(working.messages.at(-1)?.steps).toEqual(["Checking what's set up", "Opening Review"]);
    // the dock is told as the reply is written and when it ends, with no request of its own: it never asks on a timer
    const written = await noticed(cookie);
    expect(written).toBeGreaterThan(sent);
    const done = await app.request(`/api/devices/relay/${job.id}/done`, { method: "POST", ...json({ text: "Hello, let's start." }, { authorization: `Bearer ${mac.token}` }) });
    expect(done.status).toBe(200);
    const view = (await (await app.request("/api/assistant", { headers: { cookie } })).json()) as { messages: Array<{ role: string; text: string; status?: string }> };
    expect(view.messages.at(-1)).toMatchObject({ role: "assistant", text: "Hello, let's start.", status: "done" });
    expect(await noticed(cookie)).toBeGreaterThan(written);
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

describe("the chats kept", () => {
  it("a chat pushed past the ones kept goes with its pictures; the kept ones keep theirs", async () => {
    const { PAST_KEPT } = await import("./assistant");
    createUser("lea", "password1");
    const dir = path.join(process.env.DATA_DIR!, "assistant");
    const pics = path.join(dir, "images", "lea");
    mkdirSync(pics, { recursive: true });
    const oldest = "00000000-0000-4000-8000-000000000001";
    const kept = "00000000-0000-4000-8000-000000000002";
    const chat = (n: number, image?: string) => ({
      id: `chat-${n}`,
      messages: [{ id: `m-${n}`, role: "user", text: `Tiny Acrobatics plan ${n}`, at: n, ...(image ? { images: [{ id: image, name: "board.png" }] } : {}) }],
    });
    const past = Array.from({ length: PAST_KEPT }, (_, i) => chat(i, i === PAST_KEPT - 1 ? oldest : i === PAST_KEPT - 2 ? kept : undefined));
    writeFileSync(path.join(dir, "lea.json"), JSON.stringify({ messages: chat(999).messages, past }));
    for (const id of [oldest, kept]) writeFileSync(path.join(pics, `${id}.png`), "png");
    const r = await app.request("/api/assistant", { method: "DELETE", headers: { cookie: await cookieOf("lea") } });
    expect(((await r.json()) as { past: unknown[] }).past.length).toBe(PAST_KEPT);
    expect(existsSync(path.join(pics, `${oldest}.png`))).toBe(false);
    expect(existsSync(path.join(pics, `${kept}.png`))).toBe(true);
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

describe("pictures, pastes and the page a message comes from", () => {
  // a 1×1 PNG
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const imagesOf = (u: string) => path.join(process.env.DATA_DIR!, "assistant", "images", u);
  const claim = async () => (await (await app.request("/api/devices/relay/wait", { method: "POST", ...json({}, { authorization: `Bearer ${mac.token}` }) })).json()) as { id: string; user: string; files?: Record<string, string> };
  const finish = (id: string) => app.request(`/api/devices/relay/${id}/done`, { method: "POST", ...json({ text: "Done." }, { authorization: `Bearer ${mac.token}` }) });
  let imageId = "";

  it("a picture and a paste go to the Mac as files the prompt names, with the page and the highlight as facts", async () => {
    const cookie = await cookieOf("ana");
    const r = await app.request("/api/assistant/turn", {
      method: "POST",
      ...json(
        {
          text: "",
          images: [{ name: "Shot.png", type: "image/png", data: png }],
          pasted: [{ name: "Notes", text: "Tiny Acrobatics plan" }],
          context: { path: "/review/abc", title: "Review", selection: "the second hook", visible: "Tiny Acrobatics: rolls" },
        },
        { cookie },
      ),
    });
    expect(r.status).toBe(202);
    const job = await claim();
    expect(job.files).toEqual({ "attached/01-shot.png": `base64:${png}`, "pasted/01-notes.txt": "Tiny Acrobatics plan" });
    expect(job.user).toContain("attached/01-shot.png");
    expect(job.user).toContain("pasted/01-notes.txt");
    expect(job.user).toContain("The user is on /review/abc (page title: Review). On screen: Tiny Acrobatics: rolls");
    expect(job.user).toContain("They highlighted this on the page: «the second hook»");
    // Claude's own reads show under the reply; its MCP calls (mcp.ts notes those) and "Thinking" don't
    for (const label of ["Read attached/01-shot.png", "mcp__creator-toolset__list_reviews", "Thinking"])
      await app.request(`/api/devices/relay/${job.id}/step`, { method: "POST", ...json({ label }, { authorization: `Bearer ${mac.token}` }) });
    const view = (await (await app.request("/api/assistant", { headers: { cookie } })).json()) as { messages: Array<{ images?: Array<{ id: string; name: string }>; pasted?: string[]; quote?: string; steps?: string[] }> };
    expect(view.messages.at(-1)?.steps).toEqual(["Read attached/01-shot.png"]);
    const ask = view.messages.at(-2)!;
    expect(ask).toMatchObject({ pasted: ["Notes"], quote: "the second hook" });
    imageId = ask.images![0]!.id;
    expect(ask.images![0]!.name).toBe("Shot.png");
    expect(statSync(path.join(imagesOf("ana"), `${imageId}.png`)).mode & 0o777).toBe(0o600);
    expect((await finish(job.id)).status).toBe(200);

    // the next turn names the earlier attachments only; their files don't travel again
    expect((await app.request("/api/assistant/turn", { method: "POST", ...json({ text: "And now?" }, { cookie }) })).status).toBe(202);
    const next = await claim();
    expect(next.files).toBeUndefined();
    expect(next.user).toContain("User: [1 picture] [pasted: Notes]");
    expect(next.user).not.toContain("attached/");
    expect(next.user).not.toContain("highlighted");
    await finish(next.id);
  });

  it("a picture is served to its owner alone", async () => {
    const mine = await app.request(`/api/assistant/images/${imageId}`, { headers: { cookie: await cookieOf("ana") } });
    expect(mine.status).toBe(200);
    expect(mine.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await mine.arrayBuffer()).equals(Buffer.from(png, "base64"))).toBe(true);
    const nico = await cookieOf("nico");
    expect((await app.request(`/api/assistant/images/${imageId}`, { headers: { cookie: nico } })).status).toBe(404);
    for (const bad of ["..%2Fana.json", `${imageId}.png`, "not-an-id"])
      expect((await app.request(`/api/assistant/images/${bad}`, { headers: { cookie: await cookieOf("ana") } })).status, bad).toBe(404);
  });

  it("refuses a wrong type, too many, too big, a broken picture, too much paste and an empty message", async () => {
    const cookie = await cookieOf("ana");
    const im = (over: Record<string, unknown> = {}) => ({ name: "a.png", type: "image/png", data: png, ...over });
    const big = "A".repeat(Math.ceil((8 * 1024 * 1024 + 3) / 3) * 4);
    for (const [why, body] of [
      ["svg", { text: "x", images: [im({ type: "image/svg+xml" })] }],
      ["seven", { text: "x", images: Array.from({ length: 7 }, () => im()) }],
      ["over 8 MB", { text: "x", images: [im({ data: big })] }],
      ["not base64", { text: "x", images: [im({ data: "a$b=" })] }],
      ["six pastes", { text: "x", pasted: Array.from({ length: 6 }, () => ({ name: "p", text: "t" })) }],
      ["paste too long", { text: "x", pasted: [{ name: "p", text: "x".repeat(150_000) }, { name: "q", text: "x".repeat(60_000) }] }],
      ["nothing", { text: "  " }],
    ] as const) {
      const r = await app.request("/api/assistant/turn", { method: "POST", ...json(body, { cookie }) });
      expect(r.status, why).toBe(400);
      expect(((await r.json()) as { error: string }).error, why).toMatch(/\.$/);
    }
  });

  it("deleting an earlier conversation deletes its pictures", async () => {
    const cookie = await cookieOf("ana");
    const fresh = (await (await app.request("/api/assistant", { method: "DELETE", headers: { cookie } })).json()) as { past: Array<{ id: string }> };
    expect(existsSync(path.join(imagesOf("ana"), `${imageId}.png`))).toBe(true);
    expect((await app.request(`/api/assistant/past/${fresh.past[0]!.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(200);
    expect(existsSync(path.join(imagesOf("ana"), `${imageId}.png`))).toBe(false);
    expect((await app.request(`/api/assistant/images/${imageId}`, { headers: { cookie } })).status).toBe(404);
  });
});

describe("work cards", () => {
  it("a session the reply starts is a card that opens it; a Full key's call adds none", async () => {
    const cookie = await cookieOf("ana");
    expect((await app.request("/api/assistant/turn", { method: "POST", ...json({ text: "Draft a reel for Tiny Acrobatics" }, { cookie }) })).status).toBe(202);
    const job = (await (await app.request("/api/devices/relay/wait", { method: "POST", ...json({}, { authorization: `Bearer ${mac.token}` }) })).json()) as { id: string; mcp: { token: string } };
    const made = JSON.parse((await toolOf(job.mcp.token, "workshop_new_session", { title: "Rolling over" })).text) as { id: string };
    await toolOf(fullKey.slice(7), "workshop_new_session", { title: "From a Full key" });
    const workOf = async () => ((await (await app.request("/api/assistant", { headers: { cookie } })).json()) as { messages: Array<{ work?: unknown[] }> }).messages.at(-1)?.work;
    expect(await workOf()).toEqual([{ id: `workshop:${made.id}`, kind: "workshop", title: "Rolling over", href: `/workshop/sessions/${made.id}`, status: "done", detail: "Session started" }]);
    await app.request(`/api/devices/relay/${job.id}/done`, { method: "POST", ...json({ text: "Started it." }, { authorization: `Bearer ${mac.token}` }) });
    expect(await workOf()).toHaveLength(1);
  });
});

describe("show_video", () => {
  const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

  it.skipIf(!hasFfmpeg)("plays the account's own Review video in the reply; someone else's is refused, and a Full key can't call it", async () => {
    const src = path.join(process.env.DATA_DIR!, "tiny-roll.mp4");
    spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=25:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "mp4", src]);
    const { addVersion } = await import("./review");
    const added = (await addVersion(undefined, { owner: "ana", name: "TinyRoll.mp4", mime: "video/mp4", bytes: statSync(src).size }, (dest) => copyFile(src, dest)))!;
    const id = added.meta.id;
    const cookie = await cookieOf("ana");
    for (let i = 0; i < 100; i++) {
      const v = ((await (await app.request(`/api/review/assets/${id}`, { headers: { cookie } })).json()) as { asset: { versions: Array<{ status: string }> } }).asset.versions[0]!;
      if (v.status !== "processing") break;
      await new Promise((r) => setTimeout(r, 100));
    }

    expect((await app.request("/api/assistant/turn", { method: "POST", ...json({ text: "Show me the Tiny Acrobatics roll" }, { cookie }) })).status).toBe(202);
    const job = (await (await app.request("/api/devices/relay/wait", { method: "POST", ...json({}, { authorization: `Bearer ${mac.token}` }) })).json()) as { id: string; mcp: { token: string } };
    const shown = await toolOf(job.mcp.token, "show_video", { link: `https://tools.example.com/review/${id}` });
    expect(shown.error).toBe(false);
    expect(JSON.parse(shown.text)).toEqual({ showing: "TinyRoll", page: `/review/${id}?v=1` });
    const view = (await (await app.request("/api/assistant", { headers: { cookie } })).json()) as { messages: Array<{ media?: Array<{ src: string; poster?: string }>; steps?: string[] }> };
    const card = view.messages.at(-1)!.media![0]!;
    expect(card).toMatchObject({ id: `review:${id}:1`, kind: "video", title: "TinyRoll", src: `/api/review/assets/${id}/v/1/play`, href: `/review/${id}?v=1` });
    expect(view.messages.at(-1)!.steps).toContain("Showing the video");
    // the browser plays it with the owner's cookie, whole or in byte ranges
    const whole = await app.request(card.src, { headers: { cookie } });
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("video/mp4");
    expect((await app.request(card.src, { headers: { cookie, range: "bytes=0-99" } })).status).toBe(206);
    expect((await app.request(card.poster!, { headers: { cookie } })).status).toBe(200);
    // anyone else's cookie can't
    expect((await app.request(card.src, { headers: { cookie: await cookieOf("nico") } })).status).toBe(404);
    await app.request(`/api/devices/relay/${job.id}/done`, { method: "POST", ...json({ text: "Here it is." }, { authorization: `Bearer ${mac.token}` }) });

    const nico = mintJobToken("nico", "turn-show");
    expect(await toolOf(nico, "show_video", { link: id })).toEqual({ error: true, text: "Not found, or not this account's." });
    revokeJobToken(nico);
    expect(await toolOf(newApiKey(ana, "full"), "show_video", { link: id })).toEqual({ error: true, text: "show_video is for the assistant only." });
  });
});

describe("approvals: what the reply asks to do on the Mac", () => {
  const device = { authorization: `Bearer ${mac.token}` };
  type View = { messages: Array<{ status?: string; approvals?: Array<{ id: string; tool: string; summary: string; detail: string; status: string }> }> };
  const viewOf = async (cookie: string) => (await (await app.request("/api/assistant", { headers: { cookie } })).json()) as View;
  const ask = async (job: string, body: Record<string, unknown>) => {
    const r = await app.request(`/api/devices/relay/${job}/ask`, { method: "POST", ...json(body, device) });
    return { code: r.status, status: r.status === 200 ? ((await r.json()) as { status: string }).status : "" };
  };
  const start = async (cookie: string, text: string) => {
    expect((await app.request("/api/assistant/turn", { method: "POST", ...json({ text }, { cookie }) })).status).toBe(202);
    return (await (await app.request("/api/devices/relay/wait", { method: "POST", ...json({}, device) })).json()) as { id: string; asks?: boolean };
  };
  const answer = (cookie: string, id: string, allow: unknown) => app.request(`/api/assistant/approvals/${id}`, { method: "POST", ...json({ allow }, { cookie }) });

  it("a dock turn may ask; the ask waits on the reply, the owner's yes or no goes back to the Mac, anyone else is refused", async () => {
    const cookie = await cookieOf("ana");
    const job = await start(cookie, "Make a file called made.txt");
    expect(job.asks).toBe(true);
    const touch = { ask_id: "req-touch", tool: "Bash", description: "Create made.txt", reason: "", detail: "touch made.txt" };
    expect(await ask(job.id, touch)).toEqual({ code: 200, status: "waiting" });
    expect(await ask(job.id, touch)).toEqual({ code: 200, status: "waiting" }); // asked again: still one card
    const waiting = (await viewOf(cookie)).messages.at(-1)!;
    expect(waiting.approvals).toEqual([{ id: "req-touch", tool: "Bash", summary: "Run a command: Create made.txt", detail: "touch made.txt", at: expect.any(Number), status: "waiting" }]);
    // another account can't answer it, and a bad body isn't an answer
    expect((await answer(await cookieOf("nico"), "req-touch", true)).status).toBe(404);
    expect((await answer(cookie, "req-touch", "yes")).status).toBe(400);
    const r = await answer(cookie, "req-touch", true);
    expect(r.status).toBe(200);
    expect(((await r.json()) as View).messages.at(-1)!.approvals![0]!.status).toBe("allowed");
    expect(await ask(job.id, touch)).toEqual({ code: 200, status: "allowed" });
    expect((await answer(cookie, "req-touch", false)).status).toBe(409); // answered once
    // a no
    expect(await ask(job.id, { ask_id: "req-rm", tool: "Write", detail: "/tmp/x" })).toEqual({ code: 200, status: "waiting" });
    expect((await answer(cookie, "req-rm", false)).status).toBe(200);
    expect(await ask(job.id, { ask_id: "req-rm", tool: "Write", detail: "/tmp/x" })).toEqual({ code: 200, status: "denied" });
    // a bad ask, and another device's request
    expect((await ask(job.id, { ask_id: "../x", tool: "Bash" })).code).toBe(400);
    expect((await app.request(`/api/devices/relay/${job.id}/ask`, { method: "POST", ...json(touch, { authorization: "Bearer ctd_nope" }) })).status).toBe(401);
    await app.request(`/api/devices/relay/${job.id}/done`, { method: "POST", ...json({ text: "Made it." }, device) });
    // kept in the history with their answers
    expect((await viewOf(cookie)).messages.at(-1)!.approvals!.map((a) => a.status)).toEqual(["allowed", "denied"]);
  });

  it("unanswered for 10 minutes is a no, and so is anything still waiting when the reply ends", async () => {
    const cookie = await cookieOf("ana");
    const job = await start(cookie, "Tidy my folder");
    const slow = { ask_id: "req-slow", tool: "Bash", detail: "mv a b" };
    expect((await ask(job.id, slow)).status).toBe("waiting");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1000);
    expect((await ask(job.id, slow)).status).toBe("expired");
    expect((await answer(cookie, "req-slow", true)).status).toBe(409);
    vi.useRealTimers();
    expect((await ask(job.id, { ask_id: "req-left", tool: "Edit", detail: "notes.md" })).status).toBe("waiting");
    await app.request(`/api/devices/relay/${job.id}/done`, { method: "POST", ...json({ text: "Gave up." }, device) });
    expect((await viewOf(cookie)).messages.at(-1)!.approvals!.map((a) => a.status)).toEqual(["expired", "expired"]);
  });
});

describe("a video dropped in the chat", () => {
  const upload = async (cookie: string, name: string, mime: string, bytes: Buffer) => {
    const init = await app.request("/api/assistant/files", { method: "POST", ...json({ name, mime, size: bytes.length }, { cookie }) });
    if (init.status !== 200) return { status: init.status } as { status: number; id?: string };
    const { id, partSize } = (await init.json()) as { id: string; partSize: number };
    const part = await app.request(`/api/assistant/files/${id}/parts/1`, {
      method: "POST",
      headers: { cookie, "upload-length": String(bytes.length), "upload-part-size": String(partSize), "content-length": String(bytes.length), "content-type": "application/octet-stream" },
      body: bytes,
    });
    expect(part.status).toBe(200);
    const done = await app.request(`/api/assistant/files/${id}/complete`, { method: "POST", headers: { cookie } });
    return { status: done.status, ...((await done.json()) as { id: string }) };
  };

  it("an interrupted drop resumes from its last part; only its owner can ask which parts are there", async () => {
    const cookie = await cookieOf("ana");
    const size = 16 * 1024 * 1024 + 10;
    const init = await app.request("/api/assistant/files", { method: "POST", ...json({ name: "Long.mp4", mime: "video/mp4", size }, { cookie }) });
    const { id, partSize } = (await init.json()) as { id: string; partSize: number };
    const sendPart = (n: number, bytes: Buffer) =>
      app.request(`/api/assistant/files/${id}/parts/${n}`, {
        method: "POST",
        headers: { cookie, "upload-length": String(size), "upload-part-size": String(partSize), "content-length": String(bytes.length), "content-type": "application/octet-stream" },
        body: bytes,
      });
    // the connection drops after part 1
    expect((await sendPart(1, Buffer.alloc(partSize, 1))).status).toBe(200);
    const status = async () => app.request(`/api/assistant/files/${id}/parts`, { headers: { cookie } });
    expect(await status().then((r) => r.json())).toEqual({ partSize, parts: [1] });
    expect((await app.request(`/api/assistant/files/${id}/complete`, { method: "POST", headers: { cookie } })).status).toBe(400);
    // the browser comes back: it sends only what is missing
    expect((await sendPart(2, Buffer.alloc(10, 2))).status).toBe(200);
    expect(await status().then((r) => r.json())).toEqual({ partSize, parts: [1, 2] });
    // another account, a made-up id and a bad id learn nothing
    expect((await app.request(`/api/assistant/files/${id}/parts`, { headers: { cookie: await cookieOf("nico") } })).status).toBe(404);
    expect((await app.request("/api/assistant/files/00000000-0000-4000-8000-000000000000/parts", { headers: { cookie } })).status).toBe(404);
    expect((await app.request("/api/assistant/files/not-an-id/parts", { headers: { cookie } })).status).toBe(404);
  });

  it("uploads, goes with the message as a fact, and use_file hands it to Review; nobody else can use it", async () => {
    const cookie = await cookieOf("ana");
    expect((await upload(cookie, "notes.txt", "text/plain", Buffer.from("hi"))).status).toBe(400);
    const file = await upload(cookie, "My Loom.mp4", "video/mp4", Buffer.alloc(4096, 1));
    expect(file.status).toBe(200);
    // a made-up id never goes with a message
    expect((await app.request("/api/assistant/turn", { method: "POST", ...json({ text: "x", files: ["00000000-0000-4000-8000-000000000000"] }, { cookie }) })).status).toBe(400);
    expect((await app.request("/api/assistant/turn", { method: "POST", ...json({ text: "Put this up", files: [file.id] }, { cookie }) })).status).toBe(202);
    const job = (await (await app.request("/api/devices/relay/wait", { method: "POST", ...json({}, { authorization: `Bearer ${mac.token}` }) })).json()) as { id: string; mcp: { token: string }; user: string };
    expect(job.user).toContain(`"My Loom.mp4"`);
    expect(job.user).toContain(`file id ${file.id}`);
    const used = await toolOf(job.mcp.token, "use_file", { file: file.id, to: "review", name: "Loom walkthrough" });
    expect(used.error).toBe(false);
    const made = JSON.parse(used.text) as { href: string; id: string };
    expect(made.href).toBe(`/review/${made.id}`);
    expect(existsSync(path.join(process.env.DATA_DIR!, "review", made.id, "v1", "source"))).toBe(true);
    expect((await toolOf(job.mcp.token, "use_file", { file: "nope", to: "review" })).error).toBe(true);
    // the reply shows a card for it
    const view = (await (await app.request("/api/assistant", { headers: { cookie } })).json()) as { messages: Array<{ files?: unknown[]; work?: Array<{ kind: string; href: string }> }> };
    expect(view.messages.at(-2)?.files).toEqual([{ id: file.id, name: "My Loom.mp4" }]);
    expect(view.messages.at(-1)?.work?.[0]).toMatchObject({ kind: "review", href: made.href });
    await app.request(`/api/devices/relay/${job.id}/done`, { method: "POST", ...json({ text: "It's in Review." }, { authorization: `Bearer ${mac.token}` }) });
    // another account's job can't reach ana's file
    const other = mintJobToken("nico", "turn-nico");
    expect((await toolOf(other, "use_file", { file: file.id, to: "review" })).text).toMatch(/isn't here/);
    revokeJobToken(other);
  });

  it("use_file puts dropped files in the Media Library and says in one line how they were sorted", async () => {
    const { SORT_WAIT_S } = await import("./mcp");
    const { libraryDb } = await import("./library/db");
    SORT_WAIT_S.added = 0; // the line as it is the moment they are in
    const cookie = await cookieOf("ana");
    const talk = await upload(cookie, "Talk.mp4", "video/mp4", Buffer.alloc(4096, 3));
    const sea = await upload(cookie, "Sea.mp4", "video/mp4", Buffer.alloc(4096, 4));
    const token = mintJobToken("ana", "turn-library");
    type Added = { said: string; href: string; files: { name: string; version_id: string; note?: string }[] };
    const out = JSON.parse((await toolOf(token, "use_file", { files: [talk.id, sea.id], to: "library" })).text) as Added;
    expect(out.said).toBe("2 clips added: still being sorted into A-roll and B-roll");
    expect(out.files.map((f) => f.name)).toEqual(["Talk.mp4", "Sea.mp4"]);
    expect(out.href).toMatch(/^\/library\?library=/);
    // the worker sorts them (library/roll.ts); here the rolls are set as it would
    const [a, b] = out.files.map((f) => f.version_id);
    libraryDb().prepare("UPDATE assets SET roll = CASE current_version_id WHEN ? THEN 'a' ELSE 'b' END WHERE current_version_id IN (?, ?)").run(a!, a!, b!);
    expect(JSON.parse((await toolOf(token, "media_search", { versions: [a, b] })).text).said).toBe("2 clips added: 1 A-roll, 1 B-roll");
    // the same file again is the same clip
    const again = JSON.parse((await toolOf(token, "use_file", { file: talk.id, to: "library" })).text) as Added;
    expect(again.files[0]).toMatchObject({ version_id: a, note: "Already in the Media Library" });
    expect(again.said).toBe("1 clip added: 1 A-roll");
    // a file on this computer is never copied in: its folder is read in place
    expect((await toolOf(token, "use_file", { path: "/Users/tiny/Movies/take.mov", to: "library" })).text).toMatch(/media_import_folder/);
    revokeJobToken(token);
    SORT_WAIT_S.added = 10;
  });
});

describe("a file on this computer, by its path", () => {
  it("only when the server runs here; footage only; a tool that isn't set up says what it needs first", async () => {
    const token = mintJobToken("ana", "turn-path");
    const dir = mkdtempSync(path.join(tmpdir(), "footage-"));
    const clip = path.join(dir, "Call recording.mov");
    writeFileSync(clip, Buffer.alloc(2048, 2));
    writeFileSync(path.join(dir, "notes.txt"), "hi");
    delete process.env.CT_LOCAL;
    expect((await toolOf(token, "use_file", { path: clip, to: "review" })).text).toMatch(/isn't on your computer/);
    process.env.CT_LOCAL = "1";
    expect((await toolOf(token, "use_file", { path: path.join(dir, "notes.txt"), to: "review" })).text).toMatch(/isn't a video/);
    expect((await toolOf(token, "use_file", { path: "Movies/x.mov", to: "review" })).text).toMatch(/full path/);
    const made = JSON.parse((await toolOf(token, "use_file", { path: clip, to: "review" })).text) as { href: string; name: string };
    expect(made).toMatchObject({ name: "Call recording.mov" });
    expect(made.href).toMatch(/^\/review\//);
    // Video Notes with no transcription key: a hosted server still answers with the key to add; on this computer the
    // server transcribes by itself, so the file is taken
    const nico = mintJobToken("nico", "turn-nico-path");
    const toNotes = async () => JSON.parse((await toolOf(nico, "use_file", { path: clip, to: "notes" })).text) as { needs?: Array<{ ask_secret?: string[] }>; href?: string };
    process.env.CT_MODE = "hosted";
    expect((await toNotes()).needs?.some((n) => n.ask_secret?.join() === "DEEPGRAM_API_KEY")).toBe(true);
    delete process.env.CT_MODE;
    const taken = await toNotes();
    revokeJobToken(nico);
    expect(taken.needs).toBeUndefined();
    expect(taken.href).toMatch(/^\//);
    delete process.env.CT_LOCAL;
    revokeJobToken(token);
  });
});
