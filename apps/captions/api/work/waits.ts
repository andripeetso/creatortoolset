import { LIBRARY_LOOK_KIND } from "../../contracts/devices";
import type { Balance, Device } from "../../contracts/providers";
import type { StorageFolder } from "../../contracts/storage";
import { WORK_MIN } from "../../contracts/work";
import {
  addAgain,
  addComputer,
  fileUnchecked,
  lowDiskOn,
  noLooksOn,
  noOriginals,
  notOnComputers,
  notThisLibrary,
  offline,
  offInBalancing,
  updateOn,
} from "../../src/lib/wording";
import { computers, either, foldersOf, lightKey, ONLINE_MS, type FileAt, type FileRow } from "../editor/reach";
import { allowsLibrary, claimsFresh, mayClaim, offOf, readBalanceSync, takesOriginals, type WorkerSeen } from "../lib/balance";
import { deviceOf, isOnline, isThisMachine, listDevices } from "../lib/devices";
import { folderFor, hostPath } from "../lib/storage";
import { libraryChanged } from "../library/access";
import { libraryDb } from "../library/db";
import type { JobRow } from "../library/jobs";
import { lookHeldOn, type PlaceRow } from "../library/mac-look";
import { OWN, placesFor } from "../library/places";
import { BUDGET_WAITS, MAC_WAITS } from "../library/shots";
import { keySound } from "../library/transcribe";
import { resolveDevice } from "../library/whereis";
import { DECODES, leaveToComputers, leftHere, LIMIT_LIKE, type WaitClass, type WaitSnapshot } from "../library/worker";
import {
  holding,
  LIBRARY_ON_COMPUTER,
  libraryRank,
  lift,
  oldApp,
  POLL_FRESH_MS,
  polls,
  relayBusy,
  rowOf,
  takesLibrary,
  where,
  type LibRow,
} from "./library-package";

export type { WaitClass, WaitSnapshot };

export const FRESH_MS = 15_000;
export const LOW_DISK_FRESH_MS = 3 * 60_000;
export const REFUSED_IDLE_MS = 15 * 60_000;

export let BOOT = Date.now();
export const setBootForTest = (at: number): void => {
  BOOT = at;
};

export const snapshots = new Map<string, WaitSnapshot>();
export const last = new Map<number, WaitClass["wait"]>();
export const since = new Map<number, number>();
export const freeSince = new Map<string, number>();
export const stuckOn = new Map<string, string>();
const loggedStuck = new Set<string>();
const loggedGap = new Set<string>();

export function resetWaitsForTest(boot = Date.now()): void {
  BOOT = boot;
  snapshots.clear();
  last.clear();
  since.clear();
  freeSince.clear();
  stuckOn.clear();
  loggedStuck.clear();
  loggedGap.clear();
}

/** Whether `d` is one of the person's computers (never a helper.py row with version "1", a machineId and no work). */
export function isComputer(d: Pick<Device, "version" | "machineId" | "work">): boolean {
  return !!d.work || /^\d+\.\d+\.\d+/.test(d.version ?? "") || (!d.version && !d.machineId);
}

/** `b` with `x` allowed for every library and allowed to download originals. */
export function openBalance(b: Balance, x: Pick<Device, "id">): Balance {
  const { [x.id]: _, ...libraries } = b.libraries ?? {};
  return {
    ...b,
    libraries,
    originals: { ...b.originals, [x.id]: true },
  };
}

/**
 * Whether `x` is online through another caller while its library-only worker, free, has not claimed for 15 min,
 * and no newer row of the same box has taken over.
 */
export function refused(x: Device, now = Date.now(), off = offOf(x.owner), heldSet?: Set<string>): boolean {
  if (!x.work?.libraryOnly || off.has(x.id) || !isOnline(x.id)) return false;
  if (heldSet ? heldSet.has(x.id) || lookHeldOn(x.id, now) : holding(x.id) || lookHeldOn(x.id, now)) return false;
  if (now - (x.work.at ?? 0) <= REFUSED_IDLE_MS) return false;
  return !listDevices((y) => y.owner === x.owner && y.id !== x.id && y.name === x.name && claimsFresh(y, now)).length;
}

