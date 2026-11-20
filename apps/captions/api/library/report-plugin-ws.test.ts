import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";

// A Media folder in a workspace whose media a plug-in serves itself (a footage catalog) fills no core library: a
// computer's report of it indexes and locates nothing, and no library is made there. Every other workspace is as before.
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "report-plugin-ws-"));
process.env.DATA_DIR = dir;
delete process.env.CT_LOCAL;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";
mkdirSync(path.join(dir, "workshop", "projects"), { recursive: true });
writeFileSync(path.join(dir, "workshop", "projects", `${A}.json`), JSON.stringify({ id: A, owner: "tia", name: "Tiny Catalog", createdAt: 1, updatedAt: 1 }));
writeFileSync(path.join(dir, "workshop", "projects", `${B}.json`), JSON.stringify({ id: B, owner: "tia", name: "Tiny Brand", createdAt: 2, updatedAt: 2 }));

const { createUser } = await import("../users");
const { libraryDb } = await import("./db");
const { homeOf } = await import("./access");
const { applyReport, indexForDevice } = await import("./report");
const { changeStorage } = await import("../devices-storage");
const { pairDevice } = await import("../lib/devices");
const { Hono } = await import("hono");
const { mountPlugins } = await import("../lib/plugin");
const { workspaceScope } = await import("../lib/workshop/workspace");
// a plug-in that serves workspace A's media itself; B's is the core library's
mountPlugins(new Hono(), [{ id: "catalog", uploadsTo: () => (workspaceScope.getStore()?.id === A ? "catalog" : null) }]);
createUser("tia", "password1", { role: "admin" });

const d = libraryDb();
const mac = pairDevice("tia", "Tiny Mac").device;
const row = (id: string, workspace: string) => ({ id, role: "footage" as const, name: id, origin: { host: mac.id, path: `/Volumes/Tiny/${id}` }, make: false, createdAt: 0, reach: {}, workspace });
await changeStorage("tia", (st) => {
  st.folders.push(row("fold_a", A), row("fold_all", "*"), row("fold_b", B));
});

const quick = (n: number) => n.toString(16).padStart(64, "0");
const file = (folder: string, name: string, q: number) => ({ path: `/Volumes/Tiny/${folder}/${name}`, bytes: 10, mtime: 1_700_000_000_000, quick: quick(q) });
let n = 0;
const report = (folder: string, files: ReturnType<typeof file>[]) => applyReport(mac, [{ id: folder, state: "ok", scan: `s${++n}`, complete: true, files, unreadable: [] }]);
const onMac = (folder: string, name: string, q: number) => ({ name, path: `/Volumes/Tiny/${folder}/${name}`, size: 10, quick: quick(q), frames: [] });
const count = (sql: string, ...args: string[]) => (d.prepare(sql).get(...args) as { n: number }).n;
const counts = () => ({ libraries: count("SELECT COUNT(*) AS n FROM libraries"), places: count("SELECT COUNT(*) AS n FROM version_places"), assets: count("SELECT COUNT(*) AS n FROM assets") });
const libOf = (ws: string) => (d.prepare("SELECT id FROM libraries WHERE json_extract(settings, '$.projectId') = ?").get(ws) as { id: string } | undefined)?.id;

it("a row of the plug-in's workspace: the report indexes nothing, makes no library, and the Mac's index makes no clip", async () => {
  const before = counts();
  expect(await report("fold_a", [file("fold_a", "a.mov", 1), file("fold_a", "b.mov", 2)])).toEqual({ ok: true, index: [] });
  expect(await indexForDevice(mac, "fold_a", onMac("fold_a", "a.mov", 1))).toEqual({ versions: [] });
  expect(counts()).toEqual(before);
  expect(libOf(A)).toBeUndefined();
});

it("even with a library there from before, a file it holds is not located", async () => {
  d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_old', ?, 'Library', 'local', ?, 0)").run(homeOf("tia"), JSON.stringify({ projectId: A }));
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES ('ast_k', 'lib_old', 'video', 'k.mov', 'ver_k', 'tia', 0)").run();
  d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at, quick) VALUES ('ver_k', 'ast_k', 1, 'mac:k', 10, 'h', 'ready', 'tia', 0, ?)").run(quick(5));
  const before = counts();
  expect(await report("fold_a", [file("fold_a", "k.mov", 5)])).toEqual({ ok: true, index: [] });
  expect(counts()).toEqual(before);
});

it("a row in every workspace is indexed into B's library only", async () => {
  const answer = await report("fold_all", [file("fold_all", "c.mov", 3)]);
  expect(answer.index).toEqual([{ folder: "fold_all", path: "/Volumes/Tiny/fold_all/c.mov" }]);
  const libB = libOf(B);
  expect(libB).toBeDefined();
  const made = (await indexForDevice(mac, "fold_all", onMac("fold_all", "c.mov", 3))) as { versions: { library: string; versionId?: string }[] };
  expect(made.versions.map((v) => v.library)).toEqual([libB]);
  expect(made.versions[0]!.versionId).toBeTruthy();
  expect(libOf(A)).toBe("lib_old");
  expect(count("SELECT COUNT(*) AS n FROM assets WHERE library_id = 'lib_old'")).toBe(1);
});

it("a row of B is indexed into B's library as before", async () => {
  const answer = await report("fold_b", [file("fold_b", "d.mov", 4)]);
  expect(answer.index).toEqual([{ folder: "fold_b", path: "/Volumes/Tiny/fold_b/d.mov" }]);
  const made = (await indexForDevice(mac, "fold_b", onMac("fold_b", "d.mov", 4))) as { versions: { library: string; versionId?: string }[] };
  expect(made.versions).toEqual([{ library: libOf(B), versionId: expect.any(String) }]);
});
