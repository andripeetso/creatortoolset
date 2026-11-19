import { createHash, randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { sessionOf } from "./auth";
import { callerOf, scopeFor, scopeRefused, sessionRefused, type Caller } from "./auth-clients";
import { env } from "./lib/env";
import type { SessionRow } from "./lib/clients";
import { LOCAL_USER, findUser, type SessionUser } from "./users";

/**
 * Media tickets (api/connect/contract.md → "Media tickets"): what a device session hands to the things that can't sign
 * each request themselves (a video player's range requests, a web view's page and its calls, an upload the phone's
 * background transfer service sends later). A ticket is short-lived, scoped to one path prefix and to reading (or to
 * writing under that prefix), and lives no longer than the session that asked for it: a revoked or expired session
 * takes its tickets with it. Kept in memory only, so a restart ends them (the phone asks again).
 */

export const TICKET_TTL_MS = 60 * 60_000;
/** The query parameter, and the cookie a web view carries it in. */
export const TICKET_PARAM = "ct_ticket";
const TICKET_RE = /^ctm_[A-Za-z0-9_-]{43}$/;

interface Ticket {
  row: SessionRow;
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

/** The live ticket this request carries (query or cookie) and its account, or null. */
function carried(c: Context, now: number): { t: Ticket; user: SessionUser } | null {
  const raw = c.req.query(TICKET_PARAM) ?? getCookie(c, TICKET_PARAM);
  if (!raw || !TICKET_RE.test(raw)) return null;
  const t = tickets.get(sha(raw));
  if (!t || t.expiresAt <= now || t.row.revokedAt || t.row.expiresAt <= now) return null;
  const record = env.appSecret ? findUser(t.row.subject) : null;
  const user = env.appSecret ? (record ? sessionOf(record) : null) : LOCAL_USER;
  return user ? { t, user } : null;
}

/** The session a ticket on this request stands for, as a token caller; null when there is none or it doesn't fit. */
export function ticketCaller(c: Context, now = Date.now()): Caller | null {
  const found = carried(c, now);
  if (!found) return null;
  const path = c.req.path;
  if (closed(path) || !under(path, found.t.prefix)) return null;
  if (!found.t.write && c.req.method !== "GET" && c.req.method !== "HEAD") return null;
  return { kind: "token", user: found.user, row: found.t.row };
}

/** Who a live ticket signs in as, whatever its path: `/api/auth/check` only, so a web view's page opens signed in. */
export const ticketUser = (c: Context, now = Date.now()): SessionUser | null => carried(c, now)?.user ?? null;

export const mediaTicketApp = new Hono();

/** `POST /api/auth/media-ticket {path, write?}` with the device's own signed request → `{ticket, path, write, expiresAt}`. */
mediaTicketApp.post("/media-ticket", async (c) => {
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
  const write = b.write === true;
  const need = write ? "write" : "read";
  if (!k.row.scopes.includes(need)) return scopeRefused(c, need);
  const now = Date.now();
  for (const [h, t] of tickets) if (t.expiresAt <= now) tickets.delete(h);
  const ticket = `ctm_${randomBytes(32).toString("base64url")}`;
  const expiresAt = Math.min(now + TICKET_TTL_MS, k.row.expiresAt);
  tickets.set(sha(ticket), { row: k.row, prefix, write, expiresAt });
  c.header("Cache-Control", "no-store");
  return c.json({ ticket, path: prefix, write, expiresAt: new Date(expiresAt).toISOString() });
});
