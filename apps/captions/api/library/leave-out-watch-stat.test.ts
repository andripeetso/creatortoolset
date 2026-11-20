import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";

// The watch's moved-in look reads each left-out file's size and time once: a clip's file deleted long ago keeps that look
// on, and a later pass never reads the left-out files again.
const stats = vi.hoisted(() => [] as string[]);
vi.mock("node:fs/promises", async (orig) => {
  const m = await orig<typeof import("node:fs/promises")>();
  return { ...m, stat: (p: Parameters<typeof m.stat>[0], ...rest: unknown[]) => (stats.push(String(p)), (m.stat as (...a: unknown[]) => unknown)(p, ...rest)) };
});

const dir = realpathSync(mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "leave-out-stat-")));
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
const put = (rel: string, body: string) => {
  mkdirSync(path.dirname(path.join(footage, rel)), { recursive: true });
  writeFileSync(path.join(footage, rel), body);
};
let t = 1_000_000_000_000;

it("a second pass never reads the left-out files again", async () => {
  put("a.mp4", "a");
  put("Private/p1.mp4", "p1");
  put("Private/p2.mp4", "p2");
  mkdirSync(path.join(dir, "data", "storage"), { recursive: true });
  writeFileSync(
    path.join(dir, "data", "storage", `${USER}.json`),
    JSON.stringify({ schemaVersion: 3, folders: [{ id: "f", role: "footage", name: "Footage", origin: { host: "this-computer", path: footage }, make: true, createdAt: 0, reach: {}, leaveOut: ["Private"] }] }),
  );
  libraryDb().prepare("INSERT OR IGNORE INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_s', ?, 'S', 'local', 0)").run(USER);
  await scanWatchFolders((t += 10 * SETTLE_MS));
  await scanWatchFolders((t += 10 * SETTLE_MS));
  rmSync(path.join(footage, "a.mp4")); // gone for good: the moved-in look stays on
  const leftOut = () => stats.filter((p) => p.includes(`${path.sep}Private${path.sep}`)).length;
  await scanWatchFolders((t += 10 * SETTLE_MS));
  const first = leftOut();
  expect(first).toBe(2);
  await scanWatchFolders((t += 10 * SETTLE_MS));
  await scanWatchFolders((t += 10 * SETTLE_MS));
  expect(leftOut()).toBe(first);
});

it("a file moved into a left-out folder over one read before is read again: its clip leaves", async () => {
  const { utimesSync, renameSync } = await import("node:fs");
  put("C0001.mp4", "c1");
  utimesSync(path.join(footage, "C0001.mp4"), 1_700_000_000, 1_700_000_000);
  put("Private/C0001.mp4", "older one");
  await scanWatchFolders((t += 10 * SETTLE_MS));
  await scanWatchFolders((t += 10 * SETTLE_MS));
  const id = (libraryDb().prepare("SELECT asset_id FROM asset_versions WHERE source_path = ?").get(path.join(footage, "C0001.mp4")) as { asset_id: string }).asset_id;
  renameSync(path.join(footage, "C0001.mp4"), path.join(footage, "Private", "C0001.mp4"));
  await scanWatchFolders((t += 10 * SETTLE_MS));
  expect((libraryDb().prepare("SELECT trashed_at FROM assets WHERE id = ?").get(id) as { trashed_at: number | null }).trashed_at).not.toBeNull();
});
