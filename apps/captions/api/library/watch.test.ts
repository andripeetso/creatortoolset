import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "library-watch-"));
process.env.DATA_DIR = path.join(dir, "data");
process.env.LIBRARY_WATCH_FOLDERS = "1";
process.env.LIBRARY_DISK_RESERVE_GB = "0";
const { libraryDb } = await import("./db");
const { watchApp, scanWatchFolders, SETTLE_MS } = await import("./watch");

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

beforeAll(() => {
  mkdirSync(process.env.DATA_DIR!, { recursive: true });
  mkdirSync(path.join(watched, ".hidden"), { recursive: true });
  mkdirSync(copied, { recursive: true });
  writeFileSync(
    path.join(process.env.DATA_DIR!, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        { id: "ws_w", name: "w", plan: "team", comped: false, createdAt: 0, members: [
          { username: "owner-w", role: "owner", ai: "own", budgetUsd: 0, joinedAt: 0 },
          { username: "mem-w", role: "member", ai: "own", budgetUsd: 0, joinedAt: 0 },
        ] },
      ],
      invites: [],
      spend: {},
    }),
  );
  libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_w', 'ws_w', 'W', 'local', 0)").run();
});

describe("watch folder settings", () => {
  it("only the owner sets them, outsiders get 404, and a hosted server refuses", async () => {
    expect((await put("mem-w", [{ path: watched }])).status).toBe(403);
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

  it("stores the folders", async () => {
    const r = await put("owner-w", [{ path: watched, mode: "reference" }, { path: copied, mode: "copy" }]);
    expect(r.status).toBe(200);
    const s = (await r.json()) as { allowed: boolean; folders: { mode: string; found: boolean; addedBy: string }[] };
    expect(s.allowed).toBe(true);
    expect(s.folders.map((f) => [f.mode, f.found, f.addedBy])).toEqual([
      ["reference", true, "owner-w"],
      ["copy", true, "owner-w"],
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

  it("waits while a file is still growing, then copies it in", async () => {
    const big = path.join(copied, "Cartwheel.mov");
    const t1 = t0 + 100 * SETTLE_MS;
    writeFileSync(big, "part one");
    expect(await scanWatchFolders(t1)).toBe(0);
    appendFileSync(big, " part two");
    expect(await scanWatchFolders(t1 + SETTLE_MS + 10_000)).toBe(0); // it changed: the 60 s start again
    expect(await scanWatchFolders(t1 + 2 * SETTLE_MS)).toBe(0);
    expect(await scanWatchFolders(t1 + 2 * SETTLE_MS + 10_000)).toBe(1);
    const v = versions()[1]!;
    expect(v.source_path).toBeNull();
    expect(lstatSync(path.join(process.env.DATA_DIR!, "library", "blobs", v.source_key)).isFile()).toBe(true);
    expect(existsSync(big)).toBe(true); // copy mode leaves the original alone
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

  it("does nothing on a server that may not watch", async () => {
    writeFileSync(path.join(watched, "Roll.mp4"), "another clip");
    process.env.LIBRARY_WATCH_FOLDERS = "0";
    const t3 = t0 + 300 * SETTLE_MS;
    expect(await scanWatchFolders(t3)).toBe(0);
    expect(await scanWatchFolders(t3 + SETTLE_MS)).toBe(0);
    process.env.LIBRARY_WATCH_FOLDERS = "1";
    expect(versions()).toHaveLength(2);
  });
});
