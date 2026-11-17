// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { webPlugins } from "@/plugins.gen";
import type { HomeTile } from "@contracts/tools";
import { useWorkspace } from "@/lib/workspace";
import { ToolPlugins, useSteps } from "./PluginsCatalog";

// A tool's Plug-ins section (Community → <tool>, Settings → <tool>): the team's plug-ins that add to that tool;
// the ones that name no tool are Community → Other. Download takes the same road as a step's (the folder copied, then the Mac app's own
// switch), an installed one links to its own settings, and one from the person's folder has the Mac app's On switch. Server and bridge stubbed.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@/lib/dialogs", () => ({ confirmDialog: vi.fn(async () => true) }));

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
  canAdd = true;
  useWorkspace.setState({ currentProjectId: null });
});

const voice = { id: "editor-voice", title: "Voice", about: "Cleans and levels the voice", use: false, values: {}, folder: "voice" };
const engine = { id: "tiny-enhance", title: "Tiny Enhance", about: "Cleans voices with your own Tiny account.", kind: "enhance", use: false, values: {}, folder: "tiny-enhance" };
const cutout = { id: "tiny-cutout", title: "Tiny Cutout", about: "Cuts a picture out of its background.", kind: "assistant", use: false, values: {}, folder: "tiny-cutout", state: "add" };
let posted: string[] = [];
function Under({ tool, q }: { tool: HomeTile | null | "all"; q: string }) {
  return <ToolPlugins steps={useSteps()} tool={tool} q={q} />;
}
// the workspace record's answer for a plug-in: fixed on for the server ("tiny-studio-wide"), else on in ws-1 only
const workspaces = (url: string) => {
  const id = decodeURIComponent(url.split("/")[3]);
  return id.endsWith("-wide") ? { id, name: id, fixed: "It runs this server's Editor", all: true, workspaces: [] } : { id, name: id, all: false, workspaces: [{ id: "ws-1", name: "Tiny Acrobatics", on: true }, { id: "ws-2", name: "Tiny Homes", on: false }] };
};
let canAdd = true;
async function render(steps: object[], q = "", tool: HomeTile | null | "all" = "editor") {
  posted = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" || init?.method === "DELETE" || init?.method === "PUT") posted.push(`${init.method} ${url}`);
    if (url === "/api/edit-steps") return new Response(JSON.stringify({ steps, canAdd }), { status: 200 });
    if (url.endsWith("/workspaces")) return new Response(JSON.stringify(workspaces(url)), { status: 200 });
    if (init?.method === "DELETE") return new Response(JSON.stringify({ id: url.split("/").pop() }), { status: 200 });
    return new Response(JSON.stringify({ folder: "tiny-enhance" }), { status: 200 });
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<MemoryRouter><Under tool={tool} q={q} /></MemoryRouter>));
  await flush();
  await flush();
}
/** Each heading with its rows: title, the row's lines under it, its buttons, its link, its switch ("on", "off" or null). */
const groups = () =>
  [...host!.querySelectorAll("section")].map((sec) => ({
    heading: sec.querySelector("h2")!.textContent,
    rows: [...sec.querySelectorAll(".min-w-0 > .truncate")].map((t) => {
      const row = t.closest("[class*=grid]")!;
      return {
        title: t.textContent,
        lines: [...t.parentElement!.children].slice(1).map((l) => l.textContent),
        buttons: [...row.querySelectorAll("button:not([role=switch])")].map((b) => b.textContent),
        link: row.querySelector("a")?.getAttribute("href") ?? null,
        on: row.querySelector("[role=switch]") ? (row.querySelector("[role=switch]")!.getAttribute("aria-checked") === "true" ? "on" : "off") : null,
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
    expect(groups()).toEqual([{ heading: "Plug-ins", rows: [{ title: "Voice", lines: ["Cleans and levels the voice"], buttons: ["Download"], link: null, on: null }] }]);
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
    expect(posted).toEqual(["POST /api/edit-steps/add/tiny-enhance"]);
    expect(asks).toEqual(["plugin:on:tiny-enhance"]);
  });

  it("installed: every plug-in's Settings is its own page (its workspaces, then its settings)", async () => {
    webPlugins.push({ id: "tiny-enhance", settings: [{ id: "tiny-enhance", title: "Tiny Enhance", body: null }] } as never);
    const steps = [{ ...voice, pluginId: "voice", state: "on", use: true }, { ...engine, state: "loaded" }];
    await render(steps, "", "editor");
    expect(groups()[0].rows.map((r) => [r.title, r.link, r.on])).toEqual([["Voice", "/settings/plugin/voice", "on"]]);
    again();
    await render(steps, "", "enhance");
    expect(groups()[0].rows.map((r) => [r.title, r.link, r.on])).toEqual([["Tiny Enhance", "/settings/plugin/tiny-enhance", "on"]]);
  });

  it("Explore lists every row: the ones to download and the ones this server is built with (no folder), Settings on the installed ones, no switch on one the server is built with", async () => {
    webPlugins.push({ id: "tiny-studio", settings: [{ id: "tiny-studio", title: "Tiny Studio", body: null }] } as never);
    const built = { id: "tiny-studio", title: "Tiny Studio", about: "The studio's own.", kind: "", state: "loaded", use: false, values: {} };
    await render([cutout, { ...engine, state: "add" }, built], "", "all");
    expect(groups()[0].rows.map((r) => [r.title, r.link, r.on])).toEqual([
      ["Tiny Cutout", null, null],
      ["Tiny Enhance", null, null],
      ["Tiny Studio", "/settings/plugin/tiny-studio", null],
    ]);
  });

  it("installed with no page half loaded: its switch, with Settings for its workspaces all the same", async () => {
    await render([{ ...engine, state: "loaded" }], "", "enhance");
    expect(groups()).toEqual([{ heading: "Plug-ins", rows: [{ title: "Tiny Enhance", lines: ["Cleans voices with your own Tiny account."], buttons: [], link: "/settings/plugin/tiny-enhance", on: "on" }] }]);
  });

  it("the switch asks the Mac app: off by the plug-in's id, on again by its folder", async () => {
    const asks: string[] = [];
    (window as { webkit?: unknown }).webkit = { messageHandlers: { thisMac: { postMessage: async (m: string) => (asks.push(m), { ok: false }) } } };
    await render([{ ...voice, id: "voice-step", pluginId: "voice", state: "on", use: true }, { ...engine, state: "off" }], "", "all");
    // each with its switch and ⋯ (Remove), an icon button with no text
    expect(groups()[0].rows.map((r) => [r.title, r.on, r.buttons])).toEqual([["Voice", "on", [""]], ["Tiny Enhance", "off", [""]]]);
    const [voiceSwitch, engineSwitch] = host!.querySelectorAll<HTMLButtonElement>("[role=switch]");
    await act(async () => voiceSwitch.click());
    await flush();
    await act(async () => engineSwitch.click());
    await flush();
    expect(asks).toEqual(["plugin:off:voice", "plugin:on:tiny-enhance"]);
  });

  /** The ⋯ menu of the row titled `title`: its items, after opening it. */
  const menuOf = async (title: string) => {
    const row = [...host!.querySelectorAll(".min-w-0 > .truncate")].find((t) => t.textContent === title)!.closest("[class*=grid]")!;
    const more = row.querySelector<HTMLButtonElement>(`button[aria-label="More for ${title}"]`);
    if (!more) return null;
    await act(async () => more.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })));
    await flush();
    return [...document.querySelectorAll<HTMLElement>("[role=menuitem]")];
  };

  it("Remove, for one the app put in the plug-ins folder that is off: its folder goes, nothing restarts, the list is read again", async () => {
    const asks: string[] = [];
    (window as { webkit?: unknown }).webkit = { messageHandlers: { thisMac: { postMessage: async (m: string) => (asks.push(m), { ok: true }) } } };
    await render([{ ...engine, state: "off" }], "", "enhance");
    const items = await menuOf("Tiny Enhance");
    expect(items!.map((i) => i.textContent)).toEqual(["Remove"]);
    await act(async () => items![0].click());
    await flush();
    await flush();
    expect(posted).toEqual(["DELETE /api/plugins/folder/tiny-enhance"]);
    expect(asks).toEqual([]);
  });

  it("Remove, for one that is on: its folder goes, then the Mac app switches it off (and restarts its server)", async () => {
    const asks: string[] = [];
    (window as { webkit?: unknown }).webkit = { messageHandlers: { thisMac: { postMessage: async (m: string) => (asks.push(m), { ok: true }) } } };
    await render([{ ...voice, id: "voice-step", pluginId: "voice", state: "on", use: true }], "", "all");
    const items = await menuOf("Voice");
    await act(async () => items![0].click());
    await flush();
    await flush();
    expect(posted).toEqual(["DELETE /api/plugins/folder/voice"]);
    expect(asks).toEqual(["plugin:off:voice"]);
  });

  it("one not yet downloaded has no Remove; one that is on has none in a browser, where nothing could stop it", async () => {
    await render([{ ...engine, state: "add" }, { ...voice, id: "voice-step", pluginId: "voice", state: "on", use: true }], "", "all");
    expect(await menuOf("Tiny Enhance")).toBeNull();
    expect(await menuOf("Voice")).toBeNull();
  });

  it("built into the server: no Remove, and an On switch for the window's workspace in the same record as its settings page", async () => {
    canAdd = false;
    useWorkspace.setState({ currentProjectId: "ws-1" });
    const built = { id: "tiny-studio", title: "Tiny Studio", about: "The studio's own.", kind: "", state: "loaded", use: false, values: {} };
    const wide = { ...built, id: "tiny-studio-wide", title: "Tiny Wide" };
    await render([built, wide], "", "all");
    await flush();
    expect(groups()[0].rows.map((r) => [r.title, r.on])).toEqual([["Tiny Studio", "on"], ["Tiny Wide", null]]);
    expect(await menuOf("Tiny Studio")).toBeNull();
    await act(async () => host!.querySelector<HTMLButtonElement>("[role=switch]")!.click());
    await flush();
    expect(posted).toEqual(["PUT /api/plugins/tiny-studio/workspaces"]);
  });
});
