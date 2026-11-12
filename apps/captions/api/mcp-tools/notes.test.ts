import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage, AssistantView } from "../../contracts/assistant";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "notes-tools-"));
process.env.APP_SECRET = "notes-tools-secret";
// the server is on its owner's computer: Video Notes transcribes by itself, with no key and nothing asked of the internet
process.env.CT_LOCAL = "1";
delete process.env.DEEPGRAM_API_KEY;

// the speech model is not loaded in a test: this stands in for it, and listens for as long as the test says
let hears: "words" | "nothing" = "words";
let listening: Promise<void> = Promise.resolve();
vi.mock("../lib/device-transcribe", async (real) => ({
  ...(await real<typeof import("../lib/device-transcribe")>()),
  transcribeOnDevice: async () => {
    await listening;
    return hears === "words" ? { words: ["We", "start", "with", "a", "roll."].map((text, i) => ({ text, start: i / 5, end: (i + 1) / 5 })), language: "en" } : { error: "The speech model stopped" };
  },
}));

const { createUser, newApiKey } = await import("../users");
const app = (await import("../boot")).default;
const { mintJobToken } = await import("../auth");
const { pairDevice } = await import("../lib/devices");
const { saveSettings } = await import("../lib/providers");
const { DEFAULT_SETTINGS } = await import("../../contracts/providers");
const { ffmpegCommand } = await import("../ffmpeg-runtime");

// ana has her own AI on her Mac; nico has none
const ana = createUser("ana", "password1");
const nico = createUser("nico", "password1");
const anaKey = `Bearer ${newApiKey(ana, "full")}`;
const nicoKey = `Bearer ${newApiKey(nico, "full")}`;
const mac = pairDevice("ana", "Ana's Mac");
await saveSettings({ ...structuredClone(DEFAULT_SETTINGS), instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: mac.device.id }] }, "ana");

