import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "speech-"));
delete process.env.APP_SECRET; // the solo install: "local" is the admin, served by the server's keys
const { speechFor, speechJob, writeVoicePrefs, readVoicePrefs, resolvedFor, resolvedOne } = await import("./speech");
const { firstAsk } = await import("../transcribe");

afterEach(() => {
  delete process.env.DEEPGRAM_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.CT_LOCAL;
  writeVoicePrefs("local", { languages: [], stt: { default: { engine: "auto" }, per: { captions: null, transcripts: null, editor: null, mic: null } } });
});

describe("which engine turns speech into text", () => {
  it("auto is the first that serves: Deepgram, then OpenAI, then this computer; none says which key to add", () => {
    expect(speechFor("local", "captions")).toEqual({ needs: "Add your Deepgram (or OpenAI) key in Settings → API keys", key: "DEEPGRAM_API_KEY" });
    process.env.OPENAI_API_KEY = "oa";
    expect(speechFor("local", "captions")).toMatchObject({ engine: "openai", model: "whisper-1", key: "oa" });
    process.env.DEEPGRAM_API_KEY = "dg";
    expect(speechFor("local", "captions")).toMatchObject({ engine: "deepgram", model: "nova-3", key: "dg" });
  });

  it("one use can differ from the default, and an engine it can't use says so", () => {
    process.env.DEEPGRAM_API_KEY = "dg";
    process.env.OPENAI_API_KEY = "oa";
    writeVoicePrefs("local", { stt: { per: { mic: { engine: "openai" } } } });
    expect(speechFor("local", "mic")).toMatchObject({ engine: "openai" });
    expect(speechFor("local", "editor")).toMatchObject({ engine: "deepgram" });
    writeVoicePrefs("local", { stt: { default: { engine: "local" } } });
    // the AI Editor on computers hears English edits only: with no language set it stays on Deepgram, and says why
    expect(speechFor("local", "editor")).toMatchObject({ engine: "deepgram", note: "On your computers only edits in English: this runs on Deepgram" });
    expect(speechFor("local", "transcripts")).toEqual({ needs: "Needs a speech model on one of your computers" });
    expect(resolvedFor("local").find((r) => r.use === "mic")).toEqual({ use: "mic", engine: "openai", model: "whisper-1" });
    writeVoicePrefs("local", { stt: { default: { engine: "auto" }, per: { mic: null } } });
    delete process.env.OPENAI_API_KEY;
    writeVoicePrefs("local", { stt: { per: { editor: { engine: "openai" } } } });
    expect(resolvedOne("local", "editor")).toEqual({ use: "editor", needs: "Needs an OpenAI key", key: "OPENAI_API_KEY" });
    expect(resolvedOne("local", "default")).toEqual({ use: "default", engine: "deepgram", model: "nova-3" });
  });

  it("a server on its owner's computer with no computers of theirs: its own model, as before", () => {
    process.env.CT_LOCAL = "1";
    expect(speechFor("local", "transcripts")).toMatchObject({ engine: "local", model: "whisper-base", on: "server" });
    writeVoicePrefs("local", { stt: { default: { engine: "local" } } });
    expect(speechFor("local", "transcripts")).toMatchObject({ engine: "local", model: "whisper-base", on: "server" });
    writeVoicePrefs("local", { stt: { default: { engine: "local", model: "whisper-large-v3" } } });
    expect(speechFor("local", "transcripts")).toEqual({ needs: "Needs Whisper large-v3 on one of your computers" });
  });

  it("a project's languages win over the person's", () => {
    process.env.DEEPGRAM_API_KEY = "dg";
    writeVoicePrefs("local", { languages: ["et", "en"] });
    expect(speechFor("local", "editor")).toMatchObject({ languages: ["et", "en"] });
    expect(speechFor("local", "editor", ["de"])).toMatchObject({ languages: ["de"] });
  });

  it("a job on the person's own computer gets the engine and languages, never the key", () => {
    writeVoicePrefs("local", { languages: ["et"] });
    expect(speechJob("local", "editor")).toEqual({ languages: ["et"] });   // no engine here: the languages still go
    expect(speechJob("local", "editor", ["fi"])).toEqual({ languages: ["fi"] });
    process.env.DEEPGRAM_API_KEY = "dg";
    expect(speechJob("local", "editor")).toEqual({ engine: "deepgram", model: "nova-3", languages: ["et"] });
    expect(speechJob("local", "editor", ["fi"])).toEqual({ engine: "deepgram", model: "nova-3", languages: ["fi"] });
  });

  it("refuses what it can't use, and keeps what was there", () => {
    expect(writeVoicePrefs("local", { languages: ["Estonian"] })).toMatch(/two-letter/);
    expect(writeVoicePrefs("local", { stt: { default: { engine: "parrot" } } })).toMatch(/engine is one of/);
    expect(writeVoicePrefs("local", { stt: { per: { mic: { engine: "deepgram", model: "whisper-1" } } } })).toMatch(/not a deepgram model/);
    expect(writeVoicePrefs("local", { stt: { per: { radio: { engine: "auto" } } } })).toMatch(/not one of/);
    expect(readVoicePrefs("local").languages).toEqual([]);
  });

  it("Deepgram is first asked in the person's language", () => {
    expect(firstAsk([])).toBe("en");
    expect(firstAsk(["et"])).toBe("et");
    expect(firstAsk(["et", "en"])).toBe("en");
    expect(firstAsk(["et", "fi"])).toBe("detect");
  });
});
