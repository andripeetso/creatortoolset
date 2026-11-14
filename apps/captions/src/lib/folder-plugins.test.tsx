// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Star } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { folderRowNote, guardWebPlugin, loadFolderPlugins, offersNewVersion, reloadForFolderPlugins, webAdmissionProblem, type FolderPluginRow } from "./folder-plugins";
import { defineWebPlugin, type WebPlugin } from "./plugin";

const Page = () => <p>a page</p>;
const Broken = (): never => {
  throw new Error("bad data");
};
const ok = defineWebPlugin({ id: "sponsors", name: "Sponsors", routes: [{ path: "/sponsors", element: <Page /> }] });

describe("a folder plug-in's page half joins the app only when it can't break a screen", () => {
  it("lets a plain plug-in in", () => {
    expect(webAdmissionProblem([], ok, "sponsors")).toBeNull();
  });

  const cases: [string, WebPlugin | null, WebPlugin[], RegExp][] = [
    ["nothing exported", null, [], /must export defineWebPlugin/],
    ["another id than its server half", { ...ok, id: "other" }, [], /says its id is other/],
    ["an id the app already has", ok, [ok], /already has a plug-in called sponsors/],
    ["a front page of its own", { ...ok, site: { hosts: ["127.0.0.1"], claims: () => true, element: null } }, [], /front page/],
    ["a page path without its slash", { ...ok, routes: [{ path: "sponsors", element: null }] }, [], /must start with \//],
    ["a page another plug-in has", ok, [{ id: "first", routes: [{ path: "/sponsors", element: null }] }], /already has the page \/sponsors/],
    ["a replaced page another plug-in replaces", { ...ok, replaces: { finals: Page } }, [{ id: "first", replaces: { finals: Page } }], /more than one plug-in replaces the finals page/],
    ["a tile that names no Home stage", { ...ok, tiles: [{ stage: "Nowhere" as never, to: "/sponsors", icon: Star, name: "S", desc: "", gate: "sponsors" as never }] }, [], /names no stage/],
    ["a Settings section with a built-in section's id", { ...ok, settings: [{ id: "general", title: "Mine", icon: Star, body: null }] }, [], /already a built-in section/],
    // an icon name the app's icon set doesn't have arrives as undefined, and Home itself would draw it
    ["a tile whose icon is missing", { ...ok, tiles: [{ stage: "Tools", to: "/sponsors", icon: undefined as never, name: "Sponsors", desc: "", gate: "sponsors" as never }] }, [], /the Home tile "Sponsors" has no icon/],
    ["a Settings section whose icon is missing", { ...ok, settings: [{ id: "sponsors", title: "Sponsors", icon: undefined as never, body: null }] }, [], /the Settings section "Sponsors" has no icon/],
    ["an account menu item with no label", { ...ok, accountMenu: [{ label: "", to: "/sponsors", icon: Star }] }, [], /account menu item needs label and to/],
    ["a button with no onRun", { ...ok, itemActions: { session: [{ label: "Send", onRun: undefined as never }] } }, [], /button on session items needs label and onRun/],
    ["a replaced page that is not a component", { ...ok, replaces: { finals: "FinalsPage" as never } }, [], /replaces\.finals is not a component/],
    ["a Review panel with no component", { ...ok, review: { panels: [{ id: "p", panel: undefined as never }] } }, [], /Review panel needs id and panel/],
    ["a Media Library filter with no values", { ...ok, library: { facets: [{ key: "k", label: "K", values: undefined as never }] } }, [], /Media Library filter needs key, label and values/],
  ];
  it.each(cases)("refuses %s", (_what, candidate, admitted, why) => {
    expect(webAdmissionProblem(admitted, candidate as WebPlugin, "sponsors")).toMatch(why);
  });
});

describe("a build that cannot load a folder plug-in never asks for one", () => {
  it("makes no request before the first screen, or after a sign-in, when the build has no host list", async () => {
    const fetched = vi.fn(async () => new Response(JSON.stringify({ plugins: [] })));
    vi.stubGlobal("fetch", fetched);
    try {
      await loadFolderPlugins();
      await reloadForFolderPlugins();
      expect(fetched).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("every piece a folder plug-in draws has its own boundary", () => {
  it("draws a working page as it is", () => {
    const guarded = guardWebPlugin(ok);
    expect(renderToStaticMarkup(<>{guarded.routes![0]!.element}</>)).toBe("<p>a page</p>");
  });

  it("wraps pages, Settings and Devices sections, replaced pages and Review panels, and nothing else", () => {
    const tile = { stage: "Tools" as const, to: "/sponsors", icon: Star, name: "S", desc: "", gate: "sponsors" as never };
    const full = defineWebPlugin({
      ...ok,
      tiles: [tile],
      settings: [{ id: "sponsors", title: "Sponsors", icon: Star, body: <Page /> }],
      devices: [{ id: "sponsors", title: "Sponsors", body: <Page /> }],
      replaces: { finals: Page },
      review: { panels: [{ id: "p", panel: Page as never }] },
    });
    const g = guardWebPlugin(full);
    expect(g.tiles).toEqual([tile]);
    for (const piece of [g.routes![0]!.element, g.settings![0]!.body, g.devices![0]!.body]) expect(piece).not.toBe(full.routes![0]!.element);
    expect(g.replaces!.finals).not.toBe(Page);
    expect(g.review!.panels![0]!.panel).not.toBe(Page);
    const Finals = g.replaces!.finals!;
    expect(renderToStaticMarkup(<Finals />)).toBe("<p>a page</p>");
  });

  it("adds no badge when a plug-in's badge function throws", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const g = guardWebPlugin(defineWebPlugin({ ...ok, library: { badges: () => { throw new Error("no such field"); } } }));
    expect(g.library!.badges!({} as never)).toEqual([]);
    expect(g.library!.badges!({} as never)).toEqual([]);
    expect(quiet).toHaveBeenCalledTimes(1);
    quiet.mockRestore();
  });

  it("catches a page that throws while drawing, names the plug-in and keeps the app", async () => {
    // a boundary catches only in a mounted tree (the server renderer rethrows)
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const guarded = guardWebPlugin(defineWebPlugin({ id: "sponsors", name: "Sponsors", routes: [{ path: "/sponsors", element: <Broken /> }] }));
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(<><i>rest of the app</i>{guarded.routes![0]!.element}</>));
    expect(host.textContent).toBe("rest of the appThe Sponsors plug-in stopped working here.");
    await act(async () => root.unmount());
    quiet.mockRestore();
  });
});

describe("what a plug-in's row says under its name", () => {
  const row: FolderPluginRow = { folder: "sponsors", id: "sponsors", name: "Sponsors", about: "", on: true, running: true, changed: false };
  it("says nothing when all is well", () => {
    expect(folderRowNote(row, undefined, false)).toBeNull();
  });
  it("says why it is not running, before anything else", () => {
    expect(folderRowNote({ ...row, running: false, changed: true, error: "boom" }, "x", false)).toEqual({ tone: "broken", text: "boom" });
  });
  it("says when only its pages were left out", () => {
    expect(folderRowNote(row, "it needs src/x, which this version of the app doesn't have", false)?.text).toBe("Its pages were left out: it needs src/x, which this version of the app doesn't have");
  });
  it("says the folder changed, and offers the new version, while Update automatically is off", () => {
    expect(folderRowNote({ ...row, changed: true }, undefined, false)).toEqual({ tone: "attention", text: "Changed since you switched it on" });
    expect(offersNewVersion({ ...row, changed: true }, undefined)).toBe(true);
    expect(offersNewVersion(row, undefined)).toBe(false);
  });
  it("says nothing and offers nothing about a change that is coming in by itself", () => {
    expect(folderRowNote({ ...row, changed: true }, undefined, false, { waiting: false })).toBeNull();
    expect(offersNewVersion({ ...row, changed: true }, { waiting: false })).toBe(false);
  });
  it("says a new version waits for running work, quietly, and offers it now", () => {
    expect(folderRowNote({ ...row, changed: true }, undefined, false, { waiting: true })).toEqual({ text: "The new version starts when the running work is done" });
    expect(offersNewVersion({ ...row, changed: true }, { waiting: true })).toBe(true);
  });
  it("says why a changed folder was not taken", () => {
    const note = "The new version was left out: plugin.ts:3: Unexpected }";
    expect(folderRowNote({ ...row, changed: true }, undefined, false, { waiting: false, note })).toEqual({ tone: "attention", text: note });
    expect(offersNewVersion({ ...row, changed: true }, { waiting: false, note: "x" })).toBe(true);
  });
});
