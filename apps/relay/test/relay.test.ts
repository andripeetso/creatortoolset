import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import type { Server } from 'node:http';
import { createCloudflare } from '../src/cloudflare.ts';
import { openDb } from '../src/db.ts';
import { loadSigningKey, publicKeyB64 } from '../src/keys.ts';
import { freeLimit } from '../src/limits.ts';
import { reap } from '../src/reaper.ts';
import { startServer, type Deps } from '../src/server.ts';
import { checkAccountToken, mintAccountToken, verifyTicket } from '../src/tickets.ts';
import { fakeCloudflare, type FakeCloudflare } from './fake-cloudflare.ts';

// Each test gets a fresh in-memory database, a fake Cloudflare, and a clock the test moves by hand.
const SECRET = randomBytes(32);
const ZONE = 'tunnels.test.example';
let clock = 1_800_000_000;
let fake: FakeCloudflare;
let server: Server;
let base: string;
let deps: Deps;

beforeEach(async () => {
  clock = 1_800_000_000;
  fake = await fakeCloudflare();
  const signingB64 = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  deps = {
    db: openDb(':memory:'),
    cf: createCloudflare({ accountId: 'acc', zoneId: 'zone', token: 'test-token', baseUrl: `${fake.url}/client/v4` }),
    now: () => clock,
    limitFor: freeLimit(3),
    tunnelDomain: ZONE,
    publicUrl: 'https://connect.test.example',
    accountSecret: SECRET,
    signing: loadSigningKey(signingB64, '/unused'),
  };
  server = await startServer(deps, 0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fake.close();
});

async function api(method: string, path: string, opts: { token?: string; body?: unknown; raw?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let payload: string | undefined;
  if (opts.raw !== undefined) payload = opts.raw;
  else if (opts.body !== undefined) payload = JSON.stringify(opts.body);
  if (payload !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: payload });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON (healthz, 204)
  }
  return { status: res.status, json, text };
}

const acct = (id = 'acct-1') => mintAccountToken(SECRET, id, clock);

// The relay's public key, as a computer pins it.
async function relayKey() {
  const r = await api('GET', '/v1/keys');
  return createPublicKey({ key: Buffer.from(r.json.keys[0].publicKey, 'base64'), format: 'der', type: 'spki' });
}

// A computer: its own Ed25519 key, which signs the link payload.
function computer() {
  const kp = generateKeyPairSync('ed25519');
  return {
    key: kp.privateKey as KeyObject,
    spki: publicKeyB64(kp.publicKey),
  };
}

function signedLink(c: ReturnType<typeof computer>, nonce: string, o: { name?: string; origin?: string } = {}) {
  const payload = JSON.stringify({ nonce, name: o.name ?? 'Studio Mac', origin: o.origin ?? 'http://127.0.0.1:43128' });
  return {
    public_key: c.spki,
    payload,
    signature: sign(null, Buffer.from(payload), c.key).toString('base64'),
  };
}

async function challenge(token = acct()) {
  const r = await api('POST', '/v1/computers', { token });
  assert.equal(r.status, 200);
  return r.json.nonce as string;
}

async function linkOne(token = acct(), name = 'Studio Mac') {
  const c = computer();
  const nonce = await challenge(token);
  const r = await api('POST', '/v1/computers/link', { token, body: signedLink(c, nonce, { name }) });
  assert.equal(r.status, 200, r.text);
  return { c, id: r.json.computer_id as string, hostname: r.json.hostname as string, out: r.json };
}

// --- device grant ---

async function startDevice() {
  const r = await api('POST', '/oauth/device');
  assert.equal(r.status, 200);
  return r.json as { device_code: string; user_code: string };
}
const poll = (deviceCode: string) =>
  api('POST', '/oauth/token', { body: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode } });

test('device grant: pending, then approved, then a token for the approving account', async () => {
  const d = await startDevice();
  assert.equal((await poll(d.device_code)).json.error, 'authorization_pending');
  const ap = await api('POST', '/oauth/device/approve', { token: acct('acct-7'), body: { user_code: d.user_code, approve: true } });
  assert.equal(ap.status, 204);
  const t = await poll(d.device_code);
  assert.equal(t.status, 200);
  assert.equal(checkAccountToken(SECRET, t.json.access_token, clock), 'acct-7');
  assert.equal((await poll(d.device_code)).json.error, 'invalid_grant', 'a grant pays out once');
});

