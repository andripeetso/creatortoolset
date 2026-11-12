import type { DatabaseSync } from "node:sqlite";
import type { DeviceJob } from "../../contracts/devices";
import { isOnline } from "../lib/devices";
import { announce } from "../lib/sync";
import { libraryDb } from "../library/db";
import { defer, enqueueJob, extendLease, finishJob, type JobRow, parkJob, requeueExpired } from "../library/jobs";
import { NeedsKey } from "../library/transcribe";
import { trashDays } from "../library/trash";
import { Waiting } from "./analyze";
import { editStopped, runEnded } from "./ended";
import { claimableBy, claimStep, coreSteps, nextKinds, releaseQuietDevices, type StepRun } from "./engine";
import { purgeEdits, readEdit, sourcesWorkspace, type EditMeta } from "./store";

export type { StepContext } from "./engine";

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

/** The server's handler per core kind, from the step registry (engine.ts). */
export const STEPS: Record<string, StepRun> = coreSteps();

/** What a finished step queues next, for the same edit and variant (a whole-edit draft queues one per version itself). */
export const NEXT: Record<string, string[]> = nextKinds();

const running = new Map<number, { edit: string; ctl: AbortController }>();

/** A step moved (claimed, done, failed, parked): the account's open AI Editor pages and Home's to-do refetch (api/lib/sync.ts), and a run that ended is said in the chat that started it (ended.ts). */
const moved = (job: JobRow) => void (job.actor && (announce(job.actor, "editor"), runEnded(job)));

const fail = (db: DatabaseSync, job: JobRow, why: string) => {
  db.prepare(`UPDATE ${T} SET state = 'failed', lease_until = NULL, error = ? WHERE id = ?`).run(why, job.id);
  moved(job);
};

/** Stops an edit: its queued and running steps fail as "Stopped" (Retry or Run queues them again); a running one is aborted. */
export function stopEdit(editId: string): void {
  libraryDb().prepare(`UPDATE ${T} SET state = 'failed', lease_until = NULL, error = 'Stopped' WHERE edit_id = ? AND state IN ('queued', 'running')`).run(editId);
  for (const r of running.values()) if (r.edit === editId) r.ctl.abort();
  editStopped(editId);
}

/** Queues what a finished step queues next (a whole-edit draft has queued one per version itself, so only those queue previews). */
function queueNext(db: DatabaseSync, job: JobRow, edit: EditMeta, variant: string): void {
  if (variant || job.kind !== "draft") for (const kind of NEXT[job.kind] ?? []) enqueueJob(db, edit.workspaceId, job.version_id ?? "", kind, job.actor, true, T);
}

/** "<editId>:<variant>" split: the variant is "" for a whole-edit step. */
function splitVersion(job: JobRow): { editId: string; variant: string } {
  const vid = job.version_id ?? "";
  const cut = vid.indexOf(":");
  return { editId: vid.slice(0, cut), variant: vid.slice(cut + 1) };
}

/** Runs one queued step, if there is one. Returns false when the queue is empty. */
export async function tick(now = Date.now()): Promise<boolean> {
  const db = libraryDb();
  requeueExpired(db, now, T);
  releaseQuietDevices(db, isOnline);
  const job = claimStep(db, "server", LEASE_S, now, T);
  if (!job) return false;
  moved(job);
  try {
    return await runStep(db, job, now);
  } finally {
    moved(job);
  }
}

