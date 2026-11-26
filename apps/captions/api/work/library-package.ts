/**
 * Item 6C (and 6A's "send"): library jobs on the uploader's own computers, on the same road as the AI Editor's steps
 * (claim → package → result; contracts/work.ts LibraryPackage). A file only the server has (a phone or browser upload)
 * gets its probe, card picture, proxy, waveform, strip, fingerprint and description stills made on one of its uploader's
 * computers while one is online; the proxy job (and a probe, or a card picture with no proxy yet) may download the
 * original, and the computer deletes it after. The other kinds read the file where it is on that computer, else the
 * proxy the server has; never the original. A description: the computer cuts the stills, the server asks the actor's
 * AI. A "send" job is a file on one computer that nothing uploaded yet (library/derived.ts sendLater): only a computer
 * that has it takes it, and this server never runs it. The server runs a job no such computer can take only where its video work is on (server-work.ts).
 * A transcript on the person's key (6B) is one of them too: the computer cuts the sound from its copy, the server hears
 * it on the key (/hear, nothing decoded here), and the words come back in the result. A transcript on a computer's own
 * speech model goes the speech road instead (lib/computer-transcribe.ts), where that computer cuts the sound itself.
 */
import { Hono, type Context } from "hono";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { hostsOriginals, hostsProxies, SOUNDS, type LibraryUpload } from "../../contracts/library";
import { isWindowsPath } from "../../contracts/places";
import type { Balance, Device } from "../../contracts/providers";
import { sourcesOf } from "../../contracts/storage";
import { macAtLeast } from "../../contracts/voice";
import { MAC_WORK_SINCE, WORK_MIN, WORK_V, type LibraryPackage, type LibraryResult, type LibraryTranscript, type WorkFile } from "../../contracts/work";
import { computers, either, fileFor, foldersOf, ONLINE_MS, type FileRow } from "../editor/reach";
import { folderFor } from "../lib/storage";
import { allowsLibrary, claimsFresh, mayClaim, offOf, readBalanceSync, takesOriginals, type WorkerSeen } from "../lib/balance";
import { deviceForToken, deviceOf, isOnline, isThisMachine, listDevices, setDeviceWork, touchDevice } from "../lib/devices";
import { env } from "../lib/env";
import { libraryChanged } from "../library/access";
import { fileProxy, keepsOnlyOriginals, libraryDb, libraryProxyQuality, librarySetting, versionUpload } from "../library/db";
import { mayLeave, mayReceive, provesProxies, proxyTooBig, refuse, REFUSED_PROOF, type Received } from "../library/upload-gate";
import { recordDerived, type DerivedFile } from "../library/derived";
import { canEmbed } from "../library/embed";
import { FRAMES } from "../library/describe";
import { NEEDS_DISK } from "./cache";
import { claimJob, defer, enqueueJob, extendLease, finishJob, NOT_TRASHED, parkJob, type JobRow } from "../library/jobs";
import { lookHeldOn, lookReach, type PlaceRow } from "../library/mac-look";
import { wakePictures } from "../library/pictures";
import type { ProbeSummary } from "../library/media/probe";
import { sortAfter } from "../library/roll";
import { serveBlob } from "../library/routes";
import { askVersionIn, fileTranscript, hearSound, keySound, NeedsKey } from "../library/transcribe";
import { resolveDevice } from "../library/whereis";
import { aiWaits, described, describeFromStills, leaveToComputers } from "../library/worker";
import { hasMacFrames } from "../library/on-mac";
import { status } from "./waits";
import { mayRead } from "./offline";

/** The library jobs a computer runs; "send" only a computer can. */
export const LIBRARY_ON_COMPUTER: readonly string[] = ["probe", "thumb", "proxy", "wave", "sprite", "fingerprint", "transcribe", "describe"];
const KINDS = ["send", ...LIBRARY_ON_COMPUTER];
const LEASE_S = 300;
/** The stills a describe job sends (describe.ts FRAMES at most). */
const STILLS = Array.from({ length: FRAMES }, (_, i) => `still${i}`);
/** The files each kind may send back. */
const SENDS: Record<string, string[]> = {
  send: ["original", "proxy", "thumb", "wave", "sprite"],
  probe: [],
  thumb: ["thumb"],
  proxy: ["proxy"],
  wave: ["wave"],
  sprite: ["sprite"],
  fingerprint: [],
  transcribe: [],
  describe: STILLS,
};
/** The file each kind must send back; a job without it fails (retried), never finishes empty. */
// a proxy is not required: a clip whose proxy would be no smaller than it has none (media/proxy.ts makeProxy)
const REQUIRED: Record<string, string> = { thumb: "thumb", wave: "wave", sprite: "sprite", describe: "still0" };
/**
 * The kinds that may download the original of a file only the server has: the proxy, and the probe, card picture,
 * waveform, strip, fingerprint and description's stills it has no lighter copy for (an upload in a library that makes no
 * proxy, a Finals file).
 */
export const READS_ORIGINAL = ["proxy", "probe", "thumb", "wave", "sprite", "fingerprint", "describe"];
/** Of those, the ones that wait for a proxy on its way (the lighter read) rather than download the original too. */
const PROXY_FIRST = ["wave", "sprite", "fingerprint", "describe"];
const proxyComing = (versionId: string): boolean =>
  !!libraryDb().prepare("SELECT 1 FROM jobs WHERE version_id = ? AND kind = 'proxy' AND state IN ('queued', 'running')").get(versionId);
/** The most a small file (picture, waveform, strip) may weigh; a proxy is capped as a result file is. */
const SMALL_MAX = 16 * 1024 ** 2;
const FILE_MAX = 8 * 1024 ** 3;

/** A computer whose worker claimed with `library: true` on this server (stamping `libraryAt`) and whose package is not too old. */
export const takesLibrary = (d: Pick<Device, "work">): boolean =>
  !!d.work?.libraryAt && d.work.v >= WORK_MIN && !(d.work.tooOld !== undefined && d.work.v <= d.work.tooOld);
/** The kinds added after the first library jobs: only a computer that names them in its claim (work/library.ts LIBRARY_HERE) gets one. */
export const LATER_KINDS = ["probe", "thumb", "describe"];

