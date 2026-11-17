/**
 * Item 6C (and 6A's "send"): library jobs on the uploader's own computers, on the same road as the AI Editor's steps
 * (claim → package → result; contracts/work.ts LibraryPackage). A file only the server has (a phone or browser upload)
 * gets its proxy, waveform, strip and fingerprint made on one of its uploader's computers while one is online; the proxy
 * job may download the original to make the proxy, and the computer deletes it after. The other kinds read the file
 * where it is on that computer, else the proxy the server has; never the original. A "send" job is a file on one
 * computer that nothing uploaded yet (library/derived.ts sendLater): only a computer that has it takes it, and this
 * server never runs it. The server runs a job no such computer can take only where its video work is on (server-work.ts).
 * A transcript on the person's key (6B) is one of them too: the computer cuts the sound from its copy, the server hears
 * it on the key (/hear, nothing decoded here), and the words come back in the result. A transcript on a computer's own
 * speech model goes the speech road instead (lib/computer-transcribe.ts), where that computer cuts the sound itself.
 */
import { Hono, type Context } from "hono";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { SOUNDS } from "../../contracts/library";
import type { Device } from "../../contracts/providers";
import { WORK_MIN, WORK_V, type LibraryPackage, type LibraryResult, type LibraryTranscript, type WorkFile } from "../../contracts/work";
import { computers, fileFor, foldersOf, ONLINE_MS, type FileRow } from "../editor/reach";
import { mayClaim, readBalance, type WorkerSeen } from "../lib/balance";
import { deviceForToken, isOnline, isThisMachine, listDevices, touchDevice } from "../lib/devices";
import { env } from "../lib/env";
import { libraryChanged } from "../library/access";
import { libraryDb, librarySetting, proxiesInCloud, versionUpload } from "../library/db";
import { recordDerived, type DerivedFile } from "../library/derived";
import { canEmbed } from "../library/embed";
import { claimJob, enqueueJob, extendLease, finishJob, type JobRow } from "../library/jobs";
import type { ProbeSummary } from "../library/media/probe";
import { sortAfter } from "../library/roll";
import { serveBlob } from "../library/routes";
import { fileTranscript, hearSound, keySound } from "../library/transcribe";
import { leaveToComputers } from "../library/worker";
import { mayRead } from "./offline";

/** The library jobs a computer runs; "send" only a computer can. */
export const LIBRARY_ON_COMPUTER: readonly string[] = ["proxy", "wave", "sprite", "fingerprint", "transcribe"];
const KINDS = ["send", ...LIBRARY_ON_COMPUTER];
const LEASE_S = 300;
/** The files each kind may send back. */
const SENDS: Record<string, DerivedFile[]> = { send: ["original", "proxy", "thumb", "wave", "sprite"], proxy: ["proxy"], wave: ["wave"], sprite: ["sprite"], fingerprint: [], transcribe: [] };
/** The most a small file (picture, waveform, strip) may weigh; a proxy is capped as a result file is. */
const SMALL_MAX = 16 * 1024 ** 2;
const FILE_MAX = 8 * 1024 ** 3;

/** A computer whose worker reads this server's package and said it runs library jobs. */
const takesLibrary = (d: Pick<Device, "work">): boolean => !!d.work?.library && d.work.v >= WORK_MIN;

interface LibRow extends FileRow {
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
}

function rowOf(versionId: string | null): LibRow | undefined {
  return libraryDb()
    .prepare(
      `SELECT v.id, v.source_key, v.source_path, v.mac_path, v.mac_device, v.from_path, v.from_device, v.probe, v.bytes, v.sha256, v.quick,
         a.library_id, a.id AS asset_id, a.title, a.kind, d.storage_key AS proxy, d.bytes AS proxy_bytes
       FROM asset_versions v JOIN assets a ON a.id = v.asset_id
       LEFT JOIN derivatives d ON d.version_id = v.id AND d.kind = 'proxy' WHERE v.id = ?`,
    )
    .get(versionId ?? "") as LibRow | undefined;
}