class Ctx {
  readonly now: number;
  private readonly devicesByOwner = new Map<string, Device[]>();
  private readonly offByOwner = new Map<string, Set<string>>();
  private readonly balanceByOwner = new Map<string, Balance>();
  private readonly foldersByOwner = new Map<string, StorageFolder[]>();
  private readonly busyEditorsByOwner = new Map<string, Set<string>>();
  private readonly rows = new Map<string, LibRow | null>();
  private readonly placeVersions = new Map<string, { root: string | null; root_rel: string | null; hasPlace: boolean; ownByDev: Map<string, string | null> }>();
  private readonly triesCache = new Map<string, string[]>();
  private readonly fileForCache = new Map<string, FileAt | null>();
  private readonly proxyJobs = new Map<string, JobRow | null>();
  readonly holdingSet: Set<string>;
  private readonly lookHeldCache = new Map<string, boolean>();
  readonly identityGaps = new Map<string, { versions: Set<string>; onlineComputer: string; fromId: string }>();

  constructor(now: number) {
    this.now = now;
    const rows = libraryDb().prepare("SELECT DISTINCT held_by FROM jobs WHERE state = 'running' AND held_by IS NOT NULL").all() as {
      held_by: string;
    }[];
    this.holdingSet = new Set(rows.map((r) => r.held_by));
  }

  devices(owner: string): Device[] {
    let d = this.devicesByOwner.get(owner);
    if (!d) {
      d = listDevices((x) => x.owner === owner);
      this.devicesByOwner.set(owner, d);
    }
    return d;
  }

  computersOf(owner: string): Device[] {
    return this.devices(owner).filter(isComputer);
  }

  off(owner: string): Set<string> {
    let o = this.offByOwner.get(owner);
    if (!o) {
      o = offOf(owner);
      this.offByOwner.set(owner, o);
    }
    return o;
  }

  balance(owner: string): Balance {
    let b = this.balanceByOwner.get(owner);
    if (!b) {
      b = readBalanceSync(owner);
      this.balanceByOwner.set(owner, b);
    }
    return b;
  }

  folders(owner: string): StorageFolder[] {
    let f = this.foldersByOwner.get(owner);
    if (!f) {
      f = foldersOf(owner);
      this.foldersByOwner.set(owner, f);
    }
    return f;
  }

  busyEditors(owner: string): Set<string> {
    let s = this.busyEditorsByOwner.get(owner);
    if (!s) {
      s = new Set(
        computers(owner)
          .filter((c) => !c.free && isOnline(c.x.id))
          .map((c) => c.x.id),
      );
      this.busyEditorsByOwner.set(owner, s);
    }
    return s;
  }

  row(versionId: string | null): LibRow | undefined {
    if (!versionId) return undefined;
    if (this.rows.has(versionId)) return this.rows.get(versionId) ?? undefined;
    const r = rowOf(versionId) ?? null;
    this.rows.set(versionId, r);
    return r ?? undefined;
  }

  private placeInfo(versionId: string) {
    let pv = this.placeVersions.get(versionId);
    if (!pv) {
      const v = libraryDb()
        .prepare(
          "SELECT root, root_rel, EXISTS (SELECT 1 FROM version_places p WHERE p.version_id = v.id AND p.state <> 'gone') AS has_place FROM asset_versions v WHERE id = ?",
        )
        .get(versionId) as { root: string | null; root_rel: string | null; has_place: number } | undefined;
      pv = { root: v?.root ?? null, root_rel: v?.root_rel ?? null, hasPlace: !!v?.has_place, ownByDev: new Map() };
      this.placeVersions.set(versionId, pv);
    }
    return pv;
  }

  hasAnyPlace(versionId: string): boolean {
    return this.placeInfo(versionId).hasPlace;
  }

  tries(r: { id: string; mac_path: string | null; mac_device: string | null }, host: string, folders: StorageFolder[]): string[] {
    const key = `${r.id}\0${host}`;
    const hit = this.triesCache.get(key);
    if (hit) return hit;
    const pv = this.placeInfo(r.id);
    let own = pv.ownByDev.get(host);
    if (own === undefined) {
      const row = libraryDb().prepare(`SELECT ${OWN} AS own FROM asset_versions v WHERE v.id = ?`).get(host, r.id) as
        | { own: string | null }
        | undefined;
      own = row?.own ?? null;
      pv.ownByDev.set(host, own);
    }
    const out = placesFor(
      { root: pv.root, root_rel: pv.root_rel, mac_path: r.mac_path, mac_device: r.mac_device },
      { id: host, disks: deviceOf(host)?.report?.machine?.disks ?? [] },
      own,
      folders,
    );
    this.triesCache.set(key, out);
    return out;
  }

