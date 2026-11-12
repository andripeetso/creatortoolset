import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantView } from "../../contracts/assistant";
import type { CaptionRenderSpec, Cue, Word } from "../../src/lib/types";

const dataDir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "captions-export-"));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = "captions-export-secret";
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

// The transcription engine is stood in for, as in captions.test.ts. So is the browser that draws the caption frames
// (a real one is 196 MB): it hands back clear frames of the size it was asked for and keeps what it was asked to draw.
// ffmpeg is the real one, so the file that comes out is a real video.
const engine = { hold: Promise.resolve() };
const frames = { asked: [] as Array<{ spec: CaptionRenderSpec; drawn: number }>, hold: Promise.resolve(), broken: false };
let clearFrame = (_width: number, _height: number): Buffer => Buffer.alloc(0);
vi.mock("../caption-frames", () => ({
  createCaptionFrameRenderer: async (spec: CaptionRenderSpec) => {
    await frames.hold;
    const job = { spec, drawn: 0 };
    frames.asked.push(job);
    const frame = frames.broken ? Buffer.from("not a picture") : clearFrame(spec.width, spec.height);
    return { capacity: 4, render: async (times: number[]) => times.map(() => (job.drawn++, frame)), close: async () => {} };
  },
}));
vi.stubGlobal("fetch", async (url: string | URL) => {
  if (!String(url).startsWith("https://api.deepgram.com/")) throw new Error(`No network in this test: ${String(url)}`);
  await engine.hold;
  const words = SAID.map((w) => ({ word: w.text.toLowerCase(), punctuated_word: w.text, start: w.start, end: w.end, confidence: 0.99 }));
  return Response.json({ results: { channels: [{ alternatives: [{ words }] }], utterances: [{ start: 0, end: 2 }] } });
});

const { ffmpegCommand } = await import("../ffmpeg-runtime");
const { createUser, newApiKey } = await import("../users");
const { saveMyKey } = await import("../my-keys");
const app = (await import("../boot")).default;
const { pairDevice } = await import("../lib/devices");
const { saveSettings } = await import("../lib/providers");
const { DEFAULT_SETTINGS } = await import("../../contracts/providers");
const { segmentCues } = await import("../../src/lib/captions");
const { DEFAULT_STYLE } = await import("../../src/lib/types");

const ffmpeg = (args: string[]) => execFileSync(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-y", ...args]);
clearFrame = (width, height) => ffmpeg(["-f", "lavfi", "-i", `color=c=black@0.0:s=${width}x${height},format=rgba`, "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1"]);

const ana = createUser("ana", "password1");
createUser("nico", "password1");
const fullKey = `Bearer ${newApiKey(ana, "full")}`;
const mac = pairDevice("ana", "Ana's Mac");
await saveSettings({ ...structuredClone(DEFAULT_SETTINGS), instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: mac.device.id }] }, "ana");

