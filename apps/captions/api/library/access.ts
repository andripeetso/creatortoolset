import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { env } from "../lib/env";
import { announce } from "../lib/sync";
import { findUser, listUsers, LOCAL_USER, mayUse } from "../users";
import { blobs, libraryDb } from "./db";
import { assetRef, canSee } from "./sources";

let before: Record<string, string> | null = null;
/**
 * The id an account's libraries (libraries.workspace_id) and AI Editor edits (workspaceId) carry: its username. An
 * install from before keeps the id it already had: the one in $DATA_DIR/workspaces.json it owned (read once).
 */
export function homeOf(username: string): string {
  if (!before) {
    before = {};
    try {
      const s = JSON.parse(readFileSync(path.join(env.dataDir, "workspaces.json"), "utf-8")) as { workspaces?: { id: string; members: { username: string; role: string }[] }[] };
      for (const w of s.workspaces ?? []) for (const m of w.members) if (m.role === "owner") before[m.username] ??= w.id;
    } catch {
      /* a fresh install */
    }
  }
  return before[username] ?? username;
}

/**
 * Tells the library's account that it changed, for a save outside a request (the worker, a watch folder): its open
 * Media Library and Finals pages refetch (api/lib/sync.ts). A request's own write is announced already.
 */
export function libraryChanged(libraryId: string): void {
  const row = libraryDb().prepare("SELECT workspace_id FROM libraries WHERE id = ?").get(libraryId) as { workspace_id: string } | undefined;
  if (!row) return;
  const accounts = [...listUsers().map((u) => u.username), LOCAL_USER.username];
  announce(accounts.find((u) => homeOf(u) === row.workspace_id) ?? row.workspace_id, "library");
}

/**
 * The account's own local library, made silently the first time something needs one (Finals, the Home readiness, the
 * Media Library): "Library". Nothing when it has one already or may not use the Media Library.
 */
export function ensureLibrary(username: string): void {
  const account = findUser(username);
  if (account && !mayUse(account, "media")) return;
  const home = homeOf(username);
  if (libraryDb().prepare("SELECT 1 FROM libraries WHERE workspace_id = ? LIMIT 1").get(home)) return;
  libraryDb()
    .prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES (?, ?, 'Library', 'local', ?)")
    .run(`lib_${randomUUID().replace(/-/g, "").slice(0, 16)}`, home, Date.now());
}

/**
 * "owner" when the library is the account's own (homeOf), else null: a library of another account, or one that does
 * not exist, so callers answer 404, never 403. An account with the Media Library switched off is null too: the
 * Workshop, the Video Cleaner and exports read the library through here, outside the /api/library tool gate (boot.ts).
 */
export function libraryRole(username: string, libraryId: string): "owner" | null {
  const account = findUser(username);
  if (account && !mayUse(account, "media")) return null;
  const row = libraryDb().prepare("SELECT workspace_id FROM libraries WHERE id = ?").get(libraryId) as
    | { workspace_id: string }
    | undefined;
  return row && row.workspace_id === homeOf(username) ? "owner" : null;
}

/**
 * Whether the account may change this version of the library: its library role, and the policies may see the asset
 * (sources.ts). Writes to assets, collection membership and pieces ask here, so a narrowing policy holds for writes too,
 * not only for reads. A share link's creation asks visibleCards instead (shares.ts).
 */
export async function mayWrite(username: string, libraryId: string, assetId: string, versionId: string): Promise<boolean> {
  const role = libraryRole(username, libraryId);
  return !!role && (await canSee({ username, role }, assetRef(libraryId, assetId, versionId)));
}

/**
 * A version's original as a local file, for an account that may still read its library, while the asset is out of the
 * trash. Null otherwise. Caption Studio reads a clip's source through this when the clip came from the library.
 */
export async function versionSource(username: string, versionId: string): Promise<string | null> {
  const v = libraryDb()
    .prepare("SELECT a.id AS asset_id, a.library_id, v.source_key FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ? AND a.trashed_at IS NULL")
    .get(versionId) as { asset_id: string; library_id: string; source_key: string } | undefined;
  const role = v ? libraryRole(username, v.library_id) : null;
  if (!v || !role || !(await canSee({ username, role }, assetRef(v.library_id, v.asset_id, versionId)))) return null;
  return blobs.localCopy(v.source_key).catch(() => null);
}
