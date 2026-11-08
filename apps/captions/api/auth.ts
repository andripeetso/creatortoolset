import { Hono } from "hono";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "./lib/env";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import {
  LOCAL_USER,
  type SessionUser,
  type KeyLevel,
  type UserRecord,
  bumpUsage,
  findUser,
  apiKeysOf,
  dropApiKey,
  newApiKey,
  setDisplayName,
  setPassword,
  userForApiKey,
  verifyPassword,
} from "./users";

/**
 * Account login for public hosting. When APP_SECRET is set, every /api
 * route requires a per-user auth cookie; the client shows a login
 * screen until it succeeds. When APP_SECRET is unset (local use),
 * everything stays open and requests run as a local admin.
 *
 * Cookie: base64url(username).hmac(username:passwordHash) — signing
 * over the password hash invalidates cookies on password reset.
 */
export const authApp = new Hono();

/** Hono context vars set by the auth middleware in boot.ts. */
export type AuthVars = { user: SessionUser };

const COOKIE = "cap_auth";
const MAX_AGE = 180 * 24 * 3600; // ~6 months

// One login across subdomains: COOKIE_DOMAIN (e.g. .example.com) sets the cookie on the parent domain so every
// subdomain sees the same session. Unset = a cookie for the exact host only.
const domainAttr = () => (env.cookieDomain ? `; Domain=${env.cookieDomain}` : "");

function sign(username: string, hash: string): string {
  return createHmac("sha256", env.appSecret)
    .update(`${username}:${hash}`)
    .digest("hex");
}

function cookieValue(username: string, hash: string): string {
  return `${Buffer.from(username).toString("base64url")}.${sign(username, hash)}`;
}

const signedBy = (username: string, hash: string, hex: string) => {
  const expected = Buffer.from(sign(username, hash), "hex");
  const got = Buffer.from(hex, "hex");
  return got.length === expected.length && timingSafeEqual(got, expected);
};

export function getSessionUser(
  cookieHeader: string | undefined,
): SessionUser | null {
  if (!env.appSecret) return LOCAL_USER;
  const m = new RegExp(
    `(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]+)\\.([a-f0-9]{64})`,
  ).exec(cookieHeader ?? "");
  if (!m) return null;
  let username = "";
  try {
    username = Buffer.from(m[1], "base64url").toString();
  } catch {
    return null;
  }
  const user = findUser(username);
  if (!user || !signedBy(user.username, user.hash, m[2])) return null;
  return sessionOf(user);
}

export const sessionOf = (user: UserRecord): SessionUser => ({
  username: user.username,
  name: user.displayName || user.username,
  role: user.role,
  cloud: user.cloud,
  off: user.role === "admin" ? [] : user.off,
});

/**
 * The assistant's job tokens (api/assistant.ts): one per turn, `ctj_…`, in memory only, 30 min, revoked when its turn
 * ends. Accepted by boot.ts on /api/mcp alone; the tools it reaches run as its account through `innerCall`. Never
 * a Full key: rotating that would break the account's claude.ai connector.
 */
export const JOB_TOKEN_MS = 30 * 60_000;
const jobs = new Map<string, { username: string; turn: string; expires: number }>();

export function mintJobToken(username: string, turn: string): string {
  const now = Date.now();
  for (const [k, v] of jobs) if (v.expires <= now) jobs.delete(k);
  const token = `ctj_${randomBytes(24).toString("hex")}`;
  jobs.set(token, { username, turn, expires: now + JOB_TOKEN_MS });
  return token;
}

export const revokeJobToken = (token: string): void => {
  jobs.delete(token);
};

/** The turn a job token was made for (the assistant's reply id, or an automation's). */
export const jobTurn = (authorization: string | undefined): string | null =>
  jobs.get(/^Bearer (ctj_[a-f0-9]{48})$/.exec(authorization ?? "")?.[1] ?? "")?.turn ?? null;

export function jobTokenUser(authorization: string | undefined): SessionUser | null {
  const token = /^Bearer (ctj_[a-f0-9]{48})$/.exec(authorization ?? "")?.[1];
  const job = token ? jobs.get(token) : undefined;
  if (!token || !job) return null;
  if (job.expires <= Date.now()) {
    jobs.delete(token);
    return null;
  }
  const user = findUser(job.username);
  return user ? sessionOf(user) : null;
}

