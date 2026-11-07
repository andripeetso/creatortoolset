import { memberIn, workspaceById } from "../lib/workspaces";
import type { WorkspaceRole } from "../../contracts/workspaces";
import { blobs, libraryDb } from "./db";

/**
 * What an account may do in a library: its role in the library's workspace (contracts/workspaces.ts), or null.
 * A library in another workspace, or one that does not exist, is null too: callers answer 404, never 403.
 * Owner manages libraries, storage, keys and shares; member uploads and edits their own assets.
 */
export function libraryRole(username: string, libraryId: string): WorkspaceRole | null {
  const row = libraryDb().prepare("SELECT workspace_id FROM libraries WHERE id = ?").get(libraryId) as
    | { workspace_id: string }
    | undefined;
  if (!row) return null;
  const w = workspaceById(row.workspace_id);
  return (w && memberIn(w, username)?.role) || null;
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