async function runStep(db: DatabaseSync, job: JobRow, now: number): Promise<boolean> {
  const vid = job.version_id ?? "";
  const cut = vid.indexOf(":");
  const edit = readEdit(vid.slice(0, cut));
  const variant = vid.slice(cut + 1);
  if (!job.actor) {
    parkJob(db, job.id, "This edit names no account to run as", T);
    return true;
  }
  if (!edit || edit.trashedAt) return fail(db, job, "The edit is gone"), true;
  // read again at every step: footage trashed or a library left since the edit was made
  if (sourcesWorkspace(job.actor, edit.sources) !== edit.workspaceId) return fail(db, job, "Some footage is gone or no longer yours to read"), true;
  const step = STEPS[job.kind];
  if (!step) return fail(db, job, `No ${job.kind} step yet`), true;

  const ctl = new AbortController();
  running.set(job.id, { edit: edit.id, ctl });
  const beat = setInterval(() => extendLease(db, job.id, LEASE_S, Date.now(), T), BEAT_MS);
  beat.unref();
  try {
    await step({ edit, job, variant, signal: ctl.signal });
    if (ctl.signal.aborted) return true; // stopped: stopEdit already marked it
    finishJob(db, job.id, true, undefined, Date.now(), T);
    queueNext(db, job, edit, variant);
  } catch (e) {
    if (ctl.signal.aborted) return true;
    if (e instanceof Waiting) return defer(db, job.id, e.seconds, now, T), true; // still going: it runs again in e.seconds
    if (e instanceof NeedsKey) parkJob(db, job.id, e.message, T);
    else finishJob(db, job.id, false, e instanceof Error ? e.message : String(e), Date.now(), T);
  } finally {
    clearInterval(beat);
    running.delete(job.id);
  }
  return true;
}

/**
 * A device's claim (POST /api/devices/relay/editor/claim): the oldest queued step of the kinds it can run, for an edit
 * its own account made, and only while that account can still read the footage. A step whose edit is gone or no longer
 * readable fails here, as tick fails it. Null when there is nothing for this device.
 */
export function claimForDevice(device: { id: string; owner: string }, kinds: string[], now = Date.now()): DeviceJob | null {
  const db = libraryDb();
  releaseQuietDevices(db, isOnline);
  const job = claimStep(db, claimableBy(kinds), LEASE_S, now, T, { actor: device.owner, device: device.id });
  if (!job) return null;
  moved(job);
  const { editId, variant } = splitVersion(job);
  const edit = readEdit(editId);
  if (!edit || edit.trashedAt) return fail(db, job, "The edit is gone"), null;
  if (sourcesWorkspace(job.actor ?? "", edit.sources) !== edit.workspaceId) return fail(db, job, "Some footage is gone or no longer yours to read"), null;
  return { id: job.id, kind: job.kind, editId, variant };
}

/** The job row this device holds (claimed by it and still running), or undefined. */
const heldBy = (db: DatabaseSync, id: number, device: string): JobRow | undefined =>
  db.prepare("SELECT * FROM edit_jobs WHERE id = ? AND device = ? AND state = 'running'").get(id, device) as JobRow | undefined;

/** A device's heartbeat for a step it runs: renews the lease. False when it does not hold the step. */
export function beatForDevice(device: string, id: number, now = Date.now()): boolean {
  const db = libraryDb();
  if (!heldBy(db, id, device)) return false;
  extendLease(db, id, LEASE_S, now, T);
  return true;
}

/** The device finished its step: done, and the next steps queue as tick would. False when it does not hold the step. */
export function doneForDevice(device: string, id: number): boolean {
  const db = libraryDb();
  const job = heldBy(db, id, device);
  if (!job) return false;
  db.prepare("UPDATE edit_jobs SET device = NULL WHERE id = ?").run(id);
  finishJob(db, id, true, undefined, Date.now(), T);
  const { editId, variant } = splitVersion(job);
  const edit = readEdit(editId);
  if (edit) queueNext(db, job, edit, variant);
  moved(job); // after the next steps are queued, so the refetch shows them
  return true;
}

/** The device could not run its step: retried after a backoff, or failed after MAX_ATTEMPTS. False when it does not hold the step. */
export function failForDevice(device: string, id: number, why: string): boolean {
  const db = libraryDb();
  const job = heldBy(db, id, device);
  if (!job) return false;
  db.prepare("UPDATE edit_jobs SET device = NULL WHERE id = ?").run(id);
  finishJob(db, id, false, why.slice(0, 500), Date.now(), T);
  moved(job);
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
