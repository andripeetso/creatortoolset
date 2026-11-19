import { createHash, createPublicKey, verify } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './errors.ts';

// DPoP proofs (RFC 9449), ES256 only: a phone signs each request with its own P-256 key, so a token it holds is no use
// to anyone without that key. The same checks the computer runs on its own /oauth/token.

export const DPOP_SKEW = 300; // seconds a proof's iat may be off, either way (the computer's own rule, contract.md)
const JTI_KEEP = 2 * DPOP_SKEW + 1; // a jti is remembered as long as its proof could still pass (about 10 min)

type Jwk = { kty?: unknown; crv?: unknown; x?: unknown; y?: unknown; d?: unknown };

/** RFC 7638 thumbprint of a P-256 public key: SHA-256 over its required members in lexical order, base64url. */
export function jwkThumbprint(jwk: { crv: string; kty: string; x: string; y: string }): string {
  return createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest('base64url');
}

/** The htu a proof must name: the request URL without query or fragment. */
export function htuOf(url: string): string {
  const u = new URL(url);
  u.search = '';
  u.hash = '';
  return u.href;
}

const part = (s: string) => {
  const v = JSON.parse(Buffer.from(s, 'base64url').toString());
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
  return v as Record<string, unknown>;
};

/**
 * Checks a DPoP proof and spends its jti; returns the key's thumbprint. `accessToken` set: the proof must carry its
 * hash (ath). `jkt` set: the proof must be made with that key. Any failure is 401 invalid_dpop.
 */
export function checkDpop(
  db: DatabaseSync,
  proof: string | null,
  o: { method: string; url: string; now: number; accessToken?: string; jkt?: string },
): string {
  const no = () => new HttpError(401, 'invalid_dpop');
  const parts = (proof ?? '').split('.');
  if (parts.length !== 3 || parts.some((p) => !p)) throw no();
  let header: Record<string, unknown>, claims: Record<string, unknown>;
  try {
    header = part(parts[0]);
    claims = part(parts[1]);
  } catch {
    throw no();
  }
  const jwk = header.jwk as Jwk | undefined;
  if (header.typ !== 'dpop+jwt' || header.alg !== 'ES256' || !jwk || typeof jwk !== 'object' || jwk.d !== undefined) throw no();
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') throw no();
  const thumb = jwkThumbprint(jwk as { crv: string; kty: string; x: string; y: string });
  if (o.jkt !== undefined && thumb !== o.jkt) throw no();
  if (typeof claims.htm !== 'string' || claims.htm.toUpperCase() !== o.method.toUpperCase()) throw no();
  if (claims.htu !== htuOf(o.url)) throw no();
  if (typeof claims.jti !== 'string' || !claims.jti || claims.jti.length > 256) throw no();
  if (!Number.isInteger(claims.iat) || Math.abs(o.now - (claims.iat as number)) > DPOP_SKEW) throw no();
  if (o.accessToken !== undefined && claims.ath !== createHash('sha256').update(o.accessToken).digest('base64url')) throw no();
  let signed = false;
  try {
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
    signed = verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url'));
  } catch {
    signed = false;
  }
  if (!signed) throw no();
  // spent after every other check, so a bad proof cannot burn someone's jti
  db.prepare('DELETE FROM dpop_jti WHERE expires_at <= ?').run(o.now);
  const fresh = db.prepare('INSERT OR IGNORE INTO dpop_jti (jkt, jti, expires_at) VALUES (?, ?, ?)').run(thumb, claims.jti, o.now + JTI_KEEP);
  if (fresh.changes !== 1) throw no();
  return thumb;
}
