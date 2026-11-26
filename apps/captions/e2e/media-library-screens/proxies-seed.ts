// Seeds the blurred copies and proxies check (docs/media-library-proxies-prd.md R12, L10) on top of seed.ts, same
// SEED_DATA_DIR. Run again it puts every library back as it started, also while the server is up (proxies.mjs does so
// before each pass). Face Blur is switched on in every workspace of the owner's. Synthetic clips only.
//   PROXIES_FIRST=<library id>  the library that sorts first: the one Settings → Media Library and the page open on
//   PROXIES_SETUP=1             the Fresh library is not set up, so the page opens its setup
import { copyFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const data = process.env.SEED_DATA_DIR;
if (!data) throw new Error("SEED_DATA_DIR is not set");
process.env.DATA_DIR = data;
const { libraryDb, blobs } = await import("../../api/library/db");
const { indexAsset } = await import("../../api/library/query");
const { heldFile } = await import("../../api/library/held");

const d = libraryDb();
const SET_UP = { setupAt: "2026-11-18T09:00:00.000Z" };
const first = process.env.PROXIES_FIRST ?? "lib_ready";
const home = (d.prepare("SELECT workspace_id AS w FROM libraries WHERE id = 'lib_ready'").get() as { w: string }).w;
const take = d.prepare("SELECT bytes, probe FROM asset_versions WHERE id = 'ver_clip1'").get() as { bytes: number; probe: string };
const fixture = path.join(data, "take.mp4");

// Face Blur on in every workspace: the choice as the app keeps it (api/lib/plugin-workspaces.ts)
writeFileSync(path.join(data, "plugin-workspaces.json"), JSON.stringify({ before: ["blur-faces"], choices: { "blur-faces": { owner: { all: true } } } }));

/** A library as it starts: its settings, and each clip's blur answer [blur, blur_note] (a clip named "held": the server holds its file). */
const LIBRARIES: Record<string, { name: string; settings: object; clips: Record<string, [string | null, string | null]> }> = {
  // nobody answered for its files: turning Blur faces on asks about them
  lib_ready: { name: "Tiny Acrobatics library", settings: { ...SET_UP, proxy: false, upload: "none" }, clips: { clip1: [null, null], clip2: [null, null], clip3: [null, null] } },
  // every file has its answer: turning Blur faces on asks nothing, and Blurred copies is Done
  lib_answered: { name: "Answered library", settings: { ...SET_UP, proxy: false, upload: "none" }, clips: { ans1: ["no", "none"], ans2: ["no", null] } },
  // Blur faces went on with two files left as they were: 2 missing, with a clip no face was found in and one kept as filmed.
  // Upload sends proxies, so every video wants one (a small clip that plays as it is gets none otherwise): 4 missing
  lib_blur: { name: "Blurring library", settings: { ...SET_UP, blurFaces: true, proxy: true, upload: "proxies" }, clips: { left1: ["no", "skipped"], left2: ["no", "skipped"], none1: ["no", "none"], kept1: ["no", null] } },
  // a file from a phone, held for its blur; and Upload's Proxies part stored on while Generate proxies is off
  lib_held: { name: "Phone library", settings: { ...SET_UP, blurFaces: true, proxy: false, upload: "proxies" }, clips: { held: ["yes", null], plain1: ["no", "none"] } },
};
const TITLE: Record<string, string> = { ans1: "No faces clip", ans2: "Kept clip", left1: "Left as it was 1", left2: "Left as it was 2", none1: "No faces clip", kept1: "Kept clip", held: "From the phone", plain1: "No faces clip" };

d.prepare("UPDATE libraries SET settings = ? WHERE id = 'lib_fresh'").run(JSON.stringify(process.env.PROXIES_SETUP ? {} : SET_UP));
let at = Date.now();
for (const [lib, l] of Object.entries(LIBRARIES)) {
  d.prepare("INSERT OR IGNORE INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES (?, ?, ?, 'local', '{}', 0)").run(lib, home, l.name);
  d.prepare("UPDATE libraries SET settings = ? WHERE id = ?").run(JSON.stringify(l.settings), lib);
  for (const [clip, [blur, note]] of Object.entries(l.clips)) {
    const [asset, version] = [`ast_${clip}`, `ver_${clip}`];
    if (!d.prepare("SELECT 1 FROM assets WHERE id = ?").get(asset)) {
      const held = clip === "held";
      const key = held ? "mac:seed-phone" : `libraries/${lib}/v/${version}/source`;
      const put = path.join(data, `${clip}.mp4`);
      copyFileSync(fixture, put);
      if (held) {
        // as the upload's finish leaves it (routes.ts): recorded as on a computer, the bytes in library/held
        mkdirSync(path.dirname(heldFile(version)), { recursive: true });
        copyFileSync(put, heldFile(version));
      } else await blobs.put(key, put);
      d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, ?, 'video', ?, ?, 'owner', ?)").run(asset, lib, TITLE[clip], version, at++);
      d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, mime, probe, state, created_by, created_at, held) VALUES (?, ?, 1, ?, ?, ?, 'video/mp4', ?, 'ready', 'owner', ?, ?)").run(version, asset, key, statSync(fixture).size, `sha-${clip}`, take.probe, at, held ? 1 : null);
      indexAsset(d, asset);
    }
    d.prepare("UPDATE assets SET blur = ?, blur_note = ? WHERE id = ?").run(blur, note, asset);
    // what a pass made: the proxy jobs a press of Make queued, and a proxy the server got to
    d.prepare("DELETE FROM jobs WHERE version_id = ?").run(version);
    d.prepare("DELETE FROM derivatives WHERE version_id = ? AND kind = 'proxy'").run(version);
  }
}
d.prepare("UPDATE libraries SET created_at = CASE WHEN id = ? THEN -1 ELSE 0 END").run(first);
// a wrong PROXIES_FIRST would leave the pass on another library: say so here
if (!d.prepare("SELECT 1 FROM libraries WHERE id = ?").get(first)) throw new Error(`PROXIES_FIRST names no library: ${first}`);
console.log(JSON.stringify({ first, setup: !!process.env.PROXIES_SETUP, libraries: Object.keys(LIBRARIES) }));
