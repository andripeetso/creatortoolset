import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";

// What this server's watch hides while a Media folder can't be read: shown while a copy is known on a computer (never
// hidden and shown again pass after pass), and shown again once no list is left, though the folder is still away.
const dir = realpathSync(mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "leave-out-unread-")));
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
const storage = (leaveOut?: string[]) => {
  mkdirSync(path.join(dir, "data", "storage"), { recursive: true });
  writeFileSync(
    path.join(dir, "data", "storage", `${USER}.json`),
    JSON.stringify({ schemaVersion: 3, folders: [{ id: "f", role: "footage", name: "Footage", origin: { host: "this-computer", path: footage }, make: true, createdAt: 0, reach: {}, ...(leaveOut ? { leaveOut } : {}) }] }),
  );
};
const d = libraryDb();
let t = 1_000_000_000_000;
const scan = async () => {
  await scanWatchFolders((t += 10 * SETTLE_MS));
  await scanWatchFolders((t += 10 * SETTLE_MS));
};
const hidden = () => (d.prepare("SELECT left_hidden_at FROM assets").get() as { left_hidden_at: number | null }).left_hidden_at !== null;

it("is shown while a copy is known elsewhere, and shown again once no list is left", async () => {
  mkdirSync(path.join(footage, "Private"), { recursive: true });
  writeFileSync(path.join(footage, "x.mp4"), "x");
  writeFileSync(path.join(footage, "Private", "x.mp4"), "x");
  storage();
  d.prepare("INSERT OR IGNORE INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_u', ?, 'U', 'local', 0)").run(USER);
  await scan();
  storage(["Private"]);
  await scan();
  expect(hidden()).toBe(false);
  renameSync(footage, `${footage} away`);
  try {
    // the folder away: kept on what is unknown, hidden meanwhile
    await scan();
    expect(hidden()).toBe(true);
    // a computer has a copy verified: known, so shown, and never hidden again pass after pass
    const v = (d.prepare("SELECT id FROM asset_versions").get() as { id: string }).id;
    d.prepare("INSERT INTO version_places (version_id, device, folder_id, path, bytes, confirmed_at, checked_at, state, source) VALUES (?, 'mac_elsewhere', '', '/Volumes/Elsewhere/x.mp4', 1, 0, 0, 'verified', 'scan')").run(v);
    await scan();
    expect(hidden()).toBe(false);
    d.prepare("DELETE FROM version_places WHERE device = 'mac_elsewhere'").run();
    await scan();
    expect(hidden()).toBe(true);
    // the last left-out name removed while the folder is still away: shown again
    storage();
    await scan();
    expect(hidden()).toBe(false);
  } finally {
    renameSync(`${footage} away`, footage);
  }
});
