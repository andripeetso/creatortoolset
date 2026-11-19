import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createCloudflare } from '../src/cloudflare.ts';
import { signJwt, TYP, verifyJwt } from '../src/connect.ts';
import { openDb } from '../src/db.ts';
import { jwkThumbprint, MAX_JTIS_PER_KEY } from '../src/dpop.ts';
import { loadSigningKey, publicKeyB64 } from '../src/keys.ts';
import { freeLimit } from '../src/limits.ts';
import { handle, type Deps } from '../src/server.ts';
import { mintAccountToken } from '../src/tickets.ts';
import { fakeCloudflare, type FakeCloudflare } from './fake-cloudflare.ts';

// A phone signed in to the account: its DPoP token, then status and connect through a computer's tunnel. The computer is
// a real HTTP server on loopback that answers like a linked computer does, so every check runs on real requests.
const SECRET = Buffer.alloc(32, 7);
const SELF = 'https://connect.test.example';
const ZONE = 'tunnels.test.example';
let clock = 1_800_000_000;
let fake: FakeCloudflare;
let deps: Deps;
let pc: { server: Server; url: string; hits: string[]; answer: (path: string, claims: Record<string, unknown>) => { status: number; body: unknown; headers?: Record<string, string> } };
let redirectTarget: { server: Server; url: string; hits: number };

const listen = (s: Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as { port: number }).port}`)));

beforeEach(async () => {
  clock = 1_800_000_000;
  fake = await fakeCloudflare();
  const hits: string[] = [];
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const c of req) text += c;
    hits.push(req.url ?? '');
    const relayClaims = verifyJwt(JSON.parse(text || '{}').proof, deps.signing.publicKey, req.url === '/api/connect/health' ? TYP.health : TYP.mint) ?? {};
    const a = pc.answer(req.url ?? '', relayClaims);
    res.writeHead(a.status, { 'content-type': 'application/json', ...a.headers });
    res.end(typeof a.body === 'string' ? a.body : JSON.stringify(a.body));
  });
  pc = { server, url: await listen(server), hits, answer: () => ({ status: 404, body: {} }) };
  const target = createServer((_q, res) => {
    redirectTarget.hits++;
    res.end('{}');
  });
  redirectTarget = { server: target, url: await listen(target), hits: 0 };
  deps = {
    db: openDb(':memory:'),
    cf: createCloudflare({ accountId: 'acc', zoneId: 'zone', token: 'test-token', baseUrl: `${fake.url}/client/v4` }),
    now: () => clock,
    limitFor: freeLimit(3),
    tunnelDomain: ZONE,
    publicUrl: 'https://site.test.example',
    selfUrl: SELF,
    accountSecret: SECRET,
    signing: loadSigningKey(generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'), '/unused'),
    originOf: () => pc.url,
  };
});

afterEach(async () => {
  await new Promise<void>((r) => pc.server.close(() => r()));
  await new Promise<void>((r) => redirectTarget.server.close(() => r()));
  await fake.close();
});

async function call(method: string, path: string, o: { token?: string; auth?: string; dpop?: string; body?: unknown; form?: Record<string, string> } = {}) {
  const headers: Record<string, string> = {};
  if (o.token) headers.authorization = `Bearer ${o.token}`;
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
  // the broker runs behind a proxy: it sees its own internal address, never the one the phone signed
  const res = await handle(deps, new Request(`http://relay.invalid${path}`, { method, headers, body }));
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

