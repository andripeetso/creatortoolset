import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthVars } from "./auth";
import type { StorageFolder } from "../contracts/storage";

// One folder list (PRD decision 1): an id added in Settings is the id the computer's answer carries (A1), a folder on a
// computer no account has is listed as "Computer not found" (A2), and the plug-in's storage.json is imported once (A12).
const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
const dir = realpathSync(mkdtempSync(path.join(scratch, "devices-storage-one-list-")));
process.env.DATA_DIR = path.join(dir, "data");
const { storageApp, ensureUseFolder, importStudioFile, storageOf } = await import("./devices-storage");
const { relayFolders } = await import("./library/report");
const { parseStorageFile } = await import("./lib/storage");

const USER = "owner-one";
const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: USER, role: "admin" } as never);
  return next();
});
app.route("/api/devices/storage", storageApp);

const folder = (id: string, host: string, p: string, role: StorageFolder["role"] = "footage"): StorageFolder =>
  ({ id, role, name: path.basename(p), origin: { host, path: p }, make: false, createdAt: 1, reach: {} }) as StorageFolder;

beforeAll(() => {
  mkdirSync(process.env.DATA_DIR!, { recursive: true });
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("one folder list (A1, A2)", () => {
  it("a folder added on the computer answers with the same id in Settings and in the computer's relay list", async () => {
    const shoot = path.join(dir, "Shoot");
    mkdirSync(shoot, { recursive: true });
    // this server's own computer: "this-computer" is stored under the device id it reports (none paired here: the folder is kept as added)
    const r = await app.request("/api/devices/storage/folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "footage", host: "this-computer", path: shoot }),
    });
    expect(r.status).toBe(200);
    const added = ((await r.json()) as { folders: StorageFolder[] }).folders.find((f) => f.origin.path === shoot)!;
    const settings = ((await (await app.request("/api/devices/storage")).json()) as { folders: StorageFolder[] }).folders.find((f) => f.id === added.id);
    expect(settings).toBeDefined();
    const computer = { id: "this-computer", owner: USER } as never;
    const relay = await relayFolders(computer);
    expect(relay.map((x) => x.id)).toContain(added.id);
    expect((await storageOf(USER)).folders.map((f) => f.id)).toContain(added.id);
  });

  it("a folder whose computer is none of the account's is listed, marked missing, and never dropped", async () => {
    const st = path.join(dir, "data", "storage", `${USER}.json`);
    mkdirSync(path.dirname(st), { recursive: true });
    writeFileSync(st, JSON.stringify({ schemaVersion: 3, folders: [folder("gone-1", "device-nobody-has", "/Volumes/Tiny/Shoot")] }));
    const view = (await (await app.request("/api/devices/storage")).json()) as { folders: (StorageFolder & { missing?: boolean })[] };
    const row = view.folders.find((f) => f.id === "gone-1");
    expect(row).toMatchObject({ missing: true, origin: { host: "device-nobody-has" } });
    expect((await storageOf(USER)).folders.map((f) => f.id)).toContain("gone-1");
  });
});

describe("the plug-in's storage.json, imported once (A12)", () => {
  // hostnames as the studio keeps them: one known computer (tiny-mac, id tiny-id), one unknown (tiny-linux), and one
  // that duplicates a row the core list already has (same use, computer, path)
  const lookup = (host: string) => (host === "tiny-mac" ? { id: "dev-studio", owner: USER } : undefined);
  const file = path.join(dir, "storage-plugin.json");
  const studioFile = {
    schemaVersion: 3,
    folders: [
      folder("studio-a", "tiny-mac", "/Volumes/Tiny/FOOTAGE"),
      folder("studio-b", "tiny-linux", "/mnt/shoots"),
      folder("studio-dup", "tiny-mac", "/Volumes/Dup/Shoot"),
    ],
  };
  const coreRows = (): StorageFolder[] => (parseStorageFile(readFileSync(path.join(dir, "data", "storage", `${USER}.json`), "utf-8")).folders);

  it("maps the known hostname to its device id, keeps the unknown one under its name, keeps the marker's id on a duplicate, and renames the file", async () => {
    // the core list already holds the duplicate under the device id, with another id
    const st = path.join(dir, "data", "storage", `${USER}.json`);
    writeFileSync(st, JSON.stringify({ schemaVersion: 3, folders: [folder("core-dup", "dev-studio", "/Volumes/Dup/Shoot")] }));
    writeFileSync(file, JSON.stringify(studioFile));
    const n = await importStudioFile(file, USER, (x) => x, lookup);
    expect(n).toBe(3);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.migrated`)).toBe(true);
    const rows = coreRows();
    expect(rows.find((f) => f.id === "studio-a")).toMatchObject({ origin: { host: "dev-studio", path: "/Volumes/Tiny/FOOTAGE" } });
    expect(rows.find((f) => f.id === "studio-b")).toMatchObject({ origin: { host: "tiny-linux" } });
    // the duplicate collapses into one row: the studio's id (the one its computer's marker was written with)
    expect(rows.filter((f) => f.origin.path === "/Volumes/Dup/Shoot")).toHaveLength(1);
    expect(rows.find((f) => f.origin.path === "/Volumes/Dup/Shoot")!.id).toBe("studio-dup");
  });

  it("running it again changes nothing (no file left to read)", async () => {
    const before = JSON.stringify(coreRows());
    expect(await importStudioFile(file, USER, (x) => x, lookup)).toBe(0);
    expect(JSON.stringify(coreRows())).toBe(before);
  });
});

describe("Projects and Exports are made beside the workspace's first Media folder (decision 3)", () => {
  const listFile = (folders: StorageFolder[]) => writeFileSync(path.join(dir, "data", "storage", `${USER}.json`), JSON.stringify({ schemaVersion: 3, folders }));

  it("makes Projects next to the Media folder on that computer, once, and keeps it as a record", async () => {
    const dev = "dev-studio-1";
    listFile([folder("m1", dev, "/Volumes/Tiny/Shoots")]);
    const made = await ensureUseFolder(USER, undefined, "projects", dev);
    expect(made).toMatchObject({ role: "projects", origin: { host: dev, path: "/Volumes/Tiny/Projects" }, make: true });
    const again = await ensureUseFolder(USER, undefined, "projects", dev);
    expect(again).toEqual(made);
    expect((await storageOf(USER)).folders.filter((f) => f.role === "projects")).toHaveLength(1);
  });

  it("never makes one on the internal disk: with only a home-folder Media folder it says what to choose", async () => {
    const dev = "dev-studio-2";
    listFile([folder("m2", dev, "~/Movies/Shoots")]);
    const r = await ensureUseFolder(USER, undefined, "library", dev);
    expect(r).toEqual({ error: "Choose a Projects folder in Settings → Folders." });
    expect((await storageOf(USER)).folders.some((f) => f.role === "library")).toBe(false);
  });

  it("refuses a Media folder at a volume's root: Projects would land beside the volumes, not on it", async () => {
    const dev = "dev-studio-3";
    listFile([folder("m3", dev, "/Volumes/MONOLITH")]);
    expect(await ensureUseFolder(USER, undefined, "projects", dev)).toEqual({ error: "Choose a Projects folder in Settings → Folders." });
    expect((await storageOf(USER)).folders.filter((f) => f.role === "projects")).toHaveLength(0);
  });
});
