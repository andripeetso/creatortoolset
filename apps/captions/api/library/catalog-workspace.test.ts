import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// A workspace a plug-in serves (its uploadsTo: a footage catalog) has no core Media Library: no Media folder is added to
// it (Settings, the AI), and no folder's files are indexed into a library of it, a folder for every workspace included.
const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
const dir = mkdtempSync(path.join(scratch, "catalog-ws-"));
const shoots = mkdtempSync(path.join(scratch, "catalog-ws-shoots-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "catalog-ws-secret";
process.env.CT_LOCAL = "1";
process.env.LIBRARY_DISK_RESERVE_GB = "0";
const A = "eeeeeeee-0000-4000-8000-0000000000a1";
const B = "eeeeeeee-0000-4000-8000-0000000000b1";
vi.mock("../plugins.gen", async () => {
  const { workspaceScope } = await import("../lib/workshop/workspace");
  return {
    serverPlugins: [
      {
        id: "store",
        uploadsTo: () => (workspaceScope.getStore()?.id === "eeeeeeee-0000-4000-8000-0000000000a1" ? "store" : null),
        library: { source: { id: "store", label: "Footage store", main: true } },
      },
    ],
  };
});
afterAll(() => {
  delete process.env.CT_LOCAL;
  delete process.env.LIBRARY_DISK_RESERVE_GB;
  rmSync(dir, { recursive: true, force: true });
  rmSync(shoots, { recursive: true, force: true });
});

mkdirSync(path.join(dir, "workshop", "projects"), { recursive: true });
for (const [id, name, at] of [[A, "Tiny Acrobatics", 1], [B, "Climbers", 2]] as const)
  writeFileSync(path.join(dir, "workshop", "projects", `${id}.json`), JSON.stringify({ id, owner: "ana", name, createdAt: at, updatedAt: at }));
const shoot = (name: string) => {
  const p = path.join(shoots, name);
  mkdirSync(p, { recursive: true });
  writeFileSync(path.join(p, "clip.mp4"), "not really a video");
  return p;
};

const app = (await import("../boot")).default;
const { createUser, newApiKey } = await import("../users");
const { libraryDb } = await import("./db");
const { changeStorage, storageOf } = await import("../devices-storage");
const { applyReport, librariesOf } = await import("./report");
const { pairDevice } = await import("../lib/devices");
const { LIBRARY_WORDS } = await import("../../contracts/library");

const ana = createUser("ana", "password1", { role: "admin" });
const key = `Bearer ${newApiKey(ana, "full")}`;
const cookie = (await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "ana", password: "password1" }) })).headers.get("set-cookie")!.split(";")[0]!;
const d = libraryDb();
for (const [lib, ws] of [["lib_a", A], ["lib_b", B]])
  d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES (?, 'ana', 'Library', 'local', ?, 0)").run(lib, JSON.stringify({ projectId: ws, upload: "all", setupAt: "2026-11-01" }));
