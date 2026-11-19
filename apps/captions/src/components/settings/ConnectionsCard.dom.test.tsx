// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConnectionsCard, reachLine, ReachFromAnywhereRow } from "./ConnectionsCard";
import type { ThisMacState } from "./ThisMacSection";

// Settings → Computers → This Mac: Network access, the addresses it is reachable at, and Reach from anywhere.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let endpoints: unknown;
beforeEach(() => {
  endpoints = [];
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(endpoints), { headers: { "content-type": "application/json" } })));
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  delete (window as { webkit?: unknown }).webkit;
});

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const text = () => document.body.textContent ?? "";
const mac = (over: Partial<ThisMacState>) => ({ aiOn: false, paired: true, linked: false, account: true, reach: null, ...over }) as ThisMacState;

it("says each Reach from anywhere state the Mac app reports", () => {
  expect(reachLine(mac({ account: false }))).toBe("Sign in to make this Mac available to your other devices.");
  expect(reachLine(mac({ linked: false }))).toBe("Make this Mac available to your other devices through your account.");
  expect(reachLine(mac({ linked: true, reach: "unreachable" }))).toBe("On, but other devices can't reach this Mac.");
  expect(reachLine(mac({ linked: true, reach: "reachable" }))).toBe("Available to your other devices through your account.");
  expect(reachLine(mac({ linked: false, reach: "removed" }))).toBe("This Mac was removed from your account. Turn it on to add it again.");
});

it("draws no Reach from anywhere outside the Mac app, or from an app that does not report it", async () => {
  act(() => root.render(<ReachFromAnywhereRow mac={null} />));
  expect(document.body.innerHTML).toBe("<div></div>");
  act(() => root.render(<ReachFromAnywhereRow mac={mac({ linked: undefined })} />));
  expect(document.body.innerHTML).toBe("<div></div>");
  act(() => root.render(<ReachFromAnywhereRow mac={mac({ linked: true, reach: "reachable" })} />));
  expect(text()).toContain("Reach from anywhere");
  expect(document.querySelector('[aria-label="Reach from anywhere"]')!.getAttribute("aria-checked")).toBe("true");
});

it("turns Reach from anywhere on through the Mac app, and shows its problem", async () => {
  const postMessage = vi.fn(async () => ({ aiOn: false, paired: true, problem: "Your account has three computers already." }));
  (window as { webkit?: unknown }).webkit = { messageHandlers: { thisMac: { postMessage } } };
  act(() => root.render(<ReachFromAnywhereRow mac={mac({ linked: false })} />));
  act(() => document.querySelector<HTMLElement>('[aria-label="Reach from anywhere"]')!.click());
  await flush();
  expect(postMessage).toHaveBeenCalledWith("connect.link");
  expect(text()).toContain("Your account has three computers already.");
});

it("in a browser: Network access says where this computer is reachable, and its switch is the Mac app's", async () => {
  endpoints = [
    { kind: "lan", httpBaseUrl: "http://tiny-mac.local:3773" },
    { kind: "tailnet", httpBaseUrl: "http://tiny-mac.vpn.example:3773" },
  ];
  act(() => root.render(<ConnectionsCard inMac={false} mac={null} />));
  await flush();
  expect(text()).toContain("This computer");
  expect(text()).toContain("Reachable on your network at tiny-mac.local:3773.");
  expect(text()).toContain("Reachable at http://tiny-mac.vpn.example:3773");
  const sw = document.querySelector<HTMLButtonElement>('[aria-label="Network access"]')!;
  expect(sw.getAttribute("aria-checked")).toBe("true");
  expect(sw.disabled).toBe(true);
  expect(text()).not.toContain("Reach from anywhere");
});

it("in the Mac app with Network access off: only this Mac can connect, and the switch asks the app", async () => {
  const postMessage = vi.fn(async () => ({ aiOn: false, paired: true, problem: "Could not restart the server." }));
  (window as { webkit?: unknown }).webkit = { messageHandlers: { thisMac: { postMessage } } };
  act(() => root.render(<ConnectionsCard inMac mac={mac({ linked: false })} />));
  await flush();
  expect(text()).toContain("Only this Mac can connect.");
  const sw = document.querySelector<HTMLButtonElement>('[aria-label="Network access"]')!;
  expect(sw.getAttribute("aria-checked")).toBe("false");
  act(() => sw.click());
  await flush();
  expect(postMessage).toHaveBeenCalledWith("access");
  expect(text()).toContain("Could not restart the server.");
});