// tiny made-up clips: a colour and a tone (the engine is stood in for). `upright`: stored lying down with a quarter
// turn beside it, as a phone keeps a clip filmed upright
const clipFile = (name: string, upright = false) => {
  const out = path.join(dataDir, name);
  const size = upright ? "640x360" : "360x640";
  ffmpeg(["-f", "lavfi", "-i", `color=c=teal:s=${size}:r=30:d=2.4`, "-f", "lavfi", "-i", "sine=frequency=220:duration=2.4", "-c:a", "aac", "-t", "2.4", "-c:v", "libx264", "-pix_fmt", "yuv420p", out]);
  if (!upright) return readFileSync(out);
  const turned = path.join(dataDir, `turned-${name}`);
  ffmpeg(["-display_rotation", "90", "-i", out, "-c", "copy", turned]);
  return readFileSync(turned);
};
const clip = clipFile("tumbles.mp4");
const phoneClip = clipFile("phone.mp4", true);
/** A video file as ffprobe reads it: its streams, the picture's size, and the turn a player would still add. */
const probe = (bytes: Buffer) => {
  const file = path.join(dataDir, "probed.mp4");
  writeFileSync(file, bytes);
  const v = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height:stream_side_data=rotation:format=duration", "-of", "json", file]).toString();
  const { streams, format } = JSON.parse(v) as { streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number; side_data_list?: Array<{ rotation?: number }> }>; format: { duration: string } };
  const picture = streams.find((s) => s.codec_type === "video")!;
  return { codecs: streams.map((s) => s.codec_name), size: [picture.width, picture.height], turn: picture.side_data_list?.[0]?.rotation ?? 0, seconds: Number(format.duration) };
};

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
type SavedClip = { id: string; name: string; duration: number; srcWidth: number; srcHeight: number; cues?: Cue[]; words?: Word[]; hasOriginal: boolean };
type Saved = { revision: number; captioning?: string; clips: SavedClip[] };
const projectOf = async (cookie: string, id: string) => (await (await app.request(`/api/projects/${id}`, { headers: { cookie } })).json()) as Saved;
const until = (check: () => Promise<void>) => vi.waitFor(check, { timeout: 25_000, interval: 50 });
/** Holds the engine or the frames until the returned function is called. */
const held = (what: { hold: Promise<void> }) => {
  let go!: () => void;
  what.hold = new Promise<void>((r) => (go = r));
  return go;
};
const cardsOf = async (cookie: string) => (await viewOf(cookie)).messages.flatMap((m) => m.work ?? []);
/** A dropped video made a Caption Studio project, as "caption this" does; `wait`: until its captions are saved. */
const captioned = async (cookie: string, name: string, bytes = clip, wait = true) => {
  const t = await turn(cookie, "Caption this");
  const sent = JSON.parse((await tool(t.token, "use_file", { file: await drop(cookie, "tumbles.mp4", bytes), to: "captions", name })).text) as { id: string };
  await t.end();
  if (wait) await until(async () => expect((await cardsOf(cookie)).find((w) => w.id === `captions:${sent.id}`)!.status).toBe("done"));
  return sent.id;
};
/** One captioned project the tests that change nothing in it share (each "caption this" encodes a video). */
let shared: Promise<string> | undefined;
const tinyTumbles = (cookie: string) => (shared ??= captioned(cookie, "Tiny tumbles"));
/** Tests here encode video, several times each: more room than the suite's 30 s when the computer is busy. */
const LONG = 90_000;
type Started = { id: string; name: string; export: string; file: string; state: string; link: string };
const exportsOf = async (cookie: string) => (await (await app.request("/api/exports", { headers: { cookie } })).json()) as Array<{ id: string; status: string; projectId?: string }>;
const lookOnOpen = { ...DEFAULT_STYLE, fitBox: true, lowercase: false };

beforeEach(() => {
  saveMyKey("ana", "DEEPGRAM_API_KEY", "ana-own-key");
  Object.assign(engine, { hold: Promise.resolve() });
  Object.assign(frames, { hold: Promise.resolve(), broken: false });
  frames.asked.length = 0;
});

