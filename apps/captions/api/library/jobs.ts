import type { DatabaseSync } from "node:sqlite";
import { move, type Moves } from "../../contracts/transition";

/**
 * The library's job queue (tasks/media-library-plan.md, section 5): one row per (version, kind) in `jobs`.
 * Claim takes a lease; an expired lease goes back to the queue; a failure waits 60 s × attempts; three
 * failures mark the job failed (shown on the card with Retry). Every function takes `now` so tests need no clock.
 * The AI Editor's queue is the same shape in `edit_jobs` (schema.ts migration 4): each function takes the table last.
 */

export const MAX_ATTEMPTS = 3;

/** What a job left by the switch says while it waits: one a computer takes, or one only a server with video work on runs (worker.ts leftToComputers). */
export const WAITS_FOR_COMPUTER = "Waits for one of your computers. Open Creator Toolset on your Mac";
export const WAITS_FOR_SERVER = "Video work is off on this server";

/** SQL: job `j`'s clip is out of the trash and not hidden while it waits on Folders left out (report.ts). Such a clip's
 *  jobs wait queued, for this server and every computer (no AI spent on it), and run again if it is restored or shown.
 *  Its own `v` and `a` aliases stay inside the subquery. */
export const NOT_TRASHED =
  "NOT EXISTS (SELECT 1 FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = j.version_id AND (a.trashed_at IS NOT NULL OR a.left_hidden_at IS NOT NULL))";
const BACKOFF_MS = 60_000;

/** The tables these functions run on: interpolated into SQL, so never a free string. */
export type JobTable = "jobs" | "edit_jobs";

export type JobState = "queued" | "running" | "done" | "failed" | "needs_key";

/** The moves between job states, for both tables. Each UPDATE names the state it expects in its WHERE, and a JS-chosen state is checked here. */
export const JOB_MOVES: Moves<JobState> = {
  queued: ["running", "failed"], // claimed; stopped (stopEdit, failUnseen)
  running: ["done", "queued", "failed", "needs_key"], // finished, tried again, lease ran out, parked, failed for good
  done: ["queued"], // queued again (enqueueJob's `again`)
  failed: ["queued", "done"], // Retry; done when the output is there already (enqueueJob)
  needs_key: ["queued", "done", "failed", "running"], // queued again, taken by the Mac (mac-look), failed once unseen
};

export interface JobRow {
  id: number;
  library_id: string;
  version_id: string | null;
  kind: string;
  state: JobState;
  attempts: number;
  run_after: number;
  lease_until: number | null;
  /** the computer that holds it and its claim (library jobs only, work/library-package.ts); stale once not running */
  held_by?: string | null;
  claim_id?: string | null;
  actor: string | null;
  error: string | null;
  started_at?: number | null;
  done_at?: number | null;
}

/** SQL (one `?`: the version): the version has what job `kind` makes. Only kinds whose output is whole once there. */
const HAVE: Record<string, string> = {
  ...Object.fromEntries(["thumb", "sprite", "wave", "fingerprint", "proxy"].map((k) => [k, `SELECT 1 FROM derivatives WHERE version_id = ? AND kind = '${k}'`])),
  transcribe: "SELECT 1 FROM transcripts WHERE version_id = ?",
  describe: "SELECT 1 FROM descriptions WHERE version_id = ?",
};

/**
 * Queues a job. A job already queued, running or done stays as it is; a failed or needs_key one is queued again from
 * zero. A version that has what the job makes (HAVE) gets it marked done instead. `again` queues a done one too: its input changed (a new transcript to embed, a describe someone asked for again).
 */
