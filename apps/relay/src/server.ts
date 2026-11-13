import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { KeyObject } from 'node:crypto';
import type { Cloudflare } from './cloudflare.ts';
import { HttpError } from './errors.ts';
import { DEVICE_GRANT, decideDevice, pollDeviceGrant, startDeviceGrant } from './device.ts';
import { connectStats, createChallenge, linkComputer, listComputers, renewTunnel, STATS_ACCOUNT, ticketFor, unlinkComputer, type LinkDeps } from './link.ts';
import type { LimitFor } from './limits.ts';
import { publicKeyB64 } from './keys.ts';
import { ACCOUNT_TTL, checkAccountToken, mintAccountToken, TokenError } from './tickets.ts';
import { aiStats, approveAuthorize, authorizeInfo, computerCallback, exchangeCode, forwardMcp, grantFromComputer, metadata, openPage, registerClient, relayMedia, startAuthorize, type GatewayDeps } from './gateway.ts';

export interface Deps {
  db: DatabaseSync;
  cf: Cloudflare;
  now: () => number;
  limitFor: LimitFor;
  tunnelDomain: string;
  publicUrl: string; // where the approve page lives: <publicUrl>/connect
  accountSecret: Buffer;
  signing: { privateKey: KeyObject; publicKey: KeyObject; kid: string };
  /** AI apps through this broker (gateway.ts). Unset = every route of it answers 404. */
  gateway?: Pick<GatewayDeps, 'secret' | 'fetch' | 'originOf' | 'openaiChallenge' | 'selfUrl'>;
}

