import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { connect, type ClientHttp2Session } from 'node:http2';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './errors.ts';
import { computerName, verifyJwt } from './connect.ts';
import { parsePublicKey } from './keys.ts';

// Push to the phones of the account a computer belongs to.
// - A phone signed in to the account registers its APNs token here with its DPoP token (scope "mobile"):
//   POST /v1/mobile/devices { deviceId, token, sandbox, bundleId }, DELETE /v1/mobile/devices/:deviceId.
// - A linked computer publishes "something now waits on you" with a JWS signed by its own key (the key stored at link):
//   POST /v1/computers/:id/activity { proof }. Only a title, one line and a path go through: never media or chat text.
// - Each of the owning account's phones gets one alert. A token Apple calls dead is dropped.

export const ACTIVITY_TYP = 'ct-activity+jwt';
export const ACTIVITY_KINDS = ['review', 'go', 'failed', 'asks', 'final'] as const;
const MAX_PROOF_LIFE = 300; // seconds, as for every other proof between a computer and this broker
const SKEW = 60;
const MAX_DEVICES = 20; // per account; the oldest goes first
const DEAD = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered']);

export interface Device { device_id: string; token: string; sandbox: number; bundle_id: string }
export type ApnsResult = { status: number; reason?: string };
export interface Apns { send(d: Device, payload: object): Promise<ApnsResult> }
export interface PushDeps { db: DatabaseSync; now: () => number; self: string; apns?: Apns }

const str = (v: unknown, re: RegExp) => (typeof v === 'string' && re.test(v) ? v : null);
const DEVICE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** POST /v1/mobile/devices: this phone's token, under the account its DPoP token is for. */
export function registerDevice(d: PushDeps, account: string, b: Record<string, unknown>) {
  const deviceId = str(b.deviceId, DEVICE_ID);
  const token = str(b.token, /^[0-9a-fA-F]{64,200}$/)?.toLowerCase();
  const bundleId = str(b.bundleId, /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+){1,10}$/);
  if (!deviceId || !token || !bundleId || bundleId.length > 155 || typeof b.sandbox !== 'boolean') throw new HttpError(400, 'bad_request');
  // a token is one phone's: signed in to another account now (or a reinstall's new id), the old row goes
  d.db.prepare('DELETE FROM mobile_devices WHERE token = ? AND NOT (account_id = ? AND device_id = ?)').run(token, account, deviceId);
  d.db
    .prepare('INSERT OR REPLACE INTO mobile_devices (account_id, device_id, token, sandbox, bundle_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(account, deviceId, token, b.sandbox ? 1 : 0, bundleId, d.now());
  d.db
    .prepare('DELETE FROM mobile_devices WHERE account_id = ? AND device_id NOT IN (SELECT device_id FROM mobile_devices WHERE account_id = ? ORDER BY updated_at DESC LIMIT ?)')
    .run(account, account, MAX_DEVICES);
  return { ok: true, push: !!d.apns };
}

/** DELETE /v1/mobile/devices/:deviceId: only the account's own row. */
export function unregisterDevice(d: PushDeps, account: string, deviceId: string) {
  d.db.prepare('DELETE FROM mobile_devices WHERE account_id = ? AND device_id = ?').run(account, deviceId);
}

