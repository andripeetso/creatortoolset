import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, expect, it } from "vitest";
import type { AuthVars } from "../auth";
import type { AssetCard, AssetDetail, WhereAnswer } from "../../contracts/library";

// One file, three place rows on one computer: a scan row in a folder that was merged away, a scan row in the folder that
// holds it now, and a newer "found" row from the computer's own look (no folder). Show in Finder still gets its path.
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "library-best-row-"));
process.env.DATA_DIR = dir;
delete process.env.CT_LOCAL;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const BRAND = "bbbbbbbb-0000-4000-8000-000000000002";
mkdirSync(path.join(dir, "workshop", "projects"), { recursive: true });
writeFileSync(path.join(dir, "workshop", "projects", `${BRAND}.json`), JSON.stringify({ id: BRAND, owner: "ana", name: "Tiny Acrobatics", createdAt: 1, updatedAt: 1 }));
writeFileSync(
  path.join(dir, "workspaces.json"),
  JSON.stringify({ workspaces: [{ id: "t", name: "Tiny Acrobatics", plan: "team", comped: false, createdAt: 0, members: [{ username: "ana", role: "owner", ai: "own", budgetUsd: 0, joinedAt: 0 }] }], invites: [], spend: {} }),
);

const { libraryDb } = await import("./db");
const { libraryApp } = await import("./routes");
const { searchApp } = await import("./search");
const { sourcePathFor } = await import("./search");
const { placesApp } = await import("./places");
const { fixPlaceRows } = await import("./place-rows");
const { foldersOf } = await import("../editor/reach");
const { pairDevice } = await import("../lib/devices");
const { inRequestWorkspace } = await import("../lib/workspace-scope");

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: c.req.header("x-test-user") ?? "", role: "admin", off: [], read: [] } as never);
  return next();
});
app.use(inRequestWorkspace);
app.route("/api/library", libraryApp);
app.route("/api/library", searchApp);
app.route("/api/library", placesApp);
const get = async <T>(url: string) => {
  const res = await app.request(url, { headers: { "x-test-user": "ana" } });
  expect(res.status).toBe(200);
  return (await res.json()) as T;
};

const d = libraryDb();
d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_t', 't', 'Tiny', 'local', 0)").run();
d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES ('ast_rec', 'lib_t', 'video', 'Tiny recording', 'ver_rec', 'ana', 0)").run();
d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES ('ver_rec', 'ast_rec', 1, 'mac:ver_rec', 10, 'h', 'ready', 'ana', 0)").run();
const mac = pairDevice("ana", "Tiny Studio Mac").device.id;
const file = "/Volumes/TinyNAS/FOOTAGE/Recording 1.MP4";
const row = d.prepare("INSERT INTO version_places (version_id, device, kind, folder_id, path, state, source, checked_at) VALUES ('ver_rec', ?, 'original', ?, ?, ?, ?, ?)");
row.run(mac, "deadf01d", file, "verified", "scan", 1795045324760);
row.run(mac, "livef01d", file, "verified", "scan", 1795103280738);
row.run(mac, "", file, "found", "locate", 1795103281895);
// Settings → Folders on the owner's Mac: the folder that holds the file now (the merged-away one is not listed)
mkdirSync(path.join(dir, "storage"), { recursive: true });
writeFileSync(
  path.join(dir, "storage", "ana.json"),
  JSON.stringify({ schemaVersion: 3, folders: [{ id: "livef01d", role: "footage", name: "FOOTAGE", origin: { host: mac, path: "/Volumes/TinyNAS/FOOTAGE" }, make: false, createdAt: 1, reach: {}, workspace: "*" }] }),
);
// rows the fix-up must leave alone: a computer the server doesn't know (its folder list can't be read), and a row in a listed folder
const other = "dev_somebody_else";
row.run(other, "deadf01d", "/Volumes/X/a.mov", "verified", "scan", 1);
d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES ('ast_two', 'lib_t', 'video', 'Tiny two', 'ver_two', 'ana', 0)").run();
d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES ('ver_two', 'ast_two', 1, 'mac:ver_two', 10, 'h2', 'ready', 'ana', 0)").run();
d.prepare("INSERT INTO version_places (version_id, device, kind, folder_id, path, state, source, checked_at) VALUES ('ver_two', ?, 'original', 'livef01d', '/Volumes/TinyNAS/FOOTAGE/two.MP4', 'verified', 'scan', 5)").run(mac);
// a file only the merged-away folder has a row for: moved to the live folder that holds its path
d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES ('ast_three', 'lib_t', 'video', 'Tiny three', 'ver_three', 'ana', 0)").run();
d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES ('ver_three', 'ast_three', 1, 'mac:ver_three', 10, 'h3', 'ready', 'ana', 0)").run();
d.prepare("INSERT INTO version_places (version_id, device, kind, folder_id, path, state, source, checked_at) VALUES ('ver_three', ?, 'original', 'deadf01d', '/Volumes/TinyNAS/FOOTAGE/sub/three.MP4', 'verified', 'scan', 7)").run(mac);
const all = () => d.prepare("SELECT * FROM version_places ORDER BY version_id, device, folder_id").all();
const rowsOf = (v: string, dev: string) =>
  d.prepare("SELECT folder_id, path, state, checked_at FROM version_places WHERE version_id = ? AND device = ? AND kind = 'original' ORDER BY folder_id").all(v, dev);

