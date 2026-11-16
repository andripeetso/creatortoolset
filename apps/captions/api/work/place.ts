/**
 * Item 4B: which place a step goes to (design 5), and what a computer working on a step last said.
 *
 * A core step that reads video or sound (engine.ts `place`) goes to one of the asker's own computers first: one that has
 * every file on it (rank 3), else one that can get the rest as the server's proxies (rank 2); among several of the same
 * rank, load balancing (lib/balance.ts: load, Prefer / Normal / Less often / Off) picks. Only the asker's own computers,
 * and only those whose worker reads this server's package (WORK_MIN). The server (work/server-work.ts) takes such a step
 * only where its video work is on for the edit's workspace: after the asker's computers (none online can take it), or
 * first where the person set it to Prefer; set to Off, or switched off, never, and the step waits with its line.
 */
import { readFileSync } from "node:fs";
import type { Balance, Device } from "../../contracts/providers";
import type { StorageFolder } from "../../contracts/storage";
import { WORK_MIN, type WorkBeat } from "../../contracts/work";
import { coreKinds, placeOf, type StepContext } from "../editor/engine";
import { computers, editOf, either, fileFor, foldersOf, jobFiles, ONLINE_MS, rankOf, type FileRow } from "../editor/reach";
import { readEdit, readStep } from "../editor/store";
import { balanceFile, mayClaim, readBalance, type WorkerSeen } from "../lib/balance";
import { isOnline, isThisMachine, listDevices } from "../lib/devices";
import { pluginEditorSteps } from "../lib/plugin";
import { libraryDb } from "../library/db";
import type { JobRow } from "../library/jobs";
import { libraryWaits } from "./library-package";
import { serverPreferred, serverWeight, serverWorks, stepWorkspace } from "./server-work";

export interface WorkProgress extends WorkBeat {
  /** the computer's name, as Settings → Devices shows it */
  device: string;
  at: number;
}

/**
 * The gate of a computer kind (analyze's transcripts, a planned script's index), run on the server when a computer
 * claims, since it reads the server's queue and memory. It throws Waiting to put the step back with its line; what it
 * returns goes to the computer as `pkg.gate`. Filled by the step's own module (item 4C); a kind with none runs as is.
 */
export const gates: Partial<Record<string, (ctx: StepContext) => Promise<unknown>>> = {};

/** A computer whose worker reads this server's package. */
const works = (d: Pick<Device, "work">): boolean => (d.work?.v ?? 0) >= WORK_MIN;

const variantOf = (job: Pick<JobRow, "version_id">) => {
  const vid = job.version_id ?? "";
  return vid.slice(vid.indexOf(":") + 1);
};

/**
 * The owner's computers set to Off in Load balancing (lib/balance.ts, weight 0 while it is on): they take no step, so
 * none of them counts as the one that could, and the step goes to another computer (or, in phase 4, the server).
 */
function offOf(owner: string): Set<string> {
  try {
    const b = JSON.parse(readFileSync(balanceFile(owner), "utf8")) as Partial<Balance>;
    return b.on === false ? new Set() : new Set(Object.entries(b.weights ?? {}).flatMap(([id, w]) => (w === 0 ? [id] : [])));
  } catch {
    return new Set();
  }
}

/** How well computer `d` can take `job`: 3 has every file, 2 gets the rest as the server's proxies, 0 never. */
export function rankFor(d: Device, job: Pick<JobRow, "kind" | "version_id">, rows: FileRow[], folders: StorageFolder[]): number {
  if (!works(d)) return 0;
  const at = rows.map((r) => fileFor(r, d.id, folders, isThisMachine));
  if (job.kind === "post") {
    // a plug-in step it lacks would be skipped, and the cut go out without it (post.ts): never
    if ((readEdit(editOf(job))?.steps ?? []).some((s) => !d.work!.steps.includes(s.id))) return 0;
    // post rewrites the originals: only a computer that has every one
    return at.every((f) => f && "path" in f) ? 3 : 0;
  }
  // a preview plays the post copies, which stay on the computer that made them
  const on = job.kind === "preview" ? (readStep(editOf(job), "post")?.[variantOf(job)] as { on?: string } | undefined)?.on : undefined;
  return on && on !== d.id ? 0 : rankOf(at);
}

/**
 * Whether computer `d` may take each queued step now (claimStep's `fits`): a step placed on a computer, whose files it
 * gets at, that no free computer of its owner gets at a better way, and that load balancing gives to `d` among those
 * that get at them as well.
 */
export async function fitsWork(d: Device, now = Date.now()): Promise<(job: JobRow) => boolean> {
  const folders = foldersOf(d.owner);
  const balance = await readBalance(d.owner);
  // the one asking has a free slot, whatever the list says
  const off = offOf(d.owner);
  const peers = computers(d.owner).filter((c) => c.x.id === d.id || c.free).map((c) => (c.x.id === d.id ? d : c.x)).filter((x) => works(x) && !off.has(x.id));
  const serverFree = !libraryDb().prepare("SELECT 1 FROM edit_jobs WHERE state = 'running' AND device IS NULL").get();
  return (job) => {
    if (placeOf(job) !== "computer") return false;
    // the person prefers the server: it goes there first, and to a computer only while the server is busy
    const rows = jobFiles(job);
    if (serverFree && serverFirst(job, rows)) return false;
    const ranked = peers.map((x) => ({ x, r: rankFor(x, job, rows, folders) }));
    const mine = ranked.find((p) => p.x.id === d.id)?.r ?? 0;
    const top = Math.max(0, ...ranked.map((p) => p.r));
    if (!mine || mine < top) return false;
    const workers: WorkerSeen[] = ranked
      .filter((p) => p.r === top && p.x.report?.machine)
      .map(({ x }) => ({ host: x.id, at: x.id === d.id ? now : (x.lastSeen ?? 0), machine: x.report!.machine, never: [] }));
    return mayClaim(job.kind, d.id, workers, balance, now, ONLINE_MS);
  };
}

