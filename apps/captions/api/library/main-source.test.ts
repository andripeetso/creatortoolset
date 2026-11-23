import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// A plug-in source that is the Media Library (LibrarySource.main) is that only in the workspace its plug-in serves
// itself (its uploadsTo). Every other workspace on the same server keeps its own library: the Finals tools are there,
// and Face Blur's covered copies and made voices are saved into that workspace's library.
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "main-source-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "main-source-secret";
process.env.LIBRARY_DISK_RESERVE_GB = "0";
process.env.ELEVENLABS_API_KEY = "";
const A = "eeeeeeee-0000-4000-8000-00000000000a";
const B = "eeeeeeee-0000-4000-8000-00000000000b";
vi.mock("../plugins.gen", async () => {
  const { workspaceScope } = await import("../lib/workshop/workspace");
  return {
    serverPlugins: [
      {
        id: "store",
        uploadsTo: () => (workspaceScope.getStore()?.id === "eeeeeeee-0000-4000-8000-00000000000a" ? "store" : null),
        library: { source: { id: "store", label: "Footage store", main: true } },
      },
      (await import("../../editor-steps/blur-faces/plugin")).default,
    ],
  };
});
// Face Blur's AI provider: chooses the one face it is shown
vi.mock("../ai-vision", () => ({
  anyVisionConfigured: () => true,
  completeVisionWithFallback: async (_s: string, _u: string, _i: unknown[], _sig: unknown, parse: (t: string) => unknown) => ({ value: parse('{"blur": ["F1"]}'), provider: "test" }),
}));
vi.mock("../lib/uploads", async (real) => ({ ...(await real<typeof import("../lib/uploads")>()), freeBytes: async () => 100 * 1024 ** 3 }));
afterAll(() => {
  delete process.env.LIBRARY_DISK_RESERVE_GB;
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

mkdirSync(path.join(dir, "workshop", "projects"), { recursive: true });
for (const [id, name, at] of [[A, "Tiny Acrobatics", 1], [B, "Climbers", 2]] as const)
  writeFileSync(path.join(dir, "workshop", "projects", `${id}.json`), JSON.stringify({ id, owner: "ana", name, createdAt: at, updatedAt: at }));

const app = (await import("../boot")).default;
const { createUser, newApiKey } = await import("../users");
const { workspaceScope } = await import("../lib/workshop/workspace");
const { mainSourceFor } = await import("./access");
const { mainSource } = await import("./sources");
const { fileBlur, libraryDb } = await import("./db");
const { saveToLibrary } = await import("./routes");
const { saveMyKey } = await import("../my-keys");
const { useFile } = await import("../assistant-files");
const { autoCan, autoJobs, queueVersion } = await import("../../editor-steps/blur-faces/plugin");

const ana = createUser("ana", "password1", { role: "admin" });
const key = `Bearer ${newApiKey(ana, "full")}`;
const cookie = (await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "ana", password: "password1" }) })).headers.get("set-cookie")!.split(";")[0]!;
const d = libraryDb();
for (const [lib, ws] of [["lib_a", A], ["lib_b", B]])
  d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES (?, 'ana', 'Library', 'local', ?, 0)").run(lib, JSON.stringify({ projectId: ws, upload: "all", setupAt: "2026-11-01" }));
