import { memberIn, workspaceById } from "../lib/workspaces";
import type { WorkspaceRole } from "../../contracts/workspaces";
import { libraryDb } from "./db";

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
