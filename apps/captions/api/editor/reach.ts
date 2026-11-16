import { readFileSync } from "node:fs";
import path from "node:path";
import type { DeviceFootage } from "../../contracts/devices";
import type { Device } from "../../contracts/providers";
import type { StorageFolder } from "../../contracts/storage";
import { mayClaim, readBalance, type WorkerSeen } from "../lib/balance";
import { isOnline, isThisMachine, listDevices } from "../lib/devices";
import { env } from "../lib/env";
import { folderFor, hostPath, parseStorageFile, storageFilePath, withMounts } from "../lib/storage";
import { libraryDb, libraryUpload } from "../library/db";
import type { JobRow } from "../library/jobs";
import { usesFootage } from "./engine";
import { readDraft, readEdit } from "./store";
import { workWaitLine } from "../work/place";

/**
 * Which of a person's computers may take an AI Editor step that reads the edit's footage: one that can get at every
 * file. A file is read where it is on a computer (the Mac it was indexed on, or a shared folder another computer also
 * found, Settings → Storage), else from the copy the server keeps. Among the computers that are online, free and
 * declare the step, the ones that get at the files the best way decide, and load balancing (lib/balance.ts) picks
 * among those, per step: a stronger computer that can't read the files never holds a step back from one that can.
 * A computer never downloads an original to analyse or cut: it reads a file where it is, else the server's proxy.
 */

/** One footage file as the library keeps it: where it is on a computer (if anywhere), and the server's copy. */
export interface FileRow {
  id: string;
  source_key: string;
  source_path: string | null;
  mac_path: string | null;
  mac_device: string | null;
  proxy: string | null;
  library_id?: string;
}

/** How a computer gets at one file: its own path, or the server's proxy (never the original: PRD 4.2). */
export type FileAt = { path: string } | { copy: "proxy" };

/** How `host` gets at file `r`; null when it can't. */
export function fileFor(r: FileRow, host: string, folders: StorageFolder[], here: (host: string) => boolean): FileAt | null {
  // a file on a computer: that computer, or another that found the shared folder it is in, at its own path there
  const at = r.mac_path ?? r.source_path;
  if (at && (r.mac_path ? r.mac_device === host : here(host))) return { path: at };
  const from = r.mac_path ? (r.mac_device ?? undefined) : undefined;
  const there = at && ((from && hostPath(at, folders, host, from)) || hostPath(at, folders, host));
  if (there) return { path: there };
  // else the server's proxy; an original the server holds is never downloaded to analyse or cut
  return r.proxy ? { copy: "proxy" } : null;
}

/** How well a computer gets at all of a step's files: 3 every one on it, 2 some as the server's proxy, 0 not all. */
export function rankOf(files: Array<FileAt | null>): number {
  return Math.min(3, ...files.map((f) => (!f ? 0 : "path" in f ? 3 : 2)));
}

/** The edit's footage and song, as the library keeps them; `more`: other version ids the step reads too. */
export function editFiles(editId: string, more: string[] = []): FileRow[] {
  const e = readEdit(editId);
  if (!e) return [];
  const ids = [...new Set([...e.sources, ...(typeof e.song === "string" ? [e.song] : []), ...more])];
  if (!ids.length) return [];
  return libraryDb()
    .prepare(
      `SELECT v.id, v.source_key, v.source_path, v.mac_path, v.mac_device, a.library_id,
         (SELECT storage_key FROM derivatives WHERE version_id = v.id AND kind = 'proxy') AS proxy
       FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id IN (${ids.map(() => "?").join(", ")})`,
    )
    .all(...ids) as unknown as FileRow[];
}

/** The files a step reads: the edit's sources and song, and for a version's step its draft's other sources (B-roll). */
export function jobFiles(job: Pick<JobRow, "version_id">): FileRow[] {
  const vid = job.version_id ?? "";
  const variant = vid.slice(vid.indexOf(":") + 1);
  return editFiles(editOf(job), variant ? Object.keys(readDraft(editOf(job), variant)?.timeline.sources ?? {}) : []);
}

/** The edit a step belongs to: its version id is "<editId>:<variant>". */
export const editOf = (job: Pick<JobRow, "version_id">): string => (job.version_id ?? "").split(":")[0]!;

/** The account's storage folders (Settings → Storage), with the computers that reach them through a connected share. */
export function foldersOf(owner: string): StorageFolder[] {
  let raw = "{}";
  try {
    raw = readFileSync(storageFilePath(env.dataDir, owner), "utf-8");
  } catch {
    // no folders set yet
  }
  const folders = parseStorageFile(raw).folders;
  return withMounts(folders, listDevices((x) => x.owner === owner).map((x) => ({ id: x.id, disks: x.report?.machine?.disks })));
}

/** What a device that took a step of `editId` is told of its files: each one's path on it, or which server copy to fetch. */
export async function footageFor(d: Pick<Device, "id" | "owner">, editId: string): Promise<DeviceFootage[]> {
  const folders = foldersOf(d.owner);
  return editFiles(editId).flatMap((r) => {
    const at = fileFor(r, d.id, folders, isThisMachine);
    return at ? [{ id: r.id, ...at }] : [];
  });
}

