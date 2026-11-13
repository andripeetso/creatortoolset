import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createCloudflare } from '../src/cloudflare.ts';
import { openDb } from '../src/db.ts';
import { UNREACHABLE } from '../src/gateway.ts';
import { keyId, loadSigningKey, publicKeyB64 } from '../src/keys.ts';
import { freeLimit } from '../src/limits.ts';
import { startServer, type Deps } from '../src/server.ts';
import { mintAccountToken } from '../src/tickets.ts';
import { fakeCloudflare, type FakeCloudflare } from './fake-cloudflare.ts';

// AI apps through the broker (src/gateway.ts): a stand-in computer answers where a real one's tunnel would, and the
// test plays the AI app (register, authorize, token, then MCP requests) and the hosted site (info, approve).

const SECRET = randomBytes(32);
const ZONE = 'tunnels.test.example';
const SELF = 'https://connect.test.example';
const REDIRECT = 'https://chatgpt.com/connector/callback';
const s256 = (s: string) => createHash('sha256').update(s).digest('base64url');
const mediaToken = (m: string) => `${Buffer.from(JSON.stringify({ u: 'me', k: 'k', m, i: 'v1', e: 1 })).toString('base64url')}.sig`;
const THUMB = mediaToken('lt');
const PLAY = mediaToken('lp');

let clock = 1_800_000_000;
let fake: FakeCloudflare;
let server: Server;
let base: string;
let deps: Deps;
let pc: Awaited<ReturnType<typeof fakeComputer>>;

/** A person's computer as the broker reaches it: the app's sign-in for AI apps, its MCP route and a card's picture. */
async function fakeComputer() {
  // host: the tunnel hostname this computer is reached at (a real one reads it from the request)
  const state = { key: `ctk_${'a'.repeat(48)}`, down: false, challenge: '', host: `pc.${ZONE}`, seen: [] as { path: string; auth: string | null; body: string }[] };
  const http = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const path = req.url ?? '';
    state.seen.push({ path, auth: req.headers.authorization ?? null, body });
    const send = (status: number, value: unknown, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type });
      res.end(typeof value === 'string' ? value : JSON.stringify(value));
    };
    if (state.down) return send(502, '<html>Bad gateway</html>', 'text/html');
    if (path === '/api/oauth/register') return send(201, { client_id: 'computer-client-1' });
    if (path === '/api/oauth/token') {
      const p = new URLSearchParams(body);
      const ok = p.get('code') === 'good-code' && p.get('client_id') === 'computer-client-1' && s256(p.get('code_verifier') ?? '') === state.challenge;
      return ok ? send(200, { access_token: state.key, token_type: 'Bearer' }) : send(400, { error: 'invalid_grant' });
    }
    if (path === '/api/mcp') {
      if (req.headers.authorization !== `Bearer ${state.key}`) return send(401, { error: 'Unauthorized' });
      const m = JSON.parse(body) as { id?: number; method: string };
      const host = state.host;
      if (m.id === undefined) {
        res.writeHead(202);
        return res.end();
      }
      const ok = (result: unknown) => send(200, { jsonrpc: '2.0', id: m.id, result });
      if (m.method === 'tools/list') return ok({ tools: [{ name: 'media_search' }] });
      if (m.method === 'resources/read') {
        return ok({ contents: [{ uri: 'ui://card', text: '<html>', _meta: { ui: { csp: { resourceDomains: [`https://${host}`], connectDomains: [] } }, 'openai/widgetCSP': { resource_domains: [`https://${host}`] } } }] });
      }
      if (m.method === 'tools/call') {
        return ok({
          content: [{ type: 'text', text: '{"files":1}' }],
          _meta: { card: { kind: 'footage', href: `https://${host}/library`, items: [{ title: 'Bedtime', thumb: `https://${host}/api/card/media/${THUMB}`, play: `https://${host}/api/card/media/${PLAY}` }] } },
        });
      }
      return ok({ echo: m.method });
    }
    if (path.startsWith('/api/card/media/')) return send(200, 'the picture', 'image/jpeg');
    return send(404, {});
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', () => resolve()));
  return { state, url: `http://127.0.0.1:${(http.address() as { port: number }).port}`, close: () => new Promise<void>((resolve) => http.close(() => resolve())) };
}

