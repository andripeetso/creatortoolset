import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const { placeUnplaced, probe } = await import("./probe");
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

/** A JPEG whose EXIF puts it at 59°26'13.32"N 24°45'12.96"E (Tallinn), the way a camera writes it (big-endian TIFF). */
function photoAt(file: string) {
  execFileSync(ffmpegCommand(), ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=64x48", "-frames:v", "1", file]);
  const t = Buffer.alloc(128);
  t.write("MM\0*", 0, "latin1");
  t.writeUInt32BE(8, 4);
  const entry = (o: number, tag: number, type: number, count: number, value: number) => {
    t.writeUInt16BE(tag, o);
    t.writeUInt16BE(type, o + 2);
    t.writeUInt32BE(count, o + 4);
    t.writeUInt32BE(value, o + 8);
  };
  t.writeUInt16BE(1, 8);
  entry(10, 0x8825, 4, 1, 26); // the GPS IFD
  t.writeUInt16BE(4, 26);
  entry(28, 1, 2, 2, 0x4e000000); // "N"
  entry(40, 2, 5, 3, 80);
  entry(52, 3, 2, 2, 0x45000000); // "E"
  entry(64, 4, 5, 3, 104);
  [59, 1, 26, 1, 1332, 100, 24, 1, 45, 1, 1296, 100].forEach((n, i) => t.writeUInt32BE(n, 80 + i * 4));
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, 2 + 6 + t.length]), Buffer.from("Exif\0\0", "latin1"), t]);
  const jpg = readFileSync(file);
  writeFileSync(file, Buffer.concat([jpg.subarray(0, 2), app1, jpg.subarray(2)]));
}

it("a photo's country comes from its EXIF, and its coordinates are not kept", async () => {
  const file = path.join(dir, "photo.jpg");
  photoAt(file);
  const p = await probe(file);
  expect(p.country).toBe("EE");
  expect(JSON.stringify(p)).not.toMatch(/59\.4|24\.7/);

  // a photo placed before EXIF was read (country "") is read once more after the migration cleared it
  const db = libraryDb();
  const key = "libraries/lib_p/v/photo/source.jpg";
  await blobs.put(key, file);
  db.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES ('photo', 'lib_p', 'image', 'photo', 'v_photo', 'o', 0)").run();
  db.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, probe, created_by, created_at) VALUES ('v_photo', 'photo', 1, ?, 1, 'p', 'ready', '{\"duration\":0}', 'o', 0)").run(key);
  expect(await placeUnplaced(db)).toBe(1);
  expect(JSON.parse((db.prepare("SELECT probe FROM asset_versions WHERE id = 'v_photo'").get() as { probe: string }).probe).country).toBe("EE");
});
