import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// A message sent while its videos still upload, and messages sent while a reply is being written: they wait on the server.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "assistant-send-now-"));
process.env.APP_SECRET = "assistant-test-secret";

const { createUser, newApiKey } = await import("./users");
const { readWorkPrefs } = await import("./work-prefs");
const app = (await import("./boot")).default;
const { pairDevice } = await import("./lib/devices");
const { saveSettings } = await import("./lib/providers");
const { DEFAULT_SETTINGS } = await import("../contracts/providers");
const { resumeFromDisk, routeOf, runInChat, WAIT_MS } = await import("./assistant");
const { onAttention } = await import("./lib/attention");
type View = import("../contracts/assistant").AssistantView;
type Attention = import("./lib/attention").Attention;

const json = (body: unknown, extra: Record<string, string> = {}) => ({ headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** An account with its own Mac running Claude Code: its cookie, and the Mac's side of the relay (the fake AI). */
async function person(name: string) {
  const user = createUser(name, "password1");
  const mac = pairDevice(name, `${name}'s Mac`);
  await saveSettings({ ...structuredClone(DEFAULT_SETTINGS), instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: mac.device.id }] }, name);
  const login = await app.request("/api/auth/login", { method: "POST", ...json({ username: name, password: "password1" }) });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const device = { authorization: `Bearer ${mac.token}` };
  type Job = { id: string; user: string; files?: Record<string, string>; mcp: { token: string } };
  return {
    cookie,
    user,
    /** The Mac's next job (long-polls: a promise that settles when there is one). */
    claim: async () => (await (await app.request("/api/devices/relay/wait", { method: "POST", ...json({}, device) })).json()) as Job,
    ask: (id: string, body: Record<string, unknown>) => app.request(`/api/devices/relay/${id}/ask`, { method: "POST", ...json(body, device) }),
    answer: (id: string, text: string) => app.request(`/api/devices/relay/${id}/done`, { method: "POST", ...json({ text }, device) }),
    view: async () => (await (await app.request("/api/assistant", { headers: { cookie } })).json()) as View,
    send: (body: Record<string, unknown>) => app.request("/api/assistant/turn", { method: "POST", ...json(body, { cookie }) }),
    newChat: async () => (await (await app.request("/api/assistant", { method: "DELETE", headers: { cookie } })).json()) as View,
    open: (id: string) => app.request(`/api/assistant/past/${id}/open`, { method: "POST", headers: { cookie } }),
    stop: (body?: Record<string, unknown>) => app.request("/api/assistant/stop", { method: "POST", ...(body ? json(body, { cookie }) : { headers: { cookie } }) }),
    /** Starts an upload (one part of `size` bytes); returns its id and the calls that finish it. */
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
        complete: () => app.request(`/api/assistant/files/${id}/complete`, { method: "POST", headers: { cookie } }),
      };
    },
  };
}