/** The one-line form of a value from a computer: whitespace collapsed, cut to `max`. Null for anything else or empty. */
function line(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** POST /v1/computers/:id/activity: checks the computer's proof, then sends one alert to each phone of its account. */
export async function publishActivity(d: PushDeps, computerId: string, b: Record<string, unknown>) {
  const row = d.db.prepare('SELECT account_id, hostname, public_key FROM computers WHERE id = ?').get(computerId) as
    | { account_id: string; hostname: string; public_key: string | null }
    | undefined;
  if (!row) throw new HttpError(404, 'unknown_computer');
  // linked before keys were kept: its next signed tunnel request stores the key (link.ts renewTunnel)
  if (!row.public_key) throw new HttpError(401, 'bad_signature');
  let key: KeyObject;
  try {
    key = parsePublicKey(row.public_key);
  } catch {
    throw new HttpError(401, 'bad_signature');
  }
  const c = verifyJwt(b.proof, key, ACTIVITY_TYP);
  const now = d.now();
  if (!c || c.iss !== computerName(computerId) || c.aud !== d.self) throw new HttpError(401, 'bad_signature');
  const { iat, exp, jti } = c;
  if (!Number.isInteger(iat) || !Number.isInteger(exp) || typeof jti !== 'string' || !jti || jti.length > 128) throw new HttpError(401, 'bad_signature');
  if ((exp as number) <= now || (exp as number) - (iat as number) > MAX_PROOF_LIFE || (iat as number) > now + SKEW) throw new HttpError(401, 'stale_proof');

  const a = (c.activity ?? {}) as Record<string, unknown>;
  const kind = ACTIVITY_KINDS.find((k) => k === a.kind);
  const title = line(a.title, 120);
  const headline = line(a.headline, 200);
  const path = str(a.path, /^\/(?!\/)[^\s\\]{0,511}$/);
  const workspace = a.workspace === undefined ? undefined : str(a.workspace, /^[A-Za-z0-9_-]{1,128}$/);
  if (a.serverId !== computerId || !kind || !title || !headline || !path || workspace === null) throw new HttpError(400, 'bad_request');

  d.db.prepare('DELETE FROM activity_jti WHERE expires_at <= ?').run(now);
  const fresh = d.db.prepare('INSERT OR IGNORE INTO activity_jti (computer_id, jti, expires_at) VALUES (?, ?, ?)').run(computerId, jti, (exp as number) + SKEW);
  if (fresh.changes !== 1) throw new HttpError(409, 'proof_replayed');
  if (!d.apns) throw new HttpError(503, 'push_unavailable');

  // what reaches Apple and the phone: these fields and nothing else
  const payload = {
    aps: { alert: { title, body: headline }, sound: 'default', 'thread-id': `${computerId}:${workspace ?? ''}` },
    kind,
    path,
    serverId: computerId,
    server: `https://${row.hostname}`,
    ...(workspace ? { workspace } : {}),
  };
  const devices = d.db.prepare('SELECT device_id, token, sandbox, bundle_id FROM mobile_devices WHERE account_id = ?').all(row.account_id) as unknown as Device[];
  let sent = 0;
  await Promise.all(
    devices.map(async (dev) => {
      let r: ApnsResult;
      try {
        r = await d.apns!.send(dev, payload);
      } catch (e) {
        console.error('apns send failed', (e as Error).message);
        return;
      }
      if (r.status === 200) sent++;
      else if (r.status === 410 || (r.status === 400 && DEAD.has(r.reason ?? ''))) {
        d.db.prepare('DELETE FROM mobile_devices WHERE account_id = ? AND device_id = ? AND token = ?').run(row.account_id, dev.device_id, dev.token);
      } else console.error('apns refused', r.status, r.reason ?? '');
    }),
  );
  return { sent };
}

// --- Apple ---

export interface ApnsConfig { keyId: string; teamId: string; key: string }

/** The APNs settings from the environment, or null (push off). RELAY_APNS_KEY is the .p8 text (\n may be written out). */
export function apnsConfig(e: NodeJS.ProcessEnv): ApnsConfig | null {
  const key = e.RELAY_APNS_KEY?.replace(/\\n/g, '\n').trim();
  const keyId = e.RELAY_APNS_KEY_ID?.trim();
  const teamId = e.RELAY_APNS_TEAM_ID?.trim();
  return key && keyId && teamId ? { key, keyId, teamId } : null;
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

/** Apple's provider token: ES256 over { iss: team, iat }, kid = the key's id, the signature as raw r|s. */
export function apnsJwt(c: { keyId: string; teamId: string; privateKey: KeyObject }, iat: number): string {
  const head = `${b64({ alg: 'ES256', kid: c.keyId })}.${b64({ iss: c.teamId, iat })}`;
  return `${head}.${sign('sha256', Buffer.from(head), { key: c.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

/** Sends alerts over HTTP/2, one connection per Apple host, kept open. The provider token is renewed every 50 minutes. */
export function createApns(cfg: ApnsConfig, nowMs = () => Date.now()): Apns {
  const privateKey = createPrivateKey(cfg.key);
  if (privateKey.asymmetricKeyType !== 'ec') throw new Error('RELAY_APNS_KEY is not an EC (P-256) key');
  let jwt = { value: '', at: -Infinity };
  const bearer = () => {
    // Apple refuses a token older than an hour, and one renewed more often than every 20 minutes
    if (nowMs() - jwt.at >= 50 * 60_000) jwt = { value: apnsJwt({ ...cfg, privateKey }, Math.floor(nowMs() / 1000)), at: nowMs() };
    return jwt.value;
  };
  const sessions = new Map<string, ClientHttp2Session>();
  const session = (host: string) => {
    let s = sessions.get(host);
    if (!s || s.closed || s.destroyed) {
      const fresh = connect(`https://${host}`);
      const drop = () => sessions.get(host) === fresh && sessions.delete(host);
      fresh.on('error', drop);
      fresh.on('close', drop);
      fresh.on('goaway', drop);
      fresh.unref();
      sessions.set(host, (s = fresh));
    }
    return s;
  };
  return {
    send: (dev, payload) =>
      new Promise((resolve, reject) => {
        const req = session(dev.sandbox ? 'api.sandbox.push.apple.com' : 'api.push.apple.com').request({
          ':method': 'POST',
          ':path': `/3/device/${dev.token}`,
          authorization: `bearer ${bearer()}`,
          'apns-topic': dev.bundle_id,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'content-type': 'application/json',
        });
        let status = 0;
        let text = '';
        req.setEncoding('utf8');
        req.on('response', (h) => (status = Number(h[':status'])));
        req.on('data', (c: string) => (text += c));
        req.on('end', () => {
          let reason: string | undefined;
          try {
            reason = text ? (JSON.parse(text) as { reason?: string }).reason : undefined;
          } catch {
            reason = undefined;
          }
          resolve({ status, reason });
        });
        req.on('error', reject);
        req.setTimeout(10_000, () => {
          req.close();
          reject(new Error('Apple did not answer in 10 s'));
        });
        req.end(JSON.stringify(payload));
      }),
  };
}
