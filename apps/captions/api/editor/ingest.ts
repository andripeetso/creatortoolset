import { randomUUID } from "node:crypto";
import type { FootageTarget } from "../../contracts/editor";
import { homeOf, libraryRole } from "../library/access";
import { libraryDb } from "../library/db";
import { pluginFootageTarget } from "../lib/plugin";

/** The folder footage picked from this computer is filed in: the talking takes an edit is built on (A-roll). */
export const A_ROLL = "A-roll";

/**
 * Where footage added to an edit from outside the library is filed: a plug-in's target when one answers (editor.ingest),
 * else the account's own library's A-roll folder, made on first use. Null when the account has no library it may write to.
 */
export async function footageTargetFor(username: string): Promise<FootageTarget | null> {
  const plugin = await pluginFootageTarget(username);
  if (plugin) return plugin;
  const d = libraryDb();
  const lib = d.prepare("SELECT id FROM libraries WHERE workspace_id = ? ORDER BY created_at, id LIMIT 1").get(homeOf(username)) as
    | { id: string }
    | undefined;
  if (!lib || !libraryRole(username, lib.id)) return null;
  const found = d
    .prepare("SELECT id FROM collections WHERE library_id = ? AND kind = 'manual' AND parent_id IS NULL AND name = ?")
    .get(lib.id, A_ROLL) as { id: string } | undefined;
  if (found) return { libraryId: lib.id, collectionId: found.id };
  // ponytail: two first-time requests at once can make two A-roll folders; add a unique index when that shows up
  const id = `col_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  d.prepare("INSERT INTO collections (id, library_id, parent_id, name, kind, query, created_at, created_by) VALUES (?, ?, NULL, ?, 'manual', NULL, ?, ?)").run(
    id,
    lib.id,
    A_ROLL,
    Date.now(),
    username,
  );
  return { libraryId: lib.id, collectionId: id };
}