/** An original uploaded from a computer is still on that computer, where it was sent from. */
const where = (r: LibRow): FileRow => (r.mac_path || !r.from_path ? r : { ...r, mac_path: r.from_path, mac_device: r.from_device });

/** How well computer `d` can take library job `job`: 3 has the file, 2 reads the server's proxy, 1 downloads the original (proxy only), 0 never. */
export function libraryRank(d: Device, job: Pick<JobRow, "kind" | "actor">, r: LibRow, folders: ReturnType<typeof foldersOf>): number {
  if (!takesLibrary(d)) return 0;
  // only a transcript on the person's key: the speech road takes one on a computer's model, this server one on its own
  if (job.kind === "transcribe" && !keySound(job.actor, r.id)) return 0;
  const at = fileFor(where(r), d.id, folders, isThisMachine);
  if (at && "path" in at) return 3;
  if (job.kind === "send") return 0;
  if (job.kind === "proxy") return r.source_key.startsWith("mac:") ? 0 : 1;
  // a proxy, never the original itself: the one download of an original is the proxy job's
  return r.proxy ? 2 : 0;
}

/** The computers of `owner` that may take a library job now: `me`, and the others online, free and holding none. */
function peersOf(owner: string, me: Device): Device[] {
  return computers(owner)
    .filter((c) => c.x.id === me.id || (c.free && !holding(c.x.id)))
    .map((c) => (c.x.id === me.id ? me : c.x))
    .filter(takesLibrary);
}

/** Which computer holds each library job it claimed (this process; a lease outlives a restart and puts the job back). */
// ponytail: in memory; a device column on jobs if two server processes ever share one queue
const holders = new Map<number, string>();
const holding = (device: string) => [...holders].some(([id, d]) => d === device && heldBy(id, d));

/** The job `device` holds (claimed by it, still running), else undefined. */
export function heldBy(id: number, device: string): JobRow | undefined {
  if (holders.get(id) !== device) return undefined;
  const job = libraryDb().prepare("SELECT * FROM jobs WHERE id = ? AND state = 'running'").get(id) as JobRow | undefined;
  if (!job) holders.delete(id);
  return job;
}

/** Why a library job stops: its account may no longer see the clip (a library policy refused them since it was queued). */
export const UNSEEN = "This account can no longer see this clip";

/** Whether the job's account may still see its clip: the per-source check every library policy runs (offline.ts mayRead). */
const stillSees = async (job: JobRow, r: LibRow): Promise<boolean> => !!job.actor && (await mayRead(job.actor, r.library_id, r.asset_id, r.id));

/** A job its account may no longer see fails for good, queued or held: retrying would only be refused again. */
function failUnseen(job: JobRow): void {
  holders.delete(job.id);
  libraryDb().prepare("UPDATE jobs SET state = 'failed', lease_until = NULL, error = ? WHERE id = ? AND state IN ('queued', 'running')").run(UNSEEN, job.id);
  libraryChanged(job.library_id);
}

/** The job `device` holds while its account may still see the clip; one it may not see fails here. */
async function heldSeen(id: number, device: string): Promise<JobRow | undefined> {
  const job = heldBy(id, device);
  const r = job && rowOf(job.version_id);
  if (!job || !r) return undefined;
  if (await stillSees(job, r)) return job;
  failUnseen(job);
  return undefined;
}

