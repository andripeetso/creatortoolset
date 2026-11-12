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
  say({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: "2026-01-26", hostInfo: { name: "test" }, hostCapabilities: { serverTools: {} }, hostContext: { theme: "dark" } } });
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

it("a Review video: the answer's frame under its comment, a time that jumps the video, and Resolve through the app", async () => {
  say({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: {
      content: [{ type: "text", text: "{}" }, { type: "text", text: "Comment c1 (v2, 0:05.00): Trim the start" }, { type: "image", mimeType: "image/jpeg", data: "QUJD" }],
      _meta: { card: { kind: "review", title: "Cut 3", href: "https://x.test/review/r1", versions: 2, v: 2, play: "https://x.test/api/card/media/p", poster: "https://x.test/api/card/media/t", frames: true, comments: [{ id: "c1", at: "0:05", t: 5, text: "Trim the start", author: "Ana", v: 2, resolved: false, replies: 0 }, { id: "c0", at: "0:01", t: 1, text: "Old note", author: "Ana", v: 1, resolved: true, replies: 0 }] } },
    },
  });
  const video = document.querySelector("#c video") as HTMLVideoElement;
  expect(video.getAttribute("src")).toBe("https://x.test/api/card/media/p");
  expect((document.querySelector("#c img.fr") as HTMLImageElement).getAttribute("src")).toBe("data:image/jpeg;base64,QUJD");
  expect(document.getElementById("c")!.textContent).toContain("1 open · 1 resolved");
  // only the comment on the version that plays gets a time that jumps
  expect(document.querySelectorAll("#c button.at").length).toBe(1);
  (document.querySelector("#c button.at") as HTMLButtonElement).click();
  expect(video.currentTime).toBe(5);

  [...document.querySelectorAll("button.mini")].find((b) => b.textContent === "Resolve")!.dispatchEvent(new Event("click"));
  const asked = sent.find((m) => m.method === "tools/call")!;
  expect(asked.params).toEqual({ name: "resolve_comment", arguments: { link: "https://x.test/review/r1", comment_id: "c1" } });
  say({ jsonrpc: "2.0", id: asked.id, result: { content: [{ type: "text", text: "{}" }] } });
  await tick();
  expect(document.getElementById("c")!.textContent).toContain("0 open · 2 resolved");
  expect([...document.querySelectorAll("button.mini")].some((b) => b.textContent === "Resolve")).toBe(false);
});

it("footage with a playable copy plays in the card; posts show their numbers; a script offers the next step as a message", () => {
  say({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { _meta: { card: { kind: "footage", total: 2, href: "https://x.test/library", items: [{ title: "Bedtime", type: "video", play: "https://x.test/api/card/media/p1" }, { title: "No copy", type: "video" }] } } } });
  const tiles = document.querySelectorAll("button.tile");
  (tiles[0] as HTMLButtonElement).click();
  expect((document.querySelector("#c video") as HTMLVideoElement).getAttribute("src")).toBe("https://x.test/api/card/media/p1");
  (tiles[1] as HTMLButtonElement).click();
  expect(sent.find((m) => m.method === "ui/open-link")!.params).toEqual({ url: "https://x.test/library" });

  say({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { _meta: { card: { kind: "posts", title: "@tinyacrobatics", total: 1, href: "https://x.test/instagram", items: [{ text: "First steps", when: "2026-11-01", plays: 12300, likes: 340, comments: 12 }] } } } });
  expect(document.getElementById("c")!.textContent).toContain("2026-11-01 · 12.3K plays · 340 likes · 12 comments");

  say({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { _meta: { card: { kind: "script", title: "Tiny tumbles", href: "https://x.test/s", pieces: [] } } } });
  [...document.querySelectorAll("button.btn")].find((b) => b.textContent === "Find footage")!.dispatchEvent(new Event("click"));
  expect(sent.find((m) => m.method === "ui/message")!.params).toEqual({ role: "user", content: [{ type: "text", text: 'Find footage in my Media Library for the script "Tiny tumbles".' }] });
});

it("a refused call leaves the frame empty", () => {
  say({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [{ type: "text", text: "Not found, or not this account's." }], isError: true } });
  expect(document.getElementById("c")!.childNodes.length).toBe(0);
});
