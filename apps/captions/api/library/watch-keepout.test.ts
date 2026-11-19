import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Amendment b: a Projects or Exports folder is never indexed by the watcher, even nested inside a watched Media folder
const dir = realpathSync(mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "watch-keepout-")));
process.env.DATA_DIR = path.join(dir, "data");
process.env.LIBRARY_WATCH_FOLDERS = "1";
const { libraryDb } = await import("./db");
const { filesIn, keepOutOf, scanWatchFolders, SETTLE_MS } = await import("./watch");

afterAll(() => {
  delete process.env.LIBRARY_WATCH_FOLDERS;
  rmSync(dir, { recursive: true, force: true });
});

const USER = "tiny";
const media = path.join(dir, "Shoots");
const projects = path.join(media, "Projects");
const exports = path.join(media, "Exports");

describe("the watcher keeps Projects and Exports folders out (Amendment b)", () => {
  mkdirSync(path.join(projects, "Tiny Edit"), { recursive: true });
  mkdirSync(exports, { recursive: true });
  mkdirSync(path.join(media, "Day 1"), { recursive: true });
  writeFileSync(path.join(media, "Day 1", "a.mp4"), "x");
  writeFileSync(path.join(projects, "Tiny Edit", "draft.mp4"), "x");
  writeFileSync(path.join(exports, "final.mp4"), "x");
  mkdirSync(path.join(dir, "data", "storage"), { recursive: true });
  const row = (id: string, role: string, p: string) => ({ id, role, name: path.basename(p), origin: { host: "this-computer", path: p }, make: true, createdAt: 0, reach: {} });
  writeFileSync(
    path.join(dir, "data", "storage", `${USER}.json`),
    JSON.stringify({ schemaVersion: 3, folders: [row("m", "footage", media), row("p", "projects", projects), row("x", "library", exports)] }),
  );

  it("lists the Projects and Exports folders of this computer as keep-out", async () => {
    expect((await keepOutOf(USER)).sort()).toEqual([exports, projects].sort());
  });

  it("a Projects folder nested inside a Media folder is not footage, and neither is an Exports folder", async () => {
    const files = await filesIn(media, await keepOutOf(USER));
    expect(files).toEqual([path.join(media, "Day 1", "a.mp4")]);
  });

  it("a Finals folder is read with no keep-out (scanFolders passes none for it): its project folders are the files", async () => {
    expect(await filesIn(exports)).toEqual([path.join(exports, "final.mp4")]);
  });

  it("a Source media folder that is itself a Projects or Exports folder is kept out too", async () => {
    expect(await filesIn(exports, [exports])).toEqual([]);
  });

  it("with no list, the same folder reads everything (the keep-out is the only thing that drops them)", async () => {
    expect((await filesIn(media)).length).toBeGreaterThan(1);
  });
});

describe("the server's own scan of Source media never takes a nested Projects or Exports folder", () => {
  it("imports the footage of the Source media row only, nothing of the Exports folder nested in it", async () => {
    libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_k', ?, 'K', 'local', 0)").run(USER);
    const t0 = 1_000_000_000_000;
    expect(await scanWatchFolders(t0)).toBe(0);
    expect(await scanWatchFolders(t0 + SETTLE_MS)).toBe(1);
    const taken = libraryDb().prepare("SELECT source_path FROM asset_versions").all() as { source_path: string }[];
    expect(taken.map((v) => v.source_path)).toEqual([path.join(media, "Day 1", "a.mp4")]);
  });
});
