import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './errors.ts';
import { keyId } from './keys.ts';
import { PROOF_WINDOW, signedBody } from './link.ts';

/**
 * One address for AI apps (ChatGPT, Claude): <selfUrl>/mcp. A person signs in to their account on the hosted site,
 * picks their computer, and from then on every MCP request is passed through that computer's tunnel to the app on it
 * and the answer is passed back. Nothing of the person's is kept here: no scripts, pictures or video.
 *
 * What is kept: one row per connection (which account, which computer, which AI app, when made, when last used), the
 * key the computer gave this connection (sealed with RELAY_GRANT_SECRET, so the database file alone opens nothing), and
 * a count per tool per day. No request, answer, prompt or address is logged.
 *
 * The AI app sees a standard OAuth server (register, authorize, token; PKCE). The person's approval happens on their
 * side, one of two ways:
 * - the app on the computer sent its key ahead (POST /v1/computers/<id>/ai-grant, signed with the computer's own key:
 *   the Install button in the app), so signing in to the account is all that is left; or
 * - the browser is sent on to the computer's own Allow page (its /oauth/authorize, through the tunnel), and the code
 *   that comes back is swapped for the key (GET /oauth/computer/callback).
 *
 * While the computer is off, a tool call is answered with one plain sentence, never a transport error.
 */

export interface GatewayDeps {
  db: DatabaseSync;
  now: () => number; // seconds
  publicUrl: string; // the hosted site, where the person signs in (<publicUrl>/connect/ai)
  /** This broker's own address, where the AI app reaches it (RELAY_SELF_URL; the same as publicUrl when unset). */
  selfUrl?: string;
  secret: Buffer; // RELAY_GRANT_SECRET
  fetch?: typeof fetch;
  /** Where a computer answers, from its hostname. Tests point it at a local stand-in. */
  originOf?: (hostname: string) => string;
  /** The token the ChatGPT directory gives to prove the domain is ours (RELAY_OPENAI_APPS_CHALLENGE). */
  openaiChallenge?: string;
}

/** Where the AI app reaches this broker. */
const self = (gw: GatewayDeps) => gw.selfUrl || gw.publicUrl;
const REQ_TTL = 600;
/** Sign-ins kept working per connection (account, computer, AI app). */
const TOKENS_KEPT = 5; // seconds a sign-in may take, from the AI app's redirect to the approval
const CODE_TTL = 300;
const MEDIA_MAX = 5 * 1024 * 1024;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const COMPUTER_KEY = /^ctk_[a-f0-9]{48}$/;
export const UNREACHABLE = "Your computer isn't reachable right now. Open Creator Toolset on it and ask again.";
/** AI apps by where they send the person back: the same names the app's Headless access rows use. */
const KNOWN: Record<string, string> = { 'chatgpt.com': 'ChatGPT', 'chat.openai.com': 'ChatGPT', 'claude.ai': 'Claude', 'claude.com': 'Claude' };

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
const go = (to: string) => new Response(null, { status: 302, headers: { location: to, 'cache-control': 'no-store' } });
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
/** A page for the person's browser when a sign-in can't go on (the AI app has no way to show it). */
const page = (status: number, line: string, title = "This connection can't go ahead") =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Creator Toolset</title>` +
      `<body style="font:16px/1.5 system-ui,sans-serif;max-width:420px;margin:15vh auto;padding:0 20px"><h1 style="font-size:20px">${esc(title)}</h1><p>${esc(line)}</p>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' } },
  );

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const s256 = (s: string) => createHash('sha256').update(s).digest('base64url');
const keyFor = (secret: Buffer, purpose: string) => createHmac('sha256', secret).update(purpose).digest();
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Encrypts and signs a value for one purpose (AES-256-GCM): only this broker reads it back, and only for that purpose. */
export function seal(secret: Buffer, purpose: string, value: unknown): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyFor(secret, purpose), iv);
  const body = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
}
export function unseal<T>(secret: Buffer, purpose: string, text: unknown): T | null {
  try {
    const raw = Buffer.from(String(text), 'base64url');
    if (raw.length < 29) return null;
    const d = createDecipheriv('aes-256-gcm', keyFor(secret, purpose), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString()) as T;
  } catch {
    return null;
  }
}

/* ---- the AI app as an OAuth client ---- */

