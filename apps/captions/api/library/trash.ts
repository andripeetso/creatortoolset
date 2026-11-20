import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { env } from "../lib/env";
import { blobs, libraryDb } from "./db";
import { dropMacFrames } from "./on-mac";
import { assetsCopiesLack, copiesNotice } from "./copies";

/**
 * The library's trash: an asset stays in it until the library's owner empties it (Empty trash), never for its age
 * (users manage their own storage). Emptying deletes it for good, with every version, derivative and file. Rows go first
 * in one transaction, then the files: a restore that lands in between finds nothing to restore, never a row whose file
 * is gone.
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** Finals pieces stay in the trash this long (owner default, 2026-11-08). */
const PIECE_TRASH_DAYS = 5;

/**
 * A Review video (api/review.ts toLibrary: same id), live or in Review's trash. Review owns its versions and its trash
 * (TRASH_DAYS there), so the library neither changes nor purges it: Review's own purge removes it from the library.
 */
export const inReview = (assetId: string) =>
  [path.join(env.dataDir, "review", assetId), path.join(env.dataDir, "review", "trash", assetId)].some((d) => existsSync(path.join(d, "meta.json")));

/** Why an asset must not leave the library by a scan (a file it no longer matches): in Review, or behind a live share
 *  link (an asset, one of its versions, or a collection it is in). Null: it may go. */
export function trashHeld(assetId: string, now = Date.now()): string | null {
  if (inReview(assetId)) return "in Review";
  const shared = libraryDb()
    .prepare(
      `SELECT 1 FROM shares s WHERE s.expires_at > ? AND ((s.target_kind = 'asset' AND s.target_id = ?)
         OR (s.target_kind = 'version' AND s.target_id IN (SELECT id FROM asset_versions WHERE asset_id = ?))
         OR (s.target_kind = 'collection' AND s.target_id IN (SELECT collection_id FROM collection_items WHERE asset_id = ?))) LIMIT 1`,
    )
    .get(now, assetId, assetId, assetId);
  return shared ? "behind a share link" : null;
}

/** Moves an asset into the library's trash (`at` a time) or back out (null): the one writer of assets.trashed_at
 *  besides Empty trash. */
export function setTrashedAt(assetId: string, at: number | null): void {
  // into the trash or back out: no longer only hidden (report.ts, Folders left out)
  libraryDb().prepare("UPDATE assets SET trashed_at = ?, left_hidden_at = NULL WHERE id = ?").run(at, assetId);
}

const inList = (n: number) => Array(n).fill("?").join(", ");

/** Empty trash: deletes every asset in library `libraryId`'s trash that may go now. Returns how many went. */
export async function emptyTrash(libraryId: string): Promise<number> {
  const d = libraryDb();
  let lacking: Set<string> | undefined;
  // an asset with a job running stays: the worker may be writing a derivative for it
  const assets = (
    d
      .prepare(
        `SELECT id FROM assets a WHERE library_id = ? AND trashed_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM jobs j JOIN asset_versions v ON v.id = j.version_id WHERE v.asset_id = a.id AND j.state = 'running')`,
      )
      .all(libraryId) as { id: string }[]
  )
    .map((a) => a.id)
    .filter((id) => !inReview(id))
    // an original a copy still lacks stays until it has it (copies.ts); Stop copying lets it go
    .filter((id, _, all) => !(lacking ??= assetsCopiesLack(all)).has(id));
  // ponytail: 500 at a time keeps the IN lists short
  for (let i = 0; i < assets.length; i += 500) await deleteAssets(assets.slice(i, i + 500));
  return assets.length;
}

/** Finals pieces in the trash longer than PIECE_TRASH_DAYS go for good: the piece, its items and postings (the versions
 *  stay in the library) and its cover file. Returns how many went. */
export async function purgeTrashedPieces(now = Date.now()): Promise<number> {
  const d = libraryDb();
  const pieces = d
    .prepare("SELECT id, cover_key FROM pieces WHERE trashed_at IS NOT NULL AND trashed_at < ? LIMIT 500")
    .all(now - PIECE_TRASH_DAYS * DAY) as { id: string; cover_key: string | null }[];
  if (!pieces.length) return 0;
  // ponytail: one DELETE per piece id; a piece in the trash is rare, so no batching
  for (const p of pieces) d.prepare("DELETE FROM pieces WHERE id = ?").run(p.id);
  for (const p of pieces) if (p.cover_key) await blobs.delete(p.cover_key).catch((e) => console.error("[library] piece purge:", p.cover_key, e));
  return pieces.length;
}

