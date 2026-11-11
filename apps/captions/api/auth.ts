import { Hono } from "hono";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { createSocket } from "node:dgram";
import { env, hostedMode } from "./lib/env";
import { viewAsTarget } from "./lib/view-as";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import {
  LOCAL_USER,
  type SessionUser,
  type KeyLevel,
  type UserRecord,
  type SignInProvider,
  bumpUsage,
  createUser,
  findByLogin,
  findUser,
  unlinkIdentity,
  pictureOf,
  aiKeysOf,
  apiKeysOf,
  dropAiKey,
  newAiKey,
  dropApiKey,
  newApiKey,
  setDisplayName,
  setPassword,
  SIGNIN_NAME,
  isSignInProvider,
  userForApiKey,
  verifyPassword,
} from "./users";
import { INVITE_TOKEN_RE, type InviteInfo } from "../contracts/workspaces";
import { acceptInvite, inviteByToken, memberIn, workspaceOf } from "./lib/workspaces";
import { parseRelayKey } from "./connect/keys";
import { consumeJti, connectState, tunnelHostname } from "./connect/state";
import { TicketError, verifyTicket } from "./connect/ticket";

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

/** A turn waiting for its person (an approval) keeps its token: JOB_TOKEN_MS from now. */
export const touchJobToken = (token: string): void => {
  const job = jobs.get(token);
  if (job) job.expires = Math.max(job.expires, Date.now() + JOB_TOKEN_MS);
};

/** The turn a job token was made for: the assistant's reply id (a scheduled run's reply too). */
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
  picture: findUser(u.username) ? pictureOf(findUser(u.username)!) : null,
  // an install without sign-in has one fixed session user: its saved display name comes from its account record
  ...(u.name ? {} : findUser(u.username)?.displayName ? { name: findUser(u.username)!.displayName } : {}),
});

