import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { KeyObject } from 'node:crypto';
import type { Cloudflare } from './cloudflare.ts';
import { HttpError } from './errors.ts';
import { DEVICE_GRANT, decideDevice, pollDeviceGrant, startDeviceGrant } from './device.ts';
import { createChallenge, linkComputer, listComputers, ticketFor, unlinkComputer, type LinkDeps } from './link.ts';
import type { LimitFor } from './limits.ts';
import { publicKeyB64 } from './keys.ts';
import { ACCOUNT_TTL, checkAccountToken, mintAccountToken, TokenError } from './tickets.ts';

export interface Deps {
  db: DatabaseSync;
  cf: Cloudflare;
  now: () => number;
  limitFor: LimitFor;
  tunnelDomain: string;
  publicUrl: string; // where the approve page lives: <publicUrl>/connect
  accountSecret: Buffer;
  signing: { privateKey: KeyObject; publicKey: KeyObject; kid: string };
}

const MAX_BODY = 16 * 1024;

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
  try {
    if (req.method === 'GET' && path === '/healthz') return new Response('ok');
    if (req.method === 'GET' && path === '/v1/keys') {
      return json(200, { keys: [{ kid: d.signing.kid, publicKey: publicKeyB64(d.signing.publicKey) }] });
    }

    if (req.method === 'POST' && path === '/oauth/device') {
      return json(200, startDeviceGrant(d.db, d.now(), `${d.publicUrl}/connect`));
    }
    if (req.method === 'POST' && path === '/oauth/token') {
      const b = await body(req);
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
        try {
          status = await d.cf.tunnelStatus(r.tunnel_id);
        } catch {
          status = 'unknown';
        }
        computers.push({ id: r.id, name: r.name, hostname: r.hostname, status: status ?? 'gone', created_at: r.created_at });
      }
      return json(200, { computers });
    }
    const m = /^\/v1\/computers\/([0-9a-f]{32})(\/ticket)?$/.exec(path);
    if (m && req.method === 'POST' && m[2]) {
      return json(200, ticketFor(link, accountOf(d, req), m[1]));
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
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size <= MAX_BODY) chunks.push(c as Buffer);
      }
      if (size > MAX_BODY) {
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
