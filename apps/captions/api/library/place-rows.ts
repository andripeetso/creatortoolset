import type { DatabaseSync } from "node:sqlite";
import type { StorageFolder } from "../../contracts/storage";
import { deviceOf } from "../lib/devices";
import { folderFor } from "../lib/storage";
import { libraryDb } from "./db";

/**
 * One original's place row per file on a computer (version_places). The folder scan writes a file's row under its folder
 * (report.ts), the computer's own look (POST …/places) under no folder, and a folder merged into another
 * (devices-storage.ts importStudioFile) left rows under an id that is gone: rows of one version, computer and path are
 * merged into one here.
 */

type PlaceRow = {
  version_id: string;
  device: string;
  kind: string;
  folder_id: string;
  path: string;
  bytes: number | null;
  mtime: number | null;
  quick: string | null;
  sha256: string | null;
  state: string;
  source: string | null;
  confirmed_at: number | null;
  checked_at: number | null;
  verified_at: number | null;
  gone_at: number | null;
};

const latest = (rows: PlaceRow[], k: "confirmed_at" | "checked_at" | "verified_at") =>
  rows.reduce<number | null>((m, r) => (r[k] != null && (m == null || r[k]! > m) ? r[k] : m), null);

/**
 * The one row that rows of the same file become. The newest word stands (a file found gone, or not readable, since), but a
 * "found" never replaces a "verified": the file is the same one. The newest check, and every fingerprint, are kept. Its
 * folder: the newest one not in `dead` (folders merged away), else the newest folder, else none.
 */
export function mergedRow(rows: PlaceRow[], dead: ReadonlySet<string> = new Set()): PlaceRow {
  const byNew = [...rows].sort((a, b) => (b.checked_at ?? 0) - (a.checked_at ?? 0));
  const top = byNew[0]!;
  const w = top.state === "found" ? (byNew.find((r) => r.state === "verified") ?? top) : top;
  const pick = <K extends "bytes" | "mtime" | "quick" | "sha256">(k: K) => w[k] ?? byNew.find((r) => r[k] != null)?.[k] ?? null;
  const foldered = byNew.filter((r) => r.folder_id);
  return {
    ...w,
    folder_id: (foldered.find((r) => !dead.has(r.folder_id)) ?? foldered[0])?.folder_id ?? "",
    bytes: pick("bytes"),
    mtime: pick("mtime"),
    quick: pick("quick"),
    sha256: pick("sha256"),
    confirmed_at: latest(rows, "confirmed_at"),
    checked_at: latest(rows, "checked_at"),
    verified_at: latest(rows, "verified_at"),
    gone_at: w.state === "gone" ? w.gone_at : null,
  };
}

/** Computer `device`'s original rows of version `versionId` that are the same file, merged into one (mergedRow). Returns the rows removed. */
export function mergeSamePath(versionId: string, device: string, dead?: ReadonlySet<string>, d: DatabaseSync = libraryDb()): number {
  const rows = d.prepare("SELECT * FROM version_places WHERE version_id = ? AND device = ? AND kind = 'original'").all(versionId, device) as unknown as PlaceRow[];
  const groups = new Map<string, PlaceRow[]>();
  for (const r of rows) groups.set(r.path, [...(groups.get(r.path) ?? []), r]);
  let removed = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const m = mergedRow(group, dead);
    d.exec("SAVEPOINT merge_places");
    try {
      const del = d.prepare("DELETE FROM version_places WHERE version_id = ? AND device = ? AND kind = 'original' AND folder_id = ?");
      for (const r of group) del.run(r.version_id, r.device, r.folder_id);
      d.prepare(
        `INSERT INTO version_places (version_id, device, kind, folder_id, path, bytes, mtime, quick, sha256, state, source, confirmed_at, checked_at, verified_at, gone_at)
         VALUES (?, ?, 'original', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(m.version_id, m.device, m.folder_id, m.path, m.bytes, m.mtime, m.quick, m.sha256, m.state, m.source, m.confirmed_at, m.checked_at, m.verified_at, m.gone_at);
      d.exec("RELEASE merge_places");
    } catch (e) {
      d.exec("ROLLBACK TO merge_places");
      d.exec("RELEASE merge_places");
      throw e;
    }
    removed += group.length - 1;
  }
  return removed;
}

/** Folders merged into others (old id → kept id): their place rows move to the kept id, and a file the kept folder already had a row for is merged into it. Returns the rows moved or merged. */
export function repointFolders(ids: Map<string, string>, d: DatabaseSync = libraryDb()): number {
  let n = 0;
  for (const [old, kept] of ids) {
    if (old === kept) continue;
    n += Number(d.prepare("UPDATE OR IGNORE version_places SET folder_id = ? WHERE folder_id = ?").run(kept, old).changes);
    const left = d.prepare("SELECT DISTINCT version_id, device FROM version_places WHERE folder_id = ?").all(old) as { version_id: string; device: string }[];
    for (const r of left) n += mergeSamePath(r.version_id, r.device, new Set([old]), d);
  }
  return n;
}

/**
 * The fix-up at every boot (boot.ts); a second run finds nothing to do. A row whose folder is not in its computer's
 * owner's Settings → Folders list moves to the folder there that holds its path, and the rows of one file on one computer
 * become one (mergedRow). A computer the server does not know, an owner with no folders, or a path no folder holds is left
 * as it is. Files are never touched.
 */
export function fixPlaceRows(foldersOf: (owner: string) => StorageFolder[], d: DatabaseSync = libraryDb()): { merged: number; repointed: number } {
  const lists = new Map<string, StorageFolder[] | null>();
  const listOf = (device: string) => {
    if (!lists.has(device)) {
      const owner = deviceOf(device)?.owner;
      const folders = owner ? foldersOf(owner) : [];
      lists.set(device, folders.length ? folders : null);
    }
    return lists.get(device)!;
  };
  const dead = new Set<string>();
  let repointed = 0;
  const rows = d.prepare("SELECT version_id, device, folder_id, path FROM version_places WHERE kind = 'original' AND folder_id <> ''").all() as { version_id: string; device: string; folder_id: string; path: string }[];
  for (const r of rows) {
    const folders = listOf(r.device);
    if (!folders || folders.some((f) => f.id === r.folder_id)) continue;
    dead.add(r.folder_id);
    const live = folderFor(r.path, folders, r.device)?.folder.id;
    if (live)
      repointed += Number(d.prepare("UPDATE OR IGNORE version_places SET folder_id = ? WHERE version_id = ? AND device = ? AND kind = 'original' AND folder_id = ?").run(live, r.version_id, r.device, r.folder_id).changes);
  }
  let merged = 0;
  const dups = d.prepare("SELECT DISTINCT version_id, device FROM version_places WHERE kind = 'original' GROUP BY version_id, device, path HAVING count(*) > 1").all() as { version_id: string; device: string }[];
  for (const r of dups) merged += mergeSamePath(r.version_id, r.device, dead, d);
  return { merged, repointed };
}
