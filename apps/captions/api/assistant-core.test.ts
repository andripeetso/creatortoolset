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
    tiny_card: async (a) => ({ id: a.id, status: a.status }),
    tiny_wipe: async (a, ctx) => {
      if (!a.what) throw new ToolError("Say what.");
      await ctx.sure(`Wipe ${String(a.what)}?`);
      wiped.push(`${String(a.what)} by ${ctx.user.username}`);
      return { wiped: a.what };
    },
  },
  steps: { tiny_prefs: "Checking the tiny things" },
  work: (name, _a, r) => (name === "tiny_card" ? { card: { id: `edit:${String(r.id)}:new`, kind: "edit", title: "Tiny edit", href: `/editor/${String(r.id)}`, status: r.status === "done" ? "done" : "running" } } : null),
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

/** A loaded plug-in whose source is the install's Media Library (LibrarySource.main): a drop "for the library" is refused there. */
const pluggedLibrary = !!(await import("./library/sources")).mainSource();
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
    await t.end();
    // the reply that started it has ended; while ANOTHER reply is being written in that chat the line waits for it to end
    const other = await turn(cookie, "And something else meanwhile");
    expect(workEnded("ana", "edit:e9", { status: "done", detail: "First cut is ready", say: "The first cut of Tiny edit is ready.", choices: ["Show me", "Carry on"] })).toBe(true);
    let messages = (await viewOf(cookie)).messages;
    expect(messages.at(-1)!.status).toBe("thinking");
    expect(messages.at(-3)!.work![0]).toMatchObject({ status: "done", detail: "First cut is ready" });
    await other.end();
    messages = (await viewOf(cookie)).messages;
    expect(messages.slice(-2).map((m: AssistantMessage) => [m.role, m.text, m.status])).toEqual([["assistant", "Done.", "done"], ["assistant", "The first cut of Tiny edit is ready.", "done"]]);
    expect(messages.at(-1)!.choices).toEqual(["Show me", "Carry on"]);

    // work that ends while the reply that started it is still being written, and that reply then reads it with a tool:
    // the reply says so itself, and no second line follows it
    const same = await turn(cookie, "Start another and wait for it");
    await tool(same.token, "tiny_card", { id: "e10" });
    expect(workEnded("ana", "edit:e10", { status: "done", detail: "Ready", say: "Not said: the reply says it", href: "/editor/e10/first" })).toBe(true);
    await tool(same.token, "tiny_card", { id: "e10", status: "done" });
    await same.end();
    messages = (await viewOf(cookie)).messages;
    expect(messages.at(-1)).toMatchObject({ text: "Done.", work: [{ id: "edit:e10:new", status: "done", href: "/editor/e10/first" }] });
    // the same, but the reply never looks at it again: the line comes once the reply has ended
    const blind = await turn(cookie, "Start a third and move on");
    await tool(blind.token, "tiny_card", { id: "e11" });
    expect(workEnded("ana", "edit:e11", { status: "done", say: "The third is ready." })).toBe(true);
    await blind.end();
    expect((await viewOf(cookie)).messages.at(-1)!.text).toBe("The third is ready.");
    // ended already, or never started from the chat: nothing more is said
    expect(workEnded("ana", "edit:e9", { status: "done", say: "Again" })).toBe(false);
    expect(workEnded("ana", "edit:e", { status: "done", say: "Not this one" })).toBe(false);
    expect((await viewOf(cookie)).messages.at(-1)!.text).toBe("The third is ready.");
  });
});

describe("a Video Note read back", () => {
  it("a new note comes with its summary, and with what is said in it when asked; a long recording is cut and says so", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const NOTE = "11111111-2222-4333-8444-555555555555";
    const dir = path.join(process.env.DATA_DIR!, "clips", NOTE);
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    // as processClip leaves a fresh note: a summary and chapters, no blocks yet
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id: NOTE, name: "Tiny tumbles plan", owner: "ana", duration: 60, bytes: 1, mime: "video/mp4", status: "ready", progress: 1, summary: "A plan for the first class.", chapters: [{ t: 0, title: "Start" }], createdAt: now, updatedAt: now }));
    writeFileSync(path.join(dir, "transcript.json"), JSON.stringify({ words: ["We", "start", "with", "a", "roll."].map((text, i) => ({ text, start: i, end: i + 1 })) }));
    const t = await turn(await cookieOf("ana"), "Sum it up");
    const plain = JSON.parse((await tool(t.token, "notes_get", { id: NOTE })).text);
    expect(plain).toMatchObject({ id: NOTE, status: "ready", summary: "A plan for the first class.", chapters: ["0:00.00 Start"] });
    expect(plain.transcript).toBeUndefined();
    expect(JSON.parse((await tool(t.token, "notes_get", { id: NOTE, transcript: true })).text).transcript).toBe("We start with a roll.");
    writeFileSync(path.join(dir, "transcript.json"), JSON.stringify({ words: Array.from({ length: 4000 }, (_, i) => ({ text: "tumble", start: i, end: i + 1 })) }));
    const long = JSON.parse((await tool(t.token, "notes_get", { id: NOTE, transcript: true })).text).transcript as string;
    expect(long.length).toBeLessThan(12_200);
    expect(long).toContain("(cut: 27,999 characters in all; the page has the rest)");
    await t.end();
  });
});

