// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import { CARD_HTML } from "../../api/mcp-card-view";

// The card's page run against a stand-in for the AI app around it: the app answers ui/initialize, then hands the
// page a tool's answer, and the page draws it and says how tall it is.

type Msg = { jsonrpc: "2.0"; id?: number; method?: string; params?: any; result?: any };
const script = /<script>([\s\S]*)<\/script>/.exec(CARD_HTML)![1]!;
let sent: Msg[] = [];
const host = { postMessage: (m: Msg) => void sent.push(m) };
const say = (data: Msg) => window.dispatchEvent(new MessageEvent("message", { data, source: host as unknown as Window }));
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  sent = [];
  document.body.innerHTML = '<div id="c"></div>';
  Object.defineProperty(window, "parent", { value: host, configurable: true });
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(script)();
  const init = sent.find((m) => m.method === "ui/initialize")!;
  expect(init.params).toMatchObject({ protocolVersion: "2026-01-26", appInfo: { name: "creator-toolset-card" } });
  say({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: "2026-01-26", hostInfo: { name: "test" }, hostCapabilities: {}, hostContext: { theme: "dark" } } });
  await tick();
});

it("shakes hands, takes the app's theme, draws a script and reports its height", () => {
  expect(sent.some((m) => m.method === "ui/notifications/initialized")).toBe(true);
  expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  say({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: { content: [{ type: "text", text: "{}" }], _meta: { card: { kind: "script", title: "Tiny tumbles", status: "toPost", href: "https://x.test/workshop/sessions/s1", pieces: [{ id: "p", kind: "reel", locked: ["b1"], blocks: [{ id: "b1", text: "<b>Hook</b> line" }, { id: "b2", text: "Second" }], caption: "The post description" }] } } },
  });
  const text = document.getElementById("c")!.textContent!;
  expect(text).toContain("Tiny tumbles");
  expect(text).toContain("Ready to post");
  // text goes in as text, never as markup
  expect(text).toContain("<b>Hook</b> line");
  expect(document.querySelector("#c b")).toBeNull();
  expect(text).toContain("Locked");
  expect(text).toContain("The post description");
  expect(sent.some((m) => m.method === "ui/notifications/size-changed" && typeof m.params.height === "number")).toBe(true);

  // the button opens the session through the app around the card
  (document.querySelector("button.btn.p") as HTMLButtonElement).click();
  expect(sent.find((m) => m.method === "ui/open-link")!.params).toEqual({ url: "https://x.test/workshop/sessions/s1" });
});

it("draws footage with a fold, and an edit that asks again through the app", async () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ title: `Clip ${i + 1}`, type: "video", s: 65, roll: "a", said: { at: "0:07", text: "sleep" } }));
  say({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { _meta: { card: { kind: "footage", q: "sleep", total: 10, href: "https://x.test/library", items } } } });
  expect(document.querySelectorAll("button.tile:not([hidden])").length).toBe(8);
  expect(document.getElementById("c")!.textContent).toContain("1:05");
  (document.querySelector("button.more") as HTMLButtonElement).click();
  expect(document.querySelectorAll("button.tile:not([hidden])").length).toBe(10);

  say({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { _meta: { card: { kind: "edit", id: "e1", title: "Morning", href: "https://x.test/editor/e1", running: true, drafts: [] } } } });
  expect(document.getElementById("c")!.textContent).toContain("Working");
  [...document.querySelectorAll("button.btn")].find((b) => b.textContent === "Refresh")!.dispatchEvent(new Event("click"));
  const again = sent.find((m) => m.method === "tools/call")!;
  expect(again.params).toEqual({ name: "editor_get", arguments: { edit: "e1" } });
  say({ jsonrpc: "2.0", id: again.id, result: { _meta: { card: { kind: "edit", id: "e1", title: "Morning", drafts: [{ name: "A", title: "Cut A", preview: "in Review" }] } } } });
  await tick();
  expect(document.getElementById("c")!.textContent).toContain("Ready in Review");
});

it("an answer without a card says what arrived instead of staying blank", () => {
  say({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [{ type: "text", text: "{}" }] } });
  expect(document.getElementById("c")!.textContent).toContain("Nothing to show here (content; apps)");
});

it("a refused call leaves the frame empty", () => {
  say({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [{ type: "text", text: "Not found, or not this account's." }], isError: true } });
  expect(document.getElementById("c")!.childNodes.length).toBe(0);
});
