import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_FOLDERS, SOUNDS, type Organize } from "../../contracts/library";
import { libraryDb } from "./db";
import { enqueueJob } from "./jobs";
import { indexAsset } from "./query";

/**
 * How a library is organized (its setting `organize`, chosen on the Media Library's first run): "default" makes
 * DEFAULT_FOLDERS (missing ones only, when chosen: a folder deleted later is not made again). "ai" makes no folder up
 * front and never an empty one: every file that comes in and is in no folder yet is filed, and a folder is made the
 * first time a file goes into it. A video is filed by its description (describe.ts: the AI sees what the footage is and
 * names one of the library's plain top-level folders, or a new one while there are fewer than MAX_AI_FOLDERS); a sound
 * by its length (organizeOnProbe); a picture goes to Graphics. Never into Finals. Choosing "ai" files what is already
 * there too (fileUnfiled).
 */

/** Past this many plain top-level folders the AI only files into the ones there are. */
export const MAX_AI_FOLDERS = 12;

const id = () => `col_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

/** ponytail: a guess by length, no listening: under 20 s is a sound effect, longer is music */
export const SHORT_SOUND_S = 20;
/** The tag each sound folder's files carry (the names the assistant's songs and sound effects use too) */
const SOUND_TAGS: Record<string, string> = Object.fromEntries(Object.values(SOUNDS).map((s) => [s.folder, s.tag]));

export function organizeOf(libraryId: string, d = libraryDb()): Organize | undefined {
  const r = d.prepare("SELECT json_extract(settings, '$.organize') AS o FROM libraries WHERE id = ?").get(libraryId) as { o: Organize | null } | undefined;
  return r?.o ?? undefined;
}

/** The smart folder over `query` (the exact JSON text), made on first use. The AI Editor's A-roll folder comes from here too. */
export function smartFolder(d: DatabaseSync, libraryId: string, name: string, query: string, by: string, at = Date.now()): string {
  const found = d.prepare("SELECT id FROM collections WHERE library_id = ? AND kind = 'smart' AND query = ? ORDER BY created_at, id LIMIT 1").get(libraryId, query) as
    | { id: string }
    | undefined;
  if (found) return found.id;
  // ponytail: two first-time requests at once can make two; add a unique index when that shows up
  const made = id();
  d.prepare("INSERT INTO collections (id, library_id, parent_id, name, kind, query, created_at, created_by) VALUES (?, ?, NULL, ?, 'smart', ?, ?, ?)").run(
    made,
    libraryId,
    name,
    query,
    at,
    by,
  );
  return made;
}

/** A plain top-level folder by name (the oldest when two share it), or null. */
function topFolder(d: DatabaseSync, libraryId: string, name: string): string | null {
  const r = d.prepare("SELECT id FROM collections WHERE library_id = ? AND parent_id IS NULL AND kind = 'manual' AND name = ? ORDER BY created_at, id LIMIT 1").get(libraryId, name) as
    | { id: string }
    | undefined;
  return r?.id ?? null;
}

/** Makes the DEFAULT_FOLDERS the library does not have yet, in their order. */
export function ensureDefaultFolders(d: DatabaseSync, libraryId: string, by: string): void {
  const now = Date.now();
  DEFAULT_FOLDERS.forEach((f, i) => {
    if (f.roll) return void smartFolder(d, libraryId, f.name, JSON.stringify({ roll: f.roll }), by, now + i);
    if (topFolder(d, libraryId, f.name)) return;
    d.prepare("INSERT INTO collections (id, library_id, parent_id, name, kind, created_at, created_by) VALUES (?, ?, NULL, ?, 'manual', ?, ?)").run(id(), libraryId, f.name, now + i, by);
  });
}

/** The plain top-level folders a clip may be filed in by the describe AI: never Finals (it has its own tool), nor a smart folder. */
export function plainFolders(d: DatabaseSync, libraryId: string): string[] {
  // a smart folder (smart.ts) is filed by its own rule, never by a guess from its name
  const rows = d.prepare("SELECT name FROM collections WHERE library_id = ? AND parent_id IS NULL AND kind = 'manual' AND rule IS NULL AND name <> 'Finals' ORDER BY created_at, id").all(libraryId) as {
    name: string;
  }[];
  return [...new Set(rows.map((r) => r.name))];
}

interface Asset {
  id: string;
  library_id: string;
  kind: string;
  created_by: string;
}

const assetOf = (d: DatabaseSync, versionId: string) =>
  d.prepare("SELECT a.id, a.library_id, a.kind, a.created_by FROM assets a JOIN asset_versions v ON v.asset_id = a.id WHERE v.id = ?").get(versionId) as Asset | undefined;

/** The version's asset when the AI files it: its library organizes by AI and it is in no plain folder yet (one it was dropped in, Finals). */
export function toFile(d: DatabaseSync, versionId: string): Asset | null {
  const a = assetOf(d, versionId);
  if (!a || organizeOf(a.library_id, d) !== "ai") return null;
  const filed = d.prepare("SELECT 1 FROM collection_items i JOIN collections c ON c.id = i.collection_id WHERE i.asset_id = ? AND c.kind = 'manual'").get(a.id);
  return filed ? null : a;
}

/**
 * Puts the asset in the plain top-level folder `name`, made when the library has none by that name (a name differing only
 * in case is the same folder), with the sound tag a sound folder carries. Returns whether it did.
 */
export function fileInto(d: DatabaseSync, a: Asset, name: string): boolean {
  name = name.replace(/\s+/g, " ").trim().slice(0, 40);
  if (!name || name.toLowerCase() === "finals") return false;
  const same = plainFolders(d, a.library_id).find((f) => f.toLowerCase() === name.toLowerCase());
  if (same) name = same;
  let folder = topFolder(d, a.library_id, name);
  if (!folder) {
    folder = id();
    d.prepare("INSERT INTO collections (id, library_id, parent_id, name, kind, created_at, created_by) VALUES (?, ?, NULL, ?, 'manual', ?, ?)").run(folder, a.library_id, name, Date.now(), a.created_by);
  }
  d.prepare(
    `INSERT OR IGNORE INTO collection_items (collection_id, asset_id, position, added_by)
     SELECT ?, ?, COALESCE(MAX(position), 0) + 1, ? FROM collection_items WHERE collection_id = ?`,
  ).run(folder, a.id, a.created_by, folder);
  const tag = SOUND_TAGS[name];
  if (tag) {
    // the app's guess, so an AI tag: a user tag would keep the transcript off a voice recording filed here by mistake
    d.prepare("INSERT OR IGNORE INTO asset_tags (asset_id, tag, source) VALUES (?, ?, 'ai')").run(a.id, tag);
    indexAsset(d, a.id);
  }
  return true;
}

/** After the probe: a sound or a picture in a library the AI organizes goes to its folder (videos wait for their description). */
export function organizeOnProbe(d: DatabaseSync, versionId: string, duration: number, song = false): void {
  const a = toFile(d, versionId);
  if (a && song) fileInto(d, a, SOUNDS.music.folder); // a music video too
  else if (a?.kind === "audio") fileInto(d, a, duration < SHORT_SOUND_S ? SOUNDS.effect.folder : SOUNDS.music.folder);
  else if (a?.kind === "image") fileInto(d, a, "Graphics");
}

/**
 * A library just set to "ai": what is in no folder yet is filed now. Sounds and pictures at once; videos get their
 * description again (it names the folder), on the person who chose it. Trashed files are left alone.
 */
export function fileUnfiled(d: DatabaseSync, libraryId: string, by: string): void {
  const rows = d
    .prepare(
      `SELECT a.id, a.library_id, a.kind, a.created_by, v.id AS version, json_extract(v.probe, '$.duration') AS duration
       FROM assets a JOIN asset_versions v ON v.id = a.current_version_id
       WHERE a.library_id = ? AND a.trashed_at IS NULL AND v.state = 'ready'
         AND NOT EXISTS (SELECT 1 FROM collection_items i JOIN collections c ON c.id = i.collection_id WHERE i.asset_id = a.id AND c.kind = 'manual')`,
    )
    .all(libraryId) as unknown as (Asset & { version: string; duration: number | null })[];
  for (const r of rows) {
    if (r.kind === "video") enqueueJob(d, libraryId, r.version, "describe", by, true);
    else organizeOnProbe(d, r.version, r.duration ?? 0);
  }
}
