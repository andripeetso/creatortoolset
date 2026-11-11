// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { webPlugins } from "../plugins.gen";
import { defineWebPlugin } from "./plugin";

// The Mac build's host list (src/plugin-host.gen.ts), with one module that never finishes loading.
vi.mock("../plugin-host.gen", () => ({
  hostModules: { "src/lib/plugin": () => import("./plugin"), "src/never": () => new Promise(() => {}) } as Record<string, () => Promise<unknown>>,
}));

const { folderPluginFailures, loadFolderPlugins, pageFile, pageLimits } = await import("./folder-plugins");

const listed = (...plugins: { id: string; needs: string[] }[]) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ plugins: plugins.map((p) => ({ name: p.id, css: false, ...p })) }))));
const page = (id: string) => ({ default: defineWebPlugin({ id, routes: [{ path: `/${id}`, element: null }] }) });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  folderPluginFailures.clear();
  webPlugins.length = 0;
  pageLimits.loadMs = 10_000;
});

describe("a page half that never finishes loading does not leave the window blank", () => {
  it("gives up on a page file that never settles, names the plug-in, and the app draws", async () => {
    pageLimits.loadMs = 60;
    listed({ id: "stuck", needs: ["src/lib/plugin"] });
    vi.spyOn(pageFile, "load").mockImplementation(() => new Promise(() => {}));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    await loadFolderPlugins(); // without the limit this never returns, and main.tsx waits for it before the first screen
    expect(folderPluginFailures.get("stuck")).toBe("They took too long to load");
    expect(webPlugins).toEqual([]);
    quiet.mockRestore();
  });

  it("gives up on a module of the app that never arrives, and one that loads late does not join afterwards", async () => {
    pageLimits.loadMs = 60;
    listed({ id: "waits", needs: ["src/never"] }, { id: "late", needs: [] });
    let arrive = (_: unknown) => {};
    vi.spyOn(pageFile, "load").mockImplementation(() => new Promise((r) => (arrive = r)) as never);
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    await loadFolderPlugins();
    expect([...folderPluginFailures.keys()].sort()).toEqual(["late", "waits"]);
    arrive(page("late"));
    await new Promise((r) => setTimeout(r, 20));
    expect(webPlugins).toEqual([]);
    quiet.mockRestore();
  });

  it("loads a page half that arrives in time", async () => {
    listed({ id: "quick", needs: ["src/lib/plugin"] });
    vi.spyOn(pageFile, "load").mockImplementation(async () => page("quick"));
    await loadFolderPlugins();
    expect(folderPluginFailures.size).toBe(0);
    expect(webPlugins.map((p) => p.id)).toEqual(["quick"]);
  });
});
