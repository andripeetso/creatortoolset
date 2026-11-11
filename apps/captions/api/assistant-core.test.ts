import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "assistant-core-"));
process.env.APP_SECRET = "assistant-core-secret";

// one made-up module, added before the server is built: how a tool file under mcp-tools/ reaches the AI
const { MODULES } = await import("./mcp-tools");
const { ToolError } = await import("./mcp-tools/types");
MODULES.push({
  defs: [
    { name: "tiny_prefs", description: "How the user wants to work, by one of the app's own routes.", inputSchema: { type: "object", properties: {} } },
    { name: "tiny_card", description: "Leaves a card.", inputSchema: { type: "object", properties: { id: { type: "string" } } }, dockOnly: true },
    { name: "tiny_wipe", description: "Asks first.", inputSchema: { type: "object", properties: { what: { type: "string" } } } },
  ],
  handlers: {
    tiny_prefs: async (_a, ctx) => ({ talk: (await ctx.json<{ talk: string }>("/api/work-prefs")).talk, as: ctx.user.username }),
    tiny_card: async (a) => ({ id: a.id }),
    tiny_wipe: async (a, ctx) => {
      if (!a.what) throw new ToolError("Say what.");
      await ctx.sure(`Wipe ${String(a.what)}?`);
      wiped.push(`${String(a.what)} by ${ctx.user.username}`);
      return { wiped: a.what };
    },
  },
  steps: { tiny_prefs: "Checking the tiny things" },
  work: (name, _a, r) => (name === "tiny_card" ? { card: { id: `edit:${String(r.id)}:new`, kind: "edit", title: "Tiny edit", href: `/editor/${String(r.id)}`, status: "running" } } : null),
});
const wiped: string[] = [];

const { createUser, newApiKey } = await import("./users");
const app = (await import("./boot")).default;
const { handle, pluginToolsOf } = await import("./mcp");
const { routeOf, runInChat, workEnded } = await import("./assistant");
const { pairDevice } = await import("./lib/devices");
const { saveSettings } = await import("./lib/providers");
const { DEFAULT_SETTINGS } = await import("../contracts/providers");
import type { AssistantMessage, AssistantView } from "../contracts/assistant";

const ana = createUser("ana", "password1");
createUser("nico", "password1");
const fullKey = `Bearer ${newApiKey(ana, "full")}`;
const mac = pairDevice("ana", "Ana's Mac");
await saveSettings({ ...structuredClone(DEFAULT_SETTINGS), instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: mac.device.id }] }, "ana");