export const POLL_FRESH_MS = 120_000;
// ponytail: in memory; a restart forgets it, and the boot grace in G3 covers the first POLL_FRESH_MS
export const polled = new Map<string, number>();
export const notePoll = (id: string, now = Date.now()): void => {
  polled.set(id, now);
};
export const called = new Map<string, number>();
export const noteRunnerCall = (id: string, now = Date.now()): void => {
  called.set(id, now);
};
export const polls = (d: Pick<Device, "id">, now = Date.now()): boolean => now - (polled.get(d.id) ?? -Infinity) < POLL_FRESH_MS;
const isOldAppVersion = (v?: string): boolean => /^\d+\.\d+\.\d+/.test(v ?? "") && !macAtLeast(v, MAC_WORK_SINCE);
export const oldApp = (d: Pick<Device, "id" | "version">, _now = Date.now()): boolean => isOnline(d.id) && isOldAppVersion(d.version);
export const relayBusy = (d: Pick<Device, "id" | "version">, now = Date.now()): boolean =>
  now - (called.get(d.id) ?? -Infinity) < ONLINE_MS && !polls(d, now) && !isOldAppVersion(d.version);
export const asks = (d: Pick<Device, "id" | "version" | "work">, now = Date.now()): boolean =>
  claimsFresh(d, now) || polls(d, now) || relayBusy(d, now) || holding(d.id) || lookHeldOn(d.id, now);
export const startsForLibrary = (d: Pick<Device, "id" | "work">): boolean =>
  (d.work?.v ?? 0) >= WORK_MIN && !(d.work?.tooOld !== undefined && d.work.v <= d.work.tooOld) && !takesLibrary(d) && !d.work?.libraryOnly && !isThisMachine(d.id);

export function lift(d: Device, now = Date.now()): Device {
  const { tooOld: _, ...rest } = d.work ?? { v: WORK_MIN, steps: [] };
  return {
    ...d,
    work: {
      ...rest,
      v: Math.max(d.work?.v ?? 0, WORK_MIN),
      library: true,
      at: now,
      libraryAt: now,
      libraryKinds: [...new Set([...(d.work?.libraryKinds ?? []), ...LATER_KINDS])],
    },
  };
}

export interface LibRow extends FileRow {
  library_id: string;
  asset_id: string;
  title: string;
  kind: string;
  bytes: number;
  sha256: string;
  quick: string | null;
  from_path: string | null;
  from_device: string | null;
  proxy_bytes: number | null;
  created_by?: string | null;
}

export function rowOf(versionId: string | null): LibRow | undefined {
  return libraryDb()
    .prepare(
      `SELECT v.id, v.source_key, v.source_path, v.mac_path, v.mac_device, v.from_path, v.from_device, v.probe, v.bytes, v.sha256, v.quick, v.created_by,
         a.library_id, a.id AS asset_id, a.title, a.kind, d.storage_key AS proxy, d.bytes AS proxy_bytes
       FROM asset_versions v JOIN assets a ON a.id = v.asset_id
       LEFT JOIN derivatives d ON d.version_id = v.id AND d.kind = 'proxy' WHERE v.id = ?`,
    )
    .get(versionId ?? "") as LibRow | undefined;
}

/** An original uploaded from a computer is still on that computer, where it was sent from; device ids follow re-pair aliases. */
export function where(r: LibRow): FileRow {
  const base = r.mac_path || !r.from_path ? r : { ...r, mac_path: r.from_path, mac_device: r.from_device };
  return base.mac_device ? { ...base, mac_device: resolveDevice(base.mac_device) } : base;
}

function whereOf(r: PlaceRow): FileRow {
  const useMac = r.source_key.startsWith("mac:") || !!r.mac_path || !r.from_path;
  const macPath = useMac ? r.mac_path : r.from_path;
  const rawDev = useMac ? r.mac_device : r.from_device;
  return {
    id: r.version_id,
    source_key: r.source_key,
    source_path: r.source_path ?? null,
    mac_path: macPath,
    mac_device: rawDev ? resolveDevice(rawDev) : null,
    proxy: null,
  };
}
lookReach.at = (device, r, folders) => {
  const f = fileFor(whereOf(r), device, folders, isThisMachine);
  return f && "path" in f ? f.path : null;
};

/**
 * How well computer `d` can take library job `job`: 3 has the file (on its disk, or on a share it has connected), 2 reads
 * the server's proxy, 1 downloads the original (proxy only, where its owner lets it), 0 never: also for a library not on
 * its list (Settings → Computers).
 */
export function libraryRank(d: Device, job: Pick<JobRow, "kind" | "actor">, r: LibRow, folders: ReturnType<typeof foldersOf>, b: Balance): number {
  if (!takesLibrary(d) || !allowsLibrary(b, d.id, r.library_id)) return 0;
  if (LATER_KINDS.includes(job.kind) && !d.work?.libraryKinds?.includes(job.kind)) return 0;
  // only a transcript on the person's key: the speech road takes one on a computer's model, this server one on its own
  if (job.kind === "transcribe" && !keySound(job.actor, r.id)) return 0;
  // a file indexed on a Mac is described here from the stills that Mac sent, or again from its words (library/worker.ts).
  // Stills lost (held in memory for Blur faces, gone with a restart) and never described: a computer with the file cuts them
  if (job.kind === "describe" && r.source_key.startsWith("mac:") && (hasMacFrames(r.id) || described(r.id))) return 0;
  const at = fileFor(where(r), d.id, folders, isThisMachine);
  if (at && "path" in at) return 3;
  if (job.kind === "send") return 0;
  // where the server keeps originals and no proxy (Originals alone, Blurred alone), the proxy of a file that came from a
  // computer is that computer's own to make and keep, from the file it has (on-mac.ts queues it). Never another one's,
  // which would download the whole original and keep a proxy the first never sees
  if (job.kind === "proxy" && (r.mac_device || r.from_device) && keptBeside(versionUpload(r.id))) return 0;
  // a probe reads the original's own header, never its proxy's
  if (job.kind !== "proxy" && job.kind !== "probe" && r.proxy) return 2;
  // the original only for the proxy, or a kind with no proxy to read (and none on its way)
  if (!READS_ORIGINAL.includes(job.kind) || r.source_key.startsWith("mac:") || !takesOriginals(b, d)) return 0;
  return PROXY_FIRST.includes(job.kind) && proxyComing(r.id) ? 0 : 1;
}