/** One MCP tool call, as the reply's job token or an access key would make it. */
async function tool(token: string, name: string, args: Record<string, unknown>) {
  const r = await app.request("/api/mcp", { method: "POST", ...json({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { authorization: `Bearer ${token}` }) });
  const out = ((await r.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
  return { text: out.content[0]!.text, error: !!out.isError };
}

/** Whether a promise is still waiting after a moment (the Mac has no job yet). */
const stillWaiting = async (p: Promise<unknown>) => (await Promise.race([p.then(() => "settled"), tick(150).then(() => "waiting")])) === "waiting";
/** The view once its newest message is no longer being written. */
async function settled(p: Awaited<ReturnType<typeof person>>) {
  let v = await p.view();
  for (let i = 0; i < 50 && v.messages.at(-1)?.status === "thinking"; i++) v = (await tick(), await p.view());
  return v;
}

/** The view once that earlier chat no longer says it is working. */
async function quiet(p: Awaited<ReturnType<typeof person>>, chat: string) {
  let v = await p.view();
  for (let i = 0; i < 50 && v.past.find((c) => c.id === chat)?.working; i++) v = (await tick(), await p.view());
  return v;
}

const heard: Attention[] = [];
onAttention((a) => void heard.push(a));

afterEach(() => {
  vi.useRealTimers();
});

describe("a message sent while its video uploads", () => {
  it("is in the chat at once, waits for the last part, then runs with the video", async () => {
    const p = await person("tia");
    const clip = await p.upload("Beach.mov");
    const r = await p.send({ text: "Caption this", files: [clip.id] });
    expect(r.status).toBe(202);
    const v = (await r.json()) as View;
    expect(v.messages.at(-2)).toMatchObject({ role: "user", text: "Caption this", files: [{ id: clip.id, name: "Beach.mov", uploading: true }] });
    expect(v.messages.at(-1)).toMatchObject({ role: "assistant", status: "thinking", wait: { for: "videos", videos: 1, text: "Waiting for a video to upload" } });
    const job = p.claim();
    expect(await stillWaiting(job)).toBe(true);
    // the last part lands: the server joins the file itself (a locked phone never says /complete) and the turn runs
    expect((await clip.part()).status).toBe(200);
    const got = await job;
    expect(got.user).toContain(`"Beach.mov"`);
    expect(got.user).toContain(`file id ${clip.id}`);
    expect(got.user).toContain("Caption this");
    // /complete afterwards is answered the same, once
    expect(((await (await clip.complete()).json()) as { id: string }).id).toBe(clip.id);
    const during = await p.view();
    expect(during.messages.at(-2)!.files).toEqual([{ id: clip.id, name: "Beach.mov" }]);
    expect(during.messages.at(-1)!.wait).toBeUndefined();
    await p.answer(got.id, "Captioned.");
    expect((await settled(p)).messages.at(-1)).toMatchObject({ text: "Captioned.", status: "done" });
  });

  it("with two videos, runs once both are in, however close together they finish", async () => {
    const p = await person("ugo");
    const [a, b] = [await p.upload("A.mp4"), await p.upload("B.mp4")];
    expect((await p.send({ text: "Both", files: [a.id, b.id] })).status).toBe(202);
    const job = p.claim();
    await a.part();
    await a.complete();
    expect((await p.view()).messages.at(-1)!.wait).toMatchObject({ for: "videos", videos: 1 });
    expect(await stillWaiting(job)).toBe(true);
    await b.part();
    await Promise.all([b.complete(), b.complete()]);
    const got = await job;
    expect(got.user).toContain(`file id ${a.id}`);
    expect(got.user).toContain(`file id ${b.id}`);
    await p.answer(got.id, "Seen both.");
    expect((await settled(p)).messages.filter((m) => m.role === "assistant").map((m) => m.text)).toEqual(["Seen both."]);
  });

  it("a video whose last part landed before the message runs without /complete", async () => {
    const p = await person("ivy");
    const clip = await p.upload("Quick.mp4");
    await clip.part();
    const job = p.claim();
    expect((await p.send({ text: "Small one", files: [clip.id] })).status).toBe(202);
    const got = await job;
    expect(got.user).toContain(`file id ${clip.id}`);
    await p.answer(got.id, "Seen.");
  });

  it("a file finished before the message also goes (nothing waits)", async () => {
    const p = await person("val");
    const clip = await p.upload("Done.mp4");
    await clip.part();
    await clip.complete();
    expect(((await (await p.send({ text: "Go", files: [clip.id] })).json()) as View).messages.at(-1)!.wait).toBeUndefined();
    const got = await p.claim();
    await p.answer(got.id, "Ok.");
    // an id that was never this account's upload is refused, as before
    expect((await p.send({ text: "x", files: ["00000000-0000-4000-8000-000000000000"] })).status).toBe(400);
  });

  it("Stop ends the wait: the message stays, the reply says stopped, and the video arriving later runs nothing", async () => {
    const p = await person("wes");
    const clip = await p.upload("Late.mp4");
    await p.send({ text: "Never mind", files: [clip.id] });
    const r = await p.stop();
    expect(r.status).toBe(200);
    const v = (await r.json()) as View;
    expect(v.messages.at(-2)!.text).toBe("Never mind");
    expect(v.messages.at(-1)).toMatchObject({ text: "*Stopped.*", status: "done" });
    const job = p.claim();
    await clip.part();
    expect(await stillWaiting(job)).toBe(true);
    expect((await p.stop()).status).toBe(404);
    // the next message goes as usual (and takes the job the Mac is waiting for)
    await p.send({ text: "Hello" });
    const got = await job;
    expect(got.user).toContain("Hello");
    await p.answer(got.id, "Hi.");
  });

  it("survives a restart: the conversation file keeps the turn, and it runs once the video is in", async () => {
    const p = await person("xan");
    const clip = await p.upload("Restart.mp4");
    await p.send({ text: "After the restart", files: [clip.id], pasted: [{ name: "Notes", text: "Tiny Acrobatics plan" }] });
    const onDisk = JSON.parse(readFileSync(path.join(process.env.DATA_DIR!, "assistant", "xan.json"), "utf-8")) as { held: Record<string, { files: string[] }> };
    expect(Object.values(onDisk.held)[0]!.files).toEqual([clip.id]);
    // the server starts again: the conversation is read from its file
    resumeFromDisk();
    await tick();
    expect((await p.view()).messages.at(-1)).toMatchObject({ status: "thinking", wait: { for: "videos" } });
    const job = p.claim();
    await clip.part();
    const got = await job;
    expect(got.user).toContain("After the restart");
    expect(got.files).toEqual({ "pasted/01-notes.txt": "Tiny Acrobatics plan" });
    await p.answer(got.id, "Back.");
    expect((await settled(p)).messages.at(-1)).toMatchObject({ text: "Back.", status: "done" });
  });

  it("a video that stops arriving: the reply says so plainly, and the person hears it", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const p = await person("yul");
    const clip = await p.upload("Lost.mp4");
    await p.send({ text: "Here", files: [clip.id] });
    heard.length = 0;
    await vi.advanceTimersByTimeAsync(WAIT_MS + 2000);
    // the wake-up reads the upload from disk: wait for that with the clock still moved on
    let last = (await p.view()).messages.at(-1)!;
    for (let i = 0; i < 100 && last.status === "thinking"; i++) last = (await new Promise((r) => setImmediate(r)), await p.view()).messages.at(-1)!;
    vi.useRealTimers();
    expect(last).toMatchObject({ status: "error", text: `"Lost.mp4" didn't arrive, so this message wasn't answered: add it again and send the message again.` });
    expect(heard).toMatchObject([{ username: "yul", kind: "failed", reply: last.id, title: "Here" }]);
  });
});

describe("messages sent while a reply is being written", () => {
  it("queue in order: each runs after the one before, with the chat up to its own message", async () => {
    const p = await person("zed");
    expect((await p.send({ text: "First" })).status).toBe(202);
    const first = await p.claim();
    expect((await p.send({ text: "Second" })).status).toBe(202);
    const v = (await (await p.send({ text: "Third" })).json()) as View;
    expect(v.messages.slice(-4).map((m) => [m.text, m.wait?.for])).toEqual([["Second", undefined], ["", "reply"], ["Third", undefined], ["", "reply"]]);
    const next = p.claim();
    expect(await stillWaiting(next)).toBe(true);
    await p.answer(first.id, "Answer one");
    const second = await next;
    expect(second.user).toContain("Answer one");
    expect(second.user).toContain("Second");
    expect(second.user).not.toContain("Third");
    await p.answer(second.id, "Answer two");
    const third = await p.claim();
    expect(third.user).toContain("Answer two");
    await p.answer(third.id, "Answer three");
    expect((await settled(p)).messages.filter((m) => m.role === "assistant").map((m) => m.text)).toEqual(["Answer one", "Answer two", "Answer three"]);
  });

  it("Stop stops the one being written; the queued one runs next. { reply } stops a queued one", async () => {
    const p = await person("ada");
    await p.send({ text: "Long" });
    const running = await p.claim();
    await p.send({ text: "Keep" });
    const v = (await (await p.send({ text: "Drop" })).json()) as View;
    const drop = v.messages.at(-1)!.id;
    expect((await p.stop({ reply: drop })).status).toBe(200);
    expect((await p.view()).messages.at(-1)).toMatchObject({ id: drop, text: "*Stopped.*", status: "done" });
    const next = p.claim();
    expect((await p.stop()).status).toBe(200);
    const keep = await next;
    expect(keep.user).toContain("Keep");
    await p.answer(keep.id, "Kept.");
    await p.answer(running.id, "too late");
  });

  it("a message sent during a scheduled run in the open chat waits for it", async () => {
    const p = await person("bea");
    const conv = await p.view();
    const run = runInChat("bea", { chat: conv.id, task: { id: "t1", name: "Daily" }, prompt: "Daily check", preface: "", fresh: true, route: routeOf("bea", false)!, url: "http://localhost/api/mcp" });
    const scheduled = await p.claim();
    await p.send({ text: "Mine" });
    const next = p.claim();
    expect(await stillWaiting(next)).toBe(true);
    await p.answer(scheduled.id, "Checked.");
    await run;
    const mine = await next;
    expect(mine.user).toContain("Mine");
    await p.answer(mine.id, "Yours.");
  });
});

describe("the attention hook", () => {
  it("is called when a reply ends and when it asks, not for a Stop", async () => {
    const p = await person("cal");
    heard.length = 0;
    await p.send({ text: "Do the thing" });
    const job = await p.claim();
    await p.answer(job.id, "Did   the\nthing.");
    const v = await settled(p);
    expect(heard).toEqual([{ username: "cal", reply: v.messages.at(-1)!.id, kind: "done", title: "Do the thing", body: "Did the thing.", path: `/?chat=${v.id}`, sentAt: v.messages.at(-2)!.at }]);
    // an Allow / Deny on the Mac
    heard.length = 0;
    await p.send({ text: "Make a file" });
    const asking = await p.claim();
    await p.ask(asking.id, { ask_id: "req-1", tool: "Bash", description: "Create made.txt", reason: "", detail: "touch made.txt" });
    expect(heard).toMatchObject([{ kind: "asks", body: "Asks to run a command: Create made.txt", title: "Do the thing" }]);
    await p.answer(asking.id, "Made.");
    await settled(p);
    heard.length = 0;
    await p.send({ text: "Stop me" });
    await p.claim();
    await p.stop();
    await tick();
    expect(heard).toEqual([]);
  });
});

describe("New chat and an earlier chat while a reply runs or waits", () => {
  it("New chat while a reply is written: the new chat is empty, the reply ends in the earlier one, which says it is working till then", async () => {
    const p = await person("dan");
    await p.send({ text: "Old question" });
    const job = await p.claim();
    const old = (await p.view()).id;
    const v = await p.newChat();
    expect(v.messages).toEqual([]);
    expect(v.id).not.toBe(old);
    expect(v.past[0]).toMatchObject({ id: old, working: true });
    await p.answer(job.id, "Old answer");
    const after = await quiet(p, old);
    expect(after.messages).toEqual([]);
    expect(after.past[0]!.working).toBeUndefined();
    // opening it again shows the finished answer
    const r = await p.open(old);
    expect(r.status).toBe(200);
    expect(((await r.json()) as View).messages.map((m) => [m.text, m.status])).toEqual([["Old question", undefined], ["Old answer", "done"]]);
  });

  it("New chat while a reply waits for its video: the video landing starts it, and it answers in its own chat", async () => {
    const p = await person("eli");
    const clip = await p.upload("Pier.mp4");
    await p.send({ text: "Caption the pier", files: [clip.id] });
    const old = (await p.view()).id;
    expect((await p.newChat()).past[0]).toMatchObject({ id: old, working: true });
    const job = p.claim();
    await clip.part();
    const got = await job;
    expect(got.user).toContain("Caption the pier");
    expect(got.user).toContain(`file id ${clip.id}`);
    await p.answer(got.id, "Pier captioned.");
    expect((await quiet(p, old)).messages).toEqual([]);
    const opened = (await (await p.open(old)).json()) as View;
    expect(opened.messages.at(-2)!.files).toEqual([{ id: clip.id, name: "Pier.mp4" }]);
    expect(opened.messages.at(-1)).toMatchObject({ text: "Pier captioned.", status: "done" });
  });

  it("a reply waiting for its videos holds only its own chat: a message in the new chat is answered meanwhile, and one after it in the old chat still waits", async () => {
    const p = await person("kit");
    const clip = await p.upload("Dock.mp4");
    await p.send({ text: "Edit the dock clip", files: [clip.id] });
    await p.send({ text: "And make it short" });   // same chat, behind the video's reply
    const old = (await p.view()).id;
    await p.newChat();
    const v = (await (await p.send({ text: "What day is it?" })).json()) as View;
    expect(v.messages.at(-1)!.wait).toBeUndefined();   // not held behind the old chat's videos
    const now = await p.claim();
    expect(now.user).toContain("What day is it?");
    expect(now.user).not.toContain("dock");
    await p.answer(now.id, "Tuesday.");
    const next = p.claim();
    expect(await stillWaiting(next)).toBe(true);   // "And make it short" still waits for the video's reply
    await clip.part();
    const first = await next;
    expect(first.user).toContain("Edit the dock clip");
    await p.answer(first.id, "Dock edited.");
    const second = await p.claim();
    expect(second.user).toContain("And make it short");
    expect(second.user).toContain("Dock edited.");
    await p.answer(second.id, "Shortened.");
    const opened = (await (await p.open(old)).json()) as View;
    expect(opened.messages.at(-1)).toMatchObject({ text: "Shortened.", status: "done" });
  });

  it("a queued reply's prompt is its own chat up to its message, whatever chat is open when its turn comes; one at a time across chats", async () => {
    const p = await person("fay");
    await p.send({ text: "Alpha one" });
    const first = await p.claim();
    await p.send({ text: "Alpha two" });
    const alpha = (await p.view()).id;
    await p.newChat();
    const v = (await (await p.send({ text: "Beta one" })).json()) as View;
    expect(v.messages.map((m) => [m.text, m.wait?.for])).toEqual([["Beta one", undefined], ["", "reply"]]);
    const next = p.claim();
    expect(await stillWaiting(next)).toBe(true);
    await p.answer(first.id, "Answer alpha one");
    const second = await next;
    expect(second.user).toContain("Answer alpha one");
    expect(second.user).toContain("Alpha two");
    expect(second.user).not.toContain("Beta");
    const after = p.claim();
    expect(await stillWaiting(after)).toBe(true);
    await p.answer(second.id, "Answer alpha two");
    const third = await after;
    expect(third.user).toContain("Beta one");
    expect(third.user).not.toContain("Alpha");
    await p.answer(third.id, "Answer beta");
    expect((await settled(p)).messages.map((m) => m.text)).toEqual(["Beta one", "Answer beta"]);
    const opened = (await (await p.open(alpha)).json()) as View;
    expect(opened.messages.filter((m) => m.role === "assistant").map((m) => m.text)).toEqual(["Answer alpha one", "Answer alpha two"]);
  });

  it("Stop reaches a reply in an earlier chat by its id, and a queued one's Stop leaves the running one alone", async () => {
    const p = await person("gus");
    await p.send({ text: "Keep going" });
    const job = await p.claim();
    const queued = ((await (await p.send({ text: "Then this" })).json()) as View).messages.at(-1)!.id;
    const running = (await p.view()).messages.at(-3)!.id;
    const old = (await p.view()).id;
    await p.newChat();
    // the new chat has nothing of its own to stop
    expect((await p.stop()).status).toBe(404);
    expect((await p.stop({ reply: queued })).status).toBe(200);
    expect((await p.view()).past[0]).toMatchObject({ id: old, working: true });
    expect((await p.stop({ reply: running })).status).toBe(200);
    await p.answer(job.id, "too late");
    await quiet(p, old);
    const opened = (await (await p.open(old)).json()) as View;
    expect(opened.messages.filter((m) => m.role === "assistant").map((m) => [m.text, m.status])).toEqual([["*Stopped.*", "done"], ["*Stopped.*", "done"]]);
  });

  it("deleting an earlier chat whose reply runs stops it, drops the one queued there, and the new chat's message goes next", async () => {
    const p = await person("ida");
    await p.send({ text: "Alpha one" });
    const first = await p.claim();
    await p.send({ text: "Alpha two" });
    const alpha = (await p.view()).id;
    await p.newChat();
    await p.send({ text: "Beta one" });
    const next = p.claim();
    const r = await app.request(`/api/assistant/past/${alpha}`, { method: "DELETE", headers: { cookie: p.cookie } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as View).past.map((c) => c.id)).not.toContain(alpha);
    const beta = await next;
    expect(beta.user).toContain("Beta one");
    expect(beta.user).not.toContain("Alpha");
    await p.answer(first.id, "late");
    await p.answer(beta.id, "Answer beta");
    const v = await settled(p);
    expect(v.messages.map((m) => m.text)).toEqual(["Beta one", "Answer beta"]);
    expect(v.past).toEqual([]);
  });

  it("an earlier chat opens while a reply is written in the open one, which then keeps working among the earlier chats", async () => {
    const p = await person("hal");
    await p.send({ text: "Done one" });
    await p.answer((await p.claim()).id, "Fine.");
    const done = (await settled(p)).id;
    await p.newChat();
    await p.send({ text: "Slow one" });
    const job = await p.claim();
    const slow = (await p.view()).id;
    const r = await p.open(done);
    expect(r.status).toBe(200);
    const v = (await r.json()) as View;
    expect(v.id).toBe(done);
    expect(v.past.find((c) => c.id === slow)).toMatchObject({ working: true });
    await p.answer(job.id, "Slow answer.");
    expect((await quiet(p, slow)).messages.map((m) => m.text)).toEqual(["Done one", "Fine."]);
  });
});

// What the iPhone app reads from the server: these stay as they are for a file sent without a path.
describe("the phone's contract", () => {
  it("sendNow, queued messages behind a reply waiting for its video, the join and the routes after it", async () => {
    const p = await person("ola");
    expect((await p.view()).sendNow).toBe(true);
    const clip = await p.upload("Phone.mov");
    expect((await p.send({ text: "One", files: [clip.id] })).status).toBe(202);
    // a 2nd and a 3rd while the first waits for its video: taken, in order, each waiting its turn
    expect((await p.send({ text: "Two" })).status).toBe(202);
    const v = (await (await p.send({ text: "Three" })).json()) as View;
    expect(v.messages.map((m) => [m.text, m.wait?.for])).toEqual([["One", undefined], ["", "videos"], ["Two", undefined], ["", "reply"], ["Three", undefined], ["", "reply"]]);
    const job = p.claim();
    expect((await clip.part()).status).toBe(200);
    const one = await job;
    expect(one.user).toContain("One");
    // the join is done: no upload in progress any more, /complete still answers with the file
    expect((await app.request(`/api/assistant/files/${clip.id}/parts`, { headers: { cookie: p.cookie } })).status).toBe(404);
    const again = await clip.part();
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe("No upload in progress");
    const done = await clip.complete();
    expect(done.status).toBe(200);
    expect(((await done.json()) as { id: string }).id).toBe(clip.id);
    // a thinking reply with no wait is the one being written
    const now = await p.view();
    expect(now.messages[1]).toMatchObject({ status: "thinking" });
    expect(now.messages[1]!.wait).toBeUndefined();
    await p.answer(one.id, "Did one.");
    const two = await p.claim();
    expect(two.user).toContain("Two");
    await p.answer(two.id, "Did two.");
    const three = await p.claim();
    expect(three.user).toContain("Three");
    await p.answer(three.id, "Did three.");
    expect((await settled(p)).messages.filter((m) => m.role === "assistant").map((m) => m.text)).toEqual(["Did one.", "Did two.", "Did three."]);
  });
});

describe("a file dropped in the Mac app, with its path", () => {
  it("doesn't hold the reply: it starts at once, told the file is still arriving and where it is; the chip says uploading until it is in", async () => {
    const p = await person("pia");
    const clip = await p.upload("walkthru-1.mp4");
    const r = await p.send({ text: "Edit these", files: [{ id: clip.id, path: "/Users/tiny/Movies/walkthru-1.mp4" }] });
    expect(r.status).toBe(202);
    const v = (await r.json()) as View;
    expect(v.messages.at(-2)!.files).toEqual([{ id: clip.id, name: "walkthru-1.mp4", uploading: true, path: "/Users/tiny/Movies/walkthru-1.mp4" }]);
    expect(v.messages.at(-1)!.wait).toBeUndefined();
    const job = await p.claim();
    expect(job.user).toContain(`"walkthru-1.mp4", file id ${clip.id}: it is still uploading to this server`);
    expect(job.user).toContain(`On their computer it is at "/Users/tiny/Movies/walkthru-1.mp4"`);
    // the upload goes on behind the reply: its last part clears the chip
    await clip.part();
    let files = (await p.view()).messages.at(-2)!.files;
    for (let i = 0; i < 50 && files?.[0]?.uploading; i++) files = (await tick(), await p.view()).messages.at(-2)!.files;
    expect(files).toEqual([{ id: clip.id, name: "walkthru-1.mp4", path: "/Users/tiny/Movies/walkthru-1.mp4" }]);
    await p.answer(job.id, "On it.");
    // the same file sent without a path still waits, as before
    const other = await p.upload("plain.mp4");
    expect(((await (await p.send({ text: "And this", files: [other.id] })).json()) as View).messages.at(-1)!.wait).toMatchObject({ for: "videos" });
    await p.stop();
  });

  it("on a server on this same Mac it is taken where it is, nothing uploaded; a file of another size at that path is refused", async () => {
    const p = await person("uma");
    const clip = path.join(process.env.DATA_DIR!, "Here.mov");
    writeFileSync(clip, Buffer.alloc(2048, 1));
    const inPlace = (size: number) => app.request("/api/assistant/files/path", { method: "POST", ...json({ path: clip, size }, { cookie: p.cookie }) });
    process.env.CT_LOCAL = "1";
    try {
      expect(((await (await inPlace(99)).json()) as { error: string }).error).toMatch(/isn't the one dropped/);
      const { id } = (await (await inPlace(2048)).json()) as { id: string };
      await p.send({ text: "Caption it", files: [{ id, path: clip }] });
      const job = await p.claim();
      expect(job.user).toContain(`"Here.mov" (0.0 MB), file id ${id}. On their computer it is at ${JSON.stringify(clip)}.`);
      await p.answer(job.id, "Ok.");
    } finally {
      delete process.env.CT_LOCAL;
    }
    expect((await inPlace(2048)).status).toBe(409); // a server elsewhere: the dock uploads instead
  });

  it("use_file on a file still arriving waits for it; past the wait it answers plainly that it is still uploading", async () => {
    const p = await person("rae");
    const [late, never] = [await p.upload("Late.mp4"), await p.upload("Slow.mp4")];
    await p.send({ text: "Review both", files: [{ id: late.id, path: "/Users/tiny/Late.mp4" }, { id: never.id, path: "/Users/tiny/Slow.mp4" }] });
    const job = await p.claim();
    const using = tool(job.mcp.token, "use_file", { file: late.id, to: "review" });
    await tick(100);
    await late.part();
    const used = JSON.parse((await using).text) as { href: string };
    expect(used.href).toMatch(/^\/review\//);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    let ended = false;
    const waiting = tool(job.mcp.token, "use_file", { file: never.id, to: "review" }).finally(() => (ended = true));
    // the clock moves only while the call is in flight; its reads of the disk run in real time between the steps
    for (let i = 0; i < 2000 && !ended; i++) {
      await new Promise((r) => setImmediate(r));
      await vi.advanceTimersByTimeAsync(500);
    }
    vi.useRealTimers();
    const out = await waiting;
    expect(out.error).toBe(false);
    expect(JSON.parse(out.text)).toMatchObject({ file: never.id, still_uploading: "Slow.mp4" });
    expect(out.text).not.toMatch(/isn't here any more/);
    await p.answer(job.id, "Done.");
  }, 20_000);
});

describe("headless: the user's own AI sends a file with upload_file", () => {
  it("gets a command that PUTs the parts to a link; the file id then works in use_file", async () => {
    const p = await person("sol");
    const key = newApiKey(p.user, "full");
    const size = 1000;
    const out = await tool(key, "upload_file", { path: "/Users/tiny/Movies/it's.mov", size });
    const { file, command } = JSON.parse(out.text) as { file: string; command: string };
    expect(command).toContain(`dd if='/Users/tiny/Movies/it'\\''s.mov'`);
    const link = /(\/api\/upload\/ctu_[a-f0-9]+)\//.exec(command)![1]!;
    const put = (n: number, bytes: number, at = link) => app.request(`${at}/${n}`, { method: "PUT", headers: { "content-length": String(bytes), "content-type": "application/octet-stream" }, body: Buffer.alloc(bytes, 1) });
    expect((await put(1, 10)).status).toBe(400); // a part's length is checked
    expect((await put(1, size, "/api/upload/ctu_nope")).status).toBe(404);
    expect((await put(1, size)).status).toBe(200);
    // the last part joined it: use_file takes it at once, on the key too
    const used = await tool(key, "use_file", { file, to: "review" });
    expect(used.error).toBe(false);
    expect(JSON.parse(used.text).href).toMatch(/^\/review\//);
  });
});

describe("does the dropped footage belong here?", () => {
  it("asks only with footage, names the open project, and Don't ask again under that offer turns it off", async () => {
    const p = await person("tom");
    await app.request("/api/workshop/projects", { method: "POST", ...json({ name: "Paper grabbers" }, { cookie: p.cookie }) });
    await p.send({ text: "Hi" });
    const plain = await p.claim();
    expect(plain.user).not.toContain("The project open in the app");
    await p.answer(plain.id, "Hello.");
    await settled(p);
    const clip = await p.upload("app-walkthrough.mp4");
    await clip.part();
    await p.send({ text: "Edit this", files: [clip.id] });
    const asks = await p.claim();
    expect(asks.user).toContain(`The project open in the app is "Paper grabbers"`);
    expect(asks.user).toContain(`"Keep it in Paper grabbers"`);
    await tool(asks.mcp.token, "offer_choices", { choices: ["New project", "Keep it in Paper grabbers", "Don't ask again"] });
    await p.answer(asks.id, "This looks like an app walkthrough, not Paper grabbers.");
    await settled(p);
    await p.send({ text: "Don't ask again" });
    const off = await p.claim();
    expect(readWorkPrefs("tom").askFit).toBe(false);
    await p.answer(off.id, "Ok, I won't ask.");
    await settled(p);
    await p.send({ text: "And this one", files: [clip.id] });
    const quiet = await p.claim();
    expect(quiet.user).not.toContain("The project open in the app");
    await p.answer(quiet.id, "Ok.");
    await settled(p);
    // the same words with no such offer above them change nothing
    await app.request("/api/work-prefs", { method: "PUT", ...json({ askFit: true }, { cookie: p.cookie }) });
    await p.send({ text: "Don't ask again" });
    await p.answer((await p.claim()).id, "?");
    expect(readWorkPrefs("tom").askFit).toBe(true);
  });
});