  fileFor(r: FileRow, host: string, folders: StorageFolder[]): FileAt | null {
    const key = `${r.id}\0${host}\0${r.proxy ? 1 : 0}`;
    if (this.fileForCache.has(key)) return this.fileForCache.get(key) ?? null;
    let out: FileAt | null = null;
    if (!r.mac_path && r.source_path) {
      const there = isThisMachine(host) ? r.source_path : hostPath(r.source_path, folders, host);
      if (there) out = { path: there };
    }
    if (!out) {
      const first = this.tries(r, host, folders)[0];
      if (first) out = { path: first };
      else if (lightKey(r)) out = { copy: "proxy" };
    }
    this.fileForCache.set(key, out);
    return out;
  }

  pathOn(device: string, r: PlaceRow, folders: StorageFolder[]): string | null {
    const useMac = r.source_key.startsWith("mac:") || !!r.mac_path || !r.from_path;
    const macPath = useMac ? r.mac_path : r.from_path;
    const rawDev = useMac ? r.mac_device : r.from_device;
    const wf: FileRow = {
      id: r.version_id,
      source_key: r.source_key,
      source_path: r.source_path ?? null,
      mac_path: macPath,
      mac_device: rawDev ? resolveDevice(rawDev) : null,
      proxy: null,
    };
    const f = this.fileFor(wf, device, folders);
    return f && "path" in f ? f.path : null;
  }

  lookHeld(device: string): boolean {
    let h = this.lookHeldCache.get(device);
    if (h === undefined) {
      h = lookHeldOn(device, this.now);
      this.lookHeldCache.set(device, h);
    }
    return h;
  }

  asks(x: Device): boolean {
    if (this.now - BOOT < POLL_FRESH_MS) return true;
    return (
      claimsFresh(x, this.now) ||
      polls(x, this.now) ||
      relayBusy(x, this.now) ||
      this.holdingSet.has(x.id) ||
      this.lookHeld(x.id)
    );
  }

  busy(x: Device): boolean {
    return (
      this.holdingSet.has(x.id) ||
      this.lookHeld(x.id) ||
      this.busyEditors(x.owner).has(x.id) ||
      relayBusy(x, this.now)
    );
  }

  proxyJobOf(versionId: string): JobRow | undefined {
    if (this.proxyJobs.has(versionId)) return this.proxyJobs.get(versionId) ?? undefined;
    const p =
      (libraryDb()
        .prepare("SELECT * FROM jobs WHERE version_id = ? AND kind = 'proxy' AND state IN ('queued', 'running') ORDER BY id DESC LIMIT 1")
        .get(versionId) as JobRow | undefined) ?? null;
    this.proxyJobs.set(versionId, p);
    return p ?? undefined;
  }
}

const READS_PROXY = new Set(["thumb", "wave", "sprite", "fingerprint", "transcribe", "describe"]);
const SETTINGS_HELD = new Set(["offInBalancing", "notThisLibrary", "noOriginals"]);

function liftedFolderLine(ctx: Ctx, owner: string, r: LibRow, C: Device[]): string | undefined {
  const w = where(r);
  const at = w.mac_path ?? w.source_path;
  if (!at) return undefined;
  const folders = ctx.folders(owner);
  const m = folderFor(at, folders, w.mac_device ?? undefined) ?? folderFor(at, folders);
  if (!m) return undefined;
  const takers = C.filter((x) => !isThisMachine(x.id));
  if (!takers.length) return undefined;
  const reads = takers.filter((x) => {
    const f = ctx.fileFor(w, x.id, folders);
    return !!f && "path" in f;
  });
  const name = m.folder.name;
  if (reads.length) return `Only ${either(reads.map((x) => x.name))} can read ${name}`;
  const share = m.folder.mount?.share;
  return share
    ? `No computer can read ${name}: connect ${share} on ${either(takers.map((x) => x.name))}`
    : `No computer can read ${name}: add its folder to a computer in Settings → Folders`;
}

