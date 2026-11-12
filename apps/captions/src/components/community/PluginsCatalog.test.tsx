// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { webPlugins } from "@/plugins.gen";
import { PluginsView } from "./PluginsCatalog";

// Community → Plug-ins: each team plug-in with the kind its folder says, Download on the same road as a step's (the folder
// copied, then the Mac app's own switch), and Installed with a link to that plug-in's own settings. Server and bridge stubbed.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const compiled = webPlugins.length;
const flush = () => act(async () => new Promise<void>((done) => setTimeout(done, 0)));
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  webPlugins.splice(compiled);
  vi.unstubAllGlobals();
  delete (window as { webkit?: unknown }).webkit;
});

const voice = { id: "editor-voice", title: "Voice", about: "Cleans and levels the voice", use: false, values: {}, folder: "voice" };
const engine = { id: "tiny-enhance", title: "Tiny Enhance", about: "Cleans voices with your own Tiny account.", kind: "Audio Enhancer engine", use: false, values: {}, folder: "tiny-enhance" };
let posted: string[] = [];
async function render(steps: object[]) {
  posted = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") posted.push(url);
    return new Response(JSON.stringify(url === "/api/edit-steps" ? { steps, canAdd: true } : { folder: "tiny-enhance" }), { status: 200 });
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<MemoryRouter><PluginsView q="" /></MemoryRouter>));
  await flush();
  await flush();
}
const rows = () =>
  [...host!.querySelectorAll(".min-w-0 > .truncate")].map((t) => {
    const row = t.closest("[class*=grid]")!;
    return {
      title: t.textContent,
      kind: t.parentElement!.lastElementChild!.textContent,
      buttons: [...row.querySelectorAll("button")].map((b) => b.textContent),
      link: row.querySelector("a")?.getAttribute("href") ?? null,
      installed: row.textContent!.includes("Installed"),
    };
  });

describe("Community → Plug-ins", () => {
  it("lists a step and an Audio Enhancer engine, each with its own kind and Download", async () => {
    await render([{ ...voice, kind: "AI Editor step", state: "add" }, { ...engine, state: "add" }]);
    expect(rows()).toEqual([
      { title: "Voice", kind: "AI Editor step", buttons: ["Download"], link: null, installed: false },
      { title: "Tiny Enhance", kind: "Audio Enhancer engine", buttons: ["Download"], link: null, installed: false },
    ]);
  });

  it("Download copies the folder and asks the Mac app to switch it on, as for a step", async () => {
    const asks: string[] = [];
    (window as { webkit?: unknown }).webkit = { messageHandlers: { thisMac: { postMessage: async (m: string) => (asks.push(m), { ok: true }) } } };
    await render([{ ...engine, state: "add" }]);
    await act(async () => host!.querySelector("button")!.click());
    await flush();
    expect(posted).toEqual(["/api/edit-steps/add/tiny-enhance"]);
    expect(asks).toEqual(["plugin:on:tiny-enhance"]);
  });

  it("installed: a step's Settings is the AI Editor's, the engine's its own section", async () => {
    webPlugins.push({ id: "tiny-enhance", settings: [{ id: "tiny-enhance", title: "Tiny Enhance", body: null }] } as never);
    await render([{ ...voice, state: "on", use: true }, { ...engine, state: "loaded" }]);
    expect(rows()).toEqual([
      { title: "Voice", kind: "AI Editor step", buttons: [], link: "/settings/editor", installed: true },
      { title: "Tiny Enhance", kind: "Audio Enhancer engine", buttons: [], link: "/settings/tiny-enhance", installed: true },
    ]);
  });

  it("installed with no page half loaded: Installed, and no Settings link to a section that isn't there", async () => {
    await render([{ ...engine, state: "loaded" }]);
    expect(rows()).toEqual([{ title: "Tiny Enhance", kind: "Audio Enhancer engine", buttons: [], link: null, installed: true }]);
  });
});