beforeEach(async () => {
  clock = 1_800_000_000;
  fake = await fakeCloudflare();
  pc = await fakeComputer();
  const signingB64 = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  deps = {
    db: openDb(':memory:'),
    cf: createCloudflare({ accountId: 'acc', zoneId: 'zone', token: 'test-token', baseUrl: `${fake.url}/client/v4` }),
    now: () => clock,
    limitFor: freeLimit(3),
    tunnelDomain: ZONE,
    publicUrl: SELF,
    accountSecret: SECRET,
    signing: loadSigningKey(signingB64, '/unused'),
    gateway: { secret: randomBytes(32), originOf: () => pc.url, openaiChallenge: 'challenge-token\n' },
  };
  server = await startServer(deps, 0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pc.close();
  await fake.close();
});

const acct = (id = 'acct-1') => mintAccountToken(SECRET, id, clock);
const post = (path: string, body: unknown, token?: string) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

/** A computer linked to an account, with its own key (its id is its key's id). */
function addComputer(account = 'acct-1', name = 'Studio Mac') {
  const kp = generateKeyPairSync('ed25519');
  const id = keyId(kp.publicKey);
  const hostname = `${id}.${ZONE}`;
  deps.db
    .prepare("INSERT INTO computers (id, account_id, name, origin, hostname, tunnel_id, dns_id, created_at) VALUES (?, ?, ?, 'http://127.0.0.1:4000', ?, 'tun-1', 'dns-1', ?)")
    .run(id, account, name, hostname, clock);
  const signed = (p: Record<string, unknown>) => {
    const payload = JSON.stringify(p);
    return { public_key: publicKeyB64(kp.publicKey), payload, signature: sign(null, Buffer.from(payload), kp.privateKey).toString('base64') };
  };
  /** What the app's Install button sends: its key for this AI app, ahead of the sign-in. */
  const allow = (app: string, key: string | null = pc.state.key) => post(`/v1/computers/${id}/ai-grant`, signed({ purpose: 'ai-grant', computer_id: id, at: clock, app, key }));
  return { id, hostname, signed, allow };
}

/** The AI app's side up to the hosted site's page: registers, starts the sign-in, and holds what it needs to finish. */
async function startSignIn(redirect = REDIRECT) {
  const reg = (await (await post('/oauth/register', { client_name: 'openai-mcp', redirect_uris: [redirect] })).json()) as { client_id: string; client_name: string };
  const verifier = randomBytes(32).toString('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, code_challenge: s256(verifier), code_challenge_method: 'S256', state: 'st8' });
  const r = await fetch(`${base}/oauth/authorize?${q}`, { redirect: 'manual' });
  const to = new URL(r.headers.get('location') ?? 'http://none.invalid');
  return { reg, verifier, status: r.status, to, req: to.searchParams.get('req') ?? '' };
}
const approve = async (req: string, computer: string, token = acct(), yes = true) => {
  const r = await post('/oauth/authorize/approve', { req, computer_id: computer, approve: yes }, token);
  return { status: r.status, json: (await r.json()) as { redirect?: string; error?: string } };
};
/** The AI app swaps the code it was sent back with for its token. */
async function tokenFrom(redirect: string, s: { reg: { client_id: string }; verifier: string }) {
  const code = new URL(redirect).searchParams.get('code') ?? '';
  const r = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: s.reg.client_id, code_verifier: s.verifier, redirect_uri: REDIRECT }),
  });
  return { status: r.status, json: (await r.json()) as { access_token?: string; error?: string } };
}
const mcp = (token: string, msg: unknown) => fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(msg) });
const rpc = (method: string, params: unknown = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });
/** A computer that allowed ChatGPT from its app, and ChatGPT signed in: the token it works with. */
async function connected(account = 'acct-1') {
  const c = addComputer(account);
  assert.equal((await c.allow('ChatGPT')).status, 200);
  const s = await startSignIn();
  const a = await approve(s.req, c.id, acct(account));
  const t = await tokenFrom(a.json.redirect!, s);
  return { c, s, token: t.json.access_token! };
}

