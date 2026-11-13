import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Many chats at once: each chat by its id, replies in different chats written at the same time, up to MAX_RUNNING.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "assistant-many-chats-"));
process.env.APP_SECRET = "assistant-test-secret";

const { createUser, findUser, newApiKey } = await import("./users");
const app = (await import("./boot")).default;
const { pairDevice } = await import("./lib/devices");
const { saveSettings } = await import("./lib/providers");
const { DEFAULT_SETTINGS } = await import("../contracts/providers");
const { MAX_RUNNING, noteWork, resumeFromDisk, routeOf, runInChat } = await import("./assistant");
const { onAttention } = await import("./lib/attention");
type View = import("../contracts/assistant").AssistantView;
type Chat = import("../contracts/assistant").AssistantChat;
type Attention = import("./lib/attention").Attention;

const json = (body: unknown, extra: Record<string, string> = {}) => ({ headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const stillWaiting = async (p: Promise<unknown>) => (await Promise.race([p.then(() => "settled"), tick(150).then(() => "waiting")])) === "waiting";

/** An account with its own Mac running Claude Code (the fake AI answers on the relay). */
async function person(name: string) {
  createUser(name, "password1");
  const mac = pairDevice(name, `${name}'s Mac`);
  await saveSettings({ ...structuredClone(DEFAULT_SETTINGS), instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: mac.device.id }] }, name);
  const login = await app.request("/api/auth/login", { method: "POST", ...json({ username: name, password: "password1" }) });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const device = { authorization: `Bearer ${mac.token}` };
  type Job = { id: string; user: string; files?: Record<string, string>; mcp: { token: string } };
  const get = async <T>(url: string) => (await (await app.request(url, { headers: { cookie } })).json()) as T;
  return {
    cookie,
    claim: async () => (await (await app.request("/api/devices/relay/wait", { method: "POST", ...json({}, device) })).json()) as Job,
    ask: (id: string, body: Record<string, unknown>) => app.request(`/api/devices/relay/${id}/ask`, { method: "POST", ...json(body, device) }),
    answer: (id: string, text: string) => app.request(`/api/devices/relay/${id}/done`, { method: "POST", ...json({ text }, device) }),
    fail: (id: string, error: string) => app.request(`/api/devices/relay/${id}/fail`, { method: "POST", ...json({ error }, device) }),
    view: () => get<View>("/api/assistant"),
    chats: async () => (await get<{ chats: Chat[] }>("/api/assistant/chats")).chats,
    chat: (id: string) => get<View>(`/api/assistant/chats/${id}`),
    make: async () => ((await (await app.request("/api/assistant/chats", { method: "POST", headers: { cookie } })).json()) as { id: string }).id,
    sendTo: (chat: string, body: Record<string, unknown>) => app.request(`/api/assistant/chats/${chat}/turn`, { method: "POST", ...json(body, { cookie }) }),
    send: (body: Record<string, unknown>) => app.request("/api/assistant/turn", { method: "POST", ...json(body, { cookie }) }),
    stop: (body: Record<string, unknown>) => app.request("/api/assistant/stop", { method: "POST", ...json(body, { cookie }) }),
    upload: async (name: string, size = 4096) => {
      const { id, partSize } = (await (await app.request("/api/assistant/files", { method: "POST", ...json({ name, mime: "video/mp4", size }, { cookie }) })).json()) as { id: string; partSize: number };
      return {
        id,
        part: () =>
          app.request(`/api/assistant/files/${id}/parts/1`, {
            method: "POST",
            headers: { cookie, "upload-length": String(size), "upload-part-size": String(partSize), "content-length": String(size), "content-type": "application/octet-stream" },
            body: Buffer.alloc(size, 1),
          }),
      };
    },
  };
}
type Person = Awaited<ReturnType<typeof person>>;

/** That chat's view once its newest message is no longer being written. */
async function settled(p: Person, chat: string) {
  let v = await p.chat(chat);
  for (let i = 0; i < 50 && v.messages.at(-1)?.status === "thinking"; i++) v = (await tick(), await p.chat(chat));
  return v;
}

