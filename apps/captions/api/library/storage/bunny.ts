import { createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import { rm, stat, utimes } from "node:fs/promises";
import { Readable } from "node:stream";
import { cachedPath, saveToCache } from "./cache";
import { keyParts, type BlobStore } from "./types";

/**
 * Where a Bunny Storage zone is and how to sign in to it. `cdnHost` and `tokenKey` (a pull zone with token
 * authentication) make playback a signed link; without them playback copies the blob into the cache, like s3.ts.
 * `origin` replaces the API host (tests point it at a local server).
 */
export interface BunnyPlace {
  zone: string;
  accessKey: string; // the zone's storage password
  region?: string; // "" is Falkenstein (storage.bunnycdn.com); else the region code, like "sg" or "la"
  cdnHost?: string; // the pull zone's hostname, like tinyacrobatics.b-cdn.net
  tokenKey?: string; // the pull zone's token authentication key
  origin?: string;
}

/**
 * Blobs in a Bunny Storage zone, under the same keys as on disk. Bunny has no multipart upload, so `put` sends the
 * file in one PUT and removes it (callers rely on the file being gone). Uses the storage REST API: PUT, DELETE, GET,
 * and HEAD for `stat`. The HEAD answer's Content-Length is the size; a 404 is a missing blob.
 * ponytail: `locate` signs with the HS256 advanced token scheme from Bunny's docs, checked only against the docs, not a live zone
 */
export function bunnyBlobs(place: BunnyPlace, cacheDir: string, opts: { cacheBytes: number }): BlobStore {
  const origin = place.origin ?? `https://${place.region ? `${place.region}.` : ""}storage.bunnycdn.com`;
  const pathOf = (key: string) => `/${keyParts(key).map(encodeURIComponent).join("/")}`;
  const urlOf = (key: string) => `${origin}/${place.zone}${pathOf(key)}`;
  const headers = { AccessKey: place.accessKey };

  const localCopy = async (key: string): Promise<string> => {
    const p = cachedPath(cacheDir, key);
    const now = new Date();
    if (await utimes(p, now, now).then(() => true, () => false)) return p; // a hit counts as a use
    const res = await fetch(urlOf(key), { headers });
    if (!res.ok || !res.body) {
      await res.arrayBuffer().catch(() => {});
      throw new Error(`Bunny Storage has no blob ${key} (${res.status})`);
    }
    await saveToCache(cacheDir, p, Readable.fromWeb(res.body as never), opts.cacheBytes);
    return p;
  };

  return {
    kind: "bunny",
    caps: { signedUrls: !!(place.cdnHost && place.tokenKey), localPaths: !(place.cdnHost && place.tokenKey) },
    async put(key, file, o) {
      keyParts(key);
      const { size } = await stat(file);
      const res = await fetch(urlOf(key), {
        method: "PUT",
        headers: { ...headers, "Content-Type": o?.contentType ?? "application/octet-stream", "Content-Length": String(size) },
        body: Readable.toWeb(createReadStream(file)) as never,
        duplex: "half",
      });
      await res.arrayBuffer().catch(() => {});
      if (!res.ok) throw new Error(`Bunny Storage refused the upload of ${key} (${res.status})`);
      await rm(cachedPath(cacheDir, key), { force: true }); // an overwritten key must not serve the old bytes from the cache
      await rm(file, { force: true });
      return { bytes: size };
    },
    async stat(key) {
      const res = await fetch(urlOf(key), { method: "HEAD", headers });
      await res.arrayBuffer().catch(() => {});
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Bunny Storage answered ${res.status} for ${key}`);
      return { bytes: Number(res.headers.get("content-length") ?? 0) };
    },
    async delete(key) {
      const res = await fetch(urlOf(key), { method: "DELETE", headers });
      await res.arrayBuffer().catch(() => {});
      if (!res.ok && res.status !== 404) throw new Error(`Bunny Storage refused the delete of ${key} (${res.status})`);
      await rm(cachedPath(cacheDir, key), { force: true });
    },
    localCopy,
    async locate(key, ttlSeconds) {
      if (!place.cdnHost || !place.tokenKey) return { kind: "path", path: await localCopy(key) };
      // Bunny's advanced token: HMAC-SHA256 keyed by the token key over path + expires, base64url, prefixed HS256-.
      // The download and content-type hints are not sent: the pull zone serves the file as stored.
      const urlPath = pathOf(key);
      const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
      const token = createHmac("sha256", place.tokenKey).update(urlPath + String(expires)).digest("base64url");
      return { kind: "url", url: `https://${place.cdnHost}${urlPath}?token=HS256-${token}&expires=${expires}` };
    },
  };
}
