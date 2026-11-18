import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";

// T4 (local first, P1): a data dir from before the place states, moved by the migrations and the storage schema 2.
// Nothing is lost: every version, place row and folder is still there, counts pinned; rows from before are "Not checked
// yet" (never "On this computer", never missing); a '' fingerprint is tried again; a dead computer's rows stay.
const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "migration-fixture-"));
process.env.DATA_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const { MIGRATIONS } = await import("./schema");
const USER = "tiny";
const BEFORE = MIGRATIONS.findIndex((m) => m.includes("CREATE TABLE version_places_v2"));

// the old library.db, at the user_version before the place states
const file = path.join(dir, "library", "library.db");
mkdirSync(path.dirname(file), { recursive: true });
const old = new DatabaseSync(file);
for (const m of MIGRATIONS.slice(0, BEFORE)) old.exec(m);
old.exec(`PRAGMA user_version = ${BEFORE};
  INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib', '${USER}', 'Tiny Acrobatics', 'local', 0);
  INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES
    ('a1', 'lib', 'video', 'on the dead Mac', 'v1', '${USER}', 0), ('a2', 'lib', 'video', 'uploaded', 'v2', '${USER}', 0),
    ('a3', 'lib', 'video', 'never read', 'v3', '${USER}', 0), ('a4', 'lib', 'video', 'read', 'v4', '${USER}', 0);
  INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at, mac_path, mac_device, quick) VALUES
    ('v1', 'a1', 1, 'mac:v1', 10, 'mac:x', 'ready', '${USER}', 1, '/Volumes/Tiny Footage/a.mov', 'mac_dead', '${"1".repeat(64)}'),
    ('v2', 'a2', 1, 'libraries/lib/v/v2/source.mov', 20, 'y', 'ready', '${USER}', 2, NULL, NULL, ''),
    ('v3', 'a3', 1, 'libraries/lib/v/v3/source.mov', 30, 'z', 'ready', '${USER}', 3, NULL, NULL, NULL),
    ('v4', 'a4', 1, 'libraries/lib/v/v4/source.mov', 40, 'w', 'ready', '${USER}', 4, NULL, NULL, '${"4".repeat(64)}');
  INSERT INTO version_places (version_id, device, path, confirmed_at, gone_at) VALUES
    ('v1', 'mac_dead', '/Volumes/Tiny Footage/a.mov', 7, NULL),
    ('v2', 'mac_live', '/Users/tiny/Movies/b.mov', 8, 9),
    ('v4', 'mac_live', '/Users/tiny/Movies/d.mov', 10, NULL);`);
