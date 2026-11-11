import type { LibraryProgress } from "../../contracts/library";
import type { SessionUser } from "../users";
import { homeOf } from "./access";
import { libraryDb } from "./db";
import { progress } from "./estimate";

/**
 * What each of an account's libraries is doing, for Home's list and the Mac's menu bar (api/activity.ts). Read only.
 * `progress`: the library page's own numbers, a watch folder's clips still to come among them. `uploading`: this
 * account's uploads that took a part in the last two minutes. ponytail: a bucket library's uploads go straight to the
 * bucket and are not counted.
 */
export interface LibraryWork {
  id: string;
  progress: LibraryProgress;
  uploading: { files: number; received: number; size: number } | null;
}

const RECENT_MS = 2 * 60_000;
// ponytail: routes.ts STAGE_DAYS: each part moves an upload's expiry this far ahead, so the expiry says when it last moved
const STAGE_MS = 7 * 86_400_000;

export async function libraryWork(user: SessionUser, now = Date.now()): Promise<LibraryWork[]> {
  const db = libraryDb();
  const ids = db.prepare("SELECT id FROM libraries WHERE workspace_id = ? ORDER BY created_at, id").all(homeOf(user.username)) as { id: string }[];
  return Promise.all(
    ids.map(async ({ id }) => {
      const up = db
        .prepare(
          `SELECT COUNT(*) AS files, COALESCE(SUM(received), 0) AS received, COALESCE(SUM(size), 0) AS size FROM uploads
           WHERE library_id = ? AND created_by = ? AND state = 'open' AND direct_upload_id IS NULL AND expires_at > ?`,
        )
        .get(id, user.username, now + STAGE_MS - RECENT_MS) as { files: number; received: number; size: number };
      // the library page's own numbers (estimate.ts progress), so Home and the Activity list say the same
      return { id, progress: await progress(id, user.username), uploading: up.files ? { ...up } : null };
    }),
  );
}
