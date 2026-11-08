import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
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
