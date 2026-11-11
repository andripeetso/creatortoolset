import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-activity-"));
process.env.DATA_DIR = dir;
delete process.env.APP_SECRET;
const { libraryDb } = await import("./db");
const { libraryWork } = await import("./activity");
const { appRows } = await import("../activity");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const tiny = { username: "tiny", role: "admin" as const, cloud: false, off: [] };
const d = libraryDb();
d.prepare(`INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_a', 'tiny', 'L', 'local', '{"describe":true}', 1)`).run();
const now = Date.now();
for (const i of [1, 2, 3]) {
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, 'lib_a', 'video', 'c', ?, 'tiny', 1)").run(`a${i}`, `v${i}`);
  d.prepare(
    `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at)
     VALUES (?, ?, 1, 'k', 1000, ?, '{"duration":10,"vcodec":"h264"}', 'ready', 'tiny', 1)`,
  ).run(`v${i}`, `a${i}`, `s${i}`);
}
// clip 1's thumbnail is made (first, as the files lane takes them), clip 2's is still to make, clip 3's description waits
// for the plan's limit (worker.ts holdForLimit); an older clip's thumbnail from before this run does not count
d.prepare("INSERT INTO jobs (library_id, version_id, kind, state, actor, done_at) VALUES ('lib_a', 'v0', 'thumb', 'done', 'tiny', 0)").run();
d.prepare("INSERT INTO jobs (library_id, version_id, kind, state, actor, done_at) VALUES ('lib_a', 'v1', 'thumb', 'done', 'tiny', ?)").run(now);
d.prepare("INSERT INTO jobs (library_id, version_id, kind, state, actor) VALUES ('lib_a', 'v2', 'thumb', 'queued', 'tiny')").run();
d.prepare("INSERT INTO jobs (library_id, version_id, kind, state, actor, run_after, error) VALUES ('lib_a', 'v3', 'describe', 'queued', 'tiny', ?, ?)").run(
  now + 15 * 60_000,
  "Your Claude plan's weekly limit is reached; it resets 5pm.",
);
// one upload sent a part a minute ago, one was left days ago
const upload = (id: string, at: number) =>
  d.prepare(
    `INSERT INTO uploads (id, library_id, created_by, filename, size, received, staging_path, expires_at, state) VALUES (?, 'lib_a', 'tiny', 'x.mp4', 100, 40, '/nowhere', ?, 'open')`,
  ).run(id, at + 7 * 86_400_000);
upload("u1", now - 60_000);
upload("u2", now - 3 * 86_400_000);

describe("libraryWork and its rows", () => {
  it("says what is being prepared, uploaded and held back by the plan's limit, with the limit as the reason", async () => {
    const work = await libraryWork(tiny);
    expect(work).toHaveLength(1);
    expect(work[0].uploading).toEqual({ files: 1, received: 40, size: 100 });
    expect(work[0].folders).toEqual([]);
    const rows = appRows({ libraries: work, edits: [], exports: [] });
    expect(rows.map((r) => [r.detail, r.state, r.reason ?? null])).toEqual([
      ["Uploading 1 file · 40%", "working", null],
      // ponytail: progress() counts the held clip among the clips (estimate.ts), not among the jobs left
      ["Preparing 2 clips · 50%", "working", null],
      ["1 AI description waits", "working", "Your Claude plan's weekly limit is reached; it resets 5pm. They carry on by themselves then."],
    ]);
    expect(rows.every((r) => r.href === "/library" && r.title === "Media Library")).toBe(true);
  });

  it("gives another account's libraries nothing", async () => {
    expect(await libraryWork({ ...tiny, username: "someone" })).toEqual([]);
  });
});
