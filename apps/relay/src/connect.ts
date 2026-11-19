import { randomBytes, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './errors.ts';
import { checkDpop } from './dpop.ts';
import { parsePublicKey } from './keys.ts';
import { checkAccountToken, TokenError } from './tickets.ts';

// A phone signed in to the account reaches its computers here, with no code and no password:
// 1. POST /v1/client/dpop-token: the account token → a 30-minute token bound to the phone's own P-256 key (DPoP).
// 2. POST /v1/computers/:id/status: this broker asks the computer, through its tunnel, for an answer signed with the
//    computer's own key and bound to a fresh nonce. "online" means that answer came back, not that the tunnel is up.
// 3. POST /v1/computers/:id/connect: this broker asks the computer to mint a one-time credential bound to the phone's
//    key; the phone trades it on the computer itself (/oauth/token, with a DPoP proof) for its session. This broker
//    never sees that session.
// Requests to a computer are signed with this broker's key (pinned by the computer at link), carry a single-use jti and
// nonce, and are never followed through a redirect.

export const DPOP_TOKEN_TTL = 1800;
export const CLIENT_SCOPES = ['connect', 'status', 'mobile'] as const;
export const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const REQUEST_TTL = 120; // a health or mint request's life (the computer refuses more than 300 s)
const COMPUTER_TIMEOUT_MS = 10_000;
const ANSWER_SKEW = 60; // seconds a computer's signed answer may be off this clock
const MAX_ANSWER = 64 * 1024;

// The computer's side of these is apps/captions/api/connect/contract.md.
export const TYP = {
  token: 'ct-relay-dpop+jwt',
  health: 'ct-connect-health+jwt',
  healthAnswer: 'ct-connect-health-answer+jwt',
  mint: 'ct-connect-mint+jwt',
  mintAnswer: 'ct-connect-mint-answer+jwt',
  linkProof: 'ct-link-proof+jwt',
} as const;
/** How a computer is named in what is signed for it, and in what it signs. */
export const computerName = (id: string) => `ct-computer:${id}`;

export interface ConnectDeps {
  db: DatabaseSync;
  now: () => number;
  signing: { privateKey: KeyObject; publicKey: KeyObject; kid: string };
  accountSecret: Buffer;
  /** This broker's own origin: the iss of what it signs, the aud of what computers sign, the base of every DPoP htu. */
  self: string;
  fetch?: typeof fetch;
  /** Where a computer's tunnel hostname is reached (tests point it at a local server). */
  originOf?: (hostname: string) => string;
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

/** A compact JWS, EdDSA (Ed25519). `typ` names what it is, so one kind can never pass as another. */
export function signJwt(key: KeyObject, typ: string, claims: Record<string, unknown>): string {
  const head = `${b64({ alg: 'EdDSA', typ })}.${b64(claims)}`;
  return `${head}.${sign(null, Buffer.from(head), key).toString('base64url')}`;
}

/** The claims of a JWS this key signed with this typ, or null. */
export function verifyJwt(token: unknown, key: KeyObject, typ: string): Record<string, unknown> | null {
  if (typeof token !== 'string' || token.length > 16 * 1024) return null;
  const [h, p, s, extra] = token.split('.');
  if (!h || !p || !s || extra !== undefined) return null;
  try {
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    if (header?.alg !== 'EdDSA' || header?.typ !== typ) return null;
    if (!verify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))) return null;
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims : null;
  } catch {
    return null;
  }
}

const urlOf = (d: ConnectDeps, path: string) => new URL(path, d.self).href;

/** POST /v1/client/dpop-token (form): grant_type token-exchange, subject_token = an account token, scope optional. */
export function issueDpopToken(d: ConnectDeps, b: Record<string, unknown>, proof: string | null) {
  if (b.grant_type !== TOKEN_EXCHANGE || typeof b.subject_token !== 'string') throw new HttpError(400, 'unsupported_grant_type');
  const asked = typeof b.scope === 'string' && b.scope.trim() ? b.scope.trim().split(/\s+/) : [...CLIENT_SCOPES];
  if (asked.some((s) => !(CLIENT_SCOPES as readonly string[]).includes(s))) throw new HttpError(400, 'invalid_scope');
  let account: string;
  try {
    account = checkAccountToken(d.accountSecret, b.subject_token, d.now());
  } catch (e) {
    if (e instanceof TokenError || e instanceof SyntaxError) throw new HttpError(400, 'invalid_grant');
    throw e;
  }
  const now = d.now();
  const jkt = checkDpop(d.db, proof, { method: 'POST', url: urlOf(d, '/v1/client/dpop-token'), now });
  const scope = [...new Set(asked)].join(' ');
  const token = signJwt(d.signing.privateKey, TYP.token, {
    iss: d.self, aud: d.self, sub: account, jti: randomUUID(), iat: now, exp: now + DPOP_TOKEN_TTL, scope, cnf: { jkt },
  });
  return { access_token: token, token_type: 'DPoP', expires_in: DPOP_TOKEN_TTL, scope };
}