test('device grant: a denied code yields access_denied, not a token', async () => {
  const d = await startDevice();
  await api('POST', '/oauth/device/approve', { token: acct(), body: { user_code: d.user_code, approve: false } });
  assert.equal((await poll(d.device_code)).json.error, 'access_denied');
});

test('device grant: an expired code yields expired_token and cannot be approved', async () => {
  const d = await startDevice();
  clock += 601;
  assert.equal((await poll(d.device_code)).json.error, 'expired_token');
  const ap = await api('POST', '/oauth/device/approve', { token: acct(), body: { user_code: d.user_code, approve: true } });
  assert.equal(ap.status, 404);
});

test('device grant: approve needs an account token, and an unknown code is 404', async () => {
  const d = await startDevice();
  assert.equal((await api('POST', '/oauth/device/approve', { body: { user_code: d.user_code, approve: true } })).status, 401);
  assert.equal((await api('POST', '/oauth/device/approve', { token: acct(), body: { user_code: 'ZZZZ-ZZZZ', approve: true } })).status, 404);
});

// --- linking ---

test('link: a signed challenge creates the tunnel and DNS record in Cloudflare, with the origin', async () => {
  const { id, hostname, out } = await linkOne();
  assert.equal(hostname, `${id}.${ZONE}`);
  assert.ok(out.tunnel_token.startsWith('connector-token-'));
  assert.equal(fake.tunnels.size, 1);
  const [tunnelId, tunnel] = [...fake.tunnels.entries()][0];
  assert.equal(tunnel.name, `ct-${id}`);
  assert.deepEqual(tunnel.ingress, [{ hostname, service: 'http://127.0.0.1:43128' }, { service: 'http_status:404' }]);
  const [rec] = [...fake.records.values()];
  assert.equal(rec.name, hostname);
  assert.equal(rec.content, `${tunnelId}.cfargotunnel.com`);
  // the relay's key is what the computer pins
  assert.equal(out.relay_public_key, (await api('GET', '/v1/keys')).json.keys[0].publicKey);
});

test('link: a bad signature is refused, and the challenge is still usable with a good one', async () => {
  const c = computer();
  const nonce = await challenge();
  const bad = signedLink(c, nonce);
  bad.signature = sign(null, Buffer.from('something else'), c.key).toString('base64');
  const r = await api('POST', '/v1/computers/link', { token: acct(), body: bad });
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'bad_signature');
  assert.equal(fake.tunnels.size, 0, 'nothing is created for a bad signature');
  const ok = await api('POST', '/v1/computers/link', { token: acct(), body: signedLink(c, nonce) });
  assert.equal(ok.status, 200);
});

test('link: a key that signed nothing is refused and a non-Ed25519 key is refused', async () => {
  const c = computer();
  const nonce = await challenge();
  const body = signedLink(c, nonce);
  const other = computer();
  const r = await api('POST', '/v1/computers/link', { token: acct(), body: { ...body, public_key: other.spki } });
  assert.equal(r.json.error, 'bad_signature');
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const r2 = await api('POST', '/v1/computers/link', { token: acct(), body: { ...body, public_key: rsa } });
  assert.equal(r2.json.error, 'bad_key');
});

test('link: a replayed challenge is refused', async () => {
  const c = computer();
  const nonce = await challenge();
  const body = signedLink(c, nonce);
  assert.equal((await api('POST', '/v1/computers/link', { token: acct(), body })).status, 200);
  const again = await api('POST', '/v1/computers/link', { token: acct(), body });
  assert.equal(again.status, 401);
  assert.equal(again.json.error, 'bad_challenge');
  assert.equal(fake.tunnels.size, 1, 'the replay creates nothing');
});

test('link: an expired challenge is refused', async () => {
  const c = computer();
  const nonce = await challenge();
  clock += 121;
  const r = await api('POST', '/v1/computers/link', { token: acct(), body: signedLink(c, nonce) });
  assert.equal(r.json.error, 'bad_challenge');
});

