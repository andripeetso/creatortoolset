import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ConnectStepView, CONNECT_COMMAND, HERE, PhoneRow } from "./ConnectStep";
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
const view = (over: Partial<typeof base> = {}) => renderToStaticMarkup(<ConnectStepView {...base} {...over} />);

it("shows this computer checked, with its address under its name", () => {
  const html = view();
  expect(html).toContain("Studio Mac");
  expect(html).toContain("http://127.0.0.1:3773/");
  expect(html).toContain('aria-label="Studio Mac"');
  expect(html).toContain('data-state="checked"');
});

it("lists the other computers under Creator Toolset Connect with a checkbox each, and the paste command under them", () => {
  const html = view();
  expect(html).toContain("Creator Toolset Connect");
  expect(html).toContain("Workshop PC");
  expect(html).toContain("Run this on each computer you want to connect.");
  expect(html).toContain(CONNECT_COMMAND);
  expect(html).toContain('aria-label="Copy the command"');
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

it("says plainly that a phone scans the code, above the folded add-a-computer row", () => {
  const html = view({ phone: <PhoneRow /> });
  expect(html).toContain("Add your phone");
  expect(html).toContain("Use Creator Toolset on your phone too. Scan this with your phone");
  expect(html).toContain("Add a computer");
  expect(html).not.toContain("I already have a server");
});

it("opens the join forms under Add a computer, with the server address and the link steps", () => {
  const open = view({ expanded: true, link: "https://studio.example.com/api/auth/link/x" });
  expect(open).toContain("Its address, like studio.example.com");
  expect(open).toContain("paste the link it shows here");
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
  expect(view({ expanded: true })).not.toMatch(/api key/i);
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
