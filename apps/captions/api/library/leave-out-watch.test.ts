import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";

// This server's own watch of a Media folder on its computer applies the folder's Folders left out like a computer's scan:
// new files there are never taken, clips taken from there before go to the trash unless a copy is still read, and an
// import of a folder inside one takes nothing.
const dir = realpathSync(mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "leave-out-watch-")));
process.env.DATA_DIR = path.join(dir, "data");
process.env.LIBRARY_WATCH_FOLDERS = "1";
const { libraryDb } = await import("./db");
const { scanWatchFolders, SETTLE_MS, watchApp } = await import("./watch");

afterAll(() => {
  delete process.env.LIBRARY_WATCH_FOLDERS;
  rmSync(dir, { recursive: true, force: true });
});

const USER = "tiny";
const media = path.join(dir, "Shoots");
const put = (rel: string, body: string) => {
  mkdirSync(path.dirname(path.join(media, rel)), { recursive: true });
  writeFileSync(path.join(media, rel), body);
};
const storage = (leaveOut?: string[]) => {
  mkdirSync(path.join(dir, "data", "storage"), { recursive: true });
  const row = { id: "m", role: "footage", name: "Shoots", origin: { host: "this-computer", path: media }, make: true, createdAt: 0, reach: {}, ...(leaveOut ? { leaveOut } : {}) };
  writeFileSync(path.join(dir, "data", "storage", `${USER}.json`), JSON.stringify({ schemaVersion: 3, folders: [row] }));
};
const clips = () =>
  (libraryDb().prepare("SELECT v.source_path AS p, a.trashed_at AS t FROM asset_versions v JOIN assets a ON a.id = v.asset_id ORDER BY p").all() as { p: string; t: number | null }[]).map(
    (r) => [path.relative(media, r.p), r.t !== null] as const,
  );
let t = 1_000_000_000_000;
const scan = async () => {
  await scanWatchFolders((t += 10 * SETTLE_MS));
  await scanWatchFolders((t += 10 * SETTLE_MS));
};

describe("this server's watch and a Media folder's Folders left out", () => {
  put("Day 1/a.mp4", "a");
  put("Day 1/- NO SHARE/b.mp4", "b");
  put("- NO SHARE/c.mp4", "c");
  storage();
  libraryDb().prepare("INSERT OR IGNORE INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_w', ?, 'W', 'local', 0)").run(USER);

  it("with no list every file is taken", async () => {
    await scan();
    expect(clips()).toEqual([
      ["- NO SHARE/c.mp4", false],
      ["Day 1/- NO SHARE/b.mp4", false],
      ["Day 1/a.mp4", false],
    ]);
  });

  it("set (in any case), the clips taken from there go to the trash, except one whose copy is still read elsewhere", async () => {
    put("Keep/c.mp4", "c"); // the same bytes outside: the same clip
    await scan();
    storage(["- no share"]);
    put("Day 2/- NO SHARE/d.mp4", "d");
    await scan();
    expect(clips()).toEqual([
      ["- NO SHARE/c.mp4", false],
      ["Day 1/- NO SHARE/b.mp4", true],
      ["Day 1/a.mp4", false],
    ]);
  });

  it("an import of a folder inside a left-out folder takes nothing", async () => {
    put("Day 3/- NO SHARE/e.mp4", "e");
    const app = new Hono<{ Variables: AuthVars }>();
    app.use(async (c, next) => {
      c.set("user", { username: USER, role: "admin" } as never);
      return next();
    });
    app.route("/api/library", watchApp);
    const r = await app.request("/api/library/import-folder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: path.join(media, "Day 3"), libraryId: "lib_w" }),
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { imported: unknown[] }).imported).toEqual([]);
    expect(clips().some(([p]) => p.includes("e.mp4"))).toBe(false);
  });
});
