import { Hono } from "hono";
import type { Context } from "hono";
import { createPrivateKey, randomBytes, sign as cryptoSign } from "node:crypto";
import { getSessionUser, setLoginCookie, type AuthVars } from "./auth";
import { hostedMode } from "./lib/env";
import { bumpUsage, findByIdentity, findUser, linkIdentity, type SignInProvider } from "./users";

/**
 * Sign in with Apple and Google to a site account, and linking one to an account (Settings → Account). A hosted server
 * only (CT_MODE=hosted): on one person's Mac there are no providers to sign in with. The keys live in the server's
 * .env only. The free Mac app's own sign-in is a separate service (a hosted plug-in), with its own state.
 *
 * Sign-in start: GET /api/account/login/<apple|google>?for=link|site. Callbacks: /api/auth/<kind>/callback. A callback
 * for a sign-in this module did not start calls next(), so the plug-in that started it can answer.
 */
export type Kind = SignInProvider;
export interface Who {
  provider: Kind;
  sub: string;
  email: string;
  name: string;
}

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

const NOT_SET = "Sign-in isn't set up on this server yet";
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

/**
 * Google and Apple send people back only to the address their sign-in clients were registered with: SIGNIN_ORIGIN,
 * by default the product site. Any other server offers no Google / Apple sign-in, so it never shows a button that
 * ends on the provider's "redirect mismatch" page.
 */
export function signinOn(origin: string): { apple: boolean; google: boolean } {
  const here = origin === (process.env.SIGNIN_ORIGIN || "https://creatortoolset.com").replace(/\/$/, "");
  return { apple: here && !!appleSigninKeys(), google: here && !!googleSigninKeys() };
}

type Mode = { type: "site" } | { type: "link"; username: string };
// in memory: a sign-in in flight (single use, 15 min)
const states = new Map<string, { kind: Kind; mode: Mode; at: number }>();

const sweep = () => {
  const now = Date.now();
  for (const [k, v] of states) if (now - v.at > STATE_MS) states.delete(k);
};

const providerName = (p: Kind) => (p === "apple" ? "Apple" : "Google");

/** Starts a sign-in for a site account (`for=site`) or links one to the signed-in account (`for=link`); others go on. */
export const signInStartApp = new Hono<{ Variables: AuthVars }>();

signInStartApp.get("/login/:kind", (c, next) => {
  if (!hostedMode()) return next();
  const kind = c.req.param("kind");
  if (kind !== "apple" && kind !== "google") return next();
  const forWhat = c.req.query("for");
  let mode: Mode;
  if (forWhat === "link") {
    // linking needs the site account signed in here: read now, since Apple's callback is a cross-site POST without it
    const me = getSessionUser(c.req.header("cookie"));
    if (!me || !findUser(me.username)) return c.json({ error: "Sign in with an account first" }, 401);
    mode = { type: "link", username: me.username };
  } else if (forWhat === "site") mode = { type: "site" };
  else return next();
  const origin = originOf(c);
  const redirect = `${origin}/api/auth/${kind}/callback`;
  if (!signinOn(origin)[kind]) return c.json({ error: NOT_SET }, 501);
  const state = randomBytes(24).toString("base64url");
  let url: string;
  if (kind === "apple") {
    const k = appleSigninKeys();
    if (!k) return c.json({ error: NOT_SET }, 501);
    url = "https://appleid.apple.com/auth/authorize?" + new URLSearchParams({ client_id: k.servicesId, redirect_uri: redirect, response_type: "code", response_mode: "form_post", scope: "name email", state });
  } else {
    const g = googleSigninKeys();
    if (!g) return c.json({ error: NOT_SET }, 501);
    url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({ client_id: g.id, redirect_uri: redirect, response_type: "code", scope: "openid email profile", state });
  }
  sweep();
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

async function callback(c: Context, kind: Kind, p: { code: string; state: string; error?: string; userJson?: string }) {
  const st = states.get(p.state);
  states.delete(p.state); // single use
  if (!st || st.kind !== kind || Date.now() - st.at > STATE_MS) return c.text("That sign-in expired: start it again", 400);
  const mode = st.mode;
  const fail = (msg: string) =>
    mode.type === "link"
      ? c.redirect(`/settings/account?signin=${encodeURIComponent(msg)}`)
      : c.redirect(`/login?error=${encodeURIComponent(msg)}`);
  if (p.error || !p.code) return fail("Sign-in was cancelled");
  try {
    const redirect = `${originOf(c)}/api/auth/${kind}/callback`;
    const who = kind === "apple" ? await appleIdentity(p.code, redirect, p.userJson) : await googleIdentity(p.code, redirect);
    if (mode.type === "link") {
      // Google's callback is a same-site GET, so the cookie comes along: the browser finishing it must be the account
      // that started it (Apple's cross-site POST carries no cookie; its state is single use and 15 min)
      if (kind === "google" && getSessionUser(c.req.header("cookie"))?.username !== mode.username) return fail("Finish linking in the browser you're signed in on");
      const user = findUser(mode.username);
      if (!user) return fail("That account is gone");
      try {
        linkIdentity(user, who);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
      return c.redirect(`/settings/account?linked=${kind}`);
    }
    const user = findByIdentity(kind, who.sub);
    if (!user) return fail(`No account here signs in with that ${providerName(kind)} account. Sign in with your password, then link it in Settings → Account`);
    setLoginCookie(c, user);
    bumpUsage(user.username, { logins: 1 });
    return c.redirect("/");
  } catch (e) {
    console.error(`[sign-in] ${kind} sign-in failed:`, e instanceof Error ? e.message : e);
    return fail("Sign-in failed");
  }
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
  return { provider: "google", sub: claims.sub, email: verified ? str(claims.email) : "", name: str(claims.name) };
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