// --- a phone: a P-256 key in its keychain, signing a proof per request ---
function phone() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string; y: string };
  const jkt = jwkThumbprint(jwk);
  const proof = (method: string, url: string, o: { token?: string; iat?: number; jti?: string; header?: Record<string, unknown> } = {}) => {
    const b = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const head = `${b({ typ: 'dpop+jwt', alg: 'ES256', jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, ...o.header })}.${b({
      htm: method,
      htu: url,
      jti: o.jti ?? randomUUID(),
      iat: o.iat ?? clock,
      ...(o.token ? { ath: createHash('sha256').update(o.token).digest('base64url') } : {}),
    })}`;
    return `${head}.${sign('sha256', Buffer.from(head), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  };
  return { jkt, proof, jwk, privateKey };
}

const acct = (id = 'acct-1') => mintAccountToken(SECRET, id, clock);
const exchange = (account: string, dpop?: string, scope?: string) =>
  call('POST', '/v1/client/dpop-token', {
    dpop,
    form: { grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_token: account, ...(scope ? { scope } : {}) },
  });

async function tokenFor(p: ReturnType<typeof phone>, account = 'acct-1', scope?: string) {
  const r = await exchange(acct(account), p.proof('POST', `${SELF}/v1/client/dpop-token`), scope);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.access_token as string;
}

// what a computer's /api/connect/link-proof answers (contract.md), for the Mac app to pass on as it is
function linkProofBody(key: KeyObject, challenge: string, over: Record<string, unknown> = {}, publicKey = publicKeyB64(createPublicKey(key))) {
  const id = createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex').slice(0, 32);
  const origin = 'http://127.0.0.1:43128';
  const claims = { iss: `ct-computer:${id}`, aud: SELF, sub: id, jti: randomUUID(), iat: clock, exp: clock + 300, challenge, publicKey, origin, name: 'Studio Mac', ...over };
  return { proof: signJwt(key, TYP.linkProof, claims), computerId: id, publicKey, origin, name: 'Studio Mac' };
}

const challengeFor = async (account = 'acct-1') => (await call('POST', '/v1/computers/link-challenges', { token: acct(account) })).json.challenge as string;

// a linked computer, through the account-token link the Mac app drives
async function linkComputer(account = 'acct-1') {
  const key = generateKeyPairSync('ed25519').privateKey;
  const r = await call('POST', '/v1/computers/link', { token: acct(account), body: linkProofBody(key, await challengeFor(account)) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { id: r.json.computerId as string, key, out: r.json };
}

// what a computer answers: its own key signs the nonce it was asked with
function healthy(id: string, key: KeyObject, over: Record<string, unknown> = {}) {
  pc.answer = (path, c) => {
    if (path !== '/api/connect/health') return { status: 404, body: {} };
    const checkedAt = new Date(clock * 1000).toISOString();
    const descriptor = { serverId: id, label: 'Studio Mac' };
    const claims = { iss: `ct-computer:${id}`, aud: SELF, sub: id, jti: randomUUID(), iat: clock, exp: clock + 60, requestNonce: c.nonce, status: 'online', checkedAt, descriptor, ...over };
    return { status: 200, body: { serverId: id, status: 'online', checkedAt, descriptor, proof: signJwt(key, TYP.healthAnswer, claims) } };
  };
}

function minting(id: string, key: KeyObject, over: (c: Record<string, unknown>) => { body?: Record<string, unknown>; claims?: Record<string, unknown> } = () => ({})) {
  pc.answer = (path, c) => {
    if (path !== '/api/connect/mint') return { status: 404, body: {} };
    const exp = clock + 120;
    const o = over(c);
    const credential = 'ctc_one-time';
    const claims = { iss: `ct-computer:${id}`, aud: SELF, sub: id, jti: randomUUID(), iat: clock, exp, requestNonce: c.nonce, clientProofKeyThumbprint: c.clientProofKeyThumbprint, credential, ...o.claims };
    return { status: 200, body: { credential, expiresAt: new Date(exp * 1000).toISOString(), proof: signJwt(key, TYP.mintAnswer, claims), ...o.body } };
  };
}

const status = (p: ReturnType<typeof phone>, token: string, id: string, proof?: string) =>
  call('POST', `/v1/computers/${id}/status`, { auth: `DPoP ${token}`, dpop: proof ?? p.proof('POST', `${SELF}/v1/computers/${id}/status`, { token }) });
const connect = (p: ReturnType<typeof phone>, token: string, id: string, jkt = p.jkt, proof?: string) =>
  call('POST', `/v1/computers/${id}/connect`, {
    auth: `DPoP ${token}`,
    dpop: proof ?? p.proof('POST', `${SELF}/v1/computers/${id}/connect`, { token }),
    body: { clientProofKeyThumbprint: jkt },
  });

// --- linking with the account token ---

test('link: a challenge and the computer-signed proof link it, store its key, and hand back what the computer keeps', async () => {
  const { id, out } = await linkComputer();
  assert.equal(out.owner, 'acct-1');
  assert.equal(out.hostname, `${id}.${ZONE}`);
  assert.equal(out.endpoint, `https://${id}.${ZONE}`);
  assert.ok(out.tunnelToken.startsWith('connector-token-'));
  assert.equal(out.brokerKey, publicKeyB64(deps.signing.publicKey));
  const row = deps.db.prepare('SELECT public_key FROM computers WHERE id = ?').get(id) as { public_key: string };
  assert.ok(row.public_key);
  // challenges need an account token, and the free limit still holds
  assert.equal((await call('POST', '/v1/computers/link-challenges')).status, 401);
  await linkComputer();
  await linkComputer();
  assert.equal((await call('POST', '/v1/computers/link-challenges', { token: acct() })).json.error, 'limit_reached');
});