const req = (ws: string, url: string, init: { method?: string; body?: unknown; auth?: string } = {}) =>
  app.request(url, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", "x-ct-workspace": ws, ...(init.auth ? { authorization: init.auth } : { cookie }) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
const addFolder = (ws: string, role: string, p: string) => req(ws, "/api/devices/storage/folders", { method: "POST", body: { role, host: "this-computer", path: p } });
const versionsIn = (lib: string) => (d.prepare("SELECT COUNT(*) AS n FROM assets WHERE library_id = ?").get(lib) as { n: number }).n;

describe("no Media folder in a workspace a plug-in serves", () => {
  it("Settings: footage (and old music) in the served workspace is refused with the line; Projects and Exports there and footage elsewhere are added", async () => {
    for (const role of ["footage", "music"]) {
      const r = await addFolder(A, role, shoot(`a-${role}`));
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: LIBRARY_WORDS.catalogWorkspace, code: "catalog_workspace" });
    }
    expect((await addFolder(A, "projects", shoot("a-projects"))).status).toBe(200);
    expect((await addFolder(A, "library", shoot("a-exports"))).status).toBe(200);
    expect((await addFolder(B, "footage", shoot("b-footage"))).status).toBe(200);
    const footage = (await storageOf("ana")).folders.filter((f) => f.role === "footage");
    expect(footage.map((f) => f.workspace)).toEqual([B]);
  });

  it("Settings: a Media folder moved into the served workspace too is refused; every workspace is allowed", async () => {
    const f = (await storageOf("ana")).folders.find((x) => x.role === "footage" && x.workspace === B)!;
    const patch = (body: unknown) => req(B, `/api/devices/storage/folders/${f.id}`, { method: "PATCH", body });
    const r = await patch({ workspaces: [B, A] });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe(LIBRARY_WORDS.catalogWorkspace);
    expect((await patch({ workspaces: [A] })).status).toBe(400);
    expect((await storageOf("ana")).folders.find((x) => x.id === f.id)?.workspace).toBe(B);
    expect((await patch({ workspaces: null })).status).toBe(200);
  });

  it("Quick setup in the served workspace sets up Project files and Exports, skips Source media with the line, and does not fail", async () => {
    const base = path.join(shoots, "quick");
    const r = await req(A, "/api/library/lib_a/setup/quick", { method: "POST", body: { device: "this-computer", base } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { note?: string; settings: { setupAt?: string } };
    expect(body.note).toBe(LIBRARY_WORDS.catalogWorkspace);
    expect(body.settings.setupAt).toBeTruthy();
    const made = (await storageOf("ana")).folders.filter((f) => f.origin.path.startsWith(base));
    expect(made.map((f) => [f.role, f.workspace]).sort()).toEqual([["library", A], ["projects", A]]);
  });

  it("the AI's media_import_folder in the served workspace is refused with the line, and nothing goes into its library", async () => {
    const before = versionsIn("lib_a");
    const r = await req(A, "/api/mcp", { method: "POST", auth: key, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "media_import_folder", arguments: { path: shoot("a-ai") } } } });
    const result = ((await r.json()) as { result: { isError?: boolean; content: { text: string }[] } }).result;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(LIBRARY_WORDS.catalogWorkspace);
    expect(versionsIn("lib_a")).toBe(before);
  });
});

describe("the indexer never fills a served workspace's library", () => {
  const mac = pairDevice("ana", "Tiny Mac").device;
  const DIR = "/Volumes/Tiny Footage/Downloads";
  const report = (id: string) => ({ id, state: "ok" as const, scan: `s-${id}`, complete: true, files: [{ path: `${DIR}/clip.mp4`, bytes: 10, mtime: 1_700_000_000_000 }], unreadable: [] });

  it("a Media row scoped to the served workspace (written straight to the list): its files are not indexed", async () => {
    await changeStorage("ana", (st) => {
      st.folders.push({ id: "fold_a", role: "footage", name: "Downloads", origin: { host: mac.id, path: DIR }, make: false, createdAt: 0, reach: {}, workspace: A });
    });
    const folder = (await storageOf("ana")).folders.find((f) => f.id === "fold_a")!;
    expect(await librariesOf("ana", folder)).toEqual([]);
    expect((await applyReport(mac, [report("fold_a")])).index).toEqual([]);
  });

  it("a Media row for every workspace is indexed into the other workspace's library, never the served one's", async () => {
    await changeStorage("ana", (st) => {
      st.folders.push({ id: "fold_all", role: "footage", name: "Downloads", origin: { host: mac.id, path: `${DIR}/all` }, make: false, createdAt: 0, reach: {}, workspace: "*" });
    });
    const folder = (await storageOf("ana")).folders.find((f) => f.id === "fold_all")!;
    expect((await librariesOf("ana", folder)).map((l) => l.id)).toEqual(["lib_b"]);
  });
});
