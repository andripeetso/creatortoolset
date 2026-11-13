import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "transcribe-mic-"));
process.env.DATA_DIR = dir;
delete process.env.APP_SECRET; // the solo install: "local" is the admin, served by the server's keys
delete process.env.CT_LOCAL;
const { ffmpegCommand } = await import("./ffmpeg-runtime");
const { LOCAL_USER } = await import("./users");
const { transcribeApp } = await import("./transcribe");
const { writeVoicePrefs } = await import("./lib/speech");
type AuthVars = import("./auth").AuthVars;

const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => (c.set("user", LOCAL_USER), next()));
app.route("/", transcribeApp);

/** What the phone sends: AAC in m4a, 16 kHz mono. */
const m4a = path.join(dir, "phone.m4a");
const say = () => app.request("/mic", { method: "POST", headers: { "content-type": "audio/mp4" }, body: readFileSync(m4a) });

/** Deepgram and OpenAI as they answer; each request's address and content type are kept. */
function engines() {
  const asked: { url: string; type: string | null }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    asked.push({ url: String(url), type: new Headers(init.headers).get("content-type") });
    if (String(url).includes("deepgram")) {
      const words = [
        { word: "hello", punctuated_word: "Hello,", start: 0.1, end: 0.4 },
        { word: "um", punctuated_word: "um", start: 0.5, end: 0.6 },
        { word: "world", punctuated_word: "world.", start: 0.7, end: 1 },
      ];
      return Response.json({ results: { channels: [{ alternatives: [{ words }] }] } });
    }
    return Response.json({ language: "estonian", segments: [{ start: 0, end: 1, text: " Tere, maailm." }], words: [] });
  });
  return asked;
}

beforeAll(() => {
  execFileSync(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=duration=1", "-ac", "1", "-ar", "16000", "-c:a", "aac", m4a]);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("POST /api/transcribe/mic: talking to the assistant", () => {
  it("a phone's m4a is written down by Deepgram as WAV, in the person's language, ums left out", async () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "dg-test");
    vi.stubEnv("OPENAI_API_KEY", "");
    writeVoicePrefs(LOCAL_USER.username, { languages: ["en"], stt: { per: { mic: null } } });
    const asked = engines();
    const res = await say();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "Hello, um world.", language: "en" });
    expect(asked).toHaveLength(1);
    expect(asked[0].type).toBe("audio/wav");
    expect(asked[0].url).toMatch(/language=en/);
    expect(asked[0].url).not.toMatch(/filler_words/);
  });

  it("the engine chosen for the mic wins over the default", async () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "dg-test");
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    writeVoicePrefs(LOCAL_USER.username, { stt: { per: { mic: { engine: "openai" } } } });
    const asked = engines();
    const res = await say();
    expect(await res.json()).toEqual({ text: "Tere, maailm.", language: "estonian" });
    expect(asked.map((a) => a.url)).toEqual([expect.stringMatching(/\/audio\/transcriptions$/)]);
  });

  it("with no engine it answers what to add, and nothing is sent anywhere", async () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    writeVoicePrefs(LOCAL_USER.username, { stt: { per: { mic: { engine: "deepgram" } } } });
    const asked = engines();
    const res = await say();
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "Needs a Deepgram key", code: "NEEDS_KEY" });
    expect(asked).toEqual([]);
  });
});
