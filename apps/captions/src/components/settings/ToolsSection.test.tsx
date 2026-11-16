// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@/lib/auth";
import { useSetup } from "@/lib/setup";
import { webPlugins } from "@/plugins.gen";
import { ToolsSection, canAddTo, hasToolPage, skillPlacesOf } from "./ToolsSection";

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

  it("a tool has a settings page when there is something on it", () => {
    for (const t of ["workshop", "instagram", "captions", "editor"] as const) expect(hasToolPage(t, null, null)).toBe(true);
    for (const t of ["media", "review", "enhance", "record"] as const) expect(hasToolPage(t, null, null)).toBe(false);
    expect(hasToolPage("enhance", { steps: [engine as never], canAdd: true }, null)).toBe(true);
    // the Screen Recorder only in a Mac app that has its settings
    expect(hasToolPage("record", null, null, true)).toBe(true);
    // a plug-in's section that names the tool, for the accounts that may see it
    webPlugins.push({ id: "tiny", settings: [{ id: "tiny-review", title: "Tiny", body: null, tool: "review", adminOnly: true }] } as never);
    expect(hasToolPage("review", null, { role: "user" })).toBe(false);
    expect(hasToolPage("review", null, { role: "admin" })).toBe(true);
  });

  it("a row of the list is the tool and its Home switch: it opens nothing", async () => {
    await render();
    expect(host!.querySelectorAll('a[href^="/settings/tools/"]').length).toBe(0);
    expect(host!.querySelectorAll("button[aria-expanded]").length).toBe(0);
    expect(host!.querySelectorAll("[role=switch]").length).toBeGreaterThan(4);
  });

  it("the AI Editor's page on the Mac app's own server: its step with its switch, its pack, the way to Community, all open", async () => {
    document.documentElement.dataset.macThisMac = "1";
    await render("editor");
    const text = host!.textContent!;
    expect(text).toContain("Blur faces");
    expect(text).not.toContain("Tiny Enhance");
    expect(text).toContain("Tiny cards");
    expect(host!.querySelector('[aria-label="Blur faces in new edits"]')).not.toBeNull();
    expect(host!.querySelector('a[href="/community/tool/editor"]')?.textContent).toBe("Browse Community");
    // no Home switch a second time, and no section folded away
    expect(host!.querySelector('[aria-label="Show AI Editor on Home"]')).toBeNull();
    expect([...host!.querySelectorAll("h2")].map((h) => h.textContent)).toEqual(expect.arrayContaining(["Plug-ins", "Packs", "Skills for the script"]));
  });

  it("a plug-in's section that names the tool is drawn on its page, under its title", async () => {
    webPlugins.push({ id: "tiny-enhance", settings: [{ id: "tiny-picks", title: "Tiny picks", body: <p>Tiny picks body</p>, tool: "enhance" }] } as never);
    await render("enhance");
    expect(host!.textContent).toContain("Tiny picks body");
    expect([...host!.querySelectorAll("h2")].map((h) => h.textContent)).toContain("Tiny picks");
  });

  it("in a browser the step shows no switch (the Mac app's own server has it)", async () => {
    await render("editor");
    expect(host!.querySelector('[aria-label="Blur faces in new edits"]')).toBeNull();
  });
});
