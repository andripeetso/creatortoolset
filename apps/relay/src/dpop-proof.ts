import { createHash, createPublicKey, verify } from 'node:crypto';

// DPoP proofs (RFC 9449), ES256 only: a phone signs each request with its own P-256 key, so a token caught on the way
// is useless without that key. The one check the connect service (this app) and every computer (apps/captions
// api/lib/dpop.ts imports this file) run. Pure: where spent proof ids are kept is the caller's (`spend`).
// Only node:crypto here, no other import: the relay runs this file as it is (type stripping), the computer bundles it.

export const DPOP_SKEW_S = 300; // seconds a proof's iat may be off, either way
/** How long a spent jti is kept: as long as a proof with it could still pass. */
export const JTI_KEEP_S = 2 * DPOP_SKEW_S + 1;
/** Proof ids one key may have spent at once. One key flooding is refused (busy) without touching anyone else's. */
export const MAX_JTIS_PER_KEY = 10_000;

export type DpopFailure = 'missing' | 'malformed' | 'key_mismatch' | 'method_mismatch' | 'url_mismatch' | 'token_mismatch' | 'signature' | 'time_window' | 'replay' | 'busy';
export type DpopCheck = { ok: true; jkt: string; jti: string } | { ok: false; code: DpopFailure };
/** Keeps a spent jti until `untilS`: 'ok' the first time, 'replay' when it was spent, 'busy' when this key holds too many. */
export type JtiSpend = (jkt: string, jti: string, untilS: number, nowS: number) => 'ok' | 'replay' | 'busy';

type P256 = { kty: string; crv: string; x: string; y: string };

const isB64 = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]+$/.test(v);
const object = (s: string): Record<string, unknown> => {
  const v: unknown = JSON.parse(Buffer.from(s, 'base64url').toString());
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
  return v as Record<string, unknown>;
};

/** RFC 7638 thumbprint of a P-256 key: base64url(SHA-256 of {"crv","kty","x","y"} in that order). */
export const jwkThumbprint = (jwk: P256): string =>
  createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest('base64url');

/** `ath`: base64url(SHA-256(access token)). */
export const tokenHash = (token: string): string => createHash('sha256').update(token).digest('base64url');

/** The request URL as a proof names it: no query, no fragment. Null when it is not a URL. */
export function htuOf(url: string): string | null {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

/**
 * Checks a proof: `typ` dpop+jwt, `alg` ES256, a public P-256 `jwk` in the header, `htm` = the method, `htu` = the URL
 * without query or fragment, a `jti` (≤ 256 characters), `iat` (seconds, a number) within ±300 s, `ath` when a token
 * rides along, the key when `jkt` is given, then the signature. Cheap checks first; the jti is spent last, so a bad
 * proof never burns one. No `spend`: the caller spends `jti` itself once the rest of its request went through.
 */
export function checkProof(
  o: { proof: string | null | undefined; method: string; url: string; nowS: number; accessToken?: string; jkt?: string },
  spend?: JtiSpend,
): DpopCheck {
  const no = (code: DpopFailure): DpopCheck => ({ ok: false, code });
  if (!o.proof) return no('missing');
  const parts = o.proof.split('.');
  if (parts.length !== 3 || !parts.every(isB64)) return no('malformed');
  let header: Record<string, unknown>, claims: Record<string, unknown>;
  try {
    header = object(parts[0]);
    claims = object(parts[1]);
  } catch {
    return no('malformed');
  }
  const jwk = header.jwk as Record<string, unknown> | undefined;
  if (header.typ !== 'dpop+jwt' || header.alg !== 'ES256' || !jwk || typeof jwk !== 'object' || Array.isArray(jwk)) return no('malformed');
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !isB64(jwk.x) || !isB64(jwk.y) || 'd' in jwk) return no('malformed');
  const { htm, htu, jti, iat } = claims;
  if (typeof htm !== 'string' || typeof htu !== 'string' || typeof jti !== 'string' || !jti || jti.length > 256) return no('malformed');
  if (typeof iat !== 'number' || !Number.isFinite(iat)) return no('malformed');
  const jkt = jwkThumbprint(jwk as P256);
  if (o.jkt !== undefined && jkt !== o.jkt) return no('key_mismatch');
  if (htm.toUpperCase() !== o.method.toUpperCase()) return no('method_mismatch');
  const want = htuOf(o.url);
  if (!want || htu !== want) return no('url_mismatch');
  if (o.accessToken !== undefined && claims.ath !== tokenHash(o.accessToken)) return no('token_mismatch');
  if (Math.abs(o.nowS - iat) > DPOP_SKEW_S) return no('time_window');
  let signed = false;
  try {
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x as string, y: jwk.y as string }, format: 'jwk' });
    signed = verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url'));
  } catch {
    signed = false;
  }
  if (!signed) return no('signature');
  if (spend) {
    const spent = spend(jkt, jti, o.nowS + JTI_KEEP_S, o.nowS);
    if (spent !== 'ok') return no(spent);
  }
  return { ok: true, jkt, jti };
}