test('link: a proof for another broker, past its time, by another key, or for a spent challenge is refused', async () => {
  const key = generateKeyPairSync('ed25519').privateKey;
  const link = (body: Record<string, unknown>) => call('POST', '/v1/computers/link', { token: acct(), body });
  let ch = await challengeFor();
  assert.equal((await link(linkProofBody(key, ch, { aud: 'https://other-broker.example' }))).json.error, 'bad_signature');
  assert.equal((await link(linkProofBody(key, ch, { exp: clock }))).json.error, 'stale_proof');
  assert.equal((await link(linkProofBody(key, ch, { exp: clock + 400 }))).json.error, 'stale_proof');
  assert.equal((await link(linkProofBody(key, ch, { iss: 'ct-computer:' + 'f'.repeat(32) }))).json.error, 'bad_signature');
  // signed by one key, presented as another's
  const other = publicKeyB64(generateKeyPairSync('ed25519').publicKey);
  assert.equal((await link(linkProofBody(key, ch, {}, other))).json.error, 'bad_signature');
  // a challenge another account was given
  assert.equal((await link(linkProofBody(key, await challengeFor('acct-2')))).json.error, 'bad_challenge');
  assert.equal((await link(linkProofBody(key, ch))).status, 200, 'the challenge was still good after the refusals');
  ch = await challengeFor();
  const again = linkProofBody(generateKeyPairSync('ed25519').privateKey, ch);
  assert.equal((await link(again)).status, 200);
  assert.equal((await link(again)).json.error, 'bad_challenge');
});

test('link: a computer linked before keys were kept gets its key from its next signed tunnel ask', async () => {
  const { id, key } = await linkComputer();
  deps.db.prepare('UPDATE computers SET public_key = NULL WHERE id = ?').run(id);
  const p = phone();
  const token = await tokenFor(p);
  assert.equal((await status(p, token, id)).json.endpointFailure, 'key_unknown');
  const kp = { pub: publicKeyB64(createPublicKey(key)) };
  const payload = JSON.stringify({ purpose: 'tunnel', computer_id: id, at: clock });
  const r = await call('POST', `/v1/computers/${id}/tunnel`, { body: { public_key: kp.pub, payload, signature: sign(null, Buffer.from(payload), key).toString('base64') } });
  assert.equal(r.status, 200);
  healthy(id, key);
  assert.equal((await status(p, token, id)).json.status, 'online');
});

// --- the phone's DPoP token ---

test('dpop token: a key holding its cap of live proof ids is refused with 503 busy; other keys are not; room comes back as they expire', async () => {
  const add = deps.db.prepare('INSERT INTO dpop_jti (jkt, jti, expires_at) VALUES (?, ?, ?)');
  const p = phone();
  const other = phone();
  deps.db.exec('BEGIN');
  for (let i = 0; i < MAX_JTIS_PER_KEY; i++) add.run(p.jkt, `j${i}`, clock + 600);
  for (let i = 0; i < MAX_JTIS_PER_KEY; i++) add.run('flood', `j${i}`, clock + 600);
  deps.db.exec('COMMIT');
  const r = await exchange(acct(), p.proof('POST', `${SELF}/v1/client/dpop-token`));
  assert.equal(r.status, 503);
  assert.equal(r.json.error, 'busy');
  // one key's flood is that key's alone
  assert.equal((await exchange(acct(), other.proof('POST', `${SELF}/v1/client/dpop-token`))).status, 200);
  clock += 601; // the flood's proofs could no longer pass: they go, and a new proof is taken
  assert.equal((await exchange(acct(), p.proof('POST', `${SELF}/v1/client/dpop-token`))).status, 200);
});