describe("a file dropped for the Media Library", () => {
  /** A file dropped in the chat, uploaded as the dock does (one part). */
  const drop = async (cookie: string, name: string) => {
    const bytes = Buffer.alloc(4096, 7);
    const { id, partSize } = (await (await app.request("/api/assistant/files", { method: "POST", ...json({ name, mime: "video/mp4", size: bytes.length }, { cookie }) })).json()) as { id: string; partSize: number };
    await app.request(`/api/assistant/files/${id}/parts/1`, { method: "POST", headers: { cookie, "upload-length": String(bytes.length), "upload-part-size": String(partSize), "content-length": String(bytes.length), "content-type": "application/octet-stream" }, body: bytes });
    expect((await app.request(`/api/assistant/files/${id}/complete`, { method: "POST", headers: { cookie } })).status).toBe(200);
    return id;
  };

  // with a plug-in loaded that IS the Media Library there is no storage library to drop into: nothing to compare against
  it.skipIf(pluggedLibrary)("is not put where the person never looks: on an install whose Media Library is a plug-in's source it is refused, and the answer says why", async () => {
    const { registerLibrarySlot, resetLibrarySlots } = await import("./library/sources");
    const { libraryDb } = await import("./library/db");
    (await import("./mcp")).SORT_WAIT_S.added = 0; // the line as it is the moment the file is in, without waiting for the sorting
    const cookie = await cookieOf("ana");
    const t = await turn(cookie, "Put this in my library");
    const count = () => (libraryDb().prepare("SELECT COUNT(*) AS n FROM assets").get() as { n: number }).n;
    // an extra source beside the app's own library changes nothing: the file goes in
    registerLibrarySlot("tiny", { source: { id: "extras", label: "Extras" } });
    const added = JSON.parse((await tool(t.token, "use_file", { file: await drop(cookie, "Sea.mp4"), to: "library" })).text) as { said: string };
    expect(added.said).toMatch(/^1 clip added/);
    const before = count();
    expect(before).toBeGreaterThan(0);
    // a source that IS the Media Library: nothing is added to the storage library its page never shows
    resetLibrarySlots();
    registerLibrarySlot("tiny", { source: { id: "catalog", label: "Footage catalog", main: true } });
    try {
      const refused = JSON.parse((await tool(t.token, "use_file", { files: [await drop(cookie, "Talk.mp4"), await drop(cookie, "Roll.mp4")], to: "library" })).text) as { said: string; href?: string };
      expect(refused.said).toBe("Nothing was added: On this server the Media Library is the Footage catalog, and files go in on its own page (/library): open it and add them there.");
      expect(refused.href).toBeUndefined();
      expect(count()).toBe(before);
    } finally {
      resetLibrarySlots();
      await t.end();
    }
  });
});

describe("a search a plug-in's Media Library refuses", () => {
  // with the real plug-in loaded its own source is the main one: this test's made-up source would not be the one searched
  it.skipIf(pluggedLibrary)("says the source's own reason instead of finding nothing; any other failure still lists nothing", async () => {
    const { registerLibrarySlot, resetLibrarySlots, SourceRefusal } = await import("./library/sources");
    let fail: Error = new SourceRefusal("This account's AI has no footage access: an admin turns it on in Settings.");
    registerLibrarySlot("tiny", {
      source: { id: "catalog", label: "Footage catalog", main: true, list: async () => { throw fail; } },
      policies: [{ sourceId: "catalog", canSee: () => true }],
    });
    try {
      const refused = JSON.parse((await tool(fullKey, "media_search", { q: "mat" })).text) as { files: unknown[]; note?: string };
      expect(refused.files).toEqual([]);
      expect(refused.note).toBe("Footage catalog: This account's AI has no footage access: an admin turns it on in Settings.");
      // an error that is no refusal keeps its words to itself
      fail = new Error("catalog.internal:8080 ECONNREFUSED");
      const broken = JSON.parse((await tool(fullKey, "media_search", { q: "mat" })).text) as { files: unknown[]; note?: string };
      expect(broken.files).toEqual([]);
      expect(broken.note).toBeUndefined();
    } finally {
      resetLibrarySlots();
    }
  });
});

describe("the assistant asks for a folder", () => {
  it("in the Mac app the reply gets a Choose a folder button; anywhere else the AI is told to ask for a drop or a typed path", async () => {
    const cookie = await cookieOf("ana");
    const from = async (context: Record<string, unknown>) => {
      expect((await app.request("/api/assistant/turn", { method: "POST", ...json({ text: "Edit my shoot", context }, { cookie }) })).status).toBe(202);
      const job = await claim();
      return { token: `Bearer ${job.mcp.token}`, end: () => finish(job.id) };
    };
    const browser = await from({ path: "/editor", title: "AI Editor" });
    expect(await tool(browser.token, "ask_folder", { why: "the shoot to edit" })).toEqual({ error: true, text: "The user is not in the Creator Toolset Mac app, so no button can choose a folder: ask them to drop the folder on the chat, or to type its path." });
    await browser.end();
    expect((await viewOf(cookie)).messages.at(-1)!.folderAsk).toBeUndefined();
    const mac = await from({ path: "/editor", title: "AI Editor", mac: true });
    expect((await tool(mac.token, "ask_folder", { why: "the  shoot to edit" })).error).toBe(false);
    await mac.end();
    expect((await viewOf(cookie)).messages.at(-1)!.folderAsk).toEqual({ why: "the shoot to edit" });
    // the chosen folder comes as the next message's folder, as a drop does
    expect((await app.request("/api/assistant/turn", { method: "POST", ...json({ text: "", paths: ["/Users/you/Movies/Tiny shoot"] }, { cookie }) })).status).toBe(202);
    const next = await claim();
    expect(next.user).toContain('The user dropped a folder from their computer: "/Users/you/Movies/Tiny shoot" (its path there).');
    await finish(next.id);
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
