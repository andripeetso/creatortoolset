import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TRANSCRIBE_KIND } from "../../contracts/devices";

/**
 * The app's own AI Editor reads the AI Editor row of Settings → AI → Voice: an edit's clip is transcribed where that
 * row says (library/transcribe.ts editorRoute), never on another account's computers, Parakeet on computers only for
 * English, and what a computer can't do is made on the library's engine.
 */
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "editor-row-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-row-secret";
delete process.env.DEEPGRAM_API_KEY;
delete process.env.OPENAI_API_KEY;
vi.mock("../plugins.gen", () => ({ serverPlugins: [] }));

const { ffmpegCommand } = await import("../ffmpeg-runtime");
const { createUser } = await import("../users");
const app = (await import("../boot")).default;
const { pairDevice } = await import("../lib/devices");
const { writeVoicePrefs } = await import("../lib/speech");
const { saveMyKey } = await import("../my-keys");
const { libraryDb } = await import("./db");
const { askVersionIn, editorRoute, heardForEditor, saveTranscript, transcribeRoute, transcribeVersion, versionRoute } = await import("./transcribe");

const PARAKEET = "parakeet-tdt-0.6b-v3";
const TURBO = "whisper-large-v3-turbo";
const wav = path.join(dir, "speech.wav");
const urls: string[] = [];
const json = (body: unknown, token: string) => ({ method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
const claim = async (token: string, models: string[]) =>
  (await (await app.request("/api/devices/relay/editor/claim", json({ kinds: [TRANSCRIBE_KIND], models }, token))).json()) as { job: { id: number; model: string; languages: string[] } | null };
const saved = (v: string) => libraryDb().prepare("SELECT provider, model, language FROM transcripts WHERE version_id = ?").get(v) as Record<string, unknown> | undefined;

createUser("abe", "password1");
createUser("bea", "password1");
const abePc = pairDevice("abe", "Abe's PC");
const beaPc = pairDevice("bea", "Bea's PC");

beforeAll(async () => {
  execFileSync(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=duration=1", "-ac", "1", "-ar", "16000", wav]);
  libraryDb().exec(`INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_r', 'ws_r', 'R', 'local', 0);
    INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('ast_r', 'lib_r', 'video', 'Take', 'abe', 0);
    INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at)
      VALUES ('ver_r', 'ast_r', 1, 'k', 1, 'x', 'ready', 'abe', 0);`);
  vi.stubGlobal("fetch", async (url: string) => {
    urls.push(String(url));
    if (String(url).includes("/audio/transcriptions"))
      return Response.json({ language: "english", segments: [{ start: 0, end: 0.5, text: "Hi" }], words: [{ word: "Hi", start: 0, end: 0.5 }] });
    return Response.json({ results: { channels: [{ alternatives: [{ words: [{ word: "um", punctuated_word: "Um", start: 0, end: 0.3 }] }] }], utterances: [{ start: 0, end: 1 }] } });
  });
  // both computers report and claim: they are on; only Bea's, the stronger, has Parakeet so far
  for (const [d, gpu] of [[abePc, 0], [beaPc, 48]] as const)
    await app.request("/api/devices/relay/report", json({ drivers: [], homes: [], machine: { os: "linux", cpus: 8, memGb: 16, freeGb: 20, gpuMemGb: gpu } }, d.token));
  await claim(abePc.token, [TURBO]);
  await claim(beaPc.token, [PARAKEET, TURBO]);
});
afterEach(() => {
  urls.length = 0;
  askVersionIn.clear();
  heardForEditor.clear();
  for (const who of ["abe", "bea"]) writeVoicePrefs(who, { languages: [], stt: { default: { engine: "auto" }, per: { editor: null, transcripts: null } } });
});

describe("the AI Editor row reaches an edit's transcripts", () => {
  it("the row's own Deepgram or OpenAI choice is the engine an edit's clip is transcribed by, fillers kept", async () => {
    saveMyKey("abe", "DEEPGRAM_API_KEY", "dg-abe");
    saveMyKey("abe", "OPENAI_API_KEY", "sk-abe");
    writeVoicePrefs("abe", { stt: { per: { editor: { engine: "openai" } } } });
    askVersionIn.set("ver_r", { by: "abe", languages: ["en"] });
    await transcribeVersion(libraryDb(), "ver_r", wav, "abe", dir);
    expect(urls).toEqual([expect.stringContaining("/audio/transcriptions")]);
    expect(saved("ver_r")).toMatchObject({ provider: "openai", model: null });
    expect(askVersionIn.has("ver_r")).toBe(false); // cleared once made
    // the Default on OpenAI, the row on Deepgram: Deepgram, with filler words
    urls.length = 0;
    writeVoicePrefs("abe", { stt: { default: { engine: "openai" }, per: { editor: { engine: "deepgram" } } } });
    askVersionIn.set("ver_r", { by: "abe" });
    await transcribeVersion(libraryDb(), "ver_r", wav, "abe", dir);
    expect(urls).toEqual([expect.stringMatching(/deepgram.*filler_words=true/)]);
    expect(saved("ver_r")).toMatchObject({ provider: "deepgram" });
  });

  it("the editor's default is untouched: Automatic, the Default on computers and no row of its own leave the library's engine", () => {
    saveMyKey("abe", "OPENAI_API_KEY", "sk-abe");
    writeVoicePrefs("abe", { stt: { default: { engine: "openai" } } });
    askVersionIn.set("ver_r", { by: "abe", languages: ["en"] });
    expect(editorRoute("abe", ["en"])).toBeNull();
    expect(versionRoute("abe", "ver_r")).toEqual({ provider: "openai", key: "sk-abe" });
    writeVoicePrefs("abe", { stt: { per: { editor: { engine: "auto" } } } });
    expect(editorRoute("abe", ["en"])).toBeNull();
    // the Default on the person's computers: their library transcripts stay there, the editor row does not move them
    writeVoicePrefs("abe", { stt: { default: { engine: "local", model: TURBO }, per: { editor: null } } });
    expect(editorRoute("abe", ["en"])).toBeNull();
    expect(versionRoute("abe", "ver_r")).toEqual(transcribeRoute("abe"));
    expect(versionRoute("abe", "ver_r")).toMatchObject({ provider: "computer", model: TURBO });
  });

  it("on computers only Parakeet, and only for an edit in English alone; anything else stays on the library's engine", async () => {
    saveMyKey("abe", "DEEPGRAM_API_KEY", "dg-abe");
    await claim(abePc.token, [PARAKEET, TURBO]);
    writeVoicePrefs("abe", { languages: ["en"], stt: { per: { editor: { engine: "local" } } } });
    expect(editorRoute("abe", ["en"])).toEqual({ provider: "computer", model: PARAKEET, languages: ["en"] });
    expect(editorRoute("abe", ["et"])).toBeNull();
    expect(editorRoute("abe", ["en", "et"])).toBeNull();
    askVersionIn.set("ver_r", { by: "abe", languages: ["et"] });
    expect(versionRoute("abe", "ver_r")).toEqual({ provider: "deepgram", key: "dg-abe" });
    // Whisper picked on the editor row: never on computers for the editor
    writeVoicePrefs("abe", { stt: { per: { editor: { engine: "local", model: TURBO } } } });
    expect(editorRoute("abe", ["en"])).toBeNull();
    await claim(abePc.token, [TURBO]);
  });
});

describe("an edit's transcript goes only to its owner's computers", () => {
  it("an edit by Abe never reaches Bea's computer: Abe's own Parakeet hears it, and a job of Abe's for Bea's edit takes the library's way", async () => {
    saveMyKey("abe", "DEEPGRAM_API_KEY", "dg-abe");
    saveMyKey("bea", "DEEPGRAM_API_KEY", "dg-bea");
    for (const who of ["abe", "bea"]) writeVoicePrefs(who, { languages: ["en"], stt: { per: { editor: { engine: "local" } } } });
    // only Bea's computer has Parakeet: Abe's edit goes to no computer
    expect(editorRoute("abe", ["en"])).toBeNull();
    askVersionIn.set("ver_r", { by: "abe", languages: ["en"] });
    await transcribeVersion(libraryDb(), "ver_r", wav, "abe", dir);
    expect(saved("ver_r")).toMatchObject({ provider: "deepgram" });
    expect((await claim(beaPc.token, [PARAKEET, TURBO])).job).toBeNull();
    // an ask from Bea's edit on a job Abe runs: Abe's own library engine, never Bea's computer
    askVersionIn.set("ver_r", { by: "bea", languages: ["en"] });
    expect(versionRoute("abe", "ver_r")).toEqual({ provider: "deepgram", key: "dg-abe" });
    // Abe's computer gets Parakeet: his edit waits for it there; Bea's stronger computer is never handed it
    await claim(abePc.token, [PARAKEET, TURBO]);
    askVersionIn.set("ver_r", { by: "abe", languages: ["en"] });
    urls.length = 0;
    const made = transcribeVersion(libraryDb(), "ver_r", wav, "abe", dir);
    const got = await vi.waitFor(async () => {
      expect((await claim(beaPc.token, [PARAKEET, TURBO])).job).toBeNull();
      const j = (await claim(abePc.token, [PARAKEET, TURBO])).job;
      expect(j).not.toBeNull();
      return j!;
    });
    expect(got).toMatchObject({ model: PARAKEET, languages: ["en"] });
    const id = got.id;
    expect((await app.request(`/api/devices/relay/transcribe/${id}`, { headers: { authorization: `Bearer ${beaPc.token}` } })).status).toBe(404);
    const um = { words: [{ text: "Uh,", start: 0, end: 0.3 }, { text: "hi", start: 0.4, end: 0.6 }], language: "en" };
    expect((await app.request(`/api/devices/relay/transcribe/${id}`, json(um, beaPc.token))).status).toBe(404);
    expect((await app.request(`/api/devices/relay/transcribe/${id}`, json(um, abePc.token))).status).toBe(200);
    await made;
    expect(urls).toEqual([]);
    expect(saved("ver_r")).toEqual({ provider: "computer", model: PARAKEET, language: "en" });
    await claim(abePc.token, [TURBO]);
  });

  it("what Abe's computer can't do is made on the library's engine, and the transcript is made all the same", async () => {
    // a clip with no transcript yet: the library's engine makes it (one that has one keeps it: the next test)
    libraryDb().prepare("DELETE FROM transcripts WHERE version_id = 'ver_r'").run();
    saveMyKey("abe", "DEEPGRAM_API_KEY", "dg-abe");
    writeVoicePrefs("abe", { languages: ["en"], stt: { per: { editor: { engine: "local" } } } });
    await claim(abePc.token, [PARAKEET, TURBO]);
    askVersionIn.set("ver_r", { by: "abe", languages: ["en"] });
    const made = transcribeVersion(libraryDb(), "ver_r", wav, "abe", dir);
    const id = await vi.waitFor(async () => {
      const j = (await claim(abePc.token, [PARAKEET, TURBO])).job;
      expect(j).not.toBeNull();
      return j!.id;
    });
    await app.request(`/api/devices/relay/transcribe/${id}/fail`, json({ error: "Out of memory" }, abePc.token));
    await made;
    expect(urls).toEqual([expect.stringMatching(/deepgram.*filler_words=true/)]);
    expect(saved("ver_r")).toMatchObject({ provider: "deepgram", model: null });
    // tried once for the editor: analyze does not ask for it again
    expect(heardForEditor.has(`ver_r|computer:${PARAKEET}`)).toBe(true);
    await claim(abePc.token, [TURBO]);
  });

  it("a clip that has a transcript keeps it when Abe's computers can't hear it again: nothing is bought twice", async () => {
    saveMyKey("abe", "DEEPGRAM_API_KEY", "dg-abe");
    // the clip's library transcript, made by Deepgram
    askVersionIn.clear();
    await transcribeVersion(libraryDb(), "ver_r", wav, "abe", dir);
    expect(saved("ver_r")).toMatchObject({ provider: "deepgram" });
    urls.length = 0;
    // the editor row moves to Parakeet on Abe's computers, which has it, and that computer is off
    writeVoicePrefs("abe", { languages: ["en"], stt: { per: { editor: { engine: "local" } } } });
    await claim(abePc.token, [PARAKEET, TURBO]);
    askVersionIn.set("ver_r", { by: "abe", languages: ["en"] });
    const now = Date.now();
    const later = vi.spyOn(Date, "now").mockReturnValue(now + 10 * 60_000);
    try {
      await transcribeVersion(libraryDb(), "ver_r", wav, "abe", dir);
    } finally {
      later.mockRestore();
    }
    expect(urls).toEqual([]);
    expect(saved("ver_r")).toMatchObject({ provider: "deepgram" });
    expect(heardForEditor.has(`ver_r|computer:${PARAKEET}`)).toBe(true);
    await claim(abePc.token, [TURBO]);
  });

  it("a clip heard as silence (no words) is not kept: with the computers off the library's engine hears it again", async () => {
    saveMyKey("abe", "DEEPGRAM_API_KEY", "dg-abe");
    saveTranscript(libraryDb(), "ver_r", "deepgram", "en", [], []);
    writeVoicePrefs("abe", { languages: ["en"], stt: { per: { editor: { engine: "local" } } } });
    await claim(abePc.token, [PARAKEET, TURBO]);
    askVersionIn.set("ver_r", { by: "abe", languages: ["en"] });
    const now = Date.now();
    const later = vi.spyOn(Date, "now").mockReturnValue(now + 10 * 60_000);
    try {
      await transcribeVersion(libraryDb(), "ver_r", wav, "abe", dir);
    } finally {
      later.mockRestore();
    }
    expect(urls).toEqual([expect.stringMatching(/deepgram.*filler_words=true/)]);
    expect(saved("ver_r")).toMatchObject({ provider: "deepgram" });
    await claim(abePc.token, [TURBO]);
  });
});