test('dpop token: an account token and a proof give a 30-minute token bound to the phone key', async () => {
  const p = phone();
  const r = await exchange(acct(), p.proof('POST', `${SELF}/v1/client/dpop-token`));
  assert.equal(r.status, 200);
  assert.equal(r.json.token_type, 'DPoP');
  assert.equal(r.json.expires_in, 1800);
  assert.equal(r.json.scope, 'connect status mobile');
  const c = verifyJwt(r.json.access_token, deps.signing.publicKey, TYP.token)!;
  assert.deepEqual(c.cnf, { jkt: p.jkt });
  assert.equal(c.sub, 'acct-1');
  assert.equal((c.exp as number) - (c.iat as number), 1800);
  // a narrower scope is kept narrow; an unknown one is refused
  assert.equal((await exchange(acct(), p.proof('POST', `${SELF}/v1/client/dpop-token`), 'status')).json.scope, 'status');
  assert.equal((await exchange(acct(), p.proof('POST', `${SELF}/v1/client/dpop-token`), 'status admin')).json.error, 'invalid_scope');
});

test('dpop token: an account token bound to an app key opens a token for that key only', async () => {
  const p = phone();
  const thief = phone();
  const bound = () => mintAccountToken(SECRET, 'acct-1', clock, p.jkt);
  const r = await exchange(bound(), thief.proof('POST', `${SELF}/v1/client/dpop-token`));
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'invalid_dpop');
  const ok = await exchange(bound(), p.proof('POST', `${SELF}/v1/client/dpop-token`));
  assert.equal(ok.status, 200);
  assert.deepEqual(verifyJwt(ok.json.access_token, deps.signing.publicKey, TYP.token)!.cnf, { jkt: p.jkt });
});

test('dpop token: no proof, a bad account token, or a wrong grant is refused', async () => {
  const p = phone();
  assert.equal((await exchange(acct())).json.error, 'invalid_dpop');
  assert.equal((await exchange('nope.nope', p.proof('POST', `${SELF}/v1/client/dpop-token`))).json.error, 'invalid_grant');
  const other = mintAccountToken(Buffer.alloc(32, 9), 'acct-1', clock);
  assert.equal((await exchange(other, p.proof('POST', `${SELF}/v1/client/dpop-token`))).json.error, 'invalid_grant');
  const r = await call('POST', '/v1/client/dpop-token', { dpop: p.proof('POST', `${SELF}/v1/client/dpop-token`), form: { grant_type: 'password', subject_token: acct() } });
  assert.equal(r.json.error, 'unsupported_grant_type');
});

test('dpop proof: wrong method, wrong URL, stale or future iat, a replayed jti, a private key in the header, a bad signature', async () => {
  const p = phone();
  const url = `${SELF}/v1/client/dpop-token`;
  const refused = async (proof: string) => assert.equal((await exchange(acct(), proof)).json?.error, 'invalid_dpop');
  await refused(p.proof('GET', url));
  await refused(p.proof('POST', 'http://relay.invalid/v1/client/dpop-token')); // the address the broker sees is not the one signed
  await refused(p.proof('POST', `${SELF}/v1/computers`));
  await refused(p.proof('POST', url, { iat: clock - 301 }));
  await refused(p.proof('POST', url, { iat: clock + 301 }));
  await refused(p.proof('POST', url, { header: { alg: 'RS256' } }));
  await refused(p.proof('POST', url, { header: { typ: 'jwt' } }));
  await refused(p.proof('POST', url, { header: { jwk: { ...p.jwk, d: 'secret' } } }));
  const good = p.proof('POST', url);
  await refused(good.slice(0, -4) + (good.endsWith('AAAA') ? 'BBBB' : 'AAAA'));
  // the proof names the URL without its query
  await refused(p.proof('POST', `${url}?x=1`));
  const once = p.proof('POST', url, { jti: 'same-jti' });
  assert.equal((await exchange(acct(), once)).status, 200);
  await refused(once);
  // a proof made with another key for this phone's thumbprint is refused (the key in the header is what signs)
  const q = phone();
  const forged = q.proof('POST', url, { header: { jwk: p.jwk } });
  await refused(forged);
});

