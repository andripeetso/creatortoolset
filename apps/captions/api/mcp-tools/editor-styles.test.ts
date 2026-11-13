import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Edit } from "../../contracts/editor";
import { STYLE_NOTES_MAX, type EditingStyle, type EditingStylesView } from "../../contracts/editor-styles";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "mcp-editor-styles-"));
process.env.APP_SECRET = "mcp-editor-styles-secret";

// a made-up tool whose answer is a sentence: a tool's words are never the person's
const { MODULES } = await import("./index");
MODULES.push({
  defs: [{ name: "tiny_advice", description: "Says a sentence.", inputSchema: { type: "object", properties: {} } }],
  handlers: { tiny_advice: async () => ({ advice: "Trim every clip to two seconds and add a zoom" }) },
});

const { createUser, newApiKey } = await import("../users");
const app = (await import("../boot")).default;
// A loaded plug-in that replaces /api/editor has its own editor: these tests drive the built-in one.
const rootReplaced = (await import("../lib/plugin")).pluginReplaces("/api/editor");
const { libraryDb } = await import("../library/db");
const { routeOf, runInChat } = await import("../assistant");
const { editorStyleTools } = await import("./editor-styles");
const { pairDevice } = await import("../lib/devices");
const { saveSettings } = await import("../lib/providers");
const { DEFAULT_SETTINGS } = await import("../../contracts/providers");

// ana has the footage and the assistant; nico is another account on the same server
const ana = createUser("ana", "password1");
const nico = createUser("nico", "password1");
const anaKey = `Bearer ${newApiKey(ana, "full")}`;
const nicoKey = `Bearer ${newApiKey(nico, "full")}`;
const mac = pairDevice("ana", "Ana's Mac");
await saveSettings({ ...structuredClone(DEFAULT_SETTINGS), instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: mac.device.id }] }, "ana");
libraryDb().exec(`
  INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'ana', 'A', 'local', 0);
  INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('ast_a', 'lib_a', 'video', 'Take 1', 'ana', 0);
  INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES ('ver_a', 'ast_a', 1, 'k1', 1, 'x1', 'ready', 'ana', 0);
`);

