import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// The Workshop tools that live in api/mcp.ts: the current project, unlinking one post, clearing notes, the writer's options.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "mcp-workshop-lines-"));
process.env.APP_SECRET = "mcp-workshop-lines-secret";

vi.mock("../ai-complete", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ai-complete")>()),
  streamWithFallback: vi.fn(),
  completeWithFallback: vi.fn(),
}));

const { createUser, newApiKey } = await import("../users");
const app = (await import("../boot")).default;
const { streamWithFallback } = await import("../ai-complete");
const { pairDevice } = await import("../lib/devices");
const { saveSettings } = await import("../lib/providers");
const { DEFAULT_SETTINGS } = await import("../../contracts/providers");
const { TOOLS } = await import("../mcp");

const ana = createUser("ana", "password1");
const key = `Bearer ${newApiKey(ana, "full")}`;
const mac = pairDevice("ana", "Ana's Mac");
await saveSettings({ ...structuredClone(DEFAULT_SETTINGS), instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: mac.device.id }] }, "ana");

type Row = Record<string, unknown>;
const tool = async (name: string, args: Row = {}) => {
  const r = (await (await app.request("/api/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: key }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()) as {
    result: { content: Array<{ text: string }>; isError?: boolean };
  };
  const text = r.result.content[0]!.text;
  return r.result.isError ? { error: text } : { value: JSON.parse(text) as Row };
};
const route = async (url: string, method = "GET", body?: unknown) =>
  (await (await app.request(url, { method, headers: { authorization: key, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).json()) as Row;

describe("the lines for api/mcp.ts", () => {
  it("workshop_projects marks the current project", async () => {
    const tiny = String((await route("/api/workshop/projects", "POST", { name: "Tiny Acrobatics" })).id);
    const second = String((await route("/api/workshop/projects", "POST", { name: "Second brand" })).id);
    const listed = (await tool("workshop_projects")).value!;
    expect(listed.current).toBe(second);
    expect((listed.projects as Row[]).map((p) => p.id).sort()).toEqual([tiny, second].sort());
    await tool("workshop_set_project", { project: tiny });
    expect((await tool("workshop_projects")).value!.current).toBe(tiny);
  });

  it("workshop_update_session unlinks one post by its link and leaves the others, and clears notes", async () => {
    const id = String((await tool("workshop_new_session", { title: "Two posts", notes: "to clear" })).value!.id);
    const one = "https://www.instagram.com/reel/TinyAcro1/";
    const two = "https://www.instagram.com/p/TinyAcro22/";
    expect((await tool("workshop_update_session", { session: id, post_url: one })).value!.status).toBe("published");
    const both = (await tool("workshop_update_session", { session: id, post_url: two })).value!;
    expect((both.postings as Row[]).map((p) => p.shortcode)).toEqual(["TinyAcro1", "TinyAcro22"]);

    const left = (await tool("workshop_update_session", { session: id, unlink_post_url: one })).value!;
    expect((left.postings as Row[]).map((p) => p.shortcode)).toEqual(["TinyAcro22"]);
    expect((await route(`/api/workshop/sessions/${id}`)).postedNot).toEqual(["TinyAcro1"]);
    // a post that is not linked: refused, and not marked "never match again"
    expect((await tool("workshop_update_session", { session: id, unlink_post_url: "https://www.instagram.com/p/TinyNever9/" })).error).toBe("That post is not linked to this session.");
    expect((await tool("workshop_update_session", { session: id, unlink_post_url: "not a link" })).error).toBe("That post is not linked to this session.");
    expect((await route(`/api/workshop/sessions/${id}`)).postedNot).toEqual(["TinyAcro1"]);

    await tool("workshop_update_session", { session: id, notes: "" });
    expect((await tool("workshop_session", { session: id })).value!.notes).toBeUndefined();
  });

  it("workshop_chat passes my words only and deep research to the writer", async () => {
    vi.mocked(streamWithFallback).mockImplementation((async (_s: string, _u: string, _sig: unknown, parse: (t: string) => unknown) => ({ result: parse(JSON.stringify({ reply: "Done.", edits: [] })), provider: "Claude (Mac)" })) as never);
    const s = (await tool("workshop_new_session", { title: "Options" })).value!;
    const piece = (s.pieces as Row[])[0]!.id;
    const chat = async () => (await route(`/api/workshop/sessions/${String(s.id)}/chat`)) as unknown as Row[];
    await tool("workshop_chat", { session: s.id, piece, message: "I said this. And this.", my_words_only: true, scope: "slight", wait_s: 20 });
    expect((await chat()).find((m) => m.role === "user")).toMatchObject({ mine: true, scope: "slight" });
    expect((await chat()).find((m) => m.role === "user")!.deep).toBeUndefined();
    await tool("workshop_chat", { session: s.id, piece, message: "Plain.", wait_s: 20 });
    const plain = (await chat()).filter((m) => m.role === "user").at(-1)!;
    expect(plain.mine).toBeUndefined();
    // deep research runs on the person's own AI for minutes: here it is only seen to be asked for, then stopped
    const deep = (await tool("workshop_chat", { session: s.id, piece, message: "Is it true?", deep_research: true, wait_s: 0 })).value!;
    expect((await chat()).filter((m) => m.role === "user").at(-1)).toMatchObject({ deep: true });
    await route(`/api/workshop/sessions/${String(s.id)}/chat/${String((deep.reply as Row).id)}/stop`, "POST", {});
  }, 30_000);

  it("the tool list's new size", () => {
    console.log(`TOOLS bytes: ${Buffer.byteLength(JSON.stringify(TOOLS))}`);
  });
});
