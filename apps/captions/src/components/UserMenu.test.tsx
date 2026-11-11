// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@/lib/auth";
import { UserMenu } from "./UserMenu";

// The account menu in the Mac app lists the servers it opens; picking another one asks once, then tells the app.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let sent: string[];
let root: Root | undefined;
let host: HTMLDivElement | undefined;

beforeEach(() => {
  sent = [];
  localStorage.clear();
  document.documentElement.dataset.macThisMac = "1";
  vi.stubGlobal("webkit", { messageHandlers: { window: { postMessage: (m: string) => sent.push(m) } } });
  vi.stubGlobal("confirm", () => true);
  useAuth.setState({ required: false, me: { username: "owner", role: "admin", cloud: false, off: [] } });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = undefined;
  delete document.documentElement.dataset.macThisMac;
  vi.unstubAllGlobals();
});

describe("the account menu's servers", () => {
  it("marks the open server and switches to another one", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<MemoryRouter><UserMenu /></MemoryRouter>));

    const trigger = host.querySelector("button")!;
    act(() => {
      trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false }));
    });
    expect(sent).toContain("thismac-state");

    const servers = [
      { id: "this-mac", name: "This Mac", url: "", current: true },
      { id: "b", name: "Studio", url: "https://studio.example.com", current: false },
    ];
    act(() => { window.dispatchEvent(new CustomEvent("mac-this", { detail: { servers } })); });

    const items = [...document.querySelectorAll('[role="menuitem"]')];
    const studio = items.find((i) => i.textContent?.includes("Studio"))!;
    expect(items.find((i) => i.textContent?.includes("This Mac"))!.querySelector(".lucide-check")).not.toBeNull();
    expect(studio.querySelector(".lucide-check")).toBeNull();

    await act(async () => { (studio as HTMLElement).click(); });
    expect(sent).toContain("thismac-select:b");
  });
});
