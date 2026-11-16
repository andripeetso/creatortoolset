// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@/lib/auth";
import { useSetup } from "@/lib/setup";
import { webPlugins } from "@/plugins.gen";
import { ToolsSection, canAddTo, skillPlacesOf } from "./ToolsSection";

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
  it("Community has something to add to a tool when packs reach it or a plug-in adds a step to it", () => {
    for (const t of ["workshop", "instagram", "captions", "editor"] as const) expect(canAddTo(t, null)).toBe(true);
    expect(canAddTo("enhance", null)).toBe(false);
    expect(canAddTo("enhance", { steps: [engine as never], canAdd: true })).toBe(true);
    expect(canAddTo("record", null)).toBe(false);
    expect(skillPlacesOf("editor")).toEqual(["editor.script"]);
    expect(skillPlacesOf("workshop")).toEqual(["workshop.write", "workshop.review"]);
    expect(skillPlacesOf("review")).toEqual([]);
  });

  it("the list opens every tool's page, and says nothing about what is on it", async () => {
    await render();
    const links = [...host!.querySelectorAll("a")].map((a) => [a.getAttribute("href"), a.textContent]);
    for (const t of ["editor", "enhance", "review"]) expect(links).toContainEqual([`/settings/tools/${t}`, expect.any(String)]);
    expect(host!.textContent).not.toMatch(/added|plug-in ·/);
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
    // folded: the page is the Home switch and closed folds until one is opened
    const folds = [...host!.querySelectorAll("button[aria-expanded]")];
    expect(folds.map((b) => b.textContent)).toContain("Plug-ins, packs and skills");
    expect(folds.every((b) => b.getAttribute("aria-expanded") === "false")).toBe(true);
    act(() => (folds.at(-1) as HTMLButtonElement).click());
    expect(folds.at(-1)!.getAttribute("aria-expanded")).toBe("true");
  });

  it("a plug-in's section that names the tool is drawn on its page, in a fold under its title", async () => {
    webPlugins.push({ id: "tiny-enhance", settings: [{ id: "tiny-picks", title: "Tiny picks", body: <p>Tiny picks body</p>, tool: "enhance" }] } as never);
    await render("enhance");
    expect(host!.textContent).toContain("Tiny picks body");
    expect([...host!.querySelectorAll("button[aria-expanded]")].map((b) => b.textContent)).toContain("Tiny picks");
    // the plug-in's row on its own page links nowhere: its settings are right here
    expect(host!.querySelector('a[href="/settings/tools/enhance"]')).toBeNull();
  });

  it("in a browser the step shows Installed, not its switch", async () => {
    await render("editor");
    expect(host!.querySelector('[aria-label="Blur faces in new edits"]')).toBeNull();
    expect(host!.textContent).toContain("Installed");
  });
});
