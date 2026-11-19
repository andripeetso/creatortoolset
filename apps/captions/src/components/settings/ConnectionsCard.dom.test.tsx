// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConnectionsCard, PhoneNotificationsRow, reachLine, ReachFromAnywhereRow } from "./ConnectionsCard";
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
const mac = (over: Partial<ThisMacState>) => ({ aiOn: false, paired: true, linked: false, reach: null, ...over }) as ThisMacState;

it("says each Reach from anywhere state the Mac app reports", () => {
  // the Mac app's Reach raw values (apps/mac Connect.swift; ConnectTests checks the same five)
  expect(reachLine("signed-out")).toBe("Sign in to make this Mac available to your other devices.");
  expect(reachLine("off")).toBe("Make this Mac available to your other devices through your account.");
  expect(reachLine("unreachable")).toBe("On, but other devices can't reach this Mac.");
  expect(reachLine("available")).toBe("Available to your other devices through your account.");
  expect(reachLine("removed")).toBe("This Mac was removed from your account. Turn it on to add it again.");
});

it("draws no Reach from anywhere outside the Mac app, or from an app that does not report it", async () => {
  act(() => root.render(<ReachFromAnywhereRow mac={null} />));
  expect(document.body.innerHTML).toBe("<div></div>");
  act(() => root.render(<ReachFromAnywhereRow mac={mac({ reach: undefined })} />));
  expect(document.body.innerHTML).toBe("<div></div>");
  act(() => root.render(<ReachFromAnywhereRow mac={mac({ reach: null })} />));
  expect(document.body.innerHTML).toBe("<div></div>");
  act(() => root.render(<ReachFromAnywhereRow mac={mac({ linked: true, reach: "unreachable" })} />));
  expect(text()).toContain("Reach from anywhere");
  expect(document.querySelector('[aria-label="Reach from anywhere"]')!.getAttribute("aria-checked")).toBe("true");
  act(() => root.render(<ReachFromAnywhereRow mac={mac({ reach: "removed" })} />));
  expect(document.querySelector('[aria-label="Reach from anywhere"]')!.getAttribute("aria-checked")).toBe("false");
  act(() => root.render(<ReachFromAnywhereRow mac={mac({ reach: "signed-out" })} />));
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Reach from anywhere"]')!.disabled).toBe(true);
});

it("turns Reach from anywhere on through the Mac app, and shows its problem", async () => {
  const postMessage = vi.fn(async () => ({ aiOn: false, paired: true, problem: "Your account has three computers already." }));
  (window as { webkit?: unknown }).webkit = { messageHandlers: { thisMac: { postMessage } } };
  act(() => root.render(<ReachFromAnywhereRow mac={mac({ reach: "off" })} />));
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
  expect(text()).toContain("Tailnet");
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

it("in the Mac app with Network access on: the switch turns it off through the app", async () => {
  endpoints = [{ kind: "lan", httpBaseUrl: "http://tiny-mac.local:3773" }];
  const postMessage = vi.fn(async () => ({ aiOn: false, paired: true, problem: "Could not restart the server." }));
  (window as { webkit?: unknown }).webkit = { messageHandlers: { thisMac: { postMessage } } };
  act(() => root.render(<ConnectionsCard inMac mac={mac({})} />));
  await flush();
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="Network access"]')!.click());
  await flush();
  expect(postMessage).toHaveBeenCalledWith("access:off");
});

it("Send notifications to your phones: only on a linked computer, and the switch saves through the server", async () => {
  let notify = { linked: false, on: true };
  const sent: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") sent.push(JSON.parse(String(init.body))), (notify = { linked: true, on: false });
    return new Response(JSON.stringify(notify), { headers: { "content-type": "application/json" } });
  }));
  act(() => root.render(<PhoneNotificationsRow />));
  await flush();
  expect(text()).not.toContain("Send notifications to your phones");
  act(() => root.unmount());
  notify = { linked: true, on: true };
  root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<PhoneNotificationsRow />));
  await flush();
  const sw = document.querySelector<HTMLButtonElement>('[aria-label="Send notifications to your phones"]')!;
  expect(sw.getAttribute("aria-checked")).toBe("true");
  act(() => sw.click());
  await flush();
  expect(sent).toEqual([{ on: false }]);
  expect(sw.getAttribute("aria-checked")).toBe("false");
});

it("Send notifications to your phones: not drawn for someone who isn't the owner", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Only the owner can change this" }), { status: 403 })));
  act(() => root.render(<PhoneNotificationsRow />));
  await flush();
  expect(document.body.innerHTML).toBe("<div></div>");
});
