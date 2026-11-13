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
    CREATE INDEX IF NOT EXISTS computers_account ON computers (account_id);
    -- AI apps connected through this broker (gateway.ts). One row per connection; the computer's key for it is sealed.
    CREATE TABLE IF NOT EXISTS ai_grants (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      computer_id TEXT NOT NULL,
      app TEXT NOT NULL,
      key_sealed TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      used_at INTEGER);
    CREATE UNIQUE INDEX IF NOT EXISTS ai_grants_one ON ai_grants (account_id, computer_id, app);
    CREATE TABLE IF NOT EXISTS ai_tokens (
      token_hash TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL,
      created_at INTEGER NOT NULL);
    -- Tool calls per day, per AI app and tool name. Counts only: nothing about who called or with what.
    CREATE TABLE IF NOT EXISTS ai_daily (
      day TEXT NOT NULL,
      app TEXT NOT NULL,
      tool TEXT NOT NULL,
      calls INTEGER NOT NULL DEFAULT 0,
      unreachable INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, app, tool));`);
  // Added later, so an older file gets them too. released_at: the reaper deleted the tunnel of a computer that was down;
  // the computer stays on the account and gets a new tunnel when it asks. recovers: the computer has asked at least once,
  // so it can get one back (older apps cannot, and their tunnels are never released).
  const cols = new Set((db.prepare('PRAGMA table_info(computers)').all() as { name: string }[]).map((c) => c.name));
  if (!cols.has('released_at')) db.exec('ALTER TABLE computers ADD COLUMN released_at INTEGER');
  if (!cols.has('recovers')) db.exec('ALTER TABLE computers ADD COLUMN recovers INTEGER NOT NULL DEFAULT 0');
  return db;
}
