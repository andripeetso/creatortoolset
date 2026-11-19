// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProvidersView } from "@contracts/providers";
import { LIBRARY_WORDS } from "@contracts/library";
import { modelName } from "@/lib/providers";
import { Models } from "./Models";

// The owner's Models rows (Rulings 11-19): each row opens its options as a radio list, and picking one writes its own store.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  providers: null as unknown,
  voice: null as unknown,
  keys: [] as unknown[],
  saveOwn: vi.fn(async (s: unknown) => ({ own: s })),
  setProviders: vi.fn(),
  putVoice: vi.fn(async () => ({})),
  putModel: vi.fn(async () => ({})),
  setVoice: vi.fn(),
  save: vi.fn(async () => {}),
}));
vi.mock("@/lib/providers", async (orig) => ({
  ...(await orig<typeof import("@/lib/providers")>()),
  useProviders: () => ({ data: h.providers, set: h.setProviders }),
  saveOwn: h.saveOwn,
}));
vi.mock("@/lib/voice", async (orig) => ({
  ...(await orig<typeof import("@/lib/voice")>()),
  useVoice: () => ({ data: h.voice, set: h.setVoice }),
  putVoice: h.putVoice,
  putModel: h.putModel,
}));
vi.mock("@/components/settings/MyKeysSection", () => ({ useMyKeys: () => ({ data: h.keys }) }));

const providers = {
  workspace: null,
  own: {
    instances: [
      { id: "gem", driver: "gemini", name: "Gemini", enabled: true, model: "gemini-3.8-flash" },
      { id: "cl", driver: "claude", name: "Claude", enabled: true, model: "claude-opus-5" },
    ],
    default: { instance: "gem", model: "gemini-3.8-flash", effort: "high" },
    jobs: {},
  },
  using: "own",
  devices: [],
  checks: {},
  models: {},
  usage: [],
  limits: [],
} as unknown as ProvidersView;

const voice = {
  stt: { default: { engine: "auto" }, per: {} },
  resolvedDefault: { use: "default", engine: "local", model: "whisper-base" },
  available: ["local"],
  computers: [],
};

const GEMINI_KEY = [{ env: "GEMINI_API_KEY", name: "Gemini API", set: false, server: false }];

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  h.keys = [];
  h.saveOwn.mockClear();
  h.putVoice.mockClear();
  h.save.mockClear();
});

function mount(settings: Record<string, unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<MemoryRouter><Models settings={settings as never} save={h.save} /></MemoryRouter>));
  return host;
}
const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error("missing control");
  act(() => (el as HTMLElement).click());
  await act(async () => new Promise<void>((done) => setTimeout(done, 0)));
};
const open = (label: string) => click(document.querySelector(`button[aria-label="${label}"]`));
const radio = (label: string) => document.querySelector<HTMLInputElement>(`input[type="radio"][aria-label="${label}"]`);

const full = { timeline: true, timelineModel: "gemini-3.8-flash", transcribe: true, describe: true, embed: true, pictures: true, look: false };

