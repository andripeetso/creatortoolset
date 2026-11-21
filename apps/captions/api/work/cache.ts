import { copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MadeProxy, WorkClaimBody, WorkOffline } from "../../contracts/work";
import { PROXY_QUALITIES, type ProxyQuality } from "../../contracts/library";
import { env } from "../lib/env";

/**
 * The proxy cache on a computer that runs steps for a server: $DATA_DIR/proxies/<account>/<version>.mp4, one per account
 * signed in to that server (the worker's DATA_DIR is that server's folder; the account is the one the claim answer
 * names), so a second account on the same computer never reads the first's proxies. Kept until emptied (no deleting by
 * age). A download in progress is <version>.mp4.part, kept on Cancel so the next try resumes it. An original kept offline
 * is <version>.original (its own .part while it comes). A file's mtime is when a step last used it: with a size limit
 * (CT_PROXY_LIMIT, bytes) the least recently used go first, never one kept offline (offline.json, the server's list from
 * the last claim) or kept here (kept.json: a proxy this computer made for a file it keeps, Upload off). Design 6.3.
 */

let account: string | null = null;
let firstClaim = false;
// the Mac's Download location (Settings → Storage › This computer) comes in as CT_PROXY_DIR (apps/mac Worker.swift)
const legacy = () => path.join(env.dataDir, "proxies");
const root = () => process.env.CT_PROXY_DIR || legacy();

/**
 * A cache file: the version it is, `<version>.mp4` (a proxy) or `<version>.original`, and whether it is still a `.part`.
 * shortcut: version ids have no dots, so the greedy id is the version; upgrade to a separate folder for originals if one ever does.
 */
const CACHED = /^(.+)\.(mp4|original)(\.part)?$/;

/**
 * The account this worker runs for, from the claim answer (WorkClaim.account; one per worker, as its token is). The first
 * time, the cache of before there was one per account goes: whose proxies they were is unknown, so none is handed on.
 */
export function setCacheAccount(name: string): void {
  if (account === name) return;
  account = name;
  firstClaim = true;
  // only the old default folder: a folder the person picked may hold footage of theirs, so it is never swept
  let names: string[] = [];
  try {
    names = readdirSync(legacy());
  } catch {
    // no cache yet
  }
  for (const n of names) if (CACHED.test(n)) rmSync(path.join(legacy(), n), { force: true });
  rmSync(path.join(env.dataDir, "offline.json"), { force: true });
}

/**
 * The first claim after the update trims a cache already over the limit, sparing what is kept offline or here (UNIFIED-PRD
 * §4.7). Once per account; the claim's offline list is read first, so it spares what that list names.
 */
export function trimOnFirstClaim(): string[] {
  if (!firstClaim) return [];
  firstClaim = false;
  return trimCache();
}

/** This account's cache folder; known once a claim answered. */
export const proxiesDir = () => {
  if (!account) throw new Error("The proxy cache is known once the server names the account");
  return path.join(root(), encodeURIComponent(account).replace(/^\./, "%2E"));
};

/** The account's preview segments (editor/segcache.ts): counted and emptied with its proxies. A dot name is never an account's. */
export const segmentsDir = () => path.join(proxiesDir(), ".segments");

/** The bytes of the files in `dir` (none: 0). */
function dirBytes(dir: string): number {
  try {
    return readdirSync(dir).reduce((n, f) => n + (sizeOf(path.join(dir, f)) ?? 0), 0);
  } catch {
    return 0;
  }
}

/** A version id is a file name here: nothing that climbs out of the folder. */
export const safeName = (id: string): boolean => !!id && path.basename(id) === id && !id.startsWith(".");

export const proxyPath = (versionId: string) => path.join(proxiesDir(), `${versionId}.mp4`);
export const partPath = (versionId: string) => `${proxyPath(versionId)}.part`;
export const originalPath = (versionId: string) => path.join(proxiesDir(), `${versionId}.original`);
/** Where a file of the offline list is kept: its original, or its proxy. */
export const keptPath = (v: WorkOffline) => (v.kind === "original" ? originalPath(v.id) : proxyPath(v.id));