describe("a Caption Studio project exported from the chat, with the captions burned in", () => {
  it("sends the request the page's Export dialog sends, leaves a running card, and when the file is there ends the card and says so once, with its link", async () => {
    const cookie = await cookieOf("ana");
    const project = await tinyTumbles(cookie);
    const p = await projectOf(cookie, project);
    const letGo = held(frames);

    const t = await turn(cookie, "Export it with the captions burned in");
    const answer = await tool(t.token, "captions_export", { project });
    expect(answer.error).toBe(false);
    const started = JSON.parse(answer.text) as Started;
    expect(started).toEqual({
      id: project,
      name: "Tiny tumbles",
      export: expect.stringMatching(/^[0-9a-f-]{36}$/),
      // the page's file name: {project}_{clip}, and the server's "-captioned"
      file: "Tiny_tumbles_tumbles-captioned.mp4",
      state: "Exporting by itself: captions_get shows when the file is ready.",
      link: `http://localhost/captions?project=${project}`,
    });
    const card = async () => (await cardsOf(cookie)).filter((w) => w.id === `export:${started.export}`);
    expect(await card()).toEqual([{ id: `export:${started.export}`, kind: "captions", title: "Tiny tumbles", href: `/captions?project=${project}`, status: "running", detail: "Exporting" }]);
    expect((await viewOf(cookie)).messages.at(-1)!.steps).toEqual(["Starting the export"]);
    // read back while it renders: how far it is, and no file yet
    const early = JSON.parse((await tool(t.token, "captions_get", { project })).text) as { exports: Array<Record<string, string>> };
    expect(early.exports).toEqual([{ export: started.export, file: started.file, state: expect.stringMatching(/^(Waiting for its turn|Exporting, \d+% done)$/) }]);
    await t.end();
    letGo();
    await until(async () => expect((await card())[0]!.status).toBe("done"));

    // what was drawn: the project's own lines, look, overlays and frame, as the page reads them from the server
    expect(frames.asked).toHaveLength(1);
    expect(frames.asked[0]!.spec).toEqual({ width: 360, height: 640, cues: p.clips[0]!.cues, style: lookOnOpen, posSegments: [], texts: [] });
    expect(frames.asked[0]!.spec.cues.length).toBeGreaterThan(0);
    // one frame for each of the video's (2.4 s at the project's 30 a second)
    expect(frames.asked[0]!.drawn).toBe(72);

    // the file: the video with its sound, the size it is shown at
    const file = await app.request(`/api/exports/${started.export}/file`, { headers: { cookie } });
    expect([file.status, file.headers.get("content-disposition")]).toEqual([200, 'attachment; filename="Tiny_tumbles_tumbles-captioned.mp4"']);
    const made = probe(Buffer.from(await file.arrayBuffer()));
    expect(made).toMatchObject({ codecs: ["h264", "aac"], size: [360, 640], turn: 0 });
    expect(made.seconds).toBeCloseTo(2.4, 1);

    // the card ended, and one line stands under the reply with the file's link (a press saves it) and the card it is about
    const ended = { id: `export:${started.export}`, kind: "captions", title: "Tiny tumbles", href: `/captions?project=${project}`, status: "done", detail: "Ready to download" };
    expect(await card()).toEqual([ended, ended]);
    const line = `“Tiny_tumbles_tumbles-captioned.mp4” is ready: [Download it](/api/exports/${started.export}/file).`;
    const messages = (await viewOf(cookie)).messages;
    expect([messages.at(-1)!.role, messages.at(-1)!.text, messages.at(-1)!.choices, messages.at(-1)!.work]).toEqual(["assistant", line, undefined, [ended]]);
    expect(messages.filter((m) => m.text === line)).toHaveLength(1);

    // asked later: the finished file and where to get it
    const next = await turn(cookie, "Where is it?");
    const got = JSON.parse((await tool(next.token, "captions_get", { project })).text) as { exports: unknown[] };
    expect(got.exports).toEqual([{ export: started.export, file: started.file, state: "Ready", download: `http://localhost/api/exports/${started.export}/file` }]);
    await next.end();
  }, LONG);

  it("an AI key from outside the app exports too, in H.265 when asked: nothing is said in the chat, and captions_get shows the file when it is there", async () => {
    const cookie = await cookieOf("ana");
    const project = await tinyTumbles(cookie);
    const before = (await viewOf(cookie)).messages.length;
    // the clip by its name, however it is written
    const started = JSON.parse((await tool(fullKey, "captions_export", { project, format: "h265", clip: "TUMBLES" })).text) as Started;
    expect(started.file).toBe("Tiny_tumbles_tumbles-captioned.mp4");
    const state = async () => (JSON.parse((await tool(fullKey, "captions_get", { project })).text) as { exports: Array<{ state: string; download?: string }> }).exports[0]!;
    await until(async () => expect((await state()).state).toBe("Ready"));
    const file = await app.request(new URL((await state()).download!).pathname, { headers: { authorization: fullKey } });
    expect(file.status).toBe(200);
    expect(probe(Buffer.from(await file.arrayBuffer()))).toMatchObject({ codecs: ["hevc", "aac"], size: [360, 640] });
    // no card was there to end, so the chat heard nothing
    await new Promise((r) => setTimeout(r, 2300));
    const view = await viewOf(cookie);
    expect(view.messages).toHaveLength(before);
    expect(view.messages.flatMap((m) => m.work ?? []).some((w) => w.id === `export:${started.export}`)).toBe(false);
  }, LONG);

  it("a phone clip filmed upright: the server keeps the size it is shown at, its captions are laid out for that frame, and the export comes out upright", async () => {
    const cookie = await cookieOf("ana");
    const project = await captioned(cookie, "Phone reel", phoneClip);
    const c = (await projectOf(cookie, project)).clips[0]!;
    // stored 640×360 with a quarter turn: shown, edited and rendered as 360×640
    expect([c.srcWidth, c.srcHeight]).toEqual([360, 640]);
    const page = segmentCues(c.words!, lookOnOpen, 360, 640);
    expect(c.cues!.map((q) => q.words.map((w) => w.text))).toEqual(page.map((q) => q.words.map((w) => w.text)));
    const started = JSON.parse((await tool(fullKey, "captions_export", { project })).text) as Started;
    await until(async () => expect((await exportsOf(cookie)).find((j) => j.id === started.export)!.status).toBe("done"));
    expect(frames.asked[0]!.spec).toMatchObject({ width: 360, height: 640 });
    // upright, and no turn left on the file for a player to add a second time
    const file = await app.request(`/api/exports/${started.export}/file`, { headers: { cookie } });
    expect(probe(Buffer.from(await file.arrayBuffer()))).toMatchObject({ size: [360, 640], turn: 0 });
  }, LONG);

  it("what cannot be exported is refused in a plain sentence, and nothing is started", async () => {
    const cookie = await cookieOf("ana");
    const project = await tinyTumbles(cookie);
    const jobs = (await exportsOf(cookie)).length;
    const said = async (args: Record<string, unknown>, as = fullKey) => {
      const r = await tool(as, "captions_export", args);
      expect(r.error).toBe(true);
      return r.text;
    };
    expect(await said({})).toBe("Give the project's id: captions_list lists them.");
    expect(await said({ project, format: "gif" })).toBe("format is h264 or h265.");
    expect(await said({ project, clip: "other.mp4" })).toBe("“Tiny tumbles” has no clip “other.mp4”. Its clips: tumbles.mp4.");
    // Finals takes 1080p or more: the route's own words
    expect(await said({ project, finals: true })).toMatch(/360×640, below 1080p/);
    // another account's project
    expect(await said({ project }, `Bearer ${newApiKey(createUser("nina", "password1"), "full")}`)).toBe("Not found, or not this account's.");

    // still being captioned: said, and when to ask again
    const letGo = held(engine);
    const busy = await captioned(cookie, "Busy reel", clip, false);
    expect(await said({ project: busy })).toBe("The captions for “Busy reel” are still being made. Export it once they are there: ask again in a minute.");
    letGo();
    await until(async () => expect((await projectOf(cookie, busy)).captioning).toBeUndefined());

    // not transcribed (no key to transcribe on): nothing to burn in
    saveMyKey("ana", "DEEPGRAM_API_KEY", null);
    const bare = await captioned(cookie, "No key yet", clip, false);
    expect(await said({ project: bare })).toBe("“No key yet” has no captions yet, so there is nothing to burn in. They are made on the project's page (Transcribe).");

    expect(await exportsOf(cookie)).toHaveLength(jobs);
    expect(frames.asked).toEqual([]);
  }, LONG);

  it("with several captioned clips it asks which one, and a clip whose video is no longer on the server is said so", async () => {
    const cookie = await cookieOf("ana");
    const project = await captioned(cookie, "Two clips");
    const jobs = (await exportsOf(cookie)).length;
    const said = async (args: Record<string, unknown>) => {
      const r = await tool(fullKey, "captions_export", args);
      expect(r.error).toBe(true);
      return r.text;
    };
    // a second clip with captions and no video yet
    const second = "22222222-2222-4222-8222-222222222222";
    const p = await projectOf(cookie, project);
    expect((await app.request(`/api/projects/${project}/clips/draft`, { method: "POST", ...json({ id: second, name: "second.mp4" }, { cookie }) })).status).toBe(200);
    const sync = await app.request(`/api/projects/${project}/sync`, { method: "PUT", ...json({ baseRevision: p.revision, mutationId: "second-clip-1", snapshot: { clip: { id: second, duration: 2.4, cues: p.clips[0]!.cues } } }, { cookie }) });
    expect(sync.status).toBe(200);
    expect(await said({ project })).toBe("“Two clips” has 2 clips with captions: say which one (clip = its name): tumbles.mp4, second.mp4.");
    const gone = "is no longer on the server, so it cannot be exported. On the project's page the video can be added again.";
    expect(await said({ project, clip: "second.mp4" })).toBe(`The video “second.mp4” ${gone}`);
    // the first clip's video removed since (the retention sweep does the same)
    expect((await app.request(`/api/projects/${project}/clips/${p.clips[0]!.id}/original`, { method: "DELETE", headers: { cookie } })).status).toBe(200);
    expect(await said({ project, clip: "tumbles.mp4" })).toBe(`The video “tumbles.mp4” ${gone}`);

    expect(await exportsOf(cookie)).toHaveLength(jobs);
    expect(frames.asked).toEqual([]);
  }, LONG);

  it("a render that fails ends its card with one plain sentence and the chat says why; one stopped on the page ends its card and says nothing", async () => {
    const cookie = await cookieOf("ana");
    const project = await tinyTumbles(cookie);
    const cardOf = async (id: string) => (await cardsOf(cookie)).find((w) => w.id === `export:${id}`)!;

    frames.broken = true;
    const t = await turn(cookie, "Export it");
    const failed = JSON.parse((await tool(t.token, "captions_export", { project })).text) as Started;
    await t.end();
    await until(async () => expect(await cardOf(failed.export)).toMatchObject({ status: "failed", detail: "The video could not be rendered" }));
    const last = (await viewOf(cookie)).messages.at(-1)!;
    expect(last.text).toBe("“Tiny_tumbles_tumbles-captioned.mp4” was not exported: The video could not be rendered.");
    // what ffmpeg printed is not in the chat, and not in what the AI reads back
    expect(JSON.stringify(await viewOf(cookie))).not.toContain("ffmpeg");
    expect((JSON.parse((await tool(fullKey, "captions_get", { project })).text) as { exports: Array<{ state: string }> }).exports[0]!.state).toBe("Failed: The video could not be rendered");

    frames.broken = false;
    const letGo = held(frames);
    const again = await turn(cookie, "Once more");
    const stopped = JSON.parse((await tool(again.token, "captions_export", { project })).text) as Started;
    await again.end();
    const before = (await viewOf(cookie)).messages.length;
    expect((await app.request(`/api/exports/${stopped.export}`, { method: "DELETE", headers: { cookie } })).status).toBe(200);
    await until(async () => expect(await cardOf(stopped.export)).toMatchObject({ status: "failed", detail: "Stopped" }));
    letGo();
    expect((await viewOf(cookie)).messages).toHaveLength(before);
  }, LONG);
});
