import { Hono } from "hono";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "./lib/env";
import { cloneDemoReview } from "./review";
import { INVITE_TOKEN_RE, type InviteInfo } from "../contracts/workspaces";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import { acceptInvite, ensureWorkspace, inviteByToken, memberIn, workspaceOf } from "./lib/workspaces";
import {
  DEMO_USER,
  GUEST_USER,
  LOCAL_USER,
  type SessionUser,
  type KeyLevel,
  type Tool,
  type UserRecord,
  bumpUsage,
  createUser,
  findUser,
  isDemoName,
  isGuestName,
  apiKeysOf,
  dropApiKey,
  newApiKey,
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
const GUEST_MAX_AGE = 7 * 24 * 3600; // guests are a try-out, keep it short
const DEMO_MAX_AGE = 24 * 3600; // as long as their copy of the demo's Review lasts (retention.ts)

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
  // built-in guest and demo identities — cookie signed over a constant
  if (isGuestName(username)) {
    return signedBy(username, "guest", m[2]) ? { ...GUEST_USER, username } : null;
  }
  if (isDemoName(username)) {
    const demo = findUser(DEMO_USER);
    return demo && signedBy(username, "demo", m[2]) ? demoSession(demo, username) : null;
  }
  const user = findUser(username);
  if (!user || !signedBy(user.username, user.hash, m[2])) return null;
  return sessionOf(user);
}

export const sessionOf = (user: UserRecord): SessionUser => ({
  username: user.username,
  role: user.role,
  cloud: user.cloud,
  off: user.role === "admin" ? [] : user.off,
});

/** A demo visitor: the demo account read-only (boot.ts), never an admin. Its apps are fixed. */
const DEMO_OFF: Tool[] = ["notes", "guides"];
const demoSession = (demo: UserRecord, visitor: string): SessionUser => ({
  ...sessionOf(demo),
  role: "user",
  off: DEMO_OFF,
  demo: visitor,
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
  username: u.role === "guest" ? GUEST_USER.username : u.username,
  role: u.role,
  cloud: u.cloud || u.role === "admin",
  off: u.off,
  demo: !!u.demo,
});

/** Login count for real accounts — lets the client spot a first login. */
const withLogins = (u: SessionUser) => ({
  ...toPublic(u),
  logins: u.demo ? null : (findUser(u.username)?.usage.logins ?? null),
});

