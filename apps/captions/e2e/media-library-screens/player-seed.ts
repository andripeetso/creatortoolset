// Seeds the player check on top of seed.ts (same SEED_DATA_DIR): an upright and a landscape clip the server plays, with
// strips in their own shape. VP9 WebM, so a headless Chromium (no H.264) plays them. Synthetic ffmpeg test patterns only.
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync } from "node:fs";
import path from "node:path";

const data = process.env.SEED_DATA_DIR;
if (!data) throw new Error("SEED_DATA_DIR is not set");
process.env.DATA_DIR = data;
const { libraryDb, blobs } = await import("../../api/library/db");
const { probe } = await import("../../api/library/media/probe");
const { indexAsset } = await import("../../api/library/query");
const { makeSprite, noteStrip } = await import("../../api/library/media/sprite");

const d = libraryDb();
d.prepare("UPDATE libraries SET settings = ? WHERE id = 'lib_fresh'").run(JSON.stringify({ setupAt: "2026-11-18T09:00:00.000Z" }));
// the server plays its originals here (Hosted media: originals), so the player has a clip to play
d.prepare("UPDATE libraries SET settings = ? WHERE id = 'lib_ready'").run(JSON.stringify({ setupAt: "2026-11-18T09:00:00.000Z", upload: "originals" }));
const ff = (...a: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...a]);
const keep = async (file: string, key: string) => {
  const copy = `${file}.put`;
  copyFileSync(file, copy);
  return (await blobs.put(key, copy)).bytes;
};
let at = Date.now();
async function add(id: string, title: string, size: string) {
  const src = path.join(data!, `${id}.webm`);
  ff("-f", "lavfi", "-i", `testsrc2=duration=20:size=${size}:rate=30`, "-c:v", "libvpx-vp9", "-b:v", "400k", "-deadline", "realtime", "-cpu-used", "8", src);
  const v = `ver_${id}`;
  const base = `libraries/lib_ready/v/${v}`;
  const p = await probe(src);
  const thumb = path.join(data!, `${id}-thumb.jpg`);
  ff("-ss", "1", "-i", src, "-frames:v", "1", "-vf", "scale=480:-2", thumb);
  const sprite = path.join(data!, `${id}-sprite.jpg`);
  await makeSprite(src, sprite, p.duration);
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, 'lib_ready', 'video', ?, ?, 'owner', ?)").run(`ast_${id}`, title, v, at++);
  await keep(src, `${base}/source`);
  d.prepare(
    "INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, mime, probe, state, created_by, created_at) VALUES (?, ?, 1, ?, 1, ?, 'video/webm', ?, 'ready', 'owner', 0)",
  ).run(v, `ast_${id}`, `${base}/source`, `sha-${id}`, JSON.stringify(p));
  for (const [kind, file] of [["thumb", thumb], ["sprite", sprite]] as const) {
    const bytes = await keep(file, `${base}/${kind}.jpg`);
    d.prepare("INSERT OR REPLACE INTO derivatives (version_id, kind, storage_key, bytes) VALUES (?, ?, ?, ?)").run(v, kind, `${base}/${kind}.jpg`, bytes);
  }
  noteStrip(d, v, readFileSync(sprite));
  indexAsset(d, `ast_${id}`);
}
await add("pwide", "Player landscape", "640x360");
await add("ptall", "Player upright", "360x640");
