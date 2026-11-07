import { readFileSync } from "node:fs";
import path from "node:path";
import { env } from "../lib/env";
import { findUser, mayUse } from "../users";
import { blobs, libraryDb } from "./db";

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
 * A version's original as a local file, for an account that may still read its library, while the asset is out of the
 * trash. Null otherwise. Caption Studio reads a clip's source through this when the clip came from the library.
 */
export async function versionSource(username: string, versionId: string): Promise<string | null> {
  const v = libraryDb()
    .prepare("SELECT a.library_id, v.source_key FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ? AND a.trashed_at IS NULL")
    .get(versionId) as { library_id: string; source_key: string } | undefined;
  if (!v || !libraryRole(username, v.library_id)) return null;
  return blobs.localCopy(v.source_key).catch(() => null);
}
