import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { SOUNDS, type Organize, type Sound } from "../../contracts/library";
import type { SessionUser } from "../users";
import { blobs, libraryDb, librarySetting } from "./db";
import { workspaceOf } from "./describe";
import { indexAsset } from "./query";
import { lookBudgetWaits } from "./shots";
import { fileSmart } from "./smart";
import { FILMED, fileShoot, isGraphic, readHere, type Asset } from "./shoots";
import type { ProbeSummary } from "./media/probe";

type Who = Pick<SessionUser, "username" | "role">;

/**
 * How a library is organized (its setting `organize`, chosen on the Media Library's first run): "default" makes no folder
 * up front (UNIFIED-PRD §4.9: the folders are the person's own). "ai" (Smart folders) makes no folder up front and never
 * an empty one: every file that comes in and is in no folder yet is filed as soon as it is probed, and a folder is made
 * the first time a file goes into it. A video or a camera photo goes into its shoot's folder (shoots.ts: by when and where
 * it was filmed, never by topic: topics are tags); a sound by its kind (sound-kind.ts: its tag, folders, length, or a
 * listen); a graphic (a logo, a screenshot, an export: shoots.ts isGraphic) to Graphics. Never into Finals. Choosing
 * "ai" files what is already there too (fileUnfiled).
 */

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

