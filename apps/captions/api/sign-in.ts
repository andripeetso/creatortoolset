import { Hono } from "hono";
import type { Context } from "hono";
import { createHash, createPrivateKey, randomBytes, sign as cryptoSign } from "node:crypto";
import { APP_CHALLENGE, getSessionUser, mintAppCode, setLoginCookie, type AuthVars } from "./auth";
import { writeFileSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { env, hostedMode } from "./lib/env";
import { escHtml, plainPage } from "./lib/plain-page";
import { SIGNIN_NAME, bumpUsage, createUser, findByIdentity, findByLogin, findUser, isSignInProvider, linkIdentity, listUsers, refreshPicture, type SignInProvider } from "./users";

/**
 * Sign in with Apple, Google and GitHub to a site account, and linking one to an account (Settings → Account). A hosted
 * server only (CT_MODE=hosted): on one person's Mac there are no providers to sign in with. The keys live in the
 * server's .env only. A first sign-in with no account here is refused: an account is one the server's owner made, or an
 * invite. Only a server whose .env says SIGN_UPS=open makes an account for a newcomer (newAccountFor). The free Mac app's
 * own sign-in is a separate service (a hosted plug-in), with its own state.
 *
 * Sign-in start: GET /api/account/login/<apple|google|github>?for=link|site. Callbacks: /api/auth/<kind>/callback. A
 * callback for a sign-in this module did not start calls next(), so the plug-in that started it can answer.
 *
 * An app's sign-in (a phone app opens the start in the system's sign-in sheet): ?for=site&app=1&challenge=<base64url
 * sha256 of a verifier the app keeps>. It sets no cookie in that sheet: it ends on creatortoolset://signin?code=<a
 * one-time code> (or ?error=<the words the login screen would show>), and the app swaps the code for its session with
 * POST /api/auth/app { code, verifier } (auth.ts).
 */
export type Kind = SignInProvider;
export interface Who {
  provider: Kind;
  sub: string;
  email: string;
  name: string;
  /** The provider's picture URL, https only (Apple gives none). */
  picture?: string;
}

/** A picture URL the provider gave: kept only as an https address of sane length; the browser loads it from there. */
const pictureUrl = (v: unknown) => {
  const s = typeof v === "string" ? v : "";
  return s.startsWith("https://") && s.length <= 2048 ? s : undefined;
};

interface AppleSignin {
  teamId: string;
  servicesId: string;
  keyId: string;
  key: string;
}

interface GoogleSignin {
  id: string;
  secret: string;
}

interface GithubSignin {
  id: string;
  secret: string;
}

const NOT_SET = "Sign-in isn't set up on this server yet";
/** Where the sign-in service sends a person back (the service accepts this path only). */
export const SERVICE_RETURN = "/api/auth/service/callback";
const STATE_MS = 15 * 60_000;

/** This server's own address, as the browser reached it (nginx passes Host and X-Forwarded-Proto). */
export function originOf(c: Context): string {
  const url = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return process.env.PUBLIC_ORIGIN?.replace(/\/$/, "") || `${proto}://${url.host}`;
}

/** Sign in with Apple's keys: the server's .env only, never a settings screen. */
export function appleSigninKeys(): AppleSignin | null {
  const e: AppleSignin = {
    teamId: (process.env.APPLE_SIGNIN_TEAM_ID ?? "").trim(),
    servicesId: (process.env.APPLE_SIGNIN_SERVICES_ID ?? "").trim(),
    keyId: (process.env.APPLE_SIGNIN_KEY_ID ?? "").trim(),
    key: (process.env.APPLE_SIGNIN_KEY ?? "").replace(/\\n/g, "\n").trim(),
  };
  return e.teamId && e.servicesId && e.keyId && e.key ? e : null;
}

/** Sign in with Google's own OAuth client: the server's .env only. */
export function googleSigninKeys(): GoogleSignin | null {
  const id = (process.env.GOOGLE_SIGNIN_CLIENT_ID ?? "").trim();
  const secret = (process.env.GOOGLE_SIGNIN_CLIENT_SECRET ?? "").trim();
  return id && secret ? { id, secret } : null;
}

/** Sign in with GitHub's OAuth app: the server's .env only. */
export function githubSigninKeys(): GithubSignin | null {
  const id = (process.env.GITHUB_CLIENT_ID ?? "").trim();
  const secret = (process.env.GITHUB_CLIENT_SECRET ?? "").trim();
  return id && secret ? { id, secret } : null;
}

/**
 * Google, Apple and GitHub send people back only to the address their sign-in clients were registered with:
 * SIGNIN_ORIGIN, by default the product site. Any other server offers no such sign-in, so it never shows a button that
 * ends on the provider's "redirect mismatch" page.
 */
export function signinOn(origin: string): Record<Kind, boolean> {
  const here = origin === (process.env.SIGNIN_ORIGIN || "https://creatortoolset.com").replace(/\/$/, "");
  return { apple: here && !!appleSigninKeys(), google: here && !!googleSigninKeys(), github: here && !!githubSigninKeys() };
}

/**
 * The account sign-in service: a server with no Google or Apple sign-in client of its own can sign its people in
 * through another server's clients (the product site's, plugins/hosted/server/account-signin.ts). OFF unless this
 * server's .env names the service (ACCOUNT_SIGNIN_SERVICE=https://…): there is no default, so no server uses one by
 * itself. Nothing is asked of the service until a person presses a sign-in button; it then sees that sign-in (who, and
 * for which server), and this server takes its word for who the person is. So name only a service you trust. The
 * service must also list this server (its ACCOUNT_SIGNIN_FOR).
 */
export function signinService(): string {
  const o = (process.env.ACCOUNT_SIGNIN_SERVICE ?? "").trim().replace(/\/$/, "");
  return /^https:\/\/[^/?#@]+$/.test(o) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o) ? o : "";
}

/** How a person signs in with this provider here: this server's own client, the service it names, or not at all. */
export function signinVia(origin: string, kind: Kind): "own" | "service" | null {
  if (signinOn(origin)[kind]) return "own";
  const service = signinService();
  return kind !== "github" && service && service !== origin ? "service" : null;
}

/**
 * The provider's sign-in page for this state, or null when the server has no keys for that provider. Shared by the
 * site sign-in here and the Mac app's account service (plugins/hosted/server/account.ts). GitHub has no PKCE: its
 * `state` is the CSRF guard, and the Mac app's own challenge/verifier (account.ts) covers the app's code.
 */
export function signinUrl(kind: Kind, redirect: string, state: string): string | null {
  if (kind === "apple") {
    const k = appleSigninKeys();
    return k && "https://appleid.apple.com/auth/authorize?" + new URLSearchParams({ client_id: k.servicesId, redirect_uri: redirect, response_type: "code", response_mode: "form_post", scope: "name email", state });
  }
  if (kind === "google") {
    const g = googleSigninKeys();
    return g && "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({ client_id: g.id, redirect_uri: redirect, response_type: "code", scope: "openid email profile", state });
  }
  const g = githubSigninKeys();
  return g && "https://github.com/login/oauth/authorize?" + new URLSearchParams({ client_id: g.id, redirect_uri: redirect, scope: "read:user user:email", state });
}

/** `app`: an app started this site sign-in (`app=1`); the value is its challenge, kept for the code it ends with. */
/** `back`: the page the person was on when they pressed sign in (a path on this server), where a browser sign-in ends. */
type Mode = { type: "site"; app?: string; back?: string } | { type: "link"; username: string };

/** A path on this server to go back to after a sign-in, or undefined: one that starts with a single "/", never another site. */
export const backPath = (v: string | undefined): string | undefined =>
  v && /^\/(?![/\\])[^\s]{0,500}$/.test(v) && !v.startsWith("/api/") ? v : undefined;
/** Where an app's sign-in ends: the link the app registers, with ?code= or ?error=. */
const APP_LINK = "creatortoolset://signin";
/**
 * A map kept in the data folder, so a restart (every deploy) between a sign-in's start and its way back loses nothing.
 * Small and short-lived: each entry is single use and swept after 15 minutes.
 */
class Kept<V extends { at: number }> extends Map<string, V> {
  private file: string;
  constructor(name: string) {
    super();
    this.file = path.join(env.dataDir, name);
    try {
      for (const [k, v] of Object.entries(JSON.parse(readFileSync(this.file, "utf8")) as Record<string, V>)) if (Date.now() - v.at <= STATE_MS) super.set(k, v);
    } catch {
      // none yet
    }
  }
  private save() {
    try {
      writeFileSync(`${this.file}.tmp`, JSON.stringify(Object.fromEntries(this)), { mode: 0o600 });
      renameSync(`${this.file}.tmp`, this.file);
    } catch (e) {
      console.error("[sign-in] could not keep sign-ins in progress:", e instanceof Error ? e.message : e);
    }
  }
  override set(k: string, v: V) {
    super.set(k, v);
    this.save();
    return this;
  }
  override delete(k: string) {
    const had = super.delete(k);
    if (had) this.save();
    return had;
  }
}

// a sign-in in flight (single use, 15 min)
// `verifier`: the sign-in went to the service; only this server can collect who signed in (PKCE)
const states = new Kept<{ kind: Kind; mode: Mode; at: number; verifier?: string }>("sign-ins-in-progress.json");
// a link whose way back reached a browser without that account's session: waits for the person's press (15 min)
const pendingLinks = new Kept<{ username: string; who: Who; at: number }>("sign-in-links-waiting.json");

const sweep = () => {
  const now = Date.now();
  for (const m of [states, pendingLinks]) for (const [k, v] of m) if (now - v.at > STATE_MS) m.delete(k);
};

/** Starts a sign-in for a site account (`for=site`) or links one to the signed-in account (`for=link`); others go on. */
export const signInStartApp = new Hono<{ Variables: AuthVars }>();

/**
 * Which sign-in buttons show: the providers this server has keys for (none off hosted). `?login=1` (the login screen):
 * only the ones an account here has linked, since on a server that takes people by invitation any other can only fail.
 */
signInStartApp.get("/providers", (c) => {
  const origin = originOf(c);
  const linked = (kind: Kind) => c.req.query("login") !== "1" || process.env.SIGN_UPS === "open" || listUsers().some((u) => u.identities?.some((i) => i.provider === kind));
  const on = (kind: Kind) => hostedMode() && !!signinVia(origin, kind) && linked(kind);
  return c.json({ apple: on("apple"), google: on("google"), github: on("github") });
});

signInStartApp.get("/login/:kind", (c, next) => {
  if (!hostedMode()) return next();
  const kind = c.req.param("kind");
  if (!isSignInProvider(kind)) return next();
  const forWhat = c.req.query("for");
  let mode: Mode;
  if (forWhat === "link") {
    // linking needs the site account signed in here: read now, since Apple's callback is a cross-site POST without it
    const me = getSessionUser(c.req.header("cookie"));
    if (!me || !findUser(me.username)) return c.json({ error: "Sign in with an account first" }, 401);
    mode = { type: "link", username: me.username };
  } else if (forWhat === "site") {
    if (c.req.query("app") === "1") {
      // an app's sign-in: refused outright without a challenge, never turned into a browser's sign-in
      const challenge = c.req.query("challenge") ?? "";
      if (!APP_CHALLENGE.test(challenge)) return c.json({ error: "The app's sign-in challenge is missing" }, 400);
      mode = { type: "site", app: challenge };
    } else {
      const back = backPath(c.req.query("next"));
      mode = back ? { type: "site", back } : { type: "site" };
    }
  } else return next();
  const origin = originOf(c);
  const redirect = `${origin}/api/auth/${kind}/callback`;
  const via = signinVia(origin, kind);
  if (!via) return c.json({ error: NOT_SET }, 501);
  const state = randomBytes(24).toString("base64url");
  sweep();
  if (via === "service") {
    // the person's browser goes to the service and comes back with a ticket; this server collects who it was
    const verifier = randomBytes(32).toString("base64url");
    states.set(state, { kind, mode, at: Date.now(), verifier });
    const q = new URLSearchParams({ return: `${origin}${SERVICE_RETURN}`, state, challenge: createHash("sha256").update(verifier).digest("base64url") });
    return c.redirect(`${signinService()}/api/account-signin/start/${kind}?${q}`);
  }
  const url = signinUrl(kind, redirect, state);
  if (!url) return c.json({ error: NOT_SET }, 501);
  states.set(state, { kind, mode, at: Date.now() });
  return c.redirect(url);
});

/** The provider callbacks for sign-ins this module started (see the note above). */
export const signInCallbackApp = new Hono<{ Variables: AuthVars }>();

signInCallbackApp.post("/apple/callback", async (c, next) => {
  if (!hostedMode()) return next();
  const f = await c.req.parseBody();
  const s = (k: string) => (typeof f[k] === "string" ? (f[k] as string) : "");
  if (!states.has(s("state"))) return next();
  return callback(c, "apple", { code: s("code"), state: s("state"), error: s("error"), userJson: s("user") });
});

signInCallbackApp.get("/google/callback", (c, next) => {
  if (!hostedMode()) return next();
  const state = c.req.query("state") ?? "";
  if (!states.has(state)) return next();
  return callback(c, "google", { code: c.req.query("code") ?? "", state, error: c.req.query("error") });
});

signInCallbackApp.get("/github/callback", (c, next) => {
  if (!hostedMode()) return next();
  const state = c.req.query("state") ?? "";
  if (!states.has(state)) return next();
  return callback(c, "github", { code: c.req.query("code") ?? "", state, error: c.req.query("error") });
});

/**
 * The sign-in service's way back: ?state&ticket (or &error). This server collects who signed in from the service with
 * the verifier it kept, once, and from there it is the same sign-in or link as with its own client.
 */
signInCallbackApp.get(SERVICE_RETURN.replace("/api/auth", ""), async (c, next) => {
  if (!hostedMode()) return next();
  const state = c.req.query("state") ?? "";
  const st = states.get(state);
  // a sign-in this server has no record of (expired, or used already): say so, rather than a bare Not Found
  if (!st?.verifier) return c.html(EXPIRED, 400);
  states.delete(state); // single use
  if (Date.now() - st.at > STATE_MS) return c.html(EXPIRED, 400);
  const fail = failTo(c, st.mode, true);
  const ticket = c.req.query("ticket") ?? "";
  if (c.req.query("error") || !ticket) return fail(str(c.req.query("error")).slice(0, 200) || "Sign-in was cancelled");
  try {
    const res = await fetch(`${signinService()}/api/account-signin/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket, verifier: st.verifier }),
      signal: AbortSignal.timeout(20_000),
    });
    const w = (await res.json().catch(() => ({}))) as Partial<Record<keyof Who, unknown>>;
    // the service's answer is checked like a provider's: the same provider that was asked for, and a real id
    if (!res.ok || w.provider !== st.kind || typeof w.sub !== "string" || !w.sub || w.sub.length > 255) throw new Error(`the sign-in service answered ${res.status}`);
    const who: Who = { provider: st.kind, sub: w.sub, email: str(w.email).slice(0, 320), name: str(w.name).slice(0, 200), picture: pictureUrl(w.picture) };
    // the way back is a top-level GET for every provider, so the session cookie comes along
    return finish(c, st.mode, who, true);
  } catch (e) {
    console.error(`[sign-in] ${st.kind} sign-in through the service failed:`, e instanceof Error ? e.message : e);
    return fail("Sign-in failed");
  }
});

/** The press on a link's page above: the link is made, and the person goes back to the app (its window reloads on focus). */
signInCallbackApp.post("/link-confirm", async (c) => {
  if (!hostedMode()) return c.notFound();
  const f = await c.req.parseBody();
  const id = typeof f.id === "string" ? f.id : "";
  const p = pendingLinks.get(id);
  if (!p || Date.now() - p.at > STATE_MS) return c.html(EXPIRED, 400);
  pendingLinks.delete(id); // single use
  const user = findUser(p.username);
  try {
    if (!user) throw new Error("That account is gone");
    linkIdentity(user, p.who);
  } catch (e) {
    return c.html(plainPage("That didn't link", `${escHtml(e instanceof Error ? e.message : String(e))}.`), 400);
  }
  return c.html(plainPage(`${SIGNIN_NAME[p.who.provider]} is linked`, "You can close this page and go back to Creator Toolset."));
});

const EXPIRED = plainPage("That sign-in expired", "Start it again from Creator Toolset.");

/** The account's own session came along (`withCookie`), or the way back is a cross-site POST that never carries one. */
const sessionHere = (c: Context, username: string) => getSessionUser(c.req.header("cookie"))?.username === username;

/**
 * Where a failed sign-in goes: the login screen (an app's sign-in: the app's own link, with the same words), or
 * Settings → Account for a link. A link whose way back reached a browser without that account's session (the Mac app
 * finishes sign-ins in the system browser) gets a plain page, since Settings would only show that browser the login
 * screen.
 */
const failTo = (c: Context, mode: Mode, withCookie = false) => (msg: string) =>
  mode.type !== "link"
    ? c.redirect(`${mode.app ? APP_LINK : "/login"}?error=${encodeURIComponent(msg)}`)
    : withCookie && !sessionHere(c, mode.username)
      ? c.html(plainPage("That didn't link", `${escHtml(msg)}. Go back to Creator Toolset and try again.`), 400)
      : c.redirect(`/settings/account?signin=${encodeURIComponent(msg)}`);

async function callback(c: Context, kind: Kind, p: { code: string; state: string; error?: string; userJson?: string }) {
  const st = states.get(p.state);
  states.delete(p.state); // single use
  if (!st || st.kind !== kind || Date.now() - st.at > STATE_MS) return c.html(EXPIRED, 400);
  const fail = failTo(c, st.mode, kind !== "apple");
  if (p.error || !p.code) return fail("Sign-in was cancelled");
  try {
    const redirect = `${originOf(c)}/api/auth/${kind}/callback`;
    const who = await identityOf(kind, p.code, redirect, p.userJson);
    // Google's and GitHub's callbacks are top-level GETs, so the Lax cookie comes along (Apple's cross-site POST carries
    // no cookie; its state is single use and 15 min)
    return finish(c, st.mode, who, kind === "google" || kind === "github");
  } catch (e) {
    console.error(`[sign-in] ${kind} sign-in failed:`, e instanceof Error ? e.message : e);
    return fail("Sign-in failed");
  }
}

/**
 * A person the provider (or the sign-in service) vouched for: linked to the account that started it, or signed in to
 * the account that sign-in belongs to. `withCookie`: the way back carried the session cookie, so a link must be
 * finished by the account that started it.
 */
function finish(c: Context, mode: Mode, who: Who, withCookie: boolean) {
  const kind = who.provider;
  const fail = failTo(c, mode, withCookie);
  if (mode.type === "link") {
    const user = findUser(mode.username);
    if (!user) return fail("That account is gone");
    if (withCookie && !sessionHere(c, mode.username)) {
      // this browser is not signed in here as the account that started the link (the Mac app's sign-in finishes in the
      // system browser): it names the account and links only on a press, so a link sent to someone else shows them
      // whose account they would be adding their sign-in to
      const other = findByIdentity(kind, who.sub);
      if (other && other !== user) return fail(`That ${SIGNIN_NAME[kind]} account already signs in to another account here`);
      sweep();
      const id = randomBytes(24).toString("base64url");
      pendingLinks.set(id, { username: user.username, who, at: Date.now() });
      const name = escHtml(user.displayName || user.username);
      const them = escHtml(who.email || who.name || `this ${SIGNIN_NAME[kind]} account`);
      return c.html(
        plainPage(
          `Link ${SIGNIN_NAME[kind]}?`,
          `<b>${them}</b> will sign in to <b>${name}</b> on ${escHtml(new URL(originOf(c)).host)}. Not your account? Close this page.`,
          `<form method="post" action="/api/auth/link-confirm"><input type="hidden" name="id" value="${id}"><button type="submit">Link ${SIGNIN_NAME[kind]}</button></form>`,
        ),
      );
    }
    try {
      linkIdentity(user, who);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
    return c.redirect(`/settings/account?linked=${kind}`);
  }
  const known = findByIdentity(kind, who.sub);
  // closed unless the server's owner opened it: nobody gets an account here just by signing in
  if (!known && process.env.SIGN_UPS !== "open") return fail("There is no account here for that sign-in. This server takes new people by invitation");
  if (known) refreshPicture(known, who);
  const user = known ?? newAccountFor(who);
  // an app started this sign-in: no cookie for the sign-in sheet; the app swaps this code for its own session
  if (mode.app) return c.redirect(`${APP_LINK}?code=${mintAppCode(user, mode.app)}`);
  setLoginCookie(c, user);
  bumpUsage(user.username, { logins: 1 });
  return c.redirect(mode.type === "site" && mode.back ? mode.back : "/");
}

/**
 * The account for a first sign-in with no account here: named from the person's name (else their email's first part),
 * with a password nobody knows, so the password form only works once they set one in Settings → Account.
 */
function newAccountFor(who: Who) {
  const from = (who.name || who.email.split("@")[0] || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20);
  const base = from.length >= 2 ? from : "creator";
  for (let i = 1; i <= 100; i++) {
    const name = i === 1 ? base : `${base}-${i}`;
    if (findUser(name) || findByLogin(name)) continue;
    try {
      const user = createUser(name, randomBytes(24).toString("base64url"), { role: "user" });
      linkIdentity(user, who);
      return user;
    } catch {
      // a reserved or taken name: the next one
    }
  }
  throw new Error("No free account name");
}

/** The provider's identity for a returned code: its token exchange and checks. Used by both callers (here and account.ts). */
export function identityOf(kind: Kind, code: string, redirect: string, userJson?: string): Promise<Who> {
  if (kind === "apple") return appleIdentity(code, redirect, userJson);
  if (kind === "google") return googleIdentity(code, redirect);
  return githubIdentity(code, redirect);
}

/** Apple's token exchange and id_token check. Used by the site sign-in here and by the Mac app's account service. */
export async function appleIdentity(code: string, redirect: string, userJson?: string): Promise<Who> {
  const k = appleSigninKeys();
  if (!k) throw new Error(NOT_SET);
  const res = await fetch("https://appleid.apple.com/auth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: k.servicesId, client_secret: appleClientSecret(k), code, grant_type: "authorization_code", redirect_uri: redirect }),
    signal: AbortSignal.timeout(20_000),
  });
  const tok = (await res.json().catch(() => ({}))) as { id_token?: string };
  if (!res.ok || !tok.id_token) throw new Error(`Apple token exchange ${res.status}`);
  const claims = jwtClaims(tok.id_token);
  if (claims.iss !== "https://appleid.apple.com" || !audOk(claims.aud, k.servicesId) || typeof claims.sub !== "string") throw new Error("Apple id_token check failed");
  // Apple sends the name only on the first sign-in, as the form field `user` (JSON)
  let form: { name?: { firstName?: string; lastName?: string } } = {};
  try {
    form = userJson ? (JSON.parse(userJson) as typeof form) : {};
  } catch {
    /* no name this time */
  }
  const formName = [form.name?.firstName, form.name?.lastName].filter(Boolean).join(" ");
  return { provider: "apple", sub: claims.sub, email: str(claims.email), name: str(claims.name) || formName };
}

/** Google's token exchange and id_token check. */
export async function googleIdentity(code: string, redirect: string): Promise<Who> {
  const g = googleSigninKeys();
  if (!g) throw new Error(NOT_SET);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: g.id, client_secret: g.secret, redirect_uri: redirect, grant_type: "authorization_code" }),
    signal: AbortSignal.timeout(20_000),
  });
  const tok = (await res.json().catch(() => ({}))) as { id_token?: string };
  if (!res.ok || !tok.id_token) throw new Error(`Google token exchange ${res.status}`);
  const claims = jwtClaims(tok.id_token);
  if (!["https://accounts.google.com", "accounts.google.com"].includes(str(claims.iss)) || !audOk(claims.aud, g.id) || typeof claims.sub !== "string") throw new Error("Google id_token check failed");
  // an address Google hasn't verified isn't kept: the account is the provider + sub either way
  const verified = claims.email_verified === true || claims.email_verified === "true";
  return { provider: "google", sub: claims.sub, email: verified ? str(claims.email) : "", name: str(claims.name), picture: pictureUrl(claims.picture) };
}

/**
 * GitHub's token exchange (a plain OAuth token, no id_token), then the account: `id` is the stable key (`login` can
 * change). A sign-in is refused unless GitHub marks an address primary and verified: the account is never kept without
 * one (fails closed; Google and Apple keep their existing rule for unverified addresses).
 */
export async function githubIdentity(code: string, redirect: string): Promise<Who> {
  const g = githubSigninKeys();
  if (!g) throw new Error(NOT_SET);
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: g.id, client_secret: g.secret, code, redirect_uri: redirect }),
    signal: AbortSignal.timeout(20_000),
  });
  const tok = (await res.json().catch(() => ({}))) as { access_token?: unknown };
  const token = str(tok.access_token);
  if (!res.ok || !token) throw new Error(`GitHub token exchange ${res.status}`);
  // api.github.com refuses a request without a User-Agent
  const api = (p: string) =>
    fetch(`https://api.github.com${p}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "creatortoolset" },
      signal: AbortSignal.timeout(20_000),
    });
  const me = await api("/user");
  const user = (me.ok ? await me.json().catch(() => null) : null) as { id?: unknown; login?: unknown; name?: unknown; avatar_url?: unknown } | null;
  if (!user || (typeof user.id !== "number" && typeof user.id !== "string")) throw new Error(`GitHub user ${me.status}`);
  const mails = await api("/user/emails");
  const list: unknown = mails.ok ? await mails.json().catch(() => []) : [];
  const primary = (Array.isArray(list) ? list : []).find((m: { primary?: unknown; verified?: unknown }) => m?.primary === true && m?.verified === true) as { email?: unknown } | undefined;
  const email = str(primary?.email);
  if (!email) throw new Error("GitHub has no verified primary email address");
  return { provider: "github", sub: String(user.id), email, name: str(user.name) || str(user.login), picture: pictureUrl(user.avatar_url) };
}

/** Apple's client secret: an ES256 JWT signed with the .p8 key (IEEE P1363 r||s, not DER). */
function appleClientSecret(k: AppleSignin): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const head = enc({ alg: "ES256", kid: k.keyId, typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const body = enc({ iss: k.teamId, iat: now, exp: now + 300, aud: "https://appleid.apple.com", sub: k.servicesId });
  const sig = cryptoSign("sha256", Buffer.from(`${head}.${body}`), { key: createPrivateKey(k.key), dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${head}.${body}.${sig}`;
}

/**
 * The id_token's claims. It came straight from the provider's token endpoint over our own TLS call, made with our
 * secret, which OpenID Connect Core 3.1.3.7 accepts in place of checking the signature; iss and aud are still checked.
 */
function jwtClaims(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1];
  if (!part) throw new Error("bad id_token");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf-8")) as Record<string, unknown>;
}

const audOk = (aud: unknown, id: string) => (Array.isArray(aud) ? aud : [aud]).includes(id);
const str = (v: unknown) => (typeof v === "string" ? v : "");