authApp.get("/check", (c) => {
  const user = getSessionUser(c.req.header("cookie"));
  return c.json({
    required: !!env.appSecret,
    authed: !!user,
    user: user ? withLogins(user) : null,
    demo: !!env.appSecret && !!findUser(DEMO_USER), // the login screen's "See the demo"
    signup: signupOn(), // the login screen's "Create account"
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
const NO_PASSWORD_YET = "Set a password on the Mac first: Mac settings → Access from other devices";

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

/** The account signed in on this browser, if it is a real one (not a guest or a demo visitor). */
const signedInAccount = (cookie: string | undefined) => {
  const u = getSessionUser(cookie);
  return u && u.role !== "guest" && !u.demo && !isDemoName(u.username) ? u : null;
};

/**
 * Invite links, /join/<token> (contracts/workspaces.ts): public, the token is the key. GET says which workspace;
 * POST joins as the account signed in here, or makes a new account (username + password) and signs it in.
 */
authApp.get("/invite/:token", (c) => {
  const token = c.req.param("token");
  const found = INVITE_TOKEN_RE.test(token) ? inviteByToken(token) : null;
  if (!found) return c.json({ error: "This invite link doesn't work any more" }, 404);
  const me = signedInAccount(c.req.header("cookie"));
  const info: InviteInfo = {
    workspace: found.workspace.name,
    invitedBy: found.invite.createdBy,
    expired: found.invite.expiresAt <= Date.now(),
    signedInAs: me?.username ?? null,
    member: !!me && !!memberIn(found.workspace, me.username),
  };
  return c.json(info);
});

/**
 * The caller's address: with TRUST_PROXY=1 (a proxy in front, the Docker kit's Caddy) the last X-Forwarded-For entry,
 * the one that proxy added; else the socket's, since without a proxy the caller writes the header itself.
 */
function clientIp(c: Context): string {
  const xff = /^(1|true)$/i.test(process.env.TRUST_PROXY ?? "") ? c.req.header("x-forwarded-for") : undefined;
  if (xff) return xff.split(",").pop()!.trim();
  try {
    return getConnInfo(c).remote.address ?? "";
  } catch {
    return ""; // no socket (tests)
  }
}

// ponytail: in-process, per IP per hour, forgotten on restart; a shared store if the app ever runs as several processes
const SIGNUPS_PER_HOUR = 5;
let signupHour = 0;
const signupTries = new Map<string, number>();
/** A new account from this address: false past 5 an hour (sign-up and invite links alike, failed tries included). */
function newAccountAllowed(c: Context): boolean {
  const hour = Math.floor(Date.now() / 3600_000);
  if (hour !== signupHour) {
    signupHour = hour;
    signupTries.clear();
  }
  const ip = clientIp(c);
  const tries = (signupTries.get(ip) ?? 0) + 1;
  signupTries.set(ip, tries);
  return tries <= SIGNUPS_PER_HOUR;
}
const TOO_MANY = "Too many new accounts from here. Try again in an hour";

authApp.post("/invite/:token", async (c) => {
  const token = c.req.param("token");
  const found = INVITE_TOKEN_RE.test(token) ? inviteByToken(token) : null;
  if (!found) return c.json({ error: "This invite link doesn't work any more" }, 404);
  const me = signedInAccount(c.req.header("cookie"));
  let user: UserRecord | null = me ? findUser(me.username) : null;
  if (!user) {
    const b = await c.req.json<{ username?: unknown; password?: unknown }>().catch(() => ({}) as { username?: unknown; password?: unknown });
    const username = typeof b.username === "string" ? b.username.trim().toLowerCase() : "";
    const password = typeof b.password === "string" ? b.password : "";
    if (found.invite.expiresAt <= Date.now()) return c.json({ error: "This invite link has expired: ask for a new one" }, 410);
    // any account owns a free workspace and can mint invite links: the same limit as sign-up
    if (!newAccountAllowed(c)) return c.json({ error: TOO_MANY }, 429);
    try {
      // a team's new member keeps files as long as the team does (retention.ts KEEP_DAYS)
      user = createUser(username, password, { role: found.workspace.plan === "team" ? "team" : "user" });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
    setLoginCookie(c, user);
    bumpUsage(user.username, { logins: 1 });
  }
  try {
    acceptInvite(token, user.username);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 410);
  }
  return c.json({ ok: true, username: user.username });
});

/** Open sign-up (ALLOW_SIGNUP=1): only on a server with accounts; read at use so a change needs no code. */
const signupOn = () => !!env.appSecret && /^(1|true)$/i.test(process.env.ALLOW_SIGNUP ?? "");



/**
 * "Create account" (ALLOW_SIGNUP): username + password with the same rules as an invite link, a free workspace of
 * its own, signed in. Every try counts toward the limit, failed ones too, so it can't be used to probe names.
 */
authApp.post("/signup", async (c) => {
  if (!signupOn()) return c.json({ error: "Sign-up is off on this server: ask its admin for an invite link" }, 404);
  if (!newAccountAllowed(c)) return c.json({ error: TOO_MANY }, 429);
  const b = await c.req.json<{ username?: unknown; password?: unknown }>().catch(() => ({}) as { username?: unknown; password?: unknown });
  const username = typeof b.username === "string" ? b.username.trim().toLowerCase() : "";
  const password = typeof b.password === "string" ? b.password : "";
  // load the workspaces before the account exists: a first load folds every account into the admin's team
  workspaceOf(username);
  let user: UserRecord;
  try {
    user = createUser(username, password, { role: "user" });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
  ensureWorkspace(user.username);
  bumpUsage(user.username, { logins: 1 });
  setLoginCookie(c, user);
  return c.json({ ok: true, user: withLogins(sessionOf(user)) });
});

/* "Try as guest": a capped try-out session with its own name (guest.ts) */
authApp.post("/guest", (c) => {
  if (!env.appSecret) return c.json({ ok: true, user: toPublic(LOCAL_USER) });
  const secure = secureAttr(c);
  const name = `guest-${randomBytes(6).toString("hex")}`;
  c.header(
    "Set-Cookie",
    `${COOKIE}=${cookieValue(name, "guest")}; HttpOnly; Path=/; Max-Age=${GUEST_MAX_AGE}; SameSite=Lax${secure}${domainAttr()}`,
  );
  return c.json({ ok: true, user: toPublic(GUEST_USER) });
});

// ponytail: one global counter, 60 new demo visitors an hour (each gets a copy of the
// demo's Review, and Review lists read every video); per-IP if real visitors hit it
const DEMO_PER_HOUR = 60;
let demoHour = 0;
let demoVisitors = 0;

/* "See the demo": the demo account to look around, and a copy of its Review of their own */
authApp.post("/demo", async (c) => {
  const demo = env.appSecret ? findUser(DEMO_USER) : null;
  if (!demo) return c.json({ error: "There's no demo to see right now" }, 404);
  const hour = Math.floor(Date.now() / 3600_000);
  if (hour !== demoHour) [demoHour, demoVisitors] = [hour, 0];
  if (++demoVisitors > DEMO_PER_HOUR) {
    return c.json({ error: "The demo is busy right now. Try again in a few minutes, or try it as a guest" }, 429);
  }
  const secure = secureAttr(c);
  const name = `demo-${randomBytes(6).toString("hex")}`;
  await cloneDemoReview(name);
  c.header(
    "Set-Cookie",
    `${COOKIE}=${cookieValue(name, "demo")}; HttpOnly; Path=/; Max-Age=${DEMO_MAX_AGE}; SameSite=Lax${secure}${domainAttr()}`,
  );
  return c.json({ ok: true, user: withLogins(demoSession(demo, name)) });
});

/** A new AI access key for this account (body `{ level: "full" }` for the Full key); the old one of that level stops working. */
/** This account's AI access keys: which are on, when each was made and last used, its last 4 characters. */
authApp.get("/api-key", (c) => {
  const session = getSessionUser(c.req.header("cookie"));
  const user = session && !session.demo && findUser(session.username);
  if (!user) return c.json({ error: "Sign in with an account first" }, 401);
  return c.json(apiKeysOf(user));
});

/** Turns one key off (?level=full|review). */
authApp.delete("/api-key", (c) => {
  const session = getSessionUser(c.req.header("cookie"));
  const user = session && !session.demo && findUser(session.username);
  if (!user) return c.json({ error: "Sign in with an account first" }, 401);
  dropApiKey(user, c.req.query("level") === "full" ? "full" : "review");
  return c.json(apiKeysOf(user));
});

authApp.post("/api-key", async (c) => {
  const session = getSessionUser(c.req.header("cookie"));
  const user = session && !session.demo && findUser(session.username);
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