/** The plain top-level folders: never Finals, nor a smart folder (smart.ts: filed by its own rule). */
function plainFolders(d: DatabaseSync, libraryId: string): string[] {
  const rows = d.prepare("SELECT name FROM collections WHERE library_id = ? AND parent_id IS NULL AND kind = 'manual' AND rule IS NULL AND name <> 'Finals' ORDER BY created_at, id").all(libraryId) as {
    name: string;
  }[];
  return [...new Set(rows.map((r) => r.name))];
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

/** Whether a version's picture is a graphic (shoots.ts isGraphic), from its probe and its file's name. */
function graphic(d: DatabaseSync, versionId: string): boolean {
  const r = d.prepare("SELECT probe, COALESCE(mac_path, source_path, from_path) AS file FROM asset_versions WHERE id = ?").get(versionId) as { probe: string | null; file: string | null } | undefined;
  return isGraphic(r?.probe ? (JSON.parse(r.probe) as ProbeSummary) : null, r?.file);
}

/**
 * After the probe, in a library the AI organizes and a file in no folder yet: a sound (by its kind, sound-kind.ts) or a
 * song's video to its kind's folder, a graphic to Graphics, a video or a camera photo into its shoot (shoots.ts).
 */
export function organizeOnProbe(d: DatabaseSync, versionId: string, sound: Sound | null): void {
  const a = toFile(d, versionId);
  if (!a) return;
  if (sound) fileInto(d, a, SOUNDS[sound].folder);
  else if (a.kind === "image" && graphic(d, versionId)) fileInto(d, a, "Graphics");
  else if (a.kind === "video" || a.kind === "image") fileShoot(d, a);
}

/** The library's files in no folder yet, ready and not in the trash, in the order they were filmed (a shoot is named by its first day). */
function unfiled(d: DatabaseSync, libraryId: string) {
  return d
    .prepare(
      `SELECT a.id, a.library_id, a.kind, a.created_by, v.id AS version,
         (SELECT tag FROM asset_tags t WHERE t.asset_id = a.id AND t.tag IN (?, ?) ORDER BY t.source = 'user' DESC LIMIT 1) AS sound
       FROM assets a JOIN asset_versions v ON v.id = a.current_version_id
       WHERE a.library_id = ? AND a.trashed_at IS NULL AND v.state = 'ready'
         AND NOT EXISTS (SELECT 1 FROM collection_items i JOIN collections c ON c.id = i.collection_id WHERE i.asset_id = a.id AND c.kind = 'manual')
       ORDER BY ${FILMED}, a.id`,
    )
    .all(SOUNDS.music.tag, SOUNDS.effect.tag, libraryId) as unknown as (Asset & { version: string; sound: string | null })[];
}

const soundOf = (tag: string | null): Sound | null => (tag === SOUNDS.music.tag ? "music" : tag === SOUNDS.effect.tag ? "effect" : null);

/**
 * A library just set to "ai": what is in no folder yet is filed now. A video goes into its shoot (no AI call: shoots.ts).
 * A sound or picture goes to the smart folders that fit it (smart.ts), else to its kind's folder or its shoot. A judge
 * call is a model call, so with describe off or the look budget spent (UNIFIED-PRD §4.4–4.5) those files take their
 * kind's folder or shoot only. Trashed files are left alone.
 */
export async function fileUnfiled(d: DatabaseSync, libraryId: string, who: Who): Promise<void> {
  // one at a time: each judge call is a model call (shortcut: not batched as sortFolder is, fine while the sweep is once per library, upgrade if a large library stalls)
  for (const r of unfiled(d, libraryId)) {
    if (r.kind !== "video") {
      const judge = librarySetting(libraryId, "describe") && !(await lookBudgetWaits(d, r.version));
      if (judge && ((await fileSmart(d, r.version, who, await workspaceOf(d, r.version)).catch(() => 0)) ?? 0)) continue;
    }
    // a sound by its kind's tag (sound-kind.ts, since its probe): one with none (taken off, someone talking) stays where it is
    organizeOnProbe(d, r.version, soundOf(r.sound));
  }
}

/**
 * Once for a library the AI organized before shoots (11-19), and harmless every start after: the folders the AI named by
 * topic (a rule of their own name, fileInto's old aiMade) give their clips back and go, and the camera photos in Graphics
 * leave it; then everything in no folder is filed by shoot. A topic folder the person renamed, gave a rule, a folder
 * inside, a share or a Finals piece is theirs and is left as it is, and so is every other folder. Returns how many
 * files it filed. Smart folders live in the library only: no file on disk moves.
 */
export async function refileShoots(d: DatabaseSync, libraryId: string): Promise<number> {
  if (organizeOf(libraryId, d) !== "ai") return 0;
  const topics = d
    .prepare(
      `SELECT id FROM collections c WHERE library_id = ? AND kind = 'manual' AND shoot IS NULL AND rule IS NOT NULL AND rule = name
         AND NOT EXISTS (SELECT 1 FROM collections k WHERE k.parent_id = c.id) AND NOT EXISTS (SELECT 1 FROM library_grants g WHERE g.collection_id = c.id)
         AND NOT EXISTS (SELECT 1 FROM pieces p WHERE p.collection_id = c.id)`,
    )
    .all(libraryId) as { id: string }[];
  const photos = d
    .prepare(
      `SELECT c.id AS folder, i.asset_id AS asset, v.id AS version FROM collections c JOIN collection_items i ON i.collection_id = c.id
         JOIN assets a ON a.id = i.asset_id JOIN asset_versions v ON v.id = a.current_version_id
       WHERE c.library_id = ? AND c.parent_id IS NULL AND c.name = 'Graphics' AND c.rule IS NULL AND c.shoot IS NULL AND a.kind = 'image'`,
    )
    .all(libraryId) as { folder: string; asset: string; version: string }[];
  inTx(d, () => {
    for (const t of topics) {
      d.prepare("DELETE FROM collection_items WHERE collection_id = ?").run(t.id);
      d.prepare("DELETE FROM folder_out WHERE collection_id = ?").run(t.id);
      d.prepare("DELETE FROM collections WHERE id = ?").run(t.id);
    }
  });
  // a file whose header was never read for its camera and time (probed before 11-19, or indexed on a Mac): read once
  // where it is, on this very Mac or this server's own disk (a bucket's would be downloaded whole), before it is filed
  const unread = d.prepare(
    `SELECT v.mac_path, v.source_key, l.storage_kind FROM asset_versions v JOIN assets a ON a.id = v.asset_id JOIN libraries l ON l.id = a.library_id
     WHERE v.id = ? AND json_type(v.probe, '$.camera') IS NULL`,
  );
  const files = d.prepare("SELECT a.kind FROM assets a JOIN asset_versions v ON v.asset_id = a.id WHERE v.id = ?");
  for (const version of new Set([...photos.map((p) => p.version), ...unfiled(d, libraryId).map((r) => r.version)])) {
    const u = unread.get(version) as { mac_path: string | null; source_key: string; storage_kind: string } | undefined;
    if (!u) continue;
    const { kind } = files.get(version) as { kind: string };
    const file = u.mac_path ?? (u.storage_kind === "local" && !u.source_key.startsWith("mac:") ? await blobs.localCopy(u.source_key).catch(() => null) : null);
    if (file) await readHere(d, version, file, kind);
  }
  let n = 0;
  inTx(d, () => {
    for (const p of photos) if (!graphic(d, p.version)) d.prepare("DELETE FROM collection_items WHERE collection_id = ? AND asset_id = ?").run(p.folder, p.asset);
    for (const r of unfiled(d, libraryId)) {
      organizeOnProbe(d, r.version, soundOf(r.sound));
      n += toFile(d, r.version) ? 0 : 1;
    }
  });
  return n;
}

function inTx(d: DatabaseSync, f: () => void): void {
  d.exec("BEGIN");
  try {
    f();
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

/** refileShoots for every library the AI organizes: at the worker's start. */
export async function refileAllShoots(d = libraryDb()): Promise<void> {
  const libs = d.prepare("SELECT id FROM libraries WHERE json_extract(settings, '$.organize') = 'ai'").all() as { id: string }[];
  const { libraryChanged } = await import("./access"); // the open pages' folders refetch
  for (const l of libs) {
    try {
      if (await refileShoots(d, l.id)) libraryChanged(l.id);
    } catch (e) {
      console.error("[library] shoots:", l.id, e);
    }
  }
}
