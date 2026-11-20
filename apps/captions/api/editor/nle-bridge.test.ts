import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The chat's editor commands (mcp-tools/nle.ts, editor/nle-bridge.ts): listed only on a turn sent from a timeline page,
// run by a fake page that takes the request and answers it, refused for another workspace and for a Read only member.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "nle-bridge-"));
process.env.APP_SECRET = "nle-bridge-secret";

const app = (await import("../boot")).default;
const { createUser, setRead } = await import("../users");
const { mintJobToken } = await import("../auth");
const { pairDevice } = await import("../lib/devices");
const { saveSettings } = await import("../lib/providers");
const { DEFAULT_SETTINGS } = await import("../../contracts/providers");
const { serverPlugins } = await import("../plugins.gen");
const { timelineOf } = await import("./nle-bridge");

const ana = createUser("nle-ana", "password1");
const mac = pairDevice("nle-ana", "Ana's Mac");
await saveSettings({ ...structuredClone(DEFAULT_SETTINGS), instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: mac.device.id }] }, "nle-ana");
const json = (body: unknown, extra: Record<string, string> = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
const cookie = (await app.request("/api/auth/login", json({ username: "nle-ana", password: "password1" }))).headers.get("set-cookie")!.split(";")[0]!;
const CLIENT = "tab-1";

/** A message sent from `page` in its own chat: the token its reply's tools are called with. */
async function turnFrom(page: string, workspace?: string): Promise<string> {
  const { id } = (await (await app.request("/api/assistant/chats", { method: "POST", headers: { cookie } })).json()) as { id: string };
  const sent = await app.request(`/api/assistant/chats/${id}/turn`, json({ text: "Make it 26 s", context: { path: page, title: "Editor", client: CLIENT }, ...(workspace ? { workspace } : {}) }, { cookie }));
  expect(sent.status).toBe(202);
  const chat = (await (await app.request(`/api/assistant/chats/${id}`, { headers: { cookie } })).json()) as { messages: Array<{ id: string }> };
  return `Bearer ${mintJobToken("nle-ana", chat.messages.at(-1)!.id)}`;
}
const rpc = async (token: string, method: string, params: Record<string, unknown> = {}) =>
  ((await (await app.request("/api/mcp", json({ jsonrpc: "2.0", id: 1, method, params }, { authorization: token }))).json()) as { result: Record<string, unknown> }).result;
const names = async (token: string) => ((await rpc(token, "tools/list")).tools as Array<{ name: string }>).map((t) => t.name);
const call = async (token: string, name: string, args: Record<string, unknown> = {}) => {
  const r = (await rpc(token, "tools/call", { name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  return { error: !!r.isError, text: r.content[0]!.text };
};
/** The page: waits for the requests for its window. */
async function pending(): Promise<Array<{ id: string; kind: string; edit: string; draft: string; commands?: unknown[] }>> {
  for (let i = 0; i < 200; i++) {
    const r = (await (await app.request(`/api/editor/nle/pending?client=${CLIENT}`, { headers: { cookie } })).json()) as { requests: Awaited<ReturnType<typeof pending>> };
    if (r.requests.length) return r.requests;
    await new Promise((ok) => setTimeout(ok, 10));
  }
  throw new Error("no request came");
}
const reply = (body: unknown) => app.request("/api/editor/nle/reply", json(body, { cookie }));

// a plug-in's own timeline pages replace the app's: its suite checks those
describe.skipIf(serverPlugins.length > 0)("editor commands in the chat", () => {
  it("are listed only on a timeline page, and run on the page that sent the message", async () => {
    const make = async (name: string) => ((await (await app.request("/api/workshop/projects", json({ name }, { cookie }))).json()) as { id: string }).id;
    const tiny = await make("Tiny Acrobatics");
    const other = await make("Other Brand");
    const made = (await (await app.request("/api/editor/empty", json({ name: "Rolls", projectId: tiny }, { cookie }))).json()) as { id: string; draft: string };

    const library = await turnFrom("/library", tiny);
    expect((await names(library)).filter((n) => n.startsWith("nle_"))).toEqual([]);
    expect((await call(library, "nle_state")).text).toContain("navigate to the draft");
    // a project's page is not a timeline (an account writes three replies at once: this one is read off its path)
    expect(timelineOf(`/editor/p/${made.id}`)).toBeNull();
    expect(timelineOf("/editor/e%201/v2?t=3")).toEqual({ edit: "e 1", draft: "v2" });

    const editor = await turnFrom(`/editor/${made.id}/${made.draft}?t=3`, tiny);
    const listed = (await rpc(editor, "tools/list")).tools as Array<{ name: string; description: string }>;
    expect(listed.filter((t) => t.name.startsWith("nle_")).map((t) => t.name)).toEqual(["nle_state", "nle_run"]);
    expect(listed.find((t) => t.name === "nle_run")!.description).toContain("setLength(seconds: the new length in seconds)");
    expect(listed.find((t) => t.name === "nle_state")!.description).toContain("Never name a child");

    // the round trip: the page takes the request and answers; a second answer to it is dropped
    const run = call(editor, "nle_run", { commands: [{ id: "setLength", params: { seconds: 26 } }] });
    const [asked] = await pending();
    expect(asked).toMatchObject({ kind: "run", edit: made.id, draft: made.draft, commands: [{ id: "setLength", params: { seconds: 26 } }] });
    expect((await reply({ id: asked.id, result: { length: 26 } })).status).toBe(204);
    expect(JSON.parse((await run).text)).toMatchObject({ status: "done", result: { length: 26 } });
    expect((await reply({ id: asked.id, result: { length: 3 } })).status).toBe(204);
    // a late answer to the old request does not answer the next one
    const state = call(editor, "nle_state");
    const [next] = await pending();
    await reply({ id: asked.id, result: { length: 3 } });
    await reply({ id: next.id, error: "Command 1 (nudgeOn): nothing to do it on" });
    const refused = await state;
    expect(refused.error).toBe(true);
    expect(refused.text).toContain("Command 1 (nudgeOn): nothing to do it on");

    // nobody answers in 5 s: the editor is not open there
    const quiet = await call(editor, "nle_state");
    expect(JSON.parse(quiet.text)).toMatchObject({ status: "not_open" });
    expect(quiet.text).toContain("navigate");

    // a message from the same timeline in a chat of another workspace
    const elsewhere = await turnFrom(`/editor/${made.id}/${made.draft}`, other);
    expect((await call(elsewhere, "nle_state")).text).toContain("another workspace");

    // a Read only member of the Editor asks nothing of the page
    setRead(ana, ["editor"]);
    expect((await call(editor, "nle_run", { commands: [{ id: "start" }] })).text).toContain("read-only");
    setRead(ana, []);
    expect((await (await app.request(`/api/editor/nle/pending?client=${CLIENT}`, { headers: { cookie } })).json())).toEqual({ requests: [] });
  }, 20_000);
});