type HeldKind = "offInBalancing" | "notThisLibrary" | "noOriginals" | "updateOn" | "lowDiskOn" | "noLooksOn";

function heldReason(ctx: Ctx, x: Device, job: JobRow, r: LibRow): { kind: HeldKind; line: string } | null {
  const c = x.name;
  const off = ctx.off(x.owner);
  if (off.has(x.id)) return { kind: "offInBalancing", line: offInBalancing(c) };
  const b = ctx.balance(x.owner);
  const isLook = job.kind === "look";
  if (!isLook && !allowsLibrary(b, x.id, r.library_id)) return { kind: "notThisLibrary", line: notThisLibrary(c) };
  if (!isLook && job.kind === "proxy") {
    const folders = ctx.folders(x.owner);
    const lx = lift(x, ctx.now);
    const realRank = libraryRank(lx, job, r, folders, b);
    const liftedRank = libraryRank(lx, job, r, folders, openBalance(b, x));
    if (realRank === 0 && liftedRank === 1 && !takesOriginals(b, x)) {
      return { kind: "noOriginals", line: noOriginals(c) };
    }
  }
  const tooOldSet = x.work?.tooOld !== undefined && x.work.v <= x.work.tooOld;
  const pollBelowMin = polls(x, ctx.now) && (x.work?.v ?? 0) < WORK_MIN;
  const claimWithoutLib = claimsFresh(x, ctx.now) && !x.work?.library;
  if (tooOldSet || pollBelowMin || claimWithoutLib || oldApp(x, ctx.now)) {
    return { kind: "updateOn", line: updateOn(c) };
  }
  if (x.work?.lowDisk && x.work.lowDiskAt !== undefined && ctx.now - x.work.lowDiskAt < LOW_DISK_FRESH_MS) {
    return { kind: "lowDiskOn", line: lowDiskOn(c) };
  }
  if (isLook && x.kinds !== undefined && !x.kinds.includes(LIBRARY_LOOK_KIND)) {
    return { kind: "noLooksOn", line: noLooksOn(c) };
  }
  return null;
}

function rankMembers(ctx: Ctx, members: Device[], job: JobRow, r: LibRow, owner: string, useOpenBalance: boolean): Device[] {
  if (members.length <= 1) return members;
  const b = ctx.balance(owner);
  if (job.kind === "look") {
    const workers: WorkerSeen[] = members
      .filter((x) => x.report?.machine)
      .map((x) => ({ host: x.id, at: ctx.now, machine: x.report!.machine, never: [] }));
    return [...members].sort((a, d) => {
      const aOk = mayClaim(LIBRARY_LOOK_KIND, a.id, workers, b, ctx.now, ONLINE_MS) ? 1 : 0;
      const dOk = mayClaim(LIBRARY_LOOK_KIND, d.id, workers, b, ctx.now, ONLINE_MS) ? 1 : 0;
      return dOk - aOk;
    });
  }
  const folders = ctx.folders(owner);
  const ranked = members.map((x) => {
    const me = takesLibrary(x) ? x : lift(x, ctx.now);
    const bal = useOpenBalance ? openBalance(b, x) : b;
    return { x, r: libraryRank(me, job, r, folders, bal) };
  });
  return ranked
    .sort((a, d) => {
      if (d.r !== a.r) return d.r - a.r;
      const peers = ranked.filter((p) => p.r === a.r && p.x.report?.machine);
      const workers: WorkerSeen[] = peers.map(({ x }) => ({ host: x.id, at: ctx.now, machine: x.report!.machine, never: [] }));
      const aOk = mayClaim(job.kind, a.x.id, workers, b, ctx.now, ONLINE_MS) ? 1 : 0;
      const dOk = mayClaim(job.kind, d.x.id, workers, b, ctx.now, ONLINE_MS) ? 1 : 0;
      return dOk - aOk;
    })
    .map((p) => p.x);
}

