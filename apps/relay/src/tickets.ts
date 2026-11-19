import { createHmac, timingSafeEqual } from 'node:crypto';

// Account tokens: HMAC-SHA256 with RELAY_ACCOUNT_SECRET, shared with the hosted site, which mints them for browsers
// and the Mac app. The same format is minted here after a device-grant approval. Phones trade one for a DPoP-bound
// token (connect.ts); what a computer checks is signed with the relay's Ed25519 key instead, never with this secret.

export const ACCOUNT_TTL = 3600;

export class TokenError extends Error {}

function mac(secret: Buffer, body: string): Buffer {
  return createHmac('sha256', secret).update(body).digest();
}

export function mintAccountToken(secret: Buffer, sub: string, now: number, jkt?: string): string {
  const body = Buffer.from(JSON.stringify({ sub, exp: now + ACCOUNT_TTL, ...(jkt ? { jkt } : {}) })).toString('base64url');
  return `${body}.${mac(secret, body).toString('base64url')}`;
}

// Returns the account id and, for an app whose account token is bound to its key, that key's thumbprint; or throws.
export function checkAccountToken(secret: Buffer, token: string, now: number): { account: string; jkt?: string } {
  const [body, tag, extra] = token.split('.');
  if (!body || !tag || extra !== undefined) throw new TokenError('malformed');
  const want = mac(secret, body);
  const got = Buffer.from(tag, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new TokenError('bad mac');
  const c = JSON.parse(Buffer.from(body, 'base64url').toString()) as { sub: string; exp: number; jkt?: unknown };
  if (!(c.exp > now)) throw new TokenError('expired');
  return typeof c.jkt === 'string' ? { account: c.sub, jkt: c.jkt } : { account: c.sub };
}
