import { DatabaseSync } from 'node:sqlite';

export function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS devices (
      device_hash TEXT PRIMARY KEY,
      user_code TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL,
      account_id TEXT,
      expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS challenges (
      nonce TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS computers (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      name TEXT NOT NULL,
      origin TEXT NOT NULL,
      hostname TEXT NOT NULL UNIQUE,
      tunnel_id TEXT NOT NULL,
      dns_id TEXT NOT NULL,
      idle_since INTEGER,
      created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS computers_account ON computers (account_id);`);
  // Added later, so an older file gets them too. released_at: the reaper deleted the tunnel of a computer that was down;
  // the computer stays on the account and gets a new tunnel when it asks. recovers: the computer has asked at least once,
  // so it can get one back (older apps cannot, and their tunnels are never released).
  const cols = new Set((db.prepare('PRAGMA table_info(computers)').all() as { name: string }[]).map((c) => c.name));
  if (!cols.has('released_at')) db.exec('ALTER TABLE computers ADD COLUMN released_at INTEGER');
  if (!cols.has('recovers')) db.exec('ALTER TABLE computers ADD COLUMN recovers INTEGER NOT NULL DEFAULT 0');
  return db;
}
