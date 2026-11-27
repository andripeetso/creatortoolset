// Seeds the Finals check on top of seed.ts (same SEED_DATA_DIR): four upright pictures (a carousel's slides) the server
// serves, with thumbnails, in the set-up library, which is the only one. Synthetic ffmpeg test patterns only.
import { execFileSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import path from "node:path";

const data = process.env.SEED_DATA_DIR;
if (!data) throw new Error("SEED_DATA_DIR is not set");
process.env.DATA_DIR = data;
const { libraryDb, blobs } = await import("../../api/library/db");
const { indexAsset } = await import("../../api/library/query");

const d = libraryDb();
// Finals reads the first library: only the set-up one, serving its originals
d.prepare("DELETE FROM libraries WHERE id = 'lib_fresh'").run();
d.prepare("UPDATE libraries SET settings = ? WHERE id = 'lib_ready'").run(JSON.stringify({ setupAt: "2026-11-18T09:00:00.000Z", upload: "originals" }));
const ff = (...a: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...a]);
const keep = async (file: string, key: string) => {
  const copy = `${file}.put`;
  copyFileSync(file, copy);
  return (await blobs.put(key, copy)).bytes;
};
for (const n of [1, 2, 3, 4]) {
  const id = `slide${n}`;
  const v = `ver_${id}`;
  const base = `libraries/lib_ready/v/${v}`;
  const src = path.join(data, `${id}.jpg`);
  ff("-f", "lavfi", "-i", `testsrc2=size=1080x1350:rate=1`, "-frames:v", "1", "-vf", `hue=h=${n * 70}`, src);
  const thumb = path.join(data, `${id}-thumb.jpg`);
  ff("-i", src, "-vf", "scale=480:-2", thumb);
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, 'lib_ready', 'image', ?, ?, 'owner', ?)").run(`ast_${id}`, `Tiny slide ${n}`, v, Date.now() + n);
  await keep(src, `${base}/source`);
  d.prepare(
    "INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, mime, probe, state, created_by, created_at) VALUES (?, ?, 1, ?, 1, ?, 'image/jpeg', ?, 'ready', 'owner', 0)",
  ).run(v, `ast_${id}`, `${base}/source`, `sha-${id}`, JSON.stringify({ width: 1080, height: 1350 }));
  const bytes = await keep(thumb, `${base}/thumb.jpg`);
  d.prepare("INSERT OR REPLACE INTO derivatives (version_id, kind, storage_key, bytes) VALUES (?, 'thumb', ?, ?)").run(v, `${base}/thumb.jpg`, bytes);
  indexAsset(d, `ast_${id}`);
}