/** The account an in-process MCP tool call runs as (mcp.ts sets it around each call; boot.ts reads it). Outside a tool call it is empty. */
export const innerCall = new AsyncLocalStorage<SessionUser>();

/** `Authorization: Bearer ctk_…` from a script or AI, at one key level (boot.ts decides what each reaches). */
export function getApiKeyUser(authorization: string | undefined, level: KeyLevel = "review"): SessionUser | null {
  const key = /^Bearer (ctk_[a-f0-9]{48})$/.exec(authorization ?? "")?.[1];
  const user = key ? userForApiKey(key, level) : null;
  return user && sessionOf(user);
}

const toPublic = (u: SessionUser) => ({
  username: u.username,
  name: u.name ?? u.username,
  role: u.role,
  cloud: u.cloud || u.role === "admin",
  off: u.off,
});

/** Login count for real accounts — lets the client spot a first login. */
const withLogins = (u: SessionUser) => ({
  ...toPublic(u),
  logins: findUser(u.username)?.usage.logins ?? null,
});

authApp.get("/check", (c) => {
  const user = getSessionUser(c.req.header("cookie"));
  return c.json({
    required: !!env.appSecret,
    authed: !!user,
    user: user ? withLogins(user) : null,
  });
});

// tiny brute-force damper: consecutive failures per username buy a delay
const failures = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

authApp.post("/login", async (c) => {
  if (!env.appSecret) return c.json({ ok: true, user: toPublic(LOCAL_USER) });
  let username = "";
  let password = "";
  try {
    ({ username = "", password = "" } = await c.req.json<{
      username?: string;
      password?: string;
    }>());
  } catch {
    /* fall through to failed compare */
  }
  username = username.trim().toLowerCase();
  const user = username ? findUser(username) : null;
  if (!user || !password || !verifyPassword(user, password)) {
    const fails = (failures.get(username) ?? 0) + 1;
    failures.set(username, fails);
    await sleep(Math.min(fails * 250, 2000));
    return c.json({ error: "Wrong username or password" }, 401);
  }
  failures.delete(username);
  // after the password: a wrong guess from the LAN costs its delay and says nothing about the account
  if (password === env.appSecret && localOnly(c)) return c.json({ error: NO_PASSWORD_YET }, 403);
  bumpUsage(user.username, { logins: 1 });
  setLoginCookie(c, user);
  return c.json({
    ok: true,
    user: withLogins(sessionOf(user)),
  });
});

/**
 * The cookie's Secure flag: when the request came in over HTTPS (the URL, or X-Forwarded-Proto from a proxy in
 * front). A phone on plain http over the LAN would drop a Secure cookie; a forged header only costs its sender.
 */
export const secureAttr = (c: Context) => {
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0].trim() || new URL(c.req.url).protocol.replace(":", "");
  return proto.toLowerCase() === "https" ? "; Secure" : "";
};

const setLoginCookie = (c: Context, user: UserRecord) => {
  const secure = secureAttr(c);
  c.header(
    "Set-Cookie",
    `${COOKIE}=${cookieValue(user.username, user.hash)}; HttpOnly; Path=/; Max-Age=${MAX_AGE}; SameSite=Lax${secure}${domainAttr()}`,
  );
};

/**
 * A server on this Mac (CT_LOCAL=1) signs in from another device (a phone, the LAN) only once its owner chose a
 * password: until then the account's password is APP_SECRET, which only the Mac app knows, and that account signs in
 * from this Mac alone. The socket's address decides, never a header (a LAN client writes those itself).
 */
const isLoopback = (c: Context) => {
  let a = "";
  try {
    a = getConnInfo(c).remote.address ?? "";
  } catch {
    /* no socket (tests): not loopback */
  }
  return a === "::1" || /^(::ffff:)?127\./.test(a);
};
const localOnly = (c: Context) => process.env.CT_LOCAL === "1" && !isLoopback(c);
const remoteRefused = (c: Context, user: UserRecord) => localOnly(c) && !!env.appSecret && verifyPassword(user, env.appSecret);
const NO_PASSWORD_YET = "Set a password on the Mac first: the Mac app's This Mac → Access from other devices";

/**
 * One-time sign-in links, for pairing a phone later (no UI uses them yet). POST mints one for the account
 * signed in here; GET /api/auth/link/<code> signs that browser in and goes home. A code works once, within 60 s, and
 * dies with a password change. Kept in memory only and never logged.
 */
