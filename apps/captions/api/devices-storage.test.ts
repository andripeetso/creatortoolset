import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthVars } from "./auth";

// a folder added in setup must reach the Library's watch list and the AI Editor's footage lookup
const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
const dir = realpathSync(mkdtempSync(path.join(scratch, "devices-storage-")));
process.env.DATA_DIR = path.join(dir, "data");
process.env.LIBRARY_WATCH_FOLDERS = "1";
process.env.LIBRARY_DISK_RESERVE_GB = "0";
const { libraryDb } = await import("./library/db");
const { watchApp, scanWatchFolders, SETTLE_MS } = await import("./library/watch");
const { storageApp } = await import("./devices-storage");
const { createEdit } = await import("./editor/store");
const { mediaPaths } = await import("./editor/media");

afterAll(() => {
  delete process.env.LIBRARY_WATCH_FOLDERS;
  delete process.env.LIBRARY_DISK_RESERVE_GB;
  rmSync(dir, { recursive: true, force: true });
});

const USER = "owner-s";
const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: USER, role: "admin" } as never);
  return next();
});
app.route("/api/library", watchApp);
app.route("/api/devices/storage", storageApp);

const footage = path.join(dir, "Trip");
const clip = path.join(footage, "take1.mp4");
const libraryId = () => (libraryDb().prepare("SELECT id FROM libraries WHERE workspace_id = ?").get(USER) as { id: string }).id;
const addSetupFolder = (p: string, role = "footage") =>
  app.request("/api/devices/storage/folders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role, host: "this-computer", path: p }),
  });
const watchedPaths = async () => ((await (await app.request(`/api/library/${libraryId()}/watch`)).json()) as { folders: { path: string }[] }).folders.map((f) => f.path);

beforeAll(() => {
  mkdirSync(process.env.DATA_DIR!, { recursive: true });
  mkdirSync(footage, { recursive: true });
  writeFileSync(clip, Buffer.alloc(2048, 7));
});

describe("a folder added in setup", () => {
  it("is refused with the reason when the path is not a folder on this computer", async () => {
    const r = await addSetupFolder(path.join(dir, "no-such-folder"));
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/No such folder on the server/);
    const notAFolder = await addSetupFolder(clip);
    expect(notAFolder.status).toBe(400);
  });

  it("is in the Library's watch list, with its real path, and the Library reads it", async () => {
    const r = await addSetupFolder(footage);
    expect(r.status).toBe(200);
    expect(await watchedPaths()).toEqual([footage]);
  });

  it("reaches the AI Editor: its file is imported and the editor finds it where it is", async () => {
    await scanWatchFolders(Date.now()); // first sighting: the file must settle
    await scanWatchFolders(Date.now() + SETTLE_MS + 1000);
    const v = libraryDb().prepare("SELECT v.id, v.source_path FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE a.library_id = ?").get(libraryId()) as {
      id: string;
      source_path: string | null;
    };
    expect(v.source_path).toBe(clip);
    const edit = await createEdit(USER, { sources: [v.id] });
    expect(edit).not.toBeNull();
    expect((await mediaPaths(edit!, [v.id])).files[v.id]).toBe(clip);
  });

  it("is in the list once, and forgetting it in Settings stops the watch", async () => {
    // the second add is "already there" (the screen treats that as added); the watch list still has it once
    const again = await addSetupFolder(footage);
    expect(((await again.json()) as { error?: string }).error).toMatch(/already/);
    expect(await watchedPaths()).toEqual([footage]);
    const st = (await (await app.request("/api/devices/storage")).json()) as { folders: { id: string; origin: { path: string } }[] };
    const id = st.folders.find((f) => f.origin.path === footage)!.id;
    expect((await app.request(`/api/devices/storage/folders/${id}`, { method: "DELETE" })).status).toBe(200);
    expect(await watchedPaths()).toEqual([]);
  });

  it("a music folder's audio is imported as audio, not as footage", async () => {
    const band = path.join(dir, "Band");
    mkdirSync(band, { recursive: true });
    writeFileSync(path.join(band, "song.mp3"), Buffer.alloc(2048, 3));
    expect((await addSetupFolder(band, "music")).status).toBe(200);
    const later = Date.now() + 10 * SETTLE_MS;
    await scanWatchFolders(later);
    await scanWatchFolders(later + SETTLE_MS + 1000);
    const a = libraryDb()
      .prepare("SELECT a.kind FROM assets a JOIN asset_versions v ON v.asset_id = a.id WHERE v.source_path = ?")
      .get(path.join(band, "song.mp3")) as { kind: string } | undefined;
    expect(a?.kind).toBe("audio");
  });

  it("a typed ~/ path is stored as the full path, so the setup list does not offer it again", async () => {
    const home = process.env.HOME;
    process.env.HOME = dir;
    try {
      const r = await app.request("/api/devices/storage/folders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "footage", host: "this-computer", path: "~/Trip" }),
      });
      expect(r.status).toBe(200);
      const st = (await r.json()) as { folders: { origin: { path: string } }[] };
      expect(st.folders.some((f) => f.origin.path === footage)).toBe(true);
    } finally {
      process.env.HOME = home;
    }
  });

  it("is refused in words the person understands when this server cannot watch folders", async () => {
    process.env.LIBRARY_WATCH_FOLDERS = "0";
    try {
      const r = await addSetupFolder(footage);
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toMatch(/not on your computer/);
    } finally {
      process.env.LIBRARY_WATCH_FOLDERS = "1";
    }
  });
});

