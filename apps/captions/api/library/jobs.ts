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

/** Takes the oldest queued job that may run now, leases it, and counts the attempt. Null when there is none. */
export function claimJob(db: DatabaseSync, leaseSeconds = 300, now = Date.now(), table: JobTable = "jobs"): JobRow | null {
  return (
    (db
      .prepare(
        `UPDATE ${table} SET state = 'running', lease_until = ?, attempts = attempts + 1
         WHERE id = (SELECT id FROM ${table} WHERE state = 'queued' AND run_after <= ? ORDER BY id LIMIT 1)
         RETURNING *`,
      )
      .get(now + leaseSeconds * 1000, now) as JobRow | undefined) ?? null
  );
}

/** Records the outcome of a claimed job: done, back in the queue after a backoff, or failed after MAX_ATTEMPTS. */
export function finishJob(db: DatabaseSync, id: number, ok: boolean, error?: string, now = Date.now(), table: JobTable = "jobs"): void {
  if (ok) {
    db.prepare(`UPDATE ${table} SET state = 'done', lease_until = NULL, error = NULL WHERE id = ?`).run(id);
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
