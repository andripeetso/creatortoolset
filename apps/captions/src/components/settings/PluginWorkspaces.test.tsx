// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canUse, setOffHere, useAuth, type Me } from "@/lib/auth";
import { workspaceFor } from "@/lib/current-workspace";
import { useWorkspace } from "@/lib/workspace";
import { PageActionContext } from "./page-action";
import { PluginWorkspaces, WithPluginWorkspaces } from "./PluginWorkspaces";
import { resetWorkspacePick } from "./workspace-pick";

// the real select is a menu a test cannot open: a plain one with the same props
vi.mock("./kit-controls", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./kit-controls")>()),
  SettingsSelect: ({ label, value, onValueChange, options }: { label: string; value: string; onValueChange: (v: string) => void; options: ReadonlyArray<{ value: string; label: string }> }) => (
    <select aria-label={label} value={value} onChange={(e) => onValueChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  ),
}));

// A plug-in's settings start with the workspaces it works in: an All workspaces switch and one for each. Server stubbed.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
/** the page header's slot, where the workspace selector is drawn */
let header: HTMLDivElement | undefined;
const flush = () => act(async () => new Promise<void>((done) => setTimeout(done, 0)));
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  header?.remove();
  vi.unstubAllGlobals();
  setOffHere([]);
  resetWorkspacePick();
  useWorkspace.setState({ currentProjectId: null, projects: [] });
});

async function draw(answers: unknown[], page = <PluginWorkspaces id="blur-faces" />) {
  const sent: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT") sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(String(url).startsWith("/api/plugins/") ? answers.shift() : { currentProjectId: null, projects: [] }));
    }),
  );
  host = document.createElement("div");
  header = document.createElement("div");
  document.body.append(header, host);
  root = createRoot(host);
  act(() => root!.render(<MemoryRouter><PageActionContext.Provider value={header!}>{page}</PageActionContext.Provider></MemoryRouter>));
  await flush();
  return sent;
}

let mounts = 0;
/** A plug-in's own settings: counts each time they are read anew. */
function Style() {
  useEffect(() => void mounts++, []);
  return <p>Style</p>;
}

const some = { id: "blur-faces", name: "Face Blur", all: false, workspaces: [{ id: "ws-tiny", name: "Tiny Acrobatics", on: true }, { id: "ws-homes", name: "Tiny Homes", on: false }] };

