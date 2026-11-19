import { libraryDb, uploadOf } from "./db";
import { hasMembers } from "./upload-gate";

/** One change the migration makes, or in a dry run would make. */
export interface MigrationChange {
  libraryId: string;
  field: "setupAt" | "upload";
  from: unknown;
  to: string;
}

/**
 * The library rules of the one-time migration (UNIFIED-PRD §4.6, items 3 and 4): a library that already has clips is set up
 * (nobody who works today sees setup), and a library shared with members that keeps no Hosted media takes the team's
 * proxies (upload → proxies). Idempotent: a second run changes nothing. `dryRun` lists every change and writes none.
 * shortcut: the folder rows (items 1, 2), the Finals watch split, and server rendering (item 5) are not migrated here yet.
 */
export async function migrateLibraries(opts: { dryRun?: boolean; now?: string } = {}): Promise<MigrationChange[]> {
  const db = libraryDb();
  const rows = db
    .prepare(
      `SELECT l.id, json_extract(l.settings, '$.setupAt') AS setupAt, json_extract(l.settings, '$.upload') AS upload,
         EXISTS (SELECT 1 FROM assets a WHERE a.library_id = l.id) AS hasClips
       FROM libraries l`,
    )
    .all() as { id: string; setupAt: string | null; upload: unknown; hasClips: number }[];
  const changes: MigrationChange[] = [];
  for (const r of rows) {
    if (r.setupAt == null && r.hasClips) changes.push({ libraryId: r.id, field: "setupAt", from: null, to: opts.now ?? new Date().toISOString() });
    // a legacy false, an unset or "none" Upload all read as none (db.ts uploadOf), so a shared one with no Hosted media is one of these
    if (uploadOf(r.upload) === "none" && (await hasMembers(r.id))) changes.push({ libraryId: r.id, field: "upload", from: r.upload, to: "proxies" });
  }
  if (!opts.dryRun)
    for (const c of changes)
      db.prepare(`UPDATE libraries SET settings = json_set(settings, '$.${c.field}', ?) WHERE id = ?`).run(c.to, c.libraryId);
  return changes;
}
