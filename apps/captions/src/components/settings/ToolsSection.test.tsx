// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@/lib/auth";
import { useSetup } from "@/lib/setup";
import { webPlugins } from "@/plugins.gen";
import { ToolsSection, hasToolPage, skillPlacesOf } from "./ToolsSection";

// Settings → Tools: a tool something can be added to opens its own page, which holds its Home switch, its plug-ins (an
// AI Editor step with its switch for new edits on the Mac app's own server), its packs, its skills and the way to
// Community's section for it. Server stubbed.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const compiled = webPlugins.length;
const flush = () => act(async () => new Promise<void>((done) => setTimeout(done, 0)));
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.macThisMac;
  webPlugins.splice(compiled);
  useSetup.setState({ view: null });
  useAuth.setState({ me: null });
});

const blur = { id: "blur", title: "Blur faces", about: "", state: "on", use: true, values: {} };
const engine = { id: "tiny-enhance", title: "Tiny Enhance", about: "", kind: "enhance", state: "loaded", folder: "tiny-enhance", use: false, values: {} };
const offPack = { id: "tiny-off", name: "Tiny off", author: "Tiny", version: "1.0.0", description: "", off: ["*"], instructions: { "editor.script": "Short." }, items: { frameworks: [], presets: [] } };
const pack = { id: "tiny-cards", name: "Tiny cards", author: "Tiny", version: "1.0.0", description: "", off: [], instructions: { "editor.cards": "Bold." }, items: { frameworks: [], presets: [] } };

async function render(sub?: string) {
  vi.stubGlobal("fetch", async (url: string) => {
    const body =
      url === "/api/edit-steps" ? { steps: [blur, engine], canAdd: true }
      : url === "/api/packs" ? [pack, offPack]
      : url === "/api/skills" ? { skills: [], shared: [] }
      : { tools: null, hidden: [], plan: null, detected: null, done: true, have: [], mcpTo: [] };
    return new Response(JSON.stringify(body), { status: 200 });
  });
  useAuth.setState({ me: { username: "tiny", role: "admin", cloud: true, off: [] } });
  useSetup.setState({ view: { tools: null, hidden: [], plan: null, detected: null, done: true, have: [], mcpTo: [] } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<MemoryRouter><ToolsSection sub={sub} /></MemoryRouter>));
  for (let i = 0; i < 4; i++) await flush();
}

describe("Settings → Tools", () => {
  it("a tool has a page when packs reach it or a plug-in names it", () => {
    for (const t of ["workshop", "instagram", "captions", "editor"] as const) expect(hasToolPage(t, null)).toBe(true);
    expect(hasToolPage("enhance", null)).toBe(false);
    expect(hasToolPage("enhance", { steps: [engine as never], canAdd: true })).toBe(true);
    // the Screen Recorder has a page only in a Mac app that has its settings (one that reports `recorder`)
    expect(hasToolPage("record", null)).toBe(false);
    expect(hasToolPage("record", null, true)).toBe(true);
    expect(skillPlacesOf("editor")).toEqual(["editor.script"]);
    expect(skillPlacesOf("workshop")).toEqual(["workshop.write", "workshop.review"]);
    expect(skillPlacesOf("review")).toEqual([]);
  });

  it("the list links each tool that has a page, and counts what is added to it and on (a pack off everywhere is not)", async () => {
    await render();
    const links = [...host!.querySelectorAll("a")].map((a) => [a.getAttribute("href"), a.textContent]);
    expect(links).toContainEqual(["/settings/tools/editor", expect.stringContaining("2 added")]);
    expect(links).toContainEqual(["/settings/tools/enhance", expect.stringContaining("1 added")]);
    expect(links.some(([h]) => h === "/settings/tools/review")).toBe(false);
    expect(host!.querySelectorAll("[role=switch]").length).toBeGreaterThan(4);
  });

  it("the AI Editor's page on the Mac app's own server: Home switch, its step with its switch, its pack, Get more", async () => {
    document.documentElement.dataset.macThisMac = "1";
    await render("editor");
    const text = host!.textContent!;
    expect(text).toContain("Blur faces");
    expect(text).not.toContain("Tiny Enhance");
    expect(text).toContain("Tiny cards");
    expect(host!.querySelector('[aria-label="Blur faces in new edits"]')).not.toBeNull();
    expect(host!.querySelector('[aria-label="Show AI Editor on Home"]')).not.toBeNull();
    expect(host!.querySelector('a[href="/community/tool/editor"]')?.textContent).toBe("Get more for AI Editor");
  });

  it("a plug-in's section that names the tool is drawn on its page, under its title", async () => {
    webPlugins.push({ id: "tiny-enhance", settings: [{ id: "tiny-picks", title: "Tiny picks", body: <p>Tiny picks body</p>, tool: "enhance" }] } as never);
    await render("enhance");
    expect(host!.textContent).toContain("Tiny picks body");
    expect([...host!.querySelectorAll("h2")].map((h) => h.textContent)).toContain("Tiny picks");
    // the plug-in's row on its own page links nowhere: its settings are right here
    expect(host!.querySelector('a[href="/settings/tools/enhance"]')).toBeNull();
  });

  it("in a browser the step shows Installed, not its switch", async () => {
    await render("editor");
    expect(host!.querySelector('[aria-label="Blur faces in new edits"]')).toBeNull();
    expect(host!.textContent).toContain("Installed");
  });
});
