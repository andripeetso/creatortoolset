import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { TRANSCRIBE_KIND } from "../contracts/devices";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "transcribe-computers-"));
process.env.DATA_DIR = dir;
delete process.env.APP_SECRET; // one person's own install: every request is the local admin
delete process.env.CT_LOCAL;
vi.mock("./plugins.gen", () => ({ serverPlugins: [] }));

const app = (await import("./boot")).default;
const { LOCAL_USER } = await import("./users");
const { pairDevice, touchDevice } = await import("./lib/devices");
const { writeVoicePrefs } = await import("./lib/speech");
const { CAPTION_LIMITS, transcribeOnComputer } = await import("./lib/computer-transcribe");
const { STYLE_PRESETS } = await import("../src/lib/types");

const me = LOCAL_USER.username;
const json = (body: unknown, token?: string) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});
const pc = pairDevice(me, "Tiny PC");
await app.request("/api/devices/relay/report", json({ drivers: [], homes: [], machine: { os: "linux", cpus: 32, gpuMemGb: 16 } }, pc.token));
const claim = async () =>
  (await (await app.request("/api/devices/relay/editor/claim", json({ kinds: [TRANSCRIBE_KIND], models: ["whisper-large-v3-turbo"] }, pc.token))).json()) as {
    job: { id: number } | null;
  };
/** The computer's claim, as often as it takes for the page's request to reach the queue. */
async function claimJob(): Promise<{ id: number }> {
  for (let i = 0; i < 100; i++) {
    const { job } = await claim();
    if (job) return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("no transcript was queued");
}

/** A second of silence as the page sends it: a 16 kHz mono 16-bit WAV. */
const wav = (() => {
  const pcm = 32_000;
  const b = Buffer.alloc(44 + pcm);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + pcm, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(pcm, 40);
  return b;
})();
const transcribe = () => app.request("/api/transcribe", { method: "POST", headers: { "content-type": "audio/wav" }, body: wav });

/** Deepgram as it answers; how often it was asked. */
function deepgram() {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    asked.push(String(url));
    const words = [{ word: "hello", punctuated_word: "Hello.", start: 0.1, end: 0.5 }];
    return Response.json({ results: { channels: [{ alternatives: [{ words }] }] } });
  });
  return asked;
}

// the computer's own words, seconds as the helper and the Mac send them
const fromComputer = [
  { text: "Tere", start: 0.12, end: 0.48 },
  { text: "tulemast", start: 0.52, end: 1.1 },
];

writeVoicePrefs(me, { stt: { per: { captions: { engine: "local", model: "whisper-large-v3-turbo" } } } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("captions on the person's own computers", () => {
  it("a computer that is on writes them, with times in seconds the layout lays out", async () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "dg-test");
    const asked = deepgram();
    await claim(); // says it has turbo, and is on
    expect(await (await app.request("/api/transcribe/available")).json()).toMatchObject({ available: true, computers: "Whisper large-v3 turbo" });
    const answer = transcribe();
    const job = await claimJob();
    expect((await app.request(`/api/devices/relay/transcribe/${job.id}`, json({ words: fromComputer, language: "et" }, pc.token))).status).toBe(200);
    const res = await answer;
    expect(res.status).toBe(200);
    const got = (await res.json()) as { words: typeof fromComputer; language: string; note?: string };
    expect(got).toEqual({ words: fromComputer, language: "et" });
    expect(asked).toEqual([]); // nothing went to Deepgram
    // laid on screen by their times, as Deepgram's are
    const laid = await app.request("/api/captions/layout", json({ words: got.words, style: STYLE_PRESETS[0].style, width: 1080, height: 1920 }));
    const { cues } = (await laid.json()) as { cues: { start: number; end: number; words: { text: string; start: number; end: number }[] }[] };
    expect(cues[0]!.start).toBe(0.12);
    expect(cues.flatMap((c) => c.words.map(({ text, start, end }) => ({ text, start, end })))).toEqual(fromComputer);
  });

  it("the computer fails: Deepgram writes them, and says why quietly", async () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "dg-test");
    const asked = deepgram();
    const answer = transcribe();
    const job = await claimJob();
    await app.request(`/api/devices/relay/transcribe/${job.id}/fail`, json({ error: "Out of memory" }, pc.token));
    const got = (await (await answer).json()) as { words: { text: string }[]; note: string };
    expect(got.words.map((w) => w.text)).toEqual(["Hello."]);
    expect(got.note).toBe("Your computers could not do it: written by Deepgram");
    expect(asked).toHaveLength(1);
  });

  it("no computer on: Deepgram at once; with no key either, the page's own model (USE_BROWSER)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 10 * 60_000); // the PC has not been heard from in ten minutes
      vi.stubEnv("DEEPGRAM_API_KEY", "dg-test");
      deepgram();
      const got = (await (await transcribe()).json()) as { note: string };
      expect(got.note).toBe("Your computers are off: written by Deepgram");
      vi.stubEnv("DEEPGRAM_API_KEY", "");
      const res = await transcribe();
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: "USE_BROWSER", why: "Your computers are off" });
      // the page still offers the engine: its request falls back by itself
      expect(await (await app.request("/api/transcribe/available")).json()).toMatchObject({ available: true, computers: "Whisper large-v3 turbo" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a computer that is on but busy never holds a caption longer than a minute", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      await claim();
      const audio = path.join(dir, "c.wav");
      writeFileSync(audio, wav);
      const p = transcribeOnComputer(me, "whisper-large-v3-turbo", [], audio, CAPTION_LIMITS);
      const failed = expect(p).rejects.toThrow("took it in time");
      for (let t = 0; t <= CAPTION_LIMITS.claimMs; t += 15_000) {
        await vi.advanceTimersByTimeAsync(15_000);
        touchDevice(pc.device.id); // on, and claiming nothing (busy with something else)
      }
      await failed;
    } finally {
      vi.useRealTimers();
    }
  });

  it("captions chosen on Deepgram never go to a computer (as before)", async () => {
    writeVoicePrefs(me, { stt: { per: { captions: { engine: "deepgram" } } } });
    vi.stubEnv("DEEPGRAM_API_KEY", "dg-test");
    const asked = deepgram();
    await claim();
    const got = (await (await transcribe()).json()) as { words: { text: string }[]; note?: string };
    expect(got.words.map((w) => w.text)).toEqual(["Hello."]);
    expect(got.note).toBeUndefined();
    expect(asked).toHaveLength(1);
    expect(await (await app.request("/api/transcribe/available")).json()).toEqual({ available: true, allowed: true });
    writeVoicePrefs(me, { stt: { per: { captions: { engine: "local", model: "whisper-large-v3-turbo" } } } });
  });
});
