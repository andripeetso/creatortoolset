import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "cards-"));
process.env.APP_SECRET = "cards-test-secret";

const { createUser, dropAiKey, findUser, newAiKey } = await import("./users");
const { mintJobToken } = await import("./auth");
const app = (await import("./boot")).default;
const { CARD_LINK_MS, CARD_MIME, CARD_URI, cardFor, thumbLinks } = await import("./mcp-cards");
const { registerLibrarySlot, resetLibrarySlots, LIBRARY_SOURCE } = await import("./library/sources");

const user = createUser("cardowner", "password1");
const made = newAiKey(user, "ChatGPT", true);
const key = `Bearer ${made.key}`;
const ORIGIN = "http://localhost";

let id = 0;
const rpc = async (method: string, params: unknown = {}, authorization = key) =>
  (await (
    await app.request("/api/mcp", { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) })
  ).json()) as { result: Record<string, any>; error?: { code: number } };

afterEach(() => {
  vi.useRealTimers();
  resetLibrarySlots();
});

describe("cards for an AI app outside the dock", () => {
  it("lists the card on the tools that have one, and serves its page", async () => {
    expect((await rpc("initialize")).result.capabilities).toEqual({ tools: {}, resources: {} });
    const tools = (await rpc("tools/list")).result.tools as Array<{ name: string; _meta?: Record<string, any> }>;
    const search = tools.find((t) => t.name === "media_search")!;
    expect(search._meta).toMatchObject({ ui: { resourceUri: CARD_URI }, "openai/outputTemplate": CARD_URI });
    expect(tools.find((t) => t.name === "workshop_projects")!._meta).toBeUndefined();

    expect((await rpc("resources/list")).result.resources).toMatchObject([{ uri: CARD_URI, mimeType: CARD_MIME }]);
    expect((await rpc("resources/templates/list")).result.resourceTemplates).toEqual([]);
    const page = (await rpc("resources/read", { uri: CARD_URI })).result.contents[0];
    expect(page).toMatchObject({ uri: CARD_URI, mimeType: "text/html;profile=mcp-app", _meta: { ui: { csp: { resourceDomains: [ORIGIN] } } } });
    expect(page.text).toContain("ui/initialize");
    // an older name an app still holds answers with today's page; anything else is not ours
    expect((await rpc("resources/read", { uri: "ui://creator-toolset/card-old.html" })).result.contents[0].uri).toBe(CARD_URI);
    expect((await rpc("resources/read", { uri: "ui://elsewhere/x" })).error?.code).toBe(-32002);
  });

  it("gives the dock none of it", async () => {
    const dock = `Bearer ${mintJobToken("cardowner", "turn-1")}`;
    expect((await rpc("initialize", {}, dock)).result.capabilities).toEqual({ tools: {} });
    expect(((await rpc("tools/list", {}, dock)).result.tools as Array<Record<string, unknown>>).some((t) => "_meta" in t)).toBe(false);
    expect((await rpc("resources/list", {}, dock)).result.resources).toEqual([]);
  });

  it("puts a card beside a tool's answer: the text is unchanged and the card is for the page alone", async () => {
    const r = (await rpc("tools/call", { name: "workshop_new_session", arguments: { title: "Tiny tumbles" } })).result;
    const said = JSON.parse(r.content[0].text) as { id: string; title: string };
    expect(r._meta.card).toMatchObject({ kind: "script", title: "Tiny tumbles", href: `${ORIGIN}/workshop/sessions/${said.id}` });
    expect(r.structuredContent).toBeUndefined();
    // a tool without a card answers as before
    expect((await rpc("tools/call", { name: "workshop_projects", arguments: {} })).result._meta).toBeUndefined();
  });
});

