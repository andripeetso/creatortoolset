import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "mcp-"));
process.env.APP_SECRET = "mcp-test-secret";

const { createUser, newApiKey } = await import("./users");
const app = (await import("./boot")).default;
const { TOOLS, handle } = await import("./mcp");

const user = createUser("mcpowner", "password1");
const full = `Bearer ${newApiKey(user, "full")}`;
const review = `Bearer ${newApiKey(user)}`;

let id = 0;
const rpc = (method: string, params: unknown = {}, authorization = full) =>
  app.request("/api/mcp", {
    method: "POST",
    headers: { authorization, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
const tool = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await (await rpc("tools/call", { name, arguments: args })).json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { error: r.result.isError, value: r.result.isError ? r.result.content[0]!.text : JSON.parse(r.result.content[0]!.text) };
};

/** Stands in for the site's routes behind handle(): answers by "METHOD /path" (no query), records each request. */
function fakeSite(routes: Record<string, (body: Record<string, any>) => unknown>) {
  const hits: { method: string; path: string; body?: Record<string, any> }[] = [];
  const call = async (path: string, init: RequestInit) => {
    const method = String(init.method ?? "GET");
    const body = init.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, any>);
    hits.push({ method, path, body });
    const answer = routes[`${method} ${path.split("?")[0]}`];
    return answer
      ? new Response(JSON.stringify(answer(body ?? {})), { headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ error: "no route in this test" }), { status: 404, headers: { "content-type": "application/json" } });
  };
  return { call, hits };
}
/** One tools/call through handle(), against a fake site. */
async function callWith(site: ReturnType<typeof fakeSite>, name: string, args: Record<string, unknown>) {
  const r = (await handle(site.call, new Headers({ authorization: full }), { jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }, "https://tools.example.com", user)) as {
    result: { content: Array<{ text: string }>; isError?: boolean };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { error: r.result.isError, value: (r.result.isError ? r.result.content[0]!.text : JSON.parse(r.result.content[0]!.text)) as any };
}

describe("Creator Toolset as a remote MCP server", () => {
  it("answers only a Full key", async () => {
    expect((await rpc("tools/list", {}, review)).status).toBe(401);
    expect((await rpc("tools/list", {}, "")).status).toBe(401);
    expect((await rpc("tools/list")).status).toBe(200);
  });

  it("speaks MCP: initialize, notifications, tools/list, unknown methods", async () => {
    const init = (await (await rpc("initialize", { protocolVersion: "2025-06-18" })).json()) as { result: { protocolVersion: string; instructions: string } };
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.instructions).toContain("Content Workshop");
    const note = await app.request("/api/mcp", {
      method: "POST",
      headers: { authorization: full, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(note.status).toBe(202);
    const list = (await (await rpc("tools/list")).json()) as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map((t) => t.name)).toContain("workshop_chat");
    expect(((await (await rpc("nope")).json()) as { error: { code: number } }).error.code).toBe(-32601);
    expect((await app.request("/api/mcp", { headers: { authorization: full } })).status).toBe(405);
  });

  it("drives the Workshop through the site's own routes, as the AI's text", async () => {
    const s = (await tool("workshop_new_session", { title: "From the phone", notes: "the idea" })).value as { id: string; pieces: Array<{ id: string }> };
    expect(s.pieces).toHaveLength(1);
    const edited = (await tool("workshop_edit_piece", { session: s.id, piece: s.pieces[0]!.id, blocks: [{ text: "Line one" }, { text: "Line two" }], caption: "Post" })).value;
    expect(edited.blocks.map((b: { text: string }) => b.text)).toEqual(["Line one", "Line two"]);
    await tool("workshop_update_session", { session: s.id, status: "writing" });
    const read = (await tool("workshop_session", { session: s.id })).value;
    expect(read.status).toBe("writing");
    expect(read.pieces[0].caption).toBe("Post");
    // linking a post goes through the session's own PATCH (it checks the link, and moves the session on)
    const linked = (await tool("workshop_update_session", { session: s.id, post_url: "https://www.instagram.com/reel/TinyAcro1/" })).value;
    expect(linked.posted.shortcode).toBe("TinyAcro1");
    expect((await tool("workshop_update_session", { session: s.id, post_url: "not a link" })).error).toBe(true);
    expect((await tool("workshop_update_session", { session: s.id, remove_post: true })).value.posted).toBeUndefined();
    expect((await tool("workshop_sessions")).value.sessions.map((x: { id: string }) => x.id)).toContain(s.id);
    expect(await tool("workshop_session", { session: "00000000-0000-4000-8000-000000000000" })).toEqual({ error: true, value: "Not found, or not this account's." });
    expect((await tool("list_reviews")).value).toEqual({ reviews: [] });
    expect(await tool("review_set_approval", { link: "not a link", status: "approved" })).toEqual({ error: true, value: expect.stringContaining("That isn't a review link") });
    expect(await tool("review_set_approval", { link: "00000000-0000-4000-8000-000000000000", status: "changes" })).toEqual({ error: true, value: "Not found, or not this account's." });
    expect(await tool("instagram_refresh", { account: "nobody" })).toEqual({ error: true, value: "No account of yours is called @nobody: instagram_add_account adds it." });
    expect(await tool("instagram_posts", { account: "nobody" })).toEqual({ error: true, value: "No account of yours is called @nobody: instagram_add_account adds it." });
    expect((await tool("instagram_posts", { account: "nobody", since: "not a date" })).error).toBe(true);
    expect((await tool("get_review", { link: "not a link" })).error).toBe(true);
    // links start with this server's address: PUBLIC_ORIGIN, else the one the request came in on
    expect((await tool("get_review", { link: "not a link" })).value).toContain("http://localhost/review/<id>");
    process.env.PUBLIC_ORIGIN = "https://tools.example.com/";
    try {
      expect((await tool("get_review", { link: "not a link" })).value).toContain("https://tools.example.com/review/<id>");
    } finally {
      delete process.env.PUBLIC_ORIGIN;
    }
  });

  it("turns a Review video's share link on (the same link each time) and off", async () => {
    const { addVersion } = await import("./review");
    const added = await addVersion(undefined, { owner: "mcpowner", name: "TinyReel_A.mp4", mime: "video/mp4", bytes: 1 }, async () => {});
    const on = (await tool("review_share", { link: added!.meta.id })).value as { share_link: string };
    expect(on.share_link).toMatch(/\/r\/[0-9a-f-]{36}$/);
    expect((await tool("review_share", { link: added!.meta.id })).value.share_link).toBe(on.share_link);
    const token = on.share_link.split("/r/")[1];
    expect((await app.request(`/api/review/s/${token}`)).status).toBe(200);
    expect((await tool("review_share", { link: added!.meta.id, on: false })).value).toMatchObject({ shared: false });
    expect((await app.request(`/api/review/s/${token}`)).status).toBe(404);
  });

  it("lists a plug-in's tools after the built-in ones and calls its handler with the account and the site's routes", async () => {
    const { handle, pluginToolsOf } = await import("./mcp");
    const seen: string[] = [];
    const call = async (path: string) => {
      seen.push(path);
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    };
    const plugged = pluginToolsOf([
      {
        id: "tiny",
        tools: {
          defs: [{ name: "tiny_echo", description: "Echo a line for the Tiny Acrobatics test plug-in.", inputSchema: { type: "object", properties: {} } }],
          handlers: {
            tiny_echo: async (args: Record<string, unknown>, ctx: { user: { username: string }; origin: string; api: (p: string) => Promise<Response> }) => {
              const r = (await (await ctx.api("/api/workshop/projects")).json()) as { ok: boolean };
              return { text: args.text, as: ctx.user.username, origin: ctx.origin, routed: r.ok };
            },
          },
        },
      },
    ]);
    const headers = new Headers({ authorization: full });
    const list = (await handle(call, headers, { jsonrpc: "2.0", id: 1, method: "tools/list" }, "https://tools.example.com", user, plugged)) as {
      result: { tools: Array<{ name: string }> };
    };
    const names = list.result.tools.map((t) => t.name);
    expect(names.at(-1)).toBe("tiny_echo");
    expect(names).not.toContain("setup_status");
    const res = (await handle(
      call,
      headers,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tiny_echo", arguments: { text: "hi" } } },
      "https://tools.example.com",
      user,
      plugged,
    )) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(res.result.isError).toBeUndefined();
    expect(JSON.parse(res.result.content[0]!.text)).toEqual({ text: "hi", as: "mcpowner", origin: "https://tools.example.com", routed: true });
    expect(seen).toEqual(["/api/workshop/projects"]);
  });

  it("refuses at boot a plug-in tool that shadows a built-in or has no handler", async () => {
    const { pluginToolsOf } = await import("./mcp");
    const def = (name: string) => ({ name, description: "x", inputSchema: { type: "object", properties: {} } });
    expect(() => pluginToolsOf([{ id: "tiny", tools: { defs: [def("workshop_projects")], handlers: { workshop_projects: async () => ({}) } } }])).toThrow(
      "plug-in tiny: tool workshop_projects is already served",
    );
    expect(() => pluginToolsOf([{ id: "tiny", tools: { defs: [def("setup_status")], handlers: { setup_status: async () => ({}) } } }])).toThrow(
      "plug-in tiny: tool setup_status is already served",
    );
    expect(() => pluginToolsOf([{ id: "tiny", tools: { defs: [def("tiny_only")], handlers: {} } }])).toThrow("plug-in tiny: tool tiny_only has no handler");
    expect(pluginToolsOf([{ id: "tiny" }]).defs).toEqual([]);
  });

  // plugin-examples/hello is what a new plug-in is copied from (PLUGINS.md), so its tool must keep loading.
  it("serves the example plug-in's tool", async () => {
    const { pluginToolsOf } = await import("./mcp");
    const hello = (await import("../plugin-examples/hello/plugin")).default;
    const plugged = pluginToolsOf([hello]);
    expect(plugged.defs.map((d) => d.name)).toEqual(["hello_greet"]);
    expect(await plugged.handlers.get("hello_greet")!({ name: "Tiny" }, { user: { username: "mcpowner" } } as never)).toEqual({ greeting: "hello, Tiny" });
  });

  // With the owner's plug-in folder present it answers editor_list and editor_run instead, so the built-ins are checked only without it.
  it.skipIf(existsSync(new URL("../plugins/baby-acrobatics", import.meta.url)))("the built-in AI Editor tools answer with no plug-in", async () => {
    expect((await tool("editor_list")).value).toEqual({ edits: [] });
    expect((await tool("editor_run", { edit: "x", kind: "send_to_review" })).value).toContain("needs the draft");
  });

  it("lets a plug-in replace a built-in tool by name: its version is listed once and its handler answers the call", async () => {
    const { handle, pluginToolsOf } = await import("./mcp");
    const def = (name: string, description: string) => ({ name, description, inputSchema: { type: "object", properties: {} } });
    const plugged = pluginToolsOf([
      {
        id: "tiny",
        tools: {
          defs: [def("editor_list", "Tiny Acrobatics edits.")],
          handlers: { editor_list: async () => ({ edits: ["tiny-edit"] }) },
          replaces: ["editor_list"],
        },
      },
    ]);
    const headers = new Headers({ authorization: full });
    const call = async () => new Response("{}");
    const list = (await handle(call, headers, { jsonrpc: "2.0", id: 1, method: "tools/list" }, "https://tools.example.com", user, plugged)) as {
      result: { tools: Array<{ name: string; description: string }> };
    };
    const hits = list.result.tools.filter((t) => t.name === "editor_list");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.description).toBe("Tiny Acrobatics edits.");
    const res = (await handle(
      call,
      headers,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "editor_list", arguments: {} } },
      "https://tools.example.com",
      user,
      plugged,
    )) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(res.result.isError).toBeUndefined();
    expect(JSON.parse(res.result.content[0]!.text)).toEqual({ edits: ["tiny-edit"] });
  });

  it("refuses a replace that names no built-in, a built-in twice, or a name the plug-in does not serve", async () => {
    const { pluginToolsOf } = await import("./mcp");
    const def = (name: string) => ({ name, description: "x", inputSchema: { type: "object", properties: {} } });
    const handler = async () => ({});
    expect(() => pluginToolsOf([{ id: "tiny", tools: { defs: [def("tiny_only")], handlers: { tiny_only: handler }, replaces: ["tiny_only"] } }])).toThrow(
      "plug-in tiny: tiny_only is not a built-in tool it can replace",
    );
    expect(() => pluginToolsOf([{ id: "tiny", tools: { defs: [def("setup_status")], handlers: { setup_status: handler }, replaces: ["setup_status"] } }])).toThrow(
      "plug-in tiny: setup_status is not a built-in tool it can replace",
    );
    expect(() => pluginToolsOf([{ id: "tiny", tools: { defs: [], handlers: {}, replaces: ["editor_list"] } }])).toThrow(
      "plug-in tiny: replaces tool editor_list but serves no tool of that name",
    );
    expect(() =>
      pluginToolsOf([
        { id: "tiny", tools: { defs: [def("editor_list")], handlers: { editor_list: handler }, replaces: ["editor_list"] } },
        { id: "tinier", tools: { defs: [def("editor_list")], handlers: { editor_list: handler }, replaces: ["editor_list"] } },
      ]),
    ).toThrow("plug-in tinier: editor_list is already replaced by another plug-in");
    expect(() =>
      pluginToolsOf([
        { id: "tiny", tools: { defs: [def("editor_list")], handlers: { editor_list: handler }, replaces: ["editor_list"] } },
        { id: "tinier", tools: { defs: [def("editor_list")], handlers: { editor_list: handler } } },
      ]),
    ).toThrow("plug-in tinier: tool editor_list is already served");
  });

  it("editor_create makes the edit from the takes and starts it at analyze; start=false only makes it", async () => {
    const site = fakeSite({ "POST /api/editor": () => ({ id: "edit_tiny" }), "POST /api/editor/edit_tiny/run": () => ({ ok: true }) });
    const out = await callWith(site, "editor_create", {
      sources: ["v_a", "v_b"],
      name: "Tiny Acrobatics cut",
      brief: "A short hype reel",
      script: "Hook line",
      versions: 2,
      target_s: 45,
      broll_folder: "coll_b",
    });
    expect(site.hits.map((h) => `${h.method} ${h.path}`)).toEqual(["POST /api/editor", "POST /api/editor/edit_tiny/run"]);
    expect(site.hits[0]!.body).toEqual({ sources: ["v_a", "v_b"], name: "Tiny Acrobatics cut", brief: "A short hype reel", script: "Hook line", versions: 2, targetS: 45, brollCollectionId: "coll_b" });
    expect(site.hits[1]!.body).toEqual({ from: "analyze" });
    expect(out.value).toEqual({ id: "edit_tiny", name: "Tiny Acrobatics cut", status: "started", link: "https://tools.example.com/editor/edit_tiny", note: expect.any(String) });

    const made = fakeSite({ "POST /api/editor": () => ({ id: "edit_tiny" }) });
    const kept = await callWith(made, "editor_create", { sources: ["v_a"], start: false });
    expect(made.hits.map((h) => `${h.method} ${h.path}`)).toEqual(["POST /api/editor"]);
    expect(made.hits[0]!.body).toEqual({ sources: ["v_a"] }); // no targetS or brollCollectionId unless given
    expect(kept.value).toMatchObject({ id: "edit_tiny", name: "Untitled edit", status: "made" });

    const none = fakeSite({});
    expect(await callWith(none, "editor_create", { sources: [] })).toEqual({ error: true, value: expect.stringContaining("Give sources") });
    expect(none.hits).toHaveLength(0);
  });

  it("media_search searches the first library with the q, kind, folder and since the AI gave", async () => {
    const site = fakeSite({
      "GET /api/library": () => ({ libraries: [{ id: "lib_home" }, { id: "lib_other" }] }),
      "GET /api/library/lib_home/assets": () => ({
        items: [
          {
            id: "a1",
            versionId: "v1",
            title: "Handstand take",
            kind: "video",
            state: "ready",
            durationS: 12.5,
            tags: ["gym"],
            description: { text: "Tiny Acrobatics handstand on the mat" },
            capturedAt: Date.parse("2026-11-09T15:30:00Z"),
          },
        ],
      }),
    });
    const out = await callWith(site, "media_search", { q: "handstand", kind: "video", folder: "coll_b", since: "2026-11-09T00:00:00Z", limit: 5 });
    const search = site.hits.find((h) => h.path.startsWith("/api/library/lib_home/assets"))!;
    expect(Object.fromEntries(new URL(search.path, "https://x.test").searchParams)).toEqual({
      limit: "5",
      q: "handstand",
      kind: "video",
      collectionId: "coll_b",
      from: String(Date.parse("2026-11-09T00:00:00Z")),
    });
    expect(site.hits.some((h) => h.path.includes("lib_other"))).toBe(false);
    expect(out.value).toEqual({
      library: "lib_home",
      files: [
        {
          id: "a1",
          versionId: "v1",
          title: "Handstand take",
          kind: "video",
          state: "ready",
          durationS: 12.5,
          tags: ["gym"],
          description: "Tiny Acrobatics handstand on the mat",
          captured: "2026-11-09 15:30",
        },
      ],
    });
    await callWith(site, "media_search", {});
    const newest = new URL(site.hits.at(-1)!.path, "https://x.test").searchParams;
    expect(Object.fromEntries(newest)).toEqual({ limit: "50" }); // no q: the newest files
  });

  it("media_import_folder sends the folder, since as epoch ms and the folder id, and shapes the files and scripts", async () => {
    const site = fakeSite({
      "GET /api/library/lib_home/assets": () => ({ items: [{ id: "a1", versionId: "v_1", kind: "video", state: "ready", durationS: 40, width: 1920, roll: "a" }] }),
      "POST /api/library/import-folder": () => ({
        libraryId: "lib_home",
        imported: [
          { file: "/Tiny/Footage/Take 1.mov", versionId: "v_1" },
          { file: "/Tiny/Footage/Broken.mov", error: "unreadable" },
        ],
        scripts: [{ file: "/Tiny/Footage/script.txt", text: "Hook line" }],
      }),
    });
    const out = await callWith(site, "media_import_folder", { path: "/Tiny/Footage", since: "2026-11-10T00:00:00+02:00", folder: "coll_b" });
    expect(site.hits[0]!.body).toEqual({ path: "/Tiny/Footage", since: Date.parse("2026-11-10T00:00:00+02:00"), collectionId: "coll_b" });
    expect(out.value).toEqual({
      imported: 1,
      said: "1 clip added: 1 A-roll",
      files: [
        { file: "/Tiny/Footage/Take 1.mov", version_id: "v_1" },
        { file: "/Tiny/Footage/Broken.mov", error: "unreadable" },
      ],
      scripts: [{ file: "/Tiny/Footage/script.txt", text: "Hook line" }],
      note: expect.stringContaining("editor_create can take them"),
    });

    const nothing = fakeSite({ "POST /api/library/import-folder": () => ({ libraryId: "lib_home", imported: [], scripts: [] }) });
    const none = await callWith(nothing, "media_import_folder", { path: "/Tiny/Footage" });
    expect(none.value).toEqual({ imported: 0, files: [], scripts: [], note: "No media files there changed since then." });
    expect(nothing.hits[0]!.body).toEqual({ path: "/Tiny/Footage" }); // no since: all of it

    const bad = fakeSite({});
    expect(await callWith(bad, "media_import_folder", { path: "/Tiny/Footage", since: "yesterday" })).toEqual({ error: true, value: expect.stringContaining("is not a date") });
    expect(bad.hits).toHaveLength(0);
  });

  it("says in one line how the clips just added were sorted, and media_search with versions waits for the rest", async () => {
    const cards = [
      ...["v1", "v2", "v3"].map((v) => ({ versionId: v, kind: "video", state: "ready", durationS: 60, width: 1920, roll: "a" })),
      ...["v4", "v5", "v6", "v7", "v8", "v9", "v10", "v11", "v12"].map((v) => ({ versionId: v, kind: "video", state: "ready", durationS: 8, width: 1920, roll: "b" })),
    ];
    let sorted = false; // the last clip's transcript comes after the first look
    const site = fakeSite({
      "GET /api/library": () => ({ libraries: [{ id: "lib_home" }] }),
      "GET /api/library/lib_home/assets": () => ({ items: sorted ? cards : [...cards.slice(0, 11), { versionId: "v12", kind: "video", state: "processing" }] }),
      "POST /api/library/import-folder": () => ({ libraryId: "lib_home", imported: cards.map((c) => ({ file: `/Tiny/${c.versionId}.mov`, versionId: c.versionId })), scripts: [] }),
    });
    const { SORT_WAIT_S } = await import("./mcp");
    const was = { ...SORT_WAIT_S };
    SORT_WAIT_S.added = 0;
    try {
      const out = await callWith(site, "media_import_folder", { path: "/Tiny" });
      expect(out.value.said).toBe("12 clips added: 3 A-roll, 8 B-roll, 1 still being sorted");
      expect(out.value.note).toContain("media_search with these versions");
      sorted = true;
      const later = await callWith(site, "media_search", { versions: cards.map((c) => c.versionId), roll: "b" });
      expect(later.value.said).toBe("12 clips added: 3 A-roll, 9 B-roll");
      const asked = new URL(site.hits.at(-1)!.path, "https://x.test").searchParams;
      expect(asked.get("roll")).toBe("b");
      expect(asked.get("versions")).toBe(cards.map((c) => c.versionId).join(","));
    } finally {
      Object.assign(SORT_WAIT_S, was);
    }
  });

  describe("instagram_comments", () => {
    const T = { new: Date.parse("2026-11-09T10:00:00Z"), mid: Date.parse("2026-10-20T10:00:00Z"), old: Date.parse("2026-10-01T10:00:00Z") };
    /** The Analyzer account @tinyacrobatics: a newer post with a link, one with only a shortcode, an older one, and a row with neither. */
    const site = (stuck: string[] = []) =>
      fakeSite({
        "GET /api/instagram/accounts": () => [{ id: "acc_t", username: "tinyacrobatics" }],
        "GET /api/instagram/accounts/acc_t": () => ({
          id: "acc_t",
          username: "tinyacrobatics",
          jobs: [],
          catalog: [
            { shortcode: "PostNew", url: "https://www.instagram.com/reel/PostNew/", takenAt: T.new },
            { shortcode: "PostMid", takenAt: T.mid },
            { shortcode: "PostOld", url: "https://www.instagram.com/p/PostOld/", takenAt: T.old },
            { takenAt: T.new },
          ],
        }),
        "POST /api/instagram": (b) => ({
          posts: (b.urls as string[]).map((u) => {
            const sc = /\/(?:p|reel)\/([^/]+)\//.exec(u)![1]!;
            const status = stuck.includes(sc) ? "pending" : sc === "PostOld" ? "failed" : "complete";
            // a post being pulled is processing (its comments still pending); a pulled one is ready
            return { id: `id_${sc}`, shortcode: sc, status: status === "pending" ? "processing" : "ready", comments: { status }, hasComments: sc !== "PostOld" };
          }),
        }),
        "GET /api/instagram/id_PostMid": () => ({ id: "id_PostMid", shortcode: "PostMid", ...(stuck.includes("PostMid") ? { status: "processing", comments: { status: "pending" } } : { status: "ready", comments: { status: "complete" } }) }),
        "GET /api/instagram/id_PostNew/comments": () => ({
          comments: [
            { text: "How long did it take you?", likeCount: 4, replyCount: 0, judged: { kind: "question" } },
            { text: "Buy my course now!", likeCount: 50, replyCount: 0, judged: { kind: "spam" } },
            { text: "Great video", likeCount: 9, replyCount: 1, judged: { kind: "praise" } },
          ],
        }),
        "GET /api/instagram/id_PostMid/comments": () => ({
          comments: [
            { text: "Where is the mat from?", likeCount: 20, replyCount: 2, judged: { kind: "question" } },
            { text: "ok", likeCount: 1, replyCount: 0 },
          ],
        }),
      });

    it("reads the posts since a date, leaves out spam, and sorts the comments by likes", async () => {
      const fake = site();
      const out = await callWith(fake, "instagram_comments", { account: "@TinyAcrobatics", since: "2026-10-15" });
      expect(fake.hits.find((h) => h.method === "POST")!.body).toEqual({
        urls: ["https://www.instagram.com/reel/PostNew/", "https://www.instagram.com/p/PostMid/"],
        recipe: { preset: "custom", jobs: ["comments"] },
        run: "now",
      });
      expect(out.value).toEqual({
        account: "tinyacrobatics",
        posts: 2,
        comments: [
          { post: "PostMid", text: "Where is the mat from?", likes: 20, replies: 2, kind: "question" },
          { post: "PostNew", text: "Great video", likes: 9, replies: 1, kind: "praise" },
          { post: "PostNew", text: "How long did it take you?", likes: 4, replies: 0, kind: "question" },
          { post: "PostMid", text: "ok", likes: 1, replies: 0 },
        ],
        total: 4,
      });
      expect(out.value).not.toHaveProperty("pending");
    });

    it("takes the posts given by shortcode, lists a failed one, and says so when no post is in range", async () => {
      const fake = site();
      const out = await callWith(fake, "instagram_comments", { account: "tinyacrobatics", shortcodes: ["PostOld"] });
      expect(fake.hits.find((h) => h.method === "POST")!.body!.urls).toEqual(["https://www.instagram.com/p/PostOld/"]);
      expect(out.value).toEqual({ account: "tinyacrobatics", posts: 1, comments: [], total: 0, failed: ["PostOld"] });
      expect(fake.hits.some((h) => h.path === "/api/instagram/id_PostOld/comments")).toBe(false); // no comments file for a failed post

      const none = site();
      const empty = await callWith(none, "instagram_comments", { account: "tinyacrobatics", since: "2030-01-01" });
      expect(empty.value).toMatchObject({ posts: 0, comments: [] });
      expect(none.hits.some((h) => h.method === "POST")).toBe(false);
    });

    it("caps the comments at max, and lists a post still pulling as pending, waiting 45 s at most", async () => {
      vi.useFakeTimers();
      try {
        const fake = site(["PostMid"]);
        const pending = callWith(fake, "instagram_comments", { account: "tinyacrobatics", shortcodes: ["PostNew", "PostMid"], max: 1 });
        await vi.advanceTimersByTimeAsync(50_000);
        const out = await pending;
        expect(out.value.pending).toEqual(["PostMid"]);
        expect(out.value.note).toContain("instagram_comments again");
        expect(out.value.total).toBe(2); // the spam left out, the cap applied after the count
        expect(out.value.comments).toEqual([{ post: "PostNew", text: "Great video", likes: 9, replies: 1, kind: "praise" }]);
        expect(fake.hits.filter((h) => h.path === "/api/instagram/id_PostMid").length).toBeGreaterThan(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("keeps its tool list's size on purpose: it goes into every AI session that connects", () => {
    // growth must be deliberate: check what the new words buy, then update this number (never fix it by cutting words)
    // 5814 -> 6925: review_set_approval (approve or send back a Review video from a chat) and instagram_refresh/posts
    // (start an Analyzer account's pull and list its posts); 6925 -> 7071: workshop_update_session links or unlinks a post;
    // 7071 -> 9162: automations_list/create/update/delete/run (scheduled prompts on the user's own AI)
    // 9162 -> 9366: set_work_prefs makes (what they make, from setup; the assistant can change it)
    // 9366 -> 9864: review_share (a Review video's public share link, on or off, as its Share button)
    // 9864 -> 9872: "ready" in workshop_update_session's status enum (every SessionStatus)
    // 9872 -> 9904: newsletter, X thread and article pieces in the kind list
    // 9904 -> 10277: finals_link_session (link a Finals piece to the Workshop session it was made for, so its versions get post descriptions)
    // 10277 -> 10323: automations_list says it returns history, the last five results (the list already carried them)
    // 10323 -> 10338: the five automations_* tools became schedule_task (create or change), list_scheduled_tasks,
    // run_scheduled_task_now and delete_scheduled_task: runs post in an assistant chat, a destination says which, once and weekdays
    // 10338 -> 14394: editor_create (make and start an AI Editor edit), media_import_folder, media_search, media_folders (the
    // Media Library's folders), instagram_add_account and instagram_comments (what people write under an account's posts)
    // 14394 -> 14660: A-roll and B-roll: media_search's roll filter and versions (the clips just added, with the said line
    // that counts how they were sorted), roll on each hit; media_import_folder returns that said line
    // 14660 -> 15032: the Workshop's current project, unlinking one post (and what linking does to the status), and the writer's two
    // options (my words only, deep research). Tools added since then live in api/mcp-tools/ and are not counted here.
    // 15032 -> 15164: set_work_prefs job (what they want to do first, from setup; the assistant can change it)
    // 15164 -> 15233: instagram_posts gives a saved post's library id, which instagram_post reads
    expect(Buffer.byteLength(JSON.stringify(TOOLS))).toBe(15233);
  });
});
