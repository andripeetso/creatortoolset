import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Context } from "hono";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "./lib/env";
import { getSessionUser } from "./auth";
import { originOf } from "./sign-in";
import { findUser, newAiKey } from "./users";

/**
 * OAuth for the MCP server (/api/mcp), so an AI app (ChatGPT, Claude) connects by signing in instead of pasting a key.
 * The app registers itself (POST /api/oauth/register), sends the person to /oauth/authorize (sign in, then Allow), and
 * swaps the code for a token (POST /api/oauth/token, PKCE S256). The token is a named Full key (users.ts newAiKey): it
 * opens what a Full key does, shows under Settings → Headless access with the app's name, and Remove there ends it.
 * Pasted keys keep working beside it. Only on a server with accounts (APP_SECRET); without one /api/mcp is open anyway.
 *
 * A client id carries what it was registered with (name, redirect links, auth method), signed with APP_SECRET, so
 * nothing is stored for it. Codes live in memory for CODE_MS and work once.
 */

const CODE_MS = 5 * 60_000;
/** How long the Allow page's own form stays good. */
const ASK_MS = 10 * 60_000;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

type Client = { n: string; r: string[]; m: "none" | "client_secret_post" | "client_secret_basic" };

const mac = (what: string) => createHmac("sha256", env.appSecret).update(what).digest("base64url");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const sign = (kind: string, v: unknown) => {
  const body = Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${body}.${mac(`${kind}:${body}`).slice(0, 32)}`;
};
const unsign = <T>(kind: string, s: string): T | null => {
  const [body, sig] = s.split(".");
  if (!body || !sig || !same(sig, mac(`${kind}:${body}`).slice(0, 32))) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString()) as T;
  } catch {
    return null;
  }
};
const clientOf = (id: string) => unsign<Client>("client", id);
const secretOf = (id: string) => mac(`secret:${id}`);

/** https anywhere, or http on this computer only (an AI app running here). */
export const okRedirect = (u: unknown): u is string => {
  if (typeof u !== "string" || u.length > 500) return false;
  try {
    const url = new URL(u);
    if (url.hash) return false;
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  } catch {
    return false;
  }
};

const codes = new Map<string, { username: string; client: string; redirect: string; challenge: string; expires: number }>();

const metadata = (c: Context) => {
  const o = originOf(c);
  return {
    issuer: o,
    authorization_endpoint: `${o}/oauth/authorize`,
    token_endpoint: `${o}/api/oauth/token`,
    registration_endpoint: `${o}/api/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    authorization_response_iss_parameter_supported: true,
  };
};
const resource = (c: Context) => ({
  resource: `${originOf(c)}/api/mcp`,
  authorization_servers: [originOf(c)],
  bearer_methods_supported: ["header"],
});

/** What a 401 from /api/mcp says, so the AI app finds where to sign in (boot.ts). */
export const mcpChallenge = (c: Context) => `Bearer resource_metadata="${originOf(c)}/.well-known/oauth-protected-resource/api/mcp"`;

/** Mounted before the account gate (boot.ts): every route here checks its own access. */
export const oauthApp = new Hono();
// mounted at the root, so each guard names its own paths (a "*" here would stand in front of every route)
for (const p of ["/.well-known/*", "/api/oauth/*", "/oauth/*"]) {
  oauthApp.use(p, async (c, next) => (env.appSecret ? next() : c.json({ error: "Not Found" }, 404)));
}
// AI apps that run in a browser read these from their own page
oauthApp.use("/.well-known/*", cors());
oauthApp.use("/api/oauth/*", cors());

