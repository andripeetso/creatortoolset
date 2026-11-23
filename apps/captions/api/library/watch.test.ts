import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";

// its real path: the watcher resolves links, and macOS hands out /var/folders under /private
const dir = realpathSync(mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "library-watch-")));
process.env.DATA_DIR = path.join(dir, "data");
process.env.LIBRARY_WATCH_FOLDERS = "1";
process.env.LIBRARY_DISK_RESERVE_GB = "0";
const { libraryDb } = await import("./db");
const { watchApp, scanWatchFolders, SETTLE_MS, QUICK_SETTLE_MS } = await import("./watch");

afterAll(() => {
  delete process.env.LIBRARY_WATCH_FOLDERS;
  delete process.env.LIBRARY_DISK_RESERVE_GB;
  rmSync(dir, { recursive: true, force: true });
});

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: c.req.header("x-user") ?? "", role: "member" } as never);
  return next();
});
app.route("/api/library", watchApp);

const put = (user: string, folders: unknown[]) =>
  app.request("/api/library/lib_w/watch", {
    method: "PUT",
    headers: { "x-user": user, "content-type": "application/json" },
    body: JSON.stringify({ folders }),
  });
const versions = () => libraryDb().prepare("SELECT id, state, source_path, source_key FROM asset_versions ORDER BY created_at").all() as {
  id: string;
  state: string;
  source_path: string | null;
  source_key: string;
}[];

const watched = path.join(dir, "Tiny Acrobatics footage");
const copied = path.join(dir, "Card dumps");

// the account's Source media rows on this computer: what the scan reads (settings.watch keeps Finals only)
const sourceRow = (id: string, p: string) => ({ id, role: "footage", name: path.basename(p), origin: { host: "this-computer", path: p }, make: true, createdAt: 0, reach: {} });

beforeAll(() => {
  mkdirSync(process.env.DATA_DIR!, { recursive: true });
  mkdirSync(path.join(watched, ".hidden"), { recursive: true });
  mkdirSync(copied, { recursive: true });
  mkdirSync(path.join(process.env.DATA_DIR!, "storage"), { recursive: true });
  writeFileSync(path.join(process.env.DATA_DIR!, "storage", "owner-w.json"), JSON.stringify({ schemaVersion: 3, folders: [sourceRow("w", watched), sourceRow("c", copied)] }));
  libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_w', 'owner-w', 'W', 'local', 0)").run();
});

describe("watch folder settings", () => {
  it("only the owner sets them, outsiders get 404, and a hosted server refuses", async () => {
    expect((await put("stranger", [{ path: watched }])).status).toBe(404);
    process.env.LIBRARY_WATCH_FOLDERS = "0";
    const hosted = await put("owner-w", [{ path: watched }]);
    process.env.LIBRARY_WATCH_FOLDERS = "1";
    expect(hosted.status).toBe(403);
    expect(((await hosted.json()) as { error: string }).error).toMatch(/not on your computer/);
  });

  it("refuses a missing folder, a relative path and the app's own data folder", async () => {
    expect((await put("owner-w", [{ path: path.join(dir, "nope") }])).status).toBe(400);
    expect((await put("owner-w", [{ path: "footage" }])).status).toBe(400);
    expect((await put("owner-w", [{ path: process.env.DATA_DIR }])).status).toBe(400);
    expect((await put("owner-w", [{ path: dir }])).status).toBe(400); // holds the data folder
  });

  it("lists the Source media rows of this computer, each read in place", async () => {
    const r = await app.request("/api/library/lib_w/watch", { headers: { "x-user": "owner-w" } });
    const s = (await r.json()) as { allowed: boolean; folders: { path: string; mode: string; found: boolean; addedBy: string }[] };
    expect(s.allowed).toBe(true);
    expect(s.folders.map((f) => [f.path, f.mode, f.found, f.addedBy])).toEqual([
      [watched, "reference", true, "owner-w"],
      [copied, "reference", true, "owner-w"],
    ]);
  });
});

