import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { env } from "../lib/env";
import { MIGRATIONS } from "./schema";
import { bunnyBlobs, type BunnyPlace } from "./storage/bunny";
import { localBlobs } from "./storage/local";
import { s3Blobs, s3Client, type S3Place } from "./storage/s3";
import type { BlobStore } from "./storage/types";
import { LIBRARY_UPLOADS, LOOK_BUDGET_DEFAULT, lookLevelOf, proxyQualityOf, type LibraryUpload, type LookLevel, type ProxyQuality } from "../../contracts/library";

/**
 * The library database uses Node's built-in `node:sqlite`: no native dependency. It needs Node 22.13+ (the
 * Docker image is node:22; the dev machine runs 22.18). Node prints a one-line experimental warning on first use.
 */

/** Opens a library database file and runs the migrations it is missing. */
export function openLibraryDb(file: string): DatabaseSync {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  if (file !== ":memory:") chmodSync(file, 0o600); // it holds libraries' own bucket keys (storage_config); the -wal and -shm files follow its mode
  // foreign keys (node:sqlite's default is on) are off while migrations run: a table rebuild (migration 3) drops a parent table
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF; PRAGMA busy_timeout = 5000;");
  const done = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  for (let i = done; i < MIGRATIONS.length; i++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[i]!);
      if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error(`Library migration ${i + 1} broke a foreign key`);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

let shared: DatabaseSync | null = null;

/** The server's library database, $DATA_DIR/library/library.db, opened on first use. */
export const libraryDb = (): DatabaseSync => (shared ??= openLibraryDb(path.join(env.dataDir, "library", "library.db")));

const local = localBlobs(path.join(env.dataDir, "library", "blobs"));
const remotes = new Map<string, BlobStore>();

/** Where an S3 library's bucket is: the server's (LIBRARY_S3_*, keys may come from Settings → API keys) or its own. */
export interface StorageConfig {
  mode: "server" | "own";
  endpoint?: string;
  region?: string;
  bucket?: string;
  pathStyle?: boolean;
  accessKey?: string;
  secretKey?: string;
}

/** The server's bucket for libraries, read at each use (a key saved in Settings lands in process.env). Null: not set up. */
export function serverBucket(): S3Place | null {
  const e = process.env;
  const bucket = e.LIBRARY_S3_BUCKET?.trim();
  const accessKey = e.LIBRARY_S3_ACCESS_KEY?.trim();
  const secretKey = e.LIBRARY_S3_SECRET_KEY?.trim();
  if (!bucket || !accessKey || !secretKey) return null;
  const endpoint = e.LIBRARY_S3_ENDPOINT?.trim() ?? "";
  return { endpoint, region: e.LIBRARY_S3_REGION?.trim() ?? "", bucket, pathStyle: e.LIBRARY_S3_FORCE_PATH_STYLE === "true", accessKey, secretKey };
}

/** The bucket a stored config names: own keys go only with the library's own endpoint and bucket, never the server's. */
export function placeOf(c: StorageConfig): S3Place | null {
  if (c.mode === "server") return serverBucket();
  if (!c.bucket || !c.accessKey || !c.secretKey) return null;
  return { endpoint: c.endpoint ?? "", region: c.region ?? "", bucket: c.bucket, pathStyle: !!c.pathStyle, accessKey: c.accessKey, secretKey: c.secretKey };
}

/** A Bunny library's zone, as its saved config names it (the same shape as BunnyPlace without the test origin). */
export type BunnyConfig = Omit<BunnyPlace, "origin">;

/** The store a library keeps its files in: local unless its owner chose a bucket. */
export function libraryStore(libraryId: string): BlobStore {
  const r = libraryDb().prepare("SELECT storage_kind, storage_config FROM libraries WHERE id = ?").get(libraryId) as
    | { storage_kind: "local" | "s3" | "bunny"; storage_config: string | null }
    | undefined;
  if (!r || r.storage_kind === "local") return local;
  return remoteStore(r.storage_kind, JSON.parse(r.storage_config ?? "{}") as StorageConfig & BunnyConfig);
}

/**
 * Where a library whose originals stay on this disk keeps its proxies instead: a bucket or a Bunny zone (Library
 * settings → Storage, "Proxies only"), saved as `{ proxies }` in storage_config. Null: next to the originals.
 */
export type ProxyPlace = ({ kind: "s3" } & StorageConfig) | ({ kind: "bunny" } & BunnyConfig);

export function proxyPlace(libraryId: string): ProxyPlace | null {
  const r = libraryDb().prepare("SELECT storage_kind, storage_config FROM libraries WHERE id = ?").get(libraryId) as
    | { storage_kind: string; storage_config: string | null }
    | undefined;
  if (r?.storage_kind !== "local" || !r.storage_config) return null;
  return (JSON.parse(r.storage_config) as { proxies?: ProxyPlace }).proxies ?? null;
}

/** Whether the library's proxies go to the cloud while its originals stay here: then every video gets one. */
export const proxiesInCloud = (libraryId: string): boolean => !!proxyPlace(libraryId);

/** A bucket or Bunny zone as a store, one per place, shared by every library that uses it. */
function remoteStore(kind: "s3" | "bunny", config: StorageConfig & BunnyConfig): BlobStore {
  if (kind === "s3") {
    const place = placeOf(config);
    if (!place) throw new Error("This library's bucket is not set up");
    return s3For(place);
  }
  const zone = { ...config } as BunnyConfig & { kind?: string };
  delete zone.kind;
  if (!zone.zone || !zone.accessKey) throw new Error("This library's bucket is not set up");
  const id = JSON.stringify(["bunny", zone]);
  let store = remotes.get(id);
  if (!store) {
    store = bunnyBlobs(zone, path.join(env.dataDir, "library", "cache"), { cacheBytes: cacheBytes() });
    remotes.set(id, store);
  }
  return store;
}

const cacheBytes = () => {
  const gb = Number(process.env.LIBRARY_CACHE_GB?.trim() || 20);
  return (Number.isFinite(gb) && gb > 0 ? gb : 20) * 1024 ** 3;
};

/** The server's own bucket as a store (the upload relay's hop), or null when LIBRARY_S3_* is not set up. */
export function serverStore(): BlobStore | null {
  const place = serverBucket();
  return place ? s3For(place) : null;
}

/** One store per bucket, shared by every library that uses it. */
function s3For(place: S3Place): BlobStore {
  const id = JSON.stringify(place);
  let store = remotes.get(id);
  if (!store) {
    store = s3Blobs(s3Client(place), place.bucket, path.join(env.dataDir, "library", "cache"), { cacheBytes: cacheBytes() });
    remotes.set(id, store);
  }
  return store;
}

/** A change in a library's stored bytes, on today's usage_daily row (UTC), which starts from the latest earlier row. */
export function meter(libraryId: string, delta: number): void {
  if (!delta) return;
  libraryDb()
    .prepare(
      `INSERT INTO usage_daily (library_id, day, stored_bytes)
       VALUES ($lib, $day, COALESCE((SELECT stored_bytes FROM usage_daily WHERE library_id = $lib ORDER BY day DESC LIMIT 1), 0) + $delta)
       ON CONFLICT (library_id, day) DO UPDATE SET stored_bytes = excluded.stored_bytes`,
    )
    .run({ lib: libraryId, day: new Date().toISOString().slice(0, 10), delta });
}

const libraryOf = (key: string) => /^libraries\/([^/]+)\//.exec(key)?.[1] ?? "";

/** The store a key is in: a proxy goes to the library's proxy place when it has one, everything else to its own store. */
const storeOf = (key: string): BlobStore => {
  const lib = libraryOf(key);
  const proxies = key.endsWith("/proxy.mp4") ? proxyPlace(lib) : null;
  return proxies ? remoteStore(proxies.kind, proxies as unknown as StorageConfig & BunnyConfig) : libraryStore(lib);
};

/**
 * The library's files by key, in the store of the library the key names (every key starts libraries/<libraryId>/), or
 * its proxy place for a proxy. Shared by the routes and the worker. Whatever is in a bucket is metered: each put and
 * delete moves usage_daily by its bytes (a put over an existing key by the difference). This disk writes no usage.
 */
export const blobs: Omit<BlobStore, "kind" | "caps"> = {
  async put(key, file, opts) {
    const store = storeOf(key);
    if (store.kind === "local") return store.put(key, file, opts);
    const before = (await store.stat(key))?.bytes ?? 0;
    const r = await store.put(key, file, opts);
    meter(libraryOf(key), r.bytes - before);
    return r;
  },
  async delete(key) {
    const store = storeOf(key);
    if (store.kind === "local") return store.delete(key);
    const before = (await store.stat(key))?.bytes ?? 0;
    await store.delete(key);
    meter(libraryOf(key), -before);
  },
  stat: (key) => storeOf(key).stat(key),
  localCopy: (key) => storeOf(key).localCopy(key),
  locate: (key, ttl, opts) => storeOf(key).locate(key, ttl, opts),
};

/** A library's on/off setting. describe and embed spend AI on every upload, so they are off until its owner turns them on. */
/**
 * All start on: describing and shot descriptions run on the uploader's own AI (or park until they connect one), and a
 * big upload says first what it will take (estimate.ts); search by meaning runs on an OpenAI key, else on this computer (embed.ts),
 * search by picture where this server makes picture vectors (pictures.ts).
 */
export const SETTING_DEFAULTS = { describe: true, look: true, timeline: true, embed: true, proxy: true, pictures: true, transcribe: true } as const;

/** What a file added from a computer the server is not on sends here (contracts LibrarySettings.upload); old true/false read as all/none. */
export const uploadOf = (v: unknown): LibraryUpload => (v === true || v === 1 ? "all" : LIBRARY_UPLOADS.includes(v as LibraryUpload) ? (v as LibraryUpload) : "none");
export const libraryUpload = (libraryId: string): LibraryUpload =>
  uploadOf((libraryDb().prepare("SELECT json_extract(settings, '$.upload') AS v FROM libraries WHERE id = ?").get(libraryId) as { v: unknown } | undefined)?.v);
/** What a final sends from a computer (contracts LibrarySettings.finalsUpload): "all" when it was never set. */
export const finalsUpload = (libraryId: string): LibraryUpload => {
  const v = (libraryDb().prepare("SELECT json_extract(settings, '$.finalsUpload') AS v FROM libraries WHERE id = ?").get(libraryId) as { v: unknown } | undefined)?.v;
  return v === null || v === undefined ? "all" : uploadOf(v);
};
/** Whether a collection is its library's Finals (finals.ts finalsCollectionId). */
export const isFinalsCollection = (collectionId: string): boolean =>
  !!libraryDb().prepare("SELECT 1 FROM collections WHERE id = ? AND parent_id IS NULL AND kind = 'manual' AND name = 'Finals'").get(collectionId);
/** The upload setting one version follows: a final's when its asset is in Finals, else the library's. */
export function versionUpload(versionId: string): LibraryUpload {
  const r = libraryDb()
    .prepare(
      `SELECT a.library_id AS lib, EXISTS (SELECT 1 FROM collection_items ci JOIN collections c ON c.id = ci.collection_id
         WHERE ci.asset_id = a.id AND c.parent_id IS NULL AND c.kind = 'manual' AND c.name = 'Finals') AS fin
       FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?`,
    )
    .get(versionId) as { lib: string; fin: number } | undefined;
  return !r ? "none" : r.fin ? finalsUpload(r.lib) : libraryUpload(r.lib);
}

/** The Proxy quality a library's proxies are made at (UNIFIED-PRD §4.1); absent reads as standard. */
export const libraryProxyQuality = (libraryId: string): ProxyQuality =>
  proxyQualityOf((libraryDb().prepare("SELECT json_extract(settings, '$.proxyQuality') AS q FROM libraries WHERE id = ?").get(libraryId) as { q: unknown } | undefined)?.q);

export const librarySetting = (libraryId: string, key: keyof typeof SETTING_DEFAULTS): boolean => {
  const on = (libraryDb().prepare(`SELECT json_extract(settings, '$.${key}') AS on_ FROM libraries WHERE id = ?`).get(libraryId) as { on_: number | null } | undefined)?.on_;
  return on === null || on === undefined ? SETTING_DEFAULTS[key] : !!on;
};

/** How densely the library describes shots (contracts LOOK_LEVELS). */
export const libraryLookLevel = (libraryId: string): LookLevel =>
  lookLevelOf((libraryDb().prepare("SELECT json_extract(settings, '$.lookLevel') AS v FROM libraries WHERE id = ?").get(libraryId) as { v: unknown } | undefined)?.v);

/** The library's monthly cap on shot descriptions in dollars: LOOK_BUDGET_DEFAULT until its owner sets one, null when they took it off. */
export function libraryLookBudget(libraryId: string): number | null {
  const r = libraryDb().prepare("SELECT json_type(settings, '$.lookBudget') AS t, json_extract(settings, '$.lookBudget') AS v FROM libraries WHERE id = ?").get(libraryId) as
    | { t: string | null; v: unknown }
    | undefined;
  if (!r?.t) return LOOK_BUDGET_DEFAULT;
  return typeof r.v === "number" && r.v >= 0 ? r.v : null;
}
