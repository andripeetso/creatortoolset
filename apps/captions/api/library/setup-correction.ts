import type { LibrarySettings } from "../../contracts/library";
import { ownedProjects } from "../lib/workshop/workspace";
import { workspaceById } from "../lib/workspaces";
import { accountOf } from "./access";
import { libraryDb } from "./db";
import { listOf, markedAt, ownRow } from "./migrate";

/**
 * The 11-19 correction: the one-time migration (§4.6 item 3) took any folder row shared with every workspace as a sign
 * that each workspace's library was set up, so new workspaces skipped setup. A library loses its setupAt here only when
 * all of these hold: its setupAt is the migration's own stamp; it has no clips, no watch folders and no folder row of its
 * own workspace (migrate.ts ownRow); and nothing a setup or the owner page writes is in its settings (a Done would have
 * saved these). Dry run unless `write`.
 */
export interface CorrectionRow {
  id: string;
  projectId: string | null;
  workspace: string | null;
  setupAt: string | null;
  clips: number;
  ownFolders: number;
  /** cleared (or would be, in a dry run); else why it is kept */
  action: "clear" | string;
}

/** Keys only a setup's Done or the owner page write: one present means a person answered, so the setup stays. */
const ANSWER_KEYS: readonly (keyof LibrarySettings)[] = ["importMode", "defaultFolders", "proxyQuality"];

export async function correctSetups(opts: { write?: boolean } = {}): Promise<{ stamp: string | null; rows: CorrectionRow[] }> {
  const stamp = markedAt() ?? null;
  const d = libraryDb();
  const libs = d
    .prepare("SELECT l.id, l.workspace_id AS home, COALESCE(l.settings, '{}') AS settings, (SELECT COUNT(*) FROM assets a WHERE a.library_id = l.id) AS clips FROM libraries l ORDER BY l.created_at, l.id")
    .all() as { id: string; home: string; settings: string; clips: number }[];
  const lists = new Map<string, Awaited<ReturnType<typeof listOf>>>();
  const rows: CorrectionRow[] = [];
  for (const l of libs) {
    const s = JSON.parse(l.settings) as Partial<LibrarySettings> & { projectId?: string; watch?: unknown[] };
    const account = accountOf(l.home) ?? l.home;
    if (!lists.has(account)) lists.set(account, await listOf(account));
    const ownFolders = lists.get(account)!.filter((f) => ownRow(f, s.projectId)).length;
    const setupAt = typeof s.setupAt === "string" ? s.setupAt : null;
    const why =
      !setupAt ? "not set up"
      : !stamp || setupAt !== stamp ? "set up by a Done or a plug-in, not the migration"
      : l.clips > 0 ? "has clips"
      : (s.watch?.length ?? 0) > 0 ? "has watch folders"
      : ownFolders > 0 ? "has folder rows of its own workspace"
      : ANSWER_KEYS.some((k) => s[k] !== undefined) ? "has setup answers saved"
      : null;
    rows.push({ id: l.id, projectId: s.projectId ?? null, workspace: s.projectId ? (workspaceById(s.projectId)?.name ?? (await ownedProjects(account)).find((p) => p.id === s.projectId)?.name ?? null) : null, setupAt, clips: l.clips, ownFolders, action: why ?? "clear" });
    // the same stamp in the WHERE: a Done between the dry run and the write keeps its setup
    if (!why && opts.write) d.prepare("UPDATE libraries SET settings = json_remove(settings, '$.setupAt') WHERE id = ? AND json_extract(settings, '$.setupAt') = ?").run(l.id, stamp);
  }
  return { stamp, rows };
}
