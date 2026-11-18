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
const { inRequestWorkspace } = await import("./lib/workspace-scope");

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
app.use(inRequestWorkspace);
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
    expect(((await r.json()) as { error: string }).error).toMatch(/Folder not found on the server/);
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
    // a folder inside it (an old MUSIC folder) is in it already: refused by name, not added nor watched
    const songs = path.join(footage, "MUSIC");
    mkdirSync(songs, { recursive: true });
    const inner = await addSetupFolder(songs, "music");
    expect(inner.status).toBe(400);
    expect(((await inner.json()) as { error?: string }).error).toBe(`That folder is already in ${path.basename(footage)}`);
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
const { deviceOf, pairDevice, saveReport } = await import("./lib/devices");
const { applyReport, indexForDevice, parseReportFolders } = await import("./library/report");
const { whereIs } = await import("./library/whereis");
const { updateFolder } = await import("./devices-storage");
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

  it("a Finals folder takes the place of the one before and is not read as footage", async () => {
    const finals = (await view()).folders.filter((f) => (f as { role?: string }).role === "finals");
    expect(finals).toEqual([]);
    expect((await add(mac, path.join(dir, "Finals A"), "finals")).status).toBe(200);
    expect((await add(mac, path.join(dir, "Finals B"), "finals")).status).toBe(200);
    expect((await view()).folders.filter((f) => (f as { role?: string }).role === "finals").map((f) => f.origin.path)).toEqual([path.join(dir, "Finals B")]);
    expect(await watchedPaths()).not.toContain(path.join(dir, "Finals B"));
  });

  it("a folder that is not there is refused with the reason, as in setup", async () => {
    const r = await add(mac, path.join(dir, "no-such-folder"));
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/Folder not found on the server/);
  });

  // T2: a folder on another computer is read by that computer's location agent; the server never opens its path. The
  // same report contract for a Mac and a Linux helper (contracts/places.ts ReportV2)
  it.each([
    ["a Mac", "Tiny MacBook", "tiny-macbook.local", "0.17.5"],
    ["a helper", "Tiny NAS Helper", "tiny-nas", undefined],
  ] as const)("another computer's folder (%s) lands in whereIs from its agent's report; the server never reads it", async (_kind, name, host, version) => {
    const dev = pairDevice(USER, name, version).device.id;
    saveReport(dev, machine(host));
    // the same path exists on this server, with a file of its own: never read, never indexed
    const theirs = path.join(dir, `On ${name}`);
    mkdirSync(theirs, { recursive: true });
    writeFileSync(path.join(theirs, "only-on-the-server.mp4"), Buffer.alloc(1024, 5));
    expect((await add(dev, theirs)).status).toBe(200);
    expect(await watchedPaths()).not.toContain(theirs);
    const folder = (await view()).folders.find((f) => f.origin.host === dev && f.origin.path === theirs)!;
    // the agent lists a file this server does not have
    const file = { path: path.join(theirs, "on-their-disk.mp4"), bytes: 4096, mtime: 1_700_000_000_000, quick: (version ? "c" : "d").repeat(64) };
    const agent = deviceOf(dev)!;
    const answer = await applyReport(agent, parseReportFolders([{ id: folder.id, state: "ok", scan: "t2", complete: true, files: [file] }]));
    expect(answer.index).toEqual([{ folder: folder.id, path: file.path }]);
    const ix = await indexForDevice(agent, folder.id, { name: "on-their-disk.mp4", path: file.path, size: file.bytes, quick: file.quick, frames: [] });
    const versionId = (ix as { versions: { versionId?: string }[] }).versions[0]!.versionId!;
    expect(whereIs(versionId)!.computers).toEqual([
      expect.objectContaining({ device: dev, name, original: expect.objectContaining({ state: "verified", path: file.path, folder: folder.id }) }),
    ]);
    // a scan here reads only what this server watches: the server's own file in that path never comes in
    await scanWatchFolders(Date.now() + 10 * SETTLE_MS);
    expect(libraryDb().prepare("SELECT count(*) AS n FROM asset_versions WHERE source_path LIKE ?").get(`${theirs}%`)).toEqual({ n: 0 });
  });

  it("re-points a folder on its computer: the new path, its state cleared, its place rows not checked yet", async () => {
    const dev = pairDevice(USER, "Tiny Repoint Mac").device.id;
    const was = "/Volumes/Tiny Drive/Old name";
    expect((await add(dev, was)).status).toBe(200);
    const f = (await view()).folders.find((x) => x.origin.path === was)!;
    await updateFolder(USER, f.id, (x) => ({ ...x, folderState: "not_found", checkedAt: 1 }));
    libraryDb().prepare("INSERT INTO version_places (version_id, device, folder_id, path, state) VALUES ('v-repoint', ?, ?, ?, 'gone')").run(dev, f.id, `${was}/a.mp4`);
    const repoint = (id: string, p: unknown) => app.request(`/api/devices/storage/folders/${id}/re-point`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: p }) });
    const r = await repoint(f.id, "/Volumes/Tiny Drive/New name/");
    expect(r.status).toBe(200);
    const now = ((await r.json()) as { folders: { id: string; name: string; origin: { host: string; path: string }; folderState?: string; checkedAt?: number }[] }).folders.find((x) => x.id === f.id)!;
    expect(now).toMatchObject({ name: "New name", origin: { host: dev, path: "/Volumes/Tiny Drive/New name" } });
    expect(now.folderState).toBeUndefined();
    expect(now.checkedAt).toBeUndefined();
    expect(libraryDb().prepare("SELECT state FROM version_places WHERE version_id = 'v-repoint'").get()).toEqual({ state: "unchecked" });
    expect((await repoint(f.id, "relative/path")).status).toBe(400);
    expect((await repoint("no-such-folder", "/Volumes/Tiny Drive/X")).status).toBe(404);
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

