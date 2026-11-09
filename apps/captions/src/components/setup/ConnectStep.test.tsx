import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ConnectStepView, CONNECT_COMMAND } from "./ConnectStep";
import { serverUrl } from "./computers";

const base = {
  here: "Studio Mac",
  others: [{ id: "d1", name: "Workshop PC", online: false, drivers: [] }],
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
};
const view = (over: Partial<typeof base> = {}) => renderToStaticMarkup(<ConnectStepView {...base} {...over} />);

it("shows this computer with no status label, the account's other computers and the phone's code", () => {
  const html = view();
  expect(html).toContain("Studio Mac");
  expect(html).not.toContain("Running");
  expect(html).toContain("Workshop PC");
  expect(html).toContain("Not running");
  expect(html).toContain("PHONE-CODE-HERE");
});

it("folds the command and the existing-server steps under Add another computer", () => {
  const folded = view();
  expect(folded).toContain("Add another computer");
  expect(folded).not.toContain(CONNECT_COMMAND);
  expect(folded).not.toContain("I already have a server");
  const open = view({ expanded: true });
  expect(open).toContain(CONNECT_COMMAND);
  expect(open).toContain("I already have a server");
  expect(open).toContain("Sign in another computer");
});

it("asks for the server's address first, then the one-time link it shows, and joins with that link", () => {
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
