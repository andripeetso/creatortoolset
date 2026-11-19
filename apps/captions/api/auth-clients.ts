import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { clientAddress, getSessionUser, sessionOf } from "./auth";
import { endpoints } from "./descriptor";
import { tunnelHostname } from "./connect/state";
import { env, hostedMode } from "./lib/env";
import { onLeave } from "./lib/sync";
import { spendJti, verifyDpop } from "./lib/dpop";
import { ticketCaller } from "./media-ticket";
import {
  ACCESS_TOKEN_TYPE,
  ACCOUNT_TICKET_TOKEN_TYPE,
  BOOTSTRAP_TOKEN_TYPE,
  SCOPES,
  STANDARD,
  TOKEN_EXCHANGE_GRANT,
  accessRevision,
  accessSnapshot,
  createGrant,
  holdLine,
  issueSession,
  listedSession,
  onAccessChange,
  parseScopes,
  redeemGrant,
  resolveToken,
  revokeLink,
  revokeOthers,
  revokeSession,
  sessionView,
  touchSession,
  type AccessEvent,
  type AccessTokenResult,
  type ClientMetadata,
  type DeviceType,
  type PairingLinkUrl,
  type Scope,
  type SessionErrorCode,
  type SessionRow,
  type SessionState,
  type TokenError,
} from "./lib/clients";
import { LOCAL_USER, findUser, type SessionUser } from "./users";
import { accountTicketUser, originOf } from "./sign-in";

/**
 * Phones and other apps signed in to this server with a client session (api/connect/contract.md): pairing links, the
 * token exchange, the list of who has access and revoking it. No computer password is involved anywhere here.
 */

// ---- who is asking ----------------------------------------------------------------------------------------------------

export type Caller =
  | { kind: "token"; user: SessionUser; row: SessionRow }
  | { kind: "cookie"; user: SessionUser }
  | { kind: "none" }
  | { kind: "error"; code: SessionErrorCode };

/** The request URL as the caller addressed it: https when a proxy in front said so (a tunnel, a TLS proxy). */
export const requestUrl = (c: Context): string => {
  const u = new URL(c.req.url);
  if (c.req.header("x-forwarded-proto")?.split(",")[0].trim() === "https") u.protocol = "https:";
  return u.toString();
};

/** A client session's token, when the request carries one (never an API key or a computer's token). */
const tokenOf = (c: Context): { scheme: "Bearer" | "DPoP"; token: string } | null => {
  const m = /^(Bearer|DPoP) (cts_\S+)$/i.exec(c.req.header("authorization") ?? "");
  return m ? { scheme: m[1].toLowerCase() === "dpop" ? "DPoP" : "Bearer", token: m[2] } : null;
};

/** Token first; a request that carries one is answered by it alone, never by the cookie beside it. */
export function callerOf(c: Context): Caller {
  const t = tokenOf(c);
  if (!t) {
    // a media ticket stands for its session on its own path (media-ticket.ts), before the cookie
    const ticket = ticketCaller(c);
    if (ticket) return ticket;
    const user = getSessionUser(c.req.header("cookie"));
    return user ? { kind: "cookie", user } : { kind: "none" };
  }
  const r = resolveToken(t.token);
  if (!r.ok) return { kind: "error", code: r.code };
  const row = r.row;
  if (row.method === "dpop-access-token" || t.scheme === "DPoP") {
    if (row.method !== "dpop-access-token" || t.scheme !== "DPoP") return { kind: "error", code: "INVALID_DPOP" };
    const v = verifyDpop({ proof: c.req.header("dpop"), method: c.req.method, url: requestUrl(c), expectedJkt: row.jkt, accessToken: t.token });
    if (!v.ok) return { kind: "error", code: v.code === "busy" ? "BUSY" : "INVALID_DPOP" };
  }
  const record = env.appSecret ? findUser(row.subject) : null;
  const user = env.appSecret ? (record ? sessionOf(record) : null) : LOCAL_USER;
  if (!user) return { kind: "error", code: "INVALID_TOKEN" };
  touchSession(row);
  return { kind: "token", user, row };
}

const SESSION_WORDS: Record<SessionErrorCode, string> = {
  INVALID_TOKEN: "This computer doesn't know this device any more. Pair it again.",
  SESSION_EXPIRED: "This device's sign-in to the computer ran out. Pair it again.",
  SESSION_REVOKED: "This device was signed out on the computer. Pair it again.",
  INVALID_DPOP: "This device's signature didn't match. Try again.",
  BUSY: "This computer is busy. Try again in a minute.",
};