/**
 * The key of the server copy of `versionId` that device `device` may fetch for step `jobId` it holds: its proxy. The
 * original only when the step asks for it (`original`) and its library uploads originals ("all"). Null when the step or
 * the file is not its own, or there is no such copy.
 */
export function heldCopy(device: string, jobId: number, versionId: string, original = false): string | null {
  const job = libraryDb().prepare("SELECT version_id FROM edit_jobs WHERE id = ? AND device = ? AND state = 'running'").get(jobId, device) as Pick<JobRow, "version_id"> | undefined;
  const r = job && jobFiles(job).find((f) => f.id === versionId);
  if (!r) return null;
  if (original && !r.source_key.startsWith("mac:") && r.source_key !== r.proxy && r.library_id && libraryUpload(r.library_id) === "all") return r.source_key;
  return r.proxy;
}

/** The account's computers, and whether each is online and free (holds no AI Editor step now). */
export function computers(owner: string): Array<{ x: Device; free: boolean }> {
  const busy = new Set((libraryDb().prepare("SELECT DISTINCT device FROM edit_jobs WHERE state = 'running' AND device IS NOT NULL").all() as { device: string }[]).map((r) => r.device));
  return listDevices((x) => x.owner === owner).map((x) => ({ x, free: isOnline(x.id) && !busy.has(x.id) }));
}

/** "A", "A or B", "A, B or C". */
export const either = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`);

/**
 * Why a queued step that reads footage waits, in one line, when no online, free computer that runs it can read its files
 * ("Only Mac Studio can read Footage"); undefined while one can (it is about to be taken), or when no computer runs the
 * step at all. Shown beside the step on the edit page (EditJob.line).
 */
export function waitLine(owner: string, job: Pick<JobRow, "kind" | "version_id">): string | undefined {
  if (!usesFootage(job.kind)) return workWaitLine(owner, job);
  const rows = editFiles(editOf(job));
  const runs = computers(owner).filter((c) => (c.x.kinds ?? []).includes(job.kind));
  if (!rows.length || !runs.length) return undefined;
  const folders = foldersOf(owner);
  const can = runs.filter((c) => rankOf(rows.map((r) => fileFor(r, c.x.id, folders, isThisMachine))) > 0);
  if (can.some((c) => c.free)) return undefined;
  // the files some computer can't get at: named by their folder, else by the file
  const missing = rows.find((r) => runs.some((c) => !fileFor(r, c.x.id, folders, isThisMachine)));
  const at = missing && (missing.mac_path ?? missing.source_path);
  const what = (at && ((folderFor(at, folders, missing.mac_device ?? undefined) ?? folderFor(at, folders))?.folder.name ?? path.basename(at))) || "this footage";
  return can.length ? `Only ${either(can.map((c) => c.x.name))} can read ${what}` : `No computer can read ${what} yet: connect it on one in Settings → Storage`;
}

/** The same window as isOnline (lib/devices.ts). */
export const ONLINE_MS = 40_000;

/**
 * Whether device `d` may take each queued step now (claimStep's `fits`). A step that reads no footage: yes (it is balanced
 * by kind, devices.ts). Else: `d` gets at its files, no online, free computer that declares the step gets at them a better
 * way, and load balancing picks `d` among those that get at them as well.
 */
export async function fitsFor(d: Device, now = Date.now()): Promise<(job: JobRow) => boolean> {
  const folders = foldersOf(d.owner);
  const balance = await readBalance(d.owner);
  // the one asking has a free slot, whatever the list says
  const peers = computers(d.owner).filter((c) => c.x.id === d.id || c.free).map((c) => c.x);
  const files = new Map<string, FileRow[]>();
  return (job) => {
    if (!usesFootage(job.kind)) return true;
    const edit = editOf(job);
    if (!files.has(edit)) files.set(edit, editFiles(edit));
    const rows = files.get(edit)!;
    // no files left (the edit is gone): the claim fails it with its reason (worker.ts)
    if (!rows.length) return true;
    const rank = (host: string) => rankOf(rows.map((r) => fileFor(r, host, folders, isThisMachine)));
    const mine = rank(d.id);
    if (!mine) return false;
    const ranked = peers.filter((x) => x.id === d.id || (x.kinds ?? []).includes(job.kind)).map((x) => ({ x, r: x.id === d.id ? mine : rank(x.id) }));
    const top = Math.max(...ranked.map((p) => p.r));
    if (mine < top) return false;
    const workers: WorkerSeen[] = ranked
      .filter((p) => p.r === top && p.x.report?.machine)
      .map(({ x }) => ({ host: x.id, at: x.id === d.id ? now : (x.lastSeen ?? 0), machine: x.report!.machine, never: [] }));
    return mayClaim(job.kind, d.id, workers, balance, now, ONLINE_MS);
  };
}
