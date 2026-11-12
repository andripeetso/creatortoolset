import { createHmac, randomBytes } from "node:crypto";
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
 * `locate` signs with Bunny's HS256 advanced token, byte for byte what a production signer that serves real zones makes.
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
    async locate(key, ttlSeconds, o) {
      // The pull zone serves a file with the type its name's extension says and can't be told a download name, so a
      // key with no extension (a video's `source`) or a download is served from this server's copy instead.
      // ponytail: originals stream through the server cache; store them under a key with the extension to sign them too
      const named = /\.[a-z0-9]{2,5}$/i.test(key);
      if (!place.cdnHost || !place.tokenKey || !named || o?.download) return { kind: "path", path: await localCopy(key) };
      // Bunny's advanced token: HMAC-SHA256 keyed by the token key over path + expires, base64url, prefixed HS256-.
      const urlPath = pathOf(key);
      const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
      const token = createHmac("sha256", place.tokenKey).update(urlPath + String(expires)).digest("base64url");
      return { kind: "url", url: `https://${place.cdnHost}${urlPath}?token=HS256-${token}&expires=${expires}` };
    },
  };
}

/** What Bunny's account API says when it refuses: its own message, or the status. */
async function refusal(res: Response, what: string): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { Message?: string } | null;
  return new Error(`Bunny refused ${what}: ${body?.Message ?? res.status}`);
}

/**
 * Makes a library's whole Bunny setup from the account's API key: a storage zone in `region` (DE, NY, LA or SG) and a
 * pull zone on it with token authentication, so playback is a signed link. `check` tries the new zone (a test file); it
 * gets three tries, since a new zone may take a moment. On any failure after the storage zone is made, both zones are
 * deleted again, so a retry never leaves a pair behind. The key is used for these calls only and never kept. `api`
 * replaces api.bunny.net (tests).
 * ponytail: no replication regions; add a choice when someone asks for a second region
 */
export async function createBunnyZone(
  apiKey: string,
  region: string,
  check: (zone: Omit<BunnyPlace, "origin">) => Promise<string | null>,
  api = "https://api.bunny.net",
): Promise<Omit<BunnyPlace, "origin">> {
  const headers = { AccessKey: apiKey, "Content-Type": "application/json", Accept: "application/json" };
  const name = `ct-${randomBytes(6).toString("hex")}`; // zone names are global on Bunny: a random one never collides
  const made = await fetch(`${api}/storagezone`, { method: "POST", headers, body: JSON.stringify({ Name: name, Region: region }) });
  if (!made.ok) throw await refusal(made, "to make a storage zone");
  const zone = (await made.json()) as { Id: number; Password: string; StorageHostname?: string };
  let pullId: number | undefined;
  try {
    const pull = await fetch(`${api}/pullzone`, {
      method: "POST",
      headers,
      body: JSON.stringify({ Name: name, OriginType: 2, StorageZoneId: zone.Id, ZoneSecurityEnabled: true }),
    });
    if (!pull.ok) throw await refusal(pull, "to make a pull zone");
    let p = (await pull.json().catch(() => ({}))) as { Id?: number; ZoneSecurityKey?: string; Hostnames?: { Value: string; IsSystemHostname?: boolean }[] };
    pullId = p.Id;
    if (!p.ZoneSecurityKey && p.Id) p = (await (await fetch(`${api}/pullzone/${p.Id}`, { headers })).json()) as typeof p;
    if (!p.ZoneSecurityKey) throw new Error("Bunny made the pull zone but did not give its token key");
    // the zone's own storage host says its region: storage.bunnycdn.com is Falkenstein, ny.storage.bunnycdn.com New York
    const host = /^(?:([a-z]+)\.)?storage\.bunnycdn\.com$/.exec(zone.StorageHostname ?? "");
    const place = {
      zone: name,
      accessKey: zone.Password,
      region: host ? (host[1] ?? "") : region === "DE" ? "" : region.toLowerCase(),
      cdnHost: p.Hostnames?.find((h) => h.IsSystemHostname)?.Value ?? `${name}.b-cdn.net`,
      tokenKey: p.ZoneSecurityKey,
    };
    let failed: string | null = null;
    for (let i = 0; i < 3 && (failed = await check(place)); i++) await new Promise((done) => setTimeout(done, 2000));
    if (failed) throw new Error(failed);
    return place;
  } catch (e) {
    if (pullId) await fetch(`${api}/pullzone/${pullId}`, { method: "DELETE", headers }).catch(() => {});
    await fetch(`${api}/storagezone/${zone.Id}`, { method: "DELETE", headers }).catch(() => {});
    throw e;
  }
}
