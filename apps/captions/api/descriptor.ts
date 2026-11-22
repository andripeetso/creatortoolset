import { Hono } from "hono";
import { hostname, networkInterfaces } from "node:os";
import { routeAddress, type AuthVars } from "./auth";
import { computerKey } from "./connect/keys";
import { connectState } from "./connect/state";
import { hasTeam, hostedPlatform, isCloud, serverKind } from "./lib/env";
import { accountTicketHost } from "./sign-in";
import type { ServerDescriptor, ServerEndpoint } from "./lib/clients";

/** Who this server is, for a phone to check before it sends a code or a token. Public: it holds nothing secret. */
export function descriptor(): ServerDescriptor {
  let label = hostname().replace(/\.local$/, "");
  if (hasTeam() && process.env.PUBLIC_ORIGIN) {
    try {
      label = new URL(process.env.PUBLIC_ORIGIN).hostname;
    } catch { /* not a URL: the machine's name */ }
  }
  return {
    serverId: computerKey().id,
    label,
    kind: serverKind(),
    platform: hostedPlatform() ? "hosted" : process.platform === "darwin" ? "mac" : "linux",
    version: process.env.CT_VERSION ?? "",
    protocol: 1,
    capabilities: { pairing: true, dpop: true, connect: !!connectState(), account: !!accountTicketHost() },
  };
}

export const descriptorApp = new Hono();
descriptorApp.get("/.well-known/creator-toolset/server", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(descriptor());
});

/**
 * The iPhone app that opens this server's pairing links (`https://host/#token=…`) straight from the Camera: Apple reads
 * this file to let the app claim them. IOS_APP_IDS (comma-separated `<team id>.<bundle id>`) names a build of your own;
 * the default is the public Creator Toolset app.
 */
export const IOS_APP_IDS = "8DB5KKMAS3.com.creatortoolset.ios";
descriptorApp.get("/.well-known/apple-app-site-association", (c) => {
  const appIDs = (process.env.IOS_APP_IDS || IOS_APP_IDS).split(",").map((s) => s.trim()).filter(Boolean);
  c.header("Cache-Control", "public, max-age=3600");
  return c.json({ applinks: { details: [{ appIDs, components: [{ "/": "/", "#": "token=*", comment: "pairing link" }] }] } });
});

/** HOST unset, 0.0.0.0 or ::: the server listens on every interface, so other machines can reach it. */
export const listensEverywhere = (host = process.env.HOST) => !host || host === "0.0.0.0" || host === "::";

const v4 = (a: string) => a.replace(/^::ffff:(?=\d+\.)/i, "");
const TAILNET = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./; // 100.64.0.0/10

/**
 * The addresses other machines can reach this server on: the default route's (LAN) and a tailnet one. Never loopback,
 * and none in hosted mode: there the container's own addresses reach nobody.
 */
export async function endpoints(port: string): Promise<ServerEndpoint[]> {
  if (isCloud() || !listensEverywhere()) return [];
  const out: ServerEndpoint[] = [];
  const lan = await routeAddress();
  if (lan && !/^127\./.test(lan) && !TAILNET.test(lan)) out.push({ kind: "lan", httpBaseUrl: `http://${lan}:${port}` });
  // shortcut: any 100.64.0.0/10 address counts as the tailnet one, without asking its daemon; good enough while no
  // other overlay network is in use on these machines
  const tail = Object.values(networkInterfaces())
    .flat()
    .find((a) => a && a.family === "IPv4" && !a.internal && TAILNET.test(a.address));
  if (tail) out.push({ kind: "tailnet", httpBaseUrl: `http://${tail.address}:${port}` });
  return out;
}

export const endpointsApp = new Hono<{ Variables: AuthVars }>();
endpointsApp.get("/endpoints", async (c) => c.json(await endpoints(process.env.PORT || "3000")));

/**
 * When the server listens on every interface: a peer that may connect. Loopback, private (RFC 1918, fc00::/7),
 * link-local and 100.64.0.0/10. Anything else is the internet reaching a computer that meant to serve its own network.
 */
export function allowedPeer(address: string | undefined): boolean {
  if (!address) return false;
  const a = v4(address.toLowerCase().replace(/%.*$/, ""));
  if (a.includes(":")) return a === "::1" || /^f[cd][0-9a-f]{2}:/.test(a) || /^fe[89ab][0-9a-f]:/.test(a);
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(a) || TAILNET.test(a);
}
