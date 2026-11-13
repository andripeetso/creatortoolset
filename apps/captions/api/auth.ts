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
  setSignInCode,
  passwordProblem,
  SIGNIN_NAME,
  isSignInProvider,
  isAiAppKey,
  userForApiKey,
  verifyPassword,
  listUsers,
} from "./users";
import { INVITE_TOKEN_RE, type InviteInfo } from "../contracts/workspaces";
import { acceptInvite, inviteByToken, memberIn, workspaceOf } from "./lib/workspaces";
import { parseRelayKey } from "./connect/keys";
import { consumeJti, connectState, tunnelHostname } from "./connect/state";
import { TicketError, verifyTicket } from "./connect/ticket";
import { checkCode, clearTries, codeRequired, confirmSecret, mintStep, newSecret, spendStep, stepFor, waitFor, wrongTry } from "./lib/sign-in-code";

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

/** What the cookie is signed over: the password hash, plus the session stamp once the sign-in code made one (users.ts). */
const stamp = (u: UserRecord) => (u.session ? `${u.hash}:${u.session}` : u.hash);

const signedBy = (username: string, hash: string, hex: string) => {
  const expected = Buffer.from(sign(username, hash), "hex");
  const got = Buffer.from(hex, "hex");
  return got.length === expected.length && timingSafeEqual(got, expected);
};