test('link: a challenge issued to one account cannot be spent by another', async () => {
  const c = computer();
  const nonce = await challenge(acct('acct-1'));
  const r = await api('POST', '/v1/computers/link', { token: acct('acct-2'), body: signedLink(c, nonce) });
  assert.equal(r.json.error, 'bad_challenge');
});

test('link: a local origin other than 127.0.0.1 with a port is refused', async () => {
  for (const origin of ['http://192.0.2.5:43128','https://127.0.0.1:43128', 'http://127.0.0.1', 'http://127.0.0.1:99999', 'http://example.com:80']) {
    const c = computer();
    const nonce = await challenge();
    const r = await api('POST', '/v1/computers/link', { token: acct(), body: signedLink(c, nonce, { origin }) });
    assert.equal(r.status, 400, origin);
  }
});

test('link: a body over 16 KB is refused', async () => {
  const r = await api('POST', '/v1/computers/link', { token: acct(), raw: 'x'.repeat(20_000) });
  assert.equal(r.status, 413);
});

test('limit: the 4th computer on a free account is refused at the challenge', async () => {
  for (let i = 0; i < 3; i++) await linkOne(acct(), `Mac ${i}`);
  const r = await api('POST', '/v1/computers', { token: acct() });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'limit_reached');
  assert.equal(fake.tunnels.size, 3);
});

test('limit: two links that race past the count are stopped at the second', async () => {
  for (let i = 0; i < 2; i++) await linkOne(acct(), `Mac ${i}`);
  const a = computer();
  const b = computer();
  const na = await challenge();
  const nb = await challenge(); // both allowed: 2 of 3 used
  const [ra, rb] = await Promise.all([
    api('POST', '/v1/computers/link', { token: acct(), body: signedLink(a, na) }),
    api('POST', '/v1/computers/link', { token: acct(), body: signedLink(b, nb) }),
  ]);
  assert.deepEqual([ra.status, rb.status].sort(), [200, 403]);
  assert.equal(fake.tunnels.size, 3);
});

test('limit: a limit given by a plug-in replaces the free number', async () => {
  deps.limitFor = () => 10;
  for (let i = 0; i < 4; i++) await linkOne(acct(), `Mac ${i}`);
  assert.equal(fake.tunnels.size, 4);
});

// --- tickets and the computer's side of them ---

test('ticket: the owner gets one a computer can verify; another account gets not found', async () => {
  const { id, hostname } = await linkOne();
  const relayPub = await relayKey();
  const r = await api('POST', `/v1/computers/${id}/ticket`, { token: acct() });
  assert.equal(r.status, 200);
  assert.equal(r.json.expires_in, 120);
  const seen = new Set<string>();
  const check = (t: string) =>
    verifyTicket(t, {
      relayPublicKey: relayPub,
      hostname,
      computerId: id,
      owner: 'acct-1',
      now: clock,
      consume: (jti) => (seen.has(jti) ? false : (seen.add(jti), true)),
    });
  assert.equal(check(r.json.ticket).sub, 'acct-1');
  assert.throws(() => check(r.json.ticket), /already used/);

  const stranger = await api('POST', `/v1/computers/${id}/ticket`, { token: acct('acct-2') });
  assert.equal(stranger.status, 404);
  assert.equal((await api('POST', `/v1/computers/${id}/ticket`)).status, 401);
});

test('ticket: past 120 s the same ticket is refused by the computer', async () => {
  const { id, hostname } = await linkOne();
  const r = await api('POST', `/v1/computers/${id}/ticket`, { token: acct() });
  const relayPub = await relayKey();
  clock += 120;
  assert.throws(
    () => verifyTicket(r.json.ticket, { relayPublicKey: relayPub, hostname, computerId: id, owner: 'acct-1', now: clock, consume: () => true }),
    /expired/,
  );
});

// --- listing and unlinking ---

test('list shows the account its computers with tunnel status; another account sees none', async () => {
  const { id } = await linkOne();
  const mine = await api('GET', '/v1/computers', { token: acct() });
  assert.equal(mine.json.computers.length, 1);
  assert.equal(mine.json.computers[0].id, id);
  assert.equal(mine.json.computers[0].status, 'inactive');
  assert.equal((await api('GET', '/v1/computers', { token: acct('acct-2') })).json.computers.length, 0);
});

