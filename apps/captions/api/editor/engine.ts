import type { DatabaseSync } from "node:sqlite";
import { MAX_ATTEMPTS, type JobRow, type JobTable } from "../library/jobs";
import { RESOLVE_KIND } from "../../contracts/devices";
import { announce } from "../lib/sync";
import { analyzeStep } from "./analyze";
import { brollStep } from "./broll";
import { fileStep, previewStep } from "./preview";
import { scriptStep } from "./script";
import { draftStep } from "./timeline";
import type { EditMeta } from "./store";

/**
 * The AI Editor's step registry: one entry per step kind, with where it runs. A `core` kind runs on the server's
 * worker. A `device` kind runs only on a device that declares it (a Mac with Resolve, a card renderer), so the server
 * never claims it. Kinds with no entry at all still reach the server and fail as "No <kind> step yet".
 */

export interface StepContext {
  edit: EditMeta;
  job: JobRow;
  /** "" for a whole-edit step, else the version's name */
  variant: string;
  signal: AbortSignal;
}

export type StepRun = (ctx: StepContext) => Promise<void>;

export interface EditKind {
  source: "core" | "device";
  /** Kinds this one queues when it finishes (for the same edit and variant). */
  next: string[];
  /** Core kinds only: the server's handler. */
  run?: StepRun;
}

const KINDS: Record<string, EditKind> = {
  analyze: { source: "core", next: ["script"], run: analyzeStep },
  script: { source: "core", next: ["draft"], run: scriptStep },
  draft: { source: "core", next: ["broll"], run: draftStep },
  broll: { source: "core", next: ["preview"], run: brollStep },
  preview: { source: "core", next: ["file"], run: previewStep },
  file: { source: "core", next: [], run: fileStep },
  // the Resolve bridge (Mac app): handed out only with a Resolve pack installed (api/devices.ts)
  [RESOLVE_KIND]: { source: "device", next: [] },
};

/** Registers kinds that a device runs. Called once per kind (at boot, or by tests). */
export function registerDeviceKinds(kinds: string[]): void {
  for (const k of kinds) if (!KINDS[k]) KINDS[k] = { source: "device", next: [] };
}

/** Handler per core kind. The worker's STEPS is this object, so a test can swap one kind's handler. */
export function coreSteps(): Record<string, StepRun> {
  const out: Record<string, StepRun> = {};
  for (const [k, v] of Object.entries(KINDS)) if (v.source === "core" && v.run) out[k] = v.run;
  return out;
}

/** What each kind queues next, for the worker. */
export function nextKinds(): Record<string, string[]> {
  return Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.next]));
}

const deviceKinds = (): string[] => Object.keys(KINDS).filter((k) => KINDS[k]!.source === "device");

/**
 * The kinds one device may claim: the ones it declares that are registered as device kinds. A core kind named by a
 * device is ignored, so a device cannot take server work.
 */
export function claimableBy(declared: string[]): string[] {
  return declared.filter((k) => KINDS[k]?.source === "device");
}

/**
 * Takes the oldest queued job whose kind is in `kinds` (or, with "server", any kind no device kind claims), leases it
 * and counts the attempt. Same contract as library/jobs claimJob, which takes any kind. A device passes `by`: only jobs
 * its owner's account queued are taken, and the job records the device, so its beats, done and fail can be checked.
 */
export function claimStep(
  db: DatabaseSync,
  kinds: string[] | "server",
  leaseSeconds: number,
  now: number,
  table: JobTable,
  by?: { actor: string; device: string },
): JobRow | null {
  let where: string;
  let args: (string | number)[];
  if (kinds === "server") {
    const dev = deviceKinds();
    where = dev.length ? `AND kind NOT IN (${dev.map(() => "?").join(", ")})` : "";
    args = dev;
  } else {
    if (kinds.length === 0) return null;
    where = `AND kind IN (${kinds.map(() => "?").join(", ")})`;
    args = kinds;
  }
  if (by) {
    where += " AND actor = ?";
    args.push(by.actor);
  }
  return (
    (db
      .prepare(
        `UPDATE ${table} SET state = 'running', lease_until = ?, attempts = attempts + 1, device = ?
         WHERE id = (SELECT id FROM ${table} WHERE state = 'queued' AND run_after <= ? ${where} ORDER BY id LIMIT 1)
         RETURNING *`,
      )
      .get(now + leaseSeconds * 1000, by?.device ?? null, now, ...args) as JobRow | undefined) ?? null
  );
}

/**
 * A device that has gone quiet (not online) loses the steps it holds: they go back in the queue at once, not after the
 * lease runs out, and an attempt that was already used is kept (failed after MAX_ATTEMPTS, as requeueExpired does).
 * Returns how many steps were released.
 */
export function releaseQuietDevices(db: DatabaseSync, isOnline: (device: string) => boolean): number {
  const held = db.prepare("SELECT DISTINCT device FROM edit_jobs WHERE state = 'running' AND device IS NOT NULL").all() as { device: string }[];
  let released = 0;
  for (const { device } of held) {
    if (isOnline(device)) continue;
    // whose steps these are: their edit lists change (a step back in the queue, or failed)
    const actors = db.prepare("SELECT DISTINCT actor FROM edit_jobs WHERE state = 'running' AND device = ?").all(device) as { actor: string | null }[];
    for (const { actor } of actors) if (actor) announce(actor, "editor");
    released += Number(
      db
        .prepare(
          `UPDATE edit_jobs SET state = CASE WHEN attempts >= ? THEN 'failed' ELSE 'queued' END,
             error = CASE WHEN attempts >= ? THEN 'device went quiet' ELSE error END, lease_until = NULL, device = NULL
           WHERE state = 'running' AND device = ?`,
        )
        .run(MAX_ATTEMPTS, MAX_ATTEMPTS, device).changes,
    );
  }
  return released;
}