export function sessionRefused(c: Context, code: SessionErrorCode) {
  c.header("Cache-Control", "no-store");
  // this device's key spent its share of proofs: wait, nothing is wrong with the session
  if (code === "BUSY") {
    c.header("Retry-After", "60");
    return c.json({ error: SESSION_WORDS.BUSY, code }, 503);
  }
  const scheme = /^DPoP /i.test(c.req.header("authorization") ?? "") ? "DPoP" : "Bearer";
  c.header("WWW-Authenticate", `${scheme} error="${code === "INVALID_DPOP" ? "invalid_dpop_proof" : "invalid_token"}"`);
  return c.json({ error: SESSION_WORDS[code], code }, 401);
}

/** The scope a request on /api needs. */
export function scopeFor(method: string, path: string): Scope {
  if (/^\/api\/(?:connect|auth\/(?:pairing-links|access|clients))(?:\/|$)/.test(path)) return "access";
  return method === "GET" || method === "HEAD" ? "read" : "write";
}

export function scopeRefused(c: Context, need: Scope) {
  const error = need === "access" ? "This device can't manage who has access." : "This device can look but not change things.";
  return c.json({ error, code: "SCOPE", requiredScope: need }, 403);
}

const scopesOf = (k: Caller): readonly Scope[] => (k.kind === "token" ? k.row.scopes : k.kind === "cookie" ? SCOPES : []);

/** An admin sees and revokes every account's links and sessions on its own server; anyone else only their own. */
const mayFor = (user: SessionUser) => (subject: string) => subject === user.username || (!hostedMode() && user.role === "admin");

type Signed = { user: SessionUser; scopes: readonly Scope[]; sessionId?: string; expiresAt?: number };
/** The caller of an access route: signed in and holding `access`, or the answer to send instead. */
function accessCaller(c: Context): Signed | Response {
  const k = callerOf(c);
  if (k.kind === "error") return sessionRefused(c, k.code);
  if (k.kind === "none") return c.json({ error: "Sign in first" }, 401);
  if (!scopesOf(k).includes("access")) return scopeRefused(c, "access");
  return { user: k.user, scopes: scopesOf(k), ...(k.kind === "token" ? { sessionId: k.row.id, expiresAt: k.row.expiresAt } : {}) };
}

// ---- /api/auth/* ----------------------------------------------------------------------------------------------------

export const authClientsApp = new Hono();

/** The addresses a phone can open this server on, the public one first. Never loopback. */
async function pairingUrls(c: Context, credential: string): Promise<PairingLinkUrl[]> {
  const out: PairingLinkUrl[] = [];
  const add = (kind: PairingLinkUrl["kind"], origin: string) => {
    const url = `${origin.replace(/\/$/, "")}/#token=${credential}`;
    if (!out.some((u) => u.url === url)) out.push({ kind, url });
  };
  const tunnel = tunnelHostname();
  if (tunnel) add("public", `https://${tunnel}`);
  else if (hostedMode() && process.env.PUBLIC_ORIGIN) add("public", process.env.PUBLIC_ORIGIN);
  else {
    const here = new URL(requestUrl(c));
    const h = here.hostname.replace(/^\[|\]$/g, "");
    const local = /^(localhost|127\.|::1$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|f[cd]|fe[89ab])/i.test(h) || h.endsWith(".local");
    if (!local) add("public", here.origin);
  }
  for (const e of await endpoints(process.env.PORT || "3000")) add(e.kind, e.httpBaseUrl);
  return out;
}

authClientsApp.post("/pairing-links", async (c) => {
  const who = accessCaller(c);
  if (who instanceof Response) return who;
  const b = ((await c.req.json().catch(() => null)) ?? {}) as { label?: unknown; scopes?: unknown; deviceType?: unknown };
  const scopes = b.scopes === undefined ? [...STANDARD] : parseScopes(b.scopes);
  if (!scopes || scopes.length === 0) return c.json({ error: "Unknown scope" }, 400);
  // a link can hand on only what its maker holds
  const missing = scopes.find((s) => !who.scopes.includes(s));
  if (missing) return scopeRefused(c, missing);
  if (b.deviceType !== undefined && !DEVICE_TYPES.includes(b.deviceType as DeviceType)) return c.json({ error: "Unknown device type" }, 400);
  const deviceType = (b.deviceType as DeviceType | undefined) ?? "unknown";
  const label = typeof b.label === "string" ? b.label.trim().slice(0, 80) : "";
  const { link, credential } = createGrant({ kind: "pairing", subject: who.user.username, scopes, deviceType, ...(label ? { label } : {}) });
  c.header("Cache-Control", "no-store");
  return c.json({ ...link, credential, urls: await pairingUrls(c, credential) });
});

