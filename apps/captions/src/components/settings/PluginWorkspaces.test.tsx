// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canUse, setOffHere, useAuth, type Me } from "@/lib/auth";
import { workspaceFor } from "@/lib/current-workspace";
import { useWorkspace } from "@/lib/workspace";
import { PluginWorkspaces, WithPluginWorkspaces } from "./PluginWorkspaces";

// A plug-in's settings start with the workspaces it works in: an All workspaces switch and one for each. Server stubbed.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const flush = () => act(async () => new Promise<void>((done) => setTimeout(done, 0)));
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  vi.unstubAllGlobals();
  setOffHere([]);
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
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<MemoryRouter>{page}</MemoryRouter>));
  await flush();
  return sent;
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
    useWorkspace.setState({ currentProjectId: null });
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
