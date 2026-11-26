import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "library-transcribe-"));
process.env.DATA_DIR = dir;
delete process.env.APP_SECRET; // the solo install: "local" is the admin, served by the server's key
process.env.DEEPGRAM_API_KEY = "dg-test";
// the speech model is not loaded in a test: this stands in for it, and says which runs reached it
const heard: string[] = [];
vi.mock("../lib/device-transcribe", async (real) => ({
  ...(await real<typeof import("../lib/device-transcribe")>()),
  transcribeOnDevice: async (_file: string, key: string) => {
    heard.push(key);
    return { words: [{ text: "Tere,", start: 0.2, end: 0.5 }, { text: "Tiny", start: 0.6, end: 0.9 }, { text: "Acrobatics.", start: 2.4, end: 3 }], language: "et" };
  },
}));
const { ffmpegCommand } = await import("../ffmpeg-runtime");
const { LOCAL_USER } = await import("../users");
const { transcribeWav } = await import("../transcribe");
const { openLibraryDb } = await import("./db");
const { NeedsKey, saveTranscript, segmentsOf, transcribeRoute, transcribeVersion, wordsOf } = await import("./transcribe");

const wav = path.join(dir, "speech.wav");
const db = openLibraryDb(path.join(dir, "library.db"));
const urls: string[] = [];

beforeAll(() => {
  execFileSync(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=duration=1", "-ac", "1", "-ar", "16000", wav]);
  db.exec(`INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_1', 'ws_1', 'L', 'local', 0);
    INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('ast_1', 'lib_1', 'video', 'Take', 'local', 0);
    INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at)
      VALUES ('ver_1', 'ast_1', 1, 'k', 1, 'x', 'ready', 'local', 0);`);
  vi.stubGlobal("fetch", async (url: string) => {
    urls.push(String(url));
    const words = [
      { word: "so", punctuated_word: "So", start: 0.1, end: 0.3, confidence: 0.9 },
      { word: "um", punctuated_word: "um", start: 0.35, end: 0.5, confidence: 0.8 },
      { word: "so", punctuated_word: "so", start: 0.6, end: 0.8, confidence: 0.95 },
    ];
    return Response.json({ results: { channels: [{ alternatives: [{ words }] }], utterances: [{ start: 0, end: 1 }] } });
  });
});
afterEach(() => {
  urls.length = 0;
  heard.length = 0;
  process.env.DEEPGRAM_API_KEY = "dg-test";
  delete process.env.CT_LOCAL;
  delete process.env.CT_MODE;
});
afterAll(() => {
  vi.unstubAllGlobals();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("library transcripts with words", () => {
  it("Caption Studio's request is unchanged: no filler words unless asked", async () => {
    await transcribeWav(new Uint8Array(100), LOCAL_USER);
    await transcribeWav(new Uint8Array(100), LOCAL_USER, { fillers: true });
    expect(urls[0]).not.toMatch(/filler_words/);
    expect(urls[1]).toMatch(/&filler_words=true/);
  });

  it("the library's transcribe asks for fillers and keeps every word with its timing", async () => {
    await transcribeVersion(db, "ver_1", wav, "local", dir);
    expect(urls[0]).toMatch(/&filler_words=true/);
    expect(wordsOf(db, "ver_1")).toEqual([
      { w: "So", s: 0.1, e: 0.3, c: 0.9 },
      { w: "um", s: 0.35, e: 0.5, c: 0.8 },
      { w: "so", s: 0.6, e: 0.8, c: 0.95 },
    ]);
    expect(segmentsOf(db, "ver_1")).toEqual([{ start: 0.1, end: 0.8, text: "So um so" }]);
  });

  it("a key goes first; with none, only a server on its owner's computer transcribes by itself", () => {
    process.env.CT_LOCAL = "1";
    expect(transcribeRoute("local")).toEqual({ provider: "deepgram", key: "dg-test" });
    delete process.env.DEEPGRAM_API_KEY;
    expect(transcribeRoute("local")).toEqual({ provider: "device" });
    process.env.CT_MODE = "hosted";
    expect(() => transcribeRoute("local")).toThrow(NeedsKey);
    delete process.env.CT_MODE;
    delete process.env.CT_LOCAL;
    expect(() => transcribeRoute("local")).toThrow(NeedsKey);
  });

  it("with no key on the person's own computer, the transcript is made there: words with their times, the language heard", async () => {
    delete process.env.DEEPGRAM_API_KEY;
    process.env.CT_LOCAL = "1";
    await transcribeVersion(db, "ver_1", wav, "local", dir);
    expect(urls).toEqual([]); // nothing left this computer
    expect(heard).toEqual(["ver_1"]);
    expect(wordsOf(db, "ver_1")).toEqual([
      { w: "Tere,", s: 0.2, e: 0.5 },
      { w: "Tiny", s: 0.6, e: 0.9 },
      { w: "Acrobatics.", s: 2.4, e: 3 },
    ]);
    expect(segmentsOf(db, "ver_1")).toEqual([
      { start: 0.2, end: 0.9, text: "Tere, Tiny" },
      { start: 2.4, end: 3, text: "Acrobatics." },
    ]);
    expect(db.prepare("SELECT provider, language FROM transcripts WHERE version_id = 'ver_1'").get()).toEqual({ provider: "device", language: "et" });
  });

  it("with a key, the on-device model is never reached", async () => {
    process.env.CT_LOCAL = "1";
    await transcribeVersion(db, "ver_1", wav, "local", dir);
    expect(heard).toEqual([]);
    expect(urls).toHaveLength(1);
  });

  it("a transcript saved without words reads back as null words", () => {
    saveTranscript(db, "ver_1", "openai", "en", [{ start: 0, end: 1, text: "hi" }]);
    expect(wordsOf(db, "ver_1")).toBeNull();
    expect(wordsOf(db, "ver_none")).toBeNull();
  });
});