const inWs = <T,>(ws: string, fn: () => Promise<T>) => workspaceScope.run({ id: ws }, fn);
const req = (ws: string, url: string, init: { method?: string; body?: unknown; auth?: string } = {}) =>
  app.request(url, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", "x-ct-workspace": ws, ...(init.auth ? { authorization: init.auth } : { cookie }) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

describe("the Media Library's main source, per workspace", () => {
  it("is the plug-in's source only in the workspace it serves; elsewhere the workspace's own library", async () => {
    expect(mainSource()?.id).toBe("store"); // server-wide: the install has one
    expect((await inWs(A, () => mainSourceFor("ana")))?.id).toBe("store");
    expect(await inWs(B, () => mainSourceFor("ana"))).toBeUndefined();
    // a workspace named outright wins over the one the request works in
    expect((await inWs(B, () => mainSourceFor("ana", A)))?.id).toBe("store");
    expect(await inWs(A, () => mainSourceFor("ana", B))).toBeUndefined();
  });

  it("the Finals tools and their paragraph are left out in the plug-in's workspace and offered in every other one", async () => {
    const FINALS = ["finals_pieces", "finals_piece_update", "finals_piece_trash"];
    const rpc = async (ws: string, method: string, params: unknown = {}) =>
      ((await (await req(ws, "/api/mcp", { method: "POST", auth: key, body: { jsonrpc: "2.0", id: 1, method, params } })).json()) as {
        result: { tools?: { name: string }[]; instructions?: string; isError?: boolean };
      }).result;
    expect((await rpc(A, "tools/list")).tools!.map((t) => t.name).filter((n) => FINALS.includes(n))).toEqual([]);
    expect((await rpc(B, "tools/list")).tools!.map((t) => t.name)).toEqual(expect.arrayContaining(FINALS));
    expect((await rpc(A, "initialize")).instructions).not.toContain("finals_pieces");
    expect((await rpc(B, "initialize")).instructions).toContain("finals_pieces lists them");
    expect((await rpc(A, "tools/call", { name: "finals_pieces", arguments: {} })).isError).toBe(true);
    expect((await rpc(B, "tools/call", { name: "finals_pieces", arguments: {} })).isError).toBeFalsy();
  });

  it("Face Blur covers a file in another workspace and saves the covered copy into that workspace's library; never in the plug-in's", async () => {
    expect((await req(B, "/api/plugins/blur-faces/workspaces", { method: "PUT", body: { only: [A, B] } })).status).toBe(200);
    for (const ws of [A, B]) expect((await req(ws, "/api/x/blur-faces/settings", { method: "PUT", body: { mode: "all", who: "Every child's face", look: "blur" } })).status).toBe(200);
    const added = async (lib: string) => {
      const file = path.join(dir, `in-${randomUUID()}.jpg`);
      writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xe0, Math.floor(Math.random() * 255), Math.floor(Math.random() * 255)]));
      const r = await saveToLibrary("ana", file, "Tiny take.jpg", [], lib, true);
      if (!r || !("versionId" in r)) throw new Error(`not added: ${JSON.stringify(r)}`);
      d.prepare("UPDATE assets SET blur = 'yes' WHERE current_version_id = ?").run(r.versionId); // marked Blur faces: Face Blur covers it
      d.prepare("UPDATE asset_versions SET mac_path = ?, mac_device = 'mac-1' WHERE id = ?").run(`/Volumes/Tiny/${r.versionId}.jpg`, r.versionId); // on Ana's Mac
      return r.versionId;
    };
    expect(await inWs(A, () => autoCan("ana"))).toEqual({ can: false, why: "Not available while this workspace's Media Library comes from a plug-in." });
    expect(JSON.stringify(await inWs(B, () => autoCan("ana")))).not.toContain("plug-in");
    expect(await queueVersion({ libraryId: "lib_a", versionId: await added("lib_a"), owner: "ana" })).toBe(false);
    const v = await added("lib_b");
    await queueVersion({ libraryId: "lib_b", versionId: v, owner: "ana" }); // may have been queued already, on the file's event
    const mac = { id: "mac-1", owner: "ana" };
    const job = autoJobs.claim(mac)!;
    expect(job).not.toBeNull();
    const faces = { faces: [{ id: "F1", picture: "/9j/AAAA", note: "middle of the frame" }], sha256: "b".repeat(64) };
    expect(await autoJobs.answer("mac-1", Number(job.id), faces)).toMatchObject({ reply: { blur: ["F1"] } });
    expect(await autoJobs.answer("mac-1", Number(job.id), { made: { path: "/Volumes/Tiny/Imports/Blurred/take blurred.jpg", size: 6, quick: "copy-quick" } })).toEqual({ reply: { ok: true } });
    // the covered copy is the original's blurred render: a version of its clip, so in that workspace's library
    const blurred = fileBlur(v)?.blurredVersionId;
    const made = d.prepare("SELECT a.library_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(blurred ?? "") as { library_id: string };
    expect(made.library_id).toBe("lib_b");
    expect(autoJobs.claim(mac)).toBeNull(); // nothing from the plug-in's workspace was queued
  });

  it("a voice is saved into another workspace's own library; in the plug-in's it is refused and nothing is spoken", async () => {
    saveMyKey("ana", "ELEVENLABS_API_KEY", "anas-own");
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input);
      if (!url.startsWith("https://api.elevenlabs.io/")) throw new Error(`unexpected fetch ${url}`);
      calls.push(url);
      if (url.includes("/v2/voices")) return Response.json({ voices: [{ voice_id: "v_stock", name: "Sam", category: "premade", preview_url: null }], has_more: false });
      return new Response(new Uint8Array([0x49, 0x44, 0x33, 9]), { headers: { "content-type": "audio/mpeg" } });
    });
    const there = await req(A, "/api/editor/voice", { method: "POST", body: { text: "Roll the mat out.", voice: "Sam" } });
    expect({ status: there.status, body: await there.json() }).toEqual({ status: 400, body: { error: "In this workspace the Media Library is the Footage store: a voice cannot be added to it" } });
    expect(calls).toEqual([]);
    const here = await req(B, "/api/editor/voice", { method: "POST", body: { text: "Roll the mat out.", voice: "Sam" } });
    expect(here.status).toBe(200);
    expect(((await here.json()) as { libraryId: string }).libraryId).toBe("lib_b");
  });

  it("a song dropped in the chat is still refused in the plug-in's workspace", async () => {
    const id = randomUUID();
    mkdirSync(path.join(dir, "assistant", "files", "ana", id), { recursive: true });
    writeFileSync(path.join(dir, "assistant", "files", "ana", id, "file"), "bytes");
    writeFileSync(path.join(dir, "assistant", "files", "ana", id, "meta.json"), JSON.stringify({ id, name: "Song.mp3", mime: "audio/mpeg", size: 5, at: Date.now() }));
    await expect(inWs(A, () => useFile(ana as never, id, "library", undefined, undefined, "music"))).rejects.toThrow("Songs and sound effects aren't kept in this workspace's Media Library.");
  });
});
