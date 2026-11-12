import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "cards-"));
process.env.APP_SECRET = "cards-test-secret";

const { createUser, dropAiKey, findUser, newAiKey } = await import("./users");
const { mintJobToken } = await import("./auth");
const app = (await import("./boot")).default;
const { CARD_LINK_MS, CARD_MIME, CARD_URI, cardFor, mediaLinks } = await import("./mcp-cards");
const { reviewToLibrary } = await import("./review");
const { registerLibrarySlot, resetLibrarySlots, LIBRARY_SOURCE } = await import("./library/sources");
const { blobs, libraryDb } = await import("./library/db");
const { ensureLibrary, homeOf } = await import("./library/access");
const { handle, pluginToolsOf } = await import("./mcp");

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
    expect(tools.find((t) => t.name === "resolve_comment")!._meta).toEqual({ "openai/widgetAccessible": true });

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

describe("a plug-in that answers a card tool itself", () => {
  it("gets no card: its answer is its own shape", async () => {
    const plugged = pluginToolsOf([
      { id: "tiny", tools: { defs: [{ name: "editor_get", description: "The plug-in's own.", inputSchema: { type: "object", properties: {} } }], handlers: { editor_get: async () => ({ id: "e1", drafts: [{ odd: true }] }) }, replaces: ["editor_get"] } } as never,
    ]);
    const call = (p: string, init?: RequestInit) => Promise.resolve(app.request(p, init));
    const ask = async (method: string, params: unknown) => (await handle(call, new Headers({ authorization: key }), { jsonrpc: "2.0", id: 1, method, params }, ORIGIN, findUser("cardowner") as never, plugged)) as { result: Record<string, any> };
    const listed = (await ask("tools/list", {})).result.tools as Array<{ name: string; _meta?: unknown }>;
    expect(listed.filter((t) => t.name === "editor_get").map((t) => t._meta)).toEqual([undefined]);
    expect(listed.find((t) => t.name === "media_search")!._meta).toBeDefined();
    expect((await ask("tools/call", { name: "editor_get", arguments: { edit: "e1" } })).result._meta).toBeUndefined();
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
      (what, v) => (v === "v1" ? `signed-${what}` : undefined),
    )!;
    expect(card).toMatchObject({ kind: "footage", q: "sleep", total: 2, items: [{ title: "Bedtime", s: 42, roll: "a", said: { at: "0:07", text: "sleep comes easier" }, thumb: "signed-lt", play: "signed-lp" }, { title: "From a plug-in", thumb: undefined, play: undefined }] });
    expect(cardFor("media_search", { q: "sleep" }, { files: [] }, ORIGIN, none)).toMatchObject({ items: [], empty: 'Nothing in your footage matches "sleep".' });
    expect(String(cardFor("media_search", {}, { files: [] }, ORIGIN, none)!.empty)).toContain("Your Media Library is empty");
  });

  it("script, review and edit", () => {
    expect(cardFor("workshop_edit_piece", { session: "s1", piece: "p1" }, { id: "p1", kind: "reel", blocks: [{ id: "b1", text: "Hook" }] }, ORIGIN, none)).toMatchObject({ kind: "script", href: `${ORIGIN}/workshop/sessions/s1`, pieces: [{ id: "p1" }] });
    expect(
      cardFor("get_review", {}, { id: "r1", name: "Cut 3", link: `${ORIGIN}/review/r1`, approval: "approved", versions: [{ n: 1 }, { n: 2, removed: true }], comments: [{ id: "c1", at: "0:05.00–0:07.50", start: 5, text: "Trim", author: "Ana", version: 1, replies: [{}] }] }, ORIGIN, none),
    ).toMatchObject({ kind: "review", title: "Cut 3", versions: 1, frames: false, comments: [{ id: "c1", at: "0:05–0:07", t: 5, text: "Trim", author: "Ana", v: 1, resolved: false, replies: 1 }] });
    // where media may leave: the newest ready version plays in the card, and the answer's frames show
    expect(cardFor("get_review", {}, { id: "r1", name: "Cut 3", link: "x", versions: [{ n: 1, status: "ready" }, { n: 2, status: "ready" }, { n: 3, status: "processing" }], comments: [] }, ORIGIN, (what, i, n) => `${what}:${String(i)}:${String(n)}`)).toMatchObject({ v: 2, poster: "rt:r1:2", play: "rp:r1:2", frames: true });
    expect(cardFor("instagram_posts", {}, { account: "tinyacrobatics", posts: [{ url: "https://www.instagram.com/p/abc/", kind: "reel", when: "2026-11-01 09:30", caption: "First steps", plays: 12000, likes: 340, comments: 12 }] }, ORIGIN, none)).toMatchObject({ kind: "posts", title: "@tinyacrobatics", total: 1, items: [{ text: "First steps", when: "2026-11-01", plays: 12000, href: "https://www.instagram.com/p/abc/" }] });
    expect(cardFor("editor_create", {}, { id: "e1", name: "Morning", status: "started", link: `${ORIGIN}/editor/e1` }, ORIGIN, none)).toMatchObject({ kind: "edit", id: "e1", running: true, drafts: [] });
    expect(cardFor("editor_get", {}, { id: "e1", name: "Morning", link: "x", drafts: [{ name: "A", preview: "in Review", review: "/review/r1?v=2" }], jobs: [{ state: "failed" }] }, ORIGIN, none)).toMatchObject({ running: false, failed: true, drafts: [{ name: "A", preview: "in Review", href: `${ORIGIN}/review/r1?v=2` }] });
    expect(cardFor("workshop_projects", {}, {}, ORIGIN, none)).toBeNull();
  });
});