/** Deletes assets for good: every version, derivative, share and file. Review uses it when one of its videos is gone. */
export async function deleteAssets(assets: string[]): Promise<void> {
  if (!assets.length) return;
  const d = libraryDb();
  const A = inList(assets.length);
  const versions = (d.prepare(`SELECT id FROM asset_versions WHERE asset_id IN (${A})`).all(...assets) as { id: string }[]).map((v) => v.id);
  const V = inList(versions.length);
  const keys = versions.length
    ? [
        ...(d.prepare(`SELECT source_key AS k FROM asset_versions WHERE id IN (${V})`).all(...versions) as { k: string }[]),
        ...(d.prepare(`SELECT storage_key AS k FROM derivatives WHERE storage_key IS NOT NULL AND version_id IN (${V})`).all(...versions) as { k: string }[]),
        // an original a computer sent for the copies (copies.ts)
        ...(d.prepare(`SELECT storage_key AS k FROM copy_sends WHERE storage_key IS NOT NULL AND version_id IN (${V})`).all(...versions) as { k: string }[]),
      ].map((r) => r.k)
    : [];
  d.exec("BEGIN");
  try {
    if (versions.length) {
      for (const t of ["derivatives", "descriptions", "transcripts", "embeddings", "pictures", "search_segments", "stretches", "search_stretches", "stretch_notes", "timelines", "search_timeline", "jobs", "version_places", "copy_sends"]) {
        d.prepare(`DELETE FROM ${t} WHERE version_id IN (${V})`).run(...versions);
      }
      d.prepare(`DELETE FROM derived_from WHERE version_id IN (${V}) OR source_version_id IN (${V})`).run(...versions, ...versions);
      d.prepare(`DELETE FROM shares WHERE target_kind = 'version' AND target_id IN (${V})`).run(...versions);
    }
    for (const t of ["collection_items", "asset_tags", "search_assets"]) d.prepare(`DELETE FROM ${t} WHERE asset_id IN (${A})`).run(...assets);
    d.prepare(`DELETE FROM shares WHERE target_kind = 'asset' AND target_id IN (${A})`).run(...assets);
    d.prepare(`DELETE FROM asset_versions WHERE asset_id IN (${A})`).run(...assets);
    d.prepare(`DELETE FROM assets WHERE id IN (${A})`).run(...assets);
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
  // ponytail: files outlive their rows if the process dies here (orphans, no harm), and empty v/<id>/ folders stay;
  // a sweep of unreferenced keys if the disk ever needs it
  // a file indexed on a Mac (on-mac.ts) has no blob here: "mac:<id>" names nothing to delete, and its stills go
  for (const k of keys) if (!k.startsWith("mac:")) await blobs.delete(k).catch((e) => console.error("[library] purge:", k, e));
  for (const k of keys) if (k.startsWith("mac:")) await dropMacFrames(k.slice(4));
}

/**
 * Deletes a library for good (its workspace is being deleted, lib/workspace-delete.ts): every asset as deleteAssets does,
 * its Finals, folders, shares and uploads, then the library. A file indexed in place stays where it is: the library
 * holds only a link to it, and the link goes.
 */
export async function deleteLibrary(id: string): Promise<void> {
  const d = libraryDb();
  await deleteAssets((d.prepare("SELECT id FROM assets WHERE library_id = ?").all(id) as { id: string }[]).map((a) => a.id));
  const covers = (d.prepare("SELECT cover_key AS k FROM pieces WHERE library_id = ? AND cover_key IS NOT NULL").all(id) as { k: string }[]).map((r) => r.k);
  const folders = "SELECT id FROM collections WHERE library_id = ?";
  d.exec("BEGIN");
  try {
    d.prepare("DELETE FROM pieces WHERE library_id = ?").run(id); // their items and postings cascade
    for (const t of ["folder_out", "collection_items", "library_grants"]) d.prepare(`DELETE FROM ${t} WHERE collection_id IN (${folders})`).run(id);
    d.prepare("UPDATE collections SET parent_id = NULL WHERE library_id = ?").run(id);
    for (const t of ["collections", "shares", "uploads", "jobs", "watch_seen", "usage_daily"]) d.prepare(`DELETE FROM ${t} WHERE library_id = ?`).run(id);
    d.prepare("DELETE FROM libraries WHERE id = ?").run(id);
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
  for (const k of covers) await blobs.delete(k).catch((e) => console.error("[library] library delete:", k, e));
  // what is left of its files on this server (empty folders, stills); fs.rm unlinks a link, never what it points to
  await rm(path.join(env.dataDir, "library", "blobs", "libraries", id), { recursive: true, force: true });
}

/** Runs the Finals pieces' purge and the copies' notice now and every hour. */
export function startTrashPurge(): void {
  const run = () => {
    void purgeTrashedPieces().catch((e) => console.error("[library] pieces purge:", e));
    void copiesNotice().catch((e) => console.error("[library] copies notice:", e));
  };
  run();
  setInterval(run, HOUR).unref();
}
