import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "mcp-workshop-"));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = "mcp-workshop-secret";

// The Workshop's writer is the one thing stood in for: its answer is handed over as the model's stream would hand it.
// The assistant's own reply still runs on the paired Mac's relay, as it does for real.
vi.mock("../ai-complete", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ai-complete")>()),
  streamWithFallback: vi.fn(),
  completeWithFallback: vi.fn(),
}));

/** A post in the Analyzer's library, as a finished pull leaves it (nothing left for a new source to start). */
function libraryPost(code: string, owner: string, caption: string): string {
  const id = randomUUID();
  const dir = path.join(dataDir, "instagram", id);
  const url = `https://www.instagram.com/p/${code}/`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({
      id, owner, status: "ready", progress: 1, input: url, url, shortcode: code, mediaId: "1", kind: "post", accountId: randomUUID(),
      creator: { id: "1", username: "tinyacrobatics" }, takenAt: 1, caption,
      counts: { likes: 1, comments: 0, fetchedAt: 1 }, comments: { status: "skipped", count: 0, replies: 0 }, bytes: 0, createdAt: 1, updatedAt: 1,
      recipe: { preset: "watch", jobs: ["info", "stats", "transcript"] },
      jobs: [{ type: "info", status: "done" }, { type: "stats", status: "done" }, { type: "transcript", status: "done" }],
      slides: [{ index: 0, kind: "image", file: "", mime: "", width: 10, height: 10, bytes: 0, transcript: { status: "skipped" }, vision: { status: "skipped" } }],
      tags: [],
    }),
  );
  return id;
}
const tumbles = libraryPost("TINYTUMBLE1", "ana", "Three tumbles for a rainy day");
const rolls = libraryPost("TINYROLLS22", "ana", "Forward rolls, step by step");
const hangs = libraryPost("TINYHANGS33", "ana", "Hanging from the bar");
const notHers = libraryPost("TINYOTHER44", "nico", "Somebody else's post");

const { createUser, newApiKey } = await import("../users");
const app = (await import("../boot")).default;
const { streamWithFallback } = await import("../ai-complete");
const { pairDevice } = await import("../lib/devices");
const { saveSettings } = await import("../lib/providers");
const { DEFAULT_SETTINGS } = await import("../../contracts/providers");
import type { AssistantView } from "../../contracts/assistant";

const writer = vi.mocked(streamWithFallback);
const ana = createUser("ana", "password1");
createUser("nico", "password1");
const key = `Bearer ${newApiKey(ana, "full")}`;
const mac = pairDevice("ana", "Ana's Mac");
await saveSettings({ ...structuredClone(DEFAULT_SETTINGS), instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: mac.device.id }] }, "ana");

