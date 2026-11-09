import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { env } from "../lib/env";
import { MIGRATIONS } from "./schema";
import { bunnyBlobs, type BunnyPlace } from "./storage/bunny";
import { localBlobs } from "./storage/local";
import { s3Blobs, s3Client, type S3Place } from "./storage/s3";
import type { BlobStore } from "./storage/types";

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
  const gb = Number(process.env.LIBRARY_CACHE_GB?.trim() || 20);
  const cacheBytes = (Number.isFinite(gb) && gb > 0 ? gb : 20) * 1024 ** 3;
  const cacheDir = path.join(env.dataDir, "library", "cache");
  if (r.storage_kind === "bunny") {
    const zone = JSON.parse(r.storage_config ?? "{}") as BunnyConfig;
    if (!zone.zone || !zone.accessKey) throw new Error("This library's bucket is not set up");
    const id = JSON.stringify(["bunny", zone]);
    let store = remotes.get(id);
    if (!store) {
      store = bunnyBlobs(zone, cacheDir, { cacheBytes });
      remotes.set(id, store);
    }
    return store;
  }
  const place = placeOf(JSON.parse(r.storage_config ?? "{}") as StorageConfig);
  if (!place) throw new Error("This library's bucket is not set up");
  return s3For(place);
}

/** The server's own bucket as a store (the upload relay's hop), or null when LIBRARY_S3_* is not set up. */
export function serverStore(): BlobStore | null {
  const place = serverBucket();
  return place ? s3For(place) : null;
}

/** One store per bucket, shared by every library that uses it. */
function s3For(place: S3Place): BlobStore {
  const gb = Number(process.env.LIBRARY_CACHE_GB?.trim() || 20);
  const cacheBytes = (Number.isFinite(gb) && gb > 0 ? gb : 20) * 1024 ** 3;
  const cacheDir = path.join(env.dataDir, "library", "cache");
  const id = JSON.stringify(place);
  let store = remotes.get(id);
  if (!store) {
    store = s3Blobs(s3Client(place), place.bucket, cacheDir, { cacheBytes });
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

/**
 * The library's files by key, in the store of the library the key names (every key starts libraries/<libraryId>/).
 * Shared by the routes and the worker. Bucket libraries are metered: each put and delete moves usage_daily by its bytes
 * (a put over an existing key by the difference). Local libraries are the server's own disk and write no usage.
 */
export const blobs: Omit<BlobStore, "kind" | "caps"> = {
  async put(key, file, opts) {
    const lib = libraryOf(key);
    const store = libraryStore(lib);
    if (store.kind === "local") return store.put(key, file, opts);
    const before = (await store.stat(key))?.bytes ?? 0;
    const r = await store.put(key, file, opts);
    meter(lib, r.bytes - before);
    return r;
  },
  async delete(key) {
    const lib = libraryOf(key);
    const store = libraryStore(lib);
    if (store.kind === "local") return store.delete(key);
    const before = (await store.stat(key))?.bytes ?? 0;
    await store.delete(key);
    meter(lib, -before);
  },
  stat: (key) => libraryStore(libraryOf(key)).stat(key),
  localCopy: (key) => libraryStore(libraryOf(key)).localCopy(key),
  locate: (key, ttl, opts) => libraryStore(libraryOf(key)).locate(key, ttl, opts),
};

/** A library's on/off setting. describe and embed spend AI on every upload, so they are off until its owner turns them on. */
export const librarySetting = (libraryId: string, key: "describe" | "embed"): boolean =>
  !!(libraryDb().prepare(`SELECT json_extract(settings, '$.${key}') AS on_ FROM libraries WHERE id = ?`).get(libraryId) as { on_: number | null } | undefined)?.on_;