describe("each workspace", () => {
  it("has its own folders: one added in a workspace is not in another's list nor in its chats' line; older ones are the first brand's", async () => {
    const projects = path.join(process.env.DATA_DIR!, "workshop", "projects");
    mkdirSync(projects, { recursive: true });
    for (const [id, at] of [["ws-a", 1], ["ws-b", 2]] as const) writeFileSync(path.join(projects, `${id}.json`), JSON.stringify({ id, owner: USER, name: id, createdAt: at, updatedAt: at }));
    const { foldersNote } = await import("./assistant");
    type View = { folders: { id: string; role: string; workspace?: string; workspaces?: string[]; origin: { path: string } }[] };
    const list = async (ws: string) => ((await (await app.request("/api/devices/storage", { headers: { "x-ct-workspace": ws } })).json()) as View).folders;
    const before = await list("ws-a");
    expect(before.length).toBeGreaterThan(0); // the folders added above, before there were workspaces: the first brand's
    expect(await list("ws-b")).toEqual([]);
    expect(await foldersNote(USER, "ws-b")).toBe("");
    const music = path.join(dir, "Songs");
    mkdirSync(music, { recursive: true });
    const added = await app.request("/api/devices/storage/folders", {
      method: "POST",
      headers: { "content-type": "application/json", "x-ct-workspace": "ws-b" },
      body: JSON.stringify({ role: "music", host: "this-computer", path: music }),
    });
    expect(added.status).toBe(200); // "music" from an older app: added as footage, the Media Library sorts the songs
    expect(((await added.json()) as View).folders.map((f) => f.origin.path)).toEqual([music]);
    expect((await list("ws-a")).map((f) => f.id)).toEqual(before.map((f) => f.id));
    expect(await foldersNote(USER, "ws-b")).toBe(`\n\nThis workspace's folders:\n- Footage: ${music} (on Tiny Studio Mac)`); // schema 2: "this computer" is the paired computer this server runs on
    expect(await foldersNote(USER, "ws-a")).not.toContain(music);
    // Settings shows every workspace: each folder says which one it is in (an older one the first brand's)
    const id = (await list("ws-b"))[0]!.id;
    const all = async () => ((await (await app.request("/api/devices/storage?all=1", { headers: { "x-ct-workspace": "ws-a" } })).json()) as View).folders;
    expect((await all()).find((f) => f.id === id)!.workspace).toBe("ws-b");
    expect((await all()).filter((f) => f.id !== id).every((f) => f.workspace === "ws-a")).toBe(true);
    // the Library of each workspace that lists a folder on this computer reads it (the one from before is the first brand's)
    const watchedIn = (ws: string) =>
      (libraryDb().prepare("SELECT json_extract(settings, '$.projectId') AS ws, json_extract(settings, '$.watch') AS w FROM libraries WHERE workspace_id = ?").all(USER) as { ws: string | null; w: string | null }[])
        .filter((r) => (r.ws ?? "ws-a") === ws)
        .flatMap((r) => (JSON.parse(r.w ?? "[]") as { path: string }[]).map((f) => f.path));
    expect(watchedIn("ws-b")).toEqual([music]);
    expect(watchedIn("ws-a")).not.toContain(music);
    // a folder is moved and forgotten by its id, whatever workspace the window is in
    const move = (workspace: string | null) =>
      app.request(`/api/devices/storage/folders/${id}`, { method: "PATCH", headers: { "content-type": "application/json", "x-ct-workspace": "ws-a" }, body: JSON.stringify({ workspace }) });
    expect((await move("no-such-workspace")).status).toBe(400);
    expect((await move("ws-a")).status).toBe(200);
    expect(await list("ws-b")).toEqual([]);
    expect(await foldersNote(USER, "ws-b")).toBe("");
    expect(await foldersNote(USER, "ws-a")).toContain(`- Footage: ${music}`);
    expect(watchedIn("ws-a")).toContain(music);
    expect(watchedIn("ws-b")).toEqual([]);
    // every workspace: in each one's list, its chats' line and its Library's watch list
    expect((await move(null)).status).toBe(200);
    expect((await all()).find((f) => f.id === id)!.workspace).toBe("*");
    expect((await list("ws-b")).map((f) => f.id)).toEqual([id]);
    expect((await list("ws-a")).map((f) => f.id)).toContain(id);
    expect(await foldersNote(USER, "ws-b")).toBe(`\n\nThis workspace's folders:\n- Footage: ${music} (on Tiny Studio Mac)`); // schema 2: the setup folder is now on the computer this server runs on
    expect(await foldersNote(USER, "ws-a")).toContain(`- Footage: ${music}`);
    expect(watchedIn("ws-a")).toContain(music);
    expect(watchedIn("ws-b")).toEqual([music]);
    // it is in every workspace already: the same folder is not added to one again
    const again = await app.request("/api/devices/storage/folders", { method: "POST", headers: { "content-type": "application/json", "x-ct-workspace": "ws-b" }, body: JSON.stringify({ role: "music", host: "this-computer", path: music }) });
    expect(again.status).toBe(400);
    // some workspaces, by name: in each one's list and Library, and a workspace deleted only leaves it
    const pick = (workspaces: string[] | null) =>
      app.request(`/api/devices/storage/folders/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaces }) });
    expect((await pick([])).status).toBe(400);
    expect((await pick(["ws-a", "no-such-workspace"])).status).toBe(400);
    expect((await pick(["ws-a", "ws-b"])).status).toBe(200);
    expect((await all()).find((f) => f.id === id)).toMatchObject({ workspace: "ws-a", workspaces: ["ws-a", "ws-b"] });
    expect((await list("ws-b")).map((f) => f.id)).toEqual([id]);
    expect((await list("ws-a")).map((f) => f.id)).toContain(id);
    expect(watchedIn("ws-a")).toContain(music);
    expect(watchedIn("ws-b")).toEqual([music]);
    const { workspaceStorageFolders } = await import("./devices-storage");
    const gone = await workspaceStorageFolders(USER, (ws) => ws === "ws-b");
    expect(gone.n).toBe(0);
    await gone.drop();
    const left = (await all()).find((f) => f.id === id)!;
    expect([left.workspace, left.workspaces]).toEqual(["ws-a", undefined]);
    // back to one workspace: the other's Library stops reading it
    expect((await move("ws-b")).status).toBe(200);
    expect((await all()).find((f) => f.id === id)!.workspaces).toBeUndefined();
    expect(watchedIn("ws-a")).not.toContain(music);
    expect(watchedIn("ws-b")).toEqual([music]);
    // Finished videos stays one folder per workspace
    const made = await app.request("/api/devices/storage/library", { method: "POST", headers: { "content-type": "application/json", "x-ct-workspace": "ws-b" }, body: JSON.stringify({ host: "this-computer", disk: dir }) });
    expect(made.status).toBe(200);
    const library = (await all()).find((f) => f.role === "library")!;
    expect(library.workspace).toBe("ws-b");
    expect((await app.request(`/api/devices/storage/folders/${library.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace: "ws-b" }) })).status).toBe(400);
    expect((await app.request(`/api/devices/storage/folders/${id}`, { method: "DELETE", headers: { "x-ct-workspace": "ws-a" } })).status).toBe(200);
    expect(watchedIn("ws-b")).toEqual([]);
    expect((await all()).some((f) => f.id === id)).toBe(false);
  });
});