test('dpop access: a token without its proof, with a proof of another key or for another token, past expiry, or without the scope', async () => {
  const p = phone();
  const { id, key } = await linkComputer();
  healthy(id, key);
  const token = await tokenFor(p);
  const url = `${SELF}/v1/computers/${id}/status`;
  assert.equal((await call('POST', `/v1/computers/${id}/status`, { auth: `DPoP ${token}` })).status, 401);
  assert.equal((await call('POST', `/v1/computers/${id}/status`, { auth: `Bearer ${token}`, dpop: p.proof('POST', url, { token }) })).status, 401);
  assert.equal((await status(p, token, id, phone().proof('POST', url, { token }))).status, 401);
  const other = await tokenFor(p);
  assert.equal((await status(p, token, id, p.proof('POST', url, { token: other }))).status, 401);
  assert.equal((await status(p, token, id, p.proof('POST', url))).status, 401); // no ath
  // a token edited by hand no longer verifies
  const [h, , s] = token.split('.');
  const edited = Buffer.from(JSON.stringify({ iss: SELF, aud: SELF, sub: 'acct-2', jti: 'x', iat: clock, exp: clock + 1800, scope: 'status', cnf: { jkt: p.jkt } })).toString('base64url');
  assert.equal((await status(p, `${h}.${edited}.${s}`, id)).status, 401);
  const statusOnly = await tokenFor(p, 'acct-1', 'status');
  assert.equal((await connect(p, statusOnly, id)).status, 403);
  clock += 1801;
  assert.equal((await status(p, token, id)).status, 401);
});

// --- status ---

test('status: online only when the computer signed the answer to this nonce', async () => {
  const p = phone();
  const { id, key } = await linkComputer();
  healthy(id, key);
  const token = await tokenFor(p);
  const r = await status(p, token, id);
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'online');
  assert.equal(r.json.endpoint, `https://${id}.${ZONE}`);
  assert.equal(r.json.descriptor.serverId, id);
  assert.ok(r.json.traceId);
  assert.deepEqual(pc.hits, ['/api/connect/health']);
});

test('status: what the computer is sent is signed by the broker, for this computer and account, short-lived, with a nonce', async () => {
  const p = phone();
  const { id, key } = await linkComputer();
  let seen: Record<string, unknown> = {};
  pc.answer = (path, c) => {
    seen = c;
    return { status: 200, body: { proof: signJwt(key, TYP.healthAnswer, { iss: `ct-computer:${id}`, aud: SELF, sub: id, requestNonce: c.nonce, iat: clock, exp: clock + 60 }) } };
  };
  await status(p, await tokenFor(p), id);
  assert.equal(seen.aud, `ct-computer:${id}`);
  assert.equal(seen.sub, 'acct-1');
  assert.equal(seen.iss, SELF);
  assert.deepEqual(seen.scope, ['status']);
  assert.ok(typeof seen.nonce === 'string' && typeof seen.jti === 'string');
  assert.ok((seen.exp as number) - (seen.iat as number) <= 300);
});

