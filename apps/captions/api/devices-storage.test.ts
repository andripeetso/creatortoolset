import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
