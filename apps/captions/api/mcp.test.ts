import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "mcp-"));
process.env.APP_SECRET = "mcp-test-secret";

const { createUser, newApiKey } = await import("./users");
const app = (await import("./boot")).default;
const { TOOLS } = await import("./mcp");

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
    expect((await tool("editor_list")).value).toEqual({ edits: [] });
    expect(await tool("review_set_approval", { link: "not a link", status: "approved" })).toEqual({ error: true, value: expect.stringContaining("That isn't a review link") });
    expect(await tool("review_set_approval", { link: "00000000-0000-4000-8000-000000000000", status: "changes" })).toEqual({ error: true, value: "Not found, or not this account's." });
    expect(await tool("instagram_refresh", { account: "nobody" })).toEqual({ error: true, value: "No account of yours is called @nobody: add it in the Analyzer first." });
    expect(await tool("instagram_posts", { account: "nobody" })).toEqual({ error: true, value: "No account of yours is called @nobody: add it in the Analyzer first." });
    expect((await tool("instagram_posts", { account: "nobody", since: "not a date" })).error).toBe(true);
    expect((await tool("editor_run", { edit: "x", kind: "send_to_review" })).value).toContain("needs the draft");
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

  it("keeps its tool list's size on purpose: it goes into every AI session that connects", () => {
    // growth must be deliberate: check what the new words buy, then update this number (never fix it by cutting words)
    // 5814 -> 6925: review_set_approval (approve or send back a Review video from a chat) and instagram_refresh/posts
    // (start an Analyzer account's pull and list its posts); 6925 -> 7071: workshop_update_session links or unlinks a post;
    // 7071 -> 9162: automations_list/create/update/delete/run (scheduled prompts on the user's own AI)
    // 9162 -> 9366: set_work_prefs makes (what they make, from setup; the assistant can change it)
    // 9366 -> 9864: review_share (a Review video's public share link, on or off, as its Share button)
    expect(Buffer.byteLength(JSON.stringify(TOOLS))).toBe(9864);
  });
});
