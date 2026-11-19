import { createHash, randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { sessionOf } from "./auth";
import { callerOf, scopeFor, scopeRefused, sessionRefused, type Caller } from "./auth-clients";
import { env } from "./lib/env";
import { sessionById, type SessionRow } from "./lib/clients";
import { LOCAL_USER, findUser, type SessionUser } from "./users";

/**
 * Media tickets (api/connect/contract.md → "Media tickets"): what a device session hands to the things that can't sign
 * each request themselves (a video player's range requests, a web view's page and its calls, an upload the phone's
 * background transfer service sends later). A ticket is short-lived, scoped to one path prefix and to reading (or to
 * writing under that prefix), and lives no longer than the session that asked for it: a revoked or expired session
 * takes its tickets with it. Kept in memory only, so a restart ends them (the phone asks again). Never read from the
 * URL: URLs end up in access logs.
 */

/** Holders ask again before it runs out (web view) or when it answers 401 (players, background upload steps). */
export const TICKET_TTL_MS = 5 * 60_000;
/**
 * What a ticket is for, minted at its own path segment so the DPoP proof of the mint covers it. A ticket works only for
 * its own use: `media` (players, pictures, web views) in the cookie, `upload` (background upload steps) in the header.
 */
export const TICKET_USES = ["media", "upload"] as const;
export type TicketUse = (typeof TICKET_USES)[number];
export const TICKET_COOKIE = "ct_ticket";
export const TICKET_HEADER = "X-CT-Ticket";
const TICKET_RE = /^ctm_[A-Za-z0-9_-]{43}$/;

interface Ticket {
  sessionId: string;
  use: TicketUse;
  prefix: string;
  write: boolean;
  expiresAt: number;
}
const tickets = new Map<string, Ticket>();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export const resetTicketsForTest = () => tickets.clear();

/** Under `prefix`: the path itself, or below it (never a sibling that only starts with the same letters). */
const under = (path: string, prefix: string) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);

/** Paths a ticket may never open: sign-in and access management stay with the session's own signed requests. */
const closed = (path: string) => /^\/api\/auth(?:\/|$)/.test(path) || scopeFor("GET", path) === "access";

/** The live ticket this request carries (header or cookie) and its account, or null. */
function carried(c: Context, now: number): { t: Ticket; row: SessionRow; user: SessionUser } | null {
  const header = c.req.header(TICKET_HEADER);
  const raw = header ?? getCookie(c, TICKET_COOKIE);
  if (!raw || !TICKET_RE.test(raw)) return null;
  const found = tickets.get(sha(raw));
  const t = found?.use === (header ? "upload" : "media") ? found : undefined;
  // the session as it is now (a revoke, an expiry, a password change all end it), never a copy kept at issue
  const row = t && t.expiresAt > now ? sessionById(t.sessionId) : undefined;
  if (!t || !row || row.revokedAt || row.expiresAt <= now) return null;
  const record = env.appSecret ? findUser(row.subject) : null;
  const user = env.appSecret ? (record ? sessionOf(record) : null) : LOCAL_USER;
  return user ? { t, row, user } : null;
}

/** The session a ticket on this request stands for, as a token caller; null when there is none or it doesn't fit. */
export function ticketCaller(c: Context, now = Date.now()): Caller | null {
  const found = carried(c, now);
  if (!found) return null;
  const path = c.req.path;
  if (closed(path) || !under(path, found.t.prefix)) return null;
  if (!found.t.write && c.req.method !== "GET" && c.req.method !== "HEAD") return null;
  return { kind: "token", user: found.user, row: found.row };
}

/** Who a live ticket signs in as, whatever its path: `/api/auth/check` only, so a web view's page opens signed in. */
export const ticketUser = (c: Context, now = Date.now()): SessionUser | null => carried(c, now)?.user ?? null;

export const mediaTicketApp = new Hono();

/** `POST /api/auth/media-ticket/:use {path, write?}` with the device's own signed request → `{ticket, use, path, write, expiresAt}`. */
mediaTicketApp.post("/media-ticket/:use", async (c) => {
  const use = c.req.param("use") as TicketUse;
  if (!TICKET_USES.includes(use)) return c.json({ error: "Not Found" }, 404);
  const k = callerOf(c);
  if (k.kind === "error") return sessionRefused(c, k.code);
  if (k.kind === "none") return c.json({ error: "Sign in first" }, 401);
  // a browser has its cookie for all of this; only a device session needs tickets
  if (k.kind !== "token") return c.json({ error: "Only a device's session asks for tickets" }, 400);
  const b = ((await c.req.json().catch(() => null)) ?? {}) as { path?: unknown; write?: unknown };
  const prefix = typeof b.path === "string" ? b.path : "";
  if (!prefix.startsWith("/api/") || prefix.length > 500 || prefix.includes("..") || /[?#]/.test(prefix) || closed(prefix)) {
    return c.json({ error: "Bad path" }, 400);
  }
  // an upload step always writes
  const write = use === "upload" || b.write === true;
  const need = write ? "write" : "read";
  if (!k.row.scopes.includes(need)) return scopeRefused(c, need);
  const now = Date.now();
  for (const [h, t] of tickets) if (t.expiresAt <= now) tickets.delete(h);
  const ticket = `ctm_${randomBytes(32).toString("base64url")}`;
  const expiresAt = Math.min(now + TICKET_TTL_MS, k.row.expiresAt);
  tickets.set(sha(ticket), { sessionId: k.row.id, use, prefix, write, expiresAt });
  c.header("Cache-Control", "no-store");
  return c.json({ ticket, use, path: prefix, write, expiresAt: new Date(expiresAt).toISOString() });
});