/**
 * Computer `d` said its Download location's disk is not connected (work/cache.ts cacheAway) and `job` needs that disk: to
 * keep the proxy it makes, or to download the server's proxy it reads. Such a job waits for the disk (waits.ts says so)
 * or goes to another computer; nothing is written to the internal disk in its place.
 */
export function needsDisk(d: Device, job: Pick<JobRow, "kind">, r: LibRow, folders: ReturnType<typeof foldersOf>): boolean {
  if (!d.work?.cache?.away || !LIBRARY_ON_COMPUTER.includes(job.kind)) return false;
  if (job.kind === "proxy") return keepsProxy(versionUpload(r.id));
  const at = fileFor(where(r), d.id, folders, isThisMachine);
  return job.kind !== "probe" && !!r.proxy && !(at && "path" in at);
}

/** The computers of `owner` that may take a library job now: `me`, and the others online, free, holding none, asking for work lately and not Off. */
export function peersOf(owner: string, me: Device, now: number): Device[] {
  const off = offOf(owner);
  return computers(owner)
    .filter((c) => c.x.id === me.id || (c.free && !holding(c.x.id) && claimsFresh(c.x, now) && !off.has(c.x.id)))
    .map((c) => (c.x.id === me.id ? me : c.x))
    .filter(takesLibrary);
}

/** Whether `device` holds a library job now (on the jobs row, so a restart of this server keeps it). */
export const holding = (device: string) => !!libraryDb().prepare("SELECT 1 FROM jobs WHERE state = 'running' AND held_by = ?").get(device);

/**
 * The job `device` holds (claimed by it, still running), else undefined: on claim `claim` when the computer names one;
 * an older computer names none and is matched by the device alone. A job taken back and claimed again has a new claim
 * id, so the first run's late beats, files and result count for nothing.
 */
export function heldBy(id: number, device: string, claim?: string): JobRow | undefined {
  const job = libraryDb().prepare("SELECT * FROM jobs WHERE id = ? AND state = 'running' AND held_by = ?").get(id, device) as JobRow | undefined;
  return job && (!claim || job.claim_id === claim) ? job : undefined;
}

/** Why a library job stops: its account may no longer see the clip (a library policy refused them since it was queued). */
export const UNSEEN = "This account can no longer see this clip";

/** Whether the job's account may still see its clip: the per-source check every library policy runs (offline.ts mayRead). */
const stillSees = async (job: JobRow, r: LibRow): Promise<boolean> => !!job.actor && (await mayRead(job.actor, r.library_id, r.asset_id, r.id));

/** A job its account may no longer see fails for good, queued or held: retrying would only be refused again. */
function failUnseen(job: JobRow): void {
  libraryDb().prepare("UPDATE jobs SET state = 'failed', lease_until = NULL, error = ? WHERE id = ? AND state IN ('queued', 'running')").run(UNSEEN, job.id);
  libraryChanged(job.library_id);
}

/** The job `device` holds while its account may still see the clip; one it may not see fails here. */
async function heldSeen(id: number, device: string, claim?: string): Promise<JobRow | undefined> {
  const job = heldBy(id, device, claim);
  const r = job && rowOf(job.version_id);
  if (!job || !r) return undefined;
  if (await stillSees(job, r)) return job;
  failUnseen(job);
  return undefined;
}

export type LibraryDecision = { take: true } | { skip: "rank" | "balance"; by?: Device };

/** The claim's per-job placement and load-balancing decision, with no claim and no database write. */
export function decide(
  d: Device,
  job: Pick<JobRow, "kind" | "actor">,
  r: LibRow,
  peers: Device[],
  folders: ReturnType<typeof foldersOf>,
  balance: Balance,
  now = Date.now(),
): LibraryDecision {
  const ranked = peers.map((x) => ({ x, r: needsDisk(x, job, r, folders) ? 0 : libraryRank(x, job, r, folders, balance) }));
  const mine = ranked.find((p) => p.x.id === d.id)?.r ?? 0;
  const top = Math.max(0, ...ranked.map((p) => p.r));
  const workers: WorkerSeen[] = ranked
    .filter((p) => p.r === top && p.x.report?.machine)
    .map(({ x }) => ({ host: x.id, at: x.id === d.id ? now : (x.lastSeen ?? 0), machine: x.report!.machine, never: [] }));
  if (!mine || mine < top) {
    const by =
      top > 0
        ? (ranked
            .filter((p) => p.r === top && p.x.id !== d.id)
            .map((p) => p.x)
            .find((x) => mayClaim(job.kind, x.id, workers, balance, now, ONLINE_MS)) ??
          ranked.find((p) => p.r === top && p.x.id !== d.id)?.x)
        : undefined;
    return { skip: "rank", ...(by ? { by } : {}) };
  }
  if (!mayClaim(job.kind, d.id, workers, balance, now, ONLINE_MS)) {
    const by =
      ranked
        .filter((p) => p.r === top && p.x.id !== d.id)
        .map((p) => p.x)
        .find((x) => mayClaim(job.kind, x.id, workers, balance, now, ONLINE_MS)) ??
      ranked.find((p) => p.r === top && p.x.id !== d.id)?.x;
    return { skip: "balance", ...(by ? { by } : {}) };
  }
  return { take: true };
}

/** The library job computer `d` takes now, with its package, or null. The best-placed of its owner's computers, then load balancing, decide. */
export async function claimLibraryForComputer(d: Device, now = Date.now()): Promise<LibraryPackage | null> {
  if (!takesLibrary(d) || offOf(d.owner).has(d.id)) return null;
  await sweepIncoming();
  const balance = readBalanceSync(d.owner);
  const queued = queuedFor(d, now, balance);
  if (!queued.length) return null;
  const db = libraryDb();
  const folders = foldersOf(d.owner);
  const peers = peersOf(d.owner, d, now);
  for (const job of queued) {
    const r = waitsForWords(job) ? undefined : rowOf(job.version_id);
    if (!r) continue;
    // a worker from before the photo fix seeks into a one-frame file, writes no card picture and fails the photo three times
    if (r.kind === "image" && !d.work?.stills) continue;
    if (!("take" in decide(d, job, r, peers, folders, balance, now))) continue;
    if (!(await stillSees(job, r))) {
      failUnseen(job);
      continue;
    }
    const got = claimJob(db, LEASE_S, now, "jobs", undefined, job.id);
    if (!got) continue;
    const claim = randomUUID();
    db.prepare("UPDATE jobs SET held_by = ?, claim_id = ? WHERE id = ?").run(d.id, claim, got.id);
    libraryChanged(got.library_id); // its card says it is being worked on
    return packageOf({ ...got, claim_id: claim }, r, d, folders);
  }
  return null;
}

