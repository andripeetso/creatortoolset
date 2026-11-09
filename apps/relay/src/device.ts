import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

// RFC 8628 device grant. The computer's CLI shows the user_code; the user approves it while signed in (the hosted
// /connect page calls POST /oauth/device/approve). The device_code is only ever stored as a hash.

export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
export const DEVICE_TTL = 600; // seconds to approve
export const POLL_INTERVAL = 5;
const CODE_CHARS = 'BCDFGHJKLMNPQRSTVWXZ23456789'; // no vowels, no look-alikes

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function normalizeUserCode(s: string): string {
  const c = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : '';
}

export function startDeviceGrant(db: DatabaseSync, now: number, verificationUri: string) {
  const deviceCode = randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM devices WHERE expires_at < ?').run(now);
  for (let attempt = 0; ; attempt++) {
    let raw = '';
    for (let i = 0; i < 8; i++) raw += CODE_CHARS[randomInt(CODE_CHARS.length)];
    const userCode = normalizeUserCode(raw);
    try {
      db.prepare(`INSERT INTO devices (device_hash, user_code, status, account_id, expires_at)
                  VALUES (?, ?, 'pending', NULL, ?)`).run(sha256(deviceCode), userCode, now + DEVICE_TTL);
    } catch (e) {
      if (attempt >= 4) throw e; // a user_code collision: draw again
      continue;
    }
    return {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?code=${userCode}`,
      expires_in: DEVICE_TTL,
      interval: POLL_INTERVAL,
    };
  }
}

export type PollResult = { accountId: string } | { error: 'authorization_pending' | 'access_denied' | 'expired_token' | 'invalid_grant' };

export function pollDeviceGrant(db: DatabaseSync, deviceCode: string, now: number): PollResult {
  const h = sha256(deviceCode);
  const r = db.prepare('SELECT status, account_id, expires_at FROM devices WHERE device_hash = ?').get(h) as unknown as
    | { status: string; account_id: string | null; expires_at: number }
    | undefined;
  if (!r) return { error: 'invalid_grant' };
  if (r.expires_at <= now) return { error: 'expired_token' };
  if (r.status === 'pending') return { error: 'authorization_pending' };
  if (r.status === 'denied') return { error: 'access_denied' };
  if (r.status === 'approved' && r.account_id) {
    // One statement spends the approval: of two polls that race, only one gets a token.
    const spent = db.prepare(`UPDATE devices SET status = 'issued' WHERE device_hash = ? AND status = 'approved'`).run(h);
    if (spent.changes === 1) return { accountId: r.account_id };
  }
  return { error: 'invalid_grant' };
}

// Approve or deny a pending code, as the signed-in account. False when the code is unknown, used or expired.
export function decideDevice(db: DatabaseSync, userCode: string, approve: boolean, accountId: string, now: number): boolean {
  const code = normalizeUserCode(userCode);
  if (!code) return false;
  const r = db
    .prepare(`UPDATE devices SET status = ?, account_id = ? WHERE user_code = ? AND status = 'pending' AND expires_at > ?`)
    .run(approve ? 'approved' : 'denied', accountId, code, now);
  return r.changes === 1;
}
