// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { webPlugins } from "@/plugins.gen";
import type { HomeTile } from "@contracts/tools";
import { ToolPlugins, useSteps } from "./PluginsCatalog";

// A tool's Plug-ins section (Community → <tool>, Settings → Tools → <tool>): the team's plug-ins that add to that tool;
// the ones that name no tool are Community → Other. Download takes the same road as a step's (the folder copied, then the Mac app's own
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
function Under({ tool, q }: { tool: HomeTile | null | "all"; q: string }) {
  return <ToolPlugins steps={useSteps()} tool={tool} q={q} />;
}
async function render(steps: object[], q = "", tool: HomeTile | null | "all" = "editor") {
  posted = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") posted.push(url);
    return new Response(JSON.stringify(url === "/api/edit-steps" ? { steps, canAdd: true } : { folder: "tiny-enhance" }), { status: 200 });
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<MemoryRouter><Under tool={tool} q={q} /></MemoryRouter>));
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

const all = [cutout, { ...engine, state: "add" }, { ...voice, kind: "editor", state: "add" }];
const again = () => {
  act(() => root!.unmount());
  root = undefined;
  host!.remove();
};

describe("a tool's plug-ins", () => {
  it("lists only the plug-ins that add to that tool; the ones that name no tool are Other's; a row says no kind of its own", async () => {
    await render(all, "", "editor");
    expect(groups()).toEqual([{ heading: "Plug-ins", rows: [{ title: "Voice", lines: ["Cleans and levels the voice"], buttons: ["Download"], link: null, installed: false }] }]);
    again();
    await render(all, "", "enhance");
    expect(groups().map((g) => g.rows.map((r) => r.title))).toEqual([["Tiny Enhance"]]);
    again();
    await render(all, "", null);
    expect(groups().map((g) => g.rows.map((r) => r.title))).toEqual([["Tiny Cutout"]]);
  });

  it("a tool with none shows nothing; the search narrows a tool's rows", async () => {
    await render(all, "", "captions");
    expect(groups()).toEqual([]);
    again();
    await render(all, "picture", "editor");
    expect(groups()).toEqual([]);
    again();
    await render(all, "picture", null);
    expect(groups().map((g) => g.rows.map((r) => r.title))).toEqual([["Tiny Cutout"]]);
  });

  it("Download copies the folder and asks the Mac app to switch it on, as for a step", async () => {
    const asks: string[] = [];
    (window as { webkit?: unknown }).webkit = { messageHandlers: { thisMac: { postMessage: async (m: string) => (asks.push(m), { ok: true }) } } };
    await render([{ ...engine, state: "add" }], "", "enhance");
    await act(async () => host!.querySelector("button")!.click());
    await flush();
    expect(posted).toEqual(["/api/edit-steps/add/tiny-enhance"]);
    expect(asks).toEqual(["plugin:on:tiny-enhance"]);
  });

  it("installed: every plug-in's Settings is its own page (its workspaces, then its settings)", async () => {
    webPlugins.push({ id: "tiny-enhance", settings: [{ id: "tiny-enhance", title: "Tiny Enhance", body: null }] } as never);
    const steps = [{ ...voice, pluginId: "voice", state: "on", use: true }, { ...engine, state: "loaded" }];
    await render(steps, "", "editor");
    expect(groups()[0].rows.map((r) => [r.title, r.link, r.installed])).toEqual([["Voice", "/settings/plugin/voice", true]]);
    again();
    await render(steps, "", "enhance");
    expect(groups()[0].rows.map((r) => [r.title, r.link, r.installed])).toEqual([["Tiny Enhance", "/settings/plugin/tiny-enhance", true]]);
  });

  it("Explore lists every row: the ones to download and the ones this server is built with (no folder), Installed with their Settings", async () => {
    webPlugins.push({ id: "tiny-studio", settings: [{ id: "tiny-studio", title: "Tiny Studio", body: null }] } as never);
    const built = { id: "tiny-studio", title: "Tiny Studio", about: "The studio's own.", kind: "", state: "loaded", use: false, values: {} };
    await render([cutout, { ...engine, state: "add" }, built], "", "all");
    expect(groups()[0].rows.map((r) => [r.title, r.link, r.installed])).toEqual([
      ["Tiny Cutout", null, false],
      ["Tiny Enhance", null, false],
      ["Tiny Studio", "/settings/plugin/tiny-studio", true],
    ]);
  });

  it("installed with no page half loaded: Installed, with Settings for its workspaces all the same", async () => {
    await render([{ ...engine, state: "loaded" }], "", "enhance");
    expect(groups()).toEqual([{ heading: "Plug-ins", rows: [{ title: "Tiny Enhance", lines: ["Cleans voices with your own Tiny account."], buttons: [], link: "/settings/plugin/tiny-enhance", installed: true }] }]);
  });
});