function mineOf(id: string): string[] {
  const db = libraryDb();
  const seen = new Set<string>([id]);
  const q = [id];
  while (q.length) {
    const cur = q.pop()!;
    for (const r of db.prepare("SELECT old_id FROM device_alias WHERE new_id = ?").all(cur) as { old_id: string }[]) {
      if (!seen.has(r.old_id)) {
        seen.add(r.old_id);
        q.push(r.old_id);
      }
    }
  }
  return [...seen];
}

function reachPrefixes(d: Device): { prefixes: string[]; win: boolean } {
  const out = new Set<string>();
  for (const f of sourcesOf(foldersOf(d.owner))) {
    if (f.role !== "footage") continue;
    if (f.origin.host !== d.id && !f.reach?.[d.id]) continue;
    for (const p of [f.origin.path, f.mountPath, ...Object.values(f.reach ?? {}).map((r) => r.path)]) {
      if (p) out.add(p.replace(/(.)\/+$/, "$1"));
    }
  }
  const prefixes = [...out];
  return { prefixes, win: prefixes.some(isWindowsPath) };
}

/** The queued library jobs of `d`'s owner, in the libraries `d` takes, dropping rows in SQL that rank 0 for `d` whatever its settings. */
export function queuedFor(d: Device, now = Date.now(), balance: Balance = readBalanceSync(d.owner)): JobRow[] {
  const libs = balance.libraries?.[d.id];
  if (libs && !libs.length) return [];
  const mineJson = JSON.stringify(mineOf(d.id));
  const { prefixes, win } = reachPrefixes(d);
  const prefixesJson = JSON.stringify(prefixes);
  // ponytail: when any of those paths is a Windows path, inside() folds case and slashes, so keep every row with a mac_path/from_path
  const inFolder = win
    ? "(v.mac_path IS NOT NULL OR v.from_path IS NOT NULL)"
    : `(EXISTS (SELECT 1 FROM json_each(?) f WHERE v.mac_path = f.value OR substr(v.mac_path, 1, length(f.value) + 1) = f.value || '/')` +
      ` OR EXISTS (SELECT 1 FROM json_each(?) f WHERE v.from_path = f.value OR substr(v.from_path, 1, length(f.value) + 1) = f.value || '/'))`;
  const noReach =
    `v.source_path IS NULL AND v.root IS NULL` +
    ` AND NOT (v.from_path IS NOT NULL AND v.from_device IS NOT NULL AND v.from_device IN (SELECT value FROM json_each(?)))` +
    ` AND NOT (v.mac_path IS NOT NULL AND v.mac_device IS NOT NULL AND v.mac_device IN (SELECT value FROM json_each(?)))` +
    ` AND NOT EXISTS (SELECT 1 FROM version_places p WHERE p.version_id = v.id AND p.device = ?)` +
    ` AND NOT ${inFolder}`;
  const reachArgs = win ? [mineJson, mineJson, d.id] : [mineJson, mineJson, d.id, prefixesJson, prefixesJson];
  // keySound is the one rule (libraryRank): a version nobody asked about follows the owner's own route
  const keyOn = !!keySound(d.owner, "");
  const askedJson = JSON.stringify([...askVersionIn].flatMap(([v, a]) => (a.by === d.owner && keySound(d.owner, v) ? [v] : [])));
  const origOk = takesOriginals(balance, d);
  const sql =
    `SELECT j.* FROM jobs j LEFT JOIN asset_versions v ON v.id = j.version_id` +
    ` WHERE j.state = 'queued' AND j.run_after <= ? AND j.actor = ? AND j.kind IN (${KINDS.map(() => "?").join(", ")}) AND ${NOT_TRASHED}` +
    (libs ? ` AND j.library_id IN (${libs.map(() => "?").join(", ")})` : "") +
    ` AND NOT (j.kind = 'send' AND (${noReach}))` +
    (keyOn ? "" : ` AND NOT (j.kind = 'transcribe' AND (j.version_id IS NULL OR j.version_id NOT IN (SELECT value FROM json_each(?))))`) +
    (origOk ? ` AND NOT (j.kind = 'proxy' AND (${noReach}) AND v.source_key LIKE 'mac:%')` : ` AND NOT (j.kind = 'proxy' AND (${noReach}))`) +
    // with no proxy to read, the original where this computer may download it and no proxy is on its way (libraryRank)
    ` AND NOT (j.kind IN (${PROXY_FIRST.map((k) => `'${k}'`).join(", ")}) AND (${noReach}) AND NOT EXISTS (SELECT 1 FROM derivatives px WHERE px.version_id = v.id AND px.kind = 'proxy' AND px.storage_key IS NOT NULL)` +
    (origOk ? ` AND (v.source_key LIKE 'mac:%' OR EXISTS (SELECT 1 FROM jobs pj WHERE pj.version_id = v.id AND pj.kind = 'proxy' AND pj.state IN ('queued', 'running'))))` : ")") +
    " ORDER BY j.id LIMIT 100";
  const args: (string | number)[] = [
    now,
    d.owner,
    ...KINDS,
    ...(libs ?? []),
    ...reachArgs,
    ...(keyOn ? [] : [askedJson]),
    ...reachArgs,
    ...reachArgs,
  ];
  return libraryDb().prepare(sql).all(...args) as unknown as JobRow[];
}

/** A description reads what is said: it waits while its clip's transcript is still to come (library/worker.ts nextJob). */
function waitsForWords(job: JobRow): boolean {
  return job.kind === "describe" && !!libraryDb().prepare("SELECT 1 FROM jobs WHERE version_id = ? AND kind = 'transcribe' AND state IN ('queued', 'running')").get(job.version_id);
}