/** One MCP tool call under a reply's job token. */
async function tool(token: string, name: string, args: Record<string, unknown>) {
  const r = await app.request("/api/mcp", { method: "POST", ...json({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { authorization: `Bearer ${token}` }) });
  return ((await r.json()) as { result: { isError?: boolean } }).result;
}

/** Jobs claimed now, by the words in their prompt (claim order says nothing). */
const byText = <J extends { user: string }>(jobs: J[], words: string) => jobs.find((j) => j.user.includes(words))!;

const heard: Attention[] = [];
onAttention((a) => void heard.push(a));

describe("many chats", () => {
  it("a new chat by id, a turn there without opening it; replies in two chats run at once, and in one chat the second waits for the first", async () => {
    const p = await person("amy");
    const open = (await p.view()).id;
    const b = await p.make();
    expect((await p.view()).id).toBe(open); // the open chat stays open
    expect((await p.view()).past.map((c) => c.id)).not.toContain(b); // empty: not among the dock's earlier chats yet
    expect((await p.chats()).map((c) => c.id)).toEqual(expect.arrayContaining([open, b]));
    expect((await p.view()).chats).toBe(true);
    await p.send({ text: "Alpha one" });
    const r = await p.sendTo(b, { text: "Beta one" });
    expect(r.status).toBe(202);
    const bv = (await r.json()) as View;
    expect(bv.id).toBe(b);
    expect(bv.messages.map((m) => [m.text, m.wait?.for])).toEqual([["Beta one", undefined], ["", undefined]]);
    const jobs = [await p.claim(), await p.claim()];
    const alpha = byText(jobs, "Alpha one");
    const beta = byText(jobs, "Beta one");
    // each prompt holds only its own chat
    expect(alpha.user).not.toContain("Beta");
    expect(beta.user).not.toContain("Alpha");
    // a 2nd message in chat b waits for b's reply, not for a
    const second = ((await (await p.sendTo(b, { text: "Beta two" })).json()) as View).messages.at(-1)!;
    expect(second.wait).toEqual({ for: "reply", text: "Waiting for the reply before it" });
    const next = p.claim();
    expect(await stillWaiting(next)).toBe(true);
    await p.answer(alpha.id, "Answer alpha");
    expect(await stillWaiting(next)).toBe(true);
    await p.answer(beta.id, "Answer beta");
    const two = await next;
    expect(two.user).toContain("Answer beta");
    expect(two.user).toContain("Beta two");
    expect(two.user).not.toContain("Alpha");
    await p.answer(two.id, "Answer beta two");
    expect((await settled(p, b)).messages.map((m) => m.text)).toEqual(["Beta one", "Answer beta", "Beta two", "Answer beta two"]);
    expect((await p.view()).messages.map((m) => m.text)).toEqual(["Alpha one", "Answer alpha"]);
    expect((await p.view()).past.map((c) => c.id)).toContain(b);
    // a chat that's gone
    expect((await p.sendTo("00000000-0000-4000-8000-000000000000", { text: "x" })).status).toBe(404);
    expect((await app.request("/api/assistant/chats/nope", { headers: { cookie: p.cookie } })).status).toBe(404);
  });

  it("settle: a chat folds away in both lists, a newer message brings it back, and so does un-settle", async () => {
    const p = await person("sid");
    const b = await p.make();
    await p.sendTo(b, { text: "Settle me" });
    await p.answer((await p.claim()).id, "Done here.");
    await settled(p, b);
    const settle = (on: unknown) => app.request(`/api/assistant/chats/${b}/settle`, { method: "POST", ...json({ settled: on }, { cookie: p.cookie }) });
    expect((await settle("yes")).status).toBe(400);
    expect((await app.request("/api/assistant/chats/nope/settle", { method: "POST", ...json({ settled: true }, { cookie: p.cookie }) })).status).toBe(404);
    const r = (await (await settle(true)).json()) as { chats: Chat[] };
    expect(r.chats.find((c) => c.id === b)?.settled).toBe(true);
    expect((await p.view()).past.find((c) => c.id === b)?.settled).toBe(true);
    // a new message in it: back among the others
    await p.sendTo(b, { text: "One more thing" });
    expect((await p.chats()).find((c) => c.id === b)?.settled).toBeUndefined();
    await p.answer((await p.claim()).id, "Sure.");
    await settled(p, b);
    expect((await p.chats()).find((c) => c.id === b)?.settled).toBeUndefined();
    await settle(true);
    await settle(false);
    expect((await p.chats()).find((c) => c.id === b)?.settled).toBeUndefined();
  });

  it("unread: a reply that ended since you sent or looked marks its chat, and looking at it clears the mark", async () => {
    const p = await person("una");
    const b = await p.make();
    await p.sendTo(b, { text: "Tell me when it is done" });
    // still being written: working, not unread
    expect((await p.chats()).find((c) => c.id === b)).toMatchObject({ working: true });
    expect((await p.chats()).find((c) => c.id === b)?.unread).toBeUndefined();
    await p.answer((await p.claim()).id, "It is done.");
    await settled(p, b);
    expect((await p.chats()).find((c) => c.id === b)?.unread).toBe(true);
    expect((await app.request("/api/assistant/chats/nope/seen", { method: "POST", headers: { cookie: p.cookie } })).status).toBe(404);
    await tick(5);
    expect((await app.request(`/api/assistant/chats/${b}/seen`, { method: "POST", headers: { cookie: p.cookie } })).status).toBe(200);
    expect((await p.chats()).find((c) => c.id === b)?.unread).toBeUndefined();
  });

  it("navigate: the page a reply asks for opens in its own chat, never under the chat that is open", async () => {
    const p = await person("nav");
    const b = await p.make();
    await p.sendTo(b, { text: "Open the Workshop for me" });
    const job = await p.claim();
    expect((await tool(job.mcp.token, "navigate", { path: "/workshop" })).isError).toBeFalsy();
    // the open chat is another one: its page stays where it is
    expect((await p.view()).navigate).toBeNull();
    expect((await p.chat(b)).navigate).toBe("/workshop");
    await p.answer(job.id, "Opened.");
    await settled(p, b);
    // that chat becomes the open one: now the page is asked for, once
    const opened = (await (await app.request(`/api/assistant/past/${b}/open`, { method: "POST", headers: { cookie: p.cookie } })).json()) as View;
    expect(opened.navigate).toBe("/workshop");
    await app.request("/api/assistant/navigated", { method: "POST", headers: { cookie: p.cookie } });
    expect((await p.view()).navigate).toBeNull();
  });

  it(`the cap: ${MAX_RUNNING} replies at once, the next waits in send order and starts when one ends; the list says which are working`, async () => {
    const p = await person("bo");
    const ids = [await p.make(), await p.make(), await p.make(), await p.make()];
    for (const [i, id] of ids.entries()) expect((await p.sendTo(id, { text: `Chat ${i}` })).status).toBe(202);
    const jobs = [await p.claim(), await p.claim(), await p.claim()];
    expect(jobs.map((j) => /Chat (\d)/.exec(j.user)![1]).sort()).toEqual(["0", "1", "2"]);
    const fourth = p.claim();
    expect(await stillWaiting(fourth)).toBe(true);
    expect((await p.chat(ids[3]!)).messages.at(-1)!.wait).toEqual({ for: "reply", text: `Waiting: ${MAX_RUNNING} other chats are answering` });
    const list = await p.chats();
    for (const id of ids) expect(list.find((c) => c.id === id)).toMatchObject({ working: true, count: 2 });
    await p.answer(byText(jobs, "Chat 1").id, "One done.");
    const got = await fourth;
    expect(got.user).toContain("Chat 3");
    expect((await p.chat(ids[3]!)).messages.at(-1)!.wait).toBeUndefined();
    for (const j of [...jobs, got]) await p.answer(j.id, "Done.");
    await settled(p, ids[3]!);
    expect((await p.chats()).find((c) => c.id === ids[1])).toMatchObject({ last: "One done." });
    expect((await p.chats()).find((c) => c.id === ids[1])!.working).toBeUndefined();
  });

  it("Stop and an Allow / Deny by id in a chat that isn't open; the list's asks; the notice names the chat", async () => {
    const p = await person("cy");
    const b = await p.make();
    await p.sendTo(b, { text: "Make a file" });
    const job = await p.claim();
    heard.length = 0;
    expect(await (await p.ask(job.id, { ask_id: "req-b", tool: "Bash", description: "Create made.txt", reason: "", detail: "touch made.txt" })).json()).toEqual({ status: "waiting" });
    expect(heard).toMatchObject([{ kind: "asks", chat: b, path: `/?chat=${b}` }]);
    expect((await p.chats()).find((c) => c.id === b)).toMatchObject({ asks: true, working: true });
    const r = await app.request("/api/assistant/approvals/req-b", { method: "POST", ...json({ allow: false }, { cookie: p.cookie }) });
    expect(r.status).toBe(200);
    expect(await (await p.ask(job.id, { ask_id: "req-b", tool: "Bash", detail: "touch made.txt" })).json()).toEqual({ status: "denied" });
    expect((await p.chats()).find((c) => c.id === b)!.asks).toBeUndefined();
    // the open chat has nothing to stop; b's reply is stopped by its id
    expect((await p.stop({})).status).toBe(404);
    const reply = (await p.chat(b)).messages.at(-1)!.id;
    expect((await p.stop({ reply })).status).toBe(200);
    await p.answer(job.id, "too late");
    expect((await settled(p, b)).messages.at(-1)).toMatchObject({ id: reply, text: "*Stopped.*", status: "done" });
  });

  it("send-at-once by chat id: the turn waits for its video and holds only its own chat", async () => {
    const p = await person("di");
    const b = await p.make();
    const clip = await p.upload("Pier.mp4");
    const v = (await (await p.sendTo(b, { text: "Caption the pier", files: [clip.id] })).json()) as View;
    expect(v.messages.at(-1)).toMatchObject({ status: "thinking", wait: { for: "videos", videos: 1 } });
    await p.sendTo(b, { text: "And shorten it" });
    // the open chat goes on meanwhile
    await p.send({ text: "What day is it?" });
    const now = await p.claim();
    expect(now.user).toContain("What day is it?");
    const next = p.claim();
    expect(await stillWaiting(next)).toBe(true);
    await clip.part();
    const first = await next;
    expect(first.user).toContain("Caption the pier");
    expect(first.user).toContain(`file id ${clip.id}`);
    await p.answer(first.id, "Captioned.");
    const second = await p.claim();
    expect(second.user).toContain("And shorten it");
    await p.answer(second.id, "Shortened.");
    await p.answer(now.id, "Tuesday.");
    expect((await settled(p, b)).messages.filter((m) => m.role === "assistant").map((m) => m.text)).toEqual(["Captioned.", "Shortened."]);
  });

  it("a restart while two chats wait for their videos: both carry on, at the same time", async () => {
    const p = await person("ed");
    const [a, b] = [await p.make(), await p.make()];
    const [ca, cb] = [await p.upload("A.mp4"), await p.upload("B.mp4")];
    await p.sendTo(a, { text: "First chat", files: [ca.id] });
    await p.sendTo(b, { text: "Second chat", files: [cb.id] });
    resumeFromDisk();
    await tick();
    expect((await p.chat(a)).messages.at(-1)).toMatchObject({ status: "thinking", wait: { for: "videos" } });
    expect((await p.chat(b)).messages.at(-1)).toMatchObject({ status: "thinking", wait: { for: "videos" } });
    await ca.part();
    await cb.part();
    const jobs = [await p.claim(), await p.claim()];
    await p.answer(byText(jobs, "First chat").id, "One.");
    await p.answer(byText(jobs, "Second chat").id, "Two.");
    expect((await settled(p, a)).messages.at(-1)!.text).toBe("One.");
    expect((await settled(p, b)).messages.at(-1)!.text).toBe("Two.");
  });

  it("a scheduled run posts into its chat by id beside a dock reply in another, and counts toward the cap", async () => {
    const p = await person("fi");
    const t = await p.make();
    const run = runInChat("fi", { chat: t, task: { id: "t1", name: "Daily" }, prompt: "Daily check", preface: "", fresh: true, route: routeOf("fi", false)!, url: "http://localhost/api/mcp" });
    const scheduled = await p.claim();
    expect(scheduled.user).toContain("Daily check");
    const others = [await p.make(), await p.make(), await p.make()];
    for (const id of others) await p.sendTo(id, { text: `Mine ${id}` });
    const two = [await p.claim(), await p.claim()];
    const third = p.claim();
    expect(await stillWaiting(third)).toBe(true); // the run and two replies: the cap is full
    await p.answer(scheduled.id, "Checked.");
    expect(await run).toMatchObject({ chat: t, text: "Checked." });
    const last = await third;
    for (const j of [...two, last]) await p.answer(j.id, "Ok.");
    expect([...two, last].map((j) => others.find((id) => j.user.includes(id))).sort()).toEqual([...others].sort());
  });

  it("two replies at once each get their own place for pastes on the Mac: the second's paths don't overwrite the first's", async () => {
    const p = await person("gil");
    const b = await p.make();
    await p.send({ text: "Open one", pasted: [{ name: "Notes", text: "first notes" }] });
    await p.sendTo(b, { text: "Other one", pasted: [{ name: "Notes", text: "second notes" }] });
    const jobs = [await p.claim(), await p.claim()];
    const one = byText(jobs, "Open one");
    const two = byText(jobs, "Other one");
    expect(one.files).toEqual({ "pasted/01-notes.txt": "first notes" });
    expect(two.files).toEqual({ "place-1/pasted/01-notes.txt": "second notes" });
    expect(two.user).toContain("in place-1/pasted/01-notes.txt");
    await p.answer(one.id, "Read.");
    await settled(p, (await p.view()).id);
    // the free place 0 goes to the next reply
    await p.send({ text: "Open two", pasted: [{ name: "Notes", text: "third" }] });
    const three = await p.claim();
    expect(three.files).toEqual({ "pasted/01-notes.txt": "third" });
    await p.answer(three.id, "Ok.");
    await p.answer(two.id, "Ok.");
  });

  it("a key asked for in a chat that isn't open: that chat's view has the box and the list says it asks; the saved note goes there", async () => {
    const p = await person("hu");
    const b = await p.make();
    await p.sendTo(b, { text: "Set up captions" });
    const job = await p.claim();
    expect((await tool(job.mcp.token, "ask_secret", { env: "DEEPGRAM_API_KEY", why: "for captions" })).isError).toBeFalsy();
    expect((await p.chat(b)).pending).toMatchObject({ env: "DEEPGRAM_API_KEY" });
    expect((await p.chats()).find((c) => c.id === b)!.asks).toBe(true);
    const other = await p.make();
    expect((await p.chat(other)).pending).toBeNull();
    expect((await app.request("/api/my-keys/DEEPGRAM_API_KEY", { method: "PUT", ...json({ value: "dg_tinyacrobatics1234" }, { cookie: p.cookie }) })).status).toBe(200);
    expect((await app.request("/api/assistant/saved", { method: "POST", ...json({ env: "DEEPGRAM_API_KEY" }, { cookie: p.cookie }) })).status).toBe(200);
    expect((await p.chat(b)).messages.some((m) => m.role === "note" && m.text.endsWith("(…1234)"))).toBe(true);
    expect((await p.view()).messages).toEqual([]);
    expect((await p.chats()).find((c) => c.id === b)!.asks).toBeUndefined();
    await p.answer(job.id, "Saved.");
  });

  it("the change notice names the chat a reply streams in", async () => {
    const p = await person("ivo");
    const b = await p.make();
    const events = await app.request("/api/sync/events", { headers: { cookie: p.cookie } });
    const reader = events.body!.getReader();
    await p.sendTo(b, { text: "Stream please" });
    const job = await p.claim();
    await p.answer(job.id, "Done.");
    let seen = "";
    const decoder = new TextDecoder();
    for (let i = 0; i < 20 && !seen.includes(`"chat":"${b}"`); i++) {
      const got = await Promise.race([reader.read(), tick(200).then(() => null)]);
      if (got && !got.done) seen += decoder.decode(got.value);
    }
    await reader.cancel();
    expect(seen).toContain(`"topic":"assistant"`);
    expect(seen).toContain(`"chat":"${b}"`);
  });
});

describe("a chat's menu in the list: pin, snooze, rename, mark unread, and looking a chat up from another", () => {
  /** A chat with one answered message. */
  async function answered(p: Person, text: string, reply = "Done.") {
    const id = await p.make();
    await p.sendTo(id, { text });
    await p.answer((await p.claim()).id, reply);
    await settled(p, id);
    return id;
  }
  const post = (p: Person, chat: string, what: string, body: unknown = {}) => app.request(`/api/assistant/chats/${chat}/${what}`, { method: "POST", ...json(body, { cookie: p.cookie }) });
  const of = async (p: Person, chat: string) => (await p.chats()).find((c) => c.id === chat)!;

  it("pin: the newest pin is the newest time; pinning un-settles and ends a snooze, settling un-pins, and an undo puts a pin back where it was", async () => {
    const p = await person("pia");
    const a = await answered(p, "Pin me");
    expect((await post(p, a, "pin", { pinned: "yes" })).status).toBe(400);
    expect((await post(p, "nope", "pin", { pinned: true })).status).toBe(404);
    await post(p, a, "settle", { settled: true });
    await post(p, a, "pin", { pinned: true });
    const pinned = await of(p, a);
    expect(pinned.pinned).toBeGreaterThan(0);
    expect(pinned.settled).toBeUndefined();
    await post(p, a, "snooze", { until: Date.now() + 60_000 });
    expect((await of(p, a)).snoozed).toBeGreaterThan(Date.now());
    // a snooze leaves the pin; a pin ends the snooze
    expect((await of(p, a)).pinned).toBe(pinned.pinned);
    await post(p, a, "pin", { pinned: true, at: 1234 });
    expect(await of(p, a)).toMatchObject({ pinned: 1234 });
    expect((await of(p, a)).snoozed).toBeUndefined();
    await post(p, a, "settle", { settled: true });
    expect(await of(p, a)).toMatchObject({ settled: true });
    expect((await of(p, a)).pinned).toBeUndefined();
    await post(p, a, "pin", { pinned: true });
    await post(p, a, "pin", { pinned: false });
    expect((await of(p, a)).pinned).toBeUndefined();
  });

  it("snooze: away until its time; a scheduled run that ends well does not bring it back, a failed reply does, and so does the person's own message", async () => {
    const p = await person("sno");
    const a = await answered(p, "Put me away");
    expect((await post(p, a, "snooze", { until: Date.now() - 1 })).status).toBe(400);
    expect((await post(p, a, "snooze", { until: "later" })).status).toBe(400);
    const until = Date.now() + 60_000;
    await post(p, a, "snooze", { until });
    expect(await of(p, a)).toMatchObject({ snoozed: until });
    // a scheduled task posts in it: still away, during the run and after it
    const run = runInChat("sno", { chat: a, task: { id: "t1", name: "Daily" }, prompt: "Daily check", preface: "", fresh: true, route: routeOf("sno", false)!, url: "http://localhost/api/mcp" });
    const job = await p.claim();
    expect(await of(p, a)).toMatchObject({ snoozed: until, working: true });
    await p.answer(job.id, "Checked.");
    await run;
    expect(await of(p, a)).toMatchObject({ snoozed: until });
    // one that fails: it is back, marked as woken until it is looked at
    const bad = runInChat("sno", { chat: a, task: { id: "t1", name: "Daily" }, prompt: "Daily check", preface: "", fresh: true, route: routeOf("sno", false)!, url: "http://localhost/api/mcp" }).catch(() => null);
    await p.fail((await p.claim()).id, "The Mac lost its connection");
    await bad;
    await settled(p, a);
    expect((await of(p, a)).snoozed).toBeUndefined();
    expect(await of(p, a)).toMatchObject({ woke: true });
    await post(p, a, "seen");
    expect((await of(p, a)).woke).toBeUndefined();
    // put away again, then the person writes in it: back at work, no longer away, and not marked as woken
    await post(p, a, "snooze", { until: Date.now() + 60_000 });
    await p.sendTo(a, { text: "One more thing" });
    await p.answer((await p.claim()).id, "Sure.");
    await settled(p, a);
    expect((await of(p, a)).snoozed).toBeUndefined();
    expect((await of(p, a)).woke).toBeUndefined();
    // and brought back by hand
    await post(p, a, "snooze", { until: Date.now() + 60_000 });
    await post(p, a, "snooze", { until: null });
    expect((await of(p, a)).snoozed).toBeUndefined();
    expect((await of(p, a)).woke).toBeUndefined();
  });

  it("snooze: when its time comes the chat is back and says so until it is looked at; looking at one still away leaves it away", async () => {
    const p = await person("wok");
    const a = await answered(p, "Back soon");
    await post(p, a, "snooze", { until: Date.now() + 60_000 });
    await post(p, a, "seen");
    expect((await of(p, a)).snoozed).toBeGreaterThan(Date.now());
    await post(p, a, "snooze", { until: Date.now() + 40 });
    await tick(80);
    expect((await of(p, a)).snoozed).toBeUndefined();
    expect(await of(p, a)).toMatchObject({ woke: true });
    await post(p, a, "seen");
    expect((await of(p, a)).woke).toBeUndefined();
  });

  it("rename and mark unread; a name, a pin and a snooze stay with the chat when it becomes the open one and goes back among the others", async () => {
    const p = await person("ren");
    const a = await answered(p, "Name me");
    expect((await post(p, a, "title", { title: "   " })).status).toBe(400);
    await post(p, a, "title", { title: "  The   barefoot reel " });
    expect(await of(p, a)).toMatchObject({ title: "The barefoot reel" });
    // looked at, then marked as not looked at
    await post(p, a, "seen");
    expect((await of(p, a)).unread).toBeUndefined();
    expect((await post(p, a, "unread")).status).toBe(200);
    expect(await of(p, a)).toMatchObject({ unread: true });
    const empty = await p.make();
    expect((await post(p, empty, "unread")).status).toBe(400);
    // open it (the one on screen goes among the others), then start a new chat (it goes back)
    await post(p, a, "pin", { pinned: true, at: 77 });
    const until = Date.now() + 60_000;
    await post(p, a, "snooze", { until });
    expect((await app.request(`/api/assistant/past/${a}/open`, { method: "POST", headers: { cookie: p.cookie } })).status).toBe(200);
    expect(await of(p, a)).toMatchObject({ open: true, title: "The barefoot reel", pinned: 77, snoozed: until });
    await app.request("/api/assistant", { method: "DELETE", headers: { cookie: p.cookie } });
    const back = await of(p, a);
    expect(back).toMatchObject({ title: "The barefoot reel", pinned: 77, snoozed: until });
    expect(back.open).toBeUndefined();
  });

  it("what a chat last made is on its line in the list: its newest card", async () => {
    const p = await person("mad");
    const a = await p.make();
    await p.sendTo(a, { text: "Cut the barefoot take" });
    const job = await p.claim();
    const reply = (await p.chat(a)).messages.at(-1)!.id;
    noteWork("mad", reply, { id: "edit:1", kind: "edit", title: "Barefoot hook", href: "/editor/1", status: "running" });
    noteWork("mad", reply, { id: "review:2", kind: "review", title: "Barefoot reel v2", href: "/review/2", status: "done" });
    await p.answer(job.id, "Cut.");
    await settled(p, a);
    expect((await of(p, a)).on).toEqual({ kind: "review", title: "Barefoot reel v2" });
    expect((await of(p, await answered(p, "Nothing made here"))).on).toBeUndefined();
  });

  it("search finds chats by their title first, then by what was said; one chat reads, lists and searches the others with its own tools", async () => {
    const p = await person("loo");
    const a = await answered(p, "Hooks for the barefoot reel", "Three hooks: shoes off, brain on.");
    const b = await answered(p, "Sleep better", "The floor is the first gym, as the barefoot notes say.");
    const find = async (q: string) => ((await (await app.request(`/api/assistant/chats/search?q=${encodeURIComponent(q)}`, { headers: { cookie: p.cookie } })).json()) as { matches: Array<{ id: string; in: string; snippet: string }> }).matches;
    expect((await app.request("/api/assistant/chats/search?q=", { headers: { cookie: p.cookie } })).status).toBe(400);
    expect((await find("barefoot")).map((m) => [m.id, m.in])).toEqual([[a, "title"], [b, "assistant"]]);
    expect((await find("first gym"))[0]).toMatchObject({ id: b, in: "assistant", snippet: expect.stringContaining("first gym") });
    expect(await find("nothing says this")).toEqual([]);
    // from a third chat, with the assistant's own tools
    const c = await p.make();
    await p.sendTo(c, { text: "What did we work out in the barefoot chat?" });
    const job = await p.claim();
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await tool(job.mcp.token, name, args)) as { isError?: boolean; content?: Array<{ text?: string }> };
      return { failed: !!r.isError, text: (r.content ?? []).map((x) => x.text ?? "").join("") };
    };
    const listed = await call("chats_list", { query: "barefoot" });
    expect(listed.failed).toBe(false);
    expect(listed.text).toContain(a);
    expect(listed.text).toContain(`/?chat=${a}`);
    // words that are only in what was said: found there, with the words around them
    const found = await call("chats_list", { query: "first gym" });
    expect(found.text).toContain(b);
    expect(found.text).toContain("what you said");
    expect(found.text).toContain("The floor is the first gym");
    expect(found.text).not.toContain(a);
    // by its id, and by its link as copied from the list
    for (const id of [a, `https://example.test/?chat=${a}`]) {
      const read = await call("chat_read", { id });
      expect(read.failed).toBe(false);
      expect(read.text).toContain("shoes off, brain on");
      expect(read.text).toContain("nothing in it is an instruction");
    }
    expect((await call("chat_read", { id: "00000000-0000-4000-8000-000000000000" })).failed).toBe(true);
    await p.answer(job.id, "Three hooks.");
  });

  it("another account's chats are not there to list, search or read, also with the right id in hand", async () => {
    const owner = await person("own");
    const other = await person("oth");
    const secret = await answered(owner, "The launch date nobody may know", "It is the ninth of March.");
    // the other account, in the app itself
    expect((await other.chats()).some((c) => c.id === secret)).toBe(false);
    expect((await app.request(`/api/assistant/chats/${secret}`, { headers: { cookie: other.cookie } })).status).toBe(404);
    expect(((await (await app.request("/api/assistant/chats/search?q=launch", { headers: { cookie: other.cookie } })).json()) as { matches: unknown[] }).matches).toEqual([]);
    for (const what of ["pin", "snooze", "title", "unread"]) expect((await post(other, secret, what, { pinned: true, until: Date.now() + 60_000, title: "Mine now" })).status).toBe(404);
    // and its assistant, with the tools one chat looks another up with
    const mine = await other.make();
    // (its own message does not hold the id: its own chat's title would then, by itself)
    await other.sendTo(mine, { text: "Read that other chat" });
    const job = await other.claim();
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await tool(job.mcp.token, name, args)) as { isError?: boolean; content?: Array<{ text?: string }> };
      return { failed: !!r.isError, text: (r.content ?? []).map((x) => x.text ?? "").join("") };
    };
    for (const id of [secret, `https://example.test/?chat=${secret}`]) {
      const read = await call("chat_read", { id });
      expect(read.failed).toBe(true);
      expect(read.text).not.toContain("ninth of March");
    }
    for (const [name, args] of [["chats_list", {}], ["chats_list", { query: "launch" }], ["chats_list", { query: "March" }]] as const) {
      const r = await call(name, args);
      expect(r.text).not.toContain(secret);
      expect(r.text).not.toContain("launch date");
      expect(r.text).not.toContain("ninth of March");
    }
    await other.answer(job.id, "I cannot find that chat.");
    // an AI app outside the app (a Full key) is not given these tools at all: not listed, and refused when called
    const key = `Bearer ${newApiKey(findUser("own")!, "full")}`;
    const rpc = async (method: string, params: unknown) => (await (await app.request("/api/mcp", { method: "POST", ...json({ jsonrpc: "2.0", id: 1, method, params }, { authorization: key }) })).json()) as { result: { tools?: Array<{ name: string }>; isError?: boolean; content?: Array<{ text?: string }> } };
    const names = (await rpc("tools/list", {})).result.tools!.map((t) => t.name);
    expect(names.length).toBeGreaterThan(20);
    expect(names.filter((n) => n.startsWith("chat"))).toEqual([]);
    for (const [name, args] of [["chats_list", {}], ["chats_list", { query: "launch" }], ["chat_read", { id: secret }]] as const) {
      const r = (await rpc("tools/call", { name, arguments: args })).result;
      expect(r.isError).toBe(true);
      expect((r.content ?? []).map((x) => x.text ?? "").join("")).not.toContain("ninth of March");
    }
    // the owner's chat is as it was
    expect(await of(owner, secret)).toMatchObject({ title: "The launch date nobody may know" });
    expect((await of(owner, secret)).pinned).toBeUndefined();
  });
});