const cookieOf = async (username: string) => {
  const r = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "password1" }) });
  return r.headers.get("set-cookie")!.split(";")[0]!;
};
const json = (body: unknown, extra: Record<string, string> = {}) => ({ headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
const rpc = async (authorization: string, method: string, params: unknown = {}) =>
  (await (await app.request("/api/mcp", { method: "POST", ...json({ jsonrpc: "2.0", id: 1, method, params }, { authorization }) })).json()) as {
    result: { tools?: Array<Record<string, unknown>>; content?: Array<{ text: string }>; isError?: boolean };
  };
const tool = async (authorization: string, name: string, args: Record<string, unknown> = {}) => {
  const r = (await rpc(authorization, "tools/call", { name, arguments: args })).result;
  return { error: !!r.isError, text: r.content![0]!.text };
};
/** The Mac takes the reply's job: its token is the assistant's own, for that reply only. */
const claim = async () => (await (await app.request("/api/devices/relay/wait", { method: "POST", ...json({}, { authorization: `Bearer ${mac.token}` }) })).json()) as { id: string; user: string; mcp: { token: string } };
const finish = (id: string, text = "Done.") => app.request(`/api/devices/relay/${id}/done`, { method: "POST", ...json({ text }, { authorization: `Bearer ${mac.token}` }) });
const viewOf = async (cookie: string) => (await (await app.request("/api/assistant", { headers: { cookie } })).json()) as AssistantView;
/** A turn of ana's, with the Mac holding its job: the token to call tools as that reply, and how to end it. */
const turn = async (cookie: string, text: string) => {
  expect((await app.request("/api/assistant/turn", { method: "POST", ...json({ text }, { cookie }) })).status).toBe(202);
  const job = await claim();
  return { job, token: `Bearer ${job.mcp.token}`, end: async () => void (await finish(job.id)) };
};

describe("tools kept in their own files", () => {
  it("are listed after the built-in ones, a dock-only one for the assistant alone, and the listing says nothing but name, description and schema", async () => {
    const outside = (await rpc(fullKey, "tools/list")).result.tools!;
    expect(outside.map((t) => t.name)).toEqual(expect.arrayContaining(["workshop_projects", "tiny_prefs", "tiny_wipe"]));
    expect(outside.map((t) => t.name)).not.toContain("tiny_card");
    expect(outside.find((t) => t.name === "tiny_prefs")).toEqual({ name: "tiny_prefs", description: "How the user wants to work, by one of the app's own routes.", inputSchema: { type: "object", properties: {} } });
    expect((await tool(fullKey, "tiny_card", { id: "e1" })).text).toBe("tiny_card is for the assistant only.");
    const t = await turn(await cookieOf("ana"), "List them");
    expect((await rpc(t.token, "tools/list")).result.tools!.map((x) => x.name)).toEqual(expect.arrayContaining(["tiny_card", "navigate"]));
    await t.end();
  });

  it("call the site's own routes as the caller, show their step under the reply and leave their card", async () => {
    const cookie = await cookieOf("ana");
    const t = await turn(cookie, "How do I like to work?");
    expect(JSON.parse((await tool(t.token, "tiny_prefs")).text)).toMatchObject({ as: "ana" });
    await tool(t.token, "tiny_card", { id: "e7" });
    const reply = (await viewOf(cookie)).messages.at(-1)!;
    expect(reply.steps).toEqual(["Checking the tiny things", "tiny card"]);
    expect(reply.work).toEqual([{ id: "edit:e7:new", kind: "edit", title: "Tiny edit", href: "/editor/e7", status: "running" }]);
    await t.end();
  });

  it("a plug-in's tools bring their own step, card and a paragraph for the guide; a plug-in may answer a module's tool in its place", async () => {
    const plugged = pluginToolsOf([
      {
        id: "tiny",
        tools: {
          defs: [{ name: "tiny_prefs", description: "The plug-in's own.", inputSchema: { type: "object", properties: {} } }],
          handlers: { tiny_prefs: async () => ({ from: "plug-in" }) },
          replaces: ["tiny_prefs"],
          steps: { tiny_prefs: "Asking the plug-in" },
          guide: "On this install the footage is the catalog.",
        },
      } as never,
    ]);
    expect(plugged.steps).toEqual({ tiny_prefs: "Asking the plug-in" });
    const call = async () => new Response("{}", { status: 404 });
    const init = (await handle(call, new Headers({ authorization: fullKey }), { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, "https://tools.example.com", ana, plugged)) as { result: { instructions: string } };
    expect(init.result.instructions.endsWith("\n\nOn this install the footage is the catalog.")).toBe(true);
    const listed = (await handle(call, new Headers({ authorization: fullKey }), { jsonrpc: "2.0", id: 2, method: "tools/list" }, "https://tools.example.com", ana, plugged)) as { result: { tools: Array<{ name: string; description: string }> } };
    expect(listed.result.tools.filter((t) => t.name === "tiny_prefs").map((t) => t.description)).toEqual(["The plug-in's own."]);
    // a dock-only tool is never a plug-in's to replace, as the assistant's own are not
    expect(() => pluginToolsOf([{ id: "p", tools: { defs: [{ name: "tiny_card", description: "x", inputSchema: {} }], handlers: { tiny_card: async () => ({}) }, replaces: ["tiny_card"] } } as never])).toThrow(/not a built-in tool/);
  });
});

describe("a tool asks before it deletes", () => {
  it("in the dock the question waits on a card: nothing changes until Yes, which runs it as the person; No drops it; the AI is told how each was answered", async () => {
    const cookie = await cookieOf("ana");
    const t = await turn(cookie, "Wipe the tiny things");
    const asked = await tool(t.token, "tiny_wipe", { what: "the cache" });
    expect(asked.error).toBe(false);
    expect(asked.text).toContain('Asked the user: "Wipe the cache?" Nothing has been changed.');
    // asked again in the same reply: still one card
    await tool(t.token, "tiny_wipe", { what: "the cache" });
    await tool(t.token, "tiny_wipe", { what: "the logs" });
    // what a tool checks before it asks still answers at once
    expect(await tool(t.token, "tiny_wipe")).toEqual({ error: true, text: "Say what." });
    expect(wiped).toEqual([]);
    await t.end();
    const cards = (await viewOf(cookie)).messages.at(-1)!.confirms!;
    expect(cards.map((q) => [q.question, q.status])).toEqual([["Wipe the cache?", "waiting"], ["Wipe the logs?", "waiting"]]);
    // the call it stands for never reaches the dock
    expect(JSON.stringify(await viewOf(cookie))).not.toContain("tiny_wipe");

    // someone else's card is not found; a bad answer is refused
    const nico = await cookieOf("nico");
    expect((await app.request(`/api/assistant/confirms/${cards[0]!.id}`, { method: "POST", ...json({ yes: true }, { cookie: nico }) })).status).toBe(404);
    expect((await app.request(`/api/assistant/confirms/${cards[0]!.id}`, { method: "POST", ...json({}, { cookie }) })).status).toBe(400);
    expect(wiped).toEqual([]);

    const yes = await app.request(`/api/assistant/confirms/${cards[0]!.id}`, { method: "POST", ...json({ yes: true }, { cookie }) });
    expect(yes.status).toBe(200);
    expect(wiped).toEqual(["the cache by ana"]);
    expect((await app.request(`/api/assistant/confirms/${cards[0]!.id}`, { method: "POST", ...json({ yes: true }, { cookie }) })).status).toBe(409);
    expect((await app.request(`/api/assistant/confirms/${cards[1]!.id}`, { method: "POST", ...json({ yes: false }, { cookie }) })).status).toBe(200);
    expect(wiped).toEqual(["the cache by ana"]);
    expect((await viewOf(cookie)).messages.at(-1)!.confirms!.map((q) => q.status)).toEqual(["done", "no"]);

    const next = await turn(cookie, "And now?");
    expect(next.job.user).toContain('[asked: "Wipe the cache?" → yes, done');
    expect(next.job.user).toContain('[asked: "Wipe the logs?" → the user said no]');
    await next.end();
  });

  it("an AI key from outside the app is not asked here: its own app asks its own way", async () => {
    wiped.length = 0;
    expect(JSON.parse((await tool(fullKey, "tiny_wipe", { what: "the cache" })).text)).toEqual({ wiped: "the cache" });
    expect(wiped).toEqual(["the cache by ana"]);
  });

  it("deleting a scheduled task asks first, with the task's name", async () => {
    const cookie = await cookieOf("ana");
    const made = (await (await app.request("/api/automations", { method: "POST", ...json({ name: "Monday comments", prompt: "Read them", schedule: { kind: "interval", everyMinutes: 60 }, timezone: "UTC", enabled: false }, { cookie }) })).json()) as { id: string };
    expect(made.id).toBeTruthy();
    const t = await turn(cookie, "Delete that task");
    expect((await tool(t.token, "delete_scheduled_task", { id: made.id })).text).toContain('Asked the user: "Delete the scheduled task "Monday comments"?"');
    expect((await tool(t.token, "delete_scheduled_task", { id: "nope" })).error).toBe(true);
    await t.end();
    const list = async () => ((await (await app.request("/api/automations", { headers: { cookie } })).json()) as { items: Array<{ id: string }> }).items.map((x) => x.id);
    expect(await list()).toContain(made.id);
    const card = (await viewOf(cookie)).messages.at(-1)!.confirms![0]!;
    expect((await app.request(`/api/assistant/confirms/${card.id}`, { method: "POST", ...json({ yes: true }, { cookie }) })).status).toBe(200);
    expect(await list()).not.toContain(made.id);
  });
});

describe("work the assistant started ends", () => {
  it("its running card gets its end and the chat says so once, with answer buttons; work nobody started from the chat says nothing", async () => {
    const cookie = await cookieOf("ana");
    const t = await turn(cookie, "Start the tiny edit");
    await tool(t.token, "tiny_card", { id: "e9" });
    // while the reply is still being written the line waits, so the reply keeps the last word until it ends
    expect(workEnded("ana", "edit:e9", { status: "done", detail: "First cut is ready", say: "The first cut of Tiny edit is ready.", choices: ["Show me", "Carry on"] })).toBe(true);
    let messages = (await viewOf(cookie)).messages;
    expect(messages.at(-1)!.status).toBe("thinking");
    expect(messages.at(-1)!.work![0]).toMatchObject({ status: "done", detail: "First cut is ready" });
    await t.end();
    messages = (await viewOf(cookie)).messages;
    expect(messages.slice(-2).map((m: AssistantMessage) => [m.role, m.text, m.status])).toEqual([["assistant", "Done.", "done"], ["assistant", "The first cut of Tiny edit is ready.", "done"]]);
    expect(messages.at(-1)!.choices).toEqual(["Show me", "Carry on"]);
    // ended already, or never started from the chat: nothing more is said
    expect(workEnded("ana", "edit:e9", { status: "done", say: "Again" })).toBe(false);
    expect(workEnded("ana", "edit:e", { status: "done", say: "Not this one" })).toBe(false);
    expect((await viewOf(cookie)).messages.at(-1)!.text).toBe("The first cut of Tiny edit is ready.");
  });
});

describe("a scheduled run has nobody at the screen", () => {
  it("opening a page or asking for a key is refused there, in words the AI can act on", async () => {
    const run = runInChat("ana", { task: { id: "t1", name: "Weekly" }, prompt: "Do the weekly thing", preface: "", fresh: true, route: routeOf("ana", false)!, url: "http://localhost/api/mcp" });
    const job = await claim();
    const token = `Bearer ${job.mcp.token}`;
    expect(await tool(token, "navigate", { path: "/workshop" })).toEqual({ error: true, text: "Nobody is at the screen in a scheduled run: say it in your answer instead." });
    expect((await tool(token, "ask_secret", { env: "DEEPGRAM_API_KEY", why: "x" })).error).toBe(true);
    expect((await viewOf(await cookieOf("ana"))).navigate).toBeNull();
    await finish(job.id);
    await run;
  });
});