// replaced (UNIFIED-PRD Rulings 11-19): Models rows open their options as a radio list and write their own store; the Video breakdown picker is a row, not a button list.
describe("the owner's Models rows", () => {
  it("show the model in use for Descriptions and Transcripts, with no Change button", () => {
    h.providers = providers;
    h.voice = voice;
    const el = mount({ timeline: false, transcribe: true, describe: true });
    expect(el.textContent).toContain(modelName("gemini-3.8-flash"));
    expect(el.textContent).toContain("Whisper base");
    expect(el.textContent).not.toContain("Change");
  });

  it("show Not set until the AI and Voice pages have answered", () => {
    h.providers = null;
    h.voice = null;
    const el = mount({ timeline: false, transcribe: true, describe: true });
    expect(el.textContent).toContain("Not set");
    expect(el.textContent).not.toContain("Change");
  });

  it("hides Descriptions and Transcripts at Analysis Off, and Video breakdown below High", () => {
    h.providers = providers;
    h.voice = voice;
    const off = mount({ timeline: false, transcribe: false, describe: false, embed: false, pictures: false, look: false });
    expect(off.textContent).not.toContain(LIBRARY_WORDS.descriptions);
    expect(off.textContent).not.toContain(LIBRARY_WORDS.transcripts);
    host?.remove();
    act(() => root?.unmount());
    const low = mount({ ...full, timeline: false });
    expect(low.textContent).toContain(LIBRARY_WORDS.descriptions);
    expect(low.textContent).not.toContain(LIBRARY_WORDS.videoBreakdown);
  });

  it("each row opens its options as a radio list", async () => {
    h.providers = providers;
    h.voice = voice;
    mount(full);
    expect(radio(modelName("gemini-3.8-flash"))).toBeNull();
    await open(LIBRARY_WORDS.descriptions);
    expect(radio(modelName("claude-opus-5"))).toBeTruthy();
    await open(LIBRARY_WORDS.transcripts);
    expect(radio(LIBRARY_WORDS.sameAsDefault)).toBeTruthy();
    expect(radio("Whisper base")).toBeTruthy();
    await open(LIBRARY_WORDS.videoBreakdown);
    expect(document.body.textContent).toContain("Picture and sound, fewer moments");
    expect(radio("Antigravity")).toBeTruthy();
  });

  it("picking a Descriptions model writes the person's AI-by-job pick for jobs.library", async () => {
    h.providers = providers;
    h.voice = voice;
    mount(full);
    await open(LIBRARY_WORDS.descriptions);
    await click(radio(modelName("claude-opus-5")));
    expect(h.saveOwn).toHaveBeenCalledWith(expect.objectContaining({ jobs: { library: { instance: "cl", model: "claude-opus-5", effort: "high" } } }));
    expect(h.setProviders).toHaveBeenCalled();
  });

  it("picking a Transcripts model writes the person's Voice choice for transcripts", async () => {
    h.providers = providers;
    h.voice = voice;
    mount(full);
    await open(LIBRARY_WORDS.transcripts);
    await click(radio("Whisper base"));
    expect(h.putVoice).toHaveBeenCalledWith({ stt: { per: { transcripts: { engine: "local", model: "whisper-base" } } } });
  });

  it("Same as default takes the transcripts choice away", async () => {
    h.providers = providers;
    h.voice = { ...voice, stt: { default: { engine: "auto" }, per: { transcripts: { engine: "local", model: "whisper-base" } } } };
    mount(full);
    await open(LIBRARY_WORDS.transcripts);
    await click(radio(LIBRARY_WORDS.sameAsDefault));
    expect(h.putVoice).toHaveBeenCalledWith({ stt: { per: { transcripts: null } } });
  });

  it("picking a Video breakdown model saves the library's timelineModel", async () => {
    h.providers = providers;
    h.voice = voice;
    mount(full);
    await open(LIBRARY_WORDS.videoBreakdown);
    await click(radio("Gemini 3.5 Flash-Lite"));
    expect(h.save).toHaveBeenCalledWith({ timelineModel: "gemini-3.5-flash-lite" });
  });

  it("a model whose key is not added shows Needs <key> with an API keys link, and cannot be picked", async () => {
    h.providers = providers;
    h.voice = voice;
    h.keys = GEMINI_KEY;
    const el = mount(full);
    await open(LIBRARY_WORDS.videoBreakdown);
    expect(el.textContent).toContain("Needs Gemini API key");
    expect(el.querySelector<HTMLAnchorElement>('a[href="/settings/keys"]')?.textContent).toBe(LIBRARY_WORDS.apiKeys);
    expect(radio("Gemini 3.8 Flash")?.disabled).toBe(true);
    expect(radio("Antigravity")?.disabled).toBe(false);
  });

  it("the Descriptions and Transcripts tooltips carry the person's-choice line", async () => {
    h.providers = providers;
    h.voice = voice;
    mount(full);
    await click(document.querySelector(`button[aria-label="About ${LIBRARY_WORDS.descriptions}"]`));
    expect(document.body.textContent).toContain("Your choice, in every workspace.");
    await click(document.querySelector(`button[aria-label="About ${LIBRARY_WORDS.transcripts}"]`));
    expect(document.body.textContent).toContain("Turns speech into text, with times. Your choice, in every workspace.");
  });
});