test('without its secret the broker has none of this', async () => {
  delete deps.gateway;
  assert.equal((await fetch(`${base}/.well-known/oauth-authorization-server`)).status, 404);
  assert.equal((await post('/oauth/register', { redirect_uris: [REDIRECT] })).status, 404);
  assert.equal((await mcp('cgw_x', rpc('ping'))).status, 404);
  const c = addComputer();
  assert.equal((await c.allow('ChatGPT')).status, 404);
});

test("a computer's Install opens the app's store page once listed, and the by-address page until then", async () => {
  const until = await fetch(`${base}/add/chatgpt`, { redirect: 'manual' });
  assert.equal(until.status, 200);
  const html = await until.text();
  assert.ok(html.includes('Add Creator Toolset to ChatGPT'));
  assert.ok(html.includes(`value="${SELF}/mcp"`));
  assert.ok(html.includes('Sign in to your Creator Toolset account and press Allow.'));
  const claude = await (await fetch(`${base}/add/Claude`)).text();
  assert.ok(claude.includes('connectorUrl=' + encodeURIComponent(`${SELF}/mcp`)));
  deps.gateway!.listings = { ChatGPT: 'https://chatgpt.com/plugins/creator-toolset' };
  const listed = await fetch(`${base}/add/chatgpt`, { redirect: 'manual' });
  assert.equal(listed.status, 302);
  assert.equal(listed.headers.get('location'), 'https://chatgpt.com/plugins/creator-toolset');
  assert.equal((await fetch(`${base}/add/other`)).status, 404);
});

test('an AI app finds where to sign in, and the domain check answers', async () => {
  const r = await mcp('', rpc('tools/list'));
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('www-authenticate'), `Bearer resource_metadata="${SELF}/.well-known/oauth-protected-resource/mcp"`);
  assert.deepEqual(await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json(), { resource: `${SELF}/mcp`, authorization_servers: [SELF], bearer_methods_supported: ['header'] });
  const meta = await fetch(`${base}/.well-known/oauth-authorization-server`);
  assert.equal(meta.headers.get('access-control-allow-origin'), '*');
  const m = (await meta.json()) as Record<string, unknown>;
  assert.equal(m.authorization_endpoint, `${SELF}/oauth/authorize`);
  assert.equal(m.token_endpoint, `${SELF}/oauth/token`);
  assert.equal(await (await fetch(`${base}/.well-known/openai-apps-challenge`)).text(), 'challenge-token');
  assert.equal((await fetch(`${base}/oauth/token`, { method: 'OPTIONS' })).status, 204);
});

