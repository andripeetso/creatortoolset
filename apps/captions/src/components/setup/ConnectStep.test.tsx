import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectStepView, CONNECT_COMMAND, HERE, PhoneRowView, mintPhoneCode, type PhoneState } from "./ConnectStep";
import { serverUrl } from "./computers";

const base = {
  here: { name: "Studio Mac", address: "http://127.0.0.1:3773/" },
  others: [{ id: "d1", name: "Workshop PC", online: false, drivers: [] }],
  picked: new Set([HERE]),
  onPick: () => {},
  phone: <p>PHONE-CODE-HERE</p>,
  expanded: false,
  onExpand: () => {},
  server: "",
  onServer: () => {},
  onServerGo: () => {},
  serverBad: false,
  link: "",
  onLink: () => {},
  onJoin: () => {},
  joinNote: null as { ok: boolean; text: string } | null,
  account: undefined as ReactNode,
};
const view = (over: Partial<typeof base & { pasteCommand: string }> = {}) => renderToStaticMarkup(<ConnectStepView {...base} {...over} />);
const phone = (code: PhoneState | undefined, over: Partial<Parameters<typeof PhoneRowView>[0]> = {}) =>
  renderToStaticMarkup(
    <PhoneRowView code={code} now={1_000} canTurnOn={false} turningOn={false} problem={null} onTurnOn={() => {}} {...over} />,
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

it("shows this computer checked, with its address under its name", () => {
  const html = view();
  expect(html).toContain("Studio Mac");
  expect(html).toContain("http://127.0.0.1:3773/");
  expect(html).toContain('aria-label="Studio Mac"');
  expect(html).toContain('data-state="checked"');
});

it("lists the account's other computers with no checkbox, and no paste command while the package is not published", () => {
  const html = view();
  expect(html).toContain("Creator Toolset Connect");
  expect(html).toContain("Workshop PC");
  expect(html).not.toContain('aria-label="Workshop PC"');
  expect(html).not.toContain(CONNECT_COMMAND);
  expect(html).not.toContain("Run this on each computer");
  expect(html).not.toContain("Copy the command");
});

it("shows the paste command only inside Add another computer, and only when it is given", () => {
  expect(view({ pasteCommand: CONNECT_COMMAND })).not.toContain(CONNECT_COMMAND);
  const open = view({ expanded: true, pasteCommand: CONNECT_COMMAND });
  expect(open).toContain(CONNECT_COMMAND);
  expect(open).toContain("Run this on each computer you want to connect.");
  expect(open).toContain('aria-label="Copy the command"');
});

it("leaves out the Creator Toolset Connect row when it has nothing to show: no other computers and no account", () => {
  expect(view({ others: [] })).not.toContain("Creator Toolset Connect");
  expect(view({ others: [], account: <p>ACCOUNT-HERE</p> })).toContain("Creator Toolset Connect");
});

it("marks a computer that is not running with an amber dot and no label on the ones that are fine", () => {
  const html = view({
    others: [
      { id: "d1", name: "Workshop PC", online: false, drivers: [] },
      { id: "d2", name: "ARCHIVE", online: true, drivers: [] },
    ],
  });
  expect(html).toContain('aria-label="Not running. Open Creator Toolset on it."');
  expect(html).not.toContain("Running");
  expect(html).not.toContain("Connected");
});

it("says what the phone row is for and that it works on the same Wi-Fi, above the folded Add another computer row", () => {
  const html = view({ phone: <PhoneRowView code={undefined} now={0} canTurnOn={false} turningOn={false} problem={null} onTurnOn={() => {}} /> });
  expect(html).toContain("Add your phone");
  expect(html).toContain("Use Creator Toolset on your phone too. Scan this with your phone&#x27;s camera, on the same Wi-Fi.");
  expect(html).toContain("Add another computer");
  expect(html).not.toContain("Add a computer");
  expect(html).not.toContain("I already have a server");
});

it("opens the join forms under Add another computer, with the server address and the link steps", () => {
  const open = view({ expanded: true, link: "https://studio.example.com/api/auth/link/x" });
  expect(open).toContain("Its address, like studio.example.com");
  expect(open).toContain("Settings → Servers, make a sign-in link and paste it here");
  expect(open).toContain('id="ct-server-link"');
  expect(open).toContain("Join");
});

it("says a bad server address when it was refused", () => {
  expect(view({ expanded: true, serverBad: true })).toContain("Enter a web address");
});

it("shows the join result, a refusal in the error colour", () => {
  expect(view({ expanded: true, joinNote: { ok: false, text: "That link has expired." } })).toContain("That link has expired.");
  expect(view({ expanded: true, joinNote: { ok: true, text: "Joined studio.example.com as Workshop PC." } })).toContain("Joined studio.example.com");
});

it("offers the account sign-in only where the Mac app can show it, folded behind Sign in", () => {
  expect(view()).not.toContain("Sign in ›");
  const withAccount = view({ account: <p>ACCOUNT-HERE</p> });
  expect(withAccount).toContain("Sign in ›");
  expect(withAccount).not.toContain("ACCOUNT-HERE");
});

it("never asks for an API key on this step", () => {
  expect(view({ expanded: true, pasteCommand: CONNECT_COMMAND })).not.toMatch(/api key/i);
});

it("tells a person who is not signed in to sign in first, not that the connection failed", () => {
  const html = phone("signin");
  expect(html).toContain("Sign in first, then this code appears here.");
  expect(html).not.toContain("Check the connection");
});

it("offers Access from other devices as a button on a Mac app, and the copy to do it by hand without one", () => {
  const local = phone("local");
  expect(local).toContain("Your phone can&#x27;t reach this computer yet.");
  expect(local).not.toContain("<button");
  expect(local).toContain("In the Creator Toolset Mac app, turn on Access from other devices and choose this computer&#x27;s password");

  const withBridge = phone("local", { canTurnOn: true });
  expect(withBridge).toContain("<button");
  expect(withBridge).toContain("Access from other devices");
  expect(withBridge).not.toContain("In the Creator Toolset Mac app");
  expect(withBridge).toContain("choose this computer&#x27;s password once");
});

it("shows the problem the Mac app gave for turning access on", () => {
  expect(phone("local", { canTurnOn: true, problem: "Choose this computer's password to turn it on." })).toContain("Choose this computer&#x27;s password to turn it on.");
});

it("draws the live code with its QR, and drops it once it has run out", () => {
  const code = { url: "http://tiny-mac.local:3773/api/auth/link/abc", qr: "data:image/png;base64,AAAA", expiresAt: 61_000 };
  expect(phone(code, { now: 1_000 })).toContain('src="data:image/png;base64,AAAA"');
  expect(phone(code, { now: 61_000 })).not.toContain("<img");
});

it("maps the server's answers: a code, local, sign in first (401), or no code", async () => {
  const answer = (status: number, body?: unknown) => vi.stubGlobal("fetch", async () => new Response(body === undefined ? null : JSON.stringify(body), { status }));
  answer(401, { error: "Sign in with an account first" });
  expect(await mintPhoneCode()).toBe("signin");
  answer(500);
  expect(await mintPhoneCode()).toBeNull();
  answer(200, { url: null, path: null, expiresAt: null });
  expect(await mintPhoneCode()).toBe("local");
  answer(200, { url: "http://tiny-mac.local:3773", path: "/api/auth/link/abc", expiresAt: 60_000 });
  const code = await mintPhoneCode();
  expect(typeof code === "object" && code !== null && code.url).toBe("http://tiny-mac.local:3773/api/auth/link/abc");
});

it("accepts a bare or https server address and keeps only its origin", () => {
  expect(serverUrl("studio.example.com")).toBe("https://studio.example.com");
  expect(serverUrl("https://studio.example.com/some/path?x=1")).toBe("https://studio.example.com");
  expect(serverUrl("  https://box.example.com  ")).toBe("https://box.example.com");
});

it("allows plain http only on this network, and refuses other schemes and empty input", () => {
  expect(serverUrl("http://localhost:3000")).toBe("http://localhost:3000");
  expect(serverUrl("http://studio-mac.local:3000")).toBe("http://studio-mac.local:3000");
  expect(serverUrl("localhost:3102")).toBe("http://localhost:3102"); // a bare name on this network is plain http
  expect(serverUrl("http://studio.example.com")).toBeNull();
  expect(serverUrl("javascript:alert(1)")).toBeNull();
  expect(serverUrl("ftp://studio.example.com")).toBeNull();
  expect(serverUrl("   ")).toBeNull();
});

it("on a hosted server: no row for this server and no add-a-computer form, the Mac app line instead", () => {
  const html = renderToStaticMarkup(<ConnectStepView {...base} hosted />);
  expect(html).not.toContain('aria-label="Studio Mac"');
  expect(html).not.toContain("Add a computer");
  expect(html).toContain("Creator Toolset Mac app");
});