const MAX_BODY = 16 * 1024;
/** An AI app's request can carry a whole script. */
const MCP_BODY = 1024 * 1024;
// AI apps that run in a browser read the sign-in addresses from their own page
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization, mcp-protocol-version', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
const open = (res: Response) => {
  for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
  return res;
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const empty = (status: number) => new Response(null, { status });

// Account auth: a bearer token the hosted site or this broker minted. Anything else is 401.
function accountOf(d: Deps, req: Request): string {
  const h = req.headers.get('authorization') ?? '';
  if (!h.startsWith('Bearer ')) throw new HttpError(401, 'unauthorized');
  try {
    return checkAccountToken(d.accountSecret, h.slice(7), d.now());
  } catch (e) {
    if (e instanceof TokenError) throw new HttpError(401, 'unauthorized');
    throw e;
  }
}

async function body(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text) return {};
  // a token request comes as a form (OAuth), everything else as JSON
  if ((req.headers.get('content-type') ?? '').startsWith('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, 'bad_request');
}

// The whole API as one function over Fetch Request and Response, so tests can call it without a socket.
export async function handle(d: Deps, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const link: LinkDeps = { db: d.db, cf: d.cf, now: d.now, limitFor: d.limitFor, tunnelDomain: d.tunnelDomain, signing: d.signing };
  const gw: GatewayDeps | null = d.gateway ? { db: d.db, now: d.now, publicUrl: d.publicUrl, ...d.gateway } : null;
  try {
    if (req.method === 'GET' && path === '/healthz') return new Response('ok');
    if (gw) {
      const forAnyPage = path.startsWith('/.well-known/') || path === '/oauth/register' || path === '/oauth/token';
      if (forAnyPage && req.method === 'OPTIONS') return open(new Response(null, { status: 204 }));
      const meta = req.method === 'GET' ? metadata(gw, path) : null;
      if (meta) return open(meta);
      if (req.method === 'POST' && path === '/oauth/register') return open(registerClient(gw, await body(req)));
      if (req.method === 'GET' && path === '/oauth/authorize') return startAuthorize(gw, url);
      if (req.method === 'POST' && path === '/oauth/authorize/info') return json(200, authorizeInfo(gw, accountOf(d, req), await body(req)));
      if (req.method === 'POST' && path === '/oauth/authorize/approve') return json(200, await approveAuthorize(gw, accountOf(d, req), await body(req)));
      if (req.method === 'GET' && path === '/oauth/computer/callback') return await computerCallback(gw, url);
      if (req.method === 'POST' && path === '/mcp') return await forwardMcp(gw, req);
      if (req.method === 'GET' && path === '/mcp') return new Response(null, { status: 405, headers: { allow: 'POST' } });
      const media = /^\/m\/([0-9a-f]{32})\/([\w.-]{1,2000})$/.exec(path);
      if (media && req.method === 'GET') return await relayMedia(gw, media[1], media[2]);
      const opens = /^\/open\/([0-9a-f]{32})\/(.*)$/.exec(path);
      if (opens && req.method === 'GET') return openPage(gw, opens[1], opens[2], url.search);
    }
    if (req.method === 'GET' && path === '/v1/keys') {
      return json(200, { keys: [{ kid: d.signing.kid, publicKey: publicKeyB64(d.signing.publicKey) }] });
    }

    if (req.method === 'POST' && path === '/oauth/device') {
      return json(200, startDeviceGrant(d.db, d.now(), `${d.publicUrl}/connect`));
    }
    if (req.method === 'POST' && path === '/oauth/token') {
      const b = await body(req);
      if (gw && b.grant_type === 'authorization_code') {
        const p = Object.fromEntries(Object.entries(b).filter((e): e is [string, string] => typeof e[1] === 'string'));
        return open(exchangeCode(gw, p, req.headers.get('authorization')));
      }
      if (b.grant_type !== DEVICE_GRANT || typeof b.device_code !== 'string') throw new HttpError(400, 'unsupported_grant_type');
      const r = pollDeviceGrant(d.db, b.device_code, d.now());
      if ('error' in r) return json(400, { error: r.error });
      return json(200, {
        access_token: mintAccountToken(d.accountSecret, r.accountId, d.now()),
        token_type: 'Bearer',
        expires_in: ACCOUNT_TTL,
      });
    }
    if (req.method === 'POST' && path === '/oauth/device/approve') {
      const account = accountOf(d, req);
      const b = await body(req);
      if (typeof b.user_code !== 'string' || typeof b.approve !== 'boolean') throw new HttpError(400, 'bad_request');
      if (!decideDevice(d.db, b.user_code, b.approve, account, d.now())) throw new HttpError(404, 'unknown_code');
      return empty(204);
    }

    if (req.method === 'POST' && path === '/v1/computers') {
      return json(200, createChallenge(link, accountOf(d, req)));
    }
    if (req.method === 'POST' && path === '/v1/computers/link') {
      return json(200, await linkComputer(link, accountOf(d, req), await body(req)));
    }
    if (req.method === 'GET' && path === '/v1/computers') {
      const account = accountOf(d, req);
      const rows = listComputers(link, account);
      const computers = [];
      for (const r of rows) {
        let status: string | null = null;
        if (r.released_at !== null) status = 'down'; // released while it was off: it gets a tunnel when it is back
        else if (r.tunnel_id) {
          try {
            status = await d.cf.tunnelStatus(r.tunnel_id);
          } catch {
            status = 'unknown';
          }
        }
        computers.push({ id: r.id, name: r.name, hostname: r.hostname, status: status ?? 'gone', created_at: r.created_at });
      }
      return json(200, { computers });
    }
    if (req.method === 'GET' && path === '/v1/stats') {
      if (accountOf(d, req) !== STATS_ACCOUNT) throw new HttpError(403, 'forbidden');
      // the AI app counts only where that part is on
      return json(200, { ...connectStats(d.db, d.now()), ...(gw ? { ai: aiStats(d.db, d.now()) } : {}) });
    }
    const m = /^\/v1\/computers\/([0-9a-f]{32})(\/ticket|\/tunnel|\/ai-grant)?$/.exec(path);
    if (m && req.method === 'POST' && m[2] === '/ai-grant' && gw) {
      return json(200, grantFromComputer(gw, m[1], await body(req)));
    }
    if (m && req.method === 'POST' && m[2] === '/ticket') {
      return json(200, ticketFor(link, accountOf(d, req), m[1]));
    }
    if (m && req.method === 'POST' && m[2] === '/tunnel') {
      return json(200, await renewTunnel(link, m[1], await body(req)));
    }
    if (m && req.method === 'DELETE' && !m[2]) {
      await unlinkComputer(link, accountOf(d, req), m[1]);
      return empty(204);
    }
    throw new HttpError(404, 'not_found');
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.code });
    console.error('request failed', req.method, path, (e as Error).message);
    return json(500, { error: 'internal' });
  }
}

// Node adapter: reads the body with a size cap, then hands a Fetch Request to handle().
export function startServer(d: Deps, port: number, host = '127.0.0.1'): Promise<Server> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      // Over the cap, the rest is read and dropped (not buffered), then refused: the client gets a clean 413.
      const cap = (req.url ?? '').split('?')[0] === '/mcp' ? MCP_BODY : MAX_BODY;
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size <= cap) chunks.push(c as Buffer);
      }
      if (size > cap) {
        res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
        res.end('{"error":"too_large"}');
        return;
      }
      const method = req.method ?? 'GET';
      const init: RequestInit = { method, headers: req.headers as Record<string, string> };
      if (chunks.length && method !== 'GET' && method !== 'HEAD') init.body = Buffer.concat(chunks);
      const out = await handle(d, new Request(new URL(req.url ?? '/', 'http://relay.invalid'), init));
      res.writeHead(out.status, Object.fromEntries(out.headers));
      res.end(Buffer.from(await out.arrayBuffer()));
    } catch {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
