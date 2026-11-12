import { createServer, type Server } from 'node:http';

// A stand-in for the Cloudflare API routes the broker uses, as a real HTTP server so cloudflare.ts's requests,
// headers and bodies are the ones it would send. It keeps tunnels and DNS records in memory and enforces the two
// rules that matter: a tunnel with a live connector cannot be deleted, and a missing object is a 404.
export interface FakeCloudflare {
  url: string;
  tunnels: Map<string, { name: string; status: string; ingress: unknown }>;
  records: Map<string, { name: string; content: string }>;
  setStatus(tunnelId: string, status: string): void;
  close(): Promise<void>;
}

export async function fakeCloudflare(): Promise<FakeCloudflare> {
  const tunnels = new Map<string, { name: string; status: string; ingress: unknown }>();
  const records = new Map<string, { name: string; content: string }>();
  let seq = 0;

  const reply = (res: import('node:http').ServerResponse, status: number, result: unknown, message = '') => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        status < 300
          ? { success: true, errors: [], result }
          : { success: false, result: null, errors: [{ code: status, message: message || 'not found' }] },
      ),
    );
  };

  const server: Server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    if (req.headers.authorization !== 'Bearer test-token') return reply(res, 403, null, 'forbidden');
    const body = raw ? JSON.parse(raw) : {};
    const p = new URL(req.url ?? '/', 'http://fake').pathname;
    let m: RegExpExecArray | null;

    if (req.method === 'POST' && /^\/client\/v4\/accounts\/[^/]+\/cfd_tunnel$/.test(p)) {
      const id = `tun${++seq}`;
      tunnels.set(id, { name: body.name, status: 'inactive', ingress: null });
      return reply(res, 200, { id, name: body.name });
    }
    if ((m = /^\/client\/v4\/accounts\/[^/]+\/cfd_tunnel\/([^/]+)\/token$/.exec(p)) && req.method === 'GET') {
      if (!tunnels.has(m[1])) return reply(res, 404, null);
      return reply(res, 200, `connector-token-${m[1]}`);
    }
    if ((m = /^\/client\/v4\/accounts\/[^/]+\/cfd_tunnel\/([^/]+)\/configurations$/.exec(p)) && req.method === 'PUT') {
      const t = tunnels.get(m[1]);
      if (!t) return reply(res, 404, null);
      t.ingress = body.config?.ingress;
      return reply(res, 200, {});
    }
    if ((m = /^\/client\/v4\/accounts\/[^/]+\/cfd_tunnel\/([^/]+)\/connections$/.exec(p)) && req.method === 'DELETE') {
      const t = tunnels.get(m[1]);
      if (t) t.status = 'inactive';
      return reply(res, 200, {});
    }
    if ((m = /^\/client\/v4\/accounts\/[^/]+\/cfd_tunnel\/([^/]+)$/.exec(p))) {
      const t = tunnels.get(m[1]);
      if (req.method === 'GET') return t ? reply(res, 200, { id: m[1], status: t.status }) : reply(res, 404, null);
      if (req.method === 'DELETE') {
        if (!t) return reply(res, 404, null);
        if (t.status === 'healthy') return reply(res, 400, null, 'tunnel has active connections');
        tunnels.delete(m[1]);
        return reply(res, 200, {});
      }
    }
    if (req.method === 'POST' && /^\/client\/v4\/zones\/[^/]+\/dns_records$/.test(p)) {
      const id = `rec${++seq}`;
      records.set(id, { name: body.name, content: body.content });
      return reply(res, 200, { id, name: body.name, content: body.content });
    }
    if ((m = /^\/client\/v4\/zones\/[^/]+\/dns_records\/([^/]+)$/.exec(p)) && req.method === 'PATCH') {
      const r = records.get(m[1]);
      if (!r) return reply(res, 404, null);
      r.content = body.content;
      return reply(res, 200, { id: m[1], ...r });
    }
    if ((m = /^\/client\/v4\/zones\/[^/]+\/dns_records\/([^/]+)$/.exec(p)) && req.method === 'DELETE') {
      if (!records.has(m[1])) return reply(res, 404, null);
      records.delete(m[1]);
      return reply(res, 200, {});
    }
    reply(res, 404, null, 'no such route');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    tunnels,
    records,
    setStatus(id, status) {
      const t = tunnels.get(id);
      if (t) t.status = status;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