// hosted: says whether this server is a hosted one (the web shows team, admin and join screens only then). While a
// platform admin is viewing as an account (view-as, admin.ts), `user` is that account and `viewedBy` the admin.
authApp.get("/check", (c) => {
  const session = getSessionUser(c.req.header("cookie"));
  const viewed = hostedMode() && session?.role === "admin" ? viewAsTarget(c.req.header("cookie")) : null;
  const user = viewed ? sessionOf(viewed) : session;
  return c.json({
    required: !!env.appSecret,
    authed: !!user,
    user: user ? withLogins(user) : null,
    hosted: hostedMode(),
    viewedBy: viewed && session ? session.username : null,
    // a team that signs in with Google / Apple, and this account has neither linked yet: link one before anything else
    mustLink: user ? (ruleFor(user.username)?.missing ?? null) : null,
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
  const user = username ? findByLogin(username) : null;
  if (!user || !password || !verifyPassword(user, password)) {
    const fails = (failures.get(username) ?? 0) + 1;
    failures.set(username, fails);
    await sleep(Math.min(fails * 250, 2000));
    return c.json({ error: "Wrong username or password" }, 401);
  }
  failures.delete(username);
  // after the password: a wrong guess from the LAN costs its delay and says nothing about the account
  if (password === env.appSecret && localOnly(c)) return c.json({ error: NO_PASSWORD_YET }, 403);
  // checked after the password too, so a wrong guess learns nothing about the team
  const rule = ruleFor(user.username);
  if (rule && !rule.missing) return c.json({ error: `Your team signs in with ${rule.allowed.map(providerLabel).join(" or ")}: use that button`, code: "SIGNIN_RULE" }, 403);
  bumpUsage(user.username, { logins: 1 });
  setLoginCookie(c, user);
  return c.json({
    ok: true,
    user: withLogins(sessionOf(user)),
  });
});

export const providerLabel = (p: SignInProvider) => SIGNIN_NAME[p];

/**
 * The team's sign-in rule for this account (Settings → Team, `Workspace.signInWith`): the providers it must sign in
 * with, and `missing` = it has none of them linked yet, so boot.ts lets it reach only /api/auth until it links one.
 */
export function ruleFor(username: string): { allowed: SignInProvider[]; missing: SignInProvider[] | null } | null {
  const allowed: SignInProvider[] = workspaceOf(username)?.signInWith ?? [];
  if (!allowed.length) return null;
  const linked = findUser(username)?.identities?.some((i) => allowed.includes(i.provider));
  return { allowed, missing: linked ? null : allowed };
}

/**
 * The cookie's Secure flag: when the request came in over HTTPS (the URL, or X-Forwarded-Proto from a proxy in
 * front). A phone on plain http over the LAN would drop a Secure cookie; a forged header only costs its sender.
 */
export const secureAttr = (c: Context) => {
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0].trim() || new URL(c.req.url).protocol.replace(":", "");
  return proto.toLowerCase() === "https" ? "; Secure" : "";
};

export const setLoginCookie = (c: Context, user: UserRecord) => {
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
/**
 * A request that came through this computer's tunnel (api/connect). cloudflared dials this server from loopback, so the
 * socket says "local"; the tunnel's own headers and its hostname say otherwise. A LAN client can write these headers
 * too, which only makes it count as remote: fail closed.
 */
export const viaTunnel = (c: Context) => {
  const tunnel = tunnelHostname();
  return !!c.req.header("cf-connecting-ip") || !!c.req.header("cf-ray") || (!!tunnel && hostOf(c) === tunnel.toLowerCase());
};
/** The Host the request was addressed to, without port (the request URL is built from it). */
const hostOf = (c: Context) => new URL(c.req.url).hostname.toLowerCase();
/**
 * Whether this request is held to the "own computer" password rule: a server on someone's own computer (CT_LOCAL=1, or
 * one that runs its own tunnel) reached from anywhere but itself. A hosted server is never: there APP_SECRET is the
 * operator's own password, and a CDN in front of it (Cloudflare) puts the same headers on every request as our tunnel.
 */
const ownComputer = () => process.env.CT_LOCAL === "1" || !!tunnelHostname();
const localOnly = (c: Context) => (process.env.CT_LOCAL === "1" && !isLoopback(c)) || (ownComputer() && viaTunnel(c));
const remoteRefused = (c: Context, user: UserRecord) => localOnly(c) && !!env.appSecret && verifyPassword(user, env.appSecret);
const NO_PASSWORD_YET = "This computer's password isn't set yet. In Creator Toolset on this computer, turn on Access from other devices and choose it, then try again.";

/**
 * One-time sign-in links, for a phone (Setup → Add your phone, as a QR code) or another computer. POST mints one for
 * the account signed in here, with `url`: the address a phone can open this server at (null: it listens on this
 * computer only). GET /api/auth/link/<code> signs that browser in and goes home. A code works once, within 60 s, and
 * dies with a password change. Kept in memory only and never logged.
 */
export async function phoneOrigin(c: Context): Promise<string | null> {
  const tunnel = tunnelHostname();
  if (tunnel) return `https://${tunnel}`;
  const url = new URL(c.req.url);
  if (!/^(localhost|127\.[\d.]+|\[::1\])$/.test(url.hostname)) {
    return `${c.req.header("x-forwarded-proto") ?? url.protocol.replace(":", "")}://${url.host}`;
  }
  const listen = process.env.HOST;
  if (listen && listen !== "0.0.0.0" && listen !== "::") return null;
  // the port this request came in on is the one the server listens on (a Mac app picks its own)
  const lan = await routeAddress();
  return lan ? `http://${lan}:${url.port || "80"}` : null;
}

/**
 * The address this computer reaches its network by (its default route's), not the first interface found: a VPN or a
 * virtual adapter may come first. A UDP socket connects without sending a packet, so the system picks the address.
 * Null when there is no route.
 */
function routeAddress(): Promise<string | null> {
  return new Promise((resolve) => {
    const s = createSocket("udp4");
    const done = (a: string | null) => {
      s.close();
      resolve(a);
    };
    s.once("error", () => done(null));
    s.connect(53, "192.0.2.1", () => done(s.address().address));
  });
}
const LINK_TTL = 60_000;
const links = new Map<string, { username: string; hash: string; expiresAt: number }>();

authApp.post("/link", async (c) => {
  // no sign-in on this server: anyone who can reach it is in, so the address alone is the code
  if (!env.appSecret) return c.json({ url: await phoneOrigin(c), path: null, expiresAt: null });
  const me = signedInAccount(c.req.header("cookie"));
  const user = me && findUser(me.username);
  if (!user) return c.json({ error: "Sign in with an account first" }, 401);
  // an own computer whose password is still the app's secret refuses every other device: no code is made that the
  // scan would only be refused for, and the page asks for the password first (the same answer as "listens here only")
  if (ownComputer() && verifyPassword(user, env.appSecret)) return c.json({ url: null, path: null, expiresAt: null });
  const now = Date.now();
  // one live code per account: a new one ends the older ones, so the codes on screen never stack
  for (const [k, v] of links) if (v.expiresAt <= now || v.username === user.username) links.delete(k);
  const code = randomBytes(32).toString("base64url");
  links.set(code, { username: user.username, hash: user.hash, expiresAt: now + LINK_TTL });
  return c.json({ url: await phoneOrigin(c), path: `/api/auth/link/${code}`, expiresAt: now + LINK_TTL });
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
 * A provider sign-in an app started (sign-in.ts, `app=1`): the sign-in ends on the app's own link with a one-time code,
 * and the app swaps it here for its session, POST /api/auth/app { code, verifier }. The app proves it started that
 * sign-in (PKCE, S256): the start took `challenge` = base64url(sha256(verifier)), so a code caught on its way to the
 * app is useless to anyone else. A code works once (any try that names it uses it up, right or wrong), within 60 s,
 * and dies with a password change. Kept in memory only and never logged. Hosted mode only, like the sign-ins that make
 * the codes. The body must be sent as JSON (Content-Type: application/json): a form on another site cannot send that,
 * so a page elsewhere can't use this route to sign a browser in to an account of its choosing. A body sent any other
 * way is not read at all, so it is refused without touching a code.
 */
export const APP_CHALLENGE = /^[A-Za-z0-9_-]{43}$/; // base64url of a sha256
const APP_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const appCodes = new Map<string, { username: string; hash: string; challenge: string; expiresAt: number }>();

export function mintAppCode(user: UserRecord, challenge: string): string {
  const now = Date.now();
  for (const [k, v] of appCodes) if (v.expiresAt <= now) appCodes.delete(k);
  const code = randomBytes(32).toString("base64url");
  appCodes.set(code, { username: user.username, hash: user.hash, challenge, expiresAt: now + LINK_TTL });
  return code;
}

authApp.post("/app", async (c) => {
  if (!hostedMode()) return c.json({ error: "Not Found" }, 404);
  const asJson = /^application\/json\b/i.test(c.req.header("content-type") ?? "");
  const b = asJson ? ((await c.req.json().catch(() => null)) as { code?: unknown; verifier?: unknown } | null) : null;
  const code = typeof b?.code === "string" ? b.code : "";
  const verifier = typeof b?.verifier === "string" ? b.verifier : "";
  const hit = appCodes.get(code);
  appCodes.delete(code); // single use, whatever happens next
  c.header("Cache-Control", "no-store");
  const proved = !!hit && hit.expiresAt > Date.now() && APP_VERIFIER.test(verifier) && createHash("sha256").update(verifier).digest("base64url") === hit.challenge;
  const user = proved ? findUser(hit.username) : null;
  // one answer for a wrong, used or expired code and a wrong verifier: it says nothing about which
  if (!user || user.hash !== hit!.hash) return c.json({ error: "That sign-in code is used or expired" }, 400);
  bumpUsage(user.username, { logins: 1 });
  setLoginCookie(c, user);
  return c.json({ ok: true, user: withLogins(sessionOf(user)) });
});

/**
 * Ticket sign-in through this computer's tunnel (POST /api/auth/ticket, body { ticket, password }). The broker's ticket
 * proves the account and the computer; the computer's own password is still asked, once per browser. A ticket
 * works once: it is spent before the password is checked, so a wrong password needs a new ticket.
 */
authApp.post("/ticket", async (c) => {
  const s = connectState();
  if (!s || hostOf(c) !== s.hostname.toLowerCase()) {
    return c.json({ error: "Not a tunnel address for this computer" }, 404);
  }
  const b = await c.req.json<{ ticket?: unknown; password?: unknown }>().catch(() => ({}) as { ticket?: unknown; password?: unknown });
  const ticket = typeof b.ticket === "string" ? b.ticket : "";
  const password = typeof b.password === "string" ? b.password : "";
  const now = Math.floor(Date.now() / 1000);
  try {
    verifyTicket(ticket, {
      relayPublicKey: parseRelayKey(s.relayPublicKey),
      hostname: s.hostname,
      computerId: s.computerId,
      owner: s.owner,
      now,
      consume: (jti, exp) => consumeJti(jti, exp, now),
    });
  } catch (e) {
    if (e instanceof TicketError) return c.json({ error: "This ticket doesn't work here. Ask for a new one." }, 401);
    throw e;
  }
  const user = findUser(s.localUser);
  if (!user) return c.json({ error: "This ticket doesn't work here. Ask for a new one." }, 403);
  // the computer's password must be set first: while it is APP_SECRET, only this Mac can sign in
  if (password === env.appSecret) return c.json({ error: NO_PASSWORD_YET }, 403);
  if (!password || !verifyPassword(user, password)) {
    const fails = (failures.get(user.username) ?? 0) + 1;
    failures.set(user.username, fails);
    await sleep(Math.min(fails * 250, 2000));
    return c.json({ error: "Wrong password" }, 401);
  }
  failures.delete(user.username);
  bumpUsage(user.username, { logins: 1 });
  setLoginCookie(c, user);
  return c.json({ ok: true, user: withLogins(sessionOf(user)) });
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
  const signins = (user.identities ?? []).map((i) => ({ provider: i.provider, email: i.email, name: i.name ?? "", picture: i.picture ?? null }));
  return c.json({
    username: user.username,
    name: user.displayName ?? "",
    login: user.login ?? user.username,
    identities: signins.map((s) => s.provider),
    signins,
    picture: pictureOf(user),
  });
});

authApp.patch("/account", async (c) => {
  const me = signedInAccount(c.req.header("cookie"));
  const user = me && findUser(me.username);
  if (!user) return c.json({ error: "Sign in with an account first" }, 401);
  const b = (await c.req.json().catch(() => ({}))) as { name?: unknown };
  if (typeof b.name === "string") setDisplayName(user, b.name);
  return c.json({ ok: true, user: withLogins(sessionOf(user)) });
});

/**
 * Invite links, /join/<token> (contracts/workspaces.ts). Hosted mode only: boot.ts mounts this app under /api/auth
 * there. Public, the token is the key. GET says which team; POST joins as the account signed in here, or makes a new
 * account (username + password), signs it in and joins it. A new account starts with the plug-ins' default-off gates
 * (createUser), so a member never gets a plug-in's default-off gate by joining.
 */
export const inviteApp = new Hono();

inviteApp.get("/invite/:token", (c) => {
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

inviteApp.post("/invite/:token", async (c) => {
  const token = c.req.param("token");
  const me = signedInAccount(c.req.header("cookie"));
  let user: UserRecord | null = me ? findUser(me.username) : null;
  // the only await is the body: the invite is checked after it, and nothing awaits between that check and the join,
  // so a revoke or expiry can't land in between and leave a new account signed in that never joins
  const b: { username?: unknown; password?: unknown } = user ? {} : await c.req.json<{ username?: unknown; password?: unknown }>().catch(() => ({}));
  const found = INVITE_TOKEN_RE.test(token) ? inviteByToken(token) : null;
  if (!found) return c.json({ error: "This invite link doesn't work any more" }, 404);
  if (found.invite.expiresAt <= Date.now()) return c.json({ error: "This invite link has expired: ask for a new one" }, 410);
  if (!user) {
    const username = typeof b.username === "string" ? b.username.trim().toLowerCase() : "";
    const password = typeof b.password === "string" ? b.password : "";
    try {
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

/**
 * The account the access-key routes act for. A solo install (no APP_SECRET) has no sign-in and no account record until
 * something writes one: its one account (LOCAL_USER) is made here, so its keys work without sign-in.
 */
function keyAccount(cookie: string | undefined) {
  const session = getSessionUser(cookie);
  if (!session) return null;
  const user = findUser(session.username);
  if (user || env.appSecret) return user;
  return createUser(LOCAL_USER.username, randomBytes(24).toString("base64url"), { role: "admin" });
}

/** This account's AI access keys: which are on, when each was made and last used, its last 4 characters. */
authApp.get("/api-key", (c) => {
  const user = keyAccount(c.req.header("cookie"));
  if (!user) return c.json({ error: "Sign in with an account first" }, 401);
  return c.json({ ...apiKeysOf(user), ai: aiKeysOf(user) });
});

/** Turns one key off: an AI app's (?id=) or a level's (?level=full|review). */
authApp.delete("/api-key", (c) => {
  const user = keyAccount(c.req.header("cookie"));
  if (!user) return c.json({ error: "Sign in with an account first" }, 401);
  const id = c.req.query("id");
  if (id) dropAiKey(user, id);
  else dropApiKey(user, c.req.query("level") === "full" ? "full" : "review");
  return c.json({ ...apiKeysOf(user), ai: aiKeysOf(user) });
});

/** Settings → Account: unlinks a Google or Apple sign-in (hosted only; a team's required provider can't be removed). */
authApp.delete("/identity/:provider", (c) => {
  if (!hostedMode()) return c.json({ error: "Not Found" }, 404);
  const session = getSessionUser(c.req.header("cookie"));
  const user = session && findUser(session.username);
  if (!user) return c.json({ error: "Sign in with an account first" }, 401);
  const provider = c.req.param("provider");
  if (!isSignInProvider(provider)) return c.json({ error: "Unknown sign-in" }, 404);
  const rule = ruleFor(user.username);
  const left = (user.identities ?? []).filter((i) => i.provider !== provider && rule?.allowed.includes(i.provider));
  if (rule?.allowed.includes(provider) && !left.length) {
    return c.json({ error: `Your team signs in with ${rule.allowed.map(providerLabel).join(" or ")}: link another one first` }, 400);
  }
  unlinkIdentity(user, provider);
  return c.json({ ok: true });
});

/** A new AI access key for this account (body `{ level: "full" }` for the Full key); the old one of that level stops working. */
authApp.post("/api-key", async (c) => {
  const user = keyAccount(c.req.header("cookie"));
  if (!user) return c.json({ error: "Sign in with an account first" }, 401);
  const body = (await c.req.json().catch(() => null)) as { level?: unknown; name?: unknown } | null;
  // `name`: a key of its own for one AI app (Headless access); the others keep working
  if (typeof body?.name === "string") return c.json(newAiKey(user, body.name));
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