type Row = Record<string, unknown>;
const cookieOf = async (username: string) => {
  const r = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "password1" }) });
  return r.headers.get("set-cookie")!.split(";")[0]!;
};
const json = (body: unknown, extra: Record<string, string> = {}) => ({ headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
/** One tool call through POST /api/mcp: its answer read as JSON, or the refusal's words. */
const tool = async (authorization: string, name: string, args: Row = {}) => {
  const r = (await (await app.request("/api/mcp", { method: "POST", ...json({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { authorization }) })).json()) as {
    result: { content: Array<{ text: string }>; isError?: boolean };
  };
  const text = r.result.content[0]!.text;
  return r.result.isError ? { error: text } : { value: JSON.parse(text) as Row };
};
/** The page's own request, signed in as that person. */
const page = async <T = Row>(cookie: string, url: string, method = "GET", body?: unknown) =>
  (await (await app.request(url, { method, headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).json()) as T;
type Doc = { id: string; kind: string; blocks: Array<{ id: string; text: string; author: string }> };
const notesOnPage = async (cookie: string, session: string) => (await page<Doc[]>(cookie, `/api/workshop/sessions/${session}/docs`)).find((d) => d.kind === "notes")!;

/** The Mac takes the assistant's reply: its token is the assistant's own, for that reply only. */
const claim = async () => (await (await app.request("/api/devices/relay/wait", { method: "POST", ...json({}, { authorization: `Bearer ${mac.token}` }) })).json()) as { id: string; user: string; mcp: { token: string } };
const viewOf = async (cookie: string) => (await (await app.request("/api/assistant", { headers: { cookie } })).json()) as AssistantView;
const turn = async (cookie: string, text: string) => {
  expect((await app.request("/api/assistant/turn", { method: "POST", ...json({ text }, { cookie }) })).status).toBe(202);
  const job = await claim();
  return { job, token: `Bearer ${job.mcp.token}`, end: async () => void (await app.request(`/api/devices/relay/${job.id}/done`, { method: "POST", ...json({ text: "I asked the writer." }, { authorization: `Bearer ${mac.token}` }) })) };
};
/** Waits until the dock shows what `ready` looks for (the writer ends on its own time, after the reply). */
const shown = async (cookie: string, ready: (v: AssistantView) => boolean) => {
  for (let i = 0; i < 2000; i++) {
    const v = await viewOf(cookie);
    if (ready(v)) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("the dock never showed it");
};

beforeEach(() => {
  writer.mockReset();
});

describe("a session's notes", () => {
  it("written through the tool show in the page's Notes, and Notes typed on the page are what the tools read", async () => {
    const cookie = await cookieOf("ana");
    const s = (await tool(key, "workshop_new_session", { title: "Rainy day tumbles", notes: "the idea" })).value!;
    const id = String(s.id);
    // the page has opened the session: its Notes document exists, made from the notes it started with
    const before = await notesOnPage(cookie, id);
    expect(before.blocks.map((b) => b.text)).toEqual(["the idea"]);

    await tool(key, "workshop_update_session", { session: id, notes: "Film it in the hall.\n\nAsk about the mat." });
    const after = await notesOnPage(cookie, id);
    expect(after.id).toBe(before.id);
    expect(after.blocks.map((b) => [b.text, b.author])).toEqual([["Film it in the hall.\n\nAsk about the mat.", "ai"]]);
    expect((await tool(key, "workshop_session", { session: id })).value!.notes).toBe("Film it in the hall.\n\nAsk about the mat.");

    // typed on the page
    await page(cookie, `/api/workshop/sessions/${id}/docs/${after.id}`, "PATCH", { blocks: [{ id: after.blocks[0]!.id, text: "Typed on the page" }] });
    expect((await tool(key, "workshop_session", { session: id })).value!.notes).toBe("Typed on the page");
    expect((await page(cookie, `/api/workshop/sessions/${id}`)).notes).toBe("Typed on the page");

    // the person's own save of the session's notes is theirs, and cleared notes are gone in both places
    await page(cookie, `/api/workshop/sessions/${id}`, "PATCH", { notes: "Mine again" });
    expect((await notesOnPage(cookie, id)).blocks.map((b) => [b.text, b.author])).toEqual([["Mine again", "user"]]);
    await page(cookie, `/api/workshop/sessions/${id}`, "PATCH", { notes: "" });
    expect((await notesOnPage(cookie, id)).blocks.map((b) => b.text).join("")).toBe("");
    expect((await tool(key, "workshop_session", { session: id })).value!.notes).toBeUndefined();
  });

  it("notes an AI wrote into an opened session before the two were kept in step (the file is the newer one) are still read", async () => {
    const id = String((await tool(key, "workshop_new_session", { title: "From before" })).value!.id);
    await new Promise((r) => setTimeout(r, 5));
    writeFileSync(path.join(dataDir, "workshop", "sessions", id, "notes.md"), "Written where nobody saw it");
    expect((await tool(key, "workshop_session", { session: id })).value!.notes).toBe("Written where nobody saw it");
    // the next save of the notes puts the page and the tools on the same text
    await tool(key, "workshop_update_session", { session: id, notes: "Now in both" });
    expect((await notesOnPage(await cookieOf("ana"), id)).blocks.map((b) => b.text)).toEqual(["Now in both"]);
    expect((await tool(key, "workshop_session", { session: id })).value!.notes).toBe("Now in both");
  });

  it("a copy of a session takes the Notes as the page shows them", async () => {
    const cookie = await cookieOf("ana");
    const id = String((await tool(key, "workshop_new_session", { title: "To copy", notes: "old" })).value!.id);
    const notes = await notesOnPage(cookie, id);
    await page(cookie, `/api/workshop/sessions/${id}/docs/${notes.id}`, "PATCH", { blocks: [{ id: notes.blocks[0]!.id, text: "new on the page" }] });
    const copy = await page(cookie, `/api/workshop/sessions/${id}/duplicate`, "POST", {});
    expect(copy.notes).toBe("new on the page");
  });
});

describe("workshop_sources", () => {
  const link = (code: string) => `https://www.instagram.com/reel/${code}/?igsh=abc`;
  const ids = (v: Row) => (v.sources as Row[]).map((p) => p.id);

  it("lists a session's sources, adds posts by library id or link in the order the page keeps, and takes them out", async () => {
    const cookie = await cookieOf("ana");
    const id = String((await tool(key, "workshop_new_session", { title: "With sources" })).value!.id);
    expect((await tool(key, "workshop_sources", { session: id })).value).toEqual({ sources: [] });

    const first = (await tool(key, "workshop_sources", { session: id, add: [rolls] })).value!;
    expect(first.sources).toEqual([{ id: rolls, url: "https://www.instagram.com/p/TINYROLLS22/", kind: "post", by: "@tinyacrobatics", description: "Forward rolls, step by step" }]);
    // the page's own note on a source stays, as does when it was added
    const kept = (await page<{ sources: Array<{ postId: string; addedAt: number; note?: string }> }>(cookie, `/api/workshop/sessions/${id}`)).sources;
    await page(cookie, `/api/workshop/sessions/${id}`, "PATCH", { sources: [{ ...kept[0]!, note: "the hook" }] });

    // a link in any form the post has; one already there is not added twice; new ones go to the end
    const more = (await tool(key, "workshop_sources", { session: id, add: [link("TINYTUMBLE1"), rolls, hangs] })).value!;
    expect(ids(more)).toEqual([rolls, tumbles, hangs]);
    expect((more.sources as Row[])[0]!.note).toBe("the hook");
    const onPage = await page<{ sources: Array<{ postId: string; addedAt: number; note?: string }>; posts: Array<{ id: string }> }>(cookie, `/api/workshop/sessions/${id}`);
    expect(onPage.posts.map((p) => p.id)).toEqual([rolls, tumbles, hangs]);
    expect(onPage.sources[0]).toEqual({ ...kept[0]!, note: "the hook" });

    // out by link or id, in one call with an add
    const less = (await tool(key, "workshop_sources", { session: id, remove: ["instagram.com/p/TINYROLLS22", hangs], add: [rolls] })).value!;
    expect(ids(less)).toEqual([tumbles, rolls]);
    expect(ids((await tool(key, "workshop_sources", { session: id })).value!)).toEqual([tumbles, rolls]);
    expect((await tool(key, "workshop_session", { session: id })).value!.sources).toHaveLength(2);
  });

  it("says which tool saves a post that is not in the library, and changes nothing then", async () => {
    const id = String((await tool(key, "workshop_new_session", { title: "Not saved yet" })).value!.id);
    const missing = await tool(key, "workshop_sources", { session: id, add: [tumbles, "https://www.instagram.com/p/TINYNEVER99/"] });
    expect(missing.error).toBe("https://www.instagram.com/p/TINYNEVER99/ is not in the Analyzer's library: instagram_save saves it there, then add it here.");
    // someone else's post, an id nobody has, something that is no link
    for (const ref of [notHers, link("TINYOTHER44"), randomUUID(), "tumbles"]) expect((await tool(key, "workshop_sources", { session: id, add: [ref] })).error).toContain("instagram_save");
    expect((await tool(key, "workshop_sources", { session: id, remove: [rolls] })).error).toBe(`${rolls} is not one of this session's sources.`);
    expect((await tool(key, "workshop_sources", { session: id })).value).toEqual({ sources: [] });
    expect((await tool(key, "workshop_sources", { session: randomUUID() })).error).toBe("Not found, or not this account's.");
    expect((await tool(key, "workshop_sources", {})).error).toBe("Give the session's id.");
  });
});

describe("workshop_set_project", () => {
  it("switches the current project, so a new session starts there", async () => {
    const cookie = await cookieOf("ana");
    const project = async (c: string, name: string) => String((await page(c, "/api/workshop/projects", "POST", { name })).id);
    const tiny = await project(cookie, "Tiny Acrobatics");
    const second = await project(cookie, "Second brand");
    const current = async () => (await page(cookie, "/api/workshop/workspace")).currentProjectId;
    expect(await current()).toBe(second); // a new project becomes the current one

    expect((await tool(key, "workshop_set_project", { project: tiny })).value).toEqual({ current: { id: tiny, name: "Tiny Acrobatics" } });
    expect(await current()).toBe(tiny);
    expect((await tool(key, "workshop_new_session", { title: "In the current project" })).value!.projectId).toBe(tiny);

    // not hers, not a project, or none named: refused, and the current one stays
    const nicos = await project(await cookieOf("nico"), "Nico's brand");
    expect((await tool(key, "workshop_set_project", { project: nicos })).error).toBe("Not found, or not this account's.");
    expect((await tool(key, "workshop_set_project", { project: "the second one" })).error).toBe("Unknown project");
    expect((await tool(key, "workshop_set_project", {})).error).toBe("Give the project's id: workshop_projects lists them.");
    expect(await current()).toBe(tiny);
  });
});

describe("the writer the assistant asked", { timeout: 30_000 }, () => {
  type Stream = (system: string, user: string, signal: AbortSignal, parse: (t: string) => unknown) => Promise<unknown>;
  /** The writer's answer waits until `release`; `reached` says the turn got to the model. A Stop ends it as the real stream ends. */
  const held = (answer: () => unknown) => {
    let release!: () => void;
    let begun!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const reached = new Promise<void>((r) => (begun = r));
    writer.mockImplementationOnce((async (_s, _u, signal, parse) => {
      begun();
      await gate;
      const out = signal.aborted ? new Error("aborted") : answer();
      if (out instanceof Error) throw out;
      return { result: parse(JSON.stringify(out)), provider: "Claude (Mac)" };
    }) as Stream as never);
    return { release, reached };
  };
  /** A real reply of the assistant's that starts the writer and ends before the writer does. */
  const askedAndLeft = async (cookie: string, title: string) => {
    const t = await turn(cookie, `Have the writer draft ${title}`);
    const s = (await tool(t.token, "workshop_new_session", { title })).value!;
    const piece = (s.pieces as Row[])[0]!;
    const asked = (await tool(t.token, "workshop_chat", { session: s.id, piece: piece.id, message: "Draft it.", wait_s: 0 })).value!;
    expect((asked.reply as Row).status).toBe("thinking");
    await t.end();
    return { id: String(s.id), piece: String(piece.id) };
  };
  const cardOf = (v: AssistantView, session: string) => v.messages.flatMap((m) => m.work ?? []).find((w) => w.id === `workshop:${session}`)!;

  it("ends its card and says so once in the chat, with a button to see it, after the assistant's own reply has ended", async () => {
    const cookie = await cookieOf("ana");
    const w = held(() => ({ reply: "Drafted.", edits: [{ op: "add", text: "Roll forward, hands first." }] }));
    const { id } = await askedAndLeft(cookie, "Forward rolls");
    await w.reached;
    // the reply is over and the writer is still at it: this is the card that used to say running for ever
    let v = await viewOf(cookie);
    expect(v.messages.at(-1)).toMatchObject({ text: "I asked the writer.", status: "done" });
    expect(cardOf(v, id)).toMatchObject({ status: "running", detail: "The Workshop's writer is drafting" });

    w.release();
    v = await shown(cookie, (x) => cardOf(x, id).status !== "running");
    expect(cardOf(v, id)).toMatchObject({ status: "done", detail: "The writer is done", href: `/workshop/sessions/${id}` });
    expect(v.messages.slice(-2).map((m) => [m.role, m.text, m.status])).toEqual([["assistant", "I asked the writer.", "done"], ["assistant", "The writer finished “Forward rolls”.", "done"]]);
    expect(v.messages.at(-1)!.choices).toEqual(["Show me"]);
    // the next message goes to the AI with that line, so "Show me" has a name to find
    expect((await app.request("/api/assistant/turn", { method: "POST", ...json({ text: "Show me" }, { cookie }) })).status).toBe(202);
    const next = await claim();
    expect(next.user).toContain("Assistant: The writer finished “Forward rolls”.\n\nUser: Show me");
    await app.request(`/api/devices/relay/${next.id}/done`, { method: "POST", ...json({ text: "Here it is." }, { authorization: `Bearer ${mac.token}` }) });
  });

  it("a writer that fails ends the card as failed, with its reason in the chat", async () => {
    const cookie = await cookieOf("ana");
    const w = held(() => new Error("The model is out of reach"));
    const { id } = await askedAndLeft(cookie, "Bar hangs");
    await w.reached;
    w.release();
    const v = await shown(cookie, (x) => cardOf(x, id).status !== "running");
    expect(cardOf(v, id).status).toBe("failed");
    expect(cardOf(v, id).detail).toContain("The model is out of reach");
    expect(v.messages.at(-1)).toMatchObject({ role: "assistant", text: "The writer could not finish “Bar hangs”.", choices: ["Show me"] });
  });

  it("a writer the person stops ends the card and says nothing: they pressed Stop themselves", async () => {
    const cookie = await cookieOf("ana");
    const w = held(() => ({ reply: "Too late.", edits: [] }));
    const { id } = await askedAndLeft(cookie, "Stopped one");
    await w.reached;
    const said = (await viewOf(cookie)).messages.length;
    const reply = (await page<Row[]>(cookie, `/api/workshop/sessions/${id}/chat`)).at(-1)!;
    await page(cookie, `/api/workshop/sessions/${id}/chat/${String(reply.id)}/stop`, "POST", {});
    w.release();
    const v = await shown(cookie, (x) => cardOf(x, id).status !== "running");
    expect(cardOf(v, id)).toMatchObject({ status: "failed", detail: "Stopped" });
    expect(v.messages).toHaveLength(said);
  });

  it("a writer asked on the Workshop's own page says nothing in the chat", async () => {
    const cookie = await cookieOf("ana");
    const s = (await tool(key, "workshop_new_session", { title: "On the page" })).value!;
    const before = (await viewOf(cookie)).messages.length;
    writer.mockImplementationOnce((async (_s, _u, _sig, parse) => ({ result: parse(JSON.stringify({ reply: "Done.", edits: [] })), provider: "Claude (Mac)" })) as Stream as never);
    const sent = await page<{ reply: Row }>(cookie, `/api/workshop/sessions/${String(s.id)}/chat`, "POST", { docId: (s.pieces as Row[])[0]!.id, text: "Tighten it." });
    for (let i = 0; i < 500; i++) {
      if ((await page<Row[]>(cookie, `/api/workshop/sessions/${String(s.id)}/chat`)).find((m) => m.id === sent.reply.id)?.status !== "thinking") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect((await page<Row[]>(cookie, `/api/workshop/sessions/${String(s.id)}/chat`)).at(-1)!.status).toBe("done");
    expect((await viewOf(cookie)).messages).toHaveLength(before);
  });
});
