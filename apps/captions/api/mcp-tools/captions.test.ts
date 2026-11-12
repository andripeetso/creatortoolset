import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const dataDir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "captions-tools-"));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = "captions-tools-secret";
delete process.env.DEEPGRAM_API_KEY;
delete process.env.CT_LOCAL;
delete process.env.CT_MODE;
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const SAID = [
  { text: "Tiny", start: 0.1, end: 0.4 },
  { text: "Acrobatics", start: 0.45, end: 0.9 },
  { text: "starts", start: 1, end: 1.2 },
  { text: "with", start: 1.25, end: 1.4 },
  { text: "a", start: 1.42, end: 1.5 },
  { text: "roll.", start: 1.55, end: 1.9 },
];

// The engines are stood in for. The cloud's request is answered here and kept; this computer's model is never loaded.
// `hold` keeps an engine (or the AI) from answering until the test lets go, so the test can act in between.
const engine = { cloud: [] as Array<{ auth: string; wav: Buffer }>, device: [] as string[], words: SAID, fail: "", hold: Promise.resolve() };
const ai = { on: false, asked: 0, hold: Promise.resolve() };
vi.mock("../lib/device-transcribe", async (real) => ({
  ...(await real<typeof import("../lib/device-transcribe")>()),
  transcribeOnDevice: async (_file: string, key: string) => {
    engine.device.push(key);
    await engine.hold;
    return { words: engine.words, language: "en" };
  },
}));
// the cadence pass goes to the person's own AI: off unless a test switches it on, and then it answers with two thoughts
vi.mock("../ai-complete", async (real) => ({
  ...(await real<typeof import("../ai-complete")>()),
  anyAiConfigured: () => ai.on,
  completeWithFallback: async (_system: string, _prompt: string, _signal: unknown, parse: (answer: string) => unknown) => {
    ai.asked++;
    await ai.hold;
    return parse('{"lines":["Tiny Acrobatics","starts with a roll."]}');
  },
}));
// each change notice a background job asks for, with the projects the server was captioning at that moment (the
// notice goes out then or up to a second later, never before)
const notices: Array<{ topic: string; captioning: string[] }> = [];
let beingCaptioned = (): string[] => [];
vi.mock("../lib/announce-soon", async (real) => {
  const { announceSoon } = await real<typeof import("../lib/announce-soon")>();
  return {
    announceSoon: (owner: string | null | undefined, topic: string, ms?: number) => {
      notices.push({ topic, captioning: beingCaptioned() });
      announceSoon(owner, topic, ms);
    },
  };
});
vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
  if (!String(url).startsWith("https://api.deepgram.com/")) throw new Error(`No network in this test: ${String(url)}`);
  engine.cloud.push({ auth: new Headers(init?.headers).get("authorization") ?? "", wav: Buffer.from(init!.body as ArrayBuffer) });
  await engine.hold;
  if (engine.fail) return new Response(engine.fail, { status: 500 });
  const words = engine.words.map((w) => ({ word: w.text.toLowerCase(), punctuated_word: w.text, start: w.start, end: w.end, confidence: 0.99 }));
  return Response.json({ results: { channels: [{ alternatives: [{ words }] }], utterances: [{ start: 0, end: 2 }] } });
});

const { ffmpegCommand } = await import("../ffmpeg-runtime");
const { createUser, newApiKey } = await import("../users");
const { saveMyKey } = await import("../my-keys");
const app = (await import("../boot")).default;
const { pairDevice } = await import("../lib/devices");
const { saveSettings } = await import("../lib/providers");
const { DEFAULT_SETTINGS } = await import("../../contracts/providers");
const { cadenceFitOf, segmentCues } = await import("../../src/lib/captions");
const { DEFAULT_STYLE } = await import("../../src/lib/types");
const { clock } = await import("./types");
const { captioning } = await import("../projects");
beingCaptioned = () => [...captioning.keys()];
/** The page's own Transcribe for a project, as it asks the cloud route (src/lib/transcribe.ts): the status and what it was told. */
const pageTranscribes = async (cookie: string, project: string) => {
  const r = await app.request(`/api/transcribe?project=${project}`, { method: "POST", headers: { cookie, "content-type": "audio/wav" }, body: new Uint8Array(64) });
  return [r.status, ((await r.json()) as { error?: string }).error];
};
/** The "projects" notices asked for since `from` (a count of `notices`): a page that has the project open reads it again on each. */
const noticesSince = (from: number) => notices.slice(from).filter((n) => n.topic === "projects");
import type { AssistantView } from "../../contracts/assistant";
import type { CaptionStyle, Cue, Word } from "../../src/lib/types";