/** The library job computer `d` takes now, with its package, or null. The best-placed of its owner's computers, then load balancing, decide. */
export async function claimLibraryForComputer(d: Device, now = Date.now()): Promise<LibraryPackage | null> {
  if (!takesLibrary(d)) return null;
  const db = libraryDb();
  const queued = db
    .prepare(`SELECT * FROM jobs WHERE state = 'queued' AND run_after <= ? AND actor = ? AND kind IN (${KINDS.map(() => "?").join(", ")}) ORDER BY id LIMIT 100`)
    .all(now, d.owner, ...KINDS) as unknown as JobRow[];
  if (!queued.length) return null;
  const folders = foldersOf(d.owner);
  const balance = await readBalance(d.owner);
  const peers = peersOf(d.owner, d);
  for (const job of queued) {
    const r = rowOf(job.version_id);
    if (!r) continue;
    const ranked = peers.map((x) => ({ x, r: libraryRank(x, job, r, folders) }));
    const mine = ranked.find((p) => p.x.id === d.id)?.r ?? 0;
    const top = Math.max(0, ...ranked.map((p) => p.r));
    if (!mine || mine < top) continue;
    const workers: WorkerSeen[] = ranked
      .filter((p) => p.r === top && p.x.report?.machine)
      .map(({ x }) => ({ host: x.id, at: x.id === d.id ? now : (x.lastSeen ?? 0), machine: x.report!.machine, never: [] }));
    if (!mayClaim(job.kind, d.id, workers, balance, now, ONLINE_MS)) continue;
    if (!(await stillSees(job, r))) {
      failUnseen(job);
      continue;
    }
    const got = claimJob(db, LEASE_S, now, "jobs", undefined, job.id);
    if (!got) continue;
    holders.set(got.id, d.id);
    libraryChanged(got.library_id); // its card says it is being worked on
    return packageOf(got, r, d, folders);
  }
  return null;
}

function packageOf(job: JobRow, r: LibRow, d: Device, folders: ReturnType<typeof foldersOf>): LibraryPackage {
  const at = fileFor(where(r), d.id, folders, isThisMachine);
  const file: WorkFile = {
    id: r.id,
    title: r.title,
    bytes: r.bytes,
    ...(r.quick ? { quick: r.quick } : r.sha256.startsWith("mac:") ? { quick: r.sha256.slice(4) } : {}),
    ...(at && "path" in at ? { path: at.path } : {}),
    ...(r.proxy && job.kind !== "proxy" && job.kind !== "send" ? { proxy: { bytes: r.proxy_bytes ?? 0 } } : {}),
  };
  const upload = versionUpload(r.id);
  const send = job.kind === "send" && upload !== "none";
  return {
    v: WORK_V,
    job: { id: job.id, kind: job.kind, versionId: r.id, libraryId: r.library_id, actor: job.actor ?? d.owner },
    file,
    folders: folders.flatMap((f) => {
      const p = f.reach[d.id]?.path ?? (f.origin.host === d.id ? f.origin.path : undefined);
      return p ? [p] : [];
    }),
    ...(job.kind === "proxy" && !r.source_key.startsWith("mac:") ? { original: { bytes: r.bytes } } : {}),
    ...(r.probe && job.kind !== "send" ? { probe: JSON.parse(r.probe) as Record<string, unknown> } : {}),
    ...(job.kind === "transcribe" ? { audio: keySound(job.actor, r.id) ?? "wav" } : {}),
    ...(send
      ? {
          upload,
          // a video sent to a library that keeps only proxies gets one whatever the proxy switch says (worker.ts afterProbe)
          proxy: { cloud: proxiesInCloud(r.library_id) || upload === "proxies", on: librarySetting(r.library_id, "proxy") },
          music: !!libraryDb()
            .prepare(`SELECT 1 FROM asset_tags t JOIN asset_versions av ON av.asset_id = t.asset_id WHERE av.id = ? AND t.source = 'user' AND t.tag IN (${Object.values(SOUNDS).map(() => "?").join(", ")})`)
            .get(r.id, ...Object.values(SOUNDS).map((s) => s.tag)),
        }
      : {}),
  };
}

/**
 * Whether this server's loop leaves library job `job` to a computer: a "send" always (only that computer has the file);
 * another while one of the uploader's computers online can take it, or will once the proxy a computer is making is here.
 */