authClientsApp.get("/access", (c) => {
  const who = accessCaller(c);
  if (who instanceof Response) return who;
  c.header("Cache-Control", "no-store");
  return c.json(accessSnapshot(mayFor(who.user), who.sessionId));
});

authClientsApp.get("/access/events", (c) => {
  const who = accessCaller(c);
  if (who instanceof Response) return who;
  const may = mayFor(who.user);
  c.header("Cache-Control", "no-store");
  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (stream) => {
    const send = (e: AccessEvent) => void stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
    send({ version: 1, revision: accessRevision(), type: "snapshot", payload: accessSnapshot(may, who.sessionId) });
    await new Promise<void>((done) => {
      const off = onAccessChange((e, revision) => {
        const base = { version: 1 as const, revision };
        if (e.type === "pairingLinkUpserted" && may(e.link.subject)) send({ ...base, type: e.type, payload: e.link });
        else if (e.type === "pairingLinkRemoved" && may(e.subject)) send({ ...base, type: e.type, payload: { id: e.id } });
        else if (e.type === "clientRemoved" && may(e.subject)) send({ ...base, type: e.type, payload: { sessionId: e.sessionId } });
        else if (e.type === "clientUpserted" && may(e.row.subject)) {
          if (listedSession(e.row)) send({ ...base, type: e.type, payload: sessionView(e.row, who.sessionId) });
          else send({ ...base, type: "clientRemoved", payload: { sessionId: e.row.id } });
        }
      });
      const ping = setInterval(() => void stream.writeSSE({ event: "ping", data: "" }), 15_000);
      // a session's line ends when the session does (capped at the longest wait a timer takes; the device reconnects)
      const expiry = who.expiresAt === undefined ? undefined : setTimeout(() => void stream.close().finally(end), Math.min(Math.max(0, who.expiresAt - Date.now()), 2 ** 31 - 1));
      const end = () => {
        clearInterval(ping);
        clearTimeout(expiry);
        off();
        release();
        leaveOff();
        done();
      };
      // revoking the session that watches ends this stream at once
      const release = who.sessionId ? holdLine(who.sessionId, () => void stream.close().finally(end)) : () => {};
      const leaveOff = onLeave(() => void stream.writeSSE({ event: "bye", data: "", retry: 250 }).finally(end));
      stream.onAbort(end);
    });
  });
});

const idOf = async (c: Context, key: "id" | "sessionId") => {
  const v = ((await c.req.json().catch(() => null)) as Record<string, unknown> | null)?.[key];
  return typeof v === "string" ? v : "";
};

authClientsApp.post("/pairing-links/revoke", async (c) => {
  const who = accessCaller(c);
  if (who instanceof Response) return who;
  return revokeLink(await idOf(c, "id"), mayFor(who.user)) ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
});

authClientsApp.post("/clients/revoke", async (c) => {
  const who = accessCaller(c);
  if (who instanceof Response) return who;
  return revokeSession(await idOf(c, "sessionId"), mayFor(who.user)) ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
});

authClientsApp.post("/clients/revoke-others", (c) => {
  const who = accessCaller(c);
  if (who instanceof Response) return who;
  return c.json({ ok: true, revoked: revokeOthers(who.sessionId, mayFor(who.user)) });
});

authClientsApp.get("/session", (c) => {
  const k = callerOf(c);
  if (k.kind === "error") return sessionRefused(c, k.code);
  c.header("Cache-Control", "no-store");
  const user = k.kind === "none" ? null : k.user;
  return c.json({
    authenticated: k.kind !== "none",
    scopes: [...scopesOf(k)],
    method: k.kind === "token" ? k.row.method : k.kind === "cookie" ? "browser-cookie" : null,
    expiresAt: k.kind === "token" ? new Date(k.row.expiresAt).toISOString() : null,
    user: user ? { username: user.username, name: user.name ?? user.username, role: user.role } : null,
  } satisfies SessionState);
});

// ---- POST /oauth/token ------------------------------------------------------------------------------------------------

const TOKEN_WORDS: Record<TokenError, string> = {
  unsupported_grant_type: "Only token exchange is supported.",
  invalid_request: "The request is missing a field or has a wrong one.",
  invalid_dpop_proof: "This device's signature didn't match. Try again.",
  invalid_grant: "That code is used or expired. Make a new one on the computer.",
  invalid_scope: "That code doesn't allow what this device asked for.",
};
const DEVICE_TYPES: readonly DeviceType[] = ["desktop", "mobile", "tablet", "bot", "unknown"];