test('status: an answer for another nonce, from another key, another computer id, or an old one is refused', async () => {
  const p = phone();
  const { id, key } = await linkComputer();
  const token = await tokenFor(p);
  const bad = async (answer: typeof pc.answer) => {
    pc.answer = answer;
    const r = await status(p, token, id);
    assert.equal(r.status, 502);
    assert.equal(r.json.error, 'invalid_response');
  };
  const ok = (c: Record<string, unknown>) => ({ iss: `ct-computer:${id}`, aud: SELF, sub: id, requestNonce: c.nonce, iat: clock, exp: clock + 60 });
  await bad((_p, c) => ({ status: 200, body: { proof: signJwt(key, TYP.healthAnswer, { ...ok(c), requestNonce: 'other' }) } }));
  await bad((_p, c) => ({ status: 200, body: { proof: signJwt(key, TYP.healthAnswer, { ...ok(c), aud: 'https://other-broker.example' }) } }));
  await bad((_p, c) => ({ status: 200, body: { proof: signJwt(key, TYP.healthAnswer, { ...ok(c), sub: 'f'.repeat(32) }) } }));
  await bad((_p, c) => ({ status: 200, body: { proof: signJwt(key, TYP.healthAnswer, { ...ok(c), exp: clock }) } }));
  await bad((_p, c) => ({ status: 200, body: { proof: signJwt(generateKeyPairSync('ed25519').privateKey, TYP.healthAnswer, ok(c)) } }));
  await bad((_p, c) => ({ status: 200, body: { proof: signJwt(key, TYP.healthAnswer, { ...ok(c), iss: `ct-computer:${'f'.repeat(32)}` }) } }));
  await bad((_p, c) => ({ status: 200, body: { proof: signJwt(key, TYP.healthAnswer, { ...ok(c), iat: clock - 120 }) } }));
  await bad((_p, c) => ({ status: 200, body: { proof: signJwt(key, TYP.mintAnswer, ok(c)) } })); // a mint answer is not a health answer
  await bad((_p, c) => ({ status: 200, body: { proof: signJwt(key, TYP.healthAnswer, { ...ok(c), descriptor: { serverId: 'f'.repeat(32) } }) } }));
  await bad(() => ({ status: 200, body: { status: 'ok' } }));
});

test('status: a computer that does not answer is offline, with the reason; a redirect is never followed', async () => {
  const p = phone();
  const { id } = await linkComputer();
  const token = await tokenFor(p);
  pc.answer = () => ({ status: 302, body: '', headers: { location: `${redirectTarget.url}/api/connect/health` } });
  let r = await status(p, token, id);
  assert.equal(r.json.status, 'offline');
  assert.equal(r.json.endpointFailure, 'redirect');
  assert.equal(redirectTarget.hits, 0);
  pc.answer = () => ({ status: 530, body: 'error code: 1033' });
  assert.equal((await status(p, token, id)).json.endpointFailure, 'tunnel_down');
  pc.answer = () => ({ status: 502, body: 'bad gateway' });
  assert.equal((await status(p, token, id)).json.endpointFailure, 'origin_unreachable');
  pc.answer = () => ({ status: 200, body: 'not json' });
  assert.equal((await status(p, token, id)).json.endpointFailure, 'invalid_response');
  const closed = createServer();
  const gone = await listen(closed);
  await new Promise<void>((r) => closed.close(() => r()));
  deps.originOf = () => gone;
  assert.equal((await status(p, token, id)).json.endpointFailure, 'refused');
  // a computer that hangs: the broker gives up (the fetch's own timeout fires as a TimeoutError)
  deps.fetch = (async () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  }) as typeof fetch;
  r = await status(p, token, id);
  assert.equal(r.json.status, 'offline');
  assert.equal(r.json.endpointFailure, 'timeout');
});

test('status: the request carries a 10 s timeout and refuses redirects', async () => {
  const p = phone();
  const { id, key } = await linkComputer();
  let init: RequestInit | undefined;
  deps.fetch = (async (u: string, i: RequestInit) => {
    init = i;
    return fetch(u, i);
  }) as typeof fetch;
  healthy(id, key);
  await status(p, await tokenFor(p), id);
  assert.equal(init?.redirect, 'manual');
  assert.ok(init?.signal instanceof AbortSignal);
});

test('status: another account, an unknown computer, and a released tunnel', async () => {
  const p = phone();
  const { id } = await linkComputer();
  const stranger = await tokenFor(p, 'acct-2');
  const r = await status(p, stranger, id);
  assert.equal(r.status, 404);
  assert.equal(r.json.error, 'computer_link_not_found');
  assert.equal((await status(p, await tokenFor(p), 'f'.repeat(32))).status, 404);
  assert.deepEqual(pc.hits, []);
  deps.db.prepare("UPDATE computers SET released_at = ?, tunnel_id = '' WHERE id = ?").run(clock, id);
  const off = await status(p, await tokenFor(p), id);
  assert.equal(off.json.status, 'offline');
  assert.equal(off.json.offlineReason, 'tunnel_released');
});