it("the exact case: Show in Finder gets the path, and the clip is here", async () => {
  expect(sourcePathFor("lib_t", "ver_rec", { role: "admin" }, mac)).toBe(file);
  const card = (await get<{ items: AssetCard[] }>(`/api/library/lib_t/assets?device=${mac}`)).items.find((c) => c.id === "ast_rec");
  expect(card?.placeWord?.word).toBe("here");
  const where = (await get<WhereAnswer>(`/api/library/lib_t/where?versions=ver_rec&device=${mac}`)).versions.ver_rec;
  expect(where?.word.word).toBe("here");
  // the computer's word is its best row: verified, then the newest check (the folder it is in now)
  expect(where?.computers.find((c) => c.device === mac)?.original).toMatchObject({ state: "verified", folder: "livef01d" });
  const detail = await get<AssetDetail>(`/api/library/lib_t/assets/ast_rec?device=${mac}`);
  expect(detail.sourcePath).toBe(file);
  expect(detail.placeWord?.word).toBe("here");
});

it("the boot fix-up makes the three rows one (the live folder, verified, the newest check), moves a merged-away folder's row, and leaves the rest", async () => {
  const before = JSON.stringify(rowsOf("ver_rec", other)) + JSON.stringify(rowsOf("ver_two", mac));
  expect(fixPlaceRows(foldersOf)).toEqual({ merged: 2, repointed: 1 });
  expect(rowsOf("ver_rec", mac)).toEqual([{ folder_id: "livef01d", path: file, state: "verified", checked_at: 1795103281895 }]);
  expect(rowsOf("ver_three", mac)).toEqual([{ folder_id: "livef01d", path: "/Volumes/TinyNAS/FOOTAGE/sub/three.MP4", state: "verified", checked_at: 7 }]);
  // a computer the server doesn't know, and a row already in its folder, as they were
  expect(JSON.stringify(rowsOf("ver_rec", other)) + JSON.stringify(rowsOf("ver_two", mac))).toBe(before);
  expect(rowsOf("ver_rec", other)).toEqual([{ folder_id: "deadf01d", path: "/Volumes/X/a.mov", state: "verified", checked_at: 1 }]);
  // still the path, still here
  expect(sourcePathFor("lib_t", "ver_rec", { role: "admin" }, mac)).toBe(file);
  const once = JSON.stringify(all());
  expect(fixPlaceRows(foldersOf)).toEqual({ merged: 0, repointed: 0 });
  expect(JSON.stringify(all())).toBe(once);
});

it("a later look that only finds the file (no fingerprint) never downgrades its verified row, and adds no second row", async () => {
  const res = await app.request("/api/library/lib_t/places", {
    method: "POST",
    headers: { "x-test-user": "ana", "content-type": "application/json" },
    body: JSON.stringify({ device: mac, confirmed: [{ versionId: "ver_rec", path: file }], gone: [] }),
  });
  expect(await res.json()).toEqual({ confirmed: ["ver_rec"], refused: [] });
  const rows = rowsOf("ver_rec", mac) as { folder_id: string; state: string; checked_at: number }[];
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ folder_id: "livef01d", state: "verified" });
  expect(rows[0]!.checked_at).toBeGreaterThan(1795103281895);
  expect((await get<WhereAnswer>(`/api/library/lib_t/where?versions=ver_rec&device=${mac}`)).versions.ver_rec?.word.word).toBe("here");
});
