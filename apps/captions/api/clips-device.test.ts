import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  delete process.env.CT_LOCAL;
  delete process.env.CT_MODE;
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
const { ffmpegCommand } = await import("./ffmpeg-runtime");
const { clipsApp } = await import("./clips");

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

  it("on a hosted server nothing changes: no transcript, and the clip never reaches the model", async () => {
    process.env.CT_LOCAL = "1";
    process.env.CT_MODE = "hosted";
    heard.length = 0;
    expect((await process1()).words).toEqual([]);
    expect(heard).toEqual([]);
  });
});
