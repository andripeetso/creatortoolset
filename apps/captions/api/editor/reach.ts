import { readFileSync } from "node:fs";
import path from "node:path";
import type { DeviceFootage } from "../../contracts/devices";
import { hostsOriginals } from "../../contracts/library";
import type { Device } from "../../contracts/providers";
import type { StorageFolder } from "../../contracts/storage";
import { mayClaim, readBalance, type WorkerSeen } from "../lib/balance";
import { isOnline, isThisMachine, listDevices } from "../lib/devices";
import { env } from "../lib/env";
import { folderFor, hostPath, parseStorageFile, storageFilePath, withMounts } from "../lib/storage";
import { libraryDb, libraryUpload, playOf } from "../library/db";
import { mayLeave } from "../library/upload-gate";
import { triesOn } from "../library/places";
import { needsProxy } from "../library/media/proxy";
import type { ProbeSummary } from "../library/media/probe";
import { heldBy, type JobRow } from "../library/jobs";
import { usesFootage } from "./engine";
import { readDraft, readEdit } from "./store";
import { serverOpen, workWaitLine } from "../work/place";
import { downloadsAllowFor } from "../work/offline";


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
  /** the version's probe (JSON), when known: a file light enough to need no proxy is its own light copy */
  probe?: string | null;
  /** the version read in its place, whose file this row is: its blurred render (db.ts playOf); none: itself */
  play?: string;
}

/**
 * The server copy a computer may download to analyse or cut: the proxy, or the original itself when the original needs
 * no proxy (a 1080p H.264 phone clip, a song: library/media/proxy.ts needsProxy), as it is then no heavier than one.
 */
export function lightKey(r: FileRow): string | null {
  // Blur faces: a held copy of a clip not blurred (from before it was on) goes to no computer
  if (r.library_id && !mayLeave(r.library_id, { versionId: r.play ?? r.id }).ok) return null;
  if (r.proxy) return r.proxy;
  if (r.source_key.startsWith("mac:") || !r.probe) return null;
  try {
    return needsProxy(JSON.parse(r.probe) as ProbeSummary) ? null : r.source_key;
  } catch {
    return null;
  }
}

/** How a computer gets at one file: its own path, or the server's proxy (never the original: PRD 4.2). */
export type FileAt = { path: string } | { copy: "proxy" };

/** How `host` gets at file `r`; null when it can't. */
export function fileFor(r: FileRow, host: string, folders: StorageFolder[], here: (host: string) => boolean): FileAt | null {
  // a file on this server's disk: this machine, or a computer that found the shared folder it is in
  if (!r.mac_path && r.source_path) {
    const there = here(host) ? r.source_path : hostPath(r.source_path, folders, host);
    if (there) return { path: there };
  }
  // a file on a computer: the first path this one tries (its own place, its root on this computer's disks, a shared
  // folder, where it was indexed: library/places.ts placesFor)
  const first = triesOn({ ...r, id: r.play ?? r.id }, host, folders)[0];
  if (first) return { path: first };
  // else the server's proxy; an original the server holds is never downloaded to analyse or cut
  return lightKey(r) ? { copy: "proxy" } : null;
}

/**
 * How `host` gets at `r` for the owner's step: a server copy only when the server won't run the step and the owner's
 * Downloads for the library allows it (UNIFIED-PRD 4.7); a file on a computer is always read where it is.
 */
export function atFor(r: FileRow, host: string, folders: StorageFolder[], allows: (libraryId: string | undefined) => boolean, serverRuns: boolean): FileAt | null {
  const at = fileFor(r, host, folders, isThisMachine);
  if (at && "copy" in at && (serverRuns || !allows(r.library_id))) return null;
  return at;
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
  // a file marked Blur faces is read as its blurred render, under its own id (the editor source rule, db.ts playOf); an
  // original and its blurred render may both be sources, each keeps its row
  const plays = [...new Set(ids.map(playOf))];
  const rows = libraryDb()
    .prepare(
      `SELECT v.id, v.source_key, v.source_path, v.mac_path, v.mac_device, v.probe, a.library_id,
         (SELECT storage_key FROM derivatives WHERE version_id = v.id AND kind = 'proxy') AS proxy
       FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id IN (${plays.map(() => "?").join(", ")})`,
    )
    .all(...plays) as unknown as FileRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const r = byId.get(playOf(id));
    return r ? [r.id === id ? r : { ...r, id, play: r.id }] : [];
  });
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
  const job = heldBy(libraryDb(), jobId, device);
  const r = job && jobFiles(job).find((f) => f.id === versionId);
  if (!r) return null;
  if (original && !r.source_key.startsWith("mac:") && r.source_key !== r.proxy && r.library_id && hostsOriginals(libraryUpload(r.library_id)) && mayLeave(r.library_id, { versionId: r.play ?? versionId }).ok) return r.source_key;
  return lightKey(r);
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
  const serverRuns = serverOpen({ version_id: job.version_id, actor: owner });
  const allows = downloadsAllowFor(owner);
  const can = runs.filter((c) => rankOf(rows.map((r) => atFor(r, c.x.id, folders, allows, serverRuns))) > 0);
  if (can.some((c) => c.free)) return undefined;
  // the files some computer can't get at: named by their folder, else by the file
  const missing = rows.find((r) => runs.some((c) => !atFor(r, c.x.id, folders, allows, serverRuns)));
  const at = missing && (missing.mac_path ?? missing.source_path);
  const what = (at && ((folderFor(at, folders, missing.mac_device ?? undefined) ?? folderFor(at, folders))?.folder.name ?? path.basename(at))) || "this footage";
  return can.length ? `Only ${either(can.map((c) => c.x.name))} can read ${what}` : `No computer can read ${what}: add its folder to a computer in Settings → Folders`;
}

/**
 * The library whose server copies would let a waiting step run, when Downloads is off for it (UNIFIED-PRD 4.7, S5.1):
 * the server won't run the step, no computer of the person reads every file where it is, and a file has a light copy
 * the person may download. The chat then asks to turn Automatic downloads on (action_needed downloads). Undefined
 * otherwise, including Hosted media Off, which keeps the existing line.
 */
export function downloadsAsk(job: Pick<JobRow, "kind" | "version_id" | "actor">): { libraryId: string; workspace: string } | undefined {
  if (!usesFootage(job.kind) || serverOpen(job) || !job.actor) return undefined;
  const rows = editFiles(editOf(job));
  const folders = foldersOf(job.actor);
  const allows = downloadsAllowFor(job.actor);
  const onDisk = (host: string) => rows.every((r) => { const f = fileFor(r, host, folders, isThisMachine); return !!f && "path" in f; });
  const cs = computers(job.actor);
  if (!rows.length || !cs.length || cs.some((c) => onDisk(c.x.id))) return undefined;
  const r = rows.find((x) => x.library_id && lightKey(x) && !allows(x.library_id));
  if (!r?.library_id) return undefined;
  const ws = libraryDb().prepare("SELECT json_extract(settings, '$.projectId') AS ws FROM libraries WHERE id = ?").get(r.library_id) as { ws: string | null } | undefined;
  return { libraryId: r.library_id, workspace: ws?.ws ?? "" };
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
  const allows = downloadsAllowFor(d.owner);
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
    const serverRuns = serverOpen(job);
    const rank = (host: string) => rankOf(rows.map((r) => atFor(r, host, folders, allows, serverRuns)));
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