/** A proxy a computer makes stays in its cache, never sent, where the server hosts no proxies (Upload off, Originals only). */
export const keepsProxy = (upload: LibraryUpload | null | undefined): boolean => !hostsProxies(upload);
/** The server takes the original and no proxy of it (Originals alone; under Blur faces, Blurred alone): its computer keeps the proxy beside the file it sent. */
const keptBeside = (upload: LibraryUpload | null | undefined): boolean => hostsOriginals(upload) && !hostsProxies(upload);

function packageOf(job: JobRow, r: LibRow, d: Device, folders: ReturnType<typeof foldersOf>): LibraryPackage {
  const at = fileFor(where(r), d.id, folders, isThisMachine);
  const file: WorkFile = {
    id: r.id,
    title: r.title,
    bytes: r.bytes,
    ...(r.quick ? { quick: r.quick } : r.sha256.startsWith("mac:") ? { quick: r.sha256.slice(4) } : {}),
    ...(at && "path" in at ? { path: at.path } : {}),
    ...(r.proxy && !["proxy", "probe", "send"].includes(job.kind) ? { proxy: { bytes: r.proxy_bytes ?? 0 } } : {}),
  };
  const upload = versionUpload(r.id);
  const send = job.kind === "send" && (hostsOriginals(upload) || hostsProxies(upload));
  const asked = fileProxy(r.id);
  const proxyOn = asked !== "no" && (asked === "yes" || (!keepsOnlyOriginals(r.library_id) && librarySetting(r.library_id, "proxy")));
  return {
    v: WORK_V,
    job: { id: job.id, kind: job.kind, versionId: r.id, libraryId: r.library_id, actor: job.actor ?? d.owner, ...(job.claim_id ? { claim: job.claim_id } : {}) },
    file,
    folders: folders.flatMap((f) => {
      const p = f.reach[d.id]?.path ?? (f.origin.host === d.id ? f.origin.path : undefined);
      return p ? [p] : [];
    }),
    ...(READS_ORIGINAL.includes(job.kind) && !r.source_key.startsWith("mac:") && (job.kind === "proxy" || job.kind === "probe" || !r.proxy) ? { original: { bytes: r.bytes } } : {}),
    ...(r.probe && job.kind !== "send" ? { probe: JSON.parse(r.probe) as Record<string, unknown> } : {}),
    ...(job.kind === "transcribe" ? { audio: keySound(job.actor, r.id) ?? "wav" } : {}),
    ...(send
      ? {
          // older workers read only "proxies" | "all": Originals only is sent as "all" with no proxy (UNIFIED-PRD §4.2, E9)
          upload: hostsProxies(upload) && !hostsOriginals(upload) ? "proxies" : "all",
          // the add's own answer (db.ts fileProxy): Skip processing makes none, Generate proxies one; else the switch.
          // Hosted proxies with it on: every video is made here and sent (UNIFIED-PRD §4.1, §4.2); hosting alone makes
          // none (owner, 2026-11-25), and with no proxy nothing is sent (upload-gate.ts refuses the original)
          proxy: { cloud: hostsProxies(upload) && proxyOn, on: proxyOn, quality: libraryProxyQuality(r.library_id) },
          music: !!libraryDb()
            .prepare(`SELECT 1 FROM asset_tags t JOIN asset_versions av ON av.asset_id = t.asset_id WHERE av.id = ? AND t.source = 'user' AND t.tag IN (${Object.values(SOUNDS).map(() => "?").join(", ")})`)
            .get(r.id, ...Object.values(SOUNDS).map((s) => s.tag)),
        }
      : {}),
    // a proxy job encodes at the library's Proxy quality (media/proxy.ts makeProxy)
    ...(job.kind === "proxy" ? { proxy: { cloud: false, on: false, quality: libraryProxyQuality(r.library_id) } } : {}),
    // the server hosts no proxies (Upload off, or Originals only): a proxy is made here and kept in this computer's
    // cache, never sent (cache.ts keepProxy); the editor plays it from there
    ...(job.kind === "proxy" && keepsProxy(upload) ? { keepProxy: true } : {}),
  };
}

/**
 * Whether this server's loop leaves library job `job` to a computer: a "send" always (only that computer has the file);
 * another while one of the uploader's computers online can take it, or will once the proxy a computer is making is here.
 */
export function computerTakesLibrary(job: JobRow): boolean {
  if (job.kind === "send") return true;
  // a proxy a computer keeps of its own file waits for that computer, as a send does: this server would take the job
  // and end it with no proxy made (it keeps none here, library/worker.ts)
  const mine = job.kind === "proxy" ? rowOf(job.version_id) : undefined;
  if (mine && (mine.mac_device || mine.from_device) && keptBeside(versionUpload(mine.id))) return true;
  if (!job.actor || !LIBRARY_ON_COMPUTER.includes(job.kind)) return false;
  const off = offOf(job.actor);
  const own = listDevices((x) => x.owner === job.actor && isOnline(x.id) && takesLibrary(x) && !off.has(x.id));
  const starters = listDevices((x) => x.owner === job.actor && isOnline(x.id) && polls(x) && startsForLibrary(x) && !off.has(x.id));
  const r = own.length || starters.length ? rowOf(job.version_id) : undefined;
  if (!r) return false;
  const folders = foldersOf(job.actor);
  const balance = readBalanceSync(job.actor);
  if (own.some((x) => libraryRank(x, job, r, folders, balance) > 0)) return true;
  if (starters.some((x) => libraryRank(lift(x), job, r, folders, balance) === 3)) return true;
  // a later kind no computer of theirs runs yet (an older app): this server's, as before
  if (job.kind === "proxy" || (LATER_KINDS.includes(job.kind) && !own.some((x) => x.work?.libraryKinds?.includes(job.kind)) && !starters.length)) return false;
  const p = libraryDb().prepare("SELECT * FROM jobs WHERE version_id = ? AND kind = 'proxy' AND state IN ('queued', 'running')").get(r.id) as JobRow | undefined;
  return !!p && (p.state === "running" ? !!p.held_by : computerTakesLibrary(p));
}
leaveToComputers.kinds = KINDS;
leaveToComputers.test = computerTakesLibrary;
leaveToComputers.line = libraryWaitLine;
leaveToComputers.status = status;

/**
 * Why a library job no computer can take now waits, naming its folder: "Only Mac Studio can read Shoots" (that one is
 * off or away), or "No computer can read Shoots: connect Footage on Linux box" (none has its share connected). Undefined
 * when no computer takes library work at all, or the file is in no folder: the plain line says it then.
 */
