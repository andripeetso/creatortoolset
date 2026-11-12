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

// A body signed with a computer's own key: public_key (base64 SPKI Ed25519), payload (the JSON text it signed),
// signature (base64 over the payload bytes). The signature is checked before the payload is parsed.
function signedBody(body: Record<string, unknown>): { key: KeyObject; p: Record<string, unknown> } {
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

  let p: Record<string, unknown>;
  try {
    p = JSON.parse(payload);
  } catch {
    throw new HttpError(400, 'bad_request');
  }
  return { key, p };
}

// The link: a signed payload of { nonce, name, origin }.
export async function linkComputer(d: LinkDeps, accountId: string, body: Record<string, unknown>) {
  const { key, p } = signedBody(body);
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
    .prepare('SELECT id, name, hostname, tunnel_id, released_at, created_at FROM computers WHERE account_id = ? ORDER BY created_at')
    .all(accountId) as unknown as { id: string; name: string; hostname: string; tunnel_id: string; released_at: number | null; created_at: number }[];
}

export const PROOF_WINDOW = 300; // seconds a tunnel request's timestamp may be off

/**
 * A linked computer asks for its tunnel: when its server starts, then every few minutes. It signs { purpose: "tunnel",
 * computer_id, at } with its own key, so no account token is needed. While its tunnel stands the answer is
 * { unchanged: true } and Cloudflare is not called. When the reaper released it (the computer was down long enough),
 * a new tunnel is made, the computer's DNS record is pointed at it, and its token comes back: the hostname never changes.
 * A computer the broker does not have (unlinked from the account) is 404 unknown_computer.
 */
export async function renewTunnel(d: LinkDeps, computerId: string, body: Record<string, unknown>) {
  const { key, p } = signedBody(body);
  const now = d.now();
  if (keyId(key) !== computerId || p.purpose !== 'tunnel' || p.computer_id !== computerId) throw new HttpError(401, 'bad_signature');
  if (typeof p.at !== 'number' || Math.abs(now - p.at) > PROOF_WINDOW) throw new HttpError(401, 'stale_proof');
  const row = d.db.prepare('SELECT origin, hostname, dns_id, released_at FROM computers WHERE id = ?').get(computerId) as
    | { origin: string; hostname: string; dns_id: string; released_at: number | null }
    | undefined;
  if (!row) throw new HttpError(404, 'unknown_computer');
  d.db.prepare('UPDATE computers SET recovers = 1 WHERE id = ? AND recovers = 0').run(computerId);
  if (row.released_at === null) return { unchanged: true };

  let tunnel = '';
  try {
    tunnel = await d.cf.createTunnel(`ct-${computerId}-${now}`);
    // Claim the row in the same statement that fills it: of two requests that race, only one keeps its tunnel.
    const claimed = d.db
      .prepare('UPDATE computers SET tunnel_id = ?, released_at = NULL, idle_since = NULL WHERE id = ? AND released_at IS NOT NULL')
      .run(tunnel, computerId);
    if (claimed.changes !== 1) {
      await d.cf.deleteTunnel(tunnel);
      return { unchanged: true };
    }
    await d.cf.configureIngress(tunnel, row.hostname, row.origin);
    await d.cf.pointDns(row.dns_id, tunnel);
    return { tunnel_token: await d.cf.tunnelToken(tunnel) };
  } catch (e) {
    try {
      if (tunnel) await d.cf.deleteTunnel(tunnel);
    } catch {
      // a tunnel left behind is one more Cloudflare object, not a broken computer; the next request makes a new one
    }
    d.db.prepare("UPDATE computers SET tunnel_id = '', released_at = ? WHERE id = ? AND (tunnel_id = ? OR tunnel_id = '')").run(now, computerId, tunnel);
    console.error('renew failed', computerId, (e as Error).message);
    throw new HttpError(502, 'cloudflare');
  }
}

/** The reaper's release: the tunnel goes, the computer and its DNS record stay (the record points nowhere until renew). */
export async function releaseTunnel(
  d: { db: DatabaseSync; cf: Cloudflare; now: () => number },
  row: { id: string; tunnel_id: string },
  exists = true, // false: Cloudflare already deleted it, so there is nothing to delete
) {
  if (exists) await d.cf.deleteTunnel(row.tunnel_id);
  d.db
    .prepare("UPDATE computers SET tunnel_id = '', released_at = ?, idle_since = NULL WHERE id = ? AND tunnel_id = ?")
    .run(d.now(), row.id, row.tunnel_id);
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

/** The account id whose token may read connectStats: the hosted site mints it with the shared secret; no real account has a colon. */
export const STATS_ACCOUNT = ':stats';

/**
 * Counts for the owner's board on the hosted site (owner, 2026-11-12: "how many people connected"): computers linked,
 * the accounts they belong to, how many have a tunnel now, and links per day for 30 days (newest first). Counts only:
 * no names, hostnames or account ids. Times here are in seconds.
 */
export function connectStats(db: DatabaseSync, now: number) {
  const n = (sql: string, ...args: number[]) => Number((db.prepare(sql).get(...args) as { n: number }).n);
  const day = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);
  const since = now - 30 * 86_400;
  const perDay = new Map<string, number>();
  for (const r of db.prepare('SELECT created_at FROM computers WHERE created_at >= ?').all(since) as { created_at: number }[])
    perDay.set(day(r.created_at), (perDay.get(day(r.created_at)) ?? 0) + 1);
  const linkedDaily = Array.from({ length: 30 }, (_, i) => day(now - i * 86_400)).map((d) => ({ day: d, linked: perDay.get(d) ?? 0 }));
  return {
    computers: n('SELECT COUNT(*) AS n FROM computers'),
    accounts: n('SELECT COUNT(DISTINCT account_id) AS n FROM computers'),
    up: n("SELECT COUNT(*) AS n FROM computers WHERE released_at IS NULL AND tunnel_id != ''"),
    linked30: n('SELECT COUNT(*) AS n FROM computers WHERE created_at >= ?', since),
    linkedDaily,
  };
}