test('a computer that allowed the app ahead: sign in, pick it, and requests pass through to it', async () => {
  const c = addComputer();
  const s = await startSignIn();
  assert.equal(s.reg.client_name, 'ChatGPT'); // named by where it sends people back, whatever it calls itself
  assert.equal(s.status, 302);
  assert.equal(s.to.origin + s.to.pathname, `${SELF}/connect/ai`);

  // the hosted site asks what to show: not allowed yet, then allowed from the app's Install button
  const info = async () => (await (await post('/oauth/authorize/info', { req: s.req }, acct())).json()) as { app: string; host: string; computers: { id: string; name: string; up: boolean; ready: boolean }[] };
  assert.deepEqual(await info(), { app: 'ChatGPT', host: 'chatgpt.com', computers: [{ id: c.id, name: 'Studio Mac', up: true, ready: false }] });
  assert.equal((await c.allow('ChatGPT')).status, 200);
  assert.equal((await info()).computers[0]!.ready, true);
  assert.equal((await post('/oauth/authorize/info', { req: s.req })).status, 401);

  const a = await approve(s.req, c.id);
  const back = new URL(a.json.redirect!);
  assert.equal(back.origin + back.pathname, REDIRECT);
  assert.equal(back.searchParams.get('state'), 'st8');
  const t = await tokenFrom(a.json.redirect!, s);
  assert.match(t.json.access_token!, /^cgw_[a-f0-9]{64}$/);
  // a code works once
  assert.equal((await tokenFrom(a.json.redirect!, s)).status, 400);

  // the request reaches the computer with the computer's own key, word for word
  const sent = rpc('initialize', { protocolVersion: '2025-06-18' });
  assert.deepEqual(await (await mcp(t.json.access_token!, sent)).json(), { jsonrpc: '2.0', id: 1, result: { echo: 'initialize' } });
  const got = pc.state.seen.at(-1)!;
  assert.deepEqual([got.path, got.auth, got.body], ['/api/mcp', `Bearer ${pc.state.key}`, JSON.stringify(sent)]);
  assert.equal((await mcp(t.json.access_token!, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);

  // the key sits sealed: the database file alone holds no key
  const row = deps.db.prepare('SELECT key_sealed, app, account_id FROM ai_grants').get() as { key_sealed: string; app: string; account_id: string };
  assert.equal(row.app, 'ChatGPT');
  assert.equal(row.key_sealed.includes('ctk_'), false);
});

test("a card's pictures come through the broker, its video does not", async () => {
  const { c, token } = await connected();
  pc.state.host = c.hostname;
  const call = async (msg: unknown) => (await (await mcp(token, msg)).json()) as { result: Record<string, any> };
  const answer = await call(rpc('tools/call', { name: 'media_search', arguments: { q: 'sleep' } }));
  const item = answer.result._meta.card.items[0];
  assert.equal(item.thumb, `${SELF}/m/${c.id}/${THUMB}`);
  assert.equal('play' in item, false);
  // a link into the app opens through the broker's own address, for every person the same one
  assert.equal(answer.result._meta.card.href, `${SELF}/open/${c.id}/library`);
  assert.equal(answer.result.content[0].text, '{"files":1}');

  const page = await call(rpc('resources/read', { uri: 'ui://card' }));
  assert.deepEqual(page.result.contents[0]._meta.ui.csp.resourceDomains, [SELF]);
  assert.deepEqual(page.result.contents[0]._meta['openai/widgetCSP'].resource_domains, [SELF]);

  const picture = await fetch(`${base}/m/${c.id}/${THUMB}`);
  assert.equal(picture.status, 200);
  assert.equal(picture.headers.get('content-type'), 'image/jpeg');
  assert.equal(await picture.text(), 'the picture');
  assert.equal(pc.state.seen.at(-1)!.path, `/api/card/media/${THUMB}`);
  // a video link, a computer that isn't linked, a made-up token
  assert.equal((await fetch(`${base}/m/${c.id}/${PLAY}`)).status, 404);
  assert.equal((await fetch(`${base}/m/${'0'.repeat(32)}/${THUMB}`)).status, 404);
  assert.equal((await fetch(`${base}/m/${c.id}/nonsense`)).status, 404);

  // where such a link lands: the app on the computer, or the computer's web address
  const landing = await (await fetch(`${base}/open/${c.id}/review/abc-123?v=2`)).text();
  assert.ok(landing.includes('href="creatortoolset://review/abc-123?v=2"'));
  assert.ok(landing.includes(`href="https://${c.hostname}/review/abc-123?v=2"`));
  assert.equal((await fetch(`${base}/open/${'0'.repeat(32)}/review/abc`)).status, 404);
  // a path that tries to carry markup lands nowhere
  assert.equal((await fetch(`${base}/open/${c.id}/x%22%3E%3Cscript%3E`)).status, 200);
  assert.equal((await (await fetch(`${base}/open/${c.id}/x%22%3E%3Cscript%3E`)).text()).includes('<script>'), false);
  assert.equal((await fetch(`${base}/open/${c.id}/review/abc?next=https://evil.example`)).status, 404);

  // a link the AI app hands back reaches the computer as the computer's own
  await mcp(token, rpc('tools/call', { name: 'get_review', arguments: { link: `${SELF}/open/${c.id}/review/abc-123` } }));
  assert.ok(pc.state.seen.at(-1)!.body.includes(`"link":"https://${c.hostname}/review/abc-123"`));
});

test("a computer that has not allowed the app: on to its own Allow page, and its code becomes the key", async () => {
  const c = addComputer();
  const s = await startSignIn();
  const a = await approve(s.req, c.id);
  const to = new URL(a.json.redirect!);
  // the browser goes to the computer's own address; the broker registered there under the app's name
  assert.equal(to.origin + to.pathname, `https://${c.hostname}/oauth/authorize`);
  assert.equal(to.searchParams.get('client_id'), 'computer-client-1');
  assert.equal(to.searchParams.get('redirect_uri'), `${SELF}/oauth/computer/callback`);
  assert.deepEqual(JSON.parse(pc.state.seen.find((x) => x.path === '/api/oauth/register')!.body), { client_name: 'ChatGPT', redirect_uris: [`${SELF}/oauth/computer/callback`] });
  pc.state.challenge = to.searchParams.get('code_challenge')!;
  const state = to.searchParams.get('state')!;

  // the person pressed Allow there: the computer sends the browser back with its code
  const cb = await fetch(`${base}/oauth/computer/callback?${new URLSearchParams({ code: 'good-code', state })}`, { redirect: 'manual' });
  assert.equal(cb.status, 302);
  const t = await tokenFrom(cb.headers.get('location')!, s);
  assert.equal(t.status, 200);
  assert.deepEqual(await (await mcp(t.json.access_token!, rpc('ping'))).json(), { jsonrpc: '2.0', id: 1, result: { echo: 'ping' } });
  // the same page a second time is out of date
  assert.equal((await fetch(`${base}/oauth/computer/callback?${new URLSearchParams({ code: 'good-code', state })}`, { redirect: 'manual' })).status, 400);

  // Cancel on the computer's page, and a code the computer does not take: the AI app is told it was refused
  for (const q of [{ error: 'access_denied' }, { code: 'wrong-code' }]) {
    // ChatGPT is allowed by now, so a second app asks
    const s3 = await startSignIn('https://claude.ai/api/mcp/auth_callback');
    const a3 = await approve(s3.req, c.id);
    const st = new URL(a3.json.redirect!).searchParams.get('state')!;
    const r = await fetch(`${base}/oauth/computer/callback?${new URLSearchParams({ ...q, state: st })}`, { redirect: 'manual' });
    assert.equal(r.headers.get('location'), 'https://claude.ai/api/mcp/auth_callback?error=access_denied&state=st8');
  }

  // a computer that is off can't show its Allow page
  pc.state.down = true;
  const s4 = await startSignIn('https://claude.ai/api/mcp/auth_callback');
  assert.deepEqual(await approve(s4.req, c.id), { status: 503, json: { error: 'computer_unreachable' } });
});

test('while the computer is off a tool says so in plain words, and the connection stays up', async () => {
  const { token } = await connected();
  const listed = (await (await mcp(token, rpc('tools/list'))).json()) as { result: unknown };
  assert.equal((await (await mcp(token, rpc('tools/call', { name: 'media_search', arguments: {} }))).json() as { result: { isError?: boolean } }).result.isError, undefined);

  pc.state.down = true;
  const call = (await (await mcp(token, rpc('tools/call', { name: 'media_search', arguments: {} }, 7))).json()) as { id: number; result: { content: { text: string }[]; isError: boolean } };
  assert.deepEqual(call, { jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: UNREACHABLE }], isError: true } } as unknown as typeof call);
  const init = (await (await mcp(token, rpc('initialize', { protocolVersion: '2025-03-26' }))).json()) as { result: { protocolVersion: string; capabilities: unknown } };
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.deepEqual(init.result.capabilities, { tools: {}, resources: {} });
  // its tools are the ones it listed last
  assert.deepEqual(await (await mcp(token, rpc('tools/list'))).json(), listed);
  assert.equal((await mcp(token, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const both = (await (await mcp(token, [rpc('ping', {}, 1), rpc('tools/call', { name: 'get_review' }, 2)])).json()) as { id: number }[];
  assert.deepEqual(both.map((x) => x.id), [1, 2]);

  // counted: per app and tool, and how many found the computer off; nothing about who or what
  const stats = (await (await fetch(`${base}/v1/stats`, { headers: { authorization: `Bearer ${mintAccountToken(SECRET, ':stats', clock)}` } })).json()) as { ai: { apps: unknown[]; tools: unknown[] } };
  assert.deepEqual(stats.ai, {
    apps: [{ app: 'ChatGPT', connected: 1, active7: 1, active30: 1 }],
    tools: [{ tool: 'media_search', calls: 2, unreachable: 1 }, { tool: 'get_review', calls: 1, unreachable: 1 }],
  });
  assert.deepEqual(deps.db.prepare('SELECT name FROM pragma_table_info(?)').all('ai_daily').map((r) => (r as { name: string }).name), ['day', 'app', 'tool', 'calls', 'unreachable']);
});

test('removing the connection on the computer ends it here, and the AI app is told to sign in again', async () => {
  const { token } = await connected();
  pc.state.key = `ctk_${'b'.repeat(48)}`; // the computer no longer knows the old key
  const r = await mcp(token, rpc('tools/list'));
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate') ?? '', /resource_metadata=/);
  assert.equal(Number((deps.db.prepare('SELECT COUNT(*) AS n FROM ai_grants').get() as { n: number }).n), 0);
  assert.equal((await mcp(token, rpc('tools/list'))).status, 401);
});

test('the app takes its allowance back, and an unlinked computer takes its connections with it', async () => {
  const { c, token } = await connected();
  assert.deepEqual(await (await c.allow('ChatGPT', null)).json(), { removed: true });
  assert.equal((await mcp(token, rpc('ping'))).status, 401);

  const again = await connected();
  assert.equal((await fetch(`${base}/v1/computers/${again.c.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${acct()}` } })).status, 204);
  assert.equal((await mcp(again.token, rpc('ping'))).status, 401);
  assert.equal(Number((deps.db.prepare('SELECT COUNT(*) AS n FROM ai_tokens').get() as { n: number }).n), 0);
});