export function getSessionUser(
  cookieHeader: string | undefined,
): SessionUser | null {
  if (!env.appSecret) return LOCAL_USER;
  // a browser can hold several cookies by this name (an old one for the parent domain, a newer one for this host), and
  // sends all of them: the first that is still valid is the session, so an old one never hides a new sign-in
  for (const m of (cookieHeader ?? "").matchAll(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]+)\\.([a-f0-9]{64})`, "g"))) {
    let username = "";
    try {
      username = Buffer.from(m[1], "base64url").toString();
    } catch {
      continue;
    }
    const user = findUser(username);
    if (user && signedBy(user.username, stamp(user), m[2])) return sessionOf(user);
  }
  return null;
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

/**
 * `Authorization: Bearer ctk_…` from a script or AI, at one key level (boot.ts decides what each reaches). `path`: the
 * route asked for. A key an AI app got by signing in opens the MCP route and nothing else: the app only ever speaks
 * MCP, and whoever holds a copy of such a key (the Connect broker keeps one to pass requests on) can do no more with it
 * than the app can. The tools' own calls run as the account (innerCall), so they are not held by this.
 */
export function getApiKeyUser(authorization: string | undefined, level: KeyLevel = "review", path?: string): SessionUser | null {
  const key = /^Bearer (ctk_[a-f0-9]{48})$/.exec(authorization ?? "")?.[1];
  if (key && path !== undefined && path !== "/api/mcp" && isAiAppKey(key)) return null;
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

// each wrong try also buys a delay; the lock (lib/sign-in-code.ts) stops a guesser
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * No passwords on a hosted server where every account signs in with Google, Apple or GitHub: a password there is only
 * one more thing to guess. A server with any account that has no linked sign-in keeps them for everyone.
 */
export const passwordsOff = (): boolean => {
  if (!hostedMode() || !env.appSecret) return false;
  const all = listUsers();
  return all.length > 0 && all.every((u) => !!u.identities?.length);
};
export const PASSWORDS_OFF = "This server signs in with Google, Apple or GitHub only";

authApp.post("/login", async (c) => {
  if (!env.appSecret) return c.json({ ok: true, user: toPublic(LOCAL_USER) });
  if (passwordsOff()) return c.json({ error: PASSWORDS_OFF }, 403);
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
  // the lock is per account (a name no account has is held the same way); this Mac's own window is never held or counted
  const mac = fromThisMac(c);
  const key = user?.username ?? `?${username}`;
  const from = clientAddress(c);
  if (!mac && waitFor(key, from)) return locked(c, key, from);
  if (!user || !password || !verifyPassword(user, password)) {
    await sleep(Math.min((mac ? 1 : wrongTry(key, from)) * 250, 2000));
    return c.json({ error: "Wrong username or password" }, 401);
  }
  // after the password: a wrong guess from the LAN costs its delay and says nothing about the account
  if (password === env.appSecret && localOnly(c)) return c.json({ error: NO_PASSWORD_YET }, 403);
  // checked after the password too, so a wrong guess learns nothing about the team
  const rule = ruleFor(user.username);
  if (rule && !rule.missing) return c.json({ error: `Your team signs in with ${rule.allowed.map(providerLabel).join(" or ")}: use that button`, code: "SIGNIN_RULE" }, 403);
  if (!mac && (user.code || codeRequired())) return codeStep(c, user);
  clearTries(key, from);
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
    `${COOKIE}=${cookieValue(user.username, stamp(user))}; HttpOnly; Path=/; Max-Age=${MAX_AGE}; SameSite=Lax${secure}${domainAttr()}`,
  );
};

/**
 * A server on this Mac (CT_LOCAL=1) signs in from another device (a phone, the LAN) only once its owner chose a
 * password: until then the account's password is APP_SECRET, which only the Mac app knows, and that account signs in
 * from this Mac alone. The socket's address decides, never a header (a LAN client writes those itself).
 */
const isLoopback = (c: Context) => {
  const a = peerOf(c);
  return a === "::1" || /^127\./.test(a);
};
/** The socket's address, an IPv4-mapped one as plain IPv4. Empty with no socket (tests): not loopback. */
const peerOf = (c: Context) => {
  try {
    return (getConnInfo(c).remote.address ?? "").replace(/^::ffff:(?=\d+\.)/, "");
  } catch {
    return "";
  }
};
const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|f[cd][0-9a-f]{2}:)/i;
/** IPv6 by its /64: one network hands out a whole /64, so its addresses count as one. */
const per64 = (a: string) => {
  if (!a.includes(":")) return a;
  const [head = "", tail] = a.toLowerCase().replace(/%.*$/, "").split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const all = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return `${all.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, "")).join(":")}::/64`;
};
/**
 * Who a wrong password or code counts against (the lock, lib/sign-in-code.ts). The socket's address, unless the socket
 * is a proxy on this computer (cloudflared, nginx, Caddy) or, off the Mac app's server, on its private network (the
 * Docker kit's Caddy): then the address that proxy wrote. Through this Mac's tunnel that is Cloudflare's
 * CF-Connecting-IP (Cloudflare sets it and drops a caller's own), else the tunnel counts as one address; behind any
 * other proxy it is the last X-Forwarded-For entry, the one the nearest proxy added (Caddy writes the header fresh;
 * nginx appends to it). A caller that reaches the socket itself is its own address whatever it sends, and one behind a
 * proxy can only put entries before the proxy's.
 */
export function clientAddress(c: Context): string {
  const peer = peerOf(c);
  const tunnel = tunnelHostname();
  let a = peer;
  if (isLoopback(c) && tunnel && hostOf(c) === tunnel.toLowerCase()) a = c.req.header("cf-connecting-ip")?.trim() || "tunnel";
  else if (isLoopback(c) || (process.env.CT_LOCAL !== "1" && PRIVATE.test(peer))) a = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim() || peer;
  return per64(a.slice(0, 64));
}
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
/**
 * The Mac app's own window (or a browser on this Mac) signing in to the server the app runs here: CT_LOCAL=1, not
 * hosted, a loopback socket, addressed to loopback, and nothing that says the request was passed on (the tunnel's
 * headers, a proxy's). Neither the sign-in code nor the lock applies to it. A request through the tunnel, a proxy or
 * the network fails one of these; a relay that adds none of them (one the person sets up on this Mac) can't be told apart.
 */
export const fromThisMac = (c: Context) =>
  process.env.CT_LOCAL === "1" &&
  !hostedMode() &&
  isLoopback(c) &&
  /^(127\.0\.0\.1|localhost|\[::1\])$/.test(hostOf(c)) &&
  !viaTunnel(c) &&
  !["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "via"].some((h) => c.req.header(h) !== undefined);
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
  links.set(code, { username: user.username, hash: stamp(user), expiresAt: now + LINK_TTL });
  return c.json({ url: await phoneOrigin(c), path: `/api/auth/link/${code}`, expiresAt: now + LINK_TTL });
});

authApp.get("/link/:code", (c) => {
  const code = c.req.param("code");
  const link = links.get(code);
  links.delete(code); // single use, whatever happens next
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  const user = link && link.expiresAt > Date.now() ? findUser(link.username) : null;
  if (!user || stamp(user) !== link!.hash) return c.text("This sign-in link has expired or was used. Ask for a new one.", 410);
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
  appCodes.set(code, { username: user.username, hash: stamp(user), challenge, expiresAt: now + LINK_TTL });
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
  if (!user || stamp(user) !== hit!.hash) return c.json({ error: "That sign-in code is used or expired" }, 400);
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
  const from = clientAddress(c);
  if (waitFor(user.username, from)) return locked(c, user.username, from);
  if (!password || !verifyPassword(user, password)) {
    await sleep(Math.min(wrongTry(user.username, from) * 250, 2000));
    return c.json({ error: "Wrong password" }, 401);
  }
  if (user.code || codeRequired()) return codeStep(c, user);
  clearTries(user.username, from);
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

/** Too many wrong tries in a row: no password or code is looked at until the wait is over (lib/sign-in-code.ts). */
const locked = (c: Context, key: string, from: string) => {
  const min = Math.ceil(waitFor(key, from) / 60_000);
  c.header("Retry-After", String(min * 60));
  return c.json({ error: `Too many wrong tries. Try again in ${min} minute${min === 1 ? "" : "s"}.`, code: "LOCKED" }, 429);
};

/**
 * The password was right and the sign-in code is still to come: no cookie, only a step token for POST /api/auth/code.
 * An app that doesn't know this step shows `error` as the reason it can't sign in.
 */
const codeStep = (c: Context, user: UserRecord) => {
  const setup = !user.code;
  c.header("Cache-Control", "no-store");
  return c.json(
    {
      error: setup
        ? "This server asks for a code from an authenticator app. Set it up in a browser, then sign in here with a link from it."
        : "This account asks for a code from an authenticator app, which this app can't take yet. Sign in with a link from a signed-in computer instead.",
      code: setup ? "CODE_SETUP" : "CODE_NEEDED",
      step: mintStep(user.username, stamp(user), setup),
    },
    401,
  );
};

const accountHere = (c: Context) => {
  const me = env.appSecret ? signedInAccount(c.req.header("cookie")) : null;
  return (me && findUser(me.username)) || null;
};
const bodyOf = (c: Context) => c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
const text = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * The code step after a password (POST /api/auth/code { step, code }): the step token from /login or /ticket and the
 * authenticator's code, or a recovery code once. A wrong code counts toward the lock as a wrong password does; the
 * token stays until it signs in or its 5 minutes are up. A setup token takes the first code of the secret
 * /code/new made for it, switches the code on and answers the recovery codes, once.
 */
authApp.post("/code", async (c) => {
  const b = await bodyOf(c);
  const hit = stepFor(b.step);
  const user = hit && findUser(hit.username);
  c.header("Cache-Control", "no-store");
  if (!user || stamp(user) !== hit.stamp) return c.json({ error: "That sign-in expired. Sign in again.", code: "STEP_EXPIRED" }, 401);
  const from = clientAddress(c);
  if (waitFor(user.username, from)) return locked(c, user.username, from);
  const made = hit.setup && !user.code ? confirmSecret(user.username, text(b.code)) : null;
  const next = made?.code ?? (!hit.setup && user.code ? checkCode(user.code, text(b.code)) : null);
  if (!next) {
    await sleep(Math.min(wrongTry(user.username, from) * 250, 2000));
    return c.json({ error: "Wrong code" }, 401);
  }
  setSignInCode(user, next, !!made);
  spendStep(text(b.step));
  clearTries(user.username, from);
  bumpUsage(user.username, { logins: 1 });
  setLoginCookie(c, user);
  return c.json({ ok: true, user: withLogins(sessionOf(user)), ...(made ? { recovery: made.recovery } : {}) });
});

/** Settings → Account: whether the code is on, whether this server asks everyone, and whether this is this Mac's own window. */
authApp.get("/code", (c) => {
  const user = accountHere(c);
  if (!user) return c.json({ error: "Sign in with an account first" }, 401);
  return c.json({ on: !!user.code, required: codeRequired(), mac: fromThisMac(c) });
});

/**
 * A secret to scan (POST /api/auth/code/new): for the account signed in here, or a setup token's account. Never for an
 * account that has a code: switching it off comes first. Kept 10 minutes, until a first code confirms it.
 */
authApp.post("/code/new", async (c) => {
  const b = await bodyOf(c);
  const hit = b.step === undefined ? null : stepFor(b.step);
  const user = b.step === undefined ? accountHere(c) : hit?.setup ? findUser(hit.username) : null;
  if (!user || (hit && stamp(user) !== hit.stamp)) return c.json({ error: "Sign in with an account first" }, 401);
  if (user.code) return c.json({ error: "The sign-in code is on already" }, 409);
  c.header("Cache-Control", "no-store");
  return c.json(newSecret(user.username, `${user.login ?? user.username}@${hostOf(c)}`));
});

/** Switches the code on with the first code of the new secret. Every other browser is signed out; this one keeps going. */
authApp.post("/code/on", async (c) => {
  const user = accountHere(c);
  if (!user) return c.json({ error: "Sign in with an account first" }, 401);
  if (user.code) return c.json({ error: "The sign-in code is on already" }, 409);
  const made = confirmSecret(user.username, text((await bodyOf(c)).code));
  if (!made) return c.json({ error: "Wrong code" }, 400);
  setSignInCode(user, made.code, true);
  setLoginCookie(c, user);
  c.header("Cache-Control", "no-store");
  return c.json({ ok: true, recovery: made.recovery });
});

/** Switches it off with a current code or a recovery code. This Mac's own window needs neither: the way back from a lost phone. */
authApp.post("/code/off", async (c) => {
  const user = accountHere(c);
  if (!user) return c.json({ error: "Sign in with an account first" }, 401);
  if (!user.code) return c.json({ ok: true });
  if (codeRequired()) return c.json({ error: "This server asks everyone for a sign-in code" }, 400);
  if (!fromThisMac(c)) {
    const from = clientAddress(c);
    if (waitFor(user.username, from)) return locked(c, user.username, from);
    if (!checkCode(user.code, text((await bodyOf(c)).code))) {
      wrongTry(user.username, from);
      return c.json({ error: "Wrong code" }, 400);
    }
  }
  setSignInCode(user, null);
  return c.json({ ok: true });
});

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
      const problem = passwordProblem(password);
      if (problem) throw new Error(problem);
      user = createUser(username, password, { role: found.workspace.plan === "team" ? "team" : "user" });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
    // a server that asks everyone for a sign-in code: the new account signs in with its password and sets one up
    if (!codeRequired()) {
      setLoginCookie(c, user);
      bumpUsage(user.username, { logins: 1 });
    }
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
