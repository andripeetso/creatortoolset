import type { DatabaseSync } from "node:sqlite";
import { libraryDb } from "../library/db";
import { claimJob, enqueueJob, extendLease, finishJob, parkJob, requeueExpired, type JobRow } from "../library/jobs";
import { NeedsKey } from "../library/transcribe";
import { trashDays } from "../library/trash";
import { purgeEdits, readEdit, sourcesWorkspace, type EditMeta } from "./store";

/**
 * The AI Editor's worker: its own loop over `edit_jobs`, one step at a time, so a minutes-long AI step never holds up
 * the library's thumbnails and a library backlog never holds up an edit. Every step runs as the job's actor (the
 * edit's creator), on their keys and AI; no actor = parked, never the server's. A running step renews its lease every
 * minute; Stop aborts it through its signal.
 */

const T = "edit_jobs";
const LEASE_S = 300;
const BEAT_MS = 60_000;
const IDLE_MS = 2000;

export interface StepContext {
  edit: EditMeta;
  job: JobRow;
  /** "" for a whole-edit step, else the version's name */
  variant: string;
  signal: AbortSignal;
}

/** The steps by kind. Empty until the slices that build them (analyze, script, draft…) add theirs. */
export const STEPS: Record<string, (ctx: StepContext) => Promise<void>> = {};

/** What a finished step queues next, for the same edit and variant. */
export const NEXT: Record<string, string[]> = {};

const running = new Map<number, { edit: string; ctl: AbortController }>();

const fail = (db: DatabaseSync, id: number, why: string) =>
  db.prepare(`UPDATE ${T} SET state = 'failed', lease_until = NULL, error = ? WHERE id = ?`).run(why, id);

/** Stops an edit: its queued and running steps fail as "Stopped" (Retry or Run queues them again); a running one is aborted. */
export function stopEdit(editId: string): void {
  libraryDb().prepare(`UPDATE ${T} SET state = 'failed', lease_until = NULL, error = 'Stopped' WHERE edit_id = ? AND state IN ('queued', 'running')`).run(editId);
  for (const r of running.values()) if (r.edit === editId) r.ctl.abort();
}

/** Runs one queued step, if there is one. Returns false when the queue is empty. */
export async function tick(now = Date.now()): Promise<boolean> {
  const db = libraryDb();
  requeueExpired(db, now, T);
  const job = claimJob(db, LEASE_S, now, T);
  if (!job) return false;
  const vid = job.version_id ?? "";
  const cut = vid.indexOf(":");
  const edit = readEdit(vid.slice(0, cut));
  const variant = vid.slice(cut + 1);
  if (!job.actor) {
    parkJob(db, job.id, "This edit names no account to run as", T);
    return true;
  }
  if (!edit || edit.trashedAt) return fail(db, job.id, "The edit is gone"), true;
  // read again at every step: footage trashed or a library left since the edit was made
  if (sourcesWorkspace(job.actor, edit.sources) !== edit.workspaceId) return fail(db, job.id, "Some footage is gone or no longer yours to read"), true;
  const step = STEPS[job.kind];
  if (!step) return fail(db, job.id, `No ${job.kind} step yet`), true;

  const ctl = new AbortController();
  running.set(job.id, { edit: edit.id, ctl });
  const beat = setInterval(() => extendLease(db, job.id, LEASE_S, Date.now(), T), BEAT_MS);
  beat.unref();
  try {
    await step({ edit, job, variant, signal: ctl.signal });
    if (ctl.signal.aborted) return true; // stopped: stopEdit already marked it
    finishJob(db, job.id, true, undefined, Date.now(), T);
    for (const kind of NEXT[job.kind] ?? []) enqueueJob(db, edit.workspaceId, vid, kind, job.actor, true, T);
  } catch (e) {
    if (ctl.signal.aborted) return true;
    if (e instanceof NeedsKey) parkJob(db, job.id, e.message, T);
    else finishJob(db, job.id, false, e instanceof Error ? e.message : String(e), Date.now(), T);
  } finally {
    clearInterval(beat);
    running.delete(job.id);
  }
  return true;
}

/** Starts the loop, and the hourly purge of edits trashed LIBRARY_TRASH_DAYS ago; the returned function stops the loop after the current step. */
export function startEditorWorker(): () => void {
  const purge = () => void purgeEdits(Date.now() - trashDays() * 86_400_000).catch((e) => console.error("[editor] purge:", e));
  purge();
  setInterval(purge, 3_600_000).unref();
  let stopped = false;
  const loop = async () => {
    let busy = false;
    try {
      busy = await tick();
    } catch (e) {
      console.error("[editor] worker:", e);
    }
    if (!stopped) setTimeout(loop, busy ? 0 : IDLE_MS).unref();
  };
  void loop();
  return () => {
    stopped = true;
  };
}
