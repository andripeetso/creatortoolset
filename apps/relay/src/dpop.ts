import type { DatabaseSync } from 'node:sqlite';
import { checkProof, jwkThumbprint, MAX_JTIS_PER_KEY, type JtiSpend } from './dpop-proof.ts';
import { HttpError } from './errors.ts';

// DPoP proofs (RFC 9449): the shared check (dpop-proof.ts) with spent proof ids kept in the dpop_jti table.

export { jwkThumbprint, MAX_JTIS_PER_KEY };

/** The table's primary key (jkt, jti) refuses a replay; a key holding MAX_JTIS_PER_KEY live ids is busy, others are not. */
const spendIn = (db: DatabaseSync): JtiSpend => (jkt, jti, untilS, nowS) => {
  db.prepare('DELETE FROM dpop_jti WHERE expires_at <= ?').run(nowS);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM dpop_jti WHERE jkt = ?').get(jkt) as { n: number };
  if (n >= MAX_JTIS_PER_KEY) return 'busy';
  return db.prepare('INSERT OR IGNORE INTO dpop_jti (jkt, jti, expires_at) VALUES (?, ?, ?)').run(jkt, jti, untilS).changes === 1 ? 'ok' : 'replay';
};

/**
 * Checks a DPoP proof and spends its jti; returns the key's thumbprint. `accessToken` set: the proof must carry its
 * hash (ath). `jkt` set: the proof must be made with that key. A failure is 401 invalid_dpop; a key past its cap 503 busy.
 */
export function checkDpop(
  db: DatabaseSync,
  proof: string | null,
  o: { method: string; url: string; now: number; accessToken?: string; jkt?: string },
): string {
  const r = checkProof({ proof, method: o.method, url: o.url, nowS: o.now, accessToken: o.accessToken, jkt: o.jkt }, spendIn(db));
  if (r.ok) return r.jkt;
  throw r.code === 'busy' ? new HttpError(503, 'busy') : new HttpError(401, 'invalid_dpop');
}
