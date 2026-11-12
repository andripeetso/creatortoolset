import { sign } from "node:crypto";
import { computerKey, parseRelayKey } from "./keys";
import { saveConnectState, type ConnectState } from "./state";

// This computer's side of the broker's protocol (apps/relay/src/server.ts): the device grant that signs the account
// in on creatortoolset.com, then the link, which proves this computer's key and returns its tunnel.

export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export class BrokerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

async function call(brokerUrl: string, path: string, init: { method?: string; token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(new URL(path, brokerUrl), {
    method: init.method ?? "POST",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    redirect: "error",
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) throw new BrokerError(res.status, typeof json?.error === "string" ? json.error : "broker_error");
  return json ?? {};
}

export interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  interval: number;
  expires_in: number;
}

export const startDeviceGrant = async (brokerUrl: string) => (await call(brokerUrl, "/oauth/device")) as unknown as DeviceStart;

/** The account token once approved; BrokerError("authorization_pending") until then. */
export async function pollDeviceGrant(brokerUrl: string, deviceCode: string): Promise<string> {
  const r = await call(brokerUrl, "/oauth/token", { body: { grant_type: DEVICE_GRANT, device_code: deviceCode } });
  if (typeof r.access_token !== "string") throw new BrokerError(502, "broker_error");
  return r.access_token;
}

/**
 * Links this computer to the account behind `accessToken`: asks for a one-time challenge, signs it with this
 * computer's key, and saves the tunnel the broker made. The origin is this server on loopback, and only that.
 */
export async function linkThisComputer(o: {
  brokerUrl: string;
  accessToken: string;
  owner: string;
  localUser: string;
  name: string;
  origin: string;
}): Promise<ConnectState> {
  const key = computerKey();
  const challenge = await call(o.brokerUrl, "/v1/computers", { token: o.accessToken });
  const payload = JSON.stringify({ nonce: challenge.nonce, name: o.name, origin: o.origin });
  const signature = sign(null, Buffer.from(payload), key.privateKey).toString("base64");
  const publicKey = key.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const r = await call(o.brokerUrl, "/v1/computers/link", {
    token: o.accessToken,
    body: { public_key: publicKey, payload, signature },
  });
  if (r.computer_id !== key.id || typeof r.hostname !== "string" || typeof r.tunnel_token !== "string") {
    throw new BrokerError(502, "broker_error");
  }
  // the broker's key is pinned here, at link time, and read back only from this file
  parseRelayKey(String(r.relay_public_key));
  const state: ConnectState = {
    brokerUrl: o.brokerUrl,
    owner: o.owner,
    localUser: o.localUser,
    computerId: key.id,
    name: o.name,
    origin: o.origin,
    hostname: r.hostname,
    tunnelToken: r.tunnel_token,
    relayKid: String(r.relay_kid),
    relayPublicKey: String(r.relay_public_key),
    usedJti: {},
  };
  saveConnectState(state);
  return state;
}

/**
 * Asks the broker for this computer's tunnel, signed with this computer's key (no account token). Null while the saved
 * tunnel stands; a new token when the broker had released it, which it does after the tunnel has been down a while (the
 * hostname stays the same). BrokerError("unknown_computer") when the account no longer has this computer.
 */
export async function renewTunnel(s: ConnectState): Promise<string | null> {
  const key = computerKey();
  const payload = JSON.stringify({ purpose: "tunnel", computer_id: s.computerId, at: Math.floor(Date.now() / 1000) });
  const r = await call(s.brokerUrl, `/v1/computers/${s.computerId}/tunnel`, {
    body: {
      public_key: key.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      payload,
      signature: sign(null, Buffer.from(payload), key.privateKey).toString("base64"),
    },
  });
  return typeof r.tunnel_token === "string" ? r.tunnel_token : null;
}

/** The account id in a broker token. Read, not verified: the token came from the broker over TLS a moment ago. */
export function accountOfToken(token: string): string {
  const sub = (JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString()) as { sub?: unknown }).sub;
  if (typeof sub !== "string" || !sub) throw new BrokerError(502, "broker_error");
  return sub;
}