export function classifyJob(ctx: Ctx, job: JobRow, seenInPass = new Map<number, WaitClass>()): WaitClass {
  const hit = seenInPass.get(job.id);
  if (hit) return hit;

  const r = ctx.row(job.version_id);
  const isLook = job.kind === "look" && job.state === "needs_key" && job.error === MAC_WAITS;
  const owner = (isLook ? r?.created_by : job.actor) ?? job.actor;

  // A job that reads the proxy while the version's proxy job is queued or running takes the proxy job's class (running with held_by -> queued).
  if (!isLook && r && READS_PROXY.has(job.kind) && !r.proxy) {
    const p = ctx.proxyJobOf(r.id);
    if (p && p.id !== job.id) {
      if (p.state === "running") {
        if (p.held_by) {
          const out: WaitClass = { wait: "queued", actor: job.actor };
          seenInPass.set(job.id, out);
          return out;
        }
      } else if (p.state === "queued") {
        const pClass = classifyJob(ctx, p, seenInPass);
        const out: WaitClass = { ...pClass, actor: job.actor };
        seenInPass.set(job.id, out);
        return out;
      }
    }
  }

  if (!owner || !r) {
    const out: WaitClass = { wait: "cannot", reason: notOnComputers, actor: job.actor };
    seenInPass.set(job.id, out);
    return out;
  }

  const C = ctx.computersOf(owner);
  const folders = ctx.folders(owner);
  const b = ctx.balance(owner);

  let A: Device[] = [];
  if (isLook) {
    const pr: PlaceRow = {
      version_id: r.id,
      source_key: r.source_key,
      source_path: r.source_path,
      mac_path: r.mac_path,
      mac_device: r.mac_device,
      from_path: r.from_path,
      from_device: r.from_device,
    };
    A = C.filter((x) => !!ctx.pathOn(x.id, pr, folders));
  } else if (job.kind === "send" || LIBRARY_ON_COMPUTER.includes(job.kind)) {
    A = C.filter((x) => !isThisMachine(x.id) && libraryRank(lift(x, ctx.now), job, r, folders, openBalance(b, x)) > 0);
  }

  // Class 1: A is empty
  if (!A.length) {
    if (!C.length) {
      const out: WaitClass = { wait: "needs", reason: addComputer, href: "/settings/devices", actor: owner };
      seenInPass.set(job.id, out);
      return out;
    }
    const folderLine = liftedFolderLine(ctx, owner, r, C);
    if (folderLine) {
      const out: WaitClass = { wait: "needs", reason: folderLine, href: "/settings/folders", actor: owner };
      seenInPass.set(job.id, out);
      return out;
    }
    const kindRunsOnComputer =
      (job.kind === "send" || LIBRARY_ON_COMPUTER.includes(job.kind) || isLook) &&
      (job.kind !== "transcribe" || !!keySound(job.actor, r.id));
    const serverOnlyFile =
      !r.source_key.startsWith("mac:") && !r.from_device && !r.mac_device && !ctx.hasAnyPlace(r.id);
    if (!kindRunsOnComputer || serverOnlyFile) {
      const out: WaitClass = { wait: "cannot", reason: notOnComputers, actor: owner };
      seenInPass.set(job.id, out);
      return out;
    }
    const onlineC = C.find((x) => isOnline(x.id));
    if (onlineC) {
      const gap = ctx.identityGaps.get(r.library_id) ?? {
        versions: new Set<string>(),
        onlineComputer: onlineC.name,
        fromId: r.mac_device ?? r.from_device ?? "unknown",
      };
      gap.versions.add(r.id);
      ctx.identityGaps.set(r.library_id, gap);
    }
    const out: WaitClass = { wait: "cannot", reason: fileUnchecked, actor: owner };
    seenInPass.set(job.id, out);
    return out;
  }

  // Held & Allowed
  const heldByDev = new Map<string, { kind: HeldKind; line: string }>();
  const L: Device[] = [];
  for (const x of A) {
    const h = heldReason(ctx, x, job, r);
    if (h) heldByDev.set(x.id, h);
    else L.push(x);
  }

  // Class 2: L is empty
  if (!L.length) {
    const rankedA = rankMembers(ctx, A, job, r, owner, true);
    const top = heldByDev.get(rankedA[0]!.id)!;
    const allSettings = A.every((x) => SETTINGS_HELD.has(heldByDev.get(x.id)!.kind));
    const out: WaitClass = allSettings
      ? { wait: "needs", reason: top.line, href: "/settings/devices", actor: owner }
      : { wait: "set", reason: top.line, actor: owner };
    seenInPass.set(job.id, out);
    return out;
  }

  // Class 3: No member of L asks
  const askingL = L.filter((x) => ctx.asks(x));
  if (!askingL.length) {
    const rankedL = rankMembers(ctx, L, job, r, owner, false);
    const top = rankedL[0]!;
    const line = refused(top, ctx.now, ctx.off(owner), ctx.holdingSet) ? addAgain(top.name) : offline(top.name);
    const out: WaitClass = {
      wait: "offline",
      reason: line,
      device: top.id,
      devices: rankedL.map((x) => x.id),
      actor: owner,
    };
    seenInPass.set(job.id, out);
    return out;
  }

  // Class 4: Every asking member of L is busy -> queued
  const freeAskingL = askingL.filter((x) => !ctx.busy(x));
  if (!freeAskingL.length) {
    const out: WaitClass = { wait: "queued", actor: owner };
    seenInPass.set(job.id, out);
    return out;
  }

  // Class 5: queued (stuck is added in CT-3b)
  const out: WaitClass = { wait: "queued", actor: owner };
  seenInPass.set(job.id, out);
  return out;
}

