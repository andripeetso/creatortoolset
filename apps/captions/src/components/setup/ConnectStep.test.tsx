import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectStepView, CONNECT_COMMAND, HERE, PhoneRowView, mintPhoneLink, type PhoneState } from "./ConnectStep";
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
const view = (over: Partial<Parameters<typeof ConnectStepView>[0]> = {}) => renderToStaticMarkup(<ConnectStepView {...base} {...over} />);
const phone = (code: PhoneState | undefined, over: Partial<Parameters<typeof PhoneRowView>[0]> = {}) =>
  renderToStaticMarkup(
    <PhoneRowView code={code} now={1_000} onCreate={() => {}} onRevoke={async () => {}} {...over} />,
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

it("says what the phone row is for, above the folded Add another computer row", () => {
  const html = view({ phone: <PhoneRowView code={undefined} now={0} onCreate={() => {}} onRevoke={async () => {}} /> });
  expect(html).toContain("Add your phone");
  expect(html).toContain("Scan the QR code with your phone&#x27;s camera.");
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

const link = { id: "pl1", subject: "admin", credential: "AAAABBBBCCCC", scopes: ["read", "write", "access"] as const, createdAt: new Date(0).toISOString(), expiresAt: new Date(61_000).toISOString(), urls: [{ kind: "lan" as const, url: "http://tiny-mac.local:3773/#token=AAAABBBBCCCC" }] };
const made = { ...link, scopes: [...link.scopes] };

it("tells a person who is not signed in to sign in first, not that the connection failed", () => {
  const html = phone("signin");
  expect(html).toContain("Sign in first, then the link appears here.");
  expect(html).not.toContain("Check the connection");
});

it("never sends a person to Network access or a password first: the link is made at once", () => {
  for (const c of [undefined, "signin", null, "gone", made] as PhoneState[]) {
    const html = phone(c);
    expect(html).not.toContain("Network access");
    expect(html).not.toMatch(/password/i);
  }
});

it("draws the live link as the pairing card, and offers Create link once it is gone", () => {
  const live = phone(made, { now: 1_000 });
  expect(live).toContain("Pairing link");
  expect(live).toContain("Expires in 1m");
  expect(live).toContain("Copy code");
  expect(live).toContain("Revoke");
  expect(live).not.toContain("Create link");
  expect(phone(made, { now: 61_000 })).not.toContain("Copy code");
  expect(phone("gone")).toContain("Create link");
  expect(phone(null)).toContain("Create link");
});

it("marks the phone row unplaced only while its height is not known: making a link with no space held, or waiting for the list above", () => {
  const unplaced = (html: string) => html.includes("data-unplaced");
  expect(unplaced(phone(undefined))).toBe(true); // a first visit: a link is being made
  expect(unplaced(phone(undefined, { hold: true }))).toBe(false); // the last answer was a link: its space is held
  expect(unplaced(phone("gone"))).toBe(false);
  expect(unplaced(phone(made))).toBe(false);
  expect(unplaced(phone("gone", { wait: true }))).toBe(true); // the other computers are not known yet
});

it("makes a Standard link, and maps a refusal: sign in first (401) or no link", async () => {
  const bodies: unknown[] = [];
  const answer = (status: number, body?: unknown) =>
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(body === undefined ? null : JSON.stringify(body), { status });
    });
  answer(401, { error: "Sign in first" });
  expect(await mintPhoneLink()).toBe("signin");
  answer(500);
  expect(await mintPhoneLink()).toBeNull();
  answer(200, made);
  expect(await mintPhoneLink()).toEqual(made);
  expect(bodies.at(-1)).toEqual({ scopes: ["read", "write", "access"] });
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

it("offers Add this computer while this Mac is not on the account, says to answer in the browser while it waits, and shows a refusal", () => {
  const add = { onAdd: () => {}, busy: false };
  expect(view()).not.toContain("Add this computer");
  const idle = view({ addHere: add });
  expect(idle).toContain("Creator Toolset Connect");
  expect(idle).toContain("Add this computer");
  expect(view({ addHere: { ...add, busy: true } })).toContain("Say yes in your browser");
  expect(view({ addHere: { ...add, problem: "This Mac was not added: the code ran out, start again" } })).toContain("the code ran out");
});
