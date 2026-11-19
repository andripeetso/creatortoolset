import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import { signJwt } from '../src/connect.ts';
import { openDb } from '../src/db.ts';
import { jwkThumbprint } from '../src/dpop.ts';
import { loadSigningKey, publicKeyB64 } from '../src/keys.ts';
import { freeLimit } from '../src/limits.ts';
import { ACTIVITY_TYP, apnsJwt, createApns, type ApnsResult, type Device } from '../src/push.ts';
import { handle, type Deps } from '../src/server.ts';
import { mintAccountToken } from '../src/tickets.ts';
import type { Cloudflare } from '../src/cloudflare.ts';

// Push: a phone registers its APNs token with its DPoP token; a linked computer publishes a signed activity; the
// broker sends one alert to each phone of the account that owns that computer, and drops a token Apple calls dead.
const SECRET = Buffer.alloc(32, 9);
const SELF = 'https://connect.test.example';
let clock = 1_800_000_000;
let deps: Deps;
let sent: { dev: Device; payload: any }[];
let answer: (dev: Device) => ApnsResult;

beforeEach(() => {
  clock = 1_800_000_000;
  sent = [];
  answer = () => ({ status: 200 });
  deps = {
    db: openDb(':memory:'),
    cf: {} as Cloudflare,
    now: () => clock,
    limitFor: freeLimit(3),
    tunnelDomain: 'tunnels.test.example',
    publicUrl: 'https://site.test.example',
    selfUrl: SELF,
    accountSecret: SECRET,
    signing: loadSigningKey(generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'), '/unused'),
    apns: {
      send: async (dev, payload) => {
        sent.push({ dev, payload });
        return answer(dev);
      },
    },
  };
});

async function call(method: string, path: string, o: { auth?: string; dpop?: string; body?: unknown; form?: Record<string, string> } = {}) {
  const headers: Record<string, string> = {};
  if (o.auth) headers.authorization = o.auth;
  if (o.dpop) headers.dpop = o.dpop;
  let body: string | undefined;
  if (o.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(o.form).toString();
  } else if (o.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(o.body);
  }
  const res = await handle(deps, new Request(`http://relay.invalid${path}`, { method, headers, body }));
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

function phone() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string; y: string };
  const proof = (method: string, url: string, token?: string) => {
    const b = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const head = `${b({ typ: 'dpop+jwt', alg: 'ES256', jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } })}.${b({
      htm: method,
      htu: url,
      jti: randomUUID(),
      iat: clock,
      ...(token ? { ath: createHash('sha256').update(token).digest('base64url') } : {}),
    })}`;
    return `${head}.${sign('sha256', Buffer.from(head), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  };
  return { jkt: jwkThumbprint(jwk), proof };
}

async function signedIn(account = 'acct-1', scope?: string) {
  const p = phone();
  const r = await call('POST', '/v1/client/dpop-token', {
    dpop: p.proof('POST', `${SELF}/v1/client/dpop-token`),
    form: { grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_token: mintAccountToken(SECRET, account, clock), ...(scope ? { scope } : {}) },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const token = r.json.access_token as string;
  const as = (method: string, path: string, body?: unknown) => call(method, path, { auth: `DPoP ${token}`, dpop: p.proof(method, `${SELF}${path}`, token), body });
  return { as };
}

const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);
const reg = (deviceId: string, token: string, over: Record<string, unknown> = {}) => ({ deviceId, token, sandbox: true, bundleId: 'com.example.toolset', ...over });
const devices = () => deps.db.prepare('SELECT account_id, device_id, token FROM mobile_devices ORDER BY account_id, device_id').all() as any[];

// a computer linked to `account`, its own Ed25519 key kept as at link
function computer(account = 'acct-1') {
  const key = generateKeyPairSync('ed25519').privateKey;
  const pub = publicKeyB64(createPublicKey(key));
  const id = createHash('sha256').update(Buffer.from(pub, 'base64')).digest('hex').slice(0, 32);
  deps.db
    .prepare("INSERT INTO computers (id, account_id, name, origin, hostname, tunnel_id, dns_id, created_at, public_key) VALUES (?, ?, 'Mac', 'http://127.0.0.1:43128', ?, 't', 'd', ?, ?)")
    .run(id, account, `${id}.tunnels.test.example`, clock, pub);
  return { id, key };
}

const activity = (id: string, over: Record<string, unknown> = {}) => ({
  serverId: id, workspace: 'ws_1', kind: 'review', title: 'Morning routine', headline: 'The first draft is ready', path: '/editor/e1', at: new Date(clock * 1000).toISOString(), ...over,
});
const proofOf = (key: KeyObject, id: string, a: Record<string, unknown>, claims: Record<string, unknown> = {}) =>
  signJwt(key, ACTIVITY_TYP, { iss: `ct-computer:${id}`, aud: SELF, jti: randomUUID(), iat: clock, exp: clock + 60, activity: a, ...claims });
const publish = (id: string, proof: string) => call('POST', `/v1/computers/${id}/activity`, { body: { proof } });

test('registration needs the account DPoP token with the mobile scope', async () => {
  assert.equal((await call('POST', '/v1/mobile/devices', { body: reg('d1', TOKEN_A) })).status, 401);
  const statusOnly = await signedIn('acct-1', 'status');
  assert.equal((await statusOnly.as('POST', '/v1/mobile/devices', reg('d1', TOKEN_A))).status, 403);
  const p = await signedIn();
  const r = await p.as('POST', '/v1/mobile/devices', reg('d1', TOKEN_A.toUpperCase()));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, push: true });
  assert.deepEqual(devices(), [{ account_id: 'acct-1', device_id: 'd1', token: TOKEN_A }]);
  for (const bad of [reg('d1', 'nothex'), reg('d 1', TOKEN_A), reg('d1', TOKEN_A, { sandbox: 'yes' }), reg('d1', TOKEN_A, { bundleId: 'nodot' })]) {
    assert.equal((await p.as('POST', '/v1/mobile/devices', bad)).status, 400);
  }
});

test('a token signed in to another account leaves the first; unregister removes only the caller’s own row', async () => {
  const a = await signedIn('acct-1');
  const b = await signedIn('acct-2');
  await a.as('POST', '/v1/mobile/devices', reg('d1', TOKEN_A));
  await b.as('POST', '/v1/mobile/devices', reg('d9', TOKEN_A));
  assert.deepEqual(devices(), [{ account_id: 'acct-2', device_id: 'd9', token: TOKEN_A }]);
  await a.as('POST', '/v1/mobile/devices', reg('d9', TOKEN_B));
  assert.equal((await a.as('DELETE', '/v1/mobile/devices/d9')).status, 204);
  assert.deepEqual(devices(), [{ account_id: 'acct-2', device_id: 'd9', token: TOKEN_A }]);
  assert.equal((await call('DELETE', '/v1/mobile/devices/d9')).status, 401);
});

test('an activity reaches the phones of the account that owns the computer, and no one else', async () => {
  await (await signedIn('acct-1')).as('POST', '/v1/mobile/devices', reg('d1', TOKEN_A));
  await (await signedIn('acct-2')).as('POST', '/v1/mobile/devices', reg('d2', TOKEN_B));
  const c = computer('acct-1');
  const r = await publish(c.id, proofOf(c.key, c.id, activity(c.id)));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json, { sent: 1 });
  assert.deepEqual(sent.map((s) => s.dev.token), [TOKEN_A]);
  assert.equal(sent[0].dev.bundle_id, 'com.example.toolset');
  assert.equal(sent[0].dev.sandbox, 1);
});

test('only a title, one line and a path go through, never anything else the computer sent', async () => {
  await (await signedIn()).as('POST', '/v1/mobile/devices', reg('d1', TOKEN_A));
  const c = computer();
  const a = activity(c.id, { title: `  Morning\n routine ${'x'.repeat(300)}`, text: 'the whole chat message', media: 'https://cdn/clip.mp4', thumbnail: 'data:image/jpeg;base64,AAAA' });
  assert.equal((await publish(c.id, proofOf(c.key, c.id, a))).status, 200);
  const p = sent[0].payload;
  assert.deepEqual(Object.keys(p).sort(), ['aps', 'kind', 'path', 'server', 'serverId', 'workspace']);
  assert.deepEqual(Object.keys(p.aps.alert).sort(), ['body', 'title']);
  assert.equal(p.aps.alert.title.length, 120);
  assert.ok(p.aps.alert.title.startsWith('Morning routine x'));
  assert.equal(p.aps.alert.body, 'The first draft is ready');
  assert.equal(p.path, '/editor/e1');
  assert.equal(p.server, `https://${c.id}.tunnels.test.example`);
  const text = JSON.stringify(p);
  for (const leak of ['whole chat', 'cdn/clip', 'base64']) assert.ok(!text.includes(leak), leak);
});

