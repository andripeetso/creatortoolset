import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "transcribe-language-"));
delete process.env.APP_SECRET;
process.env.DEEPGRAM_API_KEY = "dg-test";
const { LOCAL_USER } = await import("./users");
const { transcribeWav, wavWrap } = await import("./transcribe");

/** Deepgram as it answered his clips: English hears `en` words, detection hears `other` in `language`. */
function deepgram(en: number, other: number, language: string) {
  const urls: string[] = [];
  const words = (n: number, w: string) => Array.from({ length: n }, (_, i) => ({ word: w, punctuated_word: w, start: i * 0.3, end: i * 0.3 + 0.2 }));
  vi.stubGlobal("fetch", async (url: string) => {
    urls.push(String(url));
    const detect = String(url).includes("detect_language=true");
    return Response.json({
      results: { channels: [{ alternatives: [{ words: detect ? words(other, "tere") : words(en, "hi") }], ...(detect ? { detected_language: language } : {}) }] },
    });
  });
  return urls;
}

const seconds = (s: number) => wavWrap(new Uint8Array(s * 32000), 16000);

afterEach(() => vi.unstubAllGlobals());
afterAll(() => vi.unstubAllGlobals());

describe("Deepgram hears languages other than English", () => {
  it("English speech is asked once, in English", async () => {
    const urls = deepgram(40, 0, "es");
    const r = await transcribeWav(seconds(20), LOCAL_USER, { fillers: true });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/language=en/);
    expect(r).toMatchObject({ language: "en" });
  });

  it("Estonian, which English hears no words of, comes from the detected language", async () => {
    const urls = deepgram(0, 37, "et");
    const r = await transcribeWav(seconds(13), LOCAL_USER, { fillers: true });
    expect(urls[1]).toMatch(/detect_language=true/);
    expect(urls[1]).toMatch(/filler_words=true/);
    expect(urls[1]).not.toMatch(/language=en/);
    expect(r).toMatchObject({ language: "et" });
    expect("words" in r && r.words).toHaveLength(37);
  });

  it("a quiet English clip stays English when detection hears less", async () => {
    deepgram(2, 0, "es");
    const r = await transcribeWav(seconds(30), LOCAL_USER);
    expect(r).toMatchObject({ language: "en" });
    expect("words" in r && r.words.map((w) => w.text)).toEqual(["hi", "hi"]);
  });
});
