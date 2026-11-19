// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { actionCard, LIBRARY_WORDS, quickSetup, RETRY, type ActionNeeded } from "@contracts/library";
import { ActionCard } from "./ActionCard";

const setup = (owner: boolean) =>
  actionCard({ kind: "setup", workspace: "ws_p", workspaceName: "Tiny Acrobatics", owner, href: "/library?setup=1", libraryId: "lib_p", device: "dev-1", deviceName: "Tiny's Mac", defaults: quickSetup("~/Movies/Creator Toolset/Tiny Acrobatics") });
const path = "~/Movies/Creator Toolset/Tiny Acrobatics/Project files";
const projects = actionCard({ kind: "projects", workspace: "ws_p", workspaceName: "Tiny Acrobatics", device: "dev-1", deviceName: "Tiny's Mac", path });
const render = (action?: ActionNeeded) => renderToStaticMarkup(<MemoryRouter><ActionCard action={action} /></MemoryRouter>);

describe("ActionCard draws the card from its title, line and actions", () => {
  it("any card: its title, its line, and each action's label in order", () => {
    const card: ActionNeeded = { kind: "downloads", libraryId: "lib_p", workspace: "ws_p", title: "A title from the server", line: "A line from the server", actions: [{ id: "turn_on", label: "First", primary: true, call: { method: "PUT", path: "/x" } }, { id: "customise", label: "Second", open: "/y" }] };
    const html = render(card);
    expect(html).toContain("A title from the server");
    expect(html).toContain("A line from the server");
    expect(html.indexOf("First")).toBeLessThan(html.indexOf("Second"));
  });

  it("the owner's setup card offers Set up and Customise; a member's has no button", () => {
    expect(render(setup(true))).toContain(LIBRARY_WORDS.quickSetupButton);
    expect(render(setup(true))).toContain(LIBRARY_WORDS.customiseButton);
    expect(render(setup(false))).not.toContain("<button");
  });

  it("the Project files card names the workspace and offers its default and Choose…", () => {
    const html = render(projects);
    expect(html).toContain("Project files folder for Tiny Acrobatics");
    expect(html).toContain(`Use ${path}`);
    expect(html).toContain("Choose…");
  });

  it("a card whose computer is missing says so and offers Retry only", () => {
    const html = render(actionCard({ kind: "projects", workspace: "ws_p", workspaceName: "Tiny Acrobatics", device: null, deviceName: "Studio-Mini.local", path }));
    expect(html).toContain("Can&#x27;t find Studio-Mini.local right now: open Creator Toolset on it");
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain(RETRY);
  });

  it("shows nothing without an action", () => {
    expect(render(undefined)).toBe("");
  });
});

describe("ActionCard presses (happy-dom)", () => {
  const mount = (action: ActionNeeded) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<MemoryRouter><ActionCard action={action} /></MemoryRouter>));
    return { host, done: () => (act(() => root.unmount()), host.remove(), vi.unstubAllGlobals()) };
  };

  it("a press sends the action's own request, with its workspace", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { host, done } = mount(projects);
    await act(async () => (host.querySelector("button") as HTMLButtonElement).click());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/devices/storage/folders");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-CT-Workspace"]).toBe("ws_p");
    expect(JSON.parse(String(init.body))).toEqual({ role: "projects", host: "dev-1", path, make: true });
    done();
  });

  it("a refused press shows the server's words and a Retry that sends the same request again", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "The computer said no" }), { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    const { host, done } = mount(setup(true));
    await act(async () => (host.querySelector("button") as HTMLButtonElement).click());
    expect(host.textContent).toContain("The computer said no");
    expect(host.textContent).not.toContain("Try again");
    const retry = [...host.querySelectorAll("button")].find((b) => b.textContent === RETRY)!;
    await act(async () => retry.click());
    expect(fetchMock.mock.calls).toHaveLength(2);
    expect(fetchMock.mock.calls[1]).toEqual(fetchMock.mock.calls[0]);
    done();
  });
});
