import { verify, type KeyObject } from "node:crypto";

// A ticket is what the broker hands an account's browser or app for one computer: Ed25519 over the base64url JSON
// body, checked here against the broker key this computer pinned at link time. Same format as the broker's
// (apps/relay/src/tickets.ts). A ticket works once, for one host, one computer, one owner, for 120 s.

export const TICKET_TTL = 120;

export class TicketError extends Error {}

export interface TicketClaims {
  sub: string; // account id
  env: string; // computer id
  aud: string; // the computer's tunnel hostname
  iat: number;
  exp: number;
  jti: string;
}

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
  const [body, sig, extra] = ticket.split(".");
  if (!body || !sig || extra !== undefined) throw new TicketError("malformed");
  let signed = false;
  try {
    signed = verify(null, Buffer.from(body), o.relayPublicKey, Buffer.from(sig, "base64url"));
  } catch {
    signed = false;
  }
  if (!signed) throw new TicketError("bad signature");
  let c: TicketClaims;
  try {
    c = JSON.parse(Buffer.from(body, "base64url").toString()) as TicketClaims;
  } catch {
    throw new TicketError("malformed");
  }
  if (c.aud !== o.hostname) throw new TicketError("wrong host");
  if (c.env !== o.computerId) throw new TicketError("wrong computer");
  if (c.sub !== o.owner) throw new TicketError("wrong account");
  if (!(c.exp > o.now) || c.exp - c.iat > TICKET_TTL) throw new TicketError("expired");
  if (typeof c.jti !== "string" || !o.consume(c.jti, c.exp)) throw new TicketError("already used");
  return c;
}