export function enqueueJob(db: DatabaseSync, libraryId: string, versionId: string, kind: string, actor: string | null, again = false, table: JobTable = "jobs"): void {
  // a file that has it already (made before, or brought in with it: an archive's transcripts and descriptions) is never
  // made again unasked, whatever the switches say: its job reads done. `again` is an ask by name or a changed input.
  const have = table === "jobs" && !again ? HAVE[kind] : undefined;
  if (have && db.prepare(have).get(versionId)) {
    db.prepare(
      `INSERT INTO jobs (library_id, version_id, kind, state, actor, done_at) VALUES (?, ?, ?, 'done', ?, ?)
       ON CONFLICT (version_id, kind) DO UPDATE SET state = 'done', lease_until = NULL, error = NULL WHERE jobs.state IN ('failed', 'needs_key')`,
    ).run(libraryId, versionId, kind, actor, Date.now());
    return;
  }
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
        `UPDATE ${table} SET state = 'running', lease_until = ?, attempts = attempts + 1, started_at = ?${table === "jobs" ? ", held_by = NULL, claim_id = NULL" : ""}
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

/**
 * The folders each library's watch walks, by library id: its Source media rows on this computer and its Finals folders
 * (watch.ts sets it on every pass). A folder taken off the list is not in it, so it stops counting at once.
 */
export const watchedFolders = new Map<string, Set<string>>();

/** Clips a library's watch folders have found and not yet taken in (estimate.ts counts them among the clips being prepared). */
export function stillToCome(_db: DatabaseSync, libraryId: string): number {
  const listed = watchedFolders.get(libraryId) ?? new Set<string>();
  let n = 0;
  for (const [k, w] of folderWalks) if (k.startsWith(`${libraryId}\0`) && listed.has(k.slice(libraryId.length + 1))) n += w.adding;
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

/**
 * Records the outcome of a claimed job: done, back in the queue after a backoff, or failed after MAX_ATTEMPTS.
 * A try that did not work, a park and a defer change only a job that is still running: one stopped, removed or taken
 * back while its step was out stays as it is (a late answer never puts a stopped job back in the queue).
 */
export function finishJob(db: DatabaseSync, id: number, ok: boolean, error?: string, now = Date.now(), table: JobTable = "jobs"): void {
  if (ok) {
    db.prepare(`UPDATE ${table} SET state = 'done', lease_until = NULL, error = NULL, done_at = ? WHERE id = ? AND state = 'running'`).run(now, id);
    return;
  }
  // the next state is chosen here (checked against JOB_MOVES); the read and the write are one synchronous run, so nothing moves the row between them
  const row = db.prepare(`SELECT attempts, run_after FROM ${table} WHERE id = ? AND state = 'running'`).get(id) as Pick<JobRow, "attempts" | "run_after"> | undefined;
  if (!row) return;
  const to = move(JOB_MOVES, "running", row.attempts >= MAX_ATTEMPTS ? "failed" : "queued", `${table} job ${id}`);
  db.prepare(`UPDATE ${table} SET state = ?, lease_until = NULL, error = ?, run_after = ? WHERE id = ? AND state = 'running'`).run(
    to,
    error ?? "failed",
    to === "failed" ? row.run_after : now + BACKOFF_MS * row.attempts,
    id,
  );
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

/**
 * At this server's start: each library job a computer holds gets a whole lease from now. The computer kept working
 * while the server was away and its next beat renews the lease, so a restart costs no try; only a real silence of the
 * lease's length puts the job back (requeueExpired). Returns how many.
 */
export function graceHeld(db: DatabaseSync, seconds: number, now = Date.now()): number {
  return Number(db.prepare("UPDATE jobs SET lease_until = MAX(COALESCE(lease_until, 0), ?) WHERE state = 'running' AND held_by IS NOT NULL").run(now + seconds * 1000).changes);
}

/** A claimed job its actor has no key or AI route for: parked as needs_key (not failed) until someone queues it again. */
export function parkJob(db: DatabaseSync, id: number, why: string, table: JobTable = "jobs"): void {
  db.prepare(`UPDATE ${table} SET state = 'needs_key', lease_until = NULL, error = ? WHERE id = ? AND state = 'running'`).run(why, id);
}

/** The AI Editor's job row (edit_jobs) this device holds (claimed by it and still running), or undefined. */
export const heldBy = (db: DatabaseSync, id: number, device: string): JobRow | undefined =>
  db.prepare("SELECT * FROM edit_jobs WHERE id = ? AND device = ? AND state = 'running'").get(id, device) as JobRow | undefined;

/** A long step's heartbeat: a running job's lease runs `seconds` from now, so requeueExpired leaves it alone. */
export function extendLease(db: DatabaseSync, id: number, seconds: number, now = Date.now(), table: JobTable = "jobs"): void {
  db.prepare(`UPDATE ${table} SET lease_until = ? WHERE id = ? AND state = 'running'`).run(now + seconds * 1000, id);
}

/** A claimed job that waits on something else (a transcript): back in the queue after `seconds`, the attempt not counted. */
export function defer(db: DatabaseSync, id: number, seconds: number, now = Date.now(), table: JobTable = "jobs"): void {
  db.prepare(`UPDATE ${table} SET state = 'queued', lease_until = NULL, attempts = MAX(attempts - 1, 0), run_after = ? WHERE id = ? AND state = 'running'`).run(
    now + seconds * 1000,
    id,
  );
}