const cookieOf = async (username: string) => {
  const r = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "password1" }) });
  return r.headers.get("set-cookie")!.split(";")[0]!;
};
const json = (body: unknown, extra: Record<string, string> = {}) => ({ headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
/** One tool call through POST /api/mcp: its answer as text, read as JSON when it is. */
const tool = async (authorization: string, name: string, args: Record<string, unknown> = {}) => {
  const r = (await (await app.request("/api/mcp", { method: "POST", ...json({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { authorization }) })).json()) as {
    result: { content: Array<{ text: string }>; isError?: boolean };
  };
  const text = r.result.content[0]!.text;
  return { error: !!r.result.isError, text, out: (text.startsWith("{") ? JSON.parse(text) : {}) as Record<string, any> };
};

/** The Mac takes its next job: a reply of the assistant's (with the token its tools run under), or one of the app's own AI calls. */
const claim = async () => (await (await app.request("/api/devices/relay/wait", { method: "POST", ...json({}, { authorization: `Bearer ${mac.token}` }) })).json()) as { id: string; system: string; user: string; mcp?: { token: string } };
const finish = (id: string, text: string) => app.request(`/api/devices/relay/${id}/done`, { method: "POST", ...json({ text }, { authorization: `Bearer ${mac.token}` }) });
/** No AI is called: the test is the Mac, and answers each of the app's own AI calls with what its prompt asks for. */
const WRITES: Array<[RegExp, unknown]> = [
  [/title, summarize/, { title: "Tiny tumbles plan", summary: "A plan for the first class.", chapters: [{ t: 0, title: "Start" }] }],
  [/main takeaways/, { items: [{ text: "Start with a roll." }] }],
  [/action plan/, { items: [{ text: "Book the hall." }] }],
  [/spoken lines/, { items: [{ text: "We start with a roll.", t: 0 }] }],
];
const macWrites = async (calls: number) => {
  for (let i = 0; i < calls; i++) {
    const job = await claim();
    // anything else is the transcript's correction pass: nothing to fix
    await finish(job.id, JSON.stringify(WRITES.find(([asks]) => asks.test(job.system))?.[1] ?? {}));
  }
};
/** A message of ana's, with the Mac holding its reply: the token to call tools as that reply, and how to end it. */
const turn = async (cookie: string, text: string, files: string[] = []) => {
  expect((await app.request("/api/assistant/turn", { method: "POST", ...json({ text, files }, { cookie }) })).status).toBe(202);
  const job = await claim();
  return { job, token: `Bearer ${job.mcp!.token}`, end: async () => void (await finish(job.id, "Done.")) };
};
const messagesOf = async (cookie: string) => ((await (await app.request("/api/assistant", { headers: { cookie } })).json()) as AssistantView).messages;

/** A file dropped in the chat, as the dock sends it. */
const drop = async (cookie: string, name: string, mime: string, bytes: Buffer) => {
  const { id, partSize } = (await (await app.request("/api/assistant/files", { method: "POST", ...json({ name, mime, size: bytes.length }, { cookie }) })).json()) as { id: string; partSize: number };
  const part = await app.request(`/api/assistant/files/${id}/parts/1`, {
    method: "POST",
    headers: { cookie, "upload-length": String(bytes.length), "upload-part-size": String(partSize), "content-length": String(bytes.length), "content-type": "application/octet-stream" },
    body: bytes,
  });
  expect(part.status).toBe(200);
  expect((await app.request(`/api/assistant/files/${id}/complete`, { method: "POST", headers: { cookie } })).status).toBe(200);
  return id;
};

// one second of sound: enough for Video Notes to have something to transcribe
const wavFile = path.join(process.env.DATA_DIR, "plan.wav");
execFileSync(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=duration=1", "-ac", "1", "-ar", "16000", wavFile]);
const wav = readFileSync(wavFile);

/** A note as its page reads it. */
const noteOf = async (cookie: string, id: string) => (await (await app.request(`/api/clips/${id}`, { headers: { cookie } })).json()) as { status: string; name: string; generating?: string[] };
const seedNote = (id: string, owner: string, name: string, at: number, extra: Record<string, unknown> = {}) => {
  const dir = path.join(process.env.DATA_DIR!, "clips", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id, name, owner, duration: 125, bytes: 1, mime: "video/mp4", status: "ready", progress: 1, createdAt: at, updatedAt: at, ...extra }));
  return dir;
};

describe("a recording dropped in the chat becomes a Video Note", () => {
  let noteId = "";

  it("its card ends when the note is ready, and the chat says so once, with answer buttons", async () => {
    const cookie = await cookieOf("ana");
    const file = await drop(cookie, "Class plan.wav", "audio/wav", wav);
    const t = await turn(cookie, "Take notes on this", [file]);
    const made = (await tool(t.token, "use_file", { file, to: "notes" })).out;
    noteId = made.id;
    expect(made).toMatchObject({ to: "notes", name: "Class plan.wav", href: `/video-notes/${noteId}` });
    expect((await messagesOf(cookie)).at(-1)!.work).toEqual([{ id: `notes:${noteId}`, kind: "notes", title: "Class plan.wav", href: `/video-notes/${noteId}`, status: "running", detail: "Transcribing and summing it up" }]);
    // the reply ends ("it is being made") while the note is still being worked on
    await t.end();
    // the transcript's correction pass, then the title and the summary
    await macWrites(2);
    await vi.waitFor(async () => expect((await messagesOf(cookie)).at(-1)!.text).toBe("“Tiny tumbles plan” is ready."), { timeout: 20_000, interval: 100 });
    const messages = await messagesOf(cookie);
    expect(messages.slice(-2).map((m: AssistantMessage) => [m.role, m.text, m.status])).toEqual([["assistant", "Done.", "done"], ["assistant", "“Tiny tumbles plan” is ready.", "done"]]);
    expect(messages.at(-1)!.choices).toEqual(["Sum it up", "Show me"]);
    expect(messages.at(-2)!.work![0]).toMatchObject({ id: `notes:${noteId}`, status: "done", detail: "Ready" });
  });

  it("then gives its summary, and writes the takeaways and the action plan when asked for them", async () => {
    const cookie = await cookieOf("ana");
    const t = await turn(cookie, "Sum it up");
    // the line in the chat is all the AI has of the note: the list finds it by name
    expect(t.job.user).toContain("“Tiny tumbles plan” is ready.");
    const found = (await tool(t.token, "notes_list")).out.notes[0];
    expect(found).toMatchObject({ id: noteId, name: "Tiny tumbles plan", status: "ready", length: "0:01", link: `http://localhost/video-notes/${noteId}` });
    const plain = (await tool(t.token, "notes_get", { id: noteId })).out;
    expect(plain).toMatchObject({ status: "ready", summary: "A plan for the first class.", chapters: ["0:00.00 Start"] });
    expect(plain.takeaways ?? plain["action plan"] ?? plain.still_writing).toBeUndefined();
    // "action items" is how a person asks; the page calls it the action plan
    const asked = tool(t.token, "notes_get", { id: noteId, add: ["takeaways", "action items"] });
    await macWrites(2);
    const got = (await asked).out;
    expect(got).toMatchObject({ summary: "A plan for the first class.", takeaways: ["Start with a roll."], "action plan": ["Book the hall."] });
    expect(got.still_writing ?? got.could_not_write ?? got.actions).toBeUndefined();
    // what it has is not written twice: this answers with no AI call at all
    expect((await tool(t.token, "notes_get", { id: noteId, add: ["takeaways", "action plan"] })).out.takeaways).toEqual(["Start with a roll."]);
    expect((await tool(t.token, "notes_get", { id: noteId, add: ["everything"] })).text).toBe("add takes takeaways, action plan, quotes, summary, chapters.");
    await t.end();
  });

  it("says still writing when the wait runs out, and has them on the next call", async () => {
    const cookie = await cookieOf("ana");
    const t = await turn(cookie, "And the quotes?");
    const early = (await tool(t.token, "notes_get", { id: noteId, add: ["quotes"], wait_s: 0 })).out;
    expect(early).toMatchObject({ still_writing: ["quotes"], note: "Still writing: call notes_get again with the same add." });
    expect(early.quotes).toBeUndefined();
    expect((await noteOf(cookie, noteId)).generating).toEqual(["quotes"]);
    // called again while they are being written: the same writing is waited for, not started twice
    const again = tool(t.token, "notes_get", { id: noteId, add: ["quotes"] });
    await macWrites(1);
    expect(await again).toMatchObject({ error: false, out: { quotes: ["We start with a roll."] } });
    await t.end();
  });

  it("a recording that fails ends its card as failed, with the reason in the chat", async () => {
    hears = "nothing";
    let stop = () => {};
    listening = new Promise((r) => (stop = r));
    const cookie = await cookieOf("ana");
    const file = await drop(cookie, "Bad take.wav", "audio/wav", wav);
    const t = await turn(cookie, "And this one", [file]);
    const made = (await tool(t.token, "use_file", { file, to: "notes" })).out;
    await t.end();
    stop();
    await vi.waitFor(async () => expect((await messagesOf(cookie)).at(-1)!.text).toBe("“Bad take.wav” did not finish: The speech model stopped"), { timeout: 20_000, interval: 100 });
    hears = "words";
    const messages = await messagesOf(cookie);
    expect(messages.at(-1)!.choices).toEqual(["Show me"]);
    expect(messages.at(-2)!.work![0]).toMatchObject({ id: `notes:${made.id}`, status: "failed", detail: "The speech model stopped" });
    expect((await tool(anaKey, "notes_list")).out.notes[0]).toMatchObject({ id: made.id, status: "error" });
  });

  it("a note made on its own page says nothing in the chat", async () => {
    const cookie = await cookieOf("ana");
    const before = (await messagesOf(cookie)).length;
    const { id } = (await (await app.request("/api/clips?name=Walk&mime=audio/wav", { method: "POST", headers: { cookie }, body: wav })).json()) as { id: string };
    await macWrites(2);
    await vi.waitFor(async () => expect((await noteOf(cookie, id)).status).toBe("ready"), { timeout: 20_000, interval: 100 });
    expect((await messagesOf(cookie)).length).toBe(before);
  });
});

describe("Video Notes by their tools", () => {
  it("notes_list gives the caller's own Video Notes, newest first, and never someone else's", async () => {
    seedNote("aaaaaaaa-1111-4111-8111-111111111111", "nico", "Old warm-up", Date.UTC(2026, 10, 2, 9, 30));
    seedNote("aaaaaaaa-2222-4222-8222-222222222222", "nico", "New warm-up", Date.UTC(2026, 10, 9, 9, 30));
    const mine = (await tool(nicoKey, "notes_list")).out;
    expect(mine).toEqual({
      notes: [
        { id: "aaaaaaaa-2222-4222-8222-222222222222", name: "New warm-up", status: "ready", length: "2:05", when: "2026-11-09 09:30", link: "http://localhost/video-notes/aaaaaaaa-2222-4222-8222-222222222222" },
        { id: "aaaaaaaa-1111-4111-8111-111111111111", name: "Old warm-up", status: "ready", length: "2:05", when: "2026-11-02 09:30", link: "http://localhost/video-notes/aaaaaaaa-1111-4111-8111-111111111111" },
      ],
    });
    expect((await tool(nicoKey, "notes_list", { limit: 1 })).out).toMatchObject({ notes: [{ name: "New warm-up" }], more: 1 });
    const anas = (await tool(anaKey, "notes_list")).out.notes as Array<{ name: string }>;
    expect(anas.length).toBeGreaterThan(0);
    expect(anas.map((n) => n.name)).not.toContain("New warm-up");
  });

  it("an account with no AI is told why its takeaways could not be written; someone else's note is not found", async () => {
    const dir = seedNote("aaaaaaaa-3333-4333-8333-333333333333", "nico", "Spoken plan", Date.UTC(2026, 10, 10));
    writeFileSync(path.join(dir, "transcript.json"), JSON.stringify({ words: [{ text: "Roll.", start: 0, end: 1 }] }));
    const token = `Bearer ${mintJobToken("nico", "turn-nico-notes")}`;
    const out = (await tool(token, "notes_get", { id: "aaaaaaaa-3333-4333-8333-333333333333", add: ["takeaways"] })).out;
    expect(out.could_not_write).toEqual({ takeaways: "AI is not configured" });
    expect(out.still_writing ?? out.takeaways).toBeUndefined();
    // someone else's note is not found
    expect(await tool(token, "notes_get", { id: (await tool(anaKey, "notes_list")).out.notes[0].id, add: ["takeaways"] })).toMatchObject({ error: true, text: "Not found, or not this account's." });
  });
});

describe("a fix dropped in the chat", () => {
  it("becomes the next version of the Review video it fixes: the answer says which, and links to it; only the owner's own video", async () => {
    const cookie = await cookieOf("ana");
    const first = await drop(cookie, "Tumble reel.mp4", "video/mp4", Buffer.alloc(4096, 1));
    let t = await turn(cookie, "Put this up for review", [first]);
    const v1 = (await tool(t.token, "use_file", { file: first, to: "review" })).out;
    expect(v1).toEqual({ to: "review", id: v1.id, name: "Tumble reel.mp4", href: `/review/${v1.id}` });
    await t.end();

    const fix = await drop(cookie, "Tumble reel fixed.mp4", "video/mp4", Buffer.alloc(4096, 2));
    t = await turn(cookie, "Here is the fix for the tumble reel", [fix]);
    expect(await tool(t.token, "use_file", { file: fix, to: "notes", version_of: v1.id })).toMatchObject({ error: true, text: "version_of goes with to: review." });
    expect((await tool(t.token, "use_file", { file: fix, to: "review", version_of: "the tumble reel" })).text).toMatch(/isn't a review link/);
    const v2 = (await tool(t.token, "use_file", { file: fix, to: "review", version_of: `http://localhost/review/${v1.id}` })).out;
    expect(v2).toEqual({ to: "review", id: v1.id, name: "Tumble reel fixed", href: `/review/${v1.id}?v=2`, version: 2, note: "Version 2 of “Tumble reel fixed”" });
    expect((await messagesOf(cookie)).at(-1)!.work).toEqual([{ id: `review:${v1.id}`, kind: "review", title: "Tumble reel fixed", href: `/review/${v1.id}?v=2`, status: "done", detail: "Version 2 of “Tumble reel fixed”" }]);
    await t.end();
    // one video with two versions, as Review itself reads it
    const versions = async () => ((await (await app.request(`/api/review/assets/${v1.id}`, { headers: { cookie } })).json()) as { asset: { versions: Array<{ n: number }> } }).asset.versions.map((v) => v.n);
    expect(await versions()).toEqual([1, 2]);
    expect(existsSync(path.join(process.env.DATA_DIR!, "review", v1.id, "v2", "source"))).toBe(true);
    expect(((await (await app.request("/api/review", { headers: { cookie } })).json()) as unknown[]).length).toBe(1);

    // another account: by the id it finds nothing; by ana's share link it can watch the video, and still may not add to it
    const nicoCookie = await cookieOf("nico");
    const theirs = await drop(nicoCookie, "Not mine.mp4", "video/mp4", Buffer.alloc(4096, 3));
    const nicoToken = `Bearer ${mintJobToken("nico", "turn-nico-review")}`;
    expect(await tool(nicoToken, "use_file", { file: theirs, to: "review", version_of: v1.id })).toMatchObject({ error: true, text: "Not found, or not this account's." });
    const share = (await tool(anaKey, "review_share", { link: v1.id })).out.share_link as string;
    expect(await tool(nicoToken, "use_file", { file: theirs, to: "review", version_of: share })).toMatchObject({ error: true, text: "That Review video isn't here, or isn't this account's." });
    expect((await app.request(`/api/assistant/files/${theirs}/use`, { method: "POST", ...json({ to: "review", version_of: v1.id }, { cookie: nicoCookie }) })).status).toBe(409);
    // and the route makes nothing else of a file sent with a video to add to
    expect(await (await app.request(`/api/assistant/files/${theirs}/use`, { method: "POST", ...json({ to: "notes", version_of: v1.id }, { cookie: nicoCookie }) })).json()).toEqual({ error: "Only a Review video takes a next version." });
    expect(await versions()).toEqual([1, 2]);
    // someone who commented hears of the next version, as when it is uploaded on the page
    expect((await tool(nicoToken, "review_comment", { link: share, text: "Nice roll" })).error).toBeFalsy();
    const third = await drop(cookie, "Tumble reel again.mp4", "video/mp4", Buffer.alloc(4096, 5));
    expect((await tool(`Bearer ${mintJobToken("ana", "turn-ana-v3")}`, "use_file", { file: third, to: "review", version_of: v1.id })).out.version).toBe(3);
    const inbox = ((await (await app.request("/api/review/notifications", { headers: { cookie: nicoCookie } })).json()) as { items: Array<{ kind: string; text?: string }> }).items;
    expect(inbox.some((n) => n.kind === "version" && n.text === "V3")).toBe(true);
  });
});

describe("a tool that is not set up yet", () => {
  it("names the key to ask for and the page that holds the rest, never a page that holds nothing", async () => {
    const token = `Bearer ${mintJobToken("nico", "turn-nico-needs")}`;
    const file = await drop(await cookieOf("nico"), "Call.wav", "audio/wav", wav);
    // a hosted server never transcribes by itself: Video Notes needs a key there, and nico has no AI either
    process.env.CT_MODE = "hosted";
    const out = (await tool(token, "use_file", { file, to: "notes" })).out;
    delete process.env.CT_MODE;
    expect(out.not_yet).toBe("Video Notes needs these first; then call use_file again.");
    expect(out.needs).toEqual([
      { what: "A Deepgram key", ask_secret: ["DEEPGRAM_API_KEY"] },
      { what: "An AI provider", open: "/settings/providers" },
    ]);
  });
});