const LINK_TTL = 60_000;
const links = new Map<string, { username: string; hash: string; expiresAt: number }>();

authApp.post("/link", (c) => {
  const me = signedInAccount(c.req.header("cookie"));
  const user = me && findUser(me.username);
  if (!user) return c.json({ error: "Sign in with an account first" }, 401);
  const now = Date.now();
  for (const [k, v] of links) if (v.expiresAt <= now) links.delete(k);
  const code = randomBytes(32).toString("base64url");
  links.set(code, { username: user.username, hash: user.hash, expiresAt: now + LINK_TTL });
  return c.json({ path: `/api/auth/link/${code}`, expiresAt: now + LINK_TTL });
});

authApp.get("/link/:code", (c) => {
  const code = c.req.param("code");
  const link = links.get(code);
  links.delete(code); // single use, whatever happens next
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  const user = link && link.expiresAt > Date.now() ? findUser(link.username) : null;
  if (!user || user.hash !== link!.hash) return c.text("This sign-in link has expired or was used. Ask for a new one.", 410);
  if (remoteRefused(c, user)) return c.text(NO_PASSWORD_YET, 403);
  bumpUsage(user.username, { logins: 1 });
  setLoginCookie(c, user);
  return c.redirect("/", 302);
});

/**
 * A new password for the account signed in here ({ current, password }). The cookie is signed over the password
 * hash, so this session gets a fresh cookie at once; every other session is signed out.
 */
authApp.post("/password", async (c) => {
  const me = signedInAccount(c.req.header("cookie"));
  const user = me && findUser(me.username);
  if (!user) return c.json({ error: "Sign in with an account first" }, 401);
  const b = await c.req.json<{ current?: unknown; password?: unknown }>().catch(() => ({}) as { current?: unknown; password?: unknown });
  if (typeof b.current !== "string" || !verifyPassword(user, b.current)) return c.json({ error: "The current password is wrong" }, 403);
  try {
    setPassword(user, typeof b.password === "string" ? b.password : "");
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
  setLoginCookie(c, user);
  return c.json({ ok: true });
});

/** The account signed in on this browser. */
const signedInAccount = (cookie: string | undefined) => getSessionUser(cookie);

/** Settings → Account: the name the app calls you. The username underneath never changes: your files are filed under it. */
authApp.get("/account", (c) => {
  const me = signedInAccount(c.req.header("cookie"));
  const user = me && findUser(me.username);
  if (!user) return c.json({ error: "Sign in with an account first" }, 401);
  return c.json({ username: user.username, name: user.displayName ?? "" });
});

authApp.patch("/account", async (c) => {
  const me = signedInAccount(c.req.header("cookie"));
  const user = me && findUser(me.username);
  if (!user) return c.json({ error: "Sign in with an account first" }, 401);
  const b = (await c.req.json().catch(() => ({}))) as { name?: unknown };
  if (typeof b.name === "string") setDisplayName(user, b.name);
  return c.json({ ok: true, user: withLogins(sessionOf(user)) });
});

/** A new AI access key for this account (body `{ level: "full" }` for the Full key); the old one of that level stops working. */
/** This account's AI access keys: which are on, when each was made and last used, its last 4 characters. */
authApp.get("/api-key", (c) => {
  const session = getSessionUser(c.req.header("cookie"));
  const user = session && findUser(session.username);
  if (!user) return c.json({ error: "Sign in with an account first" }, 401);
  return c.json(apiKeysOf(user));
});

/** Turns one key off (?level=full|review). */
authApp.delete("/api-key", (c) => {
  const session = getSessionUser(c.req.header("cookie"));
  const user = session && findUser(session.username);
  if (!user) return c.json({ error: "Sign in with an account first" }, 401);
  dropApiKey(user, c.req.query("level") === "full" ? "full" : "review");
  return c.json(apiKeysOf(user));
});

authApp.post("/api-key", async (c) => {
  const session = getSessionUser(c.req.header("cookie"));
  const user = session && findUser(session.username);
  if (!user) return c.json({ error: "Sign in with an account first" }, 401);
  const body = (await c.req.json().catch(() => null)) as { level?: unknown } | null;
  return c.json({ key: newApiKey(user, body?.level === "full" ? "full" : "review") });
});

authApp.post("/logout", (c) => {
  const secure = secureAttr(c);
  c.header(
    "Set-Cookie",
    `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure}${domainAttr()}`,
  );
  return c.json({ ok: true });
});
