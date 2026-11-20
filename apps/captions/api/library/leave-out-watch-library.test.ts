import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// This server's watch applies Folders left out over the whole library: a copy read in another of its Media folders keeps
// a clip, a file moved from one Media folder into another's left-out folder takes its clip out, and a version only ever
// reads its own copy.
const dir = realpathSync(mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "leave-out-watch-lib-")));
process.env.DATA_DIR = path.join(dir, "data");
process.env.LIBRARY_WATCH_FOLDERS = "1";
const { libraryDb } = await import("./db");
const { scanWatchFolders, SETTLE_MS } = await import("./watch");

afterAll(() => {
  delete process.env.LIBRARY_WATCH_FOLDERS;
  rmSync(dir, { recursive: true, force: true });
});

const USER = "tiny";
const footage = path.join(dir, "Footage");
const archive = path.join(dir, "Archive");
const put = (file: string, body: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
};
const storage = (archiveOut?: string[], footageOut?: string[], archiveReach: Record<string, { path: string; at: number }> = {}) => {
  mkdirSync(path.join(dir, "data", "storage"), { recursive: true });
  const row = (id: string, p: string, leaveOut?: string[]) => ({ id, role: "footage", name: path.basename(p), origin: { host: "this-computer", path: p }, make: true, createdAt: 0, reach: {}, ...(leaveOut ? { leaveOut } : {}) });
  writeFileSync(
    path.join(dir, "data", "storage", `${USER}.json`),
    JSON.stringify({ schemaVersion: 3, folders: [row("f", footage, footageOut), { ...row("a", archive, archiveOut), reach: archiveReach }] }),
  );
};
const d = libraryDb();
const clip = (file: string) =>
  d.prepare("SELECT a.id, a.trashed_at, v.source_path FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.source_path = ?").get(file) as { id: string; trashed_at: number | null; source_path: string } | undefined;
let t = 1_000_000_000_000;
const scan = async () => {
  await scanWatchFolders((t += 10 * SETTLE_MS));
  await scanWatchFolders((t += 10 * SETTLE_MS));
};

describe("Folders left out over every watched folder of a library", () => {
  put(path.join(footage, "x.mp4"), "x");
  put(path.join(footage, "q.mp4"), "q");
  put(path.join(footage, "y.mp4"), "y");
  storage();
  d.prepare("INSERT OR IGNORE INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_l', ?, 'L', 'local', 0)").run(USER);

  it("a copy read in another Media folder keeps the clip, pass after pass", async () => {
    await scan();
    put(path.join(archive, "Private", "x.mp4"), "x");
    await scan();
    const x = clip(path.join(footage, "x.mp4"))!;
    expect(x.trashed_at).toBeNull();
    storage(["Private"]);
    await scan();
    await scan();
    expect(clip(path.join(footage, "x.mp4"))!.trashed_at).toBeNull();
  });

  it("a folder that can't be read for a pass keeps its clips: away is unknown, never gone", async () => {
    renameSync(footage, `${footage} away`);
    try {
      await scan();
      expect(clip(path.join(footage, "x.mp4"))!.trashed_at).toBeNull();
    } finally {
      renameSync(`${footage} away`, footage);
    }
    await scan();
    expect(clip(path.join(footage, "x.mp4"))!.trashed_at).toBeNull();
  });

  it("a version left out reads only its own copy: never another version's file", async () => {
    const q = clip(path.join(footage, "q.mp4"))!;
    const p = path.join(archive, "Private", "p.mp4");
    put(p, "p2");
    const s = statSync(p);
    d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, source_path, bytes, sha256, state, created_by, created_at) VALUES ('v2', ?, 2, 'libraries/lib_l/v/v2/source', ?, ?, 'h2', 'ready', ?, 0)").run(q.id, p, s.size, USER);
    d.prepare("INSERT INTO watch_seen (library_id, path, size, mtime, version_id) VALUES ('lib_l', ?, ?, ?, 'v2')").run(p, s.size, Math.floor(s.mtimeMs));
    await scan();
    expect(d.prepare("SELECT source_path FROM asset_versions WHERE id = 'v2'").get()).toEqual({ source_path: p });
    expect(clip(path.join(footage, "q.mp4"))!.trashed_at).toBeNull();
  });

  it("a file moved from one Media folder into another's left-out folder takes its clip out", async () => {
    expect(clip(path.join(footage, "y.mp4"))!.trashed_at).toBeNull();
    renameSync(path.join(footage, "y.mp4"), path.join(archive, "Private", "y.mp4"));
    await scan();
    expect(clip(path.join(footage, "y.mp4"))!.trashed_at).not.toBeNull();
  });

  it("the library's own copy in a watched folder is no copy that keeps a left-out clip", async () => {
    put(path.join(footage, "Private", "c.mp4"), "c");
    put(path.join(footage, "Copies", "L", "c.mp4"), "c");
    await scan();
    const v = (d.prepare("SELECT version_id FROM watch_seen WHERE path = ?").get(path.join(footage, "Copies", "L", "c.mp4")) as { version_id: string }).version_id;
    d.prepare("INSERT INTO library_copies (id, library_id, device, path, state, created_at) VALUES ('copy_l', 'lib_l', 'this-computer', ?, 'ok', 0)").run(path.join(footage, "Copies"));
    d.prepare("INSERT INTO copy_files (copy_id, version_id, rel_path, size, copied_at) VALUES ('copy_l', ?, 'L/c.mp4', 1, 0)").run(v);
    storage(["Private"], ["Private"]);
    await scan();
    expect(d.prepare("SELECT a.trashed_at IS NOT NULL AS trashed FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(v)).toEqual({ trashed: 1 });
  });

  it("another computer's path to a folder never leaves out a file here", async () => {
    // on pc_2 Archive is found a level up, where "Archive" is a folder inside it: only this computer's path weighs here
    storage(["Private", "Archive"], ["Private"], { pc_2: { path: dir, at: 0 } });
    put(path.join(archive, "w.mp4"), "w");
    await scan();
    expect(clip(path.join(archive, "w.mp4"))?.trashed_at).toBeNull();
  });
});