const ana = createUser("ana", "password1");
createUser("nico", "password1");
const fullKey = `Bearer ${newApiKey(ana, "full")}`;
const mac = pairDevice("ana", "Ana's Mac");
await saveSettings({ ...structuredClone(DEFAULT_SETTINGS), instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: mac.device.id }] }, "ana");

// a tiny made-up clip: a colour, and a spoken line where the computer can speak (a tone elsewhere: the engine is stood in for)
const clipFile = (name: string, sound: boolean) => {
  const out = path.join(dataDir, name);
  const voice = path.join(dataDir, "line.aiff");
  let audio = ["-f", "lavfi", "-i", "sine=frequency=220:duration=2.4"];
  try {
    execFileSync("say", ["-o", voice, "Tiny Acrobatics starts with a roll"], { stdio: "ignore" });
    audio = ["-i", voice];
  } catch {
    /* no voice on this computer */
  }
  const picture = ["-f", "lavfi", "-i", "color=c=teal:s=360x640:r=30:d=2.4"];
  execFileSync(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-y", ...picture, ...(sound ? [...audio, "-af", "apad", "-c:a", "aac"] : ["-an"]), "-t", "2.4", "-c:v", "libx264", "-pix_fmt", "yuv420p", out]);
  return readFileSync(out);
};
const clip = clipFile("tumbles.mp4", true);
const muteClip = clipFile("mute.mp4", false);

const cookieOf = async (username: string) => {
  const r = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "password1" }) });
  return r.headers.get("set-cookie")!.split(";")[0]!;
};
const json = (body: unknown, extra: Record<string, string> = {}) => ({ headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
const tool = async (authorization: string, name: string, args: Record<string, unknown> = {}) => {
  const r = (await (await app.request("/api/mcp", { method: "POST", ...json({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { authorization }) })).json()) as {
    result: { content: Array<{ text: string }>; isError?: boolean };
  };
  return { error: !!r.result.isError, text: r.result.content[0]!.text };
};
const viewOf = async (cookie: string) => (await (await app.request("/api/assistant", { headers: { cookie } })).json()) as AssistantView;
/** A turn of ana's, with the Mac holding its job: the token to call tools as that reply, and how to end it. */
const turn = async (cookie: string, text: string) => {
  expect((await app.request("/api/assistant/turn", { method: "POST", ...json({ text }, { cookie }) })).status).toBe(202);
  const job = (await (await app.request("/api/devices/relay/wait", { method: "POST", ...json({}, { authorization: `Bearer ${mac.token}` }) })).json()) as { id: string; mcp: { token: string } };
  return { token: `Bearer ${job.mcp.token}`, end: async () => void (await app.request(`/api/devices/relay/${job.id}/done`, { method: "POST", ...json({ text: "Done." }, { authorization: `Bearer ${mac.token}` }) })) };
};
/** A video dropped in the chat, as the dock uploads it: its id. */
const drop = async (cookie: string, name: string, bytes: Buffer) => {
  const { id, partSize } = (await (await app.request("/api/assistant/files", { method: "POST", ...json({ name, mime: "video/mp4", size: bytes.length }, { cookie }) })).json()) as { id: string; partSize: number };
  const headers = { cookie, "upload-length": String(bytes.length), "upload-part-size": String(partSize), "content-length": String(bytes.length), "content-type": "application/octet-stream" };
  expect((await app.request(`/api/assistant/files/${id}/parts/1`, { method: "POST", headers, body: bytes })).status).toBe(200);
  expect((await app.request(`/api/assistant/files/${id}/complete`, { method: "POST", headers: { cookie } })).status).toBe(200);
  return id;
};

type SavedClip = {
  id: string; name: string; duration: number; style: CaptionStyle; words?: Word[]; originalWords?: Word[]; cues?: Cue[]; peaks?: number[];
  cadenceApplied?: boolean; cadenceFit?: unknown; cadenceDirty?: boolean; done?: boolean; posSegments?: unknown[]; texts?: unknown[];
};
type Saved = { revision: number; model: string | null; autoCadence: boolean | null; fps: number | null; script: string; captioning?: string; clips: SavedClip[] };
const projectOf = async (cookie: string, id: string) => (await (await app.request(`/api/projects/${id}`, { headers: { cookie } })).json()) as Saved;
const sync = (cookie: string, id: string, baseRevision: number, clip: Record<string, unknown>) =>
  app.request(`/api/projects/${id}/sync`, { method: "PUT", ...json({ baseRevision, mutationId: `page-${id}-${baseRevision}`, snapshot: { clip } }, { cookie }) });
/** "Caption this" in a reply of ana's: use_file's answer, the reply (to end), and the card under it. */
const captionThis = async (cookie: string, name: string, bytes = clip) => {
  const file = await drop(cookie, "tumbles.mp4", bytes);
  const t = await turn(cookie, "Caption this");
  const sent = JSON.parse((await tool(t.token, "use_file", { file, to: "captions", name })).text) as { id: string; href: string; name: string; note?: string; captioning?: boolean };
  return { ...t, sent, card: async () => (await viewOf(cookie)).messages.flatMap((m) => m.work ?? []).find((w) => w.id === `captions:${sent.id}`)! };
};
const until = (check: () => Promise<void>) => vi.waitFor(check, { timeout: 25_000, interval: 50 });
/** Holds an engine or the AI until the returned function is called. */
const held = (what: { hold: Promise<void> }) => {
  let go!: () => void;
  what.hold = new Promise<void>((r) => (go = r));
  return go;
};
const noIds = (cues: Cue[]) => JSON.parse(JSON.stringify(cues.map(({ id: _, ...c }) => c))) as unknown;
const lookOnOpen = { ...DEFAULT_STYLE, fitBox: true, lowercase: false };

beforeEach(() => {
  saveMyKey("ana", "DEEPGRAM_API_KEY", "ana-own-key");
  delete process.env.CT_LOCAL;
  Object.assign(engine, { words: SAID, fail: "", hold: Promise.resolve() });
  engine.cloud.length = 0;
  engine.device.length = 0;
  Object.assign(ai, { on: false, asked: 0, hold: Promise.resolve() });
});

describe("a video dropped in the chat and sent to Caption Studio", () => {
  it("answers with the project at once, makes the captions the page's Transcribe would have saved, then ends its card and says so in the chat", async () => {
    const cookie = await cookieOf("ana");
    const letGo = held(engine);
    const { sent, card, token, end } = await captionThis(cookie, "Tiny tumbles");
    const heard = notices.length;
    expect(sent).toMatchObject({ to: "captions", name: "Tiny tumbles", href: `/captions?project=${sent.id}`, captioning: true });
    expect(sent.id).toMatch(/^[0-9a-f-]{36}$/);
    // the project can be opened at once: the AI is not told to wait
    expect(sent.note).toBe("Being prepared and transcribed: the chat says when the captions are ready.");
    expect(await card()).toMatchObject({ id: `captions:${sent.id}`, kind: "captions", title: "Tiny tumbles", status: "running", detail: "Making the captions" });
    // read back while they are being made: the state, and no captions yet
    const early = JSON.parse((await tool(token, "captions_get", { project: sent.id })).text);
    expect(early.state).toMatch(/^Still being (prepared|transcribed)/);
    expect(early.clips).toEqual([{ name: "tumbles.mp4", captions: "None yet" }]);
    await until(async () => expect(engine.cloud).toHaveLength(1));
    expect((await projectOf(cookie, sent.id)).captioning).toBe("transcribing");
    // opened meanwhile, the page's own Transcribe gets no second transcript: the route refuses it for this project
    expect(await pageTranscribes(cookie, sent.id)).toEqual([409, "This project's captions are already being made: they show here when they are ready"]);
    expect(engine.cloud).toHaveLength(1);

    // the engine got what the browser posts: 16 kHz mono WAV, on her own key
    expect(engine.cloud[0]!.auth).toBe("Token ana-own-key");
    const wav = engine.cloud[0]!.wav;
    expect([wav.toString("latin1", 0, 4), wav.readUInt16LE(22), wav.readUInt32LE(24)]).toEqual(["RIFF", 1, 16000]);
    letGo();
    await until(async () => expect((await card()).status).toBe("done"));

    const p = await projectOf(cookie, sent.id);
    const c = p.clips[0]!;
    const words = SAID.map((w, i) => ({ ...w, id: i + 1, timing: "aligned", confidence: 0.99, utterance: 0 })) as Word[];
    expect(p).toMatchObject({ revision: 1, model: "cloud/deepgram", autoCadence: true, fps: 30, script: "" });
    expect(p.captioning).toBeUndefined();
    expect(c).toMatchObject({ name: "tumbles.mp4", style: lookOnOpen, words, originalWords: words, cadenceApplied: false, cadenceFit: null, cadenceDirty: false, done: false, posSegments: [], texts: [] });
    // the lines are the ones the page's own layout call makes for these words, this look and this frame
    const page = segmentCues(words, lookOnOpen, 360, 640);
    expect(page.length).toBeGreaterThan(0);
    expect(noIds(c.cues!)).toEqual(noIds(page));
    expect(c.duration).toBeCloseTo(2.4, 1);
    // the waveform the timeline draws
    expect(c.peaks).toHaveLength(500);
    expect(Math.max(...c.peaks!)).toBeGreaterThan(0);

    // the open page is told once the project no longer says it is being captioned: it reads it again and has the captions
    await until(async () => expect(noticesSince(heard).at(-1)?.captioning.includes(sent.id)).toBe(false));
    // from here Transcribe on the page is the person's own again (re-transcribe)
    expect((await pageTranscribes(cookie, sent.id))[0]).toBe(200);
    expect(engine.cloud).toHaveLength(2);

    // the card ended; the line waits for the reply to end, then stands under it with its buttons
    expect(await card()).toMatchObject({ status: "done", detail: "Captions are ready", href: `/captions?project=${sent.id}` });
    await end();
    const said = (await viewOf(cookie)).messages.at(-1)!;
    expect([said.role, said.text, said.choices]).toEqual(["assistant", "The captions for “Tiny tumbles” are ready.", ["Show me", "What do they say?"]]);

    // "What do they say?": each line with its start time, and the link
    const next = await turn(cookie, "What do they say?");
    const got = JSON.parse((await tool(next.token, "captions_get", { project: sent.id })).text);
    const lines = page.map((q) => `${clock(q.start)} ${q.words.map((w) => w.text).join(" ")}`);
    expect(got).toEqual({ id: sent.id, name: "Tiny tumbles", clips: [{ name: "tumbles.mp4", lines }], link: `http://localhost/captions?project=${sent.id}` });
    expect(lines.join(" ")).toContain("0:00.10 Tiny");
    expect((await viewOf(cookie)).messages.at(-1)!.steps).toEqual(["Reading the captions"]);
    await next.end();

    // the page opens it and saves on: its next save, at the revision the server left, is taken
    const save = await sync(cookie, sent.id, p.revision, { ...c, done: true });
    expect([save.status, ((await save.json()) as { revision: number }).revision]).toEqual([200, 2]);
  });

  it("the card under the reply leads to the project from the start, while the captions are still being made", async () => {
    const cookie = await cookieOf("ana");
    const letGo = held(engine);
    const { sent, card, end } = await captionThis(cookie, "Opened at once");
    const early = await card();
    letGo();
    await end();
    await until(async () => expect((await card()).status).toBe("done"));
    expect(early).toEqual({ id: `captions:${sent.id}`, kind: "captions", title: "Opened at once", href: `/captions?project=${sent.id}`, status: "running", detail: "Making the captions" });
  });

  it("lists the projects newest first, to an AI key from outside too, and never another account's", async () => {
    const cookie = await cookieOf("ana");
    const first = await captionThis(cookie, "First reel");
    await until(async () => expect((await first.card()).status).toBe("done"));
    await first.end();
    const second = await captionThis(cookie, "Second reel");
    await until(async () => expect((await second.card()).status).toBe("done"));
    await second.end();
    const { projects, more } = JSON.parse((await tool(fullKey, "captions_list", { limit: 2 })).text) as { projects: Array<Record<string, unknown>>; more?: number };
    expect(projects.map((p) => p.name)).toEqual(["Second reel", "First reel"]);
    expect(projects[0]).toEqual({ id: second.sent.id, name: "Second reel", changed: expect.stringMatching(/^\d{4}-\d\d-\d\d \d\d:\d\d$/), clips: [{ name: "tumbles.mp4", captions: true }], link: `http://localhost/captions?project=${second.sent.id}` });
    expect(more).toBeGreaterThan(0);
    expect((await tool(fullKey, "captions_get")).text).toBe("Give the project's id: captions_list lists them.");

    const nico = `Bearer ${newApiKey(createUser("nina", "password1"), "full")}`;
    expect(JSON.parse((await tool(nico, "captions_list")).text)).toEqual({ projects: [] });
    expect(await tool(nico, "captions_get", { project: second.sent.id })).toEqual({ error: true, text: "Not found, or not this account's." });
  });

  it("with no key, a server on her own computer transcribes by itself; the cadence pass is her own AI's, and what she changed on the page meanwhile is kept", async () => {
    const cookie = await cookieOf("ana");
    saveMyKey("ana", "DEEPGRAM_API_KEY", null);
    process.env.CT_LOCAL = "1";
    ai.on = true;
    const letGo = held(ai);
    const { sent, card, end } = await captionThis(cookie, "Kitchen roll");
    expect(sent.captioning).toBe(true);
    await end();
    // while her AI thinks about the lines, she opens the project and picks another font: the page saves
    await until(async () => expect(ai.asked).toBeGreaterThan(0));
    const open = await projectOf(cookie, sent.id);
    expect((await sync(cookie, sent.id, open.revision, { id: open.clips[0]!.id, style: { ...lookOnOpen, fontFamily: "Poppins" } })).status).toBe(200);
    letGo();
    await until(async () => expect((await card()).status).toBe("done"));

    expect(engine.device).toEqual([sent.id]);
    expect(engine.cloud).toEqual([]);
    const p = await projectOf(cookie, sent.id);
    const c = p.clips[0]!;
    const style = { ...lookOnOpen, fontFamily: "Poppins" };
    // her save stood (revision 1); the captions went on top of it, laid out for her look
    expect(p).toMatchObject({ revision: 2, model: "Xenova/whisper-base", autoCadence: true });
    expect(c.style).toEqual(style);
    expect(c.originalWords).toEqual(SAID.map((w, i) => ({ ...w, id: i + 1, timing: "approximate" })));
    expect(c.words!.map((w) => w.cut)).toEqual([2, 0, 2, 0, 0, 0]);
    expect(c).toMatchObject({ cadenceApplied: true, cadenceFit: cadenceFitOf(style) });
    expect(c.cues!.map((q) => q.words.map((w) => w.text).join(" "))).toEqual(["Tiny Acrobatics", "starts with a roll."]);
    expect((await viewOf(cookie)).messages.at(-1)!.text).toBe("The captions for “Kitchen roll” are ready.");
  });

  it("captions she made on the page while the server was still listening stay hers", async () => {
    const cookie = await cookieOf("ana");
    const letGo = held(engine);
    const { sent, card, end } = await captionThis(cookie, "Her own");
    await end();
    await until(async () => expect(engine.cloud).toHaveLength(1));
    const open = await projectOf(cookie, sent.id);
    const mine: Word = { id: 0, text: "Mine.", start: 0, end: 1 };
    expect((await sync(cookie, sent.id, open.revision, { id: open.clips[0]!.id, style: lookOnOpen, words: [mine], cues: [{ id: 7, start: 0, end: 1, words: [mine] }] })).status).toBe(200);
    letGo();
    await until(async () => expect((await card()).status).toBe("done"));
    const p = await projectOf(cookie, sent.id);
    expect(p.revision).toBe(1);
    expect(p.clips[0]!.cues).toEqual([{ id: 7, start: 0, end: 1, words: [mine] }]);
    expect((await viewOf(cookie)).messages.at(-1)!.text).toBe("The captions for “Her own” are ready.");
  });

  it("with nothing to transcribe on, the project is still made and the answer says why, in the route's words; nothing is sent anywhere", async () => {
    const cookie = await cookieOf("ana");
    saveMyKey("ana", "DEEPGRAM_API_KEY", null);
    const { sent, card, end } = await captionThis(cookie, "No key yet");
    expect(sent.captioning).toBeUndefined();
    expect(sent.note).toBe("Not transcribed: Add your Deepgram key in Settings → API keys. On the project's page, Transcribe runs in the browser and needs no key.");
    expect(await card()).toEqual({ id: `captions:${sent.id}`, kind: "captions", title: "No key yet", href: `/captions?project=${sent.id}`, status: "done", detail: "In Caption Studio, not transcribed" });
    await end();
    // the project is there with its editing copy, to open and transcribe on the page
    await until(async () => expect(((await (await app.request(`/api/projects/${sent.id}/clips/${(await projectOf(cookie, sent.id)).clips[0]!.id}/original/status`, { headers: { cookie } })).json()) as { proxyReady: boolean }).proxyReady).toBe(true));
    expect([engine.cloud, engine.device]).toEqual([[], []]);
    expect((await projectOf(cookie, sent.id)).clips[0]!.cues).toBeUndefined();
    expect((await viewOf(cookie)).messages.at(-1)!.text).toBe("Done.");
  });

  it("a file that is no video ends its card with one plain sentence, never what ffmpeg printed", async () => {
    const cookie = await cookieOf("ana");
    const broken = await captionThis(cookie, "Broken", Buffer.from("this is not a video at all ".repeat(40)));
    expect(broken.sent.captioning).toBe(true);
    await broken.end();
    await until(async () => expect(await broken.card()).toEqual({ id: `captions:${broken.sent.id}`, kind: "captions", title: "Broken", href: broken.sent.href, status: "failed", detail: "This file could not be read as a video" }));
    const said = (await viewOf(cookie)).messages.at(-1)!;
    expect([said.text, said.choices]).toEqual(["The captions for “Broken” were not made: This file could not be read as a video.", ["Show me"]]);
    expect(engine.cloud).toEqual([]);
    expect((await projectOf(cookie, broken.sent.id)).captioning).toBeUndefined();
  });

  it("when it cannot be done the card fails and the chat says why: the engine's refusal, a file with no sound; a clip where nothing is said has no captions", async () => {
    const cookie = await cookieOf("ana");
    const lastLine = async () => {
      const m = (await viewOf(cookie)).messages.at(-1)!;
      return [m.text, m.choices];
    };
    engine.fail = "quota";
    const heard = notices.length;
    const refused = await captionThis(cookie, "Loud");
    await refused.end();
    await until(async () => expect(await refused.card()).toMatchObject({ status: "failed", detail: "Deepgram 500: quota" }));
    expect(await lastLine()).toEqual(["The captions for “Loud” were not made: Deepgram 500: quota.", ["Show me"]]);
    expect((await projectOf(cookie, refused.sent.id)).revision).toBe(0);
    // nothing was saved, and the open page is told all the same: it offers Transcribe again
    await until(async () => expect(noticesSince(heard).at(-1)?.captioning.includes(refused.sent.id)).toBe(false));

    engine.fail = "";
    const mute = await captionThis(cookie, "Mute", muteClip);
    await mute.end();
    await until(async () => expect(await mute.card()).toMatchObject({ status: "failed", detail: "This file has no audio track" }));
    expect(engine.cloud).toHaveLength(1);

    engine.words = [];
    const quiet = await captionThis(cookie, "Quiet");
    await quiet.end();
    await until(async () => expect(await quiet.card()).toMatchObject({ status: "done", detail: "No words were heard" }));
    expect(await lastLine()).toEqual(["No words were heard in “Quiet”, so it has no captions.", ["Show me"]]);
    const p = await projectOf(cookie, quiet.sent.id);
    expect(p.clips[0]).toMatchObject({ words: [], cues: [], originalWords: [] });
    expect(p.clips[0]!.peaks).toHaveLength(500);
  });
});
