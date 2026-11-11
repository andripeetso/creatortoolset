import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

// An install whose AI Editor is a plug-in's (it answers /api/editor itself): the built-in editor's style tools would
// act on that plug-in's routes by accident, so neither is listed and neither answers. In its own file: which plug-in
// answers /api/editor is the same for the whole server.

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "mcp-editor-styles-plugin-"));
process.env.APP_SECRET = "mcp-editor-styles-plugin-secret";

const { createUser, newApiKey } = await import("../users");
const app = (await import("../boot")).default;
const { definePlugin, mountReplacedRoutes, pluginReplaces } = await import("../lib/plugin");
const { createStyle } = await import("../editor/styles");
const { pairDevice } = await import("../lib/devices");
const { saveSettings } = await import("../lib/providers");
const { DEFAULT_SETTINGS } = await import("../../contracts/providers");

const ana = createUser("ana", "password1");
const anaKey = `Bearer ${newApiKey(ana, "full")}`;
const mac = pairDevice("ana", "Ana's Mac");
await saveSettings({ ...structuredClone(DEFAULT_SETTINGS), instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: mac.device.id }] }, "ana");

const json = (body: unknown, extra: Record<string, string> = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
const rpc = async (authorization: string, method: string, params: unknown = {}) =>
  (await (await app.request("/api/mcp", json({ jsonrpc: "2.0", id: 1, method, params }, { authorization }))).json()) as { result: { tools?: Array<{ name: string }>; content?: Array<{ text: string }>; isError?: boolean } };
const names = async (authorization: string) => (await rpc(authorization, "tools/list")).result.tools!.map((t) => t.name);
const tool = async (authorization: string, name: string, args: Record<string, unknown> = {}) => {
  const r = (await rpc(authorization, "tools/call", { name, arguments: args })).result;
  return { error: !!r.isError, text: r.content![0]!.text };
};

describe("an install whose AI Editor is a plug-in's", () => {
  it("lists neither style tool and answers neither, for the assistant and for an outside AI key, even for an account that has a style", async () => {
    // a style kept from before the plug-in was loaded: it is what would list editor_style_use
    expect(typeof createStyle("ana", { name: "Tiny kept" })).toBe("object");
    // the plug-in's own editor, standing in: the routes are never called here
    if (!pluginReplaces("/api/editor")) mountReplacedRoutes(new Hono(), [definePlugin({ id: "tiny-editor", replaces: { paths: ["/api/editor"], routes: new Hono() } })]);
    expect(pluginReplaces("/api/editor")).toBe(true);

    const cookie = (await app.request("/api/auth/login", json({ username: "ana", password: "password1" }))).headers.get("set-cookie")!.split(";")[0]!;
    expect((await app.request("/api/assistant/turn", json({ text: "Make me an editing style called Tiny fast" }, { cookie }))).status).toBe(202);
    const job = (await (await app.request("/api/devices/relay/wait", json({}, { authorization: `Bearer ${mac.token}` }))).json()) as { id: string; mcp: { token: string } };
    const dock = `Bearer ${job.mcp.token}`;
    for (const auth of [dock, anaKey]) {
      const listed = await names(auth);
      expect(listed).toContain("workshop_projects");
      expect(listed.filter((n) => n.startsWith("editor_style"))).toEqual([]);
      expect(await tool(auth, "editor_style_save", { name: "Tiny fast" })).toEqual({ error: true, text: "Unknown tool editor_style_save." });
      expect(await tool(auth, "editor_style_use")).toEqual({ error: true, text: "Unknown tool editor_style_use." });
    }
    await app.request(`/api/devices/relay/${job.id}/done`, json({ text: "Done." }, { authorization: `Bearer ${mac.token}` }));
  });
});
