import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// A chat's clips "into my library" go to the Media Library of the chat's workspace, decided per workspace: where a
// plug-in serves the workspace itself (its uploadsTo), into that plug-in's store as the person (receiveFile); in every
// other workspace of the same server, into that workspace's own library, through the upload gate as before.
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "chat-to-library-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "chat-to-library-secret";
process.env.LIBRARY_DISK_RESERVE_GB = "0";
// a plug-in that keeps one workspace's media in a store of its own, as a studio's footage store does, and says so in
// the assistant's guide only there
const store = vi.hoisted(() => ({ received: [] as { user: string; workspace?: string; name: string; size: number }[], refusal: null as string | null, ws: "dddddddd-0000-4000-8000-000000000001" }));
vi.mock("../plugins.gen", async () => {
  const { workspaceScope } = await import("../lib/workshop/workspace");
  const here = () => workspaceScope.getStore()?.id === store.ws;
  return {
    serverPlugins: [
      {
        id: "store",
        uploadsTo: () => (here() ? "store" : null),
        receiveFile: async (user: { username: string }, file: { name: string; size: number }) => {
          if (store.refusal) return { error: store.refusal };
          store.received.push({ user: user.username, workspace: workspaceScope.getStore()?.id, name: file.name, size: file.size });
          return { id: `ingest-${store.received.length}`, href: "/library", where: "Tiny Acrobatics' footage store" };
        },
        tools: { defs: [], handlers: {}, guideHere: () => (here() ? "Clips dropped in this chat go into the footage store with use_file." : "") },
      },
    ],
  };
});
vi.mock("../lib/uploads", async (real) => ({ ...(await real<typeof import("../lib/uploads")>()), freeBytes: async () => 100 * 1024 ** 3 }));
afterAll(() => {
  delete process.env.LIBRARY_DISK_RESERVE_GB;
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); // a late background write can race the delete (ENOTEMPTY)
});

const STORE_WS = store.ws;
const OWN_WS = "dddddddd-0000-4000-8000-000000000002";
const projects = path.join(dir, "workshop", "projects");
const workspaces = () => {
  mkdirSync(projects, { recursive: true });
  for (const [id, name, at] of [[STORE_WS, "Tiny Acrobatics", 1], [OWN_WS, "Climbers", 2]] as const) {
    writeFileSync(path.join(projects, `${id}.json`), JSON.stringify({ id, owner: "ana", name, createdAt: at, updatedAt: at }));
  }
};

const app = (await import("../boot")).default;
const { createUser, findUser } = await import("../users");
const { workspaceScope } = await import("../lib/workshop/workspace");
const { useFile } = await import("../assistant-files");
const { libraryDb } = await import("./db");
const { librariesHere, ensureLibrary } = await import("./access");
const { pairDevice } = await import("../lib/devices");
const { mintJobToken } = await import("../auth");
const { saveSettings } = await import("../lib/providers");
const { DEFAULT_SETTINGS } = await import("../../contracts/providers");

const received = store.received;

createUser("ana", "password1", { role: "admin" });
const ana = findUser("ana")! as never;
const d = libraryDb();
const count = (lib: string) => (d.prepare("SELECT COUNT(*) AS n FROM assets WHERE library_id = ?").get(lib) as { n: number }).n;

/** A file dropped in ana's chat, as the dock leaves it. */
function drop(name = "Handstand.mp4"): string {
  const id = randomUUID();
  mkdirSync(path.join(dir, "assistant", "files", "ana", id), { recursive: true });
  writeFileSync(path.join(dir, "assistant", "files", "ana", id, "file"), `bytes of ${id}`);
  writeFileSync(path.join(dir, "assistant", "files", "ana", id, "meta.json"), JSON.stringify({ id, name, mime: "video/mp4", size: 44, at: Date.now() }));
  return id;
}
const inWs = <T,>(ws: string, fn: () => Promise<T>) => workspaceScope.run({ id: ws }, fn);

describe("use_file to the library, per workspace", () => {
  it("a workspace the plug-in serves takes the file into its store as the person; every other workspace's own library takes it there", async () => {
    workspaces();
    const own = await inWs(OWN_WS, async () => (await ensureLibrary("ana"), (await librariesHere("ana"))[0]!.id));
    d.prepare(`UPDATE libraries SET settings = json_set(COALESCE(settings, '{}'), '$.upload', 'all', '$.setupAt', '2026-11-01') WHERE id = ?`).run(own);

    const there = await inWs(OWN_WS, () => useFile(ana, drop(), "library"));
    expect(there).toMatchObject({ to: "library", libraryId: own });
    expect(count(own)).toBe(1);
    expect(received).toEqual([]);

    const served = await inWs(STORE_WS, () => useFile(ana, drop("Roll.mp4"), "library"));
    expect(served).toMatchObject({ to: "library", id: "ingest-1", store: "Tiny Acrobatics' footage store" });
    expect(received).toEqual([{ user: "ana", workspace: STORE_WS, name: "Roll.mp4", size: 44 }]);
    expect(count(own)).toBe(1);

    // the store's own refusal of this person is the answer, word for word
    store.refusal = "you may not change this";
    await expect(inWs(STORE_WS, () => useFile(ana, drop(), "library"))).rejects.toThrow("you may not change this");
    store.refusal = null;
    // an account set to Read for the Media Library sends nothing there, as its phone is told
    const before = received.length;
    await expect(inWs(STORE_WS, () => useFile({ ...(findUser("ana") as object), read: ["media"] } as never, drop(), "library"))).rejects.toThrow("This account can't add footage to that workspace");
    expect(received.length).toBe(before);
  });

  it("under Upload none another workspace's save still goes to a computer (none here: the gate's line), never to the store", async () => {
    const own = await inWs(OWN_WS, async () => (await librariesHere("ana"))[0]!.id);
    d.prepare(`UPDATE libraries SET settings = json_set(settings, '$.upload', 'none') WHERE id = ?`).run(own);
    const before = received.length;
    await expect(inWs(OWN_WS, () => useFile(ana, drop(), "library"))).rejects.toThrow("Add a computer, or turn on Originals in Settings → Media Library.");
    expect(received.length).toBe(before);
    expect(count(own)).toBe(1);
    d.prepare(`UPDATE libraries SET settings = json_set(settings, '$.upload', 'all') WHERE id = ?`).run(own);
  });
});