test('unlink removes the tunnel and DNS record from Cloudflare and is idempotent', async () => {
  const { id } = await linkOne();
  fake.setStatus([...fake.tunnels.keys()][0], 'healthy'); // a live connector: Cloudflare refuses a bare delete
  const r = await api('DELETE', `/v1/computers/${id}`, { token: acct() });
  assert.equal(r.status, 204);
  assert.equal(fake.tunnels.size, 0);
  assert.equal(fake.records.size, 0);
  assert.equal((await api('DELETE', `/v1/computers/${id}`, { token: acct() })).status, 204);
  assert.equal((await api('GET', '/v1/computers', { token: acct() })).json.computers.length, 0);
});

test('unlink by another account does nothing', async () => {
  const { id } = await linkOne();
  assert.equal((await api('DELETE', `/v1/computers/${id}`, { token: acct('acct-2') })).status, 204);
  assert.equal(fake.tunnels.size, 1);
  assert.equal((await api('GET', '/v1/computers', { token: acct() })).json.computers.length, 1);
});

test('a relinked computer after unlink gets a fresh allocation', async () => {
  const { c, id } = await linkOne();
  await api('DELETE', `/v1/computers/${id}`, { token: acct() });
  const nonce = await challenge();
  const r = await api('POST', '/v1/computers/link', { token: acct(), body: signedLink(c, nonce) });
  assert.equal(r.status, 200);
  assert.equal(fake.tunnels.size, 1);
});

test('a failed Cloudflare call rolls back, leaving nothing and 502', async () => {
  const realCreate = deps.cf.createDns;
  deps.cf = { ...deps.cf, createDns: async () => { throw new Error('boom'); } };
  const c = computer();
  const nonce = await challenge();
  const r = await api('POST', '/v1/computers/link', { token: acct(), body: signedLink(c, nonce) });
  assert.equal(r.status, 502);
  assert.equal(fake.tunnels.size, 0, 'the tunnel was deleted again');
  deps.cf = { ...deps.cf, createDns: realCreate };
  assert.equal((await api('GET', '/v1/computers', { token: acct() })).json.computers.length, 0);
});

// --- auth and routing ---

test('bad account tokens are 401 on every account route; unknown routes are 404', async () => {
  const forged = mintAccountToken(randomBytes(32), 'acct-1', clock);
  const expired = mintAccountToken(SECRET, 'acct-1', clock - 4000);
  for (const t of [forged, expired, 'nonsense']) {
    assert.equal((await api('GET', '/v1/computers', { token: t })).status, 401);
    assert.equal((await api('POST', '/v1/computers', { token: t })).status, 401);
  }
  assert.equal((await api('GET', '/v1/nothing')).status, 404);
  assert.equal((await api('GET', '/healthz')).text, 'ok');
});

// --- reaper and tunnel renew ---

// What the computer's server sends for its tunnel (api/connect/broker.ts renewTunnel).
function tunnelProof(c: ReturnType<typeof computer>, id: string, o: { at?: number; purpose?: string } = {}) {
  const payload = JSON.stringify({ purpose: o.purpose ?? 'tunnel', computer_id: id, at: o.at ?? clock });
  return { public_key: c.spki, payload, signature: sign(null, Buffer.from(payload), c.key).toString('base64') };
}
const renew = (c: ReturnType<typeof computer>, id: string, o: { at?: number; purpose?: string } = {}) =>
  api('POST', `/v1/computers/${id}/tunnel`, { body: tunnelProof(c, id, o) });

test('renew: a standing tunnel is unchanged, with no Cloudflare call; the ask marks the computer as one that recovers', async () => {
  const { c, id } = await linkOne();
  const before = fake.tunnels.size;
  const r = await renew(c, id);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { unchanged: true });
  assert.equal(fake.tunnels.size, before);
  assert.equal((deps.db.prepare('SELECT recovers FROM computers WHERE id = ?').get(id) as { recovers: number }).recovers, 1);
});

