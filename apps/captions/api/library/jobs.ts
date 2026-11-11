import type { DatabaseSync } from "node:sqlite";

/**
 * The library's job queue (tasks/media-library-plan.md, section 5): one row per (version, kind) in `jobs`.
 * Claim takes a lease; an expired lease goes back to the queue; a failure waits 60 s × attempts; three
 * failures mark the job failed (shown on the card with Retry). Every function takes `now` so tests need no clock.
 * The AI Editor's queue is the same shape in `edit_jobs` (schema.ts migration 4): each function takes the table last.
 */

export const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 60_000;

/** The tables these functions run on: interpolated into SQL, so never a free string. */
export type JobTable = "jobs" | "edit_jobs";

export interface JobRow {
  id: number;
  library_id: string;
  version_id: string | null;
  kind: string;
  state: "queued" | "running" | "done" | "failed" | "needs_key";
  attempts: number;
  run_after: number;
  lease_until: number | null;
  actor: string | null;
  error: string | null;
  started_at?: number | null;
  done_at?: number | null;
}

/**
 * Queues a job. A job already queued, running or done stays as it is; a failed or needs_key one is queued again from
 * zero. `again` queues a done one too: its input changed (a new transcript to embed, a describe someone asked for again).
 */
export function enqueueJob(db: DatabaseSync, libraryId: string, versionId: string, kind: string, actor: string | null, again = false, table: JobTable = "jobs"): void {
  db.prepare(
    `INSERT INTO ${table} (library_id, version_id, kind, state, actor) VALUES (?, ?, ?, 'queued', ?)
     ON CONFLICT (version_id, kind) DO UPDATE SET state = 'queued', attempts = 0, run_after = 0,
       lease_until = NULL, error = NULL, actor = excluded.actor
     WHERE ${table}.state IN ('failed', 'needs_key'${again ? ", 'done'" : ""})`,
  ).run(libraryId, versionId, kind, actor);
}

/**
 * Takes the oldest queued job that may run now (of `kinds`, when given; job `id`, when given and still queued), leases
 * it, counts the attempt and stamps when it started. Null when there is none.
 */
export function claimJob(db: DatabaseSync, leaseSeconds = 300, now = Date.now(), table: JobTable = "jobs", kinds?: readonly string[], id?: number): JobRow | null {
  const only = kinds?.length ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : "";
  const pick = id === undefined ? `(SELECT id FROM ${table} WHERE state = 'queued' AND run_after <= ?${only} ORDER BY id LIMIT 1)` : "? AND state = 'queued'";
  return (
    (db
      .prepare(
        `UPDATE ${table} SET state = 'running', lease_until = ?, attempts = attempts + 1, started_at = ?
         WHERE id = ${pick}
         RETURNING *`,
      )
      .get(now + leaseSeconds * 1000, now, ...(id === undefined ? [now, ...(kinds ?? [])] : [id])) as JobRow | undefined) ?? null
  );
}

/** Libraries whose watch folders are handing clips over right now (watch.ts): their slower steps wait (worker.ts). */
export const takingClips = new Set<string>();

/** What the last walk of each watch folder found, by `${libraryId}\0${folder}` (watch.ts writes it): its media files and how many are still to be taken in. */
export const folderWalks = new Map<string, { files: number; adding: number }>();

/** Clips a library's watch folders have found and not yet taken in (estimate.ts counts them among the clips being prepared). */
export function stillToCome(libraryId: string): number {
  let n = 0;
  for (const [k, w] of folderWalks) if (k.startsWith(`${libraryId}\0`)) n += w.adding;
  return n;
}

// clips someone waits on (the person opened one, an AI Editor edit needs it), newest last: their steps go first (worker.ts)
const waitedOn = new Map<string, number>();
const WAITED_MS = 10 * 60_000;

/** Someone waits on this clip: for ten minutes its picture goes before the other pictures, and its slow steps before the other slow steps. */
export function prepareFirst(versionId: string, now = Date.now()): void {
  waitedOn.delete(versionId);
  waitedOn.set(versionId, now);
  for (const [v, at] of waitedOn) if (now - at > WAITED_MS || waitedOn.size > 100) waitedOn.delete(v);
}

/** The clips prepareFirst named in the last ten minutes. */
export const firstClips = (now = Date.now()): string[] => [...waitedOn].filter(([, at]) => now - at <= WAITED_MS).map(([v]) => v);

/** Records the outcome of a claimed job: done, back in the queue after a backoff, or failed after MAX_ATTEMPTS. */
export function finishJob(db: DatabaseSync, id: number, ok: boolean, error?: string, now = Date.now(), table: JobTable = "jobs"): void {
  if (ok) {
    db.prepare(`UPDATE ${table} SET state = 'done', lease_until = NULL, error = NULL, done_at = ? WHERE id = ?`).run(now, id);
    return;
  }
  const { attempts } = db.prepare(`SELECT attempts FROM ${table} WHERE id = ?`).get(id) as { attempts: number };
  if (attempts >= MAX_ATTEMPTS) {
    db.prepare(`UPDATE ${table} SET state = 'failed', lease_until = NULL, error = ? WHERE id = ?`).run(error ?? "failed", id);
  } else {
    db.prepare(`UPDATE ${table} SET state = 'queued', lease_until = NULL, error = ?, run_after = ? WHERE id = ?`).run(
      error ?? "failed",
      now + BACKOFF_MS * attempts,
      id,
    );
  }
}

/** Puts running jobs whose lease ran out back in the queue (or fails them after MAX_ATTEMPTS). Returns how many. */
export function requeueExpired(db: DatabaseSync, now = Date.now(), table: JobTable = "jobs"): number {
  return Number(
    db
      .prepare(
        `UPDATE ${table} SET state = CASE WHEN attempts >= ? THEN 'failed' ELSE 'queued' END,
           error = CASE WHEN attempts >= ? THEN 'lease expired' ELSE error END, lease_until = NULL
         WHERE state = 'running' AND lease_until < ?`,
      )
      .run(MAX_ATTEMPTS, MAX_ATTEMPTS, now).changes,
  );
}

/** A claimed job its actor has no key or AI route for: parked as needs_key (not failed) until someone queues it again. */
export function parkJob(db: DatabaseSync, id: number, why: string, table: JobTable = "jobs"): void {
  db.prepare(`UPDATE ${table} SET state = 'needs_key', lease_until = NULL, error = ? WHERE id = ?`).run(why, id);
}

/** A long step's heartbeat: a running job's lease runs `seconds` from now, so requeueExpired leaves it alone. */
export function extendLease(db: DatabaseSync, id: number, seconds: number, now = Date.now(), table: JobTable = "jobs"): void {
  db.prepare(`UPDATE ${table} SET lease_until = ? WHERE id = ? AND state = 'running'`).run(now + seconds * 1000, id);
}

/** A claimed job that waits on something else (a transcript): back in the queue after `seconds`, the attempt not counted. */
export function defer(db: DatabaseSync, id: number, seconds: number, now = Date.now(), table: JobTable = "jobs"): void {
  db.prepare(`UPDATE ${table} SET state = 'queued', lease_until = NULL, attempts = MAX(attempts - 1, 0), run_after = ? WHERE id = ?`).run(
    now + seconds * 1000,
    id,
  );
}
