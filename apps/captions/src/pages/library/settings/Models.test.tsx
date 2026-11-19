// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProvidersView } from "@contracts/providers";
import { modelName } from "@/lib/providers";
import { Models } from "./Models";

// The owner's Models rows: Descriptions and Transcripts show the model in use (no Change button); Video breakdown keeps its picker.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ providers: null as unknown, voice: null as unknown }));
vi.mock("@/lib/providers", async (orig) => ({ ...(await orig<typeof import("@/lib/providers")>()), useProviders: () => ({ data: h.providers }) }));
vi.mock("@/lib/voice", async (orig) => ({ ...(await orig<typeof import("@/lib/voice")>()), useVoice: () => ({ data: h.voice }) }));

const providers = {
  workspace: null,
  own: {
    instances: [{ id: "gem", driver: "gemini", name: "Gemini", enabled: true, model: "gemini-3.8-flash" }],
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

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

function mount(settings: Record<string, unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Models settings={settings as never} save={vi.fn(async () => {})} />));
  return host;
}

describe("the owner's Models rows", () => {
  it("show the model in use for Descriptions and Transcripts, with no Change button", () => {
    h.providers = providers;
    h.voice = { resolvedDefault: { use: "default", engine: "local", model: "whisper-base-id" } };
    const el = mount({ timeline: false, transcribe: true, describe: true });
    expect(el.textContent).toContain(modelName("gemini-3.8-flash"));
    expect(el.textContent).toContain("whisper-base-id");
    expect(el.textContent).not.toContain("Change");
    expect(el.querySelector("a[href='/settings/providers'], a[href='/settings/voice']")).toBeNull();
  });

  it("show Not set until the AI and Voice pages have answered", () => {
    h.providers = null;
    h.voice = null;
    const el = mount({ timeline: false, transcribe: true, describe: true });
    expect(el.textContent).toContain("Not set");
    expect(el.textContent).not.toContain("Change");
  });

  it("Video breakdown keeps its picker: a button with the model's name", () => {
    h.providers = providers;
    h.voice = null;
    const el = mount({ timeline: true, timelineModel: "gemini-3.8-flash", transcribe: false });
    const btn = [...el.querySelectorAll("button")].find((b) => b.textContent === "Gemini 3.8 Flash");
    expect(btn).toBeTruthy();
    expect(el.textContent).not.toContain("Change");
  });
});