describe("card data", () => {
  const none = () => undefined;
  it("footage: the first moment said, a signed picture where there is one, and what to do when there is nothing", () => {
    const card = cardFor(
      "media_search",
      { q: "sleep" },
      { files: [{ id: "a1", versionId: "v1", title: "Bedtime", kind: "video", roll: "a", durationS: 42, said: [{ at: "0:07", text: "sleep comes easier" }, { at: "0:30", text: "later" }] }, { id: "x", versionId: "ext_9", title: "From a plug-in", kind: "video" }] },
      ORIGIN,
      (v) => (v === "v1" ? "signed" : undefined),
    )!;
    expect(card).toMatchObject({ kind: "footage", q: "sleep", total: 2, items: [{ title: "Bedtime", s: 42, roll: "a", said: { at: "0:07", text: "sleep comes easier" }, thumb: "signed" }, { title: "From a plug-in", thumb: undefined }] });
    expect(cardFor("media_search", { q: "sleep" }, { files: [] }, ORIGIN, none)).toMatchObject({ items: [], empty: 'Nothing in your footage matches "sleep".' });
    expect(String(cardFor("media_search", {}, { files: [] }, ORIGIN, none)!.empty)).toContain("Your Media Library is empty");
  });

  it("script, review and edit", () => {
    expect(cardFor("workshop_edit_piece", { session: "s1", piece: "p1" }, { id: "p1", kind: "reel", blocks: [{ id: "b1", text: "Hook" }] }, ORIGIN, none)).toMatchObject({ kind: "script", href: `${ORIGIN}/workshop/sessions/s1`, pieces: [{ id: "p1" }] });
    expect(
      cardFor("get_review", {}, { id: "r1", name: "Cut 3", link: `${ORIGIN}/review/r1`, approval: "approved", versions: [{ n: 1 }, { n: 2, removed: true }], comments: [{ at: "0:05.00–0:07.50", text: "Trim", author: "Ana", version: 1, replies: [{}] }] }, ORIGIN, none),
    ).toMatchObject({ kind: "review", title: "Cut 3", versions: 1, comments: [{ at: "0:05–0:07", text: "Trim", author: "Ana", v: 1, resolved: false, replies: 1 }] });
    expect(cardFor("editor_create", {}, { id: "e1", name: "Morning", status: "started", link: `${ORIGIN}/editor/e1` }, ORIGIN, none)).toMatchObject({ kind: "edit", id: "e1", running: true, drafts: [] });
    expect(cardFor("editor_get", {}, { id: "e1", name: "Morning", link: "x", drafts: [{ name: "A", preview: "in Review" }], jobs: [{ state: "failed" }] }, ORIGIN, none)).toMatchObject({ running: false, failed: true, drafts: [{ name: "A", preview: "in Review" }] });
    expect(cardFor("workshop_projects", {}, {}, ORIGIN, none)).toBeNull();
  });
});

describe("a card's picture links", () => {
  const get = (url: string) => app.request(new URL(url).pathname);
  /** A signed link for a clip that isn't there: past every check it ends at the library's own "not found" (code not_found). */
  const reached = async (url: string) => ((await (await get(url)).json()) as { code?: string }).code === "not_found";

  it("works for its key, its time and thumbnails of the built-in library only", async () => {
    const link = thumbLinks(key, "cardowner", ORIGIN)("v_missing")!;
    expect(link).toMatch(/^http:\/\/localhost\/api\/card\/thumb\/[\w-]+\.[\w-]+$/);
    expect(await reached(link)).toBe(true);

    // forged: another clip under the same signature, and a made-up signature
    const [body, sig] = link.split("/").pop()!.split(".");
    const other = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), v: "v_other" })).toString("base64url");
    expect(await reached(`${ORIGIN}/api/card/thumb/${other}.${sig}`)).toBe(false);
    expect(await reached(`${ORIGIN}/api/card/thumb/${body}.${"A".repeat(sig!.length)}`)).toBe(false);

    // never a plug-in's item, never without a key, never where a plug-in gates the built-in library
    expect(thumbLinks(key, "cardowner", ORIGIN)("ext_12")).toBeUndefined();
    expect(thumbLinks(undefined, "cardowner", ORIGIN)("v1")).toBeUndefined();
    registerLibrarySlot("gate", { policies: [{ sourceId: LIBRARY_SOURCE, canSee: () => true }] });
    expect(thumbLinks(key, "cardowner", ORIGIN)("v1")).toBeUndefined();
    expect(await reached(link)).toBe(false);
    resetLibrarySlots();
    expect(await reached(link)).toBe(true);

    // expired
    vi.useFakeTimers({ now: Date.now() + CARD_LINK_MS + 1000 });
    expect(await reached(link)).toBe(false);
    vi.useRealTimers();

    // the key is removed in Settings → Headless access: its links end with it
    dropAiKey(findUser("cardowner")!, made.id);
    expect(await reached(link)).toBe(false);
  });
});