type Row = Record<string, unknown>;
const json = (body: unknown, extra: Record<string, string> = {}) => ({ headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
const cookie = (await app.request("/api/auth/login", { method: "POST", ...json({ username: "ana", password: "password1" }) })).headers.get("set-cookie")!.split(";")[0]!;
/** One of the site's routes as ana at the screen: what a tool did is checked here, not in the tool's own answer. */
const site = (route: string, method = "GET", body?: unknown) => app.request(route, { method, ...(body === undefined ? { headers: { cookie } } : json(body, { cookie })) });
const mine = async () => ((await (await site("/api/editor/styles")).json()) as EditingStylesView).styles;
const styleOf = async (id: string) => (await mine()).find((s) => s.id === id)!;
const editOf = async (id: string) => (await (await site(`/api/editor/${id}`)).json()) as Edit;
const clear = async () => {
  for (const s of await mine()) expect((await site(`/api/editor/styles/${s.id}`, "DELETE")).status).toBe(200);
};
const rpc = async (authorization: string, method: string, params: unknown = {}) =>
  (await (await app.request("/api/mcp", { method: "POST", ...json({ jsonrpc: "2.0", id: 1, method, params }, { authorization }) })).json()) as {
    result: { tools?: Array<{ name: string; description: string; inputSchema: unknown }>; content?: Array<{ text: string }>; isError?: boolean };
  };
// what the model reads of each tool (a title and annotations are labels for the AI app around it)
const toolsOf = async (authorization: string) =>
  (await rpc(authorization, "tools/list")).result.tools!.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
const tool = async (authorization: string, name: string, args: Row = {}) => {
  const r = (await rpc(authorization, "tools/call", { name, arguments: args })).result;
  const text = r.content![0]!.text;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { error: !!r.isError, text, value: (r.isError || !/^[[{]/.test(text) ? text : JSON.parse(text)) as any };
};
type Job = { id: string; user: string; mcp: { token: string } };
const claim = async () => (await (await app.request("/api/devices/relay/wait", { method: "POST", ...json({}, { authorization: `Bearer ${mac.token}` }) })).json()) as Job;
/** A turn of ana's with the Mac holding its job: the token to call tools as that reply. end(text) ends it with the AI's reply, and waits until the chat shows it. */
const turn = async (text: string) => {
  expect((await app.request("/api/assistant/turn", { method: "POST", ...json({ text }, { cookie }) })).status).toBe(202);
  const job = await claim();
  return {
    token: `Bearer ${job.mcp.token}`,
    end: async (said = "Done.") => {
      await app.request(`/api/devices/relay/${job.id}/done`, { method: "POST", ...json({ text: said }, { authorization: `Bearer ${mac.token}` }) });
      await vi.waitFor(async () => expect(((await (await site("/api/assistant")).json()) as { messages: Array<{ status?: string }> }).messages.at(-1)!.status).toBe("done"));
    },
  };
};
const newChat = async () => expect((await site("/api/assistant", "DELETE")).status).toBe(200);

const NOT_TYPED =
  "Not saved: the notes are not the user's own words in this chat. Send a whole phrase they typed themselves, or a passage of a long text they pasted with this message, word for word, or leave notes out: they write them on the style's sheet (AI Editor, Editing styles).";
const SHEET = "http://localhost/editor?tab=styles";

describe.skipIf(rootReplaced)("who is offered the style tools", () => {
  it("editor_style_save is everyone's; editor_style_use comes with the account's first style and goes with its last", async () => {
    const names = async (auth: string) => (await toolsOf(auth)).map((t) => t.name);
    const before = await turn("What can you do?");
    const dock = await toolsOf(before.token);
    const outside = await toolsOf(anaKey);
    await before.end();
    for (const list of [dock, outside]) {
      expect(list.map((t) => t.name)).toContain("editor_style_save");
      expect(list.map((t) => t.name)).not.toContain("editor_style_use");
    }

    const made = (await (await site("/api/editor/styles", "POST", { name: "Tiny first" })).json()) as EditingStyle;
    const withOne = await turn("And now?");
    const dockNow = await toolsOf(withOne.token);
    await withOne.end();
    const use = editorStyleTools.defs.find((d) => d.name === "editor_style_use")!;
    // the one tool more, after editor_style_save, as its file defines it; the rest of both lists is what it was
    for (const [now, was] of [[dockNow, dock], [await toolsOf(anaKey), outside]] as const) {
      expect(now.filter((t) => t.name !== "editor_style_use")).toEqual(was);
      expect(now[now.findIndex((t) => t.name === "editor_style_save") + 1]).toEqual(use);
    }
    // what an account with a style carries on every turn besides: say so in the commit when this number moves
    const bytes = (list: unknown[]) => Buffer.byteLength(JSON.stringify(list));
    expect(bytes(dockNow) - bytes(dock)).toBe(334);
    // another account's style gives this one nothing
    expect(await names(nicoKey)).not.toContain("editor_style_use");

    expect((await site(`/api/editor/styles/${made.id}`, "DELETE")).status).toBe(200);
    const after = await turn("And now?");
    expect(await toolsOf(after.token)).toEqual(dock);
    await after.end();
    expect(await toolsOf(anaKey)).toEqual(outside);
  });
});

describe.skipIf(rootReplaced)("making, changing and picking a style by asking", () => {
  it("the assistant, in a reply: makes one with the person's words as its notes, changes it, copies one from an edit, lists them, and puts one on an edit that has not run", async () => {
    await clear();
    await newChat();
    const t = await turn("Make me an editing style called Tiny fast. Cut it fast with no pauses, and keep the bloopers in. Three versions of 30 seconds, natural pace, strong punch-in.");
    // the notes as the AI sends them: other case and spacing than typed. What is kept is the person's wording
    const made = await tool(t.token, "editor_style_save", { name: "Tiny fast", notes: "cut it FAST   with no pauses, and keep the bloopers in", versions: 3, target_s: 30, pace: "natural", punch: 1.3 });
    expect(made.value).toEqual({ id: expect.any(String), name: "Tiny fast", versions: 3, target_s: 30, pace: "natural", punch: 1.3, size: "footage", has_notes: true, made: true, link: `${SHEET}&style=${made.value.id}` });
    const id = made.value.id as string;
    // and the style's sheet opens for the person
    expect(((await (await site("/api/assistant")).json()) as { navigate?: string }).navigate).toBe(`/editor?tab=styles&style=${id}`);
    expect(await styleOf(id)).toMatchObject({ name: "Tiny fast", notes: "Cut it fast with no pauses, and keep the bloopers in", versions: 3, targetS: 30, pace: "natural", punch: 1.3 });

    // a change, by id or by name: only what is sent moves; a number is kept as the route keeps it
    expect((await tool(t.token, "editor_style_save", { id, versions: 9, pace: "tight" })).value).toMatchObject({ id, versions: 5, pace: "tight", target_s: 30 });
    expect((await tool(t.token, "editor_style_save", { id: "tiny FAST", name: "Tiny faster" })).value).toMatchObject({ id, name: "Tiny faster" });
    // the working size: one of the offered ones, or the footage's own
    expect((await tool(t.token, "editor_style_save", { id, size: "1080x1920" })).value).toMatchObject({ id, size: "1080x1920" });
    expect((await styleOf(id)).size).toEqual({ w: 1080, h: 1920 });
    expect((await tool(t.token, "editor_style_save", { id, size: "footage" })).value).toMatchObject({ id, size: "footage" });
    expect((await styleOf(id)).size).toBeNull();
    expect((await styleOf(id)).notes).toBe("Cut it fast with no pauses, and keep the bloopers in");
    expect(await tool(t.token, "editor_style_save", { id })).toMatchObject({ error: true, text: "Nothing to change: give name, versions, target_s, pace, punch, passes, size or notes." });
    expect(await tool(t.token, "editor_style_save", { notes: "Cut it fast with no pauses" })).toMatchObject({ error: true, text: "Give the new style a name." });
    expect(await tool(t.token, "editor_style_save", { id: "nope", versions: 2 })).toMatchObject({ error: true, text: `No style has that id or name. The user's styles: Tiny faster (${id}).` });
    expect(await tool(t.token, "editor_style_save", { id, pace: "slow" })).toMatchObject({ error: true, text: "pace is one of tight, natural" });

    // a copy of an edit's choices: never its brief or script
    const from = ((await (await site("/api/editor", "POST", { name: "Tiny source", sources: ["ver_a"], versions: 4, targetS: 20, brief: "A reel for parents of crawlers." })).json()) as { id: string }).id;
    const copied = (await tool(t.token, "editor_style_save", { name: "Like Tiny source", from_edit: from })).value;
    expect(copied).toMatchObject({ name: "Like Tiny source", versions: 4, target_s: 20, has_notes: false, made: true });
    expect(JSON.stringify(await styleOf(copied.id))).not.toContain("crawlers");
    expect(await tool(t.token, "editor_style_save", { id, from_edit: from })).toMatchObject({ error: true, text: "from_edit makes a new style: leave id out." });
    expect(await tool(t.token, "editor_style_save", { name: "Nobody's", from_edit: "nope" })).toMatchObject({ error: true, text: "Not found, or not this account's." });

    // the list: each style's choices, never its notes
    const listed = await tool(t.token, "editor_style_use");
    expect(listed.value).toEqual({
      styles: [
        { id, name: "Tiny faster", versions: 5, target_s: 30, pace: "tight", punch: 1.3, size: "footage", has_notes: true },
        { id: copied.id, name: "Like Tiny source", versions: 4, target_s: 20, pace: "tight", punch: 1.15, size: "footage", has_notes: false },
      ],
      link: SHEET,
    });
    expect(listed.text).not.toContain("bloopers");

    // on an edit that has not run: made without starting, the style put on, then run
    const edit = (await tool(t.token, "editor_create", { sources: ["ver_a"], name: "Tiny styled", start: false })).value.id as string;
    expect((await editOf(edit)).style).toBeUndefined();
    expect((await tool(t.token, "editor_style_use", { edit, style: "tiny faster" })).value).toEqual({ id: edit, name: "Tiny styled", versions: 5, target_s: 30, style: "Tiny faster", link: `http://localhost/editor/${edit}` });
    expect(await editOf(edit)).toMatchObject({ versions: 5, targetS: 30, style: { id, name: "Tiny faster", notes: "Cut it fast with no pauses, and keep the bloopers in", pace: "tight" } });
    expect(await tool(t.token, "editor_style_use", { edit })).toMatchObject({ error: true, text: "Give style: a style's id or name, or none to take the edit's style off." });
    expect((await editOf(edit)).style?.id).toBe(id);
    expect(await tool(t.token, "editor_style_use", { style: id })).toMatchObject({ error: true, text: "Give the edit's id: editor_list lists them." });
    expect((await tool(t.token, "editor_style_use", { edit, style: "none" })).value).toMatchObject({ id: edit, style: "none" });
    expect((await editOf(edit)).style).toBeUndefined();
    await t.end();
    // the reply's token ends with the reply, and reaches no route by itself
    expect((await app.request("/api/editor/styles", { headers: { authorization: t.token } })).status).toBe(401);
  });

  it("the person's own AI, with an access key: the same five, and its notes are theirs to write", async () => {
    await clear();
    const made = (await tool(anaKey, "editor_style_save", { name: "Tiny calm", notes: "Leave the pauses in. Slow and warm.", target_s: 45 })).value;
    expect(made).toMatchObject({ name: "Tiny calm", versions: 1, target_s: 45, pace: "tight", punch: 1.15, has_notes: true, made: true });
    expect((await styleOf(made.id)).notes).toBe("Leave the pauses in. Slow and warm.");
    expect((await tool(anaKey, "editor_style_save", { id: made.id, punch: 1 })).value).toMatchObject({ id: made.id, punch: 1 });
    const from = ((await (await site("/api/editor", "POST", { name: "Tiny source", sources: ["ver_a"], versions: 2 })).json()) as { id: string }).id;
    const copied = (await tool(anaKey, "editor_style_save", { name: "Tiny copy", from_edit: from })).value;
    expect(copied).toMatchObject({ versions: 2, made: true });
    expect((await tool(anaKey, "editor_style_use")).value.styles.map((s: Row) => s.name)).toEqual(["Tiny calm", "Tiny copy"]);
    const edit = (await tool(anaKey, "editor_create", { sources: ["ver_a"], name: "Tiny keyed", start: false })).value.id as string;
    expect((await tool(anaKey, "editor_style_use", { edit, style: made.id })).value).toMatchObject({ id: edit, style: "Tiny calm", target_s: 45 });
    expect((await editOf(edit)).style).toMatchObject({ id: made.id, notes: "Leave the pauses in. Slow and warm." });

    // another account has neither the styles nor the edit
    expect((await tool(nicoKey, "editor_style_use")).value).toEqual({ styles: [], link: SHEET });
    expect(await tool(nicoKey, "editor_style_use", { edit, style: made.id })).toMatchObject({ error: true, text: "The user has no editing style yet: editor_style_save makes one." });
    expect(await tool(nicoKey, "editor_style_save", { id: made.id, versions: 5 })).toMatchObject({ error: true, text: "The user has no editing style yet: editor_style_save makes one." });
    expect(await tool(nicoKey, "editor_style_save", { name: "Not mine", from_edit: from })).toMatchObject({ error: true, text: "Not found, or not this account's." });
    expect((await styleOf(made.id)).versions).toBe(1);
  });
});

describe.skipIf(rootReplaced)("a style's notes are the person's own words", () => {
  const refused = { error: true, text: NOT_TYPED };

  it("words the AI wrote, a tool's answer, its own earlier reply and another chat's message are refused, and nothing is saved", async () => {
    await clear();
    await newChat();
    const a = await turn("Always keep the bloopers in the cut");
    await a.end("Short clips with a zoom on every laugh work best for you.");
    await newChat();
    const b = await turn("Make me a style for my reels, you decide how");
    expect((await tool(b.token, "tiny_advice")).error).toBe(false);
    // made up by the AI
    expect(await tool(b.token, "editor_style_save", { name: "Tiny guess", notes: "Fast cuts with a punch-in on every joke" })).toMatchObject(refused);
    // a tool's answer
    expect(await tool(b.token, "editor_style_save", { name: "Tiny guess", notes: "Trim every clip to two seconds and add a zoom" })).toMatchObject(refused);
    // typed by the person, but in another chat
    expect(await tool(b.token, "editor_style_save", { name: "Tiny guess", notes: "Always keep the bloopers in the cut" })).toMatchObject(refused);
    // their words with the AI's added
    expect(await tool(b.token, "editor_style_save", { name: "Tiny guess", notes: "Make me a style for my reels, with fast cuts" })).toMatchObject(refused);
    await b.end("Short clips with a zoom on every laugh.");
    // the AI's own reply, a turn later
    const c = await turn("Yes, save that");
    expect(await tool(c.token, "editor_style_save", { name: "Tiny guess", notes: "Short clips with a zoom on every laugh" })).toMatchObject(refused);
    expect(await mine()).toEqual([]);
    // without notes the same save goes through: the name and the numbers need no check
    expect((await tool(c.token, "editor_style_save", { name: "Tiny guess", versions: 2 })).value).toMatchObject({ name: "Tiny guess", versions: 2, has_notes: false, made: true });
    await c.end();
  });

  it("an answer button they pressed is the AI's wording: refused; and notes are never put together a word at a time", async () => {
    await clear();
    await newChat();
    const a = await turn("How should my reels be cut?");
    expect((await tool(a.token, "offer_choices", { choices: ["Cut on every breath", "Leave the pauses in"] })).error).toBe(false);
    await a.end("Fast or calm?");
    // the press sends the button's words as their message
    const b = await turn("Cut on every breath");
    expect(await tool(b.token, "editor_style_save", { name: "Tiny pressed", notes: "Cut on every breath" })).toMatchObject(refused);
    await b.end();
    const c = await turn("I want it to feel like a slow morning with no music at all");
    const id = (await tool(c.token, "editor_style_save", { name: "Tiny morning" })).value.id as string;
    // single words of theirs, sent one call each, would spell a sentence they never wrote
    for (const word of ["no", "slow", "music", "all", "morning"]) expect(await tool(c.token, "editor_style_save", { id, notes: word }), word).toMatchObject(refused);
    expect(await tool(c.token, "editor_style_save", { name: "Tiny words", notes: "music" })).toMatchObject(refused);
    expect((await styleOf(id)).notes).toBe("");
    // a whole phrase of theirs is kept, in their wording
    expect((await tool(c.token, "editor_style_save", { id, notes: "a SLOW morning with no music at all" })).value).toMatchObject({ id, has_notes: true });
    expect((await styleOf(id)).notes).toBe("a slow morning with no music at all");
    await c.end();
  });

  it("a change adds the person's words under the notes the style has: what they wrote before stays, the same line is not added twice, and nothing is dropped at the cap", async () => {
    await clear();
    await newChat();
    const own = (await (await site("/api/editor/styles", "POST", { name: "Tiny mine", notes: "Open on the result." })).json()) as EditingStyle;
    const t = await turn("On Tiny mine, never use jump cuts in the middle of a sentence");
    const added = (await tool(t.token, "editor_style_save", { id: own.id, notes: "never use jump cuts in the middle of a sentence" })).value;
    expect(added).toMatchObject({ id: own.id, has_notes: true, note: "The words were added under the style's notes. The user rewrites or shortens the notes on the style's sheet." });
    expect((await styleOf(own.id)).notes).toBe("Open on the result.\nnever use jump cuts in the middle of a sentence");
    await tool(t.token, "editor_style_save", { id: own.id, notes: "Never use jump cuts in the middle of a sentence" });
    expect((await styleOf(own.id)).notes).toBe("Open on the result.\nnever use jump cuts in the middle of a sentence");
    // the AI's words on a change are refused as on a new style, and the notes stay
    expect(await tool(t.token, "editor_style_save", { id: own.id, notes: "Add a whoosh on every cut" })).toMatchObject(refused);
    expect((await styleOf(own.id)).notes).toBe("Open on the result.\nnever use jump cuts in the middle of a sentence");

    // full notes: the line does not fit, the save is refused in words, and the notes are whole
    const full = "x".repeat(STYLE_NOTES_MAX - 10);
    expect((await site(`/api/editor/styles/${own.id}`, "PUT", { notes: full })).status).toBe(200);
    expect(await tool(t.token, "editor_style_save", { id: own.id, notes: "never use jump cuts in the middle of a sentence" })).toMatchObject({ error: true, text: `The notes are at most ${STYLE_NOTES_MAX} characters` });
    expect((await styleOf(own.id)).notes).toBe(full);
    await t.end();
  });

  it("a scheduled run has nobody typing: it saves no notes, not even its own prompt's words", async () => {
    await clear();
    const run = runInChat("ana", { task: { id: "t1", name: "Weekly" }, prompt: "Make a style that keeps every pause in the cut", preface: "", fresh: true, route: routeOf("ana", false)!, url: "http://localhost/api/mcp" });
    const job = await claim();
    expect(await tool(`Bearer ${job.mcp.token}`, "editor_style_save", { name: "Tiny weekly", notes: "keeps every pause in the cut" })).toMatchObject(refused);
    await app.request(`/api/devices/relay/${job.id}/done`, { method: "POST", ...json({ text: "Done." }, { authorization: `Bearer ${mac.token}` }) });
    await run;
    expect(await mine()).toEqual([]);
  });

  it("the same save from the person's own page, and from their own AI with an access key, is kept as sent", async () => {
    await clear();
    const words = "Fast cuts with a punch-in on every joke";
    const page = (await (await site("/api/editor/styles", "POST", { name: "Tiny page", notes: words })).json()) as EditingStyle;
    expect(page.notes).toBe(words);
    // the page replaces the notes: that is the sheet's own save
    expect(((await (await site(`/api/editor/styles/${page.id}`, "PUT", { notes: "Slower." })).json()) as EditingStyle).notes).toBe("Slower.");
    const keyed = (await tool(anaKey, "editor_style_save", { name: "Tiny keyed", notes: words })).value;
    expect((await styleOf(keyed.id)).notes).toBe(words);
    expect((await tool(anaKey, "editor_style_save", { id: keyed.id, notes: "Add a whoosh on every cut" })).value).toMatchObject({ has_notes: true });
    expect((await styleOf(keyed.id)).notes).toBe(`${words}\nAdd a whoosh on every cut`);
  });
});
