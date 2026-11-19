import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';

// Test vectors for the DPoP proof check (src/dpop-proof.ts), run by this app's tests and by the computer's
// (apps/captions api/lib/dpop.test.ts), so both answer every case the same way. Only node:crypto: both runners load it.

type Key = { privateKey: KeyObject; jwk: { kty: string; crv: string; x: string; y: string } };
export type DpopVector = {
  name: string;
  proof: string | undefined;
  method: string;
  url: string;
  nowS: number;
  accessToken?: string;
  jkt?: string;
  expect: 'ok' | 'missing' | 'malformed' | 'key_mismatch' | 'method_mismatch' | 'url_mismatch' | 'token_mismatch' | 'signature' | 'time_window';
};

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const keyPair = (): Key => {
  const k = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const j = k.publicKey.export({ format: 'jwk' }) as Key['jwk'];
  return { privateKey: k.privateKey, jwk: { kty: j.kty, crv: j.crv, x: j.x, y: j.y } };
};
const signed = (key: KeyObject, head: string) => `${head}.${sign('sha256', Buffer.from(head), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
const thumb = (j: Key['jwk']) => createHash('sha256').update(JSON.stringify({ crv: j.crv, kty: j.kty, x: j.x, y: j.y })).digest('base64url');

export function dpopVectors(nowS = Math.floor(Date.now() / 1000)): DpopVector[] {
  const phone = keyPair();
  const other = keyPair();
  const url = 'https://computer.example/api/library';
  const token = `cts_${'a'.repeat(43)}`;
  const ath = createHash('sha256').update(token).digest('base64url');
  const proof = (claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}, by: Key = phone) =>
    signed(by.privateKey, `${b64({ typ: 'dpop+jwt', alg: 'ES256', jwk: phone.jwk, ...header })}.${b64({ htm: 'GET', htu: url, jti: randomUUID(), iat: nowS, ath, ...claims })}`);
  const base = { method: 'GET', url: `${url}?page=2#top`, nowS, accessToken: token };
  return [
    { name: 'a good proof, query and fragment left out of htu', proof: proof(), ...base, jkt: thumb(phone.jwk), expect: 'ok' },
    { name: 'a lower-case method', proof: proof({ htm: 'get' }), ...base, expect: 'ok' },
    { name: 'a decimal iat (RFC 9449 NumericDate)', proof: proof({ iat: nowS + 0.5 }), ...base, expect: 'ok' },
    { name: 'iat 299 s off', proof: proof({ iat: nowS - 299 }), ...base, expect: 'ok' },
    { name: 'no access token, no ath needed', proof: proof({ ath: undefined }), method: 'GET', url, nowS, expect: 'ok' },
    { name: 'no proof', proof: undefined, ...base, expect: 'missing' },
    { name: 'two parts', proof: 'a.b', ...base, expect: 'malformed' },
    { name: 'a part that is not base64url', proof: `${proof()}!`, ...base, expect: 'malformed' },
    { name: 'a header that is JSON null', proof: signed(phone.privateKey, `${b64(null)}.${b64({ htm: 'GET', htu: url, jti: 'j', iat: nowS })}`), ...base, expect: 'malformed' },
    { name: 'a jwk that is a string', proof: proof({}, { jwk: 'key' }), ...base, expect: 'malformed' },
    { name: 'a jwk with its private part', proof: proof({}, { jwk: { ...phone.jwk, d: 'secret' } }), ...base, expect: 'malformed' },
    { name: 'typ JWT', proof: proof({}, { typ: 'JWT' }), ...base, expect: 'malformed' },
    { name: 'alg ES384', proof: proof({}, { alg: 'ES384' }), ...base, expect: 'malformed' },
    { name: 'iat as a string', proof: proof({ iat: String(nowS) }), ...base, expect: 'malformed' },
    { name: 'a jti of 257 characters', proof: proof({ jti: 'j'.repeat(257) }), ...base, expect: 'malformed' },
    { name: 'no jti', proof: proof({ jti: '' }), ...base, expect: 'malformed' },
    { name: 'another key than the session holds', proof: proof(), ...base, jkt: thumb(other.jwk), expect: 'key_mismatch' },
    { name: 'the wrong method', proof: proof({ htm: 'POST' }), ...base, expect: 'method_mismatch' },
    { name: 'another URL', proof: proof({ htu: 'https://other.example/api/library' }), ...base, expect: 'url_mismatch' },
    { name: 'htu with the query', proof: proof({ htu: `${url}?page=2` }), ...base, expect: 'url_mismatch' },
    { name: 'a token without ath', proof: proof({ ath: undefined }), ...base, expect: 'token_mismatch' },
    { name: 'ath of another token', proof: proof({ ath: 'x' }), ...base, expect: 'token_mismatch' },
    { name: 'iat 301 s old', proof: proof({ iat: nowS - 301 }), ...base, expect: 'time_window' },
    { name: 'iat 301 s ahead', proof: proof({ iat: nowS + 301 }), ...base, expect: 'time_window' },
    { name: 'signed by another key than its header names', proof: proof({}, {}, other), ...base, expect: 'signature' },
  ];
}
