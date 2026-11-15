import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { ffmpegCommand } from "../../ffmpeg-runtime";

// Clips probed before the country was kept get it once, from their location tag (probe.ts placeUnplaced).
const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-place-"));
process.env.DATA_DIR = dir;
const { blobs, libraryDb } = await import("../db");
const { placeUnplaced } = await import("./probe");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it("gives older clips their country once, from the file on this disk", async () => {
  const db = libraryDb();
  db.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_p', 'ws', 'P', 'local', 0)").run();
  const clip = async (id: string, location?: string) => {
    const key = `libraries/lib_p/v/${id}/source.mp4`;
    if (location !== "gone") {
      const file = path.join(dir, `${id}.mp4`);
      execFileSync(ffmpegCommand(), ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=64x48:rate=5", "-c:v", "libx264",
        "-pix_fmt", "yuv420p", ...(location ? ["-metadata", `location=${location}`] : []), file]);
      await blobs.put(key, file);
    }
    db.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, 'lib_p', 'video', ?, ?, 'o', 0)").run(id, id, `v_${id}`);
    db.prepare(
      "INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, probe, created_by, created_at) VALUES (?, ?, 1, ?, 1, ?, 'ready', '{\"duration\":1}', 'o', 0)",
    ).run(`v_${id}`, id, key, id);
  };
  await clip("lisbon", "+38.7139-009.1394/");
  await clip("plain");
  await clip("missing", "gone");
  const country = (id: string) => (db.prepare("SELECT probe FROM asset_versions WHERE id = ?").get(`v_${id}`) as { probe: string }).probe;

  expect(await placeUnplaced(db)).toBe(2);
  expect(JSON.parse(country("lisbon"))).toEqual({ duration: 1, country: "PT" });
  expect(JSON.parse(country("plain")).country).toBe("");
  expect(JSON.parse(country("missing")).country).toBeUndefined(); // left for the next start
  expect(country("lisbon")).not.toMatch(/38\.71|009\.13/);
  expect(await placeUnplaced(db)).toBe(0); // once
});
