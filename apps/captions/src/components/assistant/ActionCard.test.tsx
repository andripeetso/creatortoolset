// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { LIBRARY_SETUP_DONE, LIBRARY_WORDS, type ActionNeeded } from "@contracts/library";
import { ActionCard, resumesOn, setUpIn } from "./ActionCard";

const setup = (owner: boolean): ActionNeeded => ({ kind: "setup", workspace: "ws_p", workspaceName: "Tiny Acrobatics", owner, href: "/library?setup=1" });
const render = (action?: ActionNeeded) => renderToStaticMarkup(<MemoryRouter><ActionCard action={action} ask="make a reel" /></MemoryRouter>);

describe("ActionCard", () => {
  it("the owner's setup card says the exact words and has a Set up button", () => {
    const html = render(setup(true));
    expect(html).toContain(LIBRARY_WORDS.setupCard("Tiny Acrobatics"));
    expect(html).toContain(LIBRARY_WORDS.setupButton);
  });

  it("a member's setup card says it isn't set up, with no button", () => {
    const html = render(setup(false));
    expect(html).toContain(LIBRARY_WORDS.setupCardMember.replace(/'/g, "&#x27;"));  // static markup escapes the apostrophe
    expect(html).not.toContain(LIBRARY_WORDS.setupButton);
  });

  it("the downloads card asks with the words and a Turn on button", () => {
    const html = render({ kind: "downloads", libraryId: "lib_p", workspace: "ws_p" });
    expect(html).toContain(LIBRARY_WORDS.downloadsCard);
    expect(html).toContain(LIBRARY_WORDS.downloadsButton);
  });

  it("shows nothing without an action", () => {
    expect(render(undefined)).toBe("");
  });

  it("resumes only on the setup done of its own workspace", () => {
    expect(resumesOn(setup(true), "ws_p")).toBe(true);
    expect(resumesOn(setup(true), "ws_other")).toBe(false);
    expect(resumesOn({ kind: "downloads", libraryId: "lib_p", workspace: "ws_p" }, "ws_p")).toBe(false);
  });
});

describe("ActionCard resume (happy-dom)", () => {
  const mount = (action: ActionNeeded, ask: string, onContinue: (text: string) => void) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<MemoryRouter><ActionCard action={action} ask={ask} onContinue={onContinue} /></MemoryRouter>));
    return { host, root };
  };
  const done = (workspace: string) => act(() => void window.dispatchEvent(new CustomEvent(LIBRARY_SETUP_DONE, { detail: { workspace } })));

  it("continues the ask once when its own workspace is set up, and not for another", () => {
    const calls: string[] = [];
    const { root, host } = mount(setup(true), "make a reel", (t) => calls.push(t));
    done("ws_other");
    expect(calls).toEqual([]);
    done("ws_p");
    done("ws_p");
    expect(calls).toEqual(["make a reel"]);
    act(() => root.unmount());
    host.remove();
  });

  it("Turn on writes Downloads needed, then continues the ask with the downloads words once", async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const calls: string[] = [];
    const { root, host } = mount({ kind: "downloads", libraryId: "lib_p", workspace: "ws_p" }, "make a reel", (t) => calls.push(t));
    const button = host.querySelector("button") as HTMLButtonElement;
    await act(async () => button.click());
    await act(async () => undefined);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/library/offline/downloads");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("PUT");
    expect(bodies).toEqual([{ libraryId: "lib_p", mode: "needed" }]);
    expect(calls).toEqual([LIBRARY_WORDS.downloadsDone("make a reel")]);
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("a failed Turn on says so and continues nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    const calls: string[] = [];
    const { root, host } = mount({ kind: "downloads", libraryId: "lib_p", workspace: "ws_p" }, "make a reel", (t) => calls.push(t));
    await act(async () => (host.querySelector("button") as HTMLButtonElement).click());
    await act(async () => undefined);
    expect(host.textContent).toContain("Could not turn it on. Try again.");
    expect(calls).toEqual([]);
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("the library list says set up when any library has setupAt", () => {
    expect(setUpIn([{ settings: {} }, { settings: { setupAt: "2026-11-18T10:00:00.000Z" } }])).toBe(true);
    expect(setUpIn([{ settings: {} }])).toBe(false);
    expect(setUpIn([])).toBe(false);
  });
});
