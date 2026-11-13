import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { DEFAULT_VOICE_PREFS, isLanguage, type VoiceView } from "@contracts/voice";
import { LANGUAGES, engineOptions, keyFix, languageName } from "@/lib/voice";
import { VoiceBody } from "./VoiceSection";

const view = (over: Partial<VoiceView> = {}): VoiceView => ({
  ...structuredClone(DEFAULT_VOICE_PREFS),
  resolved: [
    { use: "captions", engine: "deepgram", model: "nova-3" },
    { use: "transcripts", engine: "deepgram", model: "nova-3" },
    { use: "editor", needs: "Needs an OpenAI key" },
    { use: "mic", engine: "deepgram", model: "nova-3" },
  ],
  available: ["deepgram"],
  stt: { default: { engine: "auto" }, per: { editor: { engine: "openai" } } },
  ...over,
});
const html = (v: VoiceView) => renderToStaticMarkup(<MemoryRouter><VoiceBody view={v} save={() => {}} /></MemoryRouter>);

describe("the Voice page", () => {
  it("with no languages says it detects them; with some, each is a chip by name", () => {
    expect(html(view())).toContain("Detect it");
    const two = html(view({ languages: ["et", "en"] }));
    expect(two).not.toContain("Detect it");
    expect(two).toContain('aria-label="Remove Estonian"');
    expect(two).toContain('aria-label="Remove English"');
  });

  it("the Default names its model, licence and page; a use that needs a key says so with the button to it", () => {
    const out = html(view());
    expect(out).toContain("Deepgram Nova-3");
    expect(out).toContain("Paid API, your own key");
    expect(out).toContain('href="https://developers.deepgram.com/docs/models-languages-overview"');
    expect(out).toContain("Needs an OpenAI key");
    expect(out).toContain('href="/settings/keys#api-key-OPENAI_API_KEY"');
  });

  it("with no key at all the need is said once, on the Default, not again on each use that follows it", () => {
    const need = "Add your Deepgram (or OpenAI) key in Settings → API keys";
    const out = html(view({ available: [], stt: { default: { engine: "auto" }, per: {} }, resolved: (["captions", "transcripts", "editor", "mic"] as const).map((use) => ({ use, needs: need })) }));
    expect(out.split(need).length - 1).toBe(1);
    expect(out).toContain('href="/settings/keys#api-key-DEEPGRAM_API_KEY"');
  });
});

describe("the engine choices", () => {
  it("offers only the engines that can serve now, plus the one already chosen", () => {
    expect(engineOptions(view(), "auto", true).map((o) => o.value)).toEqual(["auto", "deepgram"]);
    expect(engineOptions(view(), "openai", false).map((o) => o.value)).toEqual(["same", "deepgram", "openai"]);
    expect(engineOptions(view(), undefined, false).map((o) => o.value)).toEqual(["same", "deepgram"]);
  });

  it("a key need goes to that key's row; a local engine has no key", () => {
    expect(keyFix("auto")).toBe("/settings/keys#api-key-DEEPGRAM_API_KEY");
    expect(keyFix("openai")).toBe("/settings/keys#api-key-OPENAI_API_KEY");
    expect(keyFix("local")).toBeNull();
  });
});

describe("the language picker", () => {
  it("every language is a two-letter code with a name", () => {
    for (const c of LANGUAGES) {
      expect(isLanguage(c)).toBe(true);
      expect(languageName(c)).not.toBe(c);
    }
  });
});