test('renew: another key, a stale or reused proof, a link payload, and an unknown computer are refused', async () => {
  const { c, id } = await linkOne();
  const other = computer();
  assert.equal((await api('POST', `/v1/computers/${id}/tunnel`, { body: tunnelProof(other, id) })).json.error, 'bad_signature');
  assert.equal((await renew(c, id, { at: clock - 301 })).json.error, 'stale_proof');
  assert.equal((await renew(c, id, { purpose: 'link' })).json.error, 'bad_signature');
  const nonce = await challenge();
  assert.equal((await api('POST', `/v1/computers/${id}/tunnel`, { body: signedLink(c, nonce) })).status, 401);
  await api('DELETE', `/v1/computers/${id}`, { token: acct() });
  const gone = await renew(c, id);
  assert.equal(gone.status, 404);
  assert.equal(gone.json.error, 'unknown_computer');
});

test('reaper: a computer down past the window loses only its tunnel, and gets a new one on the same hostname when back', async () => {
  const { c, id, hostname } = await linkOne(acct(), 'Sleepy Mac');
  const live = await linkOne(acct(), 'Live Mac');
  await renew(c, id);
  await renew(live.c, live.id);
  const [oldTunnel, liveTunnel] = [...fake.tunnels.keys()];
  fake.setStatus(liveTunnel, 'healthy');

  let out = await reap(deps, { afterSeconds: 1800, dryRun: false });
  assert.ok(out.every((o) => o.action === 'kept'), 'first sight starts the clock');
  clock += 1800;
  out = await reap(deps, { afterSeconds: 1800, dryRun: true });
  assert.equal(out.find((o) => o.id === id)!.action, 'would-release');
  assert.equal(fake.tunnels.size, 2, 'dry run deletes nothing');
  out = await reap(deps, { afterSeconds: 1800, dryRun: false });
  assert.equal(out.find((o) => o.id === id)!.action, 'released');
  assert.equal(out.find((o) => o.id === live.id)!.action, 'kept');
  assert.equal(fake.tunnels.has(oldTunnel), false);
  assert.equal(fake.records.size, 2, 'the DNS record stays');

  // still on the account, shown as down, still gets tickets; later sweeps leave it alone
  const list = (await api('GET', '/v1/computers', { token: acct() })).json.computers;
  assert.deepEqual(list.map((x: { id: string; status: string }) => [x.id, x.status]), [[id, 'down'], [live.id, 'healthy']]);
  assert.equal((await api('POST', `/v1/computers/${id}/ticket`, { token: acct() })).status, 200);
  assert.equal((await reap(deps, { afterSeconds: 1800, dryRun: false })).find((o) => o.id === id)!.action, 'kept');

  // back: a new tunnel, routed to the same origin, and the same DNS record now points at it
  const r = await renew(c, id);
  assert.equal(r.status, 200, r.text);
  const newTunnel = [...fake.tunnels.keys()].find((t) => t !== liveTunnel)!;
  assert.equal(r.json.tunnel_token, `connector-token-${newTunnel}`);
  assert.deepEqual(fake.tunnels.get(newTunnel)!.ingress, [{ hostname, service: 'http://127.0.0.1:43128' }, { service: 'http_status:404' }]);
  assert.ok([...fake.records.values()].some((rec) => rec.name === hostname && rec.content === `${newTunnel}.cfargotunnel.com`));
  assert.deepEqual((await renew(c, id)).json, { unchanged: true }, 'asked again: nothing new');
  assert.equal((await api('GET', '/v1/computers', { token: acct() })).json.computers[0].status, 'inactive');
});

test('reaper: a tunnel Cloudflare no longer has is released at once; unlink of a released computer still clears DNS', async () => {
  const { c, id } = await linkOne();
  await renew(c, id);
  fake.tunnels.clear();
  const out = await reap(deps, { afterSeconds: 1800, dryRun: false });
  assert.equal(out.find((o) => o.id === id)!.action, 'released');
  assert.equal(fake.records.size, 1);
  assert.equal((await api('DELETE', `/v1/computers/${id}`, { token: acct() })).status, 204);
  assert.equal(fake.records.size, 0);
});