test('refusals: another account, a forged or late request, a wrong proof, an unsigned allowance', async () => {
  const c = addComputer('acct-1');
  await c.allow('ChatGPT');
  const s = await startSignIn();
  // someone else's computer
  assert.equal((await approve(s.req, c.id, acct('acct-2'))).status, 404);
  assert.deepEqual((await (await post('/oauth/authorize/info', { req: s.req }, acct('acct-2'))).json() as { computers: unknown[] }).computers, []);
  // Cancel
  assert.equal((await approve(s.req, c.id, acct(), false)).json.redirect, `${REDIRECT}?error=access_denied&state=st8`);
  // a made-up request, and one that took too long
  assert.equal((await approve('AAAA', c.id)).status, 400);
  clock += 601;
  assert.deepEqual(await approve(s.req, c.id), { status: 400, json: { error: 'expired_request' } });

  // the wrong proof spends the code
  const s2 = await startSignIn();
  const a2 = await approve(s2.req, c.id);
  assert.equal((await tokenFrom(a2.json.redirect!, { reg: s2.reg, verifier: 'x'.repeat(43) })).status, 400);
  assert.equal((await tokenFrom(a2.json.redirect!, s2)).status, 400);

  // an app this broker never registered, a return link it wasn't registered with, no proof asked for
  const q = (o: Record<string, string>) => fetch(`${base}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: s2.reg.client_id, redirect_uri: REDIRECT, code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', ...o })}`, { redirect: 'manual' });
  assert.equal((await q({ client_id: `${s2.reg.client_id.split('.')[0]}.AAAA` })).status, 400);
  assert.equal((await q({ redirect_uri: 'https://evil.example/cb' })).status, 400);
  assert.match((await q({ code_challenge_method: 'plain' })).headers.get('location') ?? '', /error=invalid_request/);
  assert.equal((await post('/oauth/register', { redirect_uris: ['http://evil.example/cb'] })).status, 400);

  // an allowance must be signed by that computer's own key, now
  const other = addComputer('acct-2', 'Other');
  assert.equal((await post(`/v1/computers/${c.id}/ai-grant`, other.signed({ purpose: 'ai-grant', computer_id: c.id, at: clock, app: 'Claude', key: pc.state.key }))).status, 401);
  assert.equal((await post(`/v1/computers/${c.id}/ai-grant`, c.signed({ purpose: 'tunnel', computer_id: c.id, at: clock, app: 'Claude', key: pc.state.key }))).status, 401);
  assert.equal((await post(`/v1/computers/${c.id}/ai-grant`, c.signed({ purpose: 'ai-grant', computer_id: c.id, at: clock - 1000, app: 'Claude', key: pc.state.key }))).status, 401);
  assert.equal((await post(`/v1/computers/${c.id}/ai-grant`, c.signed({ purpose: 'ai-grant', computer_id: c.id, at: clock, app: 'Claude', key: 'not-a-key' }))).status, 400);
});