const HELD_SQL = `(j.kind IN ('describe', 'look') AND j.state != 'needs_key' AND (IFNULL(j.error, '') LIKE ? OR IFNULL(j.error, '') = '${BUDGET_WAITS.replace(/'/g, "''")}'))`;

function candidateJobs(libraryId: string, now: number): (JobRow & { source_key: string | null })[] {
  const kinds = [...new Set(["send", ...leaveToComputers.kinds, ...DECODES])];
  const marks = kinds.map(() => "?").join(", ");
  return libraryDb()
    .prepare(
      `SELECT j.*, v.source_key FROM jobs j LEFT JOIN asset_versions v ON v.id = j.version_id
       WHERE j.library_id = ?
         AND ((j.state = 'queued' AND j.run_after <= ? AND NOT ${HELD_SQL} AND j.kind IN (${marks}))
              OR (j.kind = 'look' AND j.state = 'needs_key' AND j.error = ?))
       ORDER BY j.id LIMIT 500`,
    )
    .all(libraryId, now, LIMIT_LIKE, ...kinds, MAC_WAITS) as unknown as (JobRow & { source_key: string | null })[];
}

function classifyLibrary(ctx: Ctx, libraryId: string): WaitSnapshot {
  const rows = candidateJobs(libraryId, ctx.now);
  const byJob = new Map<number, WaitClass>();
  const queuedIds: number[] = [];
  const waitingIds: number[] = [];
  const queuedLookIds: number[] = [];
  const queuedLookVersions = new Set<string>();
  const seenInPass = new Map<number, WaitClass>();

  for (const j of rows) {
    const isLook = j.kind === "look" && j.state === "needs_key" && j.error === MAC_WAITS;
    if (!isLook && !leftHere(j)) continue;
    try {
      const c = classifyJob(ctx, j, seenInPass);
      byJob.set(j.id, c);
      if (c.wait === "queued") {
        if (isLook) {
          queuedLookIds.push(j.id);
          if (j.version_id) queuedLookVersions.add(j.version_id);
        } else {
          queuedIds.push(j.id);
        }
      } else {
        waitingIds.push(j.id);
      }
    } catch {
      // A classify that throws for one job leaves that job unclassified so it falls back to today's rule.
    }
  }

  const snap: WaitSnapshot = {
    at: ctx.now,
    byJob,
    queuedIds,
    waitingIds,
    queuedLookIds,
    queuedLookVersions: [...queuedLookVersions],
  };
  snapshots.set(libraryId, snap);
  return snap;
}

/** Serves the library's snapshot when younger than FRESH_MS (15 s); otherwise classifies that library now and stores the result. */
export function status(libraryId: string, now = Date.now()): WaitSnapshot {
  const prev = snapshots.get(libraryId);
  if (prev && now - prev.at < FRESH_MS && now >= prev.at) return prev;
  const ctx = new Ctx(now);
  return classifyLibrary(ctx, libraryId);
}

