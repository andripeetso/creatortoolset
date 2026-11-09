import { createHmac, randomBytes, sign, timingSafeEqual, verify, type KeyObject } from 'node:crypto';

// Tokens. Two kinds, two keys, so neither can pass as the other:
// - account tokens: HMAC-SHA256 with RELAY_ACCOUNT_SECRET, shared with the hosted site, which mints them for
//   browsers and the Mac app. The same format is minted here after a device-grant approval.
// - tickets: Ed25519, signed by the relay. A computer checks them against the relay key it pinned at link time.

export const TICKET_TTL = 120; // seconds (plan §4.3)
export const ACCOUNT_TTL = 3600;

export class TokenError extends Error {}

interface TicketClaims {
  sub: string; // account id
  env: string; // computer id
  aud: string; // the computer's tunnel hostname
  iat: number;
  exp: number;
  jti: string;
}

// Body is base64url JSON; the signature covers the base64url text exactly as sent.
export function issueTicket(privateKey: KeyObject, c: { sub: string; env: string; aud: string }, now: number): string {
  const claims: TicketClaims = { ...c, iat: now, exp: now + TICKET_TTL, jti: randomBytes(16).toString('base64url') };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${body}.${sign(null, Buffer.from(body), privateKey).toString('base64url')}`;
}

// What a computer runs on the ticket it receives (WP4a imports or copies this). `consume(jti, exp)` must return
// true only the first time it sees a jti, so a ticket works once.
export function verifyTicket(
  ticket: string,
  o: {
    relayPublicKey: KeyObject;
    hostname: string;
    computerId: string;
    owner: string;
    now: number;
    consume: (jti: string, exp: number) => boolean;
  },
): TicketClaims {
  const [body, sig, extra] = ticket.split('.');
  if (!body || !sig || extra !== undefined) throw new TokenError('malformed');
  if (!verify(null, Buffer.from(body), o.relayPublicKey, Buffer.from(sig, 'base64url'))) {
    throw new TokenError('bad signature');
  }
  const c = JSON.parse(Buffer.from(body, 'base64url').toString()) as TicketClaims;
  if (c.aud !== o.hostname) throw new TokenError('wrong host');
  if (c.env !== o.computerId) throw new TokenError('wrong computer');
  if (c.sub !== o.owner) throw new TokenError('wrong account');
  if (!(c.exp > o.now) || c.exp - c.iat > TICKET_TTL) throw new TokenError('expired');
  if (!o.consume(c.jti, c.exp)) throw new TokenError('already used');
  return c;
}

function mac(secret: Buffer, body: string): Buffer {
  return createHmac('sha256', secret).update(body).digest();
}

export function mintAccountToken(secret: Buffer, sub: string, now: number): string {
  const body = Buffer.from(JSON.stringify({ sub, exp: now + ACCOUNT_TTL })).toString('base64url');
  return `${body}.${mac(secret, body).toString('base64url')}`;
}

// Returns the account id, or throws.
export function checkAccountToken(secret: Buffer, token: string, now: number): string {
  const [body, tag, extra] = token.split('.');
  if (!body || !tag || extra !== undefined) throw new TokenError('malformed');
  const want = mac(secret, body);
  const got = Buffer.from(tag, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new TokenError('bad mac');
  const c = JSON.parse(Buffer.from(body, 'base64url').toString()) as { sub: string; exp: number };
  if (!(c.exp > now)) throw new TokenError('expired');
  return c.sub;
}