oauthApp.get("/.well-known/oauth-authorization-server", (c) => c.json(metadata(c)));
oauthApp.get("/.well-known/openid-configuration", (c) => c.json(metadata(c)));
oauthApp.get("/.well-known/oauth-protected-resource", (c) => c.json(resource(c)));
oauthApp.get("/.well-known/oauth-protected-resource/api/mcp", (c) => c.json(resource(c)));
// ChatGPT's check that whoever submits the app owns this domain: the token it gives, set on the server
oauthApp.get("/.well-known/openai-apps-challenge", (c) =>
  process.env.OPENAI_APPS_CHALLENGE ? c.text(process.env.OPENAI_APPS_CHALLENGE.trim()) : c.json({ error: "Not Found" }, 404),
);

/** The AI apps Settings → Headless access has a row for, by where they come back to: their key then has that row's name. */
const KNOWN: Record<string, string> = { "chatgpt.com": "ChatGPT", "chat.openai.com": "ChatGPT", "claude.ai": "Claude", "claude.com": "Claude" };

oauthApp.post("/api/oauth/register", async (c) => {
  const b = (await c.req.json().catch(() => null)) as { redirect_uris?: unknown; client_name?: unknown; token_endpoint_auth_method?: unknown } | null;
  const uris = Array.isArray(b?.redirect_uris) ? b.redirect_uris : [];
  if (!uris.length || uris.length > 5 || !uris.every(okRedirect)) {
    return c.json({ error: "invalid_redirect_uri", error_description: "redirect_uris: 1 to 5 https links (http only on localhost)" }, 400);
  }
  const m: Client["m"] = b?.token_endpoint_auth_method === "client_secret_post" || b?.token_endpoint_auth_method === "client_secret_basic" ? b.token_endpoint_auth_method : "none";
  const name = KNOWN[new URL(uris[0] as string).hostname] ?? ((typeof b?.client_name === "string" && b.client_name.trim().slice(0, 60)) || new URL(uris[0] as string).hostname);
  const id = sign("client", { n: name, r: uris, m } satisfies Client);
  return c.json(
    {
      client_id: id,
      ...(m === "none" ? {} : { client_secret: secretOf(id), client_secret_expires_at: 0 }),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: uris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: m,
    },
    201,
  );
});

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const page = (c: Context, body: string, status: 200 | 400 = 200) => {
  // never inside another site's frame: a hidden Allow button there would connect an app without the person seeing it
  c.header("X-Frame-Options", "DENY");
  c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  c.header("Cache-Control", "no-store");
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to Creator Toolset</title>
<style>:root{color-scheme:light dark;--bg:#fafafa;--fg:#111;--mute:#666;--card:#fff;--line:#e5e5e5}@media(prefers-color-scheme:dark){:root{--bg:#0b0b0c;--fg:#eee;--mute:#999;--card:#161618;--line:#2a2a2e}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:16px;box-sizing:border-box}
main{max-width:400px;width:100%;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}h1{font-size:20px;margin:0 0 12px}p{margin:0 0 12px;color:var(--mute)}b{color:var(--fg)}
form{display:flex;gap:10px;margin-top:20px}button{flex:1;font:inherit;padding:10px;border-radius:9px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer}button[value=allow]{background:var(--fg);color:var(--bg);border-color:var(--fg)}</style></head>
<body><main>${body}</main></body></html>`,
    status,
  );
};
const problem = (c: Context, why: string) => page(c, `<h1>This connection can't go ahead</h1><p>${esc(why)}</p>`, 400);

type Ask = { u: string; c: string; r: string; ch: string; s?: string; e: number };

oauthApp.get("/oauth/authorize", (c) => {
  const q = c.req.query();
  const client = clientOf(q.client_id ?? "");
  if (!client) return problem(c, "The app asking to connect isn't one this server knows. Add the connector again.");
  if (!client.r.includes(q.redirect_uri ?? "")) return problem(c, "The app's return link doesn't match the one it registered.");
  if (q.response_type !== "code" || q.code_challenge_method !== "S256" || !CHALLENGE.test(q.code_challenge ?? "")) {
    return problem(c, "The app's request is missing its sign-in check (PKCE).");
  }
  const me = getSessionUser(c.req.header("cookie"));
  if (!me || !findUser(me.username)) {
    const here = new URL(c.req.url);
    return c.redirect(`/login?next=${encodeURIComponent(here.pathname + here.search)}`);
  }
  const ask = sign("ask", { u: me.username, c: q.client_id!, r: q.redirect_uri!, ch: q.code_challenge!, ...(q.state ? { s: q.state } : {}), e: Date.now() + ASK_MS } satisfies Ask);
  const host = new URL(q.redirect_uri!).host;
  return page(
    c,
    `<h1>Connect ${esc(client.n)}?</h1>
<p><b>${esc(client.n)}</b> (${esc(host)}) will use Creator Toolset as <b>${esc(me.name ?? me.username)}</b>, like a Full access key.</p>
<p>Remove it any time in Settings → Headless access.</p>
<form method="post" action="/oauth/authorize"><input type="hidden" name="ask" value="${esc(ask)}"><button name="do" value="deny">Cancel</button><button name="do" value="allow" autofocus>Allow</button></form>`,
  );
});

/** Back to the AI app, keeping any query its link already has. */
const back = (c: Context, redirect: string, params: Record<string, string | undefined>) => {
  const url = new URL(redirect);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return c.redirect(url.toString(), 302);
};

oauthApp.post("/oauth/authorize", async (c) => {
  const form = await c.req.parseBody();
  const ask = unsign<Ask>("ask", typeof form.ask === "string" ? form.ask : "");
  const me = getSessionUser(c.req.header("cookie"));
  // the form is signed for the account that saw it: another browser or account can't press Allow for it
  if (!ask || ask.e < Date.now() || !me || me.username !== ask.u || !findUser(me.username)) {
    return problem(c, "This page is out of date. Start connecting again from the app.");
  }
  if (form.do !== "allow") return back(c, ask.r, { error: "access_denied", state: ask.s });
  const now = Date.now();
  for (const [k, v] of codes) if (v.expires <= now) codes.delete(k);
  const code = randomBytes(32).toString("base64url");
  codes.set(code, { username: ask.u, client: ask.c, redirect: ask.r, challenge: ask.ch, expires: now + CODE_MS });
  return back(c, ask.r, { code, state: ask.s, iss: originOf(c) });
});

oauthApp.post("/api/oauth/token", async (c) => {
  c.header("Cache-Control", "no-store");
  const json = /^application\/json\b/i.test(c.req.header("content-type") ?? "");
  const b = (json ? await c.req.json().catch(() => ({})) : await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
  const s = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : "");
  const refuse = (error: string, status: 400 | 401 = 400) => c.json({ error }, status);
  if (s("grant_type") !== "authorization_code") return refuse("unsupported_grant_type");
  // a client registered with a secret sends it in the body or as Basic auth
  const basic = /^Basic (.+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
  const [basicId, basicSecret] = basic ? Buffer.from(basic, "base64").toString().split(":").map(decodeURIComponent) : [];
  const clientId = s("client_id") || basicId || "";
  const client = clientOf(clientId);
  if (!client) return refuse("invalid_client", 401);
  if (client.m !== "none" && !same(s("client_secret") || basicSecret || "", secretOf(clientId))) return refuse("invalid_client", 401);
  const hit = codes.get(s("code"));
  codes.delete(s("code")); // once, whatever happens next
  const verifier = s("code_verifier");
  const proved =
    !!hit &&
    hit.expires > Date.now() &&
    hit.client === clientId &&
    (!s("redirect_uri") || s("redirect_uri") === hit.redirect) &&
    VERIFIER.test(verifier) &&
    createHash("sha256").update(verifier).digest("base64url") === hit.challenge;
  const user = proved ? findUser(hit.username) : null;
  if (!user) return refuse("invalid_grant");
  // ponytail: a key that never expires, so no refresh tokens; Remove in Settings ends it
  return c.json({ access_token: newAiKey(user, client.n, true).key, token_type: "Bearer" });
});
