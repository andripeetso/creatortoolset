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
  return db;
}
