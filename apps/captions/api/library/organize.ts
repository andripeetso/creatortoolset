import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { SOUNDS, type Organize, type Sound } from "../../contracts/library";
import type { SessionUser } from "../users";
import { libraryDb, librarySetting } from "./db";
import { workspaceOf } from "./describe";
import { enqueueJob } from "./jobs";
import { indexAsset } from "./query";
import { lookBudgetWaits } from "./shots";
import { fileSmart } from "./smart";

type Who = Pick<SessionUser, "username" | "role">;

/**
 * How a library is organized (its setting `organize`, chosen on the Media Library's first run): "default" makes no folder
 * up front (UNIFIED-PRD §4.9: the folders are the person's own). "ai" makes no folder up
 * front and never an empty one: every file that comes in and is in no folder yet is filed, and a folder is made the
 * first time a file goes into it. A video is filed by its description (describe.ts: the AI sees what the footage is and
 * names one of the library's plain top-level folders, or a new one while there are fewer than MAX_AI_FOLDERS); a sound
 * by its kind (sound-kind.ts: its tag, folders, length, or a listen); a picture goes to Graphics. Never into Finals. Choosing "ai" files what is already
 * there too (fileUnfiled).
 */

/** Past this many plain top-level folders the AI only files into the ones there are. */
export const MAX_AI_FOLDERS = 12;

const id = () => `col_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

/** A sound with nothing else to tell its kind by (sound-kind.ts): under 20 s is a sound effect, longer is music */
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
  const r = d.prepare("SELECT id FROM collections WHERE library_id = ? AND parent_id IS NULL AND kind = 'manual' AND name = ? COLLATE NOCASE ORDER BY created_at, id LIMIT 1").get(libraryId, name) as
    | { id: string }
    | undefined;
  return r?.id ?? null;
}

/** The plain top-level folders a clip may be filed in by the describe AI: never Finals (it has its own tool), nor a smart folder. */
export function plainFolders(d: DatabaseSync, libraryId: string): string[] {
  // a smart folder (smart.ts) is filed by its own rule, never by a guess from its name
  const rows = d.prepare("SELECT name FROM collections WHERE library_id = ? AND parent_id IS NULL AND kind = 'manual' AND rule IS NULL AND name <> 'Finals' ORDER BY created_at, id").all(libraryId) as {
    name: string;
  }[];
  return [...new Set(rows.map((r) => r.name))];
}

/** The top-level folders the cap counts: plain or smart, never Finals (a smart folder the AI made is one of them too). */
export const topCount = (d: DatabaseSync, libraryId: string): number =>
  (d.prepare("SELECT COUNT(DISTINCT name COLLATE NOCASE) AS n FROM collections WHERE library_id = ? AND parent_id IS NULL AND kind = 'manual' AND name <> 'Finals'").get(libraryId) as { n: number }).n;

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
 * in case is the same folder), with the sound tag a sound folder carries. Returns whether it did. A folder the AI makes
 * (`aiMade`) is made with a rule of its own name, so it is a smart folder and fills itself (UNIFIED-PRD §4.9), and only
 * while the library has fewer than MAX_AI_FOLDERS top-level folders.
 */
export function fileInto(d: DatabaseSync, a: Asset, name: string, aiMade = false): boolean {
  name = name.replace(/\s+/g, " ").trim().slice(0, 40);
  if (!name || name.toLowerCase() === "finals") return false;
  const same = plainFolders(d, a.library_id).find((f) => f.toLowerCase() === name.toLowerCase());
  if (same) name = same;
  let folder = topFolder(d, a.library_id, name);
  if (!folder) {
    if (aiMade && topCount(d, a.library_id) >= MAX_AI_FOLDERS) return false;
    folder = id();
    d.prepare("INSERT INTO collections (id, library_id, parent_id, name, kind, rule, created_at, created_by) VALUES (?, ?, NULL, ?, 'manual', ?, ?, ?)").run(
      folder,
      a.library_id,
      name,
      aiMade ? name : null,
      Date.now(),
      a.created_by,
    );
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

/**
 * After the probe: a sound (by its kind, sound-kind.ts), a song's video or a picture in a library the AI organizes goes
 * to its folder (other videos wait for their description).
 */
export function organizeOnProbe(d: DatabaseSync, versionId: string, sound: Sound | null): void {
  const a = toFile(d, versionId);
  if (a && sound) fileInto(d, a, SOUNDS[sound].folder);
  else if (a?.kind === "image") fileInto(d, a, "Graphics");
}

/**
 * A library just set to "ai": what is in no folder yet is filed now. Videos get their description again, on the person
 * who chose it: describe.ts judges the smart folders first, then names a plain folder. A sound or picture goes to the
 * smart folders that fit it (smart.ts), else to its kind's folder. A judge call is a model call, so with describe off or
 * the look budget spent (UNIFIED-PRD §4.4–4.5) those files take their kind's folder only. Trashed files are left alone.
 */
export async function fileUnfiled(d: DatabaseSync, libraryId: string, who: Who): Promise<void> {
  const by = who.username;
  const rows = d
    .prepare(
      `SELECT a.id, a.library_id, a.kind, a.created_by, v.id AS version,
         (SELECT tag FROM asset_tags t WHERE t.asset_id = a.id AND t.tag IN (?, ?) ORDER BY t.source = 'user' DESC LIMIT 1) AS sound
       FROM assets a JOIN asset_versions v ON v.id = a.current_version_id
       WHERE a.library_id = ? AND a.trashed_at IS NULL AND v.state = 'ready'
         AND NOT EXISTS (SELECT 1 FROM collection_items i JOIN collections c ON c.id = i.collection_id WHERE i.asset_id = a.id AND c.kind = 'manual')`,
    )
    .all(SOUNDS.music.tag, SOUNDS.effect.tag, libraryId) as unknown as (Asset & { version: string; sound: string | null })[];
  for (const r of rows) if (r.kind === "video") enqueueJob(d, libraryId, r.version, "describe", by, true);
  // one at a time: each judge call is a model call (shortcut: not batched as sortFolder is, fine while the sweep is once per library, upgrade if a large library stalls)
  for (const r of rows) {
    if (r.kind === "video") continue;
    const judge = librarySetting(libraryId, "describe") && !(await lookBudgetWaits(d, r.version));
    if (judge && ((await fileSmart(d, r.version, who, await workspaceOf(d, r.version)).catch(() => 0)) ?? 0)) continue;
    // a sound by its kind's tag (sound-kind.ts, since its probe): one with none (taken off, someone talking) stays where it is
    organizeOnProbe(d, r.version, r.sound === SOUNDS.music.tag ? "music" : r.sound === SOUNDS.effect.tag ? "effect" : null);
  }
}
