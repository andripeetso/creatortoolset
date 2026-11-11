import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// A message sent while its videos still upload, and messages sent while a reply is being written: they wait on the server.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "assistant-send-now-"));
process.env.APP_SECRET = "assistant-test-secret";

const { createUser } = await import("./users");
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
  createUser(name, "password1");
  const mac = pairDevice(name, `${name}'s Mac`);
  await saveSettings({ ...structuredClone(DEFAULT_SETTINGS), instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: mac.device.id }] }, name);
  const login = await app.request("/api/auth/login", { method: "POST", ...json({ username: name, password: "password1" }) });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const device = { authorization: `Bearer ${mac.token}` };
  type Job = { id: string; user: string; files?: Record<string, string> };
  return {
    cookie,
    /** The Mac's next job (long-polls: a promise that settles when there is one). */
    claim: async () => (await (await app.request("/api/devices/relay/wait", { method: "POST", ...json({}, device) })).json()) as Job,
    ask: (id: string, body: Record<string, unknown>) => app.request(`/api/devices/relay/${id}/ask`, { method: "POST", ...json(body, device) }),
    answer: (id: string, text: string) => app.request(`/api/devices/relay/${id}/done`, { method: "POST", ...json({ text }, device) }),
    view: async () => (await (await app.request("/api/assistant", { headers: { cookie } })).json()) as View,
    send: (body: Record<string, unknown>) => app.request("/api/assistant/turn", { method: "POST", ...json(body, { cookie }) }),
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

/** Whether a promise is still waiting after a moment (the Mac has no job yet). */
const stillWaiting = async (p: Promise<unknown>) => (await Promise.race([p.then(() => "settled"), tick(150).then(() => "waiting")])) === "waiting";
/** The view once its newest message is no longer being written. */
async function settled(p: Awaited<ReturnType<typeof person>>) {
  let v = await p.view();
  for (let i = 0; i < 50 && v.messages.at(-1)?.status === "thinking"; i++) v = (await tick(), await p.view());
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
