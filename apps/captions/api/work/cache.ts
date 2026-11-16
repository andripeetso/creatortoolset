import { readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { WorkClaimBody } from "../../contracts/work";
import { env } from "../lib/env";

/**
 * The proxy cache on a computer that runs steps for a server: $DATA_DIR/proxies/<version>.mp4, one per server (the
 * worker's DATA_DIR is that server's folder), kept until emptied (no deleting by age). A download in progress is
 * <version>.mp4.part, kept on Cancel so the next try resumes it. A proxy's mtime is when a step last used it: with a size
 * limit (CT_PROXY_LIMIT, bytes) the least recently used go first, never one kept offline (offline.json, the server's
 * list from the last claim). Design 6.3.
 */

export const proxiesDir = () => path.join(env.dataDir, "proxies");

/** A version id is a file name here: nothing that climbs out of the folder. */
export const safeName = (id: string): boolean => !!id && path.basename(id) === id && !id.startsWith(".");

export const proxyPath = (versionId: string) => path.join(proxiesDir(), `${versionId}.mp4`);
export const partPath = (versionId: string) => `${proxyPath(versionId)}.part`;

export const sizeOf = (file: string): number | null => {
  try {
    const s = statSync(file);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
};

/** The size limit, when the person set one. */
export const cacheLimit = (): number | undefined => {
  const n = Number(process.env.CT_PROXY_LIMIT);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** The versions kept offline, as the server last listed them. */
const offlineFile = () => path.join(env.dataDir, "offline.json");
export function keptOffline(): string[] {
  try {
    const v = JSON.parse(readFileSync(offlineFile(), "utf8")) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
export const setKeptOffline = (ids: string[]) => writeFileSync(offlineFile(), JSON.stringify(ids));

/** Every file in the cache: the version (null for a `.part`), its size and when it was last used. */
function entries(): { file: string; version: string | null; size: number; used: number }[] {
  let names: string[] = [];
  try {
    names = readdirSync(proxiesDir());
  } catch {
    return []; // no cache yet
  }
  return names.flatMap((name) => {
    const file = path.join(proxiesDir(), name);
    try {
      const s = statSync(file);
      return s.isFile() ? [{ file, version: name.endsWith(".mp4") ? name.slice(0, -4) : null, size: s.size, used: s.mtimeMs }] : [];
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

/** Over the limit: the least recently used proxies go until it fits, never one kept offline. The removed versions. */
export function trimCache(limit = cacheLimit(), keep = new Set(keptOffline())): string[] {
  if (!limit) return [];
  const all = entries();
  let bytes = all.reduce((n, e) => n + e.size, 0);
  const removed: string[] = [];
  for (const e of all.filter((e) => e.version && !keep.has(e.version)).sort((a, b) => a.used - b.used)) {
    if (bytes <= limit) break;
    rmSync(e.file, { force: true });
    bytes -= e.size;
    removed.push(e.version!);
  }
  return removed;
}

/** Settings → Storage → Empty: every proxy and unfinished download goes, except the ones kept offline. */
export function emptyCache(keep = new Set(keptOffline())): void {
  for (const e of entries()) {
    const version = e.version ?? path.basename(e.file).replace(/\.mp4\.part$/, "");
    if (!keep.has(version)) rmSync(e.file, { force: true });
  }
}

/**
 * The server's claim answer named these (WorkClaim.drop): its account may no longer see them, or they are gone. Each
 * goes with its unfinished download, kept offline or not; the next claim's offline list no longer names it.
 */
export function dropProxies(ids: string[]): void {
  for (const v of ids) if (safeName(v)) for (const f of [proxyPath(v), partPath(v)]) rmSync(f, { force: true });
}

/** What a claim reports of the cache (WorkClaimBody.cache). */
export function cacheReport(): NonNullable<WorkClaimBody["cache"]> {
  const all = entries();
  const limit = cacheLimit();
  const offline = keptOffline();
  const parts = all.flatMap((e) => (e.version ? [] : [path.basename(e.file).replace(/\.mp4\.part$/, "")]));
  return {
    bytes: all.reduce((n, e) => n + e.size, 0),
    ...(limit ? { limit } : {}),
    ...(offline.length ? { offline } : {}),
    versions: all.flatMap((e) => (e.version ? [e.version] : [])),
    ...(parts.length ? { parts } : {}),
  };
}
