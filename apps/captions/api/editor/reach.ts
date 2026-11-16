import { readFile } from "node:fs/promises";
import type { DeviceFootage } from "../../contracts/devices";
import type { Device } from "../../contracts/providers";
import type { StorageFolder } from "../../contracts/storage";
import { mayClaim, readBalance, type WorkerSeen } from "../lib/balance";
import { isOnline, isThisMachine, listDevices } from "../lib/devices";
import { env } from "../lib/env";
import { hostPath, parseStorageFile, storageFilePath } from "../lib/storage";
import { libraryDb } from "../library/db";
import type { JobRow } from "../library/jobs";
import { usesFootage } from "./engine";
import { readEdit } from "./store";

/**
 * Which of a person's computers may take an AI Editor step that reads the edit's footage: one that can get at every
 * file. A file is read where it is on a computer (the Mac it was indexed on, or a shared folder another computer also
 * found, Settings → Storage), else from the copy the server keeps. Among the computers that are online, free and
 * declare the step, the ones that get at the files the best way decide, and load balancing (lib/balance.ts) picks
 * among those, per step: a stronger computer that can't read the files never holds a step back from one that can.
 */

/** One footage file as the library keeps it: where it is on a computer (if anywhere), and the server's copy. */
export interface FileRow {
  id: string;
  source_key: string;
  source_path: string | null;
  mac_path: string | null;
  mac_device: string | null;
  proxy: string | null;
}

/** How a computer gets at one file: its own path, or the server's copy (the video file, or only its proxy). */
export type FileAt = { path: string } | { copy: "original" | "proxy" };

/** How `host` gets at file `r`; null when it can't. */
export function fileFor(r: FileRow, host: string, folders: StorageFolder[], here: (host: string) => boolean): FileAt | null {
  // a file on a computer: that computer, or another that found the shared folder it is in, at its own path there
  const at = r.mac_path ?? r.source_path;
  if (at && (r.mac_path ? r.mac_device === host : here(host))) return { path: at };
  const from = r.mac_path ? (r.mac_device ?? undefined) : undefined;
  const there = at && ((from && hostPath(at, folders, host, from)) || hostPath(at, folders, host));
  if (there) return { path: there };
  // "mac:<id>": indexed on a Mac and never uploaded, so the server has no copy of the file itself
  if (!r.source_key.startsWith("mac:")) return { copy: r.source_key === r.proxy ? "proxy" : "original" };
  return r.proxy ? { copy: "proxy" } : null;
}

/** How well a computer gets at all of a step's files: 3 every one on it, 2 some from the server, 1 some only as a proxy, 0 not all. */
export function rankOf(files: Array<FileAt | null>): number {
  return Math.min(3, ...files.map((f) => (!f ? 0 : "path" in f ? 3 : f.copy === "original" ? 2 : 1)));
}

/** The edit's footage and song, as the library keeps them. */
export function editFiles(editId: string): FileRow[] {
  const e = readEdit(editId);
  if (!e) return [];
  const ids = [...new Set([...e.sources, ...(typeof e.song === "string" ? [e.song] : [])])];
  if (!ids.length) return [];
  return libraryDb()
    .prepare(
      `SELECT v.id, v.source_key, v.source_path, v.mac_path, v.mac_device,
         (SELECT storage_key FROM derivatives WHERE version_id = v.id AND kind = 'proxy') AS proxy
       FROM asset_versions v WHERE v.id IN (${ids.map(() => "?").join(", ")})`,
    )
    .all(...ids) as unknown as FileRow[];
}

/** The edit a step belongs to: its version id is "<editId>:<variant>". */
export const editOf = (job: Pick<JobRow, "version_id">): string => (job.version_id ?? "").split(":")[0]!;

/** The account's storage folders (Settings → Storage). */
export async function foldersOf(owner: string): Promise<StorageFolder[]> {
  return parseStorageFile(await readFile(storageFilePath(env.dataDir, owner), "utf-8").catch(() => "{}")).folders;
}

/** What a device that took a step of `editId` is told of its files: each one's path on it, or which server copy to fetch. */
export async function footageFor(d: Pick<Device, "id" | "owner">, editId: string): Promise<DeviceFootage[]> {
  const folders = await foldersOf(d.owner);
  return editFiles(editId).flatMap((r) => {
    const at = fileFor(r, d.id, folders, isThisMachine);
    return at ? [{ id: r.id, ...at }] : [];
  });
}

/** The key of the server copy of `versionId` that device `device` may fetch for step `jobId` it holds (the copy fileFor
 *  named): the video file when the server has it, else its proxy. Null when the step or the file is not its own. */
export function heldCopy(device: string, jobId: number, versionId: string): string | null {
  const job = libraryDb().prepare("SELECT version_id FROM edit_jobs WHERE id = ? AND device = ? AND state = 'running'").get(jobId, device) as Pick<JobRow, "version_id"> | undefined;
  const r = job && editFiles(editOf(job)).find((f) => f.id === versionId);
  return !r ? null : !r.source_key.startsWith("mac:") ? r.source_key : r.proxy;
}

/** The same window as isOnline (lib/devices.ts). */
const ONLINE_MS = 40_000;

/**
 * Whether device `d` may take each queued step now (claimStep's `fits`). A step that reads no footage: yes (it is balanced
 * by kind, devices.ts). Else: `d` gets at its files, no online, free computer that declares the step gets at them a better
 * way, and load balancing picks `d` among those that get at them as well.
 */
export async function fitsFor(d: Device, now = Date.now()): Promise<(job: JobRow) => boolean> {
  const folders = await foldersOf(d.owner);
  const balance = await readBalance(d.owner);
  const busy = new Set((libraryDb().prepare("SELECT DISTINCT device FROM edit_jobs WHERE state = 'running' AND device IS NOT NULL").all() as { device: string }[]).map((r) => r.device));
  // the one asking has a free slot, whatever the list says
  const peers = listDevices((x) => x.owner === d.owner).filter((x) => x.id === d.id || (isOnline(x.id) && !busy.has(x.id)));
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
