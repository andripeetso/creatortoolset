import { randomBytes, verify } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Cloudflare } from './cloudflare.ts';
import { HttpError } from './errors.ts';
import type { LimitFor } from './limits.ts';
import { keyId, parsePublicKey, publicKeyB64 } from './keys.ts';
import { issueTicket } from './tickets.ts';
import type { KeyObject } from 'node:crypto';

export const CHALLENGE_TTL = 120; // seconds

export interface LinkDeps {
  db: DatabaseSync;
  cf: Cloudflare;
  now: () => number;
  limitFor: LimitFor;
  tunnelDomain: string; // computers get <id>.<tunnelDomain>
  signing: { privateKey: KeyObject; publicKey: KeyObject; kid: string };
}

const ORIGIN = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/; // a computer's local server, and only that
const hostOf = (id: string, domain: string) => `${id}.${domain}`;

function linkedCount(db: DatabaseSync, accountId: string): number {
  const r = db.prepare('SELECT COUNT(*) AS n FROM computers WHERE account_id = ?').get(accountId) as { n: number };
  return Number(r.n);
}

// The first step of a link: a one-time nonce bound to the account. Refused past the account's computer limit.
export function createChallenge(d: LinkDeps, accountId: string) {
  const now = d.now();
  if (linkedCount(d.db, accountId) >= d.limitFor(accountId)) throw new HttpError(403, 'limit_reached');
  d.db.prepare('DELETE FROM challenges WHERE expires_at <= ?').run(now);
  const nonce = randomBytes(32).toString('base64url');
  d.db.prepare('INSERT INTO challenges (nonce, account_id, expires_at) VALUES (?, ?, ?)').run(nonce, accountId, now + CHALLENGE_TTL);
  return { nonce, expires_in: CHALLENGE_TTL };
}

// Body: public_key (base64 SPKI of the computer's Ed25519 key), payload (the JSON text the computer signed),
// signature (base64 Ed25519 over the payload bytes). The signature is checked before the payload is parsed.
export async function linkComputer(d: LinkDeps, accountId: string, body: Record<string, unknown>) {
  const { public_key, payload, signature } = body;
  if (typeof public_key !== 'string' || typeof payload !== 'string' || typeof signature !== 'string') {
    throw new HttpError(400, 'bad_request');
  }
  if (payload.length > 2048) throw new HttpError(400, 'bad_request');
  let key: KeyObject;
  try {
    key = parsePublicKey(public_key);
  } catch {
    throw new HttpError(400, 'bad_key');
  }
  let signed = false;
  try {
    signed = verify(null, Buffer.from(payload), key, Buffer.from(signature, 'base64'));
  } catch {
    signed = false;
  }
  if (!signed) throw new HttpError(401, 'bad_signature');

  let p: { nonce?: unknown; name?: unknown; origin?: unknown };
  try {
    p = JSON.parse(payload);
  } catch {
    throw new HttpError(400, 'bad_request');
  }
  const name = typeof p.name === 'string' ? p.name.trim() : '';
  const origin = typeof p.origin === 'string' ? p.origin : '';
  if (typeof p.nonce !== 'string' || !name || name.length > 64 || !ORIGIN.test(origin)) {
    throw new HttpError(400, 'bad_request');
  }
  const port = Number(ORIGIN.exec(origin)![1]);
  if (port < 1 || port > 65535) throw new HttpError(400, 'bad_request');

  // Spend the nonce in one statement: of two links that race, only one finds it.
  const now = d.now();
  const spent = d.db
    .prepare('DELETE FROM challenges WHERE nonce = ? AND account_id = ? AND expires_at > ?')
    .run(p.nonce, accountId, now);
  if (spent.changes !== 1) throw new HttpError(401, 'bad_challenge');

  const id = keyId(key);
  const hostname = hostOf(id, d.tunnelDomain);
  if (d.db.prepare('SELECT 1 FROM computers WHERE id = ?').get(id)) throw new HttpError(409, 'already_linked');
  if (linkedCount(d.db, accountId) >= d.limitFor(accountId)) throw new HttpError(403, 'limit_reached');

  // Reserve the row before any Cloudflare call, so a racing link counts it against the limit.
  d.db
    .prepare(`INSERT INTO computers (id, account_id, name, origin, hostname, tunnel_id, dns_id, idle_since, created_at)
              VALUES (?, ?, ?, ?, ?, '', '', NULL, ?)`)
    .run(id, accountId, name, origin, hostname, now);

  const row = { tunnel: '', dns: '' };
  try {
    row.tunnel = await d.cf.createTunnel(`ct-${id}`);
    d.db.prepare('UPDATE computers SET tunnel_id = ? WHERE id = ?').run(row.tunnel, id);
    await d.cf.configureIngress(row.tunnel, hostname, origin);
    row.dns = await d.cf.createDns(hostname, row.tunnel);
    d.db.prepare('UPDATE computers SET dns_id = ? WHERE id = ?').run(row.dns, id);
    const tunnelToken = await d.cf.tunnelToken(row.tunnel);
    return {
      computer_id: id,
      hostname,
      tunnel_token: tunnelToken,
      relay_kid: d.signing.kid,
      relay_public_key: publicKeyB64(d.signing.publicKey),
    };
  } catch (e) {
    // Undo what was created. If Cloudflare refuses the undo, keep the row: the reaper removes it later.
    try {
      if (row.dns) await d.cf.deleteDns(row.dns);
      if (row.tunnel) await d.cf.deleteTunnel(row.tunnel);
      d.db.prepare('DELETE FROM computers WHERE id = ?').run(id);
    } catch {
      // the reaper owns what is left
    }
    console.error('link failed', id, (e as Error).message);
    throw new HttpError(502, 'cloudflare');
  }
}

export function listComputers(d: LinkDeps, accountId: string) {
  return d.db
    .prepare('SELECT id, name, hostname, tunnel_id, created_at FROM computers WHERE account_id = ? ORDER BY created_at')
    .all(accountId) as unknown as { id: string; name: string; hostname: string; tunnel_id: string; created_at: number }[];
}

// The owner's ticket for one of their computers. Another account's computer is "not found", never "forbidden".
export function ticketFor(d: LinkDeps, accountId: string, computerId: string) {
  const row = d.db.prepare('SELECT hostname FROM computers WHERE id = ? AND account_id = ?').get(computerId, accountId) as
    | { hostname: string }
    | undefined;
  if (!row) throw new HttpError(404, 'not_found');
  return {
    ticket: issueTicket(d.signing.privateKey, { sub: accountId, env: computerId, aud: row.hostname }, d.now()),
    hostname: row.hostname,
    expires_in: 120,
  };
}

// Removes a computer's tunnel and DNS record, then its row. Used by unlink and the reaper. Cloudflare 404s are
// fine (already gone), any other error throws and leaves the row for a retry.
export async function removeComputer(d: { db: DatabaseSync; cf: Cloudflare }, row: { id: string; tunnel_id: string; dns_id: string }) {
  if (row.dns_id) await d.cf.deleteDns(row.dns_id);
  if (row.tunnel_id) await d.cf.deleteTunnel(row.tunnel_id);
  d.db.prepare('DELETE FROM computers WHERE id = ?').run(row.id);
}

export async function unlinkComputer(d: LinkDeps, accountId: string, computerId: string) {
  const row = d.db.prepare('SELECT id, tunnel_id, dns_id FROM computers WHERE id = ? AND account_id = ?').get(computerId, accountId) as
    | { id: string; tunnel_id: string; dns_id: string }
    | undefined;
  if (row) await removeComputer(d, row);
}