describe("a card's media links", () => {
  const get = (url: string, range?: string) => app.request(new URL(url).pathname, { headers: range ? { range } : {} });
  const ok = async (url: string) => (await get(url)).status === 200;
  const sign = () => mediaLinks(key, "cardowner", ORIGIN);
  /** A clip in the owner's library: a thumbnail, and a playable copy when `proxy`. */
  const clip = async (v: string, proxy: boolean) => {
    ensureLibrary("cardowner");
    const d = libraryDb();
    const lib = (d.prepare("SELECT id FROM libraries WHERE workspace_id = ?").get(homeOf("cardowner")) as { id: string }).id;
    d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, ?, 'video', ?, ?, 'cardowner', 1)").run(`a_${v}`, lib, v, v);
    d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, mime, probe, state, created_by, created_at) VALUES (?, ?, 1, ?, 9, ?, 'video/quicktime', '{}', 'ready', 'cardowner', 1)").run(v, `a_${v}`, `libraries/${lib}/v/${v}/source`, v);
    const put = async (name: string, body: string) => {
      const file = path.join(process.env.DATA_DIR!, `in-${v}-${name}`);
      writeFileSync(file, body);
      await blobs.put(`libraries/${lib}/v/${v}/${name}`, file);
    };
    await put("source", "the camera original");
    await put("thumb.jpg", "the picture");
    d.prepare("INSERT INTO derivatives (version_id, kind, storage_key, bytes) VALUES (?, 'thumb', ?, 11)").run(v, `libraries/${lib}/v/${v}/thumb.jpg`);
    if (proxy) {
      await put("proxy.mp4", "0123456789");
      d.prepare("INSERT INTO derivatives (version_id, kind, storage_key, bytes) VALUES (?, 'proxy', ?, 10)").run(v, `libraries/${lib}/v/${v}/proxy.mp4`);
    }
  };

  it("serves a clip's picture and its playable copy to its owner's links, in ranges; never the original", async () => {
    await clip("v_pic", true);
    await clip("v_raw", false);
    const res = await get(sign()("lt", "v_pic")!);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(await res.text()).toBe("the picture");

    // a player asks in ranges: the range goes in and the range headers come back
    const part = await get(sign()("lp", "v_pic")!, "bytes=2-5");
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(part.headers.get("content-type")).toBe("video/mp4");
    expect(await part.text()).toBe("2345");

    // a clip with no playable copy gets no video link (the library would hand out the original for it), only its picture
    expect(sign()("lp", "v_raw")).toBeUndefined();
    expect(sign()("lt", "v_raw")).toBeDefined();
    // and a link made while a copy existed stops when the copy is gone
    const play = sign()("lp", "v_pic")!;
    libraryDb().prepare("DELETE FROM derivatives WHERE version_id = 'v_pic' AND kind = 'proxy'").run();
    expect((await get(play)).status).toBe(404);

    // signing is not seeing: another account's own key makes a link, and the library still refuses it the clip
    const other = createUser("cardother", "password1");
    expect(await ok(mediaLinks(`Bearer ${newAiKey(other, "ChatGPT", true).key}`, "cardother", ORIGIN)("lt", "v_pic")!)).toBe(false);
  });

  it("serves a Review version's picture and video to its owner's links", async () => {
    const id = "0b5d6c1e-1111-4222-8333-944455556666";
    const dir = path.join(process.env.DATA_DIR!, "review", id);
    mkdirSync(path.join(dir, "v1"), { recursive: true });
    writeFileSync(path.join(dir, "v1", "source"), "the review video");
    writeFileSync(path.join(dir, "v1", "thumb.jpg"), "its picture");
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id, name: "Cut 3", owner: "cardowner", approval: { status: "none" }, createdAt: 1, updatedAt: 2, versions: [{ n: 1, name: "cut.mp4", mime: "video/mp4", bytes: 16, duration: 0, fps: 0, width: 0, height: 0, status: "ready", progress: 1, createdAt: 1 }] }));
    writeFileSync(path.join(dir, "comments.json"), "[]");
    await reviewToLibrary();

    expect(await (await get(sign()("rt", id, 1)!)).text()).toBe("its picture");
    const part = await get(sign()("rp", id, 1)!, "bytes=4-9");
    expect(part.status).toBe(206);
    expect(await part.text()).toBe("review");
    // a version that isn't there, and a version number that isn't one
    expect(await ok(sign()("rt", id, 2)!)).toBe(false);
    expect(sign()("rp", id, "1/../x")).toBeUndefined();
  });

  it("works for its key and its time only; none for a plug-in's item, and none anywhere a plug-in guards the library", async () => {
    await clip("v_gate", true);
    const link = sign()("lt", "v_gate")!;
    expect(link).toMatch(/^http:\/\/localhost\/api\/card\/media\/[\w-]+\.[\w-]+$/);
    expect(await ok(link)).toBe(true);

    // forged: another clip under the same signature, and a made-up signature
    const [body, sig] = link.split("/").pop()!.split(".");
    const other = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), i: "v_pic" })).toString("base64url");
    expect(await ok(`${ORIGIN}/api/card/media/${other}.${sig}`)).toBe(false);
    expect(await ok(`${ORIGIN}/api/card/media/${body}.${"A".repeat(sig!.length)}`)).toBe(false);

    expect(sign()("lt", "ext_12")).toBeUndefined();
    expect(mediaLinks(undefined, "cardowner", ORIGIN)("lt", "v_gate")).toBeUndefined();
    const review = sign()("rt", "0b5d6c1e-1111-4222-8333-944455556666", 1)!;
    registerLibrarySlot("gate", { policies: [{ sourceId: LIBRARY_SOURCE, canSee: () => true }] });
    expect(sign()("lt", "v_gate")).toBeUndefined();
    expect(sign()("rp", "0b5d6c1e-1111-4222-8333-944455556666", 1)).toBeUndefined();
    expect(await ok(link)).toBe(false);
    expect(await ok(review)).toBe(false);
    resetLibrarySlots();
    expect(await ok(link)).toBe(true);

    // expired
    vi.useFakeTimers({ now: Date.now() + CARD_LINK_MS + 1000 });
    expect(await ok(link)).toBe(false);
    vi.useRealTimers();

    // the key is removed in Settings → Headless access: its links end with it
    dropAiKey(findUser("cardowner")!, made.id);
    expect(await ok(link)).toBe(false);
  });
});