// A client id carries what it was registered with, signed, so nothing is stored for it.
type Client = { n: string; r: string[]; m: 'none' | 'client_secret_post' | 'client_secret_basic' };
const tag = (gw: GatewayDeps, what: string) => createHmac('sha256', gw.secret).update(what).digest('base64url');
function clientOf(gw: GatewayDeps, id: string): Client | null {
  const [body, sig] = id.split('.');
  if (!body || !sig || !same(sig, tag(gw, `client:${body}`).slice(0, 32))) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString()) as Client;
  } catch {
    return null;
  }
}
/** https anywhere, or http on the person's own computer (an AI app running there). */
const okRedirect = (u: unknown): u is string => {
  if (typeof u !== 'string' || u.length > 500) return false;
  try {
    const url = new URL(u);
    if (url.hash) return false;
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  } catch {
    return false;
  }
};

export function metadata(gw: GatewayDeps, path: string): Response | null {
  const o = self(gw);
  if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
    return json(200, { resource: `${o}/mcp`, authorization_servers: [o], bearer_methods_supported: ['header'] });
  }
  if (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/openid-configuration') {
    return json(200, {
      issuer: o,
      authorization_endpoint: `${o}/oauth/authorize`,
      token_endpoint: `${o}/oauth/token`,
      registration_endpoint: `${o}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      authorization_response_iss_parameter_supported: true,
    });
  }
  if (path === '/.well-known/openai-apps-challenge' && gw.openaiChallenge) {
    return new Response(gw.openaiChallenge.trim(), { headers: { 'content-type': 'text/plain' } });
  }
  return null;
}

export function registerClient(gw: GatewayDeps, b: Record<string, unknown>): Response {
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
  if (!uris.length || uris.length > 5 || !uris.every(okRedirect)) {
    return json(400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris: 1 to 5 https links (http only on localhost)' });
  }
  const m: Client['m'] = b.token_endpoint_auth_method === 'client_secret_post' || b.token_endpoint_auth_method === 'client_secret_basic' ? b.token_endpoint_auth_method : 'none';
  const host = new URL(uris[0] as string).hostname;
  const name = KNOWN[host] ?? ((typeof b.client_name === 'string' && b.client_name.trim().slice(0, 60)) || host);
  const body = Buffer.from(JSON.stringify({ n: name, r: uris, m } satisfies Client)).toString('base64url');
  const id = `${body}.${tag(gw, `client:${body}`).slice(0, 32)}`;
  return json(201, {
    client_id: id,
    ...(m === 'none' ? {} : { client_secret: tag(gw, `secret:${id}`), client_secret_expires_at: 0 }),
    client_id_issued_at: gw.now(),
    client_name: name,
    redirect_uris: uris,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: m,
  });
}

/** Back to the AI app, keeping any query its link already has. */
const back = (redirect: string, params: Record<string, string | undefined>) => {
  const url = new URL(redirect);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return url.toString();
};

// What the AI app asked for, carried through the sign-in on the hosted site as one sealed value.
type Ask = { c: string; r: string; ch: string; s?: string; e: number };

/** GET /oauth/authorize: checks the AI app's request, then hands the browser to the hosted site's sign-in page with it. */
export function startAuthorize(gw: GatewayDeps, url: URL): Response {
  const q = url.searchParams;
  const id = q.get('client_id') ?? '';
  const redirect = q.get('redirect_uri') ?? '';
  const client = clientOf(gw, id);
  if (!client || !client.r.includes(redirect)) return page(400, "The app asking to connect isn't one this service knows. Add Creator Toolset again in that app.");
  const state = q.get('state') ?? undefined;
  const challenge = q.get('code_challenge') ?? '';
  if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !CHALLENGE.test(challenge)) {
    return go(back(redirect, { error: 'invalid_request', error_description: 'PKCE (S256) is required', state }));
  }
  const ask: Ask = { c: id, r: redirect, ch: challenge, ...(state ? { s: state } : {}), e: gw.now() + REQ_TTL };
  return go(`${gw.publicUrl}/connect/ai?req=${seal(gw.secret, 'ask', ask)}`);
}

function askOf(gw: GatewayDeps, req: unknown): { ask: Ask; app: string } {
  const ask = unseal<Ask>(gw.secret, 'ask', req);
  const client = ask ? clientOf(gw, ask.c) : null;
  if (!ask || !client || !(ask.e > gw.now())) throw new HttpError(400, 'expired_request');
  return { ask, app: client.n };
}

type ComputerRow = { id: string; name: string; hostname: string; tunnel_id: string; released_at: number | null };
const computersOf = (db: DatabaseSync, account: string) =>
  db.prepare('SELECT id, name, hostname, tunnel_id, released_at FROM computers WHERE account_id = ? ORDER BY created_at').all(account) as unknown as ComputerRow[];
const grantOf = (db: DatabaseSync, account: string, computer: string, app: string) =>
  (db.prepare('SELECT id FROM ai_grants WHERE account_id = ? AND computer_id = ? AND app = ?').get(account, computer, app) as { id: string } | undefined)?.id;

/**
 * POST /oauth/authorize/info { req } as the signed-in account (the hosted site calls it): which AI app asks, where it
 * sends the person back, and the account's computers. ready: that computer already allowed this app (from its Install
 * button), so Allow needs no second page.
 */
export function authorizeInfo(gw: GatewayDeps, account: string, b: Record<string, unknown>) {
  const { ask, app } = askOf(gw, b.req);
  return {
    app,
    host: new URL(ask.r).host,
    computers: computersOf(gw.db, account).map((c) => ({ id: c.id, name: c.name, up: c.released_at === null && !!c.tunnel_id, ready: !!grantOf(gw.db, account, c.id, app) })),
  };
}

// Sign-ins on their way through a computer's own Allow page, and codes on their way to the AI app: in memory, short-lived.
type Leg = { account: string; computer: string; app: string; cid: string; verifier: string; ask: Ask; exp: number };
type Code = { grant: string; client: string; redirect: string; challenge: string; exp: number };
const legs = new Map<string, Leg>();
const codes = new Map<string, Code>();
function sweep(now: number) {
  for (const [k, v] of legs) if (v.exp <= now) legs.delete(k);
  for (const [k, v] of codes) if (v.exp <= now) codes.delete(k);
}
function codeFor(gw: GatewayDeps, grant: string, ask: Ask): string {
  const now = gw.now();
  sweep(now);
  const code = randomBytes(32).toString('base64url');
  codes.set(code, { grant, client: ask.c, redirect: ask.r, challenge: ask.ch, exp: now + CODE_TTL });
  return code;
}
const done = (gw: GatewayDeps, grant: string, ask: Ask) => back(ask.r, { code: codeFor(gw, grant, ask), state: ask.s, iss: self(gw) });

const originOf = (gw: GatewayDeps, hostname: string) => (gw.originOf ? gw.originOf(hostname) : `https://${hostname}`);
const callback = (gw: GatewayDeps) => `${self(gw)}/oauth/computer/callback`;

/** One connection's key from the computer: kept sealed. Connecting the same app to the same computer again replaces it. */
function saveGrant(gw: GatewayDeps, account: string, computer: string, app: string, key: string): string {
  const sealed = seal(gw.secret, 'key', key);
  const had = grantOf(gw.db, account, computer, app);
  if (had) {
    gw.db.prepare('UPDATE ai_grants SET key_sealed = ? WHERE id = ?').run(sealed, had);
    return had;
  }
  const id = randomBytes(12).toString('hex');
  gw.db.prepare('INSERT INTO ai_grants (id, account_id, computer_id, app, key_sealed, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, account, computer, app, sealed, gw.now());
  return id;
}
function dropGrant(db: DatabaseSync, id: string) {
  lists.delete(id);
  db.prepare('DELETE FROM ai_tokens WHERE grant_id = ?').run(id);
  db.prepare('DELETE FROM ai_grants WHERE id = ?').run(id);
}
/** A computer that leaves its account takes its connections with it (link.ts removeComputer). */
export function dropGrantsOf(db: DatabaseSync, computer: string) {
  db.prepare('DELETE FROM ai_tokens WHERE grant_id IN (SELECT id FROM ai_grants WHERE computer_id = ?)').run(computer);
  db.prepare('DELETE FROM ai_grants WHERE computer_id = ?').run(computer);
}

/**
 * POST /oauth/authorize/approve { req, computer_id, approve } as the signed-in account: where the browser goes next.
 * No: back to the AI app, refused. Yes with a computer that already allowed this app: back to the AI app with its code.
 * Yes otherwise: on to that computer's own Allow page, through its tunnel (this broker registers there as the app's
 * stand-in, so the page names the app); the answer comes back to /oauth/computer/callback.
 */
export async function approveAuthorize(gw: GatewayDeps, account: string, b: Record<string, unknown>): Promise<{ redirect: string }> {
  const { ask, app } = askOf(gw, b.req);
  if (b.approve === false) return { redirect: back(ask.r, { error: 'access_denied', state: ask.s }) };
  const row = computersOf(gw.db, account).find((c) => c.id === b.computer_id);
  if (!row) throw new HttpError(404, 'not_found');
  const ready = grantOf(gw.db, account, row.id, app);
  if (ready) return { redirect: done(gw, ready, ask) };
  let cid = '';
  try {
    const r = await (gw.fetch ?? fetch)(`${originOf(gw, row.hostname)}/api/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: app, redirect_uris: [callback(gw)] }),
      signal: AbortSignal.timeout(15_000),
    });
    cid = r.ok ? String(((await r.json()) as { client_id?: unknown }).client_id ?? '') : '';
  } catch {
    cid = '';
  }
  if (!cid) throw new HttpError(503, 'computer_unreachable');
  const now = gw.now();
  sweep(now);
  const state = randomBytes(24).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  legs.set(state, { account, computer: row.id, app, cid, verifier, ask, exp: now + REQ_TTL });
  const q = new URLSearchParams({ response_type: 'code', client_id: cid, redirect_uri: callback(gw), code_challenge: s256(verifier), code_challenge_method: 'S256', state });
  return { redirect: `https://${row.hostname}/oauth/authorize?${q}` };
}

/** GET /oauth/computer/callback: the computer's Allow page sent the browser back; its code is swapped for the key. */
export async function computerCallback(gw: GatewayDeps, url: URL): Promise<Response> {
  const state = url.searchParams.get('state') ?? '';
  const leg = legs.get(state);
  legs.delete(state); // once, whatever happens next
  if (!leg || !(leg.exp > gw.now())) return page(400, 'This page is out of date. Start connecting again from the app.');
  const refused = () => go(back(leg.ask.r, { error: 'access_denied', state: leg.ask.s }));
  const code = url.searchParams.get('code') ?? '';
  const row = computersOf(gw.db, leg.account).find((c) => c.id === leg.computer);
  if (url.searchParams.get('error') || !code || !row) return refused();
  let key = '';
  try {
    const r = await (gw.fetch ?? fetch)(`${originOf(gw, row.hostname)}/api/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: leg.cid, code_verifier: leg.verifier, redirect_uri: callback(gw) }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    key = r.ok ? String(((await r.json()) as { access_token?: unknown }).access_token ?? '') : '';
  } catch {
    key = '';
  }
  if (!COMPUTER_KEY.test(key)) return refused();
  return go(done(gw, saveGrant(gw, leg.account, leg.computer, leg.app, key), leg.ask));
}

/** POST /oauth/token (grant_type=authorization_code): the AI app swaps its code for its token here. PKCE proves it started the sign-in. */
export function exchangeCode(gw: GatewayDeps, p: Record<string, string>, authorization: string | null): Response {
  const basic = /^Basic (.+)$/i.exec(authorization ?? '')?.[1];
  const [basicId, basicSecret] = basic ? Buffer.from(basic, 'base64').toString().split(':').map(decodeURIComponent) : [];
  const clientId = p.client_id || basicId || '';
  const client = clientOf(gw, clientId);
  if (!client) return json(401, { error: 'invalid_client' });
  if (client.m !== 'none' && !same(p.client_secret || basicSecret || '', tag(gw, `secret:${clientId}`))) return json(401, { error: 'invalid_client' });
  const hit = codes.get(p.code ?? '');
  codes.delete(p.code ?? ''); // once, whatever happens next
  const verifier = p.code_verifier ?? '';
  const proved = !!hit && hit.exp > gw.now() && hit.client === clientId && (!p.redirect_uri || p.redirect_uri === hit.redirect) && VERIFIER.test(verifier) && s256(verifier) === hit.challenge;
  const grant = proved ? (gw.db.prepare('SELECT id FROM ai_grants WHERE id = ?').get(hit.grant) as { id: string } | undefined) : undefined;
  if (!grant) return json(400, { error: 'invalid_grant' });
  const token = `cgw_${randomBytes(32).toString('hex')}`;
  gw.db.prepare('INSERT INTO ai_tokens (token_hash, grant_id, created_at) VALUES (?, ?, ?)').run(sha(token), grant.id, gw.now());
  // the newest few stay: the same account in more than one chat app sign-in (a second device, the store's reviewers)
  // keeps working, and old ones don't pile up out of sight
  gw.db
    .prepare('DELETE FROM ai_tokens WHERE grant_id = ? AND token_hash NOT IN (SELECT token_hash FROM ai_tokens WHERE grant_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)')
    .run(grant.id, grant.id, TOKENS_KEPT);
  return json(200, { access_token: token, token_type: 'Bearer' });
}

/**
 * POST /v1/computers/<id>/ai-grant: the app on a linked computer allows an AI app ahead of the sign-in (its Install
 * button), or takes that back. Signed with the computer's own key: { purpose: "ai-grant", computer_id, at, app, key }.
 * key is the key the computer made for this connection; null removes the connection.
 */
export function grantFromComputer(gw: GatewayDeps, computerId: string, body: Record<string, unknown>) {
  const { key, p } = signedBody(body);
  if (keyId(key) !== computerId || p.purpose !== 'ai-grant' || p.computer_id !== computerId) throw new HttpError(401, 'bad_signature');
  if (typeof p.at !== 'number' || Math.abs(gw.now() - p.at) > PROOF_WINDOW) throw new HttpError(401, 'stale_proof');
  const row = gw.db.prepare('SELECT account_id FROM computers WHERE id = ?').get(computerId) as { account_id: string } | undefined;
  if (!row) throw new HttpError(404, 'unknown_computer');
  const app = typeof p.app === 'string' ? p.app.trim().slice(0, 60) : '';
  if (!app) throw new HttpError(400, 'bad_request');
  if (p.key === null) {
    const had = grantOf(gw.db, row.account_id, computerId, app);
    if (had) dropGrant(gw.db, had);
    return { removed: !!had };
  }
  if (typeof p.key !== 'string' || !COMPUTER_KEY.test(p.key)) throw new HttpError(400, 'bad_request');
  saveGrant(gw, row.account_id, computerId, app, p.key);
  return { ok: true };
}

/* ---- passing requests on ---- */

type Rpc = { id?: unknown; method?: unknown; params?: Record<string, unknown> };
// The last tool list each connection got, so an AI app that asks while the computer is off still gets its tools.
const lists = new Map<string, unknown>();

/** What a request gets while the computer can't be reached: the connection itself stays up, a tool call says why. */
function offline(m: Rpc, cached: unknown): unknown {
  if (m.id === undefined) return null;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: m.id, result });
  switch (m.method) {
    case 'initialize':
      return ok({
        protocolVersion: typeof m.params?.protocolVersion === 'string' ? m.params.protocolVersion : '2025-06-18',
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'creator-toolset', version: '1.0.0' },
        instructions: `Creator Toolset runs on the user's own computer, and that computer can't be reached right now. If a tool says so, tell the user: ${UNREACHABLE}`,
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return cached ? ok(cached) : { jsonrpc: '2.0', id: m.id, error: { code: -32000, message: UNREACHABLE } };
    case 'tools/call':
      return ok({ content: [{ type: 'text', text: UNREACHABLE }], isError: true });
    default:
      return { jsonrpc: '2.0', id: m.id, error: { code: -32000, message: UNREACHABLE } };
  }
}

/**
 * Every link in an answer that points at the computer is turned into one on this address, so an AI app deals with one
 * address for every person: a card's pictures are fetched through /m, any other link opens through /open (below). A
 * card's video link is left out: video stays on the computer.
 */
function throughHere(gw: GatewayDeps, out: unknown, computer: string, hostname: string) {
  const its = `https://${hostname}/`;
  const media = `${its}api/card/media/`;
  const turn = (v: string) => (v.includes(its) ? v.replaceAll(media, `${self(gw)}/m/${computer}/`).replaceAll(its, `${self(gw)}/open/${computer}/`) : v);
  const walk = (v: unknown, card: boolean): unknown => {
    if (typeof v === 'string') return turn(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, card));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !card || k !== 'play').map(([k, x]) => [k, walk(x, card || k === 'card')]));
    return v;
  };
  for (const one of Array.isArray(out) ? out : [out]) {
    const o = one as { result?: Record<string, any> } | null;
    if (!o?.result || typeof o.result !== 'object') continue;
    o.result = walk(o.result, false) as Record<string, any>;
    // the card's page loads pictures from this address only
    for (const c of Array.isArray(o.result.contents) ? o.result.contents : []) {
      if (c?._meta?.ui?.csp) c._meta.ui.csp.resourceDomains = [self(gw)];
      if (c?._meta?.['openai/widgetCSP']) c._meta['openai/widgetCSP'].resource_domains = [self(gw)];
    }
  }
}

const TOOL = /^[a-z][a-z0-9_]{0,63}$/;
function count(gw: GatewayDeps, app: string, list: Rpc[], down: boolean) {
  const day = new Date(gw.now() * 1000).toISOString().slice(0, 10);
  for (const m of list) {
    const tool = m.method === 'tools/call' ? m.params?.name : undefined;
    if (typeof tool !== 'string' || !TOOL.test(tool)) continue;
    gw.db
      .prepare('INSERT INTO ai_daily (day, app, tool, calls, unreachable) VALUES (?, ?, ?, 1, ?) ON CONFLICT(day, app, tool) DO UPDATE SET calls = calls + 1, unreachable = unreachable + excluded.unreachable')
      .run(day, app, tool, down ? 1 : 0);
  }
}

/** POST /mcp: the AI app's request, passed to the computer its token stands for. */
export async function forwardMcp(gw: GatewayDeps, req: Request): Promise<Response> {
  const challenge = { 'www-authenticate': `Bearer resource_metadata="${self(gw)}/.well-known/oauth-protected-resource/mcp"` };
  const token = /^Bearer (cgw_[a-f0-9]{64})$/.exec(req.headers.get('authorization') ?? '')?.[1];
  const g = token
    ? (gw.db
        .prepare(
          `SELECT g.id, g.app, g.key_sealed, g.used_at, c.id AS computer, c.hostname, c.released_at
           FROM ai_tokens t JOIN ai_grants g ON g.id = t.grant_id JOIN computers c ON c.id = g.computer_id WHERE t.token_hash = ?`,
        )
        .get(sha(token)) as { id: string; app: string; key_sealed: string; used_at: number | null; computer: string; hostname: string; released_at: number | null } | undefined)
    : undefined;
  if (!g) return json(401, { error: 'unauthorized' }, challenge);
  const key = unseal<string>(gw.secret, 'key', g.key_sealed);
  if (!key) {
    dropGrant(gw.db, g.id);
    return json(401, { error: 'unauthorized' }, challenge);
  }
  const text = await req.text();
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const list = (Array.isArray(msg) ? msg : [msg]).filter((m): m is Rpc => !!m && typeof m === 'object');

  let res: Response | null = null;
  // a computer whose tunnel was released while it was off is not asked: it has no address until it is back
  if (g.released_at === null) {
    try {
      res = await (gw.fetch ?? fetch)(`${originOf(gw, g.hostname)}/api/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
        // a link the AI app got from here and hands back (a Review video's) is the computer's own again
        body: text.replaceAll(`${self(gw)}/open/${g.computer}/`, `https://${g.hostname}/`),
        signal: AbortSignal.timeout(90_000),
      });
    } catch {
      res = null;
    }
  }
  // the person removed this connection on their computer: it ends here too, and the AI app is told to sign in again
  if (res?.status === 401) {
    dropGrant(gw.db, g.id);
    return json(401, { error: 'unauthorized' }, challenge);
  }
  let out: unknown;
  let down = !res || res.status >= 500;
  if (res && !down && res.status !== 202) {
    try {
      out = JSON.parse(await res.text());
    } catch {
      down = true; // a proxy's error page, not the app's answer
    }
  }
  count(gw, g.app, list, down);
  const now = gw.now();
  if (now - (g.used_at ?? 0) > 60) gw.db.prepare('UPDATE ai_grants SET used_at = ? WHERE id = ?').run(now, g.id);
  if (down) {
    const cached = lists.get(g.id);
    const answers = list.map((m) => offline(m, cached)).filter((a) => a !== null);
    if (!answers.length) return new Response(null, { status: 202 });
    return json(200, Array.isArray(msg) ? answers : answers[0]);
  }
  if (res!.status === 202) return new Response(null, { status: 202 });
  throughHere(gw, out, g.computer, g.hostname);
  if (!Array.isArray(msg) && (msg as Rpc).method === 'tools/list' && (out as { result?: unknown })?.result) lists.set(g.id, (out as { result: unknown }).result);
  return json(res!.status, out);
}

/** GET /m/<computer>/<token>: a card's picture, fetched from the computer with the link the computer itself signed. Pictures only. */
export async function relayMedia(gw: GatewayDeps, computer: string, token: string): Promise<Response> {
  const gone = () => json(404, { error: 'not_found' });
  const row = gw.db.prepare('SELECT hostname, released_at FROM computers WHERE id = ?').get(computer) as { hostname: string; released_at: number | null } | undefined;
  let kind = '';
  try {
    kind = String((JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString()) as { m?: unknown }).m ?? '');
  } catch {
    kind = '';
  }
  // lt, rt: a library clip's and a Review version's thumbnail (the app's api/mcp-cards.ts). Video is never passed on from here.
  if (!row || row.released_at !== null || (kind !== 'lt' && kind !== 'rt') || !/^[\w-]+\.[\w-]+$/.test(token)) return gone();
  let res: Response;
  try {
    res = await (gw.fetch ?? fetch)(`${originOf(gw, row.hostname)}/api/card/media/${token}`, { signal: AbortSignal.timeout(20_000) });
  } catch {
    return gone();
  }
  const type = res.headers.get('content-type') ?? '';
  if (res.status !== 200 || !type.startsWith('image/') || Number(res.headers.get('content-length') ?? 0) > MEDIA_MAX || !res.body) return gone();
  // read with a cap: a picture is small, and nothing larger is held here
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > MEDIA_MAX) return gone();
    chunks.push(chunk);
  }
  return new Response(Buffer.concat(chunks), { headers: { 'content-type': type, 'cache-control': 'private, max-age=3600' } });
}

const OPEN_PATH = /^[A-Za-z0-9._~%/-]{0,500}$/;
const OPEN_QUERY = /^(\?[A-Za-z0-9._~%=&-]{0,500})?$/;

/**
 * GET /open/<computer>/<path>: where a link in an AI app's answer lands. The thing lives on the person's computer, so
 * the page offers the app on it (its own link, creatortoolset://…) and the computer's web address, which asks for the
 * computer's password.
 */
export function openPage(gw: GatewayDeps, computer: string, rest: string, query: string): Response {
  const row = gw.db.prepare('SELECT hostname FROM computers WHERE id = ?').get(computer) as { hostname: string } | undefined;
  if (!row || !OPEN_PATH.test(rest) || !OPEN_QUERY.test(query)) return page(404, "That link doesn't lead anywhere any more.", 'Not found');
  const inApp = `creatortoolset://${rest}${query}`;
  const inBrowser = `https://${row.hostname}/${rest}${query}`;
  const button = 'display:inline-block;padding:10px 18px;border-radius:9px;text-decoration:none;font-weight:600';
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open in Creator Toolset</title>` +
      `<body style="font:16px/1.5 system-ui,sans-serif;max-width:420px;margin:15vh auto;padding:0 20px"><h1 style="font-size:20px">Open in Creator Toolset</h1>` +
      `<p>It is on your computer.</p>` +
      `<p><a style="${button};background:#111;color:#fff" href="${esc(inApp)}">Open in the app</a></p>` +
      `<p><a href="${esc(inBrowser)}">Open in the browser</a>. It asks for your computer's password.</p>`,
    { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' } },
  );
}

/**
 * Counts for the owner's board: per AI app, how many connections there are and how many were used in the last 7 and 30
 * days; and per tool, the calls of the last 30 days and how many of them found the computer off. Counts only.
 */
export function aiStats(db: DatabaseSync, now: number) {
  const apps = db
    .prepare('SELECT app, COUNT(*) AS connected, SUM(used_at >= ?) AS active7, SUM(used_at >= ?) AS active30 FROM ai_grants GROUP BY app ORDER BY connected DESC')
    .all(now - 7 * 86_400, now - 30 * 86_400) as { app: string; connected: number; active7: number | null; active30: number | null }[];
  const since = new Date((now - 30 * 86_400) * 1000).toISOString().slice(0, 10);
  const tools = db
    .prepare('SELECT tool, SUM(calls) AS calls, SUM(unreachable) AS unreachable FROM ai_daily WHERE day >= ? GROUP BY tool ORDER BY calls DESC LIMIT 50')
    .all(since) as { tool: string; calls: number; unreachable: number }[];
  return {
    apps: apps.map((a) => ({ app: a.app, connected: Number(a.connected), active7: Number(a.active7 ?? 0), active30: Number(a.active30 ?? 0) })),
    tools: tools.map((t) => ({ tool: t.tool, calls: Number(t.calls), unreachable: Number(t.unreachable) })),
  };
}
