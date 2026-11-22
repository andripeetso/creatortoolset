import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "./auth";

const dataDir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "clips-device-"));
process.env.DATA_DIR = dataDir;
delete process.env.DEEPGRAM_API_KEY;
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));
afterEach(() => {
  ai = false;
  delete process.env.CT_LOCAL;
  delete process.env.CT_MODE;
  delete process.env.CT_SERVER;
});

// the speech model is not loaded in a test: this stands in for it, and says which clips reached it
const heard: string[] = [];
vi.mock("./lib/device-transcribe", async (real) => ({
  ...(await real<typeof import("./lib/device-transcribe")>()),
  transcribeOnDevice: async (_file: string, key: string) => {
    heard.push(key);
    return { words: [{ text: "Tiny", start: 0.1, end: 0.4 }, { text: "Acrobatics.", start: 0.4, end: 1 }], language: "en" };
  },
}));
// no AI is set up in a test: switched on, this stands in for it, keeps what each call was sent and answers every parser
let ai = false;
const sent: { system: string; user: string }[] = [];
vi.mock("./ai-complete", async (real) => {
  const actual = await real<typeof import("./ai-complete")>();
  return {
    ...actual,
    anyAiConfigured: (...a: Parameters<typeof actual.anyAiConfigured>) => ai || actual.anyAiConfigured(...a),
    completeWithFallback: (async (system: string, user: string, signal: AbortSignal | undefined, parse: (t: string) => unknown, opts?: object) => {
      if (!ai) return actual.completeWithFallback(system, user, signal, parse, opts);
      sent.push({ system, user });
      return parse('{"drop":[],"fixes":[],"title":"Walk","summary":"A walk.","chapters":[{"t":0,"title":"Start"}],"items":[{"text":"One point"}]}');
    }) as typeof actual.completeWithFallback,
  };
});
const { ffmpegCommand } = await import("./ffmpeg-runtime");
const { clipsApp } = await import("./clips");
await import("./work/task-kinds");

const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "ana", role: "user", cloud: true, off: [] });
  await next();
});
app.route("/api/clips", clipsApp);

const recording = path.join(dataDir, "walk.wav");
execFileSync(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=duration=1", "-ac", "1", "-ar", "16000", recording]);

/** Uploads the recording and waits until Video Notes is done with it: its id and its transcript's words. */
async function process1(): Promise<{ id: string; words: unknown[] }> {
  const { id } = (await (await app.request("/api/clips?name=Walk&mime=audio/wav", { method: "POST", body: readFileSync(recording) })).json()) as { id: string };
  await vi.waitFor(async () => expect(((await (await app.request(`/api/clips/${id}`)).json()) as { status: string }).status).toBe("ready"), { timeout: 20_000, interval: 100 });
  return { id, words: ((await (await app.request(`/api/clips/${id}/transcript`)).json()) as { words: unknown[] }).words };
}

describe("Video Notes with no transcription key", () => {
  it("on the person's own computer the clip is transcribed there, words with their times", async () => {
    process.env.CT_LOCAL = "1";
    const { id, words } = await process1();
    expect(heard).toEqual([id]);
    expect(words).toEqual([{ text: "Tiny", start: 0.1, end: 0.4 }, { text: "Acrobatics.", start: 0.4, end: 1 }]);
  });

  it("on Cloud it waits for one of the person's computers, and the clip never reaches the model", async () => {
    process.env.CT_LOCAL = "1";
    process.env.CT_SERVER = "cloud";
    heard.length = 0;
    const { id } = (await (await app.request("/api/clips?name=Walk&mime=audio/wav", { method: "POST", body: readFileSync(recording) })).json()) as { id: string };
    await vi.waitFor(async () => expect(((await (await app.request(`/api/clips/${id}`)).json()) as { note?: string }).note).toMatch(/^Waits for one of your computers/), { timeout: 5000, interval: 50 });
    expect(heard).toEqual([]);
  });
});

describe("what Video Notes writes about a recording", () => {
  const titled = () => sent.find((s) => s.system.startsWith("You title"))!.user;
  const PLAIN = "Duration: 1s\nTranscript:\n";

  it("carries the workspace the recording is in, so its names are used; the word-for-word transcript fix does not", async () => {
    process.env.CT_LOCAL = "1";
    ai = true;
    // no workspace: each call reads what it always did
    await process1();
    expect(titled().startsWith(PLAIN)).toBe(true);

    mkdirSync(path.join(dataDir, "workshop", "projects"), { recursive: true });
    const ember = { id: "p-ember", owner: "ana", name: "Ember Realm", audience: "", voice: "", cta: "", notes: "A free online fantasy RPG server.", createdAt: 1, updatedAt: 1 };
    writeFileSync(path.join(dataDir, "workshop", "projects", "p-ember.json"), JSON.stringify(ember));
    sent.length = 0;
    const { id } = await process1();
    expect(titled()).toMatch(/^The workspace this recording belongs to\.[^\n]*\nWorkspace: Ember Realm[\s\S]*A free online fantasy RPG server\.\n\nDuration: 1s\nTranscript:\n/);
    // the pass that only corrects misheard words adds nothing of its own, so it is told nothing more
    expect(sent.find((s) => s.system.startsWith("You correct"))!.user).not.toContain("Ember Realm");

    // a section added afterwards reads the same material
    const material = titled();
    sent.length = 0;
    await app.request(`/api/clips/${id}/blocks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "takeaways" }) });
    await vi.waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0]!.user).toBe(material);
  });
});