/**
 * A request with `Authorization: DPoP <token>` and a `DPoP` proof made with the token's key for this method and URL.
 * Returns the account and the phone key's thumbprint. Anything wrong is 401; a token without the scope is 403.
 */
export function dpopCaller(d: ConnectDeps, req: Request, scope: (typeof CLIENT_SCOPES)[number]) {
  const h = req.headers.get('authorization') ?? '';
  if (!h.startsWith('DPoP ')) throw new HttpError(401, 'unauthorized');
  const token = h.slice(5);
  const c = verifyJwt(token, d.signing.publicKey, TYP.token);
  const now = d.now();
  const jkt = (c?.cnf as { jkt?: unknown } | undefined)?.jkt;
  if (!c || c.iss !== d.self || c.aud !== d.self || typeof c.sub !== 'string' || typeof jkt !== 'string') throw new HttpError(401, 'unauthorized');
  if (typeof c.exp !== 'number' || c.exp <= now) throw new HttpError(401, 'unauthorized');
  const path = new URL(req.url).pathname;
  checkDpop(d.db, req.headers.get('dpop'), { method: req.method, url: urlOf(d, path), now, accessToken: token, jkt });
  if (typeof c.scope !== 'string' || !c.scope.split(' ').includes(scope)) throw new HttpError(403, 'insufficient_scope');
  return { account: c.sub, jkt };
}

type Linked = { hostname: string; public_key: string | null; released_at: number | null };

function linked(d: ConnectDeps, account: string, computerId: string): Linked {
  const row = d.db.prepare('SELECT hostname, public_key, released_at FROM computers WHERE id = ? AND account_id = ?').get(computerId, account) as
    | Linked
    | undefined;
  // another account's computer reads as not linked, never as forbidden
  if (!row) throw new HttpError(404, 'computer_link_not_found');
  return row;
}

/** Why a computer did not answer, in words the phone's diagnosis can name (Cloudflare's codes first). */
export function classifyAnswer(status: number, body: string): string {
  const cf = /error code:\s*(\d{4})/i.exec(body)?.[1];
  if (cf === '1016') return 'dns';
  if (cf === '1033') return 'tunnel_down';
  if (status >= 300 && status < 400) return 'redirect';
  switch (status) {
    case 530:
      return cf === undefined ? 'tunnel_down' : 'unknown';
    case 502:
    case 503:
      return 'origin_unreachable'; // cloudflared is up, nothing listens on the computer's port
    case 521:
      return 'refused';
    case 504:
    case 522:
    case 524:
      return 'timeout';
    case 525:
    case 526:
      return 'tls';
    default:
      return 'invalid_response';
  }
}

type Answer = { ok: true; json: Record<string, unknown> } | { ok: false; failure: string };

/** POSTs a signed request to a computer through its tunnel: 10 s at most, redirects refused, the answer capped. */
async function askComputer(d: ConnectDeps, hostname: string, path: string, proof: string): Promise<Answer> {
  const origin = d.originOf ? d.originOf(hostname) : `https://${hostname}`;
  let res: Response;
  try {
    res = await (d.fetch ?? fetch)(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proof }),
      redirect: 'manual',
      signal: AbortSignal.timeout(COMPUTER_TIMEOUT_MS),
    });
  } catch (e) {
    const err = e as { name?: string; cause?: { code?: string } };
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return { ok: false, failure: 'timeout' };
    const code = err.cause?.code;
    return { ok: false, failure: code === 'ECONNREFUSED' ? 'refused' : code === 'ENOTFOUND' ? 'dns' : 'unreachable' };
  }
  const text = await res.text().catch(() => '');
  if (res.status !== 200) return { ok: false, failure: classifyAnswer(res.status, text.slice(0, 512)) };
  if (text.length > MAX_ANSWER) return { ok: false, failure: 'invalid_response' };
  try {
    const json = JSON.parse(text);
    if (json && typeof json === 'object' && !Array.isArray(json)) return { ok: true, json };
  } catch {
    // below
  }
  return { ok: false, failure: 'invalid_response' };
}

