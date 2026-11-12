// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { webPlugins } from "@/plugins.gen";
import { PluginsView } from "./PluginsCatalog";

// Community → Plug-ins: the team's plug-ins under the name of the tool each adds to, in Home's order, and the ones that
// name no tool under Other, last. Download takes the same road as a step's (the folder copied, then the Mac app's own
// switch), and Installed links to that plug-in's own settings. Server and bridge stubbed.
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
const engine = { id: "tiny-enhance", title: "Tiny Enhance", about: "Cleans voices with your own Tiny account.", kind: "enhance", use: false, values: {}, folder: "tiny-enhance" };
const cutout = { id: "tiny-cutout", title: "Tiny Cutout", about: "Cuts a picture out of its background.", kind: "assistant", use: false, values: {}, folder: "tiny-cutout", state: "add" };
let posted: string[] = [];
async function render(steps: object[], q = "") {
  posted = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") posted.push(url);
    return new Response(JSON.stringify(url === "/api/edit-steps" ? { steps, canAdd: true } : { folder: "tiny-enhance" }), { status: 200 });
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<MemoryRouter><PluginsView q={q} /></MemoryRouter>));
  await flush();
  await flush();
}
/** Each heading with its rows: title, the row's lines under it, its buttons, its link, Installed. */
const groups = () =>
  [...host!.querySelectorAll("section")].map((sec) => ({
    heading: sec.querySelector("h2")!.textContent,
    rows: [...sec.querySelectorAll(".min-w-0 > .truncate")].map((t) => {
      const row = t.closest("[class*=grid]")!;
      return {
        title: t.textContent,
        lines: [...t.parentElement!.children].slice(1).map((l) => l.textContent),
        buttons: [...row.querySelectorAll("button")].map((b) => b.textContent),
        link: row.querySelector("a")?.getAttribute("href") ?? null,
        installed: row.textContent!.includes("Installed"),
      };
    }),
  }));

describe("Community → Plug-ins", () => {
  it("groups the plug-ins under the tool each adds to, in Home's order, Other last; a row says no kind of its own", async () => {
    await render([cutout, { ...engine, state: "add" }, { ...voice, kind: "editor", state: "add" }]);
    expect(groups()).toEqual([
      { heading: "AI Editor", rows: [{ title: "Voice", lines: ["Cleans and levels the voice"], buttons: ["Download"], link: null, installed: false }] },
      { heading: "Audio Enhancer", rows: [{ title: "Tiny Enhance", lines: ["Cleans voices with your own Tiny account."], buttons: ["Download"], link: null, installed: false }] },
      { heading: "Other", rows: [{ title: "Tiny Cutout", lines: ["Cuts a picture out of its background."], buttons: ["Download"], link: null, installed: false }] },
    ]);
  });

  it("searches across every heading, the headings' names included", async () => {
    await render([cutout, { ...engine, state: "add" }, { ...voice, kind: "editor", state: "add" }], "audio enhancer");
    expect(groups().map((g) => [g.heading, g.rows.map((r) => r.title)])).toEqual([["Audio Enhancer", ["Tiny Enhance"]]]);
    act(() => root!.unmount());
    root = undefined;
    host!.remove();
    await render([cutout, { ...engine, state: "add" }, { ...voice, kind: "editor", state: "add" }], "picture");
    expect(groups().map((g) => [g.heading, g.rows.map((r) => r.title)])).toEqual([["Other", ["Tiny Cutout"]]]);
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
    expect(groups().map((g) => [g.heading, g.rows.map((r) => [r.title, r.link, r.installed])])).toEqual([
      ["AI Editor", [["Voice", "/settings/editor", true]]],
      ["Audio Enhancer", [["Tiny Enhance", "/settings/tiny-enhance", true]]],
    ]);
  });

  it("installed with no page half loaded: Installed, and no Settings link to a section that isn't there", async () => {
    await render([{ ...engine, state: "loaded" }]);
    expect(groups()).toEqual([{ heading: "Audio Enhancer", rows: [{ title: "Tiny Enhance", lines: ["Cleans voices with your own Tiny account."], buttons: [], link: null, installed: true }] }]);
  });
});
