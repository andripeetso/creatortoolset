import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { checkProof, JTI_KEEP_S, MAX_JTIS_PER_KEY, type DpopFailure, type JtiSpend } from "../../../relay/src/dpop-proof";
import { env } from "./env";

/**
 * DPoP proofs (RFC 9449), ES256 only. The check is the one the connect service runs too (apps/relay/src/dpop-proof.ts,
 * imported as source: the bundle carries it, and the relay runs it without a build). Spent `jti`s are kept here in
 * memory, per key, for 10 min (longer than any `iat` they could pass with), and on disk ($DATA_DIR/dpop-jti.db) for
 * the same time: a restart, or the other process during a no-downtime swap (both open the same file, and SQLite's
 * insert is one step across them), still refuses a proof spent before.
 */
export { DPOP_SKEW_S, MAX_JTIS_PER_KEY, htuOf, jwkThumbprint, tokenHash, type DpopFailure } from "../../../relay/src/dpop-proof";
export type DpopResult = { ok: true; jkt: string; jti: string } | { ok: false; code: DpopFailure };

const seen = new Map<string, Map<string, number>>(); // jkt -> jti -> forget after (s)

let db: DatabaseSync | null | undefined;
/** The spent jtis on disk; null (memory only) when the file can't be opened, or in a test file with no data folder. */
function disk(): DatabaseSync | null {
  if (db !== undefined) return db;
  db = null;
  if (process.env.VITEST && !process.env.DATA_DIR) return db; // never the home folder's data from a test
  try {
    mkdirSync(env.dataDir, { recursive: true });
    const d = new DatabaseSync(path.join(env.dataDir, "dpop-jti.db"));
    d.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS spent (jkt TEXT NOT NULL, jti TEXT NOT NULL, until REAL NOT NULL, PRIMARY KEY (jkt, jti)) WITHOUT ROWID; CREATE INDEX IF NOT EXISTS spent_until ON spent (until);");
    db = d;
  } catch (e) {
    console.error("[dpop] spent proofs are kept in memory only:", e instanceof Error ? e.message : e);
  }
  return db;
}

const pruneKey = (jkt: string, ids: Map<string, number>, nowS: number) => {
  for (const [jti, until] of ids) if (until <= nowS) ids.delete(jti);
  if (ids.size === 0) seen.delete(jkt);
};
const prune = (nowS = Date.now() / 1000) => {
  for (const [jkt, ids] of seen) pruneKey(jkt, ids, nowS);
  try {
    db?.prepare("DELETE FROM spent WHERE until <= ?").run(nowS);
  } catch {
    // busy: the next minute's prune takes them
  }
};
setInterval(prune, 60_000).unref();

/** One key past its cap is busy; every other key goes on. Only a session's own key or a redeemed code reaches here. */
const spend: JtiSpend = (jkt, jti, untilS, nowS) => {
  let ids = seen.get(jkt);
  if (!ids) seen.set(jkt, (ids = new Map()));
  if (ids.has(jti)) return "replay";
  if (ids.size >= MAX_JTIS_PER_KEY) pruneKey(jkt, ids, nowS);
  if (ids.size >= MAX_JTIS_PER_KEY) return "busy";
  // spent in an earlier run of this server, or by its other process: the row is already there
  const d = disk();
  if (d && Number(d.prepare("INSERT OR IGNORE INTO spent (jkt, jti, until) VALUES (?, ?, ?)").run(jkt, jti, untilS).changes) === 0) return "replay";
  ids.set(jti, untilS);
  if (!seen.has(jkt)) seen.set(jkt, ids);
  return "ok";
};

/** Spends a proof checked with `spend: false`, once what it came with went through (POST /oauth/token: the code). */
export const spendJti = (jkt: string, jti: string, now = Date.now()): "ok" | "replay" | "busy" => spend(jkt, jti, now / 1000 + JTI_KEEP_S, now / 1000);

/** Forget every jti (tests). */
export const resetDpopReplay = () => {
  seen.clear();
  disk()?.exec("DELETE FROM spent");
};
/** The jti map itself (tests fill it). */
export const dpopReplayForTest = () => seen;

export function verifyDpop(o: {
  proof: string | undefined;
  method: string;
  url: string;
  now?: number; // ms
  expectedJkt?: string;
  accessToken?: string;
  /** false: the jti is checked, not spent; the caller spends it with spendJti */
  spend?: boolean;
}): DpopResult {
  const nowS = (o.now ?? Date.now()) / 1000;
  return checkProof(
    { proof: o.proof, method: o.method, url: o.url, nowS, accessToken: o.accessToken, jkt: o.expectedJkt },
    o.spend === false ? undefined : spend,
  );
}