export const sizeOf = (file: string): number | null => {
  try {
    const s = statSync(file);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
};

/** The size limit: 25 GB (decimal, as the copy reads), or CT_PROXY_LIMIT (bytes) when set (UNIFIED-PRD M16). */
export const CACHE_LIMIT_DEFAULT = 25e9;
export const cacheLimit = (): number => {
  const n = Number(process.env.CT_PROXY_LIMIT);
  return Number.isFinite(n) && n > 0 ? n : CACHE_LIMIT_DEFAULT;
};

// the file is named inside the try: no account yet means no cache, and an empty list
/**
 * The free space a proxy kept on this computer must leave on its disk: 30 GB (Media Library CEO, 2026-11-20: a full
 * disk crashes his apps), or CT_PROXY_FLOOR (bytes) when set.
 */
export const FLOOR_DEFAULT = 30e9;
const floor = (): number => {
  const n = Number(process.env.CT_PROXY_FLOOR);
  return process.env.CT_PROXY_FLOOR && Number.isFinite(n) && n >= 0 ? n : FLOOR_DEFAULT;
};
const freeOn = (dir: string): number => {
  try {
    const s = statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return Number.POSITIVE_INFINITY; // a disk that can't say: as before the floor
  }
};

/** About how big a proxy of a file will be: the quality's top video rate and its sound for its length, never more than the file. */
export const proxyBytes = (fileBytes: number, seconds: number, quality: ProxyQuality = "standard"): number => {
  const q = PROXY_QUALITIES.find((x) => x.value === quality) ?? PROXY_QUALITIES[1]!;
  return seconds > 0 ? Math.min(fileBytes || Number.POSITIVE_INFINITY, seconds * (q.maxKbps + 128) * 125) : fileBytes;
};

/**
 * Room for a proxy of about `bytes` in the cache, keeping the floor free on its disk: the least recently used proxies go
 * first, never one kept offline or kept here (those still count, as space taken). False when even that is not enough:
 * then no proxy is written and the original plays.
 */
export function roomFor(bytes: number): boolean {
  const dir = proxiesDir();
  mkdirSync(dir, { recursive: true });
  const short = () => floor() + bytes - freeOn(dir);
  if (short() <= 0) return true;
  const keep = protectedIds();
  const old = entries().filter((x) => !x.part && !keep.has(x.id)).sort((a, b) => a.used - b.used);
  // nothing is trimmed for a proxy that wouldn't fit even with all of them gone
  if (old.reduce((n, e) => n + e.size, 0) < short()) return false;
  for (const e of old) {
    rmSync(path.join(dir, e.file), { force: true });
    if (short() <= 0) return true;
  }
  return short() <= 0;
}

/** What became of each proxy a plug-in asked for (contracts/work.ts MadeProxy), kept beside the cache: its size, or skipped. */
const madeFile = () => path.join(proxiesDir(), "made.json");
export function madeProxies(): Record<string, MadeProxy> {
  try {
    const v = JSON.parse(readFileSync(madeFile(), "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, MadeProxy>) : {};
  } catch {
    return {};
  }
}
export function noteMade(id: string, made: MadeProxy): void {
  mkdirSync(proxiesDir(), { recursive: true });
  writeFileSync(madeFile(), JSON.stringify({ ...madeProxies(), [id]: made }));
}

const readIds = (file: () => string): string[] => {
  try {
    const v = JSON.parse(readFileSync(file(), "utf8")) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

/** The versions kept offline, as the server last listed them. */
const offlineFile = () => path.join(proxiesDir(), "offline.json");
export const keptOffline = (): string[] => readIds(offlineFile);
export const setKeptOffline = (ids: string[]) => {
  mkdirSync(proxiesDir(), { recursive: true });
  writeFileSync(offlineFile(), JSON.stringify(ids));
};

/** The proxies this computer keeps for files it indexed itself (Upload off, Generate proxies on): never sent, never trimmed. */
const keptFile = () => path.join(proxiesDir(), "kept.json");
export const keptProxies = (): string[] => readIds(keptFile);

/** Never removed by the limit or by Empty: kept offline by the owner, or kept here. */
const protectedIds = () => new Set([...keptOffline(), ...keptProxies()]);

/** A proxy this computer made for a file it keeps here: moved into the cache and listed in kept.json. */
export function keepProxy(versionId: string, made: string): void {
  mkdirSync(proxiesDir(), { recursive: true });
  moveFile(made, proxyPath(versionId));
  writeFileSync(keptFile(), JSON.stringify([...keptProxies().filter((x) => x !== versionId), versionId]));
}

/** A file moved to another place on the same disk, or copied across disks (a Download location on another disk). */
export function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    copyFileSync(from, to);
    rmSync(from, { force: true });
  }
}

/** Every file in the cache: the version it is, its size, when it was last used, and whether it is unfinished. */
function entries(): { file: string; id: string; ext: string; size: number; used: number; part: boolean }[] {
  let names: string[] = [];
  try {
    names = readdirSync(proxiesDir());
  } catch {
    return []; // no cache yet
  }
  return names.flatMap((name) => {
    const m = CACHED.exec(name);
    if (!m) return []; // offline.json, kept.json
    const file = path.join(proxiesDir(), name);
    try {
      const s = statSync(file);
      return s.isFile() ? [{ file, id: m[1]!, ext: m[2]!, size: s.size, used: s.mtimeMs, part: !!m[3] }] : [];
    } catch {
      return [];
    }
  });
}

/** A step used this proxy now: it is the last the limit removes. */
export function touchProxy(file: string): void {
  if (path.dirname(file) !== proxiesDir()) return;
  const now = new Date();
  try {
    utimesSync(file, now, now);
  } catch {
    // gone meanwhile: downloaded again when needed
  }
}

/** Over the limit: the least recently used files go until it fits, never one kept offline or here. The removed versions. */
export function trimCache(limit = cacheLimit(), keep = protectedIds()): string[] {
  if (!limit) return [];
  const all = entries();
  let bytes = all.reduce((n, e) => n + e.size, 0);
  const removed: string[] = [];
  for (const e of all.filter((e) => !e.part && !keep.has(e.id)).sort((a, b) => a.used - b.used)) {
    if (bytes <= limit) break;
    rmSync(e.file, { force: true });
    bytes -= e.size;
    removed.push(e.id);
  }
  return removed;
}

/** Settings → Storage → Empty: every file and unfinished download goes, except the ones kept offline or here. */
export function emptyCache(keep = protectedIds()): void {
  for (const e of entries()) if (!keep.has(e.id)) rmSync(e.file, { force: true });
  rmSync(segmentsDir(), { recursive: true, force: true });
}

/**
 * The server's claim answer named these (WorkClaim.drop): its account may no longer see them, or they are gone. Each
 * goes with its unfinished download, kept offline or not; the next claim's offline list no longer names it.
 */
export function dropProxies(ids: string[]): void {
  for (const v of ids) {
    if (!safeName(v)) continue;
    for (const f of [proxyPath(v), partPath(v), originalPath(v), `${originalPath(v)}.part`]) rmSync(f, { force: true });
  }
  const kept = keptProxies();
  const left = kept.filter((x) => !ids.includes(x));
  if (left.length !== kept.length) writeFileSync(keptFile(), JSON.stringify(left));
}

/** What a claim reports of the cache (WorkClaimBody.cache); nothing before the server named the account. */
export function cacheReport(): WorkClaimBody["cache"] {
  if (!account) return undefined;
  const all = entries();
  const limit = cacheLimit();
  const offline = keptOffline();
  const parts = [...new Set(all.flatMap((e) => (e.part ? [e.id] : [])))];
  // the proxies only: an original kept offline is not a version the server knows as a proxy (its dropFor check)
  const versions = [...new Set(all.flatMap((e) => (e.part || e.ext !== "mp4" ? [] : [e.id])))];
  return {
    bytes: all.reduce((n, e) => n + e.size, 0) + dirBytes(segmentsDir()),
    ...(limit ? { limit } : {}),
    ...(offline.length ? { offline } : {}),
    versions,
    ...(parts.length ? { parts } : {}),
    dir: proxiesDir(),
    // a size for a proxy still here, and every skip (so it isn't asked for again)
    ...(() => {
      const made = Object.fromEntries(Object.entries(madeProxies()).filter(([id, m]) => "skip" in m || versions.includes(id)));
      return Object.keys(made).length ? { made } : {};
    })(),
  };
}
