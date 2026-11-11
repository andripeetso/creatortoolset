import { Hono } from "hono";
import type { LibraryProgress, WatchStatus } from "../../contracts/library";
import type { AuthVars } from "../auth";
import type { SessionUser } from "../users";
import { homeOf } from "./access";
import { libraryDb } from "./db";
import { progress } from "./estimate";
import { watchApp } from "./watch";

/**
 * What each of an account's libraries is doing, for Home's list and the Mac's menu bar (api/activity.ts). Read only.
 * `folders`: its watch folders' files and how many are still to be taken in (watch.ts keeps those in memory, so they are
 * read through its own route, as the account). `uploading`: this account's uploads that took a part in the last two
 * minutes. ponytail: a bucket library's uploads go straight to the bucket and are not counted.
 */
export interface LibraryWork {
  id: string;
  progress: LibraryProgress;
  folders: { path: string; files: number; adding: number }[];
  uploading: { files: number; received: number; size: number } | null;
}

const RECENT_MS = 2 * 60_000;
// ponytail: routes.ts STAGE_DAYS: each part moves an upload's expiry this far ahead, so the expiry says when it last moved
const STAGE_MS = 7 * 86_400_000;

async function watchOf(user: SessionUser, libraryId: string): Promise<WatchStatus["folders"]> {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use(async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route("/", watchApp);
  const r = await app.request(`/${libraryId}/watch`);
  return r.ok ? ((await r.json()) as WatchStatus).folders : [];
}

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
      const folders = (await watchOf(user, id)).map(({ path, files, adding }) => ({ path, files, adding }));
      return { id, progress: await progress(id, user.username), folders, uploading: up.files ? { ...up } : null };
    }),
  );
}