const count = (t: string) => (old.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
const before = { versions: count("asset_versions"), places: count("version_places"), assets: count("assets") };
old.close();

// the old storage list: footage, music, Finished videos, Finals, and setup's "this computer" folder
const storage = path.join(dir, "storage", `${USER}.json`);
mkdirSync(path.dirname(storage), { recursive: true });
const folder = (id: string, role: string, host: string, p: string) => ({ id, role, name: path.basename(p), origin: { host, path: p }, make: false, createdAt: 1, reach: {} });
const folders = [
  folder("f-footage", "footage", "mac_live", "/Volumes/Tiny Footage/Shoots"),
  folder("f-music", "music", "mac_live", "/Users/tiny/Music/Songs"),
  folder("f-library", "library", "mac_live", "/Users/tiny/Movies/Creator Toolset"),
  folder("f-finals", "finals", "mac_live", "/Users/tiny/Movies/Finals"),
  folder("f-here", "footage", "this-computer", "/Users/tiny/Footage"),
];
writeFileSync(storage, JSON.stringify({ folders }));

const { libraryDb } = await import("./db");
const { whereIs, resolveDevice } = await import("./whereis");
const { placeWordOf } = await import("../../contracts/places");
const { pairDevice, saveReport } = await import("../lib/devices");
const { storageOf, updateFolder } = await import("../devices-storage");
const { useOf } = await import("./report");

describe("T4: a data dir from before the place states", () => {
  it("starts from the user_version before the rebuild", () => {
    expect(BEFORE).toBe(37);
    expect(before).toEqual({ versions: 4, places: 3, assets: 4 });
  });

  it("the migrations keep every version and place row; rows from before are not checked yet, gone times kept", () => {
    const d = libraryDb();
    const n = (t: string) => (d.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
    expect({ versions: n("asset_versions"), places: n("version_places"), assets: n("assets") }).toEqual(before);
    expect(d.prepare("SELECT version_id, device, kind, folder_id, path, state, source, confirmed_at, gone_at FROM version_places ORDER BY version_id").all()).toEqual([
      { version_id: "v1", device: "mac_dead", kind: "original", folder_id: "", path: "/Volumes/Tiny Footage/a.mov", state: "unchecked", source: "migrated", confirmed_at: 7, gone_at: null },
      { version_id: "v2", device: "mac_live", kind: "original", folder_id: "", path: "/Users/tiny/Movies/b.mov", state: "unchecked", source: "migrated", confirmed_at: 8, gone_at: 9 },
      { version_id: "v4", device: "mac_live", kind: "original", folder_id: "", path: "/Users/tiny/Movies/d.mov", state: "unchecked", source: "migrated", confirmed_at: 10, gone_at: null },
    ]);
  });

  it("a '' fingerprint (a read that failed) is tried again; one never read or read stays as it was; no full sha256 yet", () => {
    expect(libraryDb().prepare("SELECT id, quick, full_sha256 FROM asset_versions ORDER BY id").all()).toEqual([
      { id: "v1", quick: "1".repeat(64), full_sha256: null },
      { id: "v2", quick: null, full_sha256: null },
      { id: "v3", quick: null, full_sha256: null },
      { id: "v4", quick: "4".repeat(64), full_sha256: null },
    ]);
  });

  it("a dead computer's rows stay (no alias, never deleted) and read as not checked yet there, never missing", () => {
    expect(resolveDevice("mac_dead")).toBe("mac_dead");
    expect(libraryDb().prepare("SELECT mac_device FROM asset_versions WHERE id = 'v1'").get()).toEqual({ mac_device: "mac_dead" });
    expect(placeWordOf(whereIs("v1"), "mac_dead")).toEqual({ word: "unchecked", computer: "A computer" });
    // the place once found gone is not checked either until its computer lists the folder again
    expect(whereIs("v2")!.computers[0]!.original!.state).toBe("unchecked");
  });

  it("the storage list moves to schema 3: every folder kept, music read as media, this computer is the paired computer the server runs on, the old Library's Footage listed", async () => {
    const here = pairDevice(USER, "Tiny Studio Mac").device.id;
    saveReport(here, { at: Date.now(), drivers: [], homes: [], machine: { host: hostname(), cpus: 8, memGb: 16 } } as never);
    const st = await storageOf(USER);
    expect(st.schemaVersion).toBe(3);
    expect(st.folders.map((f) => [f.id, f.origin.host, f.origin.path, useOf(f)])).toEqual([
      ["f-footage", "mac_live", "/Volumes/Tiny Footage/Shoots", "media"],
      ["f-music", "mac_live", "/Users/tiny/Music/Songs", "media"],
      ["f-library", "mac_live", "/Users/tiny/Movies/Creator Toolset", "exports"],
      ["f-finals", "mac_live", "/Users/tiny/Movies/Finals", "finals"],
      ["f-here", here, "/Users/tiny/Footage", "media"],
      ["f-library:footage", "mac_live", "/Users/tiny/Movies/Creator Toolset/Footage", "media"],
    ]);
    // written back in the account's queue: the next read is the file itself
    await updateFolder(USER, "none", () => null);
    const saved = JSON.parse(readFileSync(storage, "utf-8")) as { schemaVersion: number; folders: { id: string; origin: { host: string } }[] };
    expect(saved.schemaVersion).toBe(3);
    expect(saved.folders.map((f) => f.id)).toEqual([...folders.map((f) => f.id), "f-library:footage"]);
    expect(saved.folders.find((f) => f.id === "f-here")!.origin.host).toBe(here);
  });
});
