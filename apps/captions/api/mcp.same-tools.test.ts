import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// What the assistant is sent for an account with no editing style: the dock's tool list, an outside AI key's tool list
// and the prompt, compared character for character with a golden file. The golden was written by this same test on
// the commit before the assistant could save a style, so this file must keep running as it is on an older checkout: it
// imports nothing newer than the assistant itself. UPDATE_GOLDEN=1 writes the file from what this checkout sends, with
// the tools in ADDED taken out (so it stays "main without the style tools"); never on a branch that adds a tool.

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "same-tools-"));
process.env.APP_SECRET = "same-tools-secret";

const { createUser, newApiKey } = await import("./users");
const app = (await import("./boot")).default;
const { serverPlugins } = await import("./plugins.gen");
const { pairDevice } = await import("./lib/devices");
const { saveSettings } = await import("./lib/providers");
const { DEFAULT_SETTINGS } = await import("../contracts/providers");

const ana = createUser("ana", "password1");
const fullKey = `Bearer ${newApiKey(ana, "full")}`;
const mac = pairDevice("ana", "Ana's Mac");
await saveSettings({ ...structuredClone(DEFAULT_SETTINGS), instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: mac.device.id }] }, "ana");

type Tool = { name: string; description: string; inputSchema: unknown };
type Golden = { system: string; user: string; dock: Tool[]; outside: string[] };
const json = (body: unknown, extra: Record<string, string> = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
const toolsOf = async (authorization: string) =>
  ((await (await app.request("/api/mcp", json({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { authorization }))).json()) as { result: { tools: Tool[] } }).result.tools
    // what the model reads of each tool; a title and annotations are labels for the AI app around it
    .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

const file = path.join(import.meta.dirname, "golden", "assistant-no-style.json");
/** The tools every account gets since: the list is main's with these in it and nothing else moved. */
const ADDED = ["upload_file", "channel_posts", "editor_style_save", "design_make", "design_layers"];
/** The assistant's tools an outside AI key gets since, with the same definition as the dock's. */
const OPENED = ["use_file"];
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

// a plug-in adds its own tools and guide: the golden is the app's own, with none loaded
describe.skipIf(serverPlugins.length > 0)("an account with no editing style", () => {
  it("gets main's prompt and main's tool list plus editor_style_save, in the dock and on an outside AI key", async () => {
    const cookie = (await app.request("/api/auth/login", json({ username: "ana", password: "password1" }))).headers.get("set-cookie")!.split(";")[0]!;
    expect((await app.request("/api/assistant/turn", json({ text: "What can you do?" }, { cookie }))).status).toBe(202);
    const job = (await (await app.request("/api/devices/relay/wait", json({}, { authorization: `Bearer ${mac.token}` }))).json()) as { id: string; system: string; user: string; mcp: { token: string } };
    const dock = await toolsOf(`Bearer ${job.mcp.token}`);
    const outside = await toolsOf(fullKey);
    await app.request(`/api/devices/relay/${job.id}/done`, json({ text: "Done." }, { authorization: `Bearer ${mac.token}` }));

    const main = (list: Tool[]) => list.filter((t) => !ADDED.includes(t.name));
    const mainOutside = (list: Tool[]) => main(list).filter((t) => !OPENED.includes(t.name));
    if (process.env.UPDATE_GOLDEN) writeFileSync(file, `${JSON.stringify({ system: job.system, user: job.user, dock: main(dock), outside: mainOutside(outside).map((t) => t.name) } satisfies Golden, null, 1)}\n`);
    const golden = JSON.parse(readFileSync(file, "utf8")) as Golden;

    expect(job.system).toBe(golden.system);
    expect(job.user).toBe(golden.user);
    // every tool main lists, in main's order, each definition character for character
    expect(JSON.stringify(main(dock))).toBe(JSON.stringify(golden.dock));
    expect(JSON.stringify(mainOutside(outside))).toBe(JSON.stringify(golden.outside.map((name) => golden.dock.find((t) => t.name === name))));
    if (process.env.UPDATE_GOLDEN) return;

    // what is new: these tools, the same definitions for both callers
    expect(dock.filter((t) => ADDED.includes(t.name)).map((t) => t.name)).toEqual(ADDED);
    expect(outside.filter((t) => ADDED.includes(t.name))).toEqual(dock.filter((t) => ADDED.includes(t.name)));
    expect(outside.filter((t) => OPENED.includes(t.name))).toEqual(dock.filter((t) => OPENED.includes(t.name)));
    // what every turn of every person now carries: say so in the commit when a number moves
    const def = dock.find((t) => t.name === "editor_style_save")!;
    expect(Buffer.byteLength(def.description)).toBeLessThanOrEqual(300);
    expect(Buffer.byteLength(def.description)).toBe(131);
    // the description, the name and ten typed fields (those alone are 387 bytes; size is 52, passes 28), and the comma before it in the
    // list: 534; upload_file adds 345 (its 182-byte description, path and size); channel_posts 426 (the connected
    // social accounts' numbers and posts, read again first when over an hour old; its 279-byte description, platform and refresh)
    // design_make and design_layers add 978 (the designer's two tools: start or find a design, read its pages and write
    // layers onto them; their 291- and 208-byte descriptions, six fields and two). How layers are written is not in
    // them: design_layers hands it over when a design is read, so it costs nothing on a turn that designs nothing
    expect(bytes(dock) - bytes(main(dock))).toBe(2283);
    // an outside key gets those and use_file (1217, as the dock lists it): a file its AI sent with upload_file goes on from there
    expect(bytes(outside) - bytes(mainOutside(outside))).toBe(3500);
  });
});