describe("a chat that keeps no workspace while the person has several", () => {
  it("asks once on an Add / Not now card naming the open workspace, and Add puts the clips there; a chat with its workspace never asks", async () => {
    rmSync(projects, { recursive: true, force: true }); // the chat starts before any workspace: it keeps none
    const mac = pairDevice("ana", "Ana's Mac");
    await saveSettings({ ...structuredClone(DEFAULT_SETTINGS), instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: mac.device.id }] }, "ana");
    const login = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "ana", password: "password1" }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const json = (body: unknown, extra: Record<string, string> = {}) => ({ headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
    expect((await app.request("/api/assistant/turn", { method: "POST", ...json({ text: "Ingest these clips into my library" }, { cookie }) })).status).toBe(202);
    const job = (await (await app.request("/api/devices/relay/wait", { method: "POST", ...json({}, { authorization: `Bearer ${mac.token}` }) })).json()) as { id: string; mcp: { token: string } };
    workspaces();
    // the open one: the store's workspace
    await app.request("/api/workshop/workspace", { method: "PATCH", ...json({ currentProjectId: STORE_WS }, { cookie }) });
    const call = async (token: string, args: Record<string, unknown>) =>
      (await (await app.request("/api/mcp", { method: "POST", ...json({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "use_file", arguments: args } }, { authorization: `Bearer ${token}` }) })).json()) as {
        result: { content: { text: string }[]; isError?: boolean };
      };
    // a new chat keeps its workspace: no card, the clips go straight in, and the answer says where
    const chat = ((await (await app.request("/api/assistant/chats", { method: "POST", headers: { cookie } })).json()) as { id: string }).id;
    expect((await app.request(`/api/assistant/chats/${chat}/turn`, { method: "POST", ...json({ text: "Into my library", workspace: STORE_WS }, { cookie }) })).status).toBe(202);
    const reply = ((await (await app.request(`/api/assistant/chats/${chat}`, { headers: { cookie } })).json()) as { messages: { id: string }[] }).messages.at(-1)!.id;
    const direct = await call(mintJobToken("ana", reply), { file: drop("C.mp4"), to: "library" });
    expect(JSON.parse(direct.result.content[0]!.text).said).toBe("Added 1 clip to Tiny Acrobatics' footage store. They'll show once processed.");
    // the plug-in's line for the store's workspace: in that chat's guide, not in the one that keeps no workspace
    const guide = async (token: string) =>
      ((await (await app.request("/api/mcp", { method: "POST", ...json({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { authorization: `Bearer ${token}` }) })).json()) as { result: { instructions: string } }).result.instructions;
    const LINE = "Clips dropped in this chat go into the footage store with use_file.";
    expect(await guide(mintJobToken("ana", reply))).toContain(LINE);
    expect(await guide(job.mcp.token)).not.toContain(LINE);
    expect((job as unknown as { system: string }).system).not.toContain(LINE);

    const before = received.length;
    const asked = await call(job.mcp.token, { files: [drop("A.mp4"), drop("B.mp4")], to: "library" });
    expect(asked.result.content[0]!.text).toContain("Add these clips to Tiny Acrobatics' Media Library?");
    expect(received.length).toBe(before);
    const view = (await (await app.request("/api/assistant", { headers: { cookie } })).json()) as { messages: { confirms?: { id: string; question: string; yes?: string; no?: string }[] }[] };
    const card = view.messages.at(-1)!.confirms!;
    expect(card).toHaveLength(1);
    expect(card[0]).toMatchObject({ question: "Add these clips to Tiny Acrobatics' Media Library?", yes: "Add", no: "Not now" });
    // Add: the same call runs as ana, in the workspace the card named, whatever is open by then
    await app.request("/api/workshop/workspace", { method: "PATCH", ...json({ currentProjectId: OWN_WS }, { cookie }) });
    expect((await app.request(`/api/assistant/confirms/${card[0]!.id}`, { method: "POST", ...json({ yes: true }, { cookie }) })).status).toBe(200);
    expect(received.slice(before).map((r) => [r.name, r.workspace])).toEqual([
      ["A.mp4", STORE_WS],
      ["B.mp4", STORE_WS],
    ]);
    await app.request(`/api/devices/relay/${job.id}/done`, { method: "POST", ...json({ text: "Done." }, { authorization: `Bearer ${mac.token}` }) });
  });
});
