// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AccessView, ClientSession, CreatedLink } from "@/lib/access";

// Settings → Computers → Phones: pairing links (create, copy, expire, revoke) and the signed-in devices, live from the
// server's access events.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock("qrcode", () => ({ default: { toDataURL: async (url: string) => `data:image/png;base64,${btoa(url)}` } }));
const { PhonesSection } = await import("./SignedInClients");
const { PairingLinkCard } = await import("./PairingLinks");

const NOW = Date.parse("2026-11-18T12:00:00Z");
const phone: ClientSession = {
  sessionId: "s-phone",
  subject: "admin",
  method: "bearer-access-token",
  issuedAt: new Date(NOW - 86_400_000).toISOString(),
  expiresAt: new Date(NOW + 86_400_000).toISOString(),
  scopes: ["read", "write", "access"],
  client: { label: "Tiny iPhone", deviceType: "mobile", os: "iOS 26", appVersion: "1.4.0" },
  lastConnectedAt: new Date(NOW - 3 * 60_000).toISOString(),
  connected: true,
  current: false,
};
const browser: ClientSession = {
  sessionId: "s-here",
  subject: "admin",
  method: "dpop-access-token",
  issuedAt: new Date(NOW - 86_400_000).toISOString(),
  expiresAt: new Date(NOW + 86_400_000).toISOString(),
  scopes: ["read", "write", "access"],
  client: { deviceType: "desktop", os: "macOS", userAgent: "Safari" },
  lastConnectedAt: new Date(NOW - 60 * 60_000).toISOString(),
  connected: true,
  current: true,
};
const ipad: ClientSession = {
  sessionId: "s-ipad",
  subject: "admin",
  method: "bearer-access-token",
  issuedAt: new Date(NOW - 86_400_000).toISOString(),
  expiresAt: new Date(NOW + 86_400_000).toISOString(),
  scopes: ["read"],
  client: { label: "Living room iPad", deviceType: "tablet", os: "iPadOS 26", appVersion: "1.4.0" },
  lastConnectedAt: null,
  connected: false,
  current: false,
};

/** The access events: the test sends them as the server would. */
class FakeSource {
  static last: FakeSource | null = null;
  listeners = new Map<string, (e: MessageEvent) => void>();
  revision = 0;
  constructor() {
    FakeSource.last = this;
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, fn);
  }
  close() {}
  send(type: string, data: unknown) {
    act(() => this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify({ version: 1, revision: ++this.revision, type, payload: data }) })));
  }
}

