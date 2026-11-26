import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "transcribe-live-"));
process.env.DATA_DIR = dir;
delete process.env.APP_SECRET;
delete process.env.CT_LOCAL;

vi.mock("./lib/speech", () => ({ speechFor: vi.fn() }));
vi.mock("./library/transcribe", () => ({ transcribeFile: vi.fn() }));

const { speechFor } = await import("./lib/speech");
const { transcribeFile } = await import("./library/transcribe");
const { LOCAL_USER } = await import("./users");
const { transcribeLiveApp } = await import("./transcribe-live");
type AuthVars = import("./auth").AuthVars;

const app = new Hono<{ Variables: AuthVars }>();
// the account gate is in boot.ts; here the signed-in user is set the way the gate leaves it
app.use("*", async (c, next) => (c.set("user", LOCAL_USER), next()));
app.route("/", transcribeLiveApp);

const live = (body: Uint8Array | null = new Uint8Array([1, 2, 3])) =>
  app.request("/", { method: "POST", headers: { "content-type": "audio/webm" }, body });

beforeEach(() => {
  vi.mocked(speechFor).mockReset();
  vi.mocked(transcribeFile).mockReset();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("POST /api/transcribe/live: words while the person talks", () => {
  it("answers SPEECH with the line and a reason when no engine serves the mic", async () => {
    vi.mocked(speechFor).mockReturnValue({ needs: "Add your Deepgram (or OpenAI) key in Settings → API keys", key: "DEEPGRAM_API_KEY" });
    const res = await live();
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "SPEECH", reason: "missing-key", error: expect.stringContaining("Settings → API keys") });
    expect(transcribeFile).not.toHaveBeenCalled();
  });

  it("never sends interim audio to a paid engine", async () => {
    vi.mocked(speechFor).mockReturnValue({ engine: "deepgram", model: "nova-3", key: "k", languages: [] });
    const res = await live();
    expect(await res.json()).toEqual({ text: "", interim: true, skipped: true });
    expect(transcribeFile).not.toHaveBeenCalled();
  });

  it("writes the audio so far with the mic's short limits, through speechFor's engine", async () => {
    vi.mocked(speechFor).mockReturnValue({ engine: "local", model: "whisper-base", on: "server", languages: [] });
    vi.mocked(transcribeFile).mockResolvedValue({ segments: [{ start: 0, end: 1, text: " Hello " }, { start: 1, end: 2, text: "there." }], words: [], language: "en", provider: "device" } as never);
    const res = await live();
    expect(speechFor).toHaveBeenCalledWith(LOCAL_USER, "mic");
    expect(transcribeFile).toHaveBeenCalledWith(expect.stringContaining("live-"), LOCAL_USER.username, expect.any(String), expect.any(String), { use: "mic", fillers: false, soon: true });
    expect(await res.json()).toEqual({ text: "Hello there.", interim: true });
  });

  it("an interim pass that fails says no words, not an error", async () => {
    vi.mocked(speechFor).mockReturnValue({ engine: "local", model: "whisper-base", on: "computers", languages: [] });
    vi.mocked(transcribeFile).mockRejectedValue(new Error("computer busy"));
    const res = await live();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "", interim: true });
  });

  it("refuses an empty body and a recording over the live limit", async () => {
    vi.mocked(speechFor).mockReturnValue({ engine: "local", model: "whisper-base", on: "server", languages: [] });
    expect((await live(new Uint8Array())).status).toBe(400);
    const big = await app.request("/", { method: "POST", headers: { "content-type": "audio/webm", "content-length": String(5 * 1024 * 1024) }, body: new Uint8Array([1]) });
    expect(big.status).toBe(413);
    expect(transcribeFile).not.toHaveBeenCalled();
  });
});
