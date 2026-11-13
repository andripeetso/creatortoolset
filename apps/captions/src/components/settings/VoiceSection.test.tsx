// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { useAuth } from "@/lib/auth";
import { DEFAULT_VOICE_PREFS, isLanguage, type VoiceView } from "@contracts/voice";
import { LANGUAGES, engineOptions, keyFix, languageName } from "@/lib/voice";
import { VoiceBody, VoiceSection } from "./VoiceSection";

const view = (over: Partial<VoiceView> = {}): VoiceView => ({
  ...structuredClone(DEFAULT_VOICE_PREFS),
  resolved: [
    { use: "captions", engine: "deepgram", model: "nova-3" },
    { use: "transcripts", engine: "deepgram", model: "nova-3" },
    { use: "editor", needs: "Needs an OpenAI key", key: "OPENAI_API_KEY" },
    { use: "mic", engine: "deepgram", model: "nova-3" },
  ],
  resolvedDefault: { use: "default", engine: "deepgram", model: "nova-3" },
  available: ["deepgram"],
  availableFor: { captions: ["deepgram"], transcripts: ["deepgram", "local"], editor: ["deepgram"], mic: ["deepgram"] },
  computers: [],
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
    const need = { needs: "Add your Deepgram (or OpenAI) key in Settings → API keys", key: "DEEPGRAM_API_KEY" as const };
    const out = html(view({
      available: [], stt: { default: { engine: "auto" }, per: {} },
      resolved: (["captions", "transcripts", "editor", "mic"] as const).map((use) => ({ use, ...need })),
      resolvedDefault: { use: "default", ...need },
    }));
    expect(out.split("Needs a Deepgram key").length - 1).toBe(1);
    expect(out).toContain('href="/settings/keys#api-key-DEEPGRAM_API_KEY"');
  });
});

describe("a use's own need", () => {
  it("shows on its row when the Default it follows can run", () => {
    const out = html(view({
      stt: { default: { engine: "auto" }, per: {} },
      resolvedDefault: { use: "default", engine: "local", model: "whisper-large-v3-turbo" },
      resolved: [{ use: "captions", needs: "Add your Deepgram (or OpenAI) key in Settings → API keys", key: "DEEPGRAM_API_KEY" }],
    }));
    expect(out).toContain("Needs a Deepgram key");
  });
});

describe("models on your computers", () => {
  it("with none, offers to add a computer; with one, each model can be downloaded, and one it has removed", () => {
    expect(html(view())).toContain('href="/settings/devices"');
    const out = html(view({ computers: [{ id: "d1", name: "Studio PC", online: false, models: [{ id: "whisper-large-v3-turbo", state: "ready" }] }] }));
    expect(out).toContain("Studio PC");
    expect(out).toContain("Off");
    expect(out).toContain(">Remove<");
    expect(out).toContain(">Download<");
    expect(out).toContain("By OpenAI");
  });

  it("a use offers a model on your computers only when it can run there", () => {
    const v = view();
    expect(engineOptions(v.availableFor.transcripts, undefined, false).map((o) => o.value)).toContain("local");
    expect(engineOptions(v.availableFor.editor, undefined, false).map((o) => o.value)).not.toContain("local");
  });
});

describe("read-aloud", () => {
  it("is there even when the voice settings can't load: it is kept in this browser", async () => {
    useAuth.setState({ required: true, me: { username: "sam", role: "admin", cloud: false, off: [] } });
    vi.stubGlobal("Worker", class {});
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "Sign in with an account" }), { status: 403 }));
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => {
      root.render(<MemoryRouter><VoiceSection /></MemoryRouter>);
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(document.body.textContent).toContain("Could not load the voice settings");
    expect(document.body.textContent).toContain("Read the assistant's replies aloud");
    act(() => root.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });
});

describe("the engine choices", () => {
  it("offers only the engines that can serve now, plus the one already chosen", () => {
    expect(engineOptions(view().available, "auto", true).map((o) => o.value)).toEqual(["auto", "deepgram"]);
    expect(engineOptions(view().available, "openai", false).map((o) => o.value)).toEqual(["same", "deepgram", "openai"]);
    expect(engineOptions(view().available, undefined, false).map((o) => o.value)).toEqual(["same", "deepgram"]);
  });

  it("a key need goes to that key's row; a local engine has no key", () => {
    expect(keyFix("DEEPGRAM_API_KEY")).toBe("/settings/keys#api-key-DEEPGRAM_API_KEY");
    expect(keyFix("OPENAI_API_KEY")).toBe("/settings/keys#api-key-OPENAI_API_KEY");
    expect(keyFix(undefined)).toBeNull();
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