/** The claims of a computer's answer, when its own key signed it to this broker for this request; else null. */
function answerClaims(d: ConnectDeps, row: Linked, computerId: string, token: unknown, typ: string, nonce: string) {
  const c = verifyJwt(token, parsePublicKey(row.public_key!), typ);
  const now = d.now();
  if (!c || c.iss !== computerName(computerId) || c.sub !== computerId || c.aud !== d.self || c.requestNonce !== nonce) return null;
  if (typeof c.iat !== 'number' || Math.abs(now - c.iat) > ANSWER_SKEW) return null;
  if (typeof c.exp !== 'number' || c.exp <= now) return null;
  return c;
}

const request = (d: ConnectDeps, account: string, computerId: string, scope: string, extra: Record<string, unknown> = {}) => {
  const now = d.now();
  const nonce = randomUUID();
  return {
    nonce,
    now,
    claims: { iss: d.self, aud: computerName(computerId), sub: account, jti: randomUUID(), iat: now, exp: now + REQUEST_TTL, nonce, scope: [scope], ...extra },
  };
};

/** POST /v1/computers/:id/status: online only when the computer itself signed the answer to this nonce. */
export async function computerStatus(d: ConnectDeps, account: string, computerId: string) {
  const row = linked(d, account, computerId);
  const endpoint = `https://${row.hostname}`;
  const traceId = randomBytes(8).toString('hex');
  const r = request(d, account, computerId, 'status');
  const checkedAt = new Date(r.now * 1000).toISOString();
  const offline = (more: Record<string, unknown>) => ({ computerId, endpoint, status: 'offline', checkedAt, ...more, traceId });
  // released while it was off: nothing answers on that hostname until the computer asks for its tunnel again
  if (row.released_at !== null) return offline({ offlineReason: 'tunnel_released' });
  // linked before keys were kept, and not back since: there is nothing to check an answer with yet
  if (!row.public_key) return offline({ endpointFailure: 'key_unknown' });
  const a = await askComputer(d, row.hostname, '/api/connect/health', signJwt(d.signing.privateKey, TYP.health, r.claims));
  if (!a.ok) return offline({ endpointFailure: a.failure });
  const c = answerClaims(d, row, computerId, a.json.proof, TYP.healthAnswer, r.nonce);
  const descriptor = c?.descriptor as { serverId?: unknown } | undefined;
  if (!c || (descriptor?.serverId !== undefined && descriptor.serverId !== computerId)) {
    console.error('health answer not signed by the computer', computerId, traceId);
    throw new HttpError(502, 'invalid_response');
  }
  return {
    computerId,
    endpoint,
    status: 'online',
    checkedAt: typeof c.checkedAt === 'string' ? c.checkedAt : checkedAt,
    ...(descriptor && typeof descriptor === 'object' ? { descriptor } : {}),
    traceId,
  };
}

const seconds = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' ? Math.floor(Date.parse(v) / 1000) : NaN);

/**
 * POST /v1/computers/:id/connect { clientProofKeyThumbprint }: the computer mints a one-time credential bound to the
 * calling phone's key. The body's thumbprint must be the key the caller signed this request with.
 */
export async function connectComputer(d: ConnectDeps, caller: { account: string; jkt: string }, computerId: string, b: Record<string, unknown>) {
  if (b.clientProofKeyThumbprint !== caller.jkt) throw new HttpError(401, 'unauthorized');
  const row = linked(d, caller.account, computerId);
  if (!row.public_key) throw new HttpError(409, 'computer_key_unknown');
  const device = typeof b.deviceId === 'string' && b.deviceId.length <= 128 ? { deviceId: b.deviceId } : {};
  const r = request(d, caller.account, computerId, 'connect', { cnf: { jkt: caller.jkt }, clientProofKeyThumbprint: caller.jkt, ...device });
  const a = await askComputer(d, row.hostname, '/api/connect/mint', signJwt(d.signing.privateKey, TYP.mint, r.claims));
  if (!a.ok) throw new HttpError(a.failure === 'timeout' ? 504 : 502, a.failure === 'timeout' ? 'computer_timeout' : 'computer_unreachable');
  const c = answerClaims(d, row, computerId, a.json.proof, TYP.mintAnswer, r.nonce);
  const exp = seconds(a.json.expiresAt);
  const fits =
    c &&
    c.clientProofKeyThumbprint === caller.jkt &&
    typeof a.json.credential === 'string' &&
    a.json.credential.length > 0 &&
    c.credential === a.json.credential &&
    c.exp === exp &&
    exp > d.now() &&
    exp - d.now() <= 300;
  if (!fits) {
    console.error('mint answer not signed by the computer for this request', computerId);
    throw new HttpError(502, 'invalid_response');
  }
  return { computerId, endpoint: `https://${row.hostname}`, credential: a.json.credential, expiresAt: a.json.expiresAt };
}