// Settings → Storage picks a computer. When that computer is the machine this server runs on (the Mac app's own
// pairing on a server inside the Mac app), its folder joins the Library like a setup folder does.
const { pairDevice, saveReport } = await import("./lib/devices");
describe("a folder added in Settings for the computer this server runs on", () => {
  const add = (host: string, p: string, role = "footage") =>
    app.request("/api/devices/storage/folders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role, host, path: p }) });
  const view = async () => (await (await app.request("/api/devices/storage")).json()) as { here: string[]; folders: { id: string; origin: { host: string; path: string } }[] };
  const machine = (host: string) => ({ at: Date.now(), drivers: [], homes: [], machine: { host, cpus: 8, memGb: 16 } }) as never;
  // this Mac's own pairing reports this machine's name (in another case, as the Mac app does), another computer its own
  const mac = pairDevice(USER, "Tiny Studio Mac").device.id;
  const other = pairDevice(USER, "Tiny Helper").device.id;
  saveReport(mac, machine(hostname().toUpperCase()));
  saveReport(other, machine("tiny-helper.local"));
  const mine = path.join(dir, "Shoot");
  mkdirSync(mine, { recursive: true });
  writeFileSync(path.join(mine, "a.mp4"), Buffer.alloc(1024, 3));

  it("tells the page which computer is this machine", async () => {
    expect((await view()).here).toEqual([mac]);
  });

  it("joins the Library's watch list, keeps the computer it was added on, and leaves the list when it is removed", async () => {
    expect((await add(mac, mine)).status).toBe(200);
    expect(await watchedPaths()).toContain(mine);
    const row = (await view()).folders.find((f) => f.origin.path === mine)!;
    expect(row.origin.host).toBe(mac);
    await app.request(`/api/devices/storage/folders/${row.id}`, { method: "DELETE" });
    expect(await watchedPaths()).not.toContain(mine);
  });

  it("a folder that is not there is refused with the reason, as in setup", async () => {
    const r = await add(mac, path.join(dir, "no-such-folder"));
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/No such folder on the server/);
  });

  it("another computer's folder is only recorded: the server cannot read it, so nothing is watched or checked", async () => {
    const theirs = "/Volumes/Tiny Drive/Footage";
    expect((await add(other, theirs)).status).toBe(200);
    expect(await watchedPaths()).not.toContain(theirs);
  });

  it("where the server may not read the person's folders (a hosted server), a folder is recorded as before and no computer is named", async () => {
    process.env.LIBRARY_WATCH_FOLDERS = "0";
    try {
      expect((await view()).here).toEqual([]);
      expect((await add(mac, mine, "music")).status).toBe(200);
      expect(await watchedPaths()).not.toContain(mine);
    } finally {
      process.env.LIBRARY_WATCH_FOLDERS = "1";
    }
  });
});