export const oauthTokenApp = new Hono();

oauthTokenApp.post("/oauth/token", async (c) => {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  const refuse = (error: TokenError) => c.json({ error, error_description: TOKEN_WORDS[error] }, 400);
  if (!/^application\/x-www-form-urlencoded\b/i.test(c.req.header("content-type") ?? "")) return refuse("invalid_request");
  // a small form, never an upload: read as text (capped by the server's body limit)
  const form = new URLSearchParams(await c.req.text().catch(() => ""));
  const field = (k: string) => form.get(k)?.trim().slice(0, 200) || undefined;
  if (field("grant_type") !== TOKEN_EXCHANGE_GRANT) return refuse("unsupported_grant_type");
  const credential = field("subject_token");
  const type = field("subject_token_type");
  if (!credential || (type !== BOOTSTRAP_TOKEN_TYPE && type !== ACCOUNT_TICKET_TOKEN_TYPE) || field("requested_token_type") !== ACCESS_TOKEN_TYPE) return refuse("invalid_request");
  // checked for shape only: the session's kind is the one its link was made for, whatever the device says
  const claimed = (field("client_device_type") ?? "unknown") as DeviceType;
  if (!DEVICE_TYPES.includes(claimed)) return refuse("invalid_request");
  const scopeField = field("scope");
  const requested = scopeField === undefined ? undefined : parseScopes(scopeField.split(/\s+/));
  if (requested === null) return refuse("invalid_scope");

  // a proof that fails is an error, never a fall back to a Bearer token; checked before the code is looked at, its
  // jti spent only once the code was: anyone may post a proof here, so a proof without a good code keeps nothing
  let checked: { jkt: string; jti: string } | undefined;
  const proof = c.req.header("dpop");
  if (proof !== undefined) {
    const v = verifyDpop({ proof, method: "POST", url: requestUrl(c), spend: false });
    if (!v.ok) return refuse("invalid_dpop_proof");
    checked = v;
  }
  const jkt = checked?.jkt;
  let r: { ok: true; grant: { kind: string; subject: string; label?: string; deviceType?: DeviceType }; scopes: Scope[] } | { ok: false; error: TokenError };
  if (type === ACCOUNT_TICKET_TOKEN_TYPE) {
    // a phone signed in to its account (sign-in.ts accountTicketUser): bound to its key, Standard, as an account connect
    const scopes = requested ? STANDARD.filter((s) => requested.includes(s)) : [...STANDARD];
    if (!scopes.length) return refuse("invalid_scope");
    const verifier = field("code_verifier");
    if (!jkt || !verifier) return refuse("invalid_grant");
    const user = await accountTicketUser({ ticket: credential, verifier, jkt, host: new URL(originOf(c)).host });
    r = user ? { ok: true, grant: { kind: "account", subject: user.username, deviceType: claimed }, scopes } : { ok: false, error: "invalid_grant" };
  } else {
    r = redeemGrant(credential, { jkt, ...(requested ? { requested } : {}) });
  }
  if (!r.ok) return refuse(r.error);
  const spent = checked ? spendJti(checked.jkt, checked.jti) : "ok";
  if (spent === "busy") {
    c.header("Retry-After", "60");
    return c.json({ error: "temporarily_unavailable", error_description: "Too many sign-ins at once. Try again in a minute." }, 503);
  }
  if (spent === "replay") return refuse("invalid_dpop_proof");
  if (env.appSecret && !findUser(r.grant.subject)) return refuse("invalid_grant");

  const label = (r.grant.kind === "pairing" && r.grant.label) || field("client_label");
  const client: ClientMetadata = {
    ...(label ? { label: label.slice(0, 80) } : {}),
    deviceType: r.grant.deviceType ?? "unknown",
    ...(field("client_os") ? { os: field("client_os") } : {}),
    ...(field("client_model") ? { model: field("client_model") } : {}),
    ...(field("app_version") ? { appVersion: field("app_version") } : {}),
    ipAddress: clientAddress(c),
    ...(c.req.header("user-agent") ? { userAgent: c.req.header("user-agent")!.slice(0, 200) } : {}),
  };
  const { token, row } = issueSession({ subject: r.grant.subject, scopes: r.scopes, ...(jkt ? { jkt } : {}), client });
  return c.json({
    access_token: token,
    issued_token_type: ACCESS_TOKEN_TYPE,
    token_type: jkt ? "DPoP" : "Bearer",
    expires_in: Math.floor((row.expiresAt - Date.now()) / 1000),
    scope: row.scopes.join(" "),
  } satisfies AccessTokenResult);
});
