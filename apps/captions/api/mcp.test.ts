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
    expect((await tool("workshop_sessions")).value.sessions.map((x: { id: string }) => x.id)).toContain(s.id);
    expect(await tool("workshop_session", { session: "00000000-0000-4000-8000-000000000000" })).toEqual({ error: true, value: "Not found, or not this account's." });
    expect((await tool("list_reviews")).value).toEqual({ reviews: [] });
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

  it("keeps its tool list's size on purpose: it goes into every AI session that connects", () => {
    // growth must be deliberate: check what the new words buy, then update this number (never fix it by cutting words)
    expect(Buffer.byteLength(JSON.stringify(TOOLS))).toBe(4383);
  });
});