export function libraryWaitLine(job: JobRow): string | undefined {
  const r = job.actor ? rowOf(job.version_id) : undefined;
  if (!r || !job.actor) return undefined;
  const w = where(r);
  const at = w.mac_path ?? w.source_path;
  const folders = foldersOf(job.actor);
  const m = at ? (folderFor(at, folders, w.mac_device ?? undefined) ?? folderFor(at, folders)) : null;
  if (!m) return undefined;
  const off = offOf(job.actor);
  const balance = readBalanceSync(job.actor);
  const takers = listDevices((x) => x.owner === job.actor && (takesLibrary(x) || startsForLibrary(x)) && !off.has(x.id) && allowsLibrary(balance, x.id, r.library_id));
  if (!takers.length) return undefined;
  const reads = takers.filter((x) => {
    const f = fileFor(w, x.id, folders, isThisMachine);
    return !!f && "path" in f;
  });
  const name = m.folder.name;
  if (reads.length) return `Only ${either(reads.map((x) => x.name))} can read ${name}`;
  const share = m.folder.mount?.share;
  return share
    ? `No computer can read ${name}: connect ${share} on ${either(takers.map((x) => x.name))}`
    : `No computer can read ${name}: add its folder to a computer in Settings → Folders`;
}

/** Whether a library job waits that computer `d` would be handed now: its device runner's long poll starts the worker. */
export async function libraryWaits(d: Device, now = Date.now()): Promise<boolean> {
  if ((!takesLibrary(d) && !startsForLibrary(d)) || offOf(d.owner).has(d.id)) return false;
  const me = takesLibrary(d) ? d : lift(d, now);
  const balance = readBalanceSync(d.owner);
  const queued = queuedFor(me, now, balance);
  if (!queued.length) return false;
  const folders = foldersOf(d.owner);
  const peers = peersOf(d.owner, me, now);
  return queued.some((job) => {
    const r = waitsForWords(job) ? undefined : rowOf(job.version_id);
    if (!r) return false;
    const ranked = peers.map((x) => ({ x, r: libraryRank(x, job, r, folders, balance) }));
    const mine = ranked.find((p) => p.x.id === me.id)?.r ?? 0;
    const top = Math.max(0, ...ranked.map((p) => p.r));
    if (!mine || mine < top) return false;
    const workers: WorkerSeen[] = ranked
      .filter((p) => p.r === top && p.x.report?.machine)
      .map(({ x }) => ({ host: x.id, at: x.id === me.id ? now : (x.lastSeen ?? 0), machine: x.report!.machine, never: [] }));
    return mayClaim(job.kind, me.id, workers, balance, now, ONLINE_MS);
  });
}

const incoming = (jobId: number) => path.join(env.dataDir, "library", "incoming", String(jobId));
/** What a computer sent for a job it no longer holds (it went away mid-job, its lease ran out): a description's stills
 *  among them, which are kept only for that job's call. Gone before work is handed out again. */
export async function sweepIncoming(): Promise<void> {
  const dir = path.join(env.dataDir, "library", "incoming");
  const running = libraryDb().prepare("SELECT 1 FROM jobs WHERE id = ? AND state = 'running'");
  for (const n of await readdir(dir).catch(() => [] as string[])) if (!running.get(Number(n))) await rm(path.join(dir, n), { recursive: true, force: true });
}
const NAME = /^(original|proxy|thumb|wave|sprite|still\d)$/;

/** Passes at most `cap` bytes, then fails the stream. */
function capped(cap: number): Transform {
  let n = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      n += chunk.length;
      done(n > cap ? new Error("The file is larger than allowed") : null, chunk);
    },
  });
}

/**
 * A file a held job sends, streamed to its incoming folder under its cap; false when it may not send it, "gone" when the
 * job is not held, the gate's refusal (upload-gate.ts) when the library does not take it. `declared`: the SHA-256 a
 * computer declared for a proxy before sending it; the bytes must hash to it.
 */
export async function acceptLibraryFile(
  jobId: number,
  deviceId: string,
  name: string,
  body: Readable,
  claim?: string,
  declared?: string,
): Promise<boolean | "gone" | Exclude<Received, { ok: true }>> {
  const job = heldBy(jobId, deviceId, claim);
  if (!job) return "gone";
  if (!NAME.test(name) || !SENDS[job.kind]?.includes(name as DerivedFile) || !job.version_id) return false;
  const r = rowOf(job.version_id);
  // a proxy of a file only a computer has (`mac:`) is that computer's upload; one of the server's own original is made from it
  // a still is held for its description's call only, a waveform is numbers; a card picture or strip is kept for every clip (Blur faces asks none)
  const kind = name === "original" ? "original" : name === "proxy" && r?.source_key.startsWith("mac:") ? "proxy" : name.startsWith("still") ? "held" : name === "wave" || name === "thumb" || name === "sprite" ? "data" : "derivative";
  const sender = deviceOf(deviceId);
  const into = { id: job.library_id, versionId: job.version_id };
  const must = provesProxies(sender) && kind === "proxy";
  const before = mayReceive(kind, into, "computer", { sender, ...(must ? { proof: { sha256: declared ?? "" } } : {}) });
  if (!before.ok) return before;
  const cap = name === "original" ? (r?.bytes ?? 0) : name === "proxy" ? FILE_MAX : SMALL_MAX;
  await mkdir(incoming(jobId), { recursive: true });
  const out = path.join(incoming(jobId), name);
  const hash = createHash("sha256");
  let bytes = 0;
  const tally = new Transform({
    transform(chunk: Buffer, _enc, done) {
      hash.update(chunk);
      bytes += chunk.length;
      done(null, chunk);
    },
  });
  try {
    await pipeline(body, capped(cap), tally, createWriteStream(out));
  } catch {
    await rm(out, { force: true });
    return false;
  }
  if (kind === "proxy") {
    const after = mayReceive("proxy", into, "computer", { sender, proof: { ...(declared ? { sha256: declared } : {}), got: hash.digest("hex"), bytes, original: r?.bytes } });
    if (!after.ok) {
      await rm(out, { force: true }); // not the proxy it said: nothing of it is kept
      return after;
    }
  } else if (name === "proxy" && proxyTooBig(bytes, r?.bytes)) {
    // a proxy of a file the server holds (a phone's, under none too) is a derivative, but no smaller than its original is not kept
    await rm(out, { force: true });
    return refuse(REFUSED_PROOF);
  }
  return true;
}

