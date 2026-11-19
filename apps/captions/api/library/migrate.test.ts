import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// U2 §4.6 one-time migration on a synthetic Studio-shaped data folder (Tiny Acrobatics): watch footage and a Finals entry,
// a stored copyTo and a default copy root, places on a Mac, members under none and false, a workspace with folder records
// and no library, version places (one outside every row), the monthly budget, and server-work.json (item 5, not ours).
// MIGRATE_PRINT=1 prints the dry run, for the hand-off.
const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "migrate-"));
process.env.DATA_DIR = dir;
process.env.LIBRARY_DISK_RESERVE_GB = "0";
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const NOW = "2026-11-18T00:00:00.000Z";
// the owner shares ws_b with sam (a member); ws_a has no member; the owner's account is "tinyacrobatics"
writeFileSync(
  path.join(dir, "workspaces.json"),
  JSON.stringify({
    workspaces: [
      {
        id: "tinyacrobatics",
        name: "Tiny Acrobatics",
        plan: "team",
        createdAt: 0,
        members: [
          { username: "tinyacrobatics", role: "owner", ai: "own", budgetUsd: 0, joinedAt: 0 },
          { username: "sam", role: "member", ai: "own", budgetUsd: 0, joinedAt: 0, workspaces: ["ws_b"] },
        ],
      },
    ],
    invites: [],
    spend: {},
  }),
);
writeFileSync(path.join(dir, "server-work.json"), '{"on":true}');
// the last 30 days' spend per workspace: ws_b 12 + 6 = 18 (the describe line counts ws_a's 50 too, not ws_b's); a hour from September is out
writeFileSync(
  path.join(dir, "mac-claude-usage.json"),
  JSON.stringify({
    "2026-11-10T09": {
      "Media Library shot descriptions": { costUsd: 12, ws: { ws_b: { costUsd: 12 } } },
      "Media Library describe": { costUsd: 56, ws: { ws_a: { costUsd: 50 }, ws_b: { costUsd: 6 } } },
    },
    "2026-09-01T09": { "Media Library describe": { costUsd: 100, ws: { ws_b: { costUsd: 100 } } } },
  }),
);

const { libraryDb } = await import("./db");
const { migrateOnce, migrateLibraries, under } = await import("./migrate");
const d = libraryDb();

const lib = (id: string, name: string, s: object) => d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES (?, 'tinyacrobatics', ?, 'local', ?, 0)").run(id, name, JSON.stringify(s));
lib("lib_a", "Tiny Acrobatics", {
  projectId: "ws_a",
  upload: "none",
  copyTo: "/Volumes/Tiny Footage/Copies",
  places: [
    { path: "/Users/tiny/Movies/Shoots", mode: "in-place" },
    { path: "/Users/tiny/Movies/Old", mode: "copy" },
  ],
  watch: [
    { path: "/srv/footage/a", mode: "reference", addedBy: "tinyacrobatics" },
    { path: "/srv/finals", mode: "reference", addedBy: "tinyacrobatics", projects: { "reel-1": "proj_1" } },
    { path: "/srv/collect", mode: "copy", collectionId: "col_1", addedBy: "tinyacrobatics" },
  ],
});
lib("lib_b", "Tiny Acrobatics Stories", {
  projectId: "ws_b",
  upload: false,
  copyTo: "/Volumes/Tiny Footage/Stories",
  places: [{ path: "/Users/tiny/Movies/Gone", mode: "in-place" }],
  lookBudget: 10,
});
const asset = (id: string, libraryId: string) => d.prepare("INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES (?, ?, 'video', 'V', 'tinyacrobatics', 0)").run(id, libraryId);
asset("a_a1", "lib_a");
asset("a_a2", "lib_a");
asset("a_a3", "lib_a");
asset("a_b1", "lib_b");
// a1: indexed by the studio Mac under the copy root; a2: a verified place on the laptop under Shoots; a3: verified, under no row
const version = (id: string, assetId: string, macPath: string | null, macDevice: string | null) =>
  d.prepare(
    "INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at, mac_path, mac_device, quick) VALUES (?, ?, 1, ?, 10, 'x', 'ready', 'tinyacrobatics', 1, ?, ?, '')",
  ).run(id, assetId, `mac:${id}`, macPath, macDevice);
version("v_a1", "a_a1", "/Volumes/Tiny Footage/Copies/x.mov", "mac_studio");
version("v_a2", "a_a2", null, null);
version("v_a3", "a_a3", null, null);
version("v_b1", "a_b1", null, null);
const place = (versionId: string, device: string, p: string, state: string) =>
  d.prepare("INSERT INTO version_places (version_id, device, kind, folder_id, path, state, source, confirmed_at) VALUES (?, ?, 'original', '', ?, ?, 'test', 1)").run(versionId, device, p, state);
place("v_a2", "mac_laptop", "/Users/tiny/Movies/Shoots/y.mov", "verified");
place("v_a3", "mac_studio", "/Users/tiny/Stray/z.mov", "verified");

// the account's folder list: Shoots already a Source media row on the laptop; ws_c has folder records and no library
mkdirSync(path.join(dir, "storage"), { recursive: true });
const row = (id: string, host: string, p: string, ws: string) => ({ id, role: "footage", name: path.basename(p), origin: { host, path: p }, make: false, createdAt: 1, reach: {}, workspace: ws });
const listFile = path.join(dir, "storage", "tinyacrobatics.json");
writeFileSync(listFile, JSON.stringify({ schemaVersion: 3, folders: [row("f-shoots", "mac_laptop", "/Users/tiny/Movies/Shoots", "ws_a"), row("f-c", "mac_studio", "/Volumes/Tiny Footage/Projects", "ws_c")] }));