test('list: a phone lists with its DPoP token too', async () => {
  const p = phone();
  const { id } = await linkComputer();
  const token = await tokenFor(p);
  const r = await call('GET', '/v1/computers', { auth: `DPoP ${token}`, dpop: p.proof('GET', `${SELF}/v1/computers`, { token }) });
  assert.equal(r.status, 200);
  assert.equal(r.json.computers[0].id, id);
  assert.equal((await call('GET', '/v1/computers', { auth: `DPoP ${token}` })).status, 401);
});

// --- connect ---

test('connect: the computer mints a one-time credential bound to the phone key, checked against its own key', async () => {
  const p = phone();
  const { id, key } = await linkComputer();
  let asked: Record<string, unknown> = {};
  minting(id, key, (c) => ((asked = c), {}));
  const r = await connect(p, await tokenFor(p), id);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.credential, 'ctc_one-time');
  assert.equal(r.json.endpoint, `https://${id}.${ZONE}`);
  // what the computer checks: the broker's key, this computer, this account, the phone's key, one scope, ≤ 300 s
  assert.equal(asked.aud, `ct-computer:${id}`);
  assert.equal(asked.sub, 'acct-1');
  assert.deepEqual(asked.cnf, { jkt: p.jkt });
  assert.equal(asked.clientProofKeyThumbprint, p.jkt);
  assert.deepEqual(asked.scope, ['connect']);
  assert.ok((asked.exp as number) - (asked.iat as number) <= 300);
  assert.notEqual(asked.nonce, undefined);
});

test('connect: a thumbprint that is not the caller key, another account, or a reused proof is refused', async () => {
  const p = phone();
  const { id, key } = await linkComputer();
  minting(id, key);
  const token = await tokenFor(p);
  assert.equal((await connect(p, token, id, phone().jkt)).status, 401);
  assert.equal((await connect(p, await tokenFor(p, 'acct-2'), id)).status, 404);
  const proof = p.proof('POST', `${SELF}/v1/computers/${id}/connect`, { token });
  assert.equal((await connect(p, token, id, p.jkt, proof)).status, 200);
  assert.equal((await connect(p, token, id, p.jkt, proof)).status, 401);
});

test('connect: a mint answer for another key, nonce, credential or expiry, or living too long, is refused', async () => {
  const p = phone();
  const { id, key } = await linkComputer();
  const token = await tokenFor(p);
  const bad = async (over: Parameters<typeof minting>[2]) => {
    minting(id, key, over);
    const r = await connect(p, token, id);
    assert.equal(r.status, 502, JSON.stringify(r.json));
    assert.equal(r.json.error, 'invalid_response');
  };
  await bad(() => ({ claims: { clientProofKeyThumbprint: phone().jkt } }));
  await bad(() => ({ claims: { requestNonce: 'other' } }));
  await bad(() => ({ claims: { aud: 'https://other-broker.example' } }));
  await bad(() => ({ claims: { credential: 'ctc_other' } }));
  await bad(() => ({ body: { credential: 'ctc_other' } }));
  await bad(() => ({ claims: { exp: clock + 121 } }));
  await bad(() => ({ claims: { exp: clock + 400 }, body: { expiresAt: new Date((clock + 400) * 1000).toISOString() } }));
  await bad(() => ({ claims: { iss: `ct-computer:${'f'.repeat(32)}` } }));
  minting(id, generateKeyPairSync('ed25519').privateKey);
  assert.equal((await connect(p, token, id)).json.error, 'invalid_response');
});

test('connect: a computer that is down or slow is a clear error, and a redirect is not followed', async () => {
  const p = phone();
  const { id } = await linkComputer();
  const token = await tokenFor(p);
  pc.answer = () => ({ status: 307, body: '', headers: { location: `${redirectTarget.url}/api/connect/mint` } });
  assert.equal((await connect(p, token, id)).json.error, 'computer_unreachable');
  assert.equal(redirectTarget.hits, 0);
  deps.fetch = (async () => {
    throw new DOMException('timeout', 'TimeoutError');
  }) as typeof fetch;
  const r = await connect(p, token, id);
  assert.equal(r.status, 504);
  assert.equal(r.json.error, 'computer_timeout');
});