test('the computer’s signature, audience, lifetime and single use are checked', async () => {
  await (await signedIn()).as('POST', '/v1/mobile/devices', reg('d1', TOKEN_A));
  const c = computer();
  const other = generateKeyPairSync('ed25519').privateKey;
  const a = activity(c.id);
  assert.equal((await publish(c.id, proofOf(other, c.id, a))).status, 401, 'another key');
  assert.equal((await publish(c.id, proofOf(c.key, c.id, a, { aud: 'https://elsewhere.example' }))).status, 401, 'aud');
  assert.equal((await publish(c.id, proofOf(c.key, c.id, a, { iss: 'ct-computer:0000' }))).status, 401, 'iss');
  assert.equal((await publish(c.id, proofOf(c.key, c.id, a, { exp: clock - 1 }))).status, 401, 'expired');
  assert.equal((await publish(c.id, proofOf(c.key, c.id, a, { exp: clock + 1000 }))).status, 401, 'too long');
  assert.equal((await publish(c.id, signJwt(c.key, 'ct-connect-health+jwt', { iss: `ct-computer:${c.id}`, aud: SELF, jti: 'j', iat: clock, exp: clock + 60, activity: a }))).status, 401, 'typ');
  assert.equal((await publish(c.id, proofOf(c.key, c.id, activity('f'.repeat(32))))).status, 400, 'another server id');
  assert.equal((await publish(c.id, proofOf(c.key, c.id, activity(c.id, { path: 'https://evil.example/' })))).status, 400, 'path');
  assert.equal((await publish(c.id, proofOf(c.key, c.id, activity(c.id, { kind: 'chat' })))).status, 400, 'kind');
  assert.equal((await publish('e'.repeat(32), proofOf(c.key, 'e'.repeat(32), a))).status, 404, 'unknown');
  const once = proofOf(c.key, c.id, a);
  assert.equal((await publish(c.id, once)).status, 200);
  assert.equal((await publish(c.id, once)).status, 409, 'replayed');
  assert.equal(sent.length, 1);
});