let calls: { method: string; url: string; body?: unknown }[];
let view: AccessView;
let created: CreatedLink;
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  calls = [];
  view = { pairingLinks: [], clientSessions: [phone, browser] };
  created = { id: "pl-new", subject: "admin", credential: "AAAABBBBCCCC", label: "Living room iPad", scopes: ["read"], createdAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 5 * 60_000).toISOString(), urls: [
    { kind: "lan", url: "http://tiny-mac.local:3773/#token=AAAABBBBCCCC" },
    { kind: "tailnet", url: "http://tiny-mac.vpn.example:3773/#token=AAAABBBBCCCC" },
  ] };
  vi.stubGlobal("EventSource", FakeSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const out = url === "/api/auth/access" ? view : url === "/api/auth/pairing-links" ? created : {};
      return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
    }),
  );
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const text = () => document.body.textContent ?? "";
const button = (name: string, within: ParentNode = document.body) =>
  [...within.querySelectorAll("button")].find((b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name) as HTMLButtonElement;
const click = (b: HTMLElement) => act(() => b.click());

function Page({ startCreate = false }: { startCreate?: boolean }) {
  const [create, setCreate] = useState(startCreate);
  return <PhonesSection create={create} onCreateChange={setCreate} />;
}
async function show(startCreate = false) {
  act(() => root.render(<Page startCreate={startCreate} />));
  await flush();
}

it("lists the signed-in devices: name, os and app version, how they are connected, This device without Revoke", async () => {
  await show();
  expect(text()).toContain("Tiny iPhone");
  expect(text()).toContain("iOS 26 · 1.4.0");
  expect(text()).toContain("Connected for 3 min");
  expect(text()).toContain("This device");
  // this device is the one row without a Revoke of its own
  expect(document.querySelectorAll("button").length).toBe(3); // Revoke others, Create link, the phone's Revoke
  expect(button("Revoke others").disabled).toBe(false);
});

it("follows the access events: a new device, a removed one, and a snapshot that replaces the list", async () => {
  await show();
  FakeSource.last!.send("clientUpserted", ipad);
  expect(text()).toContain("Living room iPad");
  expect(text()).toContain("iPadOS 26 · 1.4.0 · Read only");
  expect(text()).toContain("Not connected yet.");
  FakeSource.last!.send("clientUpserted", { ...ipad, connected: false, lastConnectedAt: NOW - 5_000 });
  expect(text()).toContain("Last connected at");
  FakeSource.last!.send("clientRemoved", { sessionId: "s-phone" });
  expect(text()).not.toContain("Tiny iPhone");
  FakeSource.last!.send("snapshot", { pairingLinks: [], clientSessions: [browser] });
  expect(text()).not.toContain("Living room iPad");
  expect(button("Revoke others").disabled).toBe(true); // only this device is left
});

it("creates a Read only link with its name, and shows its card with the QR code open, its addresses and its code", async () => {
  await show(true);
  const name = document.querySelector<HTMLInputElement>('input[placeholder="e.g. Living room iPad"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Living room iPad");
    name.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const standard = [...document.querySelectorAll('[role="radio"]')].find((r) => r.textContent?.includes("Standard"))!;
  expect(standard.getAttribute("aria-checked")).toBe("true"); // Standard until another is picked
  click([...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((r) => r.textContent?.includes("Read only"))!);
  click(button("Create link", document.querySelector('[role="dialog"]')!));
  await flush();
  expect(calls.find((c) => c.url === "/api/auth/pairing-links")).toEqual({ method: "POST", url: "/api/auth/pairing-links", body: { label: "Living room iPad", scopes: ["read"], deviceType: "mobile" } });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  const card = document.querySelector('[data-pairing-link="pl-new"]')!;
  expect(card.textContent).toContain("Living room iPad");
  expect(card.textContent).toContain("Expires in 5m · Read only");
  // two addresses: a list to pick the one the QR code and link use, the first picked
  const addresses = card.querySelectorAll('[role="radiogroup"] [role="radio"]');
  expect([...addresses].map((a) => a.textContent)).toEqual(["Local networktiny-mac.local:3773", "Tailnettiny-mac.vpn.example:3773"]);
  expect(card.querySelector("code")!.textContent).toBe("http://tiny-mac.local:3773/#token=AAAABBBBCCCC");
  click(addresses[1] as HTMLElement);
  expect(card.querySelector("code")!.textContent).toBe("http://tiny-mac.vpn.example:3773/#token=AAAABBBBCCCC");
  await flush();
  expect(card.querySelector("img")!.getAttribute("src")).toBe(`data:image/png;base64,${btoa("http://tiny-mac.vpn.example:3773/#token=AAAABBBBCCCC")}`);
  // the QR code folds away and back
  click(button("QR code", card));
  expect(card.querySelector("img")).toBeNull();
  expect(button("Copy code", card)).toBeTruthy();
});

it("drops a link once it runs out, counting down to it", async () => {
  view.pairingLinks = [{ id: "pl-old", label: "Kitchen phone", scopes: ["read", "write", "access"], subject: "admin", createdAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 65_000).toISOString() }];
  await show();
  const card = () => document.querySelector('[data-pairing-link="pl-old"]');
  expect(card()!.textContent).toContain("Expires in 1m 5s · Standard");
  // a link this page did not make has no code to show
  expect(card()!.textContent).toContain("Its code shows only in the window that made it.");
  act(() => void vi.advanceTimersByTime(10_000));
  expect(card()!.textContent).toContain("Expires in 55s");
  act(() => void vi.advanceTimersByTime(56_000));
  expect(card()).toBeNull();
});

it("shows the code to copy by hand where the clipboard can't take it", async () => {
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: async () => Promise.reject(new Error("denied")) } });
  act(() => root.render(<PairingLinkCard link={created} created={created} now={NOW} onRevoke={async () => {}} />));
  click(button("Copy code"));
  await flush();
  expect(text()).toContain("Copying is not available here. Copy it by hand:");
  expect(document.querySelector<HTMLInputElement>("input[readonly]")!.value).toBe("AAAABBBBCCCC");
});

it("copies the code when the clipboard works", async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  act(() => root.render(<PairingLinkCard link={created} created={created} now={NOW} onRevoke={async () => {}} />));
  click(button("Copy code"));
  await flush();
  expect(writeText).toHaveBeenCalledWith("AAAABBBBCCCC");
  expect(document.querySelector("input[readonly]")).toBeNull();
});

it("revokes a link, one device, and every other device", async () => {
  view.pairingLinks = [{ id: "pl-old", scopes: ["read"], subject: "admin", createdAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 60_000).toISOString() }];
  view.clientSessions = [phone, ipad, browser];
  await show();
  click(button("Revoke", document.querySelector('[data-pairing-link="pl-old"]')!));
  await flush();
  expect(calls.at(-1)).toEqual({ method: "POST", url: "/api/auth/pairing-links/revoke", body: { id: "pl-old" } });
  expect(document.querySelector('[data-pairing-link="pl-old"]')).toBeNull();

  const phoneRow = [...document.querySelectorAll("[class*=grid]")].find((r) => r.textContent?.includes("Tiny iPhone"))!;
  click(button("Revoke", phoneRow));
  await flush();
  expect(calls.at(-1)).toEqual({ method: "POST", url: "/api/auth/clients/revoke", body: { sessionId: "s-phone" } });
  expect(text()).not.toContain("Tiny iPhone");

  click(button("Revoke others"));
  await flush();
  expect(calls.at(-1)).toEqual({ method: "POST", url: "/api/auth/clients/revoke-others", body: {} });
  expect(text()).not.toContain("Living room iPad");
  expect(text()).toContain("This device");
});