/** One of the asker's computers that can take this step is online (busy or not): the server's loop leaves it to that one. */
export function computerCanTake(job: JobRow): boolean {
  if (!job.actor) return false;
  const off = offOf(job.actor);
  const own = listDevices((x) => x.owner === job.actor && isOnline(x.id) && works(x) && !off.has(x.id));
  if (!own.length) return false;
  const rows = jobFiles(job);
  const folders = foldersOf(job.actor);
  return own.some((x) => rankFor(x, job, rows, folders) > 0);
}

/**
 * What the server's own loop may take: a step that reads no video or sound; else, where its video work is on for the
 * step (server-work.ts) and the person did not set the server to Off, one they prefer it for or no computer of theirs
 * can take now.
 */
// ponytail: placed and ranked again per queued step on each idle tick; cache per tick if long queues of waiting steps appear
export function serverMayTake(job: JobRow): boolean {
  if (placeOf(job) !== "computer") return true;
  if (!serverOpen(job)) return false;
  return serverFirst(job, jobFiles(job)) || !computerCanTake(job);
}

/** The person prefers the server for this step and it has every file (an upload or its proxy): it goes there first. */
const serverFirst = (job: JobRow, rows: FileRow[]): boolean =>
  serverPreferred(stepWorkspace(job.version_id), job.actor) && rows.every((r) => !r.source_key.startsWith("mac:") || !!r.proxy);

/** The server may run this video step at all: its video work is on for it, and the asker has not set it to Off. */
const serverOpen = (job: Pick<JobRow, "version_id" | "actor">): boolean => serverWorks(stepWorkspace(job.version_id), job.actor) && serverWeight(job.actor) > 0;

/** Whether a step waits that computer `d` would be handed by a work claim now: what its device runner's long poll is told. */
export async function workWaits(d: Device, now = Date.now()): Promise<boolean> {
  if (!works(d)) return false;
  if (await libraryWaits(d, now)) return true;
  const k = coreKinds();
  const fits = await fitsWork(d, now);
  return (
    libraryDb()
      .prepare(`SELECT * FROM edit_jobs WHERE state = 'queued' AND run_after <= ? AND actor = ? AND kind IN (${k.map(() => "?").join(", ")}) ORDER BY id LIMIT 200`)
      .all(now, d.owner, ...k) as unknown as JobRow[]
  ).some(fits);
}

/**
 * Why a queued step placed on a computer waits, in one line (reach.ts waitLine, beside the step on the edit page);
 * undefined while a free computer can take it (it is about to), or for a step that stays on the server.
 */
export function workWaitLine(owner: string, job: Pick<JobRow, "kind" | "version_id">): string | undefined {
  if (placeOf(job) !== "computer") return undefined;
  const off = offOf(owner);
  const online = computers(owner).filter((c) => isOnline(c.x.id) && !off.has(c.x.id));
  const rows = jobFiles(job);
  const folders = foldersOf(owner);
  const can = online.filter((c) => rankFor(c.x, job, rows, folders) > 0);
  if (can.some((c) => c.free)) return undefined;
  if (can.length) return `Waits for ${either(can.map((c) => c.x.name))}`;
  const old = online.filter((c) => c.x.work && !works(c.x));
  if (old.length) return `Update Creator Toolset on ${either(old.map((c) => c.x.name))}`;
  if (job.kind === "post") {
    const need = readEdit(editOf(job))?.steps ?? [];
    for (const c of online.filter((x) => works(x.x))) {
      const lacks = need.find((s) => !c.x.work!.steps.includes(s.id));
      if (lacks) return `${pluginEditorSteps().find((s) => s.id === lacks.id)?.title ?? lacks.id} isn't on ${c.x.name}`;
    }
    return "Needs the original files: open Creator Toolset on the Mac that has them";
  }
  return "Waits for one of your computers. Open Creator Toolset on your Mac";
}

/** What each computer working on a step last said (its beats), by job id. */
const progress = new Map<number, WorkProgress & { deviceId: string }>();

/** Keeps a beat's line and download progress for the edit page. */
export function noteProgress(jobId: number, d: Pick<Device, "id" | "name">, beat: WorkBeat, now = Date.now()): void {
  progress.set(jobId, { ...beat, device: d.name, deviceId: d.id, at: now });
}

/** A beat's body, as far as it is one: a line and non-negative numbers. */
export function parseBeat(b: unknown): WorkBeat {
  const o = (b && typeof b === "object" ? b : {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
  const out: WorkBeat = {};
  if (typeof o.line === "string" && o.line) out.line = o.line.slice(0, 300);
  for (const k of ["done", "total", "leftS"] as const) if (n(o[k]) !== undefined) out[k] = n(o[k]);
  return out;
}

/** What the computer holding `jobId` last reported, while it holds it. */
export function progressOf(jobId: number): WorkProgress | undefined {
  const p = progress.get(jobId);
  if (!p) return undefined;
  if (!libraryDb().prepare("SELECT 1 FROM edit_jobs WHERE id = ? AND device = ? AND state = 'running'").get(jobId, p.deviceId)) {
    progress.delete(jobId);
    return undefined;
  }
  const { deviceId: _, ...out } = p;
  return out;
}