/**
 * The job's result, filed while `deviceId` still holds it: the files and rows through recordDerived, then the job done.
 * "done", "failed" when the result was missing what its kind makes (or said it failed), "gone" when the job is not held.
 */
export async function applyLibraryResult(jobId: number, deviceId: string, r: LibraryResult, claim?: string): Promise<"done" | "failed" | "gone"> {
  const job = heldBy(jobId, deviceId, claim);
  if (!job) return "gone";
  const db = libraryDb();
  const failed = (why: string) => (failLibrary(job, why), "failed" as const);
  try {
    if ("error" in r.outcome) return failed(r.outcome.error);
    const there = new Set(await readdir(incoming(jobId)).catch(() => [] as string[]));
    const sent = Object.fromEntries((r.files as string[]).filter((f) => there.has(f) && SENDS[job.kind]?.includes(f)).map((f) => [f, path.join(incoming(jobId), f)]));
    // the kind's own file, or the job is not done: a refused upload is a failed try, never a finished job with nothing
    const need = REQUIRED[job.kind];
    if (need && !sent[need]) return failed(`Your computer's ${need} did not arrive`);
    const stills = STILLS.flatMap((s) => (sent[s] ? [sent[s]] : []));
    const files = Object.fromEntries(Object.entries(sent).filter(([f]) => !STILLS.includes(f))) as Partial<Record<DerivedFile, string>>;
    const probes = job.kind === "send" || job.kind === "probe";
    const probe = probes && r.probe && typeof r.probe === "object" ? (r.probe as unknown as ProbeSummary) : undefined;
    const fingerprint = (job.kind === "fingerprint" || job.kind === "send") && typeof r.fingerprint === "string" && r.fingerprint.length < 1_000_000 ? r.fingerprint : undefined;
    const hex = (x: unknown) => (typeof x === "string" && /^[0-9a-f]{64}$/.test(x) ? x : undefined);
    const sha256 = job.kind === "send" ? hex(r.sha256) : undefined;
    const quick = probes ? hex(r.quick) : undefined;
    if (probes && !probe) return failed("Your computer sent no probe of the file");
    if (job.kind === "fingerprint" && !fingerprint) return failed("Your computer sent no fingerprint");
    if (job.kind === "transcribe") {
      const t = transcriptOf(r.transcript);
      if (!t) return failed("Your computer sent no transcript");
      fileTranscript(db, job.version_id!, job.actor, t);
      // new words to search by meaning, as after a transcript made here (library/worker.ts)
      if (librarySetting(job.library_id, "embed") && canEmbed(job.actor)) enqueueJob(db, job.library_id, job.version_id!, "embed", job.actor, true);
    }
    // the stills its computer cut: the actor's AI describes them here (decision 12: the computer reads the footage)
    if (job.kind === "describe") await describeFromStills(db, job.library_id, job.version_id!, job.actor, stills);
    await recordDerived(job.version_id!, { files, ...(probe ? { probe } : {}), ...(fingerprint ? { fingerprint } : {}), ...(sha256 ? { sha256 } : {}), ...(quick ? { quick } : {}) }, job.actor);
    if (files.thumb) wakePictures();
    finishJob(db, job.id, true, undefined, Date.now());
    sortAfter(job);
    return "done";
  } catch (e) {
    // no AI for it: parked, as the server's own run parks it; a usage limit or a busy AI waits, never fails (library/worker.ts)
    if (e instanceof NeedsKey) return (parkJob(db, job.id, e.message), libraryChanged(job.library_id), "failed");
    if (job.kind === "describe" && aiWaits(db, job, e)) return "failed";
    return failed(e instanceof Error ? e.message : String(e));
  } finally {
    await rm(incoming(jobId), { recursive: true, force: true });
  }
}

const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;
const text = (x: unknown, max: number): x is string => typeof x === "string" && x.length <= max;
/** The transcript in a computer's result, when it is one: the shapes /hear answered, bounded. */
function transcriptOf(x: unknown): LibraryTranscript | null {
  const t = x as Partial<LibraryTranscript> | null | undefined;
  if (!t || !text(t.provider, 40) || (t.model !== undefined && !text(t.model, 100)) || !(t.language === null || text(t.language, 20))) return null;
  if (!Array.isArray(t.segments) || !Array.isArray(t.words) || t.segments.length > 200_000 || t.words.length > 2_000_000) return null;
  const segments = t.segments.filter((s) => num(s?.start) && num(s.end) && text(s.text, 20_000)).map((s) => ({ start: s.start, end: s.end, text: s.text }));
  const words = t.words.filter((w) => num(w?.s) && num(w.e) && text(w.w, 200) && (w.c === undefined || num(w.c))).map((w) => ({ w: w.w, s: w.s, e: w.e, ...(w.c !== undefined ? { c: w.c } : {}) }));
  return { provider: t.provider, ...(t.model ? { model: t.model } : {}), language: t.language, segments, words };
}

/** A failed try (retried after its backoff); the last one of a step the card is shown with fails the version, as on the server. */
function failLibrary(job: JobRow, error: string): true {
  const db = libraryDb();
  void rm(incoming(job.id), { recursive: true, force: true }); // what it sent (a description's stills): not kept past the try
  finishJob(db, job.id, false, error, Date.now());
  const after = db.prepare("SELECT state FROM jobs WHERE id = ?").get(job.id) as { state: string } | undefined; // gone when the clip was removed meanwhile
  if (after?.state === "failed" && (job.kind === "send" || job.kind === "proxy")) db.prepare("UPDATE asset_versions SET state = 'failed' WHERE id = ?").run(job.version_id);
  libraryChanged(job.library_id);
  return true;
}