/**
 * Self-check (every 60 s): refreshes at most 20 libraries with candidate jobs (stalest snapshot first),
 * logs stuck and identity-gap conditions once when they start, and notifies libraryChanged on class changes.
 */
export function checkWaits(now = Date.now()): void {
  const kinds = [...new Set(["send", ...leaveToComputers.kinds, ...DECODES])];
  const marks = kinds.map(() => "?").join(", ");
  const libs = (
    libraryDb()
      .prepare(
        `SELECT DISTINCT j.library_id FROM jobs j
         WHERE (j.state = 'queued' AND j.run_after <= ? AND NOT ${HELD_SQL} AND j.kind IN (${marks}))
            OR (j.kind = 'look' AND j.state = 'needs_key' AND j.error = ?)`,
      )
      .all(now, LIMIT_LIKE, ...kinds, MAC_WAITS) as { library_id: string }[]
  )
    .map((r) => r.library_id)
    .sort((a, b) => (snapshots.get(a)?.at ?? -Infinity) - (snapshots.get(b)?.at ?? -Infinity));

  const picked = libs.slice(0, 20);
  const unpicked = new Set(libs.slice(20));
  const ctx = new Ctx(now);
  const seenJobs = new Set<number>();

  // Keep job ids from libraries that still have candidates but were beyond the 20-library cap this pass
  for (const libId of unpicked) {
    const snap = snapshots.get(libId);
    if (snap) for (const id of snap.byJob.keys()) seenJobs.add(id);
  }

  for (const libId of picked) {
    try {
      const snap = classifyLibrary(ctx, libId);
      let changed = false;
      for (const [id, c] of snap.byJob) {
        seenJobs.add(id);
        const prev = last.get(id);
        if (prev !== undefined && prev !== c.wait) changed = true;
        last.set(id, c.wait);
      }
      const gap = ctx.identityGaps.get(libId);
      if (gap && gap.versions.size > 0) {
        const gapKey = `${libId}\0${gap.onlineComputer}\0${gap.fromId}`;
        if (!loggedGap.has(gapKey)) {
          loggedGap.add(gapKey);
          console.warn(
            `[library] ${gap.versions.size} files of ${libId} have no place while ${gap.onlineComputer} is online (from ${gap.fromId})`,
          );
        }
      } else {
        for (const k of [...loggedGap]) if (k.startsWith(`${libId}\0`)) loggedGap.delete(k);
      }
      if (changed) libraryChanged(libId);
    } catch {
      // per-library try/catch so one bad library never stops the pass
    }
  }

  // Stuck log lines per (device, line) when the condition starts (populated by CT-3b)
  const stuckGroups = new Map<string, { deviceId: string; cName: string; line: string; count: number; oldest: number }>();
  for (const libId of libs) {
    const snap = snapshots.get(libId);
    if (!snap) continue;
    for (const [id, c] of snap.byJob) {
      if (c.wait === "stuck" && c.device && c.reason) {
        const key = `${c.device}\0${c.reason}`;
        const cur = stuckGroups.get(key);
        if (!cur) {
          const devName = listDevices((x) => x.id === c.device)[0]?.name ?? c.device;
          stuckGroups.set(key, { deviceId: c.device, cName: devName, line: c.reason, count: 1, oldest: id });
        } else {
          cur.count++;
          if (id < cur.oldest) cur.oldest = id;
        }
      }
    }
  }
  stuckOn.clear();
  for (const [key, g] of stuckGroups) {
    if (!stuckOn.has(g.deviceId)) stuckOn.set(g.deviceId, g.line);
    if (!loggedStuck.has(key)) {
      loggedStuck.add(key);
      console.warn(`[library] stuck on ${g.cName}: ${g.line} (${g.count} jobs, oldest ${g.oldest})`);
    }
  }
  for (const k of [...loggedStuck]) {
    if (!stuckGroups.has(k)) loggedStuck.delete(k);
  }

  for (const id of [...last.keys()]) {
    if (!seenJobs.has(id)) last.delete(id);
  }
  for (const id of [...since.keys()]) {
    if (!seenJobs.has(id)) since.delete(id);
  }
}
