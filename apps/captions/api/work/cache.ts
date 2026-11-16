import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { env } from "../lib/env";

/**
 * The proxy cache on a computer that runs steps for a server: $DATA_DIR/proxies/<version>.mp4, one per server (the
 * worker's DATA_DIR is that server's folder), kept until emptied. A download in progress is <version>.mp4.part, kept on
 * Cancel so the next try resumes it. The size limit and the versions kept offline come later (design 6.3).
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

/** What a claim reports of the cache (WorkClaimBody.cache). */
export function cacheReport(): { bytes: number } {
  let bytes = 0;
  try {
    for (const name of readdirSync(proxiesDir())) bytes += sizeOf(path.join(proxiesDir(), name)) ?? 0;
  } catch {
    // no cache yet
  }
  return { bytes };
}
