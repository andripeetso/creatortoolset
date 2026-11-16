// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { useAuth } from "@/lib/auth";
import { DEFAULT_VOICE_PREFS, isLanguage, type VoiceView } from "@contracts/voice";
import { LANGUAGES, engineOptions, languageName } from "@/lib/voice";
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
  it("the spoken languages are the person's own: one row each with its Remove, under the row that adds one", () => {
    const none = html(view());
    expect(none).toContain("Spoken languages");
    expect(none).not.toContain(">Remove<");
    const two = html(view({ languages: ["et", "en"] }));
    expect(two).toContain('aria-label="Remove Estonian"');
    expect(two).toContain('aria-label="Remove English"');
    expect(two.split(">Remove<").length - 1).toBe(2);
  });

  it("the Default names its model and what it is good at, nothing else; a use that needs a key says so, with no link off the page", () => {
    const out = html(view());
    expect(out).toContain("Deepgram Nova-3: Most accurate · keeps filler words");
    expect(out).not.toContain("Paid API");
    expect(out).not.toContain("Model page");
    expect(out).toContain("Needs an OpenAI key");
    expect(out).not.toContain("<a ");
  });

  it("with no key at all the need is said once, on the Default, not again on each use that follows it", () => {
    const need = { needs: "Add your Deepgram (or OpenAI) key in Settings → API keys", key: "DEEPGRAM_API_KEY" as const };
    const out = html(view({
      available: [], stt: { default: { engine: "auto" }, per: {} },
      resolved: (["captions", "transcripts", "editor", "mic"] as const).map((use) => ({ use, ...need })),
      resolvedDefault: { use: "default", ...need },
    }));
    expect(out.split("Needs a Deepgram key").length - 1).toBe(1);
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

describe("the AI Editor on your computers", () => {
  it("offered Your computers when one has Parakeet; on Deepgram anyway, its row says why in one line", () => {
    const note = "Runs on Deepgram: your computers are used for edits in English only.";
    const out = html(view({
      stt: { default: { engine: "auto" }, per: { editor: { engine: "local" } } },
      availableFor: { captions: ["deepgram"], transcripts: ["deepgram"], editor: ["deepgram", "local"], mic: ["deepgram"] },
      resolved: [{ use: "editor", engine: "deepgram", model: "nova-3", note }],
    }));
    expect(out).toContain(note);
    expect(out.split(note).length - 1).toBe(1);
    expect(engineOptions(["deepgram", "local"], "local", false).map((o) => o.label)).toContain("Your computers");
  });
});

describe("models on your computers", () => {
  it("with none, says so; with one, each model can be downloaded, and one it has removed; a model's line is what it is good at and its size", () => {
    expect(html(view())).toContain("No computers");
    const out = html(view({ computers: [{ id: "d1", name: "Studio PC", online: false, os: "linux", models: [{ id: "whisper-large-v3-turbo", state: "ready" }] }] }));
    expect(out).toContain("Studio PC");
    expect(out).toContain("Offline");
    expect(out).toContain(">Remove<");
    expect(out).toContain(">Download<");
    expect(out).toContain("Most accurate · every language · 1.6 GB");
    expect(out).not.toContain("By OpenAI");
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
    expect(document.body.textContent).toContain("Read replies aloud");
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

});

describe("the language picker", () => {
  it("every language is a two-letter code with a name", () => {
    for (const c of LANGUAGES) {
      expect(isLanguage(c)).toBe(true);
      expect(languageName(c)).not.toBe(c);
    }
  });
});

describe("dictation and the models on a Mac", () => {
  const dictation = (over: Record<string, unknown> = {}) => ({
    on: true, keys: { talk: "Hold fn", history: "", file: "", cancel: "" }, picking: null, engine: "mac", model: "whisper-base.en", keep: 10, sounds: true, needs: null, paused: null,
    models: [{ id: "whisper-base.en", name: "Whisper Base (English)", size: "145 MB", here: true, removable: true, progress: null }],
    ...over,
  });
  const withMac = (v: VoiceView, d: Record<string, unknown>) =>
    renderToStaticMarkup(<MemoryRouter><VoiceBody view={v} save={() => {}} mac={{ dictation: d } as never} /></MemoryRouter>);

  it("a Mac is offered the Mac's models, a Linux computer the others", () => {
    const out = html(view({ computers: [{ id: "m", name: "Tiny Mac", online: true, os: "mac", version: "0.15.38", models: [] }] }));
    expect(out).toContain("Whisper small (English)");
    expect(out).toContain("Parakeet TDT 0.6B v2");
    // an older Mac app can't run Parakeet: not offered
    const old = html(view({ computers: [{ id: "m", name: "Tiny Mac", online: true, os: "mac", version: "0.15.37", models: [] }] }));
    expect(old).toContain("Whisper small (English)");
    expect(old).not.toContain("Parakeet");
    const pc = html(view({ computers: [{ id: "p", name: "Tiny PC", online: true, os: "linux", models: [] }] }));
    expect(pc).toContain("Parakeet TDT 0.6B v3");
    expect(pc).not.toContain("Parakeet TDT 0.6B v2");
    expect(pc).not.toContain("Whisper small (English)");
  });

  it("on this Mac the engine is chosen; the server's says what it needs and has no model row", () => {
    const mac = withMac(view(), dictation());
    expect(mac).toContain("Dictation engine");
    expect(mac).toContain("Dictation model");
    const need = { use: "mic" as const, needs: "Needs a Deepgram key", key: "DEEPGRAM_API_KEY" as const };
    const server = withMac(view({ resolved: [...view().resolved.filter((r) => r.use !== "mic"), need] }), dictation({ engine: "server" }));
    expect(server).toContain("Needs a Deepgram key");
    expect(server).not.toContain("Dictation model");
  });

  it("while the other dictation app is open, one quiet line says why it is off", () => {
    const out = withMac(view(), dictation({ paused: "Off while your earlier dictation app is open", needs: "Accessibility" }));
    expect(out).toContain("Off while your earlier dictation app is open");
    expect(out).not.toContain("Needs Accessibility");
  });
});
