// The only file that talks to Cloudflare. Tunnel and DNS calls, nothing else.

export interface Cloudflare {
  createTunnel(name: string): Promise<string>; // tunnel id
  tunnelToken(tunnelId: string): Promise<string>; // connector token for cloudflared
  configureIngress(tunnelId: string, hostname: string, origin: string): Promise<void>;
  createDns(hostname: string, tunnelId: string): Promise<string>; // DNS record id
  deleteDns(recordId: string): Promise<void>;
  tunnelStatus(tunnelId: string): Promise<string | null>; // healthy | degraded | inactive | down; null when gone
  deleteTunnel(tunnelId: string): Promise<void>;
}

export class CloudflareError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface CloudflareConfig {
  accountId: string;
  zoneId: string;
  token: string; // Tunnel:Edit and DNS:Edit on the tunnel zone only
  baseUrl?: string;
  fetch?: typeof fetch;
}

export function createCloudflare(cfg: CloudflareConfig): Cloudflare {
  const f = cfg.fetch ?? fetch;
  const base = cfg.baseUrl ?? 'https://api.cloudflare.com/client/v4';
  const tunnels = `${base}/accounts/${cfg.accountId}/cfd_tunnel`;
  const records = `${base}/zones/${cfg.zoneId}/dns_records`;

  // A 404 is not an error when allow404 is set: deletes are idempotent.
  async function call(method: string, url: string, body?: unknown, allow404 = false): Promise<any> {
    const res = await f(url, {
      method,
      headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (allow404 && res.status === 404) return null;
    const json = (await res.json().catch(() => null)) as { success?: boolean; result?: any; errors?: { message?: string }[] } | null;
    if (!res.ok || !json?.success) {
      const msg = (json?.errors ?? []).map((e) => e.message).join('; ') || `HTTP ${res.status}`;
      throw new CloudflareError(res.status, msg);
    }
    return json.result;
  }

  return {
    async createTunnel(name) {
      return (await call('POST', tunnels, { name, config_src: 'cloudflare' })).id;
    },
    async tunnelToken(id) {
      return call('GET', `${tunnels}/${id}/token`);
    },
    async configureIngress(id, hostname, origin) {
      await call('PUT', `${tunnels}/${id}/configurations`, {
        config: { ingress: [{ hostname, service: origin }, { service: 'http_status:404' }] },
      });
    },
    async createDns(hostname, tunnelId) {
      const r = await call('POST', records, {
        type: 'CNAME',
        name: hostname,
        content: `${tunnelId}.cfargotunnel.com`,
        proxied: true,
        ttl: 1,
      });
      return r.id;
    },
    async deleteDns(id) {
      await call('DELETE', `${records}/${id}`, undefined, true);
    },
    async tunnelStatus(id) {
      const r = await call('GET', `${tunnels}/${id}`, undefined, true);
      return r ? r.status : null;
    },
    async deleteTunnel(id) {
      // Cloudflare refuses to delete a tunnel with live connectors, so drop them first.
      await call('DELETE', `${tunnels}/${id}/connections`, undefined, true);
      await call('DELETE', `${tunnels}/${id}`, undefined, true);
    },
  };
}
