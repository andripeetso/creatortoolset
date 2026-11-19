// Who may use this server from another device: pairing links, signed-in clients and the addresses a phone reaches it on
// (api/connect/contract.md). The raw pairing code is only ever in this page's memory: listings never carry it.

import { useCallback, useEffect, useState } from "react";

export type AccessScope = "read" | "write" | "access";
export const READ_ONLY: AccessScope[] = ["read"];
export const STANDARD: AccessScope[] = ["read", "write", "access"];

/** A time from the server: ms since 1970 or an ISO string. */
type When = number | string;
export const ms = (t: When | null | undefined): number => (t == null ? NaN : new Date(t).getTime());

export interface PairingLink {
  id: string;
  subject?: string;
  label?: string | null;
  scopes: AccessScope[];
  createdAt?: When;
  expiresAt: When;
}
export interface PairingUrl {
  kind: string;
  url: string;
}
export interface CreatedLink extends PairingLink {
  credential: string;
  urls: PairingUrl[];
}
export interface ClientSession {
  sessionId: string;
  subject?: string;
  label?: string | null;
  scopes: AccessScope[];
  method?: string;
  client: {
    label?: string | null;
    deviceType?: "desktop" | "mobile" | "tablet" | "bot" | "unknown";
    os?: string | null;
    model?: string | null;
    appVersion?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  };
  issuedAt?: When;
  expiresAt?: When;
  lastConnectedAt?: When | null;
  connected: boolean;
  current: boolean;
}
export interface AccessView {
  pairingLinks: PairingLink[];
  clientSessions: ClientSession[];
}
export interface Endpoint {
  kind: "lan" | "tailnet" | string;
  httpBaseUrl: string;
}

async function send<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const out = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw Object.assign(new Error(out.error ?? `Request failed (${r.status})`), { status: r.status });
  return out;
}

export const createPairingLink = (input: { label?: string; scopes: AccessScope[] }) => send<CreatedLink>("/api/auth/pairing-links", input);
export const revokePairingLink = (id: string) => send("/api/auth/pairing-links/revoke", { id });
export const revokeClient = (sessionId: string) => send("/api/auth/clients/revoke", { sessionId });
export const revokeOtherClients = () => send("/api/auth/clients/revoke-others", {});
export const getEndpoints = () => send<Endpoint[]>("/api/server/endpoints");

const EVENTS = ["snapshot", "pairingLinkUpserted", "pairingLinkRemoved", "clientUpserted", "clientRemoved"] as const;
export type AccessEvent = (typeof EVENTS)[number];

const upsert = <T,>(list: T[], item: T, same: (a: T) => boolean) => (list.some(same) ? list.map((x) => (same(x) ? item : x)) : [...list, item]);

/** One event of /api/auth/access/events applied to the list. */
export function applyAccessEvent(view: AccessView | null, type: AccessEvent, data: unknown): AccessView | null {
  if (type === "snapshot") return data as AccessView;
  if (!view) return view;
  const d = data as Partial<PairingLink & ClientSession> & { id?: string; sessionId?: string };
  switch (type) {
    case "pairingLinkUpserted":
      return { ...view, pairingLinks: upsert(view.pairingLinks, d as PairingLink, (l) => l.id === d.id) };
    case "pairingLinkRemoved":
      return { ...view, pairingLinks: view.pairingLinks.filter((l) => l.id !== d.id) };
    case "clientUpserted":
      return { ...view, clientSessions: upsert(view.clientSessions, d as ClientSession, (s) => s.sessionId === d.sessionId) };
    case "clientRemoved":
      return { ...view, clientSessions: view.clientSessions.filter((s) => s.sessionId !== d.sessionId) };
  }
}

/**
 * The pairing links and signed-in clients, live: one read for the first paint (and its error), then the event stream,
 * whose snapshot replaces the list on every (re)connect. `apply` changes the list at once after this page's own action.
 */
export function useAccess(on = true) {
  const [view, setView] = useState<AccessView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!on) return;
    let live = true;
    setError(null);
    send<AccessView>("/api/auth/access").then(
      (v) => live && setView((had) => had ?? v),
      (e: Error) => live && setError(e.message),
    );
    if (typeof EventSource === "undefined") return () => void (live = false);
    const source = new EventSource("/api/auth/access/events", { withCredentials: true });
    for (const type of EVENTS) {
      source.addEventListener(type, (e) => {
        try {
          // each event's data is { version, revision, type, payload }
          const { payload } = JSON.parse((e as MessageEvent<string>).data) as { payload: unknown };
          setView((v) => applyAccessEvent(v, type, payload));
          setError(null);
        } catch {
          // a line this page can't read: the next snapshot puts the list right
        }
      });
    }
    return () => {
      live = false;
      source.close();
    };
  }, [on, n]);
  const apply = useCallback((type: AccessEvent, data: unknown) => setView((v) => applyAccessEvent(v, type, data)), []);
  return { view, error, apply, retry: useCallback(() => setN((x) => x + 1), []) };
}

/** "Expires in 4m 30s", counted down each second. */
export function expiresIn(at: When, now: number): string {
  const s = Math.floor((ms(at) - now) / 1000);
  if (s <= 0) return "Expired";
  if (s < 5) return "Expires in a moment";
  if (s < 60) return `Expires in ${s}s`;
  const m = Math.floor(s / 60);
  if (s < 3600) return `Expires in ${m}m${s % 60 ? ` ${s % 60}s` : ""}`;
  const h = Math.floor(s / 3600);
  if (s < 86_400) return `Expires in ${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  return `Expires in ${Math.floor(s / 86_400)}d`;
}

/** "3 min", how long a client has been connected. */
export function elapsed(since: When, now: number): string {
  const m = Math.floor((now - ms(since)) / 60_000);
  if (m < 1) return "less than a minute";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1 day" : `${d} days`;
}

const stamp = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
export const atTime = (t: When): string => (Number.isNaN(ms(t)) ? String(t) : stamp.format(ms(t)));

/** A session's connection line: "Connected for 3 min", "Last connected at …" or "Not connected yet." */
export function connectionLine(s: ClientSession, now: number): string {
  if (s.current || s.connected) return s.lastConnectedAt != null ? `Connected for ${elapsed(s.lastConnectedAt, now)}` : "Connected";
  return s.lastConnectedAt != null ? `Last connected at ${atTime(s.lastConnectedAt)}` : "Not connected yet.";
}

export const accessName = (scopes: AccessScope[]) => (scopes.includes("write") ? "Standard" : "Read only");

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A pairing address's name in the endpoint list: the network it is on, else its host. */
export const endpointName = (kind: string, url: string): string => (kind === "lan" ? "Local network" : kind === "tailnet" ? "VPN" : hostOf(url));
