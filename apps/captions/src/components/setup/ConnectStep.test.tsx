import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ConnectStepView, CONNECT_COMMAND } from "./ConnectStep";
import { serverUrl } from "./computers";

const base = {
  here: "Studio Mac",
  others: [{ id: "d1", name: "Workshop PC", online: false, drivers: [] }],
  address: "https://creatortoolset.com",
  expanded: false,
  onExpand: () => {},
  server: "",
  onServer: () => {},
  onServerGo: () => {},
  serverBad: false,
};
const view = (over: Partial<typeof base> = {}) => renderToStaticMarkup(<ConnectStepView {...base} {...over} />);

it("shows this computer as running, the account's other computers and the phone address", () => {
  const html = view();
  expect(html).toContain("Studio Mac");
  expect(html).toContain("Running");
  expect(html).toContain("Workshop PC");
  expect(html).toContain("Not running");
  expect(html).toContain("Add your phone");
  expect(html).toContain("https://creatortoolset.com");
});

it("folds the command and the existing-server row under Add another computer", () => {
  const folded = view();
  expect(folded).toContain("Add another computer");
  expect(folded).not.toContain(CONNECT_COMMAND);
  expect(folded).not.toContain("I already have a server");
  const open = view({ expanded: true });
  expect(open).toContain(CONNECT_COMMAND);
  expect(open).toContain("I already have a server");
});

it("says a bad server address when it was refused", () => {
  expect(view({ expanded: true, serverBad: true })).toContain("Enter a web address");
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