test('a token Apple calls dead is dropped; one that failed for another reason stays', async () => {
  const p = await signedIn();
  await p.as('POST', '/v1/mobile/devices', reg('gone', 'c'.repeat(64)));
  await p.as('POST', '/v1/mobile/devices', reg('bad', 'd'.repeat(64)));
  await p.as('POST', '/v1/mobile/devices', reg('busy', 'e'.repeat(64)));
  await p.as('POST', '/v1/mobile/devices', reg('fine', 'f'.repeat(64)));
  answer = (dev) =>
    dev.device_id === 'gone' ? { status: 410, reason: 'Unregistered' } : dev.device_id === 'bad' ? { status: 400, reason: 'BadDeviceToken' } : dev.device_id === 'busy' ? { status: 429, reason: 'TooManyRequests' } : { status: 200 };
  const c = computer();
  assert.deepEqual((await publish(c.id, proofOf(c.key, c.id, activity(c.id)))).json, { sent: 1 });
  assert.deepEqual(devices().map((d) => d.device_id), ['busy', 'fine']);
});

test('with no Apple key, phones still register and a publish says push is off', async () => {
  delete deps.apns;
  const p = await signedIn();
  assert.deepEqual((await p.as('POST', '/v1/mobile/devices', reg('d1', TOKEN_A))).json, { ok: true, push: false });
  const c = computer();
  assert.equal((await publish(c.id, proofOf(c.key, c.id, activity(c.id)))).status, 503);
});

test('the APNs provider token is ES256 by the team key, and only an EC key is taken', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwt = apnsJwt({ keyId: 'KEY123', teamId: 'TEAM456', privateKey }, clock);
  const [h, p, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'ES256', kid: 'KEY123' });
  assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url').toString()), { iss: 'TEAM456', iat: clock });
  assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  assert.ok(createApns({ keyId: 'K', teamId: 'T', key: pem }));
  const ed = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  assert.throws(() => createApns({ keyId: 'K', teamId: 'T', key: ed }));
});
