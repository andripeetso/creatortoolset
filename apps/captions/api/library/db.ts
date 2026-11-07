import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { env } from "../lib/env";
import { MIGRATIONS } from "./schema";
import { localBlobs } from "./storage/local";

/**
 * The library database uses Node's built-in `node:sqlite`: no native dependency. It needs Node 22.13+ (the
 * Docker image is node:22; the dev machine runs 22.18). Node prints a one-line experimental warning on first use.
 */

/** Opens a library database file and runs the migrations it is missing. */
export function openLibraryDb(file: string): DatabaseSync {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const done = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  for (let i = done; i < MIGRATIONS.length; i++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return db;
}

let shared: DatabaseSync | null = null;

/** The server's library database, $DATA_DIR/library/library.db, opened on first use. */
export const libraryDb = (): DatabaseSync => (shared ??= openLibraryDb(path.join(env.dataDir, "library", "library.db")));

/** The library's files, $DATA_DIR/library/blobs, by key (storage/local.ts). Shared by the routes and the worker. */
export const blobs = localBlobs(path.join(env.dataDir, "library", "blobs"));

/** A library's on/off setting. describe and embed spend AI on every upload, so they are off until its owner turns them on. */
export const librarySetting = (libraryId: string, key: "describe" | "embed"): boolean =>
  !!(libraryDb().prepare(`SELECT json_extract(settings, '$.${key}') AS on_ FROM libraries WHERE id = ?`).get(libraryId) as { on_: number | null } | undefined)?.on_;