describe("watch folder scan", () => {
  const t0 = 1_000_000_000_000;
  const clip = path.join(watched, "Handstand.mp4");

  it("imports a settled file once, by reference, as the owner", async () => {
    writeFileSync(clip, "frame data one");
    writeFileSync(path.join(watched, ".hidden", "skip.mp4"), "hidden");
    writeFileSync(path.join(watched, "notes.txt"), "not media");
    // links lead out of the folder the owner chose: a linked file or folder is never followed
    const outside = path.join(dir, "Elsewhere");
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "Private.mp4"), "not in the watched folder");
    symlinkSync(path.join(outside, "Private.mp4"), path.join(watched, "Linked.mp4"));
    symlinkSync(outside, path.join(watched, "Linked folder"));
    expect(await scanWatchFolders(t0)).toBe(0); // first sight: not settled yet
    expect(await scanWatchFolders(t0 + SETTLE_MS - 1)).toBe(0);
    expect(await scanWatchFolders(t0 + SETTLE_MS)).toBe(1);
    const [v] = versions();
    expect(v).toMatchObject({ state: "processing", source_path: clip });
    expect(lstatSync(path.join(process.env.DATA_DIR!, "library", "blobs", v!.source_key)).isSymbolicLink()).toBe(true);
    const a = libraryDb().prepare("SELECT title, created_by FROM assets").get();
    expect(a).toEqual({ title: "Handstand", created_by: "owner-w" });
    expect(libraryDb().prepare("SELECT kind, actor FROM jobs WHERE version_id = ?").get(v!.id)).toEqual({ kind: "probe", actor: "owner-w" });
  });

  it("imports nothing on a re-scan with the same size and mtime", async () => {
    expect(await scanWatchFolders(t0 + 10 * SETTLE_MS)).toBe(0);
    expect(await scanWatchFolders(t0 + 20 * SETTLE_MS)).toBe(0);
    expect(versions()).toHaveLength(1);
  });

  it("reads a file that is still growing in place, once it has settled", async () => {
    const big = path.join(copied, "Cartwheel.mov");
    const t1 = t0 + 100 * SETTLE_MS;
    writeFileSync(big, "part one");
    expect(await scanWatchFolders(t1)).toBe(0);
    appendFileSync(big, " part two");
    expect(await scanWatchFolders(t1 + SETTLE_MS + 10_000)).toBe(0); // it changed: the 60 s start again
    expect(await scanWatchFolders(t1 + 2 * SETTLE_MS)).toBe(0);
    expect(await scanWatchFolders(t1 + 2 * SETTLE_MS + 10_000)).toBe(1);
    const v = versions()[1]!;
    expect(v.source_path).toBe(big); // a Source media row is read in place: the file stays where it is
    expect(existsSync(big)).toBe(true);
  });

  it("marks a referenced file that disappears missing, deletes nothing, and brings it back", async () => {
    const t2 = t0 + 200 * SETTLE_MS;
    rmSync(clip);
    await scanWatchFolders(t2);
    const [v] = versions();
    expect(v!.state).toBe("missing");
    expect(libraryDb().prepare("SELECT COUNT(*) AS n FROM assets WHERE trashed_at IS NULL").get()).toEqual({ n: 2 });
    expect(libraryDb().prepare("SELECT COUNT(*) AS n FROM watch_seen WHERE path = ?").get(clip)).toEqual({ n: 1 });
    expect(lstatSync(path.join(process.env.DATA_DIR!, "library", "blobs", v!.source_key)).isSymbolicLink()).toBe(true);

    writeFileSync(clip, "frame data one"); // the drive is back
    libraryDb().prepare("UPDATE jobs SET state = 'failed' WHERE version_id = ?").run(v!.id); // the worker gave up meanwhile
    await scanWatchFolders(t2 + 1000);
    expect(versions()[0]!.state).toBe("processing");
    expect(libraryDb().prepare("SELECT state FROM jobs WHERE version_id = ?").get(v!.id)).toEqual({ state: "queued" });
  });

  it("leaves a trashed clip's gone file alone, out of the missing count, and checks it again once restored", async () => {
    const t = t0 + 250 * SETTLE_MS;
    const [v] = versions();
    const trash = (at: number | null) => libraryDb().prepare("UPDATE assets SET trashed_at = ? WHERE id = (SELECT asset_id FROM asset_versions WHERE id = ?)").run(at, v!.id);
    trash(t);
    rmSync(clip); // moved away after it went to the trash
    await scanWatchFolders(t);
    expect(versions()[0]!.state).not.toBe("missing");
    trash(null);
    await scanWatchFolders(t + 1000);
    expect(versions()[0]!.state).toBe("missing");
    const missing = async () => ((await (await app.request("/api/library/lib_w/watch", { headers: { "x-user": "owner-w" } })).json()) as { missing: number }).missing;
    expect(await missing()).toBe(1);
    trash(t + 1500); // gone first, trashed after: the status counts it no more
    expect(await missing()).toBe(0);
    trash(null);
    writeFileSync(clip, "frame data one");
    await scanWatchFolders(t + 2000);
  });

  it("does nothing on a server that may not watch", async () => {
    writeFileSync(path.join(watched, "Roll.mp4"), "another clip");
    process.env.LIBRARY_WATCH_FOLDERS = "0";
    const t3 = t0 + 300 * SETTLE_MS;
    expect(await scanWatchFolders(t3)).toBe(0);
    expect(await scanWatchFolders(t3 + SETTLE_MS)).toBe(0);
    process.env.LIBRARY_WATCH_FOLDERS = "1";
    expect(versions()).toHaveLength(2);
  });

  it("takes footage that was already in the folder after a short look, and says how many are still to come", async () => {
    const t4 = t0 + 400 * SETTLE_MS;
    // what the earlier tests left waiting comes in first
    await scanWatchFolders(t4 - 2 * SETTLE_MS);
    await scanWatchFolders(t4 - SETTLE_MS);
    const had = versions().length;
    const folder = async () => {
      const r = await app.request("/api/library/lib_w/watch", { headers: { "x-user": "owner-w" } });
      return ((await r.json()) as { folders: { mode: string; files: number; adding: number }[] }).folders.find((f) => f.mode === "reference")!;
    };
    expect(await folder()).toMatchObject({ files: 2, adding: 0 });

    // shot ten minutes before the folder is looked at: nobody is still writing it
    const old = path.join(watched, "Last summer.mp4");
    writeFileSync(old, "shot long ago");
    utimesSync(old, new Date(t4 - 10 * SETTLE_MS), new Date(t4 - 10 * SETTLE_MS));
    expect(await scanWatchFolders(t4)).toBe(0); // first sight: counted, not taken
    expect(await folder()).toMatchObject({ files: 3, adding: 1 });
    expect(await scanWatchFolders(t4 + QUICK_SETTLE_MS - 1)).toBe(0);
    expect(await scanWatchFolders(t4 + QUICK_SETTLE_MS)).toBe(1);
    expect(await folder()).toMatchObject({ files: 3, adding: 0 });
    expect(versions()).toHaveLength(had + 1);

    // an old file that is still growing (a copy that kept the original's date) waits like any other
    const copying = path.join(watched, "Still copying.mp4");
    const t5 = t4 + 10 * SETTLE_MS;
    writeFileSync(copying, "part one");
    utimesSync(copying, new Date(t4 - 10 * SETTLE_MS), new Date(t4 - 10 * SETTLE_MS));
    expect(await scanWatchFolders(t5)).toBe(0);
    appendFileSync(copying, " part two");
    utimesSync(copying, new Date(t4 - 10 * SETTLE_MS), new Date(t4 - 10 * SETTLE_MS));
    expect(await scanWatchFolders(t5 + QUICK_SETTLE_MS)).toBe(0); // it grew: the wait starts again
    expect(await scanWatchFolders(t5 + 2 * QUICK_SETTLE_MS)).toBe(1);
  });

  it("a referenced file moved inside the folder reconnects by its checksum: the clip reads it at its new path", async () => {
    const t6 = t0 + 600 * SETTLE_MS;
    const had = versions().length;
    const moved = path.join(watched, "2025", "Handstand.mp4");
    mkdirSync(path.dirname(moved), { recursive: true });
    renameSync(clip, moved);
    await scanWatchFolders(t6);
    expect(versions()[0]).toMatchObject({ state: "missing", source_path: clip });
    await scanWatchFolders(t6 + SETTLE_MS);
    const [v] = versions();
    expect(v).toMatchObject({ state: "processing", source_path: moved });
    expect(readlinkSync(path.join(process.env.DATA_DIR!, "library", "blobs", v!.source_key))).toBe(moved);
    expect(versions()).toHaveLength(had);
  });
});

