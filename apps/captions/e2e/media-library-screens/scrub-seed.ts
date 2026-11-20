// Seeds the hover-scrub check on top of seed.ts (same SEED_DATA_DIR): an upright and a landscape clip with strips in
// their own shape, and an upright clip whose only copy is on a computer, with an old 16:9 strip and the new strip that
// computer would hand in (written to <data>/new-strip.jpg). Synthetic ffmpeg test patterns only.
import { execFileSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import path from "node:path";

const data = process.env.SEED_DATA_DIR;
if (!data) throw new Error("SEED_DATA_DIR is not set");
process.env.DATA_DIR = data;
const { libraryDb, blobs } = await import("../../api/library/db");
const { probe } = await import("../../api/library/media/probe");
const { indexAsset } = await import("../../api/library/query");
const { makeSprite, noteStrip } = await import("../../api/library/media/sprite");
const { readFileSync } = await import("node:fs");

const d = libraryDb();
// the fresh library is set up too here: no setup dialog over the Gallery
d.prepare("UPDATE libraries SET settings = ? WHERE id = 'lib_fresh'").run(JSON.stringify({ setupAt: "2026-11-18T09:00:00.000Z" }));
const ff = (...a: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...a]);
const clip = (name: string, size: string) => {
  const f = path.join(data, `${name}.mp4`);
  ff("-f", "lavfi", "-i", `testsrc2=duration=6:size=${size}:rate=30`, "-c:v", "libx264", "-pix_fmt", "yuv420p", f);
  return f;
};
const keep = async (file: string, key: string) => {
  const copy = `${file}.put`;
  copyFileSync(file, copy);
  return (await blobs.put(key, copy)).bytes;
};
let at = Date.now();
async function add(id: string, title: string, src: string, strip: "new" | "old", mac?: string) {
  const v = `ver_${id}`;
  const base = `libraries/lib_ready/v/${v}`;
  const p = await probe(src);
  const thumb = path.join(data, `${id}-thumb.jpg`);
  ff("-ss", "1", "-i", src, "-frames:v", "1", "-vf", "scale=480:-2", thumb);
  const sprite = path.join(data, `${id}-sprite.jpg`);
  // an old strip as strips were cut before 2026-11-19: 160 × 90 frames, side by side
  if (strip === "new") await makeSprite(src, sprite, p.duration);
  else ff("-i", src, "-vf", `fps=20/${p.duration},scale=160:90:force_original_aspect_ratio=increase,crop=160:90,tile=20x1`, "-frames:v", "1", sprite);
  const jpeg = readFileSync(sprite);
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, 'lib_ready', 'video', ?, ?, 'owner', ?)").run(`ast_${id}`, title, v, at++);
  const source = mac ? `mac:${v}` : `${base}/source`;
  if (!mac) await keep(src, source);
  d.prepare(
    "INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, mime, probe, state, created_by, created_at, mac_path, mac_device) VALUES (?, ?, 1, ?, 1, ?, 'video/mp4', ?, 'ready', 'owner', 0, ?, ?)",
  ).run(v, `ast_${id}`, source, `sha-${id}`, JSON.stringify(p), mac ?? null, mac ? "mac-tiny" : null);
  for (const [kind, file] of [["thumb", thumb], ["sprite", sprite]] as const) {
    const bytes = await keep(file, `${base}/${kind}.jpg`);
    d.prepare("INSERT OR REPLACE INTO derivatives (version_id, kind, storage_key, bytes) VALUES (?, ?, ?, ?)").run(v, kind, `${base}/${kind}.jpg`, bytes);
  }
  if (strip === "new") noteStrip(d, v, jpeg);
  indexAsset(d, `ast_${id}`);
}
const tall = clip("tall", "360x640");
const wide = clip("wide", "640x360");
await add("old", "Old strip upright", tall, "old", "/Volumes/Tiny/Source media/Old strip upright.mp4");
await add("wide", "Scrub landscape", wide, "new");
await add("tall", "Scrub upright", tall, "new");
// what the Mac that has the old clip makes from its file (onMac.ts repairStrips): the strip in the clip's own shape
await makeSprite(tall, path.join(data, "new-strip.jpg"), (await probe(tall)).duration);
console.log(JSON.stringify({ scrub: true }));
