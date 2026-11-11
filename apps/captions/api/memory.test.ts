import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "memory-"));
process.env.APP_SECRET = "memory-test-secret";

// a made-up tool whose answer is a sentence: a tool's words are never the person's
const { MODULES } = await import("./mcp-tools");
MODULES.push({
  defs: [{ name: "tiny_report", description: "Says a sentence.", inputSchema: { type: "object", properties: {} } }],
  handlers: { tiny_report: async () => ({ report: "The audience likes tumbling reels with loud music" }) },
});

const { createUser, newApiKey } = await import("./users");
const app = (await import("./boot")).default;
const { pluginToolsOf } = await import("./mcp");
const { serverPlugins } = await import("./plugins.gen");
const { SYSTEM, MAC_NOTE, routeOf, runInChat } = await import("./assistant");
const { MEMORY_BLOCK_MAX, foundIn } = await import("./lib/memory");
const { memoryTools } = await import("./mcp-tools/memory");
const { pairDevice } = await import("./lib/devices");
const { saveSettings } = await import("./lib/providers");
const { DEFAULT_SETTINGS } = await import("../contracts/providers");
import { MEMORY_CAP, MEMORY_QUOTE_MAX, type MemoryFact } from "../contracts/memory";

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
type Job = { id: string; user: string; system: string; mcp: { token: string } };
/** The Mac takes the reply's job: what the AI is sent (system, user), and the reply's own token. */
const claim = async () => (await (await app.request("/api/devices/relay/wait", { method: "POST", ...json({}, { authorization: `Bearer ${mac.token}` }) })).json()) as Job;
const cookie = await cookieOf("ana");
/** A turn of ana's with the Mac holding its job. end(text) ends it with the AI's reply, and waits until the chat shows it. */
const turn = async (body: string | Record<string, unknown>) => {
  expect((await app.request("/api/assistant/turn", { method: "POST", ...json(typeof body === "string" ? { text: body } : body, { cookie }) })).status).toBe(202);
  const job = await claim();
  return {
    job,
    token: `Bearer ${job.mcp.token}`,
    end: async (text = "Done.") => {
      await app.request(`/api/devices/relay/${job.id}/done`, { method: "POST", ...json({ text }, { authorization: `Bearer ${mac.token}` }) });
      await vi.waitFor(async () => expect(((await (await app.request("/api/assistant", { headers: { cookie } })).json()) as { messages: Array<{ status?: string }> }).messages.at(-1)!.status).toBe("done"));
    },
  };
};
const newChat = async () => expect((await app.request("/api/assistant", { method: "DELETE", headers: { cookie } })).status).toBe(200);
const kept = async (as = cookie) => ((await (await app.request("/api/memory", { headers: { cookie: as } })).json()) as { facts: MemoryFact[] }).facts;
const removeAll = async () => {
  for (const f of await kept()) expect((await app.request(`/api/memory/${f.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(200);
};
const NOT_SAID = "Not kept: those are not the user's own words in this chat. Quote what they wrote themselves, or keep nothing.";
/** The system prompt origin/main sends for a dock turn on Claude Code: the guide, what this install's plug-ins add, the Mac's note. */
const guide = pluginToolsOf(serverPlugins).guide;
const UNCHANGED = SYSTEM + (guide ? `\n\n${guide}` : "") + MAC_NOTE;

describe("with nothing kept, nothing is different", () => {
  it("no facts: the assistant's prompt equals origin/main's, character for character", async () => {
    await newChat();
    const t = await turn("Hello");
    expect(t.job.system).toBe(UNCHANGED);
    expect(t.job.user).toBe("User: Hello\n\nAnswer the user's last message.");
    await t.end();
    // kept, then removed: the same again
    await newChat();
    const a = await turn("I post every day at 18:00");
    expect((await tool(a.token, "remember", { quote: "I post every day at 18:00" })).error).toBe(false);
    await a.end();
    await newChat();
    const b = await turn("Hello");
    expect(b.job.system).toBe(`${UNCHANGED}\n\nThings the user told you in earlier chats, in their own words, that still hold (their list: Settings, Memory):\n- I post every day at 18:00`);
    await b.end();
    await removeAll();
    await newChat();
    const c = await turn("Hello");
    expect(c.job.system).toBe(UNCHANGED);
    expect(c.job.user).toBe("User: Hello\n\nAnswer the user's last message.");
    await c.end();
  });

  it("the two tools are the assistant's alone, and together stay under 500 bytes", async () => {
    const outside = (await rpc(fullKey, "tools/list")).result.tools!.map((t) => t.name);
    expect(outside).not.toContain("remember");
    expect(outside).not.toContain("forget");
    expect((await tool(fullKey, "remember", { quote: "I post every day at 18:00" })).text).toBe("remember is for the assistant only.");
    const t = await turn("List them");
    const inside = (await rpc(t.token, "tools/list")).result.tools!;
    await t.end();
    const mine = inside.filter((x) => x.name === "remember" || x.name === "forget");
    expect(mine).toEqual(memoryTools.defs.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })));
    // what every turn of every person with a tool-taking AI now carries: say so in the commit when this number moves
    expect(Buffer.byteLength(JSON.stringify(mine))).toBe(494);
  });

  it("only the assistant's turn reads the store: no other prompt builder imports it", () => {
    const api = path.dirname(fileURLToPath(import.meta.url));
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) ? [path.join(dir, e.name)] : []));
    const all = files(api).map((f) => ({ name: path.relative(api, f), dir: path.dirname(f), src: readFileSync(f, "utf8") }));
    expect(all.length).toBeGreaterThan(100);
    // every file that imports the store (api/lib/memory.ts), by any spelling of its path
    const store = path.join(api, "lib", "memory");
    const readers = all.filter((f) => [...f.src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].some((m) => m[1]!.startsWith(".") && path.resolve(f.dir, m[1]!).replace(/\.ts$/, "") === store));
    // the dock's turn, and the routes of the list (which hand no prompt text to anyone)
    expect(readers.map((f) => f.name).sort()).toEqual(["assistant.ts", "memory.ts"]);
    expect(all.filter((f) => f.src.includes("memoryBlock")).map((f) => f.name).sort()).toEqual(["assistant.ts", "lib/memory.ts"]);
    expect(all.find((f) => f.name === "memory.ts")!.src).not.toContain("memoryBlock");
  });

  it("a scheduled run gets none of it and keeps nothing", async () => {
    await newChat();
    const a = await turn("My audience is people who train at home");
    expect((await tool(a.token, "remember", { quote: "My audience is people who train at home" })).error).toBe(false);
    await a.end();
    const run = runInChat("ana", { task: { id: "t1", name: "Weekly" }, prompt: "I always post at noon. Do the weekly thing", preface: "", fresh: true, route: routeOf("ana", false)!, url: "http://localhost/api/mcp" });
    const job = await claim();
    expect(job.system).toBe(SYSTEM + (guide ? `\n\n${guide}` : ""));
    expect(await tool(`Bearer ${job.mcp.token}`, "remember", { quote: "I always post at noon" })).toEqual({ error: true, text: "Only the assistant keeps things, from what the person says to it in a chat." });
    await app.request(`/api/devices/relay/${job.id}/done`, { method: "POST", ...json({ text: "Done." }, { authorization: `Bearer ${mac.token}` }) });
    await run;
    expect((await kept()).map((f) => f.text)).toEqual(["My audience is people who train at home"]);
    await removeAll();
  });
});

describe("only what the person said is kept", () => {
  it("their own words are kept as they wrote them, whatever the quote's case and spacing; the next chat knows them", async () => {
    await newChat();
    const t = await turn("Two things.  No music on\ntalking reels, ever. And I don’t use emojis.");
    expect(JSON.parse((await tool(t.token, "remember", { quote: "no MUSIC   on talking reels" })).text)).toEqual({ kept: "No music on talking reels" });
    expect(JSON.parse((await tool(t.token, "remember", { quote: "I don't use emojis" })).text)).toEqual({ kept: "I don’t use emojis" });
    // the same thing again is kept once
    expect((await tool(t.token, "remember", { quote: "No music on talking reels" })).error).toBe(false);
    await t.end();
    expect((await kept()).map((f) => f.text)).toEqual(["I don’t use emojis", "No music on talking reels"]);
    await newChat();
    const next = await turn("Hello again");
    expect(next.job.system.endsWith("(their list: Settings, Memory):\n- No music on talking reels\n- I don’t use emojis")).toBe(true);
    expect(next.job.user).toBe("User: Hello again\n\nAnswer the user's last message.");
    await next.end();
    await removeAll();
  });

  it("the AI's own words, a tool's answer, a paste, the page and a guess are refused", async () => {
    await newChat();
    const first = await turn("What should I post?");
    await first.end("You always post at noon on Fridays, so try a Friday reel.");
    const t = await turn({
      text: "Look at this page for me",
      pasted: [{ name: "Notes", text: "Every reel must open with a question to the viewer" }],
      context: { path: "/review/abc", title: "Review", selection: "Never show the logo before the hook", visible: "Tiny Acrobatics posts three reels a week" },
    });
    // the reply before this one said it, the person did not
    expect(await tool(t.token, "remember", { quote: "You always post at noon on Fridays" })).toEqual({ error: true, text: NOT_SAID });
    // a tool's answer
    expect(JSON.parse((await tool(t.token, "tiny_report")).text).report).toBe("The audience likes tumbling reels with loud music");
    expect(await tool(t.token, "remember", { quote: "The audience likes tumbling reels with loud music" })).toEqual({ error: true, text: NOT_SAID });
    // a pasted text, what they highlighted, what is on the page
    for (const quote of ["Every reel must open with a question to the viewer", "Never show the logo before the hook", "Tiny Acrobatics posts three reels a week"]) expect(await tool(t.token, "remember", { quote })).toEqual({ error: true, text: NOT_SAID });
    // a guess, and their words bent into something they did not say
    expect(await tool(t.token, "remember", { quote: "The user likes short hooks" })).toEqual({ error: true, text: NOT_SAID });
    expect(await tool(t.token, "remember", { quote: "Look at this page for me every day" })).toEqual({ error: true, text: NOT_SAID });
    // part of a word is not their word
    expect(await tool(t.token, "remember", { quote: "ook at this pag" })).toEqual({ error: true, text: NOT_SAID });
    // no quote, or a wall of text
    expect((await tool(t.token, "remember", { quote: "  " })).text).toBe("Give the user's own words as the quote: a whole sentence of theirs, or nothing.");
    expect((await tool(t.token, "remember", {})).error).toBe(true);
    expect((await tool(t.token, "remember", { quote: "x".repeat(MEMORY_QUOTE_MAX + 1) })).text).toBe("Keep one short thing: a quote of up to 300 characters.");
    await t.end();
    expect(await kept()).toEqual([]);
  });

  it("what they said in another chat is refused in this one", async () => {
    await newChat();
    const a = await turn("I film on Sundays in the garden");
    await a.end();
    await newChat();
    const b = await turn("Plan my week");
    expect(await tool(b.token, "remember", { quote: "I film on Sundays in the garden" })).toEqual({ error: true, text: NOT_SAID });
    await b.end();
    expect(await kept()).toEqual([]);
  });

  it("there is one way in: no page, script or AI key can add a fact, and one account never sees or removes another's", async () => {
    await newChat();
    const t = await turn("I film on Sundays in the garden");
    for (const headers of [{ cookie }, { authorization: fullKey }] as Array<Record<string, string>>) {
      const r = await app.request("/api/memory", { method: "POST", ...json({ quote: "I film on Sundays in the garden" }, headers) });
      expect(r.status).toBe(403);
    }
    expect(await kept()).toEqual([]);
    expect((await tool(t.token, "remember", { quote: "I film on Sundays in the garden" })).error).toBe(false);
    // the reply's token with another account's sign-in: that account said no such thing
    const nico = await cookieOf("nico");
    expect((await app.request("/api/memory", { method: "POST", ...json({ quote: "I film on Sundays in the garden" }, { cookie: nico, authorization: t.token }) })).status).toBe(403);
    await t.end();
    // once the reply has ended its token keeps nothing
    expect((await app.request("/api/memory", { method: "POST", ...json({ quote: "I film on Sundays in the garden" }, { cookie, authorization: t.token }) })).status).toBe(403);
    const [fact] = await kept();
    expect(await kept(nico)).toEqual([]);
    expect((await app.request(`/api/memory/${fact!.id}`, { method: "DELETE", headers: { cookie: nico } })).status).toBe(404);
    expect((await kept()).length).toBe(1);
    await removeAll();
  });
});

describe("a removed fact stays removed", () => {
  it("the message it came from cannot put it back, in the same words or shifted ones; saying it again keeps it again", async () => {
    await newChat();
    const t = await turn("I post at 18:00 every day and I never use stock footage");
    expect((await tool(t.token, "remember", { quote: "I post at 18:00" })).error).toBe(false);
    const [fact] = await kept();
    expect((await app.request(`/api/memory/${fact!.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(200);
    const REMOVED = "The user removed that from memory. It is kept again only when they say it again.";
    expect(await tool(t.token, "remember", { quote: "I post at 18:00" })).toEqual({ error: true, text: REMOVED });
    expect(await tool(t.token, "remember", { quote: "post at 18:00 every day" })).toEqual({ error: true, text: REMOVED });
    expect(await tool(t.token, "remember", { quote: "I never use stock footage" })).toEqual({ error: true, text: REMOVED });
    await t.end();
    expect(await kept()).toEqual([]);
    // in the next reply of the same chat it is still that old message
    const again = await turn("What did I say?");
    expect(await tool(again.token, "remember", { quote: "I post at 18:00" })).toEqual({ error: true, text: REMOVED });
    await again.end();
    const said = await turn("Yes: I post at 18:00");
    expect(JSON.parse((await tool(said.token, "remember", { quote: "I post at 18:00" })).text)).toEqual({ kept: "I post at 18:00" });
    await said.end();
    await removeAll();
  });

  it("forget removes the one fact its words name, and says so when none or several do", async () => {
    await newChat();
    const t = await turn("I post at 18:00 on weekdays. I post at 10:00 on Sundays. My editor is called Mia.");
    for (const quote of ["I post at 18:00 on weekdays", "I post at 10:00 on Sundays", "My editor is called Mia"]) expect((await tool(t.token, "remember", { quote })).error).toBe(false);
    await t.end();
    const f = await turn("Forget what I said about my editor, and about posting");
    expect(await tool(f.token, "forget", { quote: "I love long captions" })).toEqual({ error: true, text: "Nothing kept says that." });
    expect((await tool(f.token, "forget", { quote: "I post at" })).text).toBe('Several kept facts say that: quote one of them in full. "I post at 10:00 on Sundays", "I post at 18:00 on weekdays"');
    expect(JSON.parse((await tool(f.token, "forget", { quote: "my editor is called mia" })).text)).toEqual({ forgot: "My editor is called Mia" });
    expect((await tool(f.token, "forget", {})).text).toBe("Give the words of the fact to remove.");
    await f.end();
    expect((await kept()).map((x) => x.text)).toEqual(["I post at 10:00 on Sundays", "I post at 18:00 on weekdays"]);
    // an AI key from outside the app has no forget tool
    expect((await tool(fullKey, "forget", { quote: "I post at 10:00 on Sundays" })).text).toBe("forget is for the assistant only.");
    await removeAll();
  });
});

describe("the store has a fixed size", () => {
  it("full: the next one is refused in words the AI can pass on, nothing kept is lost, and the prompt's block stays under its cap", async () => {
    await newChat();
    // each kept line counts its words, "- " and the line end: six sentences of 283 make 6 × 286 = 1,716 of the 2,000
    const sentence = (n: number) => `Rule ${n} of mine is ${"that every reel opens on a face ".repeat(8)}always`.padEnd(283, "!");
    const all = Array.from({ length: 7 }, (_, i) => sentence(i + 1));
    expect(all.every((s) => s.length === 283)).toBe(true);
    // a line that fits to the last character: 281 + 3 = 284 = what is left
    const fits = `${"z".repeat(273)} is mine`;
    expect(6 * 286 + fits.length + 3).toBe(MEMORY_CAP);
    const FULL = "Memory is full, so this was not kept. Tell the user: they can remove something in Settings, Memory, and then say it again.";
    const t = await turn([...all, fits, "I also like the colour green"].join("\n"));
    for (const quote of all.slice(0, 6)) expect((await tool(t.token, "remember", { quote })).error).toBe(false);
    const before = await kept();
    expect(before.length).toBe(6);
    expect(await tool(t.token, "remember", { quote: all[6]! })).toEqual({ error: true, text: FULL });
    expect(await kept()).toEqual(before);
    expect((await tool(t.token, "remember", { quote: fits })).error).toBe(false);
    expect(await tool(t.token, "remember", { quote: "I also like the colour green" })).toEqual({ error: true, text: FULL });
    await t.end();
    expect((await kept()).map((f) => f.text)).toEqual([fits, ...all.slice(0, 6).reverse()]);
    await newChat();
    const next = await turn("Hello");
    const block = next.job.system.slice(UNCHANGED.length);
    expect(block.length).toBeGreaterThan(MEMORY_CAP);
    expect(block.length).toBeLessThanOrEqual(MEMORY_BLOCK_MAX);
    expect(MEMORY_BLOCK_MAX).toBeLessThan(MEMORY_CAP + 250);
    for (const s of [...all.slice(0, 6), fits]) expect(block).toContain(`- ${s}`);
    await next.end();
    await removeAll();
  });
});

describe("projects are kept apart", () => {
  it("a fact said for one project is not in another project's prompt; a fact about the person is in both", async () => {
    const project = async (name: string) => ((await (await app.request("/api/workshop/projects", { method: "POST", ...json({ name }, { cookie }) })).json()) as { id: string }).id;
    const enter = async (id: string) => expect((await app.request("/api/workshop/workspace", { method: "PATCH", ...json({ currentProjectId: id }, { cookie }) })).status).toBe(200);
    const tumbles = await project("Tiny Acrobatics");
    const garden = await project("Tiny Gardens");
    await enter(tumbles);
    await newChat();
    const t = await turn("Here we never show faces. And I only film on my phone.");
    expect(JSON.parse((await tool(t.token, "remember", { quote: "we never show faces", project_only: true })).text)).toEqual({ kept: "we never show faces", for_project: "Tiny Acrobatics" });
    expect(JSON.parse((await tool(t.token, "remember", { quote: "I only film on my phone" })).text)).toEqual({ kept: "I only film on my phone" });
    await t.end();
    expect(await kept()).toMatchObject([{ text: "I only film on my phone" }, { text: "we never show faces", project: { id: tumbles, name: "Tiny Acrobatics" } }]);
    expect((await kept())[0]!.project).toBeUndefined();

    await newChat();
    const here = await turn("Hello");
    expect(here.job.system.slice(UNCHANGED.length)).toBe(
      '\n\nThings the user told you in earlier chats, in their own words, that still hold (their list: Settings, Memory):\n- I only film on my phone\nOnly for their current project, "Tiny Acrobatics":\n- we never show faces',
    );
    await here.end();

    await enter(garden);
    await newChat();
    const there = await turn("Hello");
    expect(there.job.system.slice(UNCHANGED.length)).toBe("\n\nThings the user told you in earlier chats, in their own words, that still hold (their list: Settings, Memory):\n- I only film on my phone");
    expect(there.job.system).not.toContain("faces");
    await there.end();
    await removeAll();
  });
});

describe("a quote found in a text", () => {
  it("is the text's own wording: whole words, any case, any spacing, either shape of quote mark", () => {
    expect(foundIn("i post at 18:00", "Well, I  post\nat 18:00.")).toBe("I post at 18:00");
    expect(foundIn("don't", "I don’t and I won’t")).toBe("don’t");
    expect(foundIn("art", "start the cart")).toBeNull();
    expect(foundIn("post at 18", "I post at 180 bpm")).toBeNull();
    expect(foundIn("(a+b)*", "it is (a+b)* really")).toBe("(a+b)*");
    expect(foundIn("", "anything")).toBeNull();
    expect(foundIn("   ", "anything")).toBeNull();
  });
});