test('reaper: a computer on an older app (never asked for its tunnel) is never touched', async () => {
  const { id } = await linkOne();
  fake.tunnels.clear();
  clock += 100_000;
  const out = await reap(deps, { afterSeconds: 1800, dryRun: false });
  assert.equal(out.find((o) => o.id === id)!.action, 'kept');
  assert.equal((await api('GET', '/v1/computers', { token: acct() })).json.computers.length, 1);
});

test('reaper: a link cut short before its tunnel was saved is removed after the window, not before', async () => {
  // a row reserved by a link that died with no tunnel yet (tunnel_id '')
  deps.db.prepare(`INSERT INTO computers (id, account_id, name, origin, hostname, tunnel_id, dns_id, idle_since, created_at)
                   VALUES ('stranded', 'acct-1', 'Stuck', 'http://127.0.0.1:43128', 'stranded.${ZONE}', '', '', NULL, ?)`).run(clock);
  const young = await reap(deps, { afterSeconds: 1800, dryRun: false });
  assert.equal(young.find((o) => o.id === 'stranded')!.action, 'kept');
  clock += 1800;
  const dry = await reap(deps, { afterSeconds: 1800, dryRun: true });
  assert.equal(dry.find((o) => o.id === 'stranded')!.action, 'would-remove');
  const out = await reap(deps, { afterSeconds: 1800, dryRun: false });
  assert.equal(out.find((o) => o.id === 'stranded')!.action, 'removed');
  assert.equal((await api('GET', '/v1/computers', { token: acct() })).json.computers.length, 0);
});

test('reaper: a tunnel that comes back healthy resets its clock', async () => {
  const { c, id } = await linkOne();
  await renew(c, id);
  const tid = [...fake.tunnels.keys()][0];
  await reap(deps, { afterSeconds: 1800, dryRun: false });
  clock += 1000;
  fake.setStatus(tid, 'healthy');
  await reap(deps, { afterSeconds: 1800, dryRun: false });
  fake.setStatus(tid, 'inactive');
  clock += 1000; // 2000 s since first sight, but the healthy sweep reset the clock, so this sweep starts it again
  const out = await reap(deps, { afterSeconds: 1800, dryRun: false });
  assert.equal(out.find((o) => o.id === id)!.action, 'kept');
});

test('reaper: a degraded tunnel (still serving, a connection lost) is alive, however long', async () => {
  const { c, id } = await linkOne();
  await renew(c, id);
  fake.setStatus([...fake.tunnels.keys()][0], 'degraded');
  await reap(deps, { afterSeconds: 1800, dryRun: false });
  clock += 100_000;
  const out = await reap(deps, { afterSeconds: 1800, dryRun: false });
  assert.equal(out.find((o) => o.id === id)!.action, 'kept');
});

test('db: a file from before the release columns gets them, and its computers start as ones that do not recover', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const file = `${mkdtempSync(`${process.env.CT_SCRATCH_DIR ?? tmpdir()}/relay-old-`)}/relay.sqlite`;
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE computers (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, name TEXT NOT NULL, origin TEXT NOT NULL,
            hostname TEXT NOT NULL UNIQUE, tunnel_id TEXT NOT NULL, dns_id TEXT NOT NULL, idle_since INTEGER, created_at INTEGER NOT NULL);
            INSERT INTO computers VALUES ('x', 'a', 'Old', 'http://127.0.0.1:1', 'x.h', 't', 'd', NULL, 1);`);
  old.close();
  const db = openDb(file);
  assert.deepEqual({ ...(db.prepare('SELECT released_at, recovers FROM computers').get() as object) }, { released_at: null, recovers: 0 });
  db.close();
  openDb(file).close(); // a second open adds nothing twice
});

test('cloudflare: a deleted tunnel (Cloudflare still answers it, with deleted_at) counts as gone', async () => {
  const answer = (result: unknown) => async () => Response.json({ success: true, errors: [], result });
  const cf = (result: unknown) =>
    createCloudflare({ accountId: 'a', zoneId: 'z', token: 't', fetch: answer(result) as unknown as typeof fetch });
  assert.equal(await cf({ id: 'x', status: 'down', deleted_at: '2026-11-12T15:25:17Z' }).tunnelStatus('x'), null);
  assert.equal(await cf({ id: 'x', status: 'down', deleted_at: null }).tunnelStatus('x'), 'down');
});
