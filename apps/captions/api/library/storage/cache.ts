import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { keyParts } from "./types";

/** Where a remote blob's local copy sits in its cache folder (same layout as the key). */
export const cachedPath = (cacheDir: string, key: string): string => path.join(cacheDir, ...keyParts(key));

/**
 * Writes a downloaded blob to its cache path, then trims the cache. Remote stores (s3.ts, bunny.ts) use it for localCopy.
 * ponytail: walks the whole cache after each download (an index if it holds many thousands of files), and may drop
 * a copy another job was handed a moment ago but has not opened yet (only once the cap is reached); a pin per job then
 */
export async function saveToCache(cacheDir: string, p: string, body: Readable, cacheBytes: number): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true });
  const tmp = path.join(path.dirname(p), `.dl-${process.pid}-${Date.now()}-${path.basename(p)}`);
  try {
    await pipeline(body, createWriteStream(tmp));
    await rename(tmp, p);
  } finally {
    await rm(tmp, { force: true });
  }
  await evictCache(cacheDir, p, cacheBytes);
}

/** Removes the least recently used copies until the cache is within `cacheBytes`; `keep` (the copy just written) stays. */
export async function evictCache(cacheDir: string, keep: string, cacheBytes: number): Promise<void> {
  const files = await Promise.all(
    (await readdir(cacheDir, { recursive: true, withFileTypes: true }).catch(() => []))
      .filter((e) => e.isFile() && !e.name.startsWith(".dl-"))
      .map(async (e) => {
        const p = path.join(e.parentPath, e.name);
        const s = await stat(p).catch(() => null);
        return { p, bytes: s?.size ?? 0, used: s?.mtimeMs ?? 0 };
      }),
  );
  let total = files.reduce((n, f) => n + f.bytes, 0);
  for (const f of files.sort((a, b) => a.used - b.used)) {
    if (total <= cacheBytes) break;
    if (f.p === keep) continue;
    await rm(f.p, { force: true });
    total -= f.bytes;
  }
}