/** The device behind the ctd_ token; it is alive. */
function caller(c: Context): Device | null {
  const d = deviceForToken(c.req.header("authorization"));
  if (d) touchDevice(d.id, c.req.header("user-agent"));
  return d;
}
/** The claim a computer's call is for (x-ct-claim); none from an older computer. */
const claimOf = (c: Context): string | undefined => c.req.header("x-ct-claim") || undefined;
/** The answer to a call for a job the computer no longer holds: taken back, given to another claim, or finished. */
const GONE = (c: Context) => c.json({ ok: false, error: "This job was taken back" }, 410);
const idOf = (c: Context): number => {
  const n = Number(c.req.param("id"));
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

/** Mounted at /api/devices/relay/work/lib (api/work/routes.ts), with the device's ctd_ token. */
export const libWorkApp = new Hono();

/**
 * How far each held job's transfer got, and when it last moved (memory only: after a restart the first beat renews).
 * A download or upload that stops moving for STALL_MS keeps no lease: the job goes back to the queue (a counted try)
 * and the computer's next beat is answered 410. A beat without progress (an encode, the server checking an upload) renews.
 */
const moved = new Map<number, { claim: string | null | undefined; done: number; at: number }>();
const STALL_MS = 15 * 60_000;

libWorkApp.post("/:id/beat", async (c) => {
  const d = caller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const job = heldBy(idOf(c), d.id, claimOf(c));
  if (!job) {
    moved.delete(idOf(c));
    return GONE(c);
  }
  const b = (await c.req.json().catch(() => null)) as { done?: unknown; total?: unknown } | null;
  if (typeof b?.done === "number" && typeof b.total === "number" && b.done < b.total) {
    const now = Date.now();
    const m = moved.get(job.id);
    if (!m || m.claim !== job.claim_id || m.done !== b.done) moved.set(job.id, { claim: job.claim_id, done: b.done, at: now });
    else if (now - m.at >= STALL_MS) return c.json({ ok: true });
  }
  extendLease(libraryDb(), job.id, LEASE_S);
  return c.json({ ok: true });
});

/** The server's proxy of the job's file, for a kind that reads it (never the proxy job's or a send's). */
libWorkApp.get("/:id/light", async (c) => {
  const d = caller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const job = await heldSeen(idOf(c), d.id, claimOf(c));
  if (!job) return GONE(c);
  // Blur faces: a held copy of a clip not blurred (from before it was on) goes to no computer
  const key = !["proxy", "probe", "send"].includes(job.kind) && mayLeave(job.library_id, { versionId: job.version_id! }).ok ? rowOf(job.version_id)?.proxy : null;
  return key ? serveBlob(c, key, "application/octet-stream") : c.json({ error: "Not found" }, 404);
});

/** The original of a file only the server has, only to make what it has no lighter copy for (READS_ORIGINAL): the computer deletes it once that is made. */
libWorkApp.get("/:id/original", async (c) => {
  const d = caller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const job = await heldSeen(idOf(c), d.id, claimOf(c));
  if (!job) return GONE(c);
  const r = READS_ORIGINAL.includes(job.kind) && mayLeave(job.library_id, { versionId: job.version_id! }).ok ? rowOf(job.version_id) : undefined;
  return r && !r.source_key.startsWith("mac:") ? serveBlob(c, r.source_key, "application/octet-stream") : c.json({ error: "Not found" }, 404);
});

/**
 * A transcribe job's sound, cut on the computer from its own copy (library/transcribe.ts soundArgs): heard here on the
 * actor's key, nothing decoded, and the words answered for the job's result. Only while the computer holds the job.
 */
libWorkApp.post("/:id/hear", async (c) => {
  const d = caller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const job = await heldSeen(idOf(c), d.id, claimOf(c));
  if (!job) return GONE(c);
  const body = c.req.raw.body;
  if (job.kind !== "transcribe" || !job.version_id) return c.json({ error: "Not found" }, 404);
  if (!body) return c.json({ error: "Send the sound." }, 400);
  await mkdir(incoming(job.id), { recursive: true });
  const file = path.join(incoming(job.id), `sound.${keySound(job.actor, job.version_id) ?? "wav"}`);
  try {
    await pipeline(Readable.fromWeb(body as never), capped(FILE_MAX), createWriteStream(file));
    // ponytail: one request for the whole hearing; an hour of talk takes the key's provider well under a minute
    return c.json(await hearSound(job.version_id, job.actor, file));
  } catch (e) {
    return c.json({ error: (e instanceof Error ? e.message : String(e)).slice(0, 500) }, 502);
  } finally {
    await rm(file, { force: true });
  }
});

libWorkApp.put("/:id/file", async (c) => {
  const d = caller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const body = c.req.raw.body;
  if (!body) return c.json({ error: "Send the file." }, 400);
  const ok = await acceptLibraryFile(idOf(c), d.id, c.req.query("name") ?? "", Readable.fromWeb(body as never), claimOf(c), c.req.query("sha256") || undefined);
  if (ok === "gone") return GONE(c);
  if (typeof ok === "object") return c.json(ok.body, ok.status);
  return ok ? c.json({ ok }) : c.json({ error: "Not a file this job may send" }, 400);
});

libWorkApp.post("/:id/done", async (c) => {
  const d = caller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const r = (await c.req.json().catch(() => null)) as LibraryResult | null;
  if (!r || typeof r !== "object" || !r.outcome || !Array.isArray(r.files)) return c.json({ error: "A library result" }, 400);
  const got = await applyLibraryResult(idOf(c), d.id, r, claimOf(c));
  moved.delete(idOf(c));
  return got === "gone" ? GONE(c) : c.json({ ok: got === "done" });
});

libWorkApp.post("/:id/fail", async (c) => {
  const d = caller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const job = heldBy(idOf(c), d.id, claimOf(c));
  moved.delete(idOf(c));
  if (!job) return GONE(c);
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  // handed back as newer than the worker reads: its package version is kept as too old, so no library package goes to it
  // (nor fails again) until it claims with a newer one (work/routes.ts)
  if (b?.update === true && d.work) setDeviceWork(d.id, { ...d.work, tooOld: d.work.v });
  const error = typeof b?.error === "string" && b.error ? b.error.slice(0, 500) : "Your computer could not run this job";
  // its Download location's disk is not connected (it went since the claim, the footage is on that same disk, or a Mac
  // app the server could not tell of): a wait, never a failed try. The job comes back in ten minutes with its try given
  // back, and three such answers no longer fail the clip for good
  if (error.includes(NEEDS_DISK)) {
    defer(libraryDb(), job.id, 600);
    libraryChanged(job.library_id);
    return c.json({ ok: true });
  }
  return c.json({ ok: failLibrary(job, error) });
});