const libRow = (id: string) => JSON.parse((d.prepare("SELECT settings FROM libraries WHERE id = ?").get(id) as { settings: string }).settings) as Record<string, unknown>;
const folders = () => (JSON.parse(readFileSync(listFile, "utf-8")) as { folders: { origin: { host: string; path: string }; workspace?: string }[] }).folders;

describe("§4.6 the one-time Media Library migration", () => {
  it("under: a path is its root or inside it; a ~/ root matches the same folder under any home", () => {
    expect(under("/Volumes/Tiny Footage/Copies/x.mov", "/Volumes/Tiny Footage/Copies")).toBe(true);
    expect(under("/Volumes/Tiny Footage/Copies2/x.mov", "/Volumes/Tiny Footage/Copies")).toBe(false);
    expect(under("/Users/tiny/Movies/Creator Toolset/Lib/a.mov", "~/Movies/Creator Toolset/Lib")).toBe(true);
    expect(under("/Users/tiny/Movies/Creator Toolset/Other/a.mov", "~/Movies/Creator Toolset/Lib")).toBe(false);
  });

  it("a dry run lists every change in order and writes nothing", async () => {
    const before = [readFileSync(listFile, "utf-8"), JSON.stringify(libRow("lib_a")), JSON.stringify(libRow("lib_b"))];
    const r = await migrateOnce({ dryRun: true, now: NOW });
    expect(r.skipped).toBeUndefined();
    expect(r.changes.map((c) => [c.libraryId, c.field, c.to])).toEqual([
      ["lib_a", "folder", "Source media on mac_studio: /Volumes/Tiny Footage/Copies (first: added files go here)"],
      ["lib_a", "folder", "Source media on this server: /srv/footage/a"],
      ["lib_a", "folder", "Source media on this server: /srv/collect"],
      ["lib_b", "folder", "Source media on Computer not found: /Volumes/Tiny Footage/Stories (first: added files go here)"],
      ["lib_b", "folder", "Source media on Computer not found: /Users/tiny/Movies/Gone"],
      ["(new library in ws_c)", "setupAt", NOW],
      ["lib_a", "setupAt", NOW],
      ["lib_b", "setupAt", NOW],
      ["lib_b", "upload", "proxies"],
      ["lib_b", "lookBudget", 27],
    ]);
    expect(r.outside).toEqual([{ libraryId: "lib_a", versionId: "v_a3", device: "mac_studio", path: "/Users/tiny/Stray/z.mov" }]);
    expect(r.notes).toEqual([
      "lib_a: /srv/finals is a Finals folder; it stays in settings.watch until the Final exports record carries its projects",
      "lib_a: /srv/collect was filed into a collection; its new files are no longer filed automatically",
      "lib_a: /srv/collect was a copy folder; its files stay where they are",
      "lib_a: /Users/tiny/Movies/Old was a copy place; its files were copied into the copy root",
    ]);
    expect([readFileSync(listFile, "utf-8"), JSON.stringify(libRow("lib_a")), JSON.stringify(libRow("lib_b"))]).toEqual(before);
    if (process.env.MIGRATE_PRINT) console.log(JSON.stringify(r, null, 2));
  });

  it("a real run writes the rows (copy root first), setup, proxies and the cap, and keeps the Finals entry and server-work.json", async () => {
    const r = await migrateOnce({ now: NOW });
    expect(r.changes.length).toBe(10);
    // the copy roots lead, the rows already there keep their place, and the new ones follow
    expect(folders().map((f) => [f.origin.host, f.origin.path, f.workspace])).toEqual([
      ["mac_studio", "/Volumes/Tiny Footage/Copies", "ws_a"],
      ["not-found", "/Volumes/Tiny Footage/Stories", "ws_b"],
      ["mac_laptop", "/Users/tiny/Movies/Shoots", "ws_a"],
      ["mac_studio", "/Volumes/Tiny Footage/Projects", "ws_c"],
      ["this-computer", "/srv/footage/a", "ws_a"],
      ["this-computer", "/srv/collect", "ws_a"],
      ["not-found", "/Users/tiny/Movies/Gone", "ws_b"],
    ]);
    expect((libRow("lib_a").watch as unknown[]).length).toBe(3);
    expect(libRow("lib_a")).toMatchObject({ upload: "none", setupAt: NOW });
    expect(libRow("lib_b")).toMatchObject({ upload: "proxies", setupAt: NOW, lookBudget: 27 });
    expect(libRow("lib_a")).not.toHaveProperty("lookBudget");
    expect(readFileSync(path.join(dir, "server-work.json"), "utf-8")).toBe('{"on":true}');
    expect(existsSync(path.join(dir, "library", "migrated.json"))).toBe(true);
    const made = d.prepare("SELECT id, settings FROM libraries WHERE settings LIKE '%ws_c%'").get() as { id: string; settings: string };
    expect(JSON.parse(made.settings)).toMatchObject({ projectId: "ws_c", setupAt: NOW });
  });

  it("a second run changes nothing: skipped by the marker, and the same work done again finds nothing", async () => {
    expect((await migrateOnce({ now: NOW })).skipped).toMatch(/already migrated/);
    const folderBefore = readFileSync(listFile, "utf-8");
    // the marker is the boot's guard; the migration's own steps must also be convergent on their own
    rmSync(path.join(dir, "library", "migrated.json"));
    const again = await migrateOnce({ now: NOW });
    expect(again.changes).toEqual([]);
    expect(readFileSync(listFile, "utf-8")).toBe(folderBefore);
    expect(await migrateLibraries({ now: NOW })).toEqual([]);
  });
});
