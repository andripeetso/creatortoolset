import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { env } from "../lib/env";

// What this computer knows once it is linked: which account owns it, its tunnel hostname, and the broker's key it
// pinned at link time. The tunnel token is a secret, so the file is mode 0600. Ticket ids already spent are kept
// here too, until their expiry, so a restart does not make a ticket work twice.
export interface ConnectState {
  brokerUrl: string;
  owner: string; // the broker account id that approved the link
  localUser: string; // the local account that started it: a ticket signs in as this one
  computerId: string;
  name: string;
  origin: string;
  hostname: string; // the tunnel hostname; requests on it are remote
  tunnelToken: string;
  relayKid: string;
  relayPublicKey: string; // base64 SPKI DER
  usedJti: Record<string, number>; // jti -> exp (unix seconds)
}

const file = () => path.join(env.dataDir, "connect.json");
let cache: ConnectState | null | undefined;

export function connectState(): ConnectState | null {
  if (cache !== undefined) return cache;
  try {
    cache = JSON.parse(readFileSync(file(), "utf8")) as ConnectState;
  } catch {
    cache = null; // not linked (or unreadable: then nothing is trusted)
  }
  return cache;
}

export function saveConnectState(next: ConnectState | null): void {
  if (next === null) {
    cache = null;
    return;
  }
  mkdirSync(env.dataDir, { recursive: true });
  writeFileSync(file(), JSON.stringify(next), { mode: 0o600 });
  cache = next;
}

/** The tunnel hostname of a linked computer, or null. Requests whose Host is this name came through the tunnel. */
export const tunnelHostname = (): string | null => connectState()?.hostname ?? null;

/** True once per jti: the first use of a ticket. A spent or unknown-to-us ticket (after expiry) is refused. */
export function consumeJti(jti: string, exp: number, now: number): boolean {
  const s = connectState();
  if (!s) return false;
  for (const [k, e] of Object.entries(s.usedJti)) if (e <= now) delete s.usedJti[k];
  if (s.usedJti[jti] !== undefined) return false;
  s.usedJti[jti] = exp;
  saveConnectState(s);
  return true;
}
