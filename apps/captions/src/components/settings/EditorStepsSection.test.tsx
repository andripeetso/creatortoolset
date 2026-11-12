// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorStepsSection } from "./EditorStepsSection";

// Settings → AI Editor lists only the loaded AI Editor steps: a team plug-in of another kind (loaded or not) and a step
// not downloaded yet have no row here. Server stubbed.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const flush = () => act(async () => new Promise<void>((done) => setTimeout(done, 0)));
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});

describe("Settings → AI Editor", () => {
  it("shows the loaded steps only", async () => {
    const steps = [
      { id: "blur", title: "Blur faces", about: "", state: "on", use: true, values: {} },
      { id: "tiny-enhance", title: "Tiny Enhance", about: "", kind: "Audio Enhancer engine", state: "loaded", folder: "tiny-enhance", use: false, values: {} },
      { id: "editor-voice", title: "Voice", about: "", kind: "AI Editor step", state: "add", folder: "voice", use: false, values: {} },
    ];
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ steps, canAdd: true }), { status: 200 }));
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<MemoryRouter><EditorStepsSection /></MemoryRouter>));
    await flush();
    await flush();
    expect(host.textContent).toContain("Blur faces");
    expect(host.textContent).not.toContain("Tiny Enhance");
    expect(host.textContent).not.toContain("Voice");
    expect(host.querySelectorAll("[role=switch]")).toHaveLength(1);
  });
});