export function computerTakesLibrary(job: JobRow): boolean {
  if (job.kind === "send") return true;
  if (!job.actor || !LIBRARY_ON_COMPUTER.includes(job.kind)) return false;
  const own = listDevices((x) => x.owner === job.actor && isOnline(x.id) && takesLibrary(x));
  const r = own.length ? rowOf(job.version_id) : undefined;
  if (!r) return false;
  const folders = foldersOf(job.actor);
  if (own.some((x) => libraryRank(x, job, r, folders) > 0)) return true;
  if (job.kind === "proxy") return false;
  const p = libraryDb().prepare("SELECT * FROM jobs WHERE version_id = ? AND kind = 'proxy' AND state IN ('queued', 'running')").get(r.id) as JobRow | undefined;
  return !!p && (p.state === "running" ? holders.has(p.id) : computerTakesLibrary(p));
}
leaveToComputers.kinds = KINDS;
leaveToComputers.test = computerTakesLibrary;

/** Whether a library job waits that computer `d` would be handed now: its device runner's long poll starts the worker. */
export async function libraryWaits(d: Device, now = Date.now()): Promise<boolean> {
  if (!takesLibrary(d)) return false;
  const db = libraryDb();
  const queued = db
    .prepare(`SELECT * FROM jobs WHERE state = 'queued' AND run_after <= ? AND actor = ? AND kind IN (${KINDS.map(() => "?").join(", ")}) ORDER BY id LIMIT 100`)
    .all(now, d.owner, ...KINDS) as unknown as JobRow[];
  const folders = queued.length ? foldersOf(d.owner) : [];
  return queued.some((j) => {
    const r = rowOf(j.version_id);
    return !!r && libraryRank(d, j, r, folders) > 0;
  });
}

const incoming = (jobId: number) => path.join(env.dataDir, "library", "incoming", String(jobId));
const NAME = /^(original|proxy|thumb|wave|sprite)$/;

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

/** A file a held job sends, streamed to its incoming folder under its cap; false when it may not send it. */
export async function acceptLibraryFile(jobId: number, deviceId: string, name: string, body: Readable): Promise<boolean> {
  const job = heldBy(jobId, deviceId);
  if (!job || !NAME.test(name) || !SENDS[job.kind]?.includes(name as DerivedFile)) return false;
  // the original only to a library that keeps originals: a proxies-only library never gets one
  if (name === "original" && (!job.version_id || versionUpload(job.version_id) !== "all")) return false;
  const cap = name === "original" ? (rowOf(job.version_id)?.bytes ?? 0) : name === "proxy" ? FILE_MAX : SMALL_MAX;
  await mkdir(incoming(jobId), { recursive: true });
  const out = path.join(incoming(jobId), name);
  try {
    await pipeline(body, capped(cap), createWriteStream(out));
  } catch {
    await rm(out, { force: true });
    return false;
  }
  return true;
}