describe("Workspaces", () => {
  it("lists the workspaces with a switch each, and a switch saves the ones on", async () => {
    const sent = await draw([some, { ...some, workspaces: some.workspaces.map((w) => ({ ...w, on: true })) }]);
    expect(host!.querySelector('[aria-label="Face Blur in all workspaces"]')!.getAttribute("aria-checked")).toBe("false");
    expect(host!.textContent).toContain("Tiny Acrobatics");
    expect(host!.textContent).toContain("Tiny Homes");
    const homes = host!.querySelector<HTMLButtonElement>('[aria-label="Face Blur in Tiny Homes"]')!;
    expect(homes.getAttribute("aria-checked")).toBe("false");
    act(() => homes.click());
    await flush();
    expect(sent).toEqual([{ only: ["ws-tiny", "ws-homes"] }]);
  });

  it("in All workspaces every workspace shows on, and switching one off keeps the rest", async () => {
    const sent = await draw([{ ...some, all: true }, some]);
    const homes = host!.querySelector<HTMLButtonElement>('[aria-label="Face Blur in Tiny Homes"]')!;
    expect(homes.getAttribute("aria-checked")).toBe("true");
    act(() => homes.click());
    await flush();
    expect(sent).toEqual([{ only: ["ws-tiny"] }]);
  });

  it("off in this workspace, the settings below are the ones of a workspace where it is on", async () => {
    useWorkspace.setState({ currentProjectId: "ws-homes" });
    setOffHere(["blur-faces"]);
    await draw([some], <WithPluginWorkspaces id="blur-faces"><p>Style</p></WithPluginWorkspaces>);
    expect(host!.textContent).toContain("These are its settings for Tiny Acrobatics");
    expect(host!.textContent).toContain("Style");
    expect(workspaceFor("/api/x/blur-faces/settings")).toBe("ws-tiny");
    expect(workspaceFor("/api/library/files")).toBe("ws-homes");
    act(() => root!.unmount());
    root = undefined;
    expect(workspaceFor("/api/x/blur-faces/settings")).toBe("ws-homes");
  });

  it("on in several workspaces, the header's selector lists them and the settings below are the chosen one's", async () => {
    useWorkspace.setState({ currentProjectId: "ws-homes", projects: [...some.workspaces, { id: "ws-play", name: "Tiny Play" }] as never });
    setOffHere(["blur-faces"]);
    await draw([{ ...some, workspaces: [...some.workspaces, { id: "ws-play", name: "Tiny Play", on: true }] }], <WithPluginWorkspaces id="blur-faces"><Style /></WithPluginWorkspaces>);
    const pick = header!.querySelector<HTMLSelectElement>('[aria-label="Workspace"]')!;
    // only where it is on, and never locked by the window's workspace, where it is off: it starts on one where it is on
    expect([...pick.options].map((o) => o.text)).toEqual(["Tiny Acrobatics", "Tiny Play"]);
    expect(pick.value).toBe("ws-tiny");
    expect(host!.textContent).toContain("Style");
    expect(host!.textContent).not.toContain("Settings for");
    expect(host!.textContent).not.toContain("These are its settings");
    expect(workspaceFor("/api/x/blur-faces/settings")).toBe("ws-tiny");
    const before = mounts;
    pick.value = "ws-play";
    act(() => void pick.dispatchEvent(new Event("change", { bubbles: true })));
    await flush();
    expect(workspaceFor("/api/x/blur-faces/settings")).toBe("ws-play");
    expect(mounts).toBe(before + 1); // read anew for the other workspace
    expect(useWorkspace.getState().currentProjectId).toBe("ws-homes"); // the window stays where it is
  });

  it("off in every workspace, it says so in place of the settings", async () => {
    useWorkspace.setState({ currentProjectId: "ws-homes", projects: some.workspaces as never });
    setOffHere(["blur-faces"]);
    await draw([{ ...some, workspaces: some.workspaces.map((w) => ({ ...w, on: false })) }], <WithPluginWorkspaces id="blur-faces"><Style /></WithPluginWorkspaces>);
    expect(host!.textContent).toContain("Off in every workspace.");
    expect(host!.textContent).not.toContain("Style");
    expect(header!.querySelector("select")).toBeNull();
  });

  it("fixed on for the whole server, there is no selector and its settings are drawn", async () => {
    useWorkspace.setState({ currentProjectId: "ws-homes", projects: some.workspaces as never });
    await draw([{ id: "studio", name: "Studio", all: true, fixed: "It runs this server's AI Editor and Finals, so it is on in every workspace", workspaces: [] }], <WithPluginWorkspaces id="studio"><Style /></WithPluginWorkspaces>);
    expect(header!.querySelector("select")).toBeNull();
    expect(host!.textContent).toContain("Style");
    expect(workspaceFor("/api/x/studio/settings")).toBe("ws-homes");
  });

  it("says a plug-in that changes the whole server is on in every workspace, with no switches", async () => {
    await draw([{ id: "studio", name: "Studio", all: true, fixed: "It runs this server's AI Editor and Finals, so it is on in every workspace", workspaces: [] }]);
    expect(host!.textContent).toContain("All workspaces");
    expect(host!.textContent).toContain("on in every workspace");
    expect(host!.querySelector('[role="switch"]')).toBeNull();
  });
});

describe("canUse", () => {
  it("hides a plug-in off in this workspace, for an admin too", () => {
    const admin = { username: "owner", role: "admin", cloud: true, off: [] } as Me;
    useAuth.setState({ me: admin });
    expect(canUse(admin, "blur-faces" as never)).toBe(true);
    setOffHere(["blur-faces"]);
    expect(canUse(useAuth.getState().me, "blur-faces" as never)).toBe(false);
    expect(canUse(useAuth.getState().me, "review")).toBe(true);
    useAuth.setState({ me: null });
  });
});