describe("a folder chosen from the Media Library card", () => {
  const post = (user: string, body: unknown) =>
    app.request("/api/library/watch/folder", {
      method: "POST",
      headers: { "x-user": user, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const listed = async () => ((await (await app.request("/api/library/lib_w/watch", { headers: { "x-user": "owner-w" } })).json()) as { folders: { path: string }[] }).folders.map((f) => f.path);

  it("joins the account's watch list, read in place", async () => {
    const chosen = path.join(dir, "Picked footage");
    mkdirSync(chosen, { recursive: true });
    expect((await post("owner-w", { path: chosen })).status).toBe(200);
    expect(await listed()).toContain(chosen);
    expect((await post("owner-w", { path: chosen })).status).toBe(200); // already there counts as added
    expect((await listed()).filter((p) => p === chosen)).toHaveLength(1);
  });

  it("checks the folder: a missing or relative path is refused and nothing is added", async () => {
    const before = await listed();
    expect((await post("owner-w", { path: path.join(dir, "not there") })).status).toBe(400);
    expect((await post("owner-w", { path: "footage" })).status).toBe(400);
    expect((await post("owner-w", {})).status).toBe(400);
    const other = path.join(dir, "Other footage");
    mkdirSync(other, { recursive: true });
    expect((await post("owner-w", { path: other, libraryId: "lib_nope" })).status).toBe(400); // not a library of theirs
    expect(await listed()).toEqual(before);
  });
});

describe("the watch list is the account's Source media rows", () => {
  const newer = path.join(dir, "Newer footage");
  const put2 = (folders: unknown[]) => put("owner-w", folders);
  const rowsOnDisk = () => (JSON.parse(readFileSync(path.join(process.env.DATA_DIR!, "storage", "owner-w.json"), "utf-8")) as { folders: { origin: { path: string } }[] }).folders.map((f) => f.origin.path);

  it("a folder put on the list is a row, read by the next scan; one taken off is removed, and the scan stops", async () => {
    mkdirSync(newer, { recursive: true });
    writeFileSync(path.join(newer, "Flip.mp4"), "flip");
    expect((await put2([{ path: watched }, { path: copied }, { path: newer }])).status).toBe(200);
    expect(rowsOnDisk()).toContain(newer);
    expect(await scanWatchFolders(Date.now())).toBe(0);
    expect(await scanWatchFolders(Date.now() + SETTLE_MS)).toBe(1);
    expect(versions().some((v) => v.source_path === path.join(newer, "Flip.mp4"))).toBe(true);
    // taken off: the row goes, and nothing in it is scanned again
    expect((await put2([{ path: watched }, { path: copied }])).status).toBe(200);
    expect(rowsOnDisk()).not.toContain(newer);
    writeFileSync(path.join(newer, "Later.mp4"), "later");
    expect(await scanWatchFolders(Date.now() + 10 * SETTLE_MS)).toBe(0);
    expect(versions().some((v) => v.source_path === path.join(newer, "Later.mp4"))).toBe(false);
  });

  it("refuses a copy watch (copyTo, or mode copy): copying is for drops, and nothing is written", async () => {
    const before = rowsOnDisk();
    expect((await put2([{ path: watched }, { path: copied }, { path: newer, mode: "copy" }])).status).toBe(400);
    expect((await put2([{ path: watched }, { path: copied }, { path: newer, copyTo: dir }])).status).toBe(400);
    expect(rowsOnDisk()).toEqual(before);
  });

  it("a server that may not watch shows no folders", async () => {
    process.env.LIBRARY_WATCH_FOLDERS = "0";
    const s = (await (await app.request("/api/library/lib_w/watch", { headers: { "x-user": "owner-w" } })).json()) as { allowed: boolean; folders: unknown[] };
    process.env.LIBRARY_WATCH_FOLDERS = "1";
    expect(s).toMatchObject({ allowed: false, folders: [] });
  });
});

describe("a folder brought in for the AI (POST /api/library/import-folder)", () => {
  const importDir = path.join(dir, "Tiny Acrobatics import");
  const old = path.join(importDir, "Last year.mp4");
  const take = path.join(importDir, "Handstand take.mp4");
  const script = path.join(importDir, "script.txt");
  let since = 0;
  const importFolder = (user: string, body: unknown) =>
    app.request("/api/library/import-folder", {
      method: "POST",
      headers: { "x-user": user, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const read = async (r: Response) => (await r.json()) as { libraryId: string; imported: { file: string; versionId?: string; error?: string }[]; scripts: { file: string; text: string }[] };
  const assets = () => (libraryDb().prepare("SELECT COUNT(*) AS n FROM assets").get() as { n: number }).n;

  beforeAll(() => {
    mkdirSync(importDir, { recursive: true });
    writeFileSync(old, "last year's take");
    // an old file: its mtime is years back, and it arrived before `since`
    utimesSync(old, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
  });

  it("brings in the files that arrived since the date, returns the script's text, and remembers them as seen", async () => {
    await new Promise((r) => setTimeout(r, 100));
    // a file's times come from the system's coarse clock (Linux: one timer tick, up to 10 ms behind Date.now()), so the
    // take written right after `since` can carry a time just before it: `since` leaves that much room, still long after
    // the old file arrived
    since = Date.now() - 20;
    writeFileSync(take, "frame data take");
    writeFileSync(script, "Hook: the handstand, then the reveal");
    const r = await importFolder("owner-w", { path: importDir, since, libraryId: "lib_w" });
    expect(r.status).toBe(200);
    const body = await read(r);
    expect(body.libraryId).toBe("lib_w");
    expect(body.imported.map((x) => x.file)).toEqual([take]); // the old file is not taken
    expect(body.imported[0]!.error).toBeUndefined();
    expect(body.scripts).toEqual([{ file: script, text: "Hook: the handstand, then the reveal" }]);
    const made = versions().filter((v) => v.source_path === take);
    expect(made).toHaveLength(1);
    expect(made[0]!.state).toBe("processing");
    expect(body.imported[0]!.versionId).toBe(made[0]!.id);
    expect(versions().some((v) => v.source_path === old)).toBe(false);
    expect(libraryDb().prepare("SELECT version_id FROM watch_seen WHERE library_id = ? AND path = ?").get("lib_w", take)).toEqual({ version_id: made[0]!.id });
  });

  it("a second call takes nothing new: the same version, no second asset", async () => {
    const assetsBefore = assets();
    const versionsBefore = versions().length;
    const body = await read(await importFolder("owner-w", { path: importDir, since, libraryId: "lib_w" }));
    expect(body.imported.map((x) => x.file)).toEqual([take]);
    expect(body.imported[0]!.versionId).toBe(versions().find((v) => v.source_path === take)!.id);
    expect(versions()).toHaveLength(versionsBefore);
    expect(assets()).toBe(assetsBefore);
  });

  it("the watch scan does not take the same file again once the folder is watched", async () => {
    const added = await app.request("/api/library/watch/folder", {
      method: "POST",
      headers: { "x-user": "owner-w", "content-type": "application/json" },
      body: JSON.stringify({ path: importDir }),
    });
    expect(added.status).toBe(200);
    await scanWatchFolders(Date.now());
    await scanWatchFolders(Date.now() + SETTLE_MS);
    expect(versions().filter((v) => v.source_path === take)).toHaveLength(1);
    expect(libraryDb().prepare("SELECT COUNT(*) AS n FROM watch_seen WHERE library_id = ? AND path = ?").get("lib_w", take)).toEqual({ n: 1 });
  });

  it("the same bytes a Mac indexed (no whole-file hash, only its quick fingerprint) are that clip, never a second one", async () => {
    const v = versions().find((x) => x.source_path === take)!;
    const { quickPrint } = await import("../work/files"); // after DATA_DIR is set, like the test's other imports
    const quick = await quickPrint(take);
    libraryDb().prepare("UPDATE asset_versions SET sha256 = ?, quick = ? WHERE id = ?").run(`mac:${quick}`, quick, v.id);
    const again = path.join(importDir, "Handstand again.mp4");
    writeFileSync(again, "frame data take");
    try {
      const assetsBefore = assets();
      const body = await read(await importFolder("owner-w", { path: importDir, since, libraryId: "lib_w" }));
      expect(body.imported.find((x) => x.file === again)?.versionId).toBe(v.id);
      expect(assets()).toBe(assetsBefore);
    } finally {
      rmSync(again);
    }
  });

  it("refuses on a server that may not read folders, a relative path, and someone else's library", async () => {
    process.env.LIBRARY_WATCH_FOLDERS = "0";
    try {
      const hosted = await importFolder("owner-w", { path: importDir, libraryId: "lib_w" });
      expect(hosted.status).toBe(403);
      expect(((await hosted.json()) as { error: string }).error).toMatch(/not on your computer/);
    } finally {
      process.env.LIBRARY_WATCH_FOLDERS = "1";
    }
    expect((await importFolder("owner-w", { path: "footage", libraryId: "lib_w" })).status).toBe(400);
    expect((await importFolder("stranger", { path: importDir, libraryId: "lib_w" })).status).toBe(404);
  });

  it("never brings back a file the user trashed, and refuses a whole home folder", async () => {
    const v = versions().find((x) => x.source_path === take)!;
    libraryDb().prepare("UPDATE assets SET trashed_at = ? WHERE id = (SELECT asset_id FROM asset_versions WHERE id = ?)").run(Date.now(), v.id);
    const assetsBefore = assets();
    const body = await read(await importFolder("owner-w", { path: importDir, since, libraryId: "lib_w" }));
    expect(body.imported).toEqual([{ file: take, error: expect.stringMatching(/trash/) }]);
    expect(assets()).toBe(assetsBefore);
    expect((await importFolder("owner-w", { path: "~", libraryId: "lib_w" })).status).toBe(400);
  });
});