/** The job's result, filed while `deviceId` still holds it: the files and rows through recordDerived, then the job done. */
export async function applyLibraryResult(jobId: number, deviceId: string, r: LibraryResult): Promise<boolean> {
  const job = heldBy(jobId, deviceId);
  if (!job) return false;
  const db = libraryDb();
  holders.delete(jobId);
  try {
    if ("error" in r.outcome) return failLibrary(job, r.outcome.error);
    const there = new Set(await readdir(incoming(jobId)).catch(() => [] as string[]));
    const files = Object.fromEntries(r.files.filter((f) => there.has(f) && SENDS[job.kind]?.includes(f)).map((f) => [f, path.join(incoming(jobId), f)]));
    const probe = job.kind === "send" && r.probe && typeof r.probe === "object" ? (r.probe as unknown as ProbeSummary) : undefined;
    const fingerprint = (job.kind === "fingerprint" || job.kind === "send") && typeof r.fingerprint === "string" && r.fingerprint.length < 1_000_000 ? r.fingerprint : undefined;
    const hex = (x: unknown) => (job.kind === "send" && typeof x === "string" && /^[0-9a-f]{64}$/.test(x) ? x : undefined);
    const sha256 = hex(r.sha256);
    const quick = hex(r.quick);
    if (job.kind === "send" && !probe) return failLibrary(job, "Your computer sent no probe of the file");
    if (job.kind === "transcribe") {
      const t = transcriptOf(r.transcript);
      if (!t) return failLibrary(job, "Your computer sent no transcript");
      fileTranscript(db, job.version_id!, job.actor, t);
      // new words to search by meaning, as after a transcript made here (library/worker.ts)
      if (librarySetting(job.library_id, "embed") && canEmbed(job.actor)) enqueueJob(db, job.library_id, job.version_id!, "embed", job.actor, true);
    }
    await recordDerived(job.version_id!, { files, ...(probe ? { probe } : {}), ...(fingerprint ? { fingerprint } : {}), ...(sha256 ? { sha256 } : {}), ...(quick ? { quick } : {}) }, job.actor);
    finishJob(db, job.id, true, undefined, Date.now());
    sortAfter(job);
    return true;
  } catch (e) {
    return failLibrary(job, e instanceof Error ? e.message : String(e));
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
  holders.delete(job.id);
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
const idOf = (c: Context): number => {
  const n = Number(c.req.param("id"));
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

/** Mounted at /api/devices/relay/work/lib (api/work/routes.ts), with the device's ctd_ token. */
export const libWorkApp = new Hono();

libWorkApp.post("/:id/beat", (c) => {
  const d = caller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const job = heldBy(idOf(c), d.id);
  if (job) extendLease(libraryDb(), job.id, LEASE_S);
  return c.json({ ok: !!job });
});

/** The server's proxy of the job's file, for a kind that reads it (never the proxy job's or a send's). */
libWorkApp.get("/:id/light", async (c) => {
  const d = caller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const job = await heldSeen(idOf(c), d.id);
  const key = job && job.kind !== "proxy" && job.kind !== "send" ? rowOf(job.version_id)?.proxy : null;
  return key ? serveBlob(c, key, "application/octet-stream") : c.json({ error: "Not found" }, 404);
});

/** The original, only to make the proxy of a file only the server has: the computer deletes it once the proxy is made. */
libWorkApp.get("/:id/original", async (c) => {
  const d = caller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const job = await heldSeen(idOf(c), d.id);
  const r = job?.kind === "proxy" ? rowOf(job.version_id) : undefined;
  return r && !r.source_key.startsWith("mac:") ? serveBlob(c, r.source_key, "application/octet-stream") : c.json({ error: "Not found" }, 404);
});

/**
 * A transcribe job's sound, cut on the computer from its own copy (library/transcribe.ts soundArgs): heard here on the
 * actor's key, nothing decoded, and the words answered for the job's result. Only while the computer holds the job.
 */
libWorkApp.post("/:id/hear", async (c) => {
  const d = caller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const job = await heldSeen(idOf(c), d.id);
  const body = c.req.raw.body;
  if (job?.kind !== "transcribe" || !job.version_id) return c.json({ error: "Not found" }, 404);
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
  const ok = await acceptLibraryFile(idOf(c), d.id, c.req.query("name") ?? "", Readable.fromWeb(body as never));
  return ok ? c.json({ ok }) : c.json({ error: "Not a file this job may send" }, 400);
});

libWorkApp.post("/:id/done", async (c) => {
  const d = caller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const r = (await c.req.json().catch(() => null)) as LibraryResult | null;
  if (!r || typeof r !== "object" || !r.outcome || !Array.isArray(r.files)) return c.json({ error: "A library result" }, 400);
  return c.json({ ok: await applyLibraryResult(idOf(c), d.id, r) });
});

libWorkApp.post("/:id/fail", async (c) => {
  const d = caller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const job = heldBy(idOf(c), d.id);
  if (!job) return c.json({ ok: false });
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  return c.json({ ok: failLibrary(job, typeof b?.error === "string" && b.error ? b.error.slice(0, 500) : "Your computer could not run this job") });
});
