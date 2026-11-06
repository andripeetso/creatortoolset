import { Hono } from "hono";
import type { Context } from "hono";
import { sessionOf, type AuthVars } from "./auth";
import { LOGINS, PLATFORMS, type ConnectorsView, type LoginKind, type SocialPlatform } from "../contracts/connectors";
import { appFor, finishLogin, freshToken, loginUrl, pullAccount } from "./lib/connectors/platforms";
import { findAccount, newState, patchAccount, publicAccount, readApps, readConnectors, removeAccount, saveAccounts, writeApps, type StoredAccount } from "./lib/connectors/store";
import { publicApifyStatus, readApify } from "./lib/instagram/apify";
import { addLoginAccount } from "./instagram";
import { findUser, listUsers, LOCAL_USER, type SessionUser } from "./users";

/**
 * Settings → Connectors: each person connects their own social accounts. Logins (Meta, Google,
 * TikTok) read their own numbers through our registered apps; anything else is read by handle on their own Apify
 * token, so we never pay for anyone's scraping. Tokens stay in $DATA_DIR/connectors/<user>.json.
 */
export const connectorsApp = new Hono<{ Variables: AuthVars }>();

const KINDS: LoginKind[] = ["meta", "google", "tiktok"];
const STATE_MS = 15 * 60_000;
const states = new Map<string, { user: string; kind: LoginKind; projectId?: string; verifier?: string; at: number; back: string }>();

const nobody = (u: SessionUser) => u.role === "guest" || !!u.demo;

/** Where a login sends people back: PUBLIC_ORIGIN in production (the apps register this exact URL), else this host. */
function redirectFor(c: Context, kind: LoginKind): string {
  // nginx passes Host and X-Forwarded-Proto (not X-Forwarded-Host): https://creatortoolset.com in production
  const url = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const origin = process.env.PUBLIC_ORIGIN?.replace(/\/$/, "") || `${proto}://${url.host}`;
  return `${origin}/api/connectors/callback/${kind}`;
}

async function view(c: Context<{ Variables: AuthVars }>): Promise<ConnectorsView> {
  const user = c.get("user");
  const apify = publicApifyStatus(await readApify(user.username));
  return {
    logins: Object.fromEntries(KINDS.map((k) => [k, !!appFor(k)])) as ConnectorsView["logins"],
    redirects: Object.fromEntries(KINDS.map((k) => [k, redirectFor(c, k)])) as ConnectorsView["redirects"],
    apify: { configured: apify.configured, valid: apify.valid },
    accounts: readConnectors(user.username).accounts.map(publicAccount),
  };
}

connectorsApp.get("/", async (c) => c.json(await view(c)));

/** Settings → Admin → Connector apps: which apps are set (never their secrets), and the URLs to register. */
connectorsApp.get("/apps", (c) => {
  if (c.get("user").role !== "admin") return c.json({ error: "Admins only" }, 403);
  const a = readApps();
  const shown = (k: LoginKind) => {
    const app = appFor(k);
    return { set: !!app, id: app?.id ?? "", fromEnv: !!app && !a[k], ...(k === "meta" ? { configId: a.meta?.configId ?? "" } : {}) };
  };
  return c.json({
    meta: shown("meta"),
    google: shown("google"),
    tiktok: shown("tiktok"),
    tiktokVerify: a.tiktokVerify?.name ?? "",
    redirects: Object.fromEntries(KINDS.map((k) => [k, redirectFor(c, k)])),
  });
});

/** Save one app's keys ({kind, id, secret, configId?}) or TikTok's site check file ({kind: "tiktokVerify", name, content}). An empty id removes it. */
connectorsApp.put("/apps", async (c) => {
  if (c.get("user").role !== "admin") return c.json({ error: "Admins only" }, 403);
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const s = (k: string, max = 500) => (typeof b?.[k] === "string" ? (b[k] as string).trim().slice(0, max) : "");
  const next = { ...readApps() };
  if (b?.kind === "tiktokVerify") {
    const name = s("name", 120);
    if (name && !/^tiktok[\w-]*\.txt$/i.test(name)) return c.json({ error: "TikTok's file is named tiktok….txt" }, 400);
    if (name) next.tiktokVerify = { name, content: s("content", 2000) };
    else delete next.tiktokVerify;
  } else if (KINDS.includes(b?.kind as LoginKind)) {
    const kind = b!.kind as LoginKind;
    const id = s("id");
    const secret = s("secret") || (next[kind]?.id === id ? next[kind]!.secret : "");
    if (!id) delete next[kind];
    else if (!secret) return c.json({ error: "Paste the secret too" }, 400);
    else next[kind] = kind === "meta" ? { id, secret, ...(s("configId") ? { configId: s("configId") } : {}) } : { id, secret };
  } else return c.json({ error: "Unknown app" }, 400);
  writeApps(next);
  return c.json({ ok: true });
});

/** TikTok's "verify URL ownership" file, at the site's root (boot.ts mounts this before the app). */
export function tiktokVerifyFile(name: string): string | null {
  const v = readApps().tiktokVerify;
  return v && v.name === name ? v.content : null;
}

/** Start a login: the page to open (the browser goes there and comes back to /callback). */
connectorsApp.get("/login/:kind", (c) => {
  const user = c.get("user");
  const kind = c.req.param("kind") as LoginKind;
  if (nobody(user)) return c.json({ error: "Connect accounts from your own account" }, 403);
  if (!KINDS.includes(kind)) return c.json({ error: "Unknown login" }, 404);
  if (!appFor(kind)) return c.json({ error: `${LOGINS.find((l) => l.id === kind)!.label} login isn't set up on this server yet` }, 409);
  const state = newState();
  const { url, verifier } = loginUrl(kind, redirectFor(c, kind), state);
  for (const [k, v] of states) if (Date.now() - v.at > STATE_MS) states.delete(k);
  const back = c.req.query("back")?.startsWith("/") && !c.req.query("back")!.startsWith("//") ? c.req.query("back")! : "/settings/connectors";
  states.set(state, { user: user.username, kind, projectId: c.req.query("projectId") || undefined, verifier, at: Date.now(), back });
  return c.redirect(url);
});

connectorsApp.get("/callback/:kind", async (c) => {
  const user = c.get("user");
  const st = states.get(c.req.query("state") ?? "");
  const kind = c.req.param("kind") as LoginKind;
  const back = (q: string) => c.redirect(`${st?.back ?? "/settings/connectors"}${(st?.back ?? "").includes("?") ? "&" : "?"}${q}`);
  if (!st || st.user !== user.username || st.kind !== kind || Date.now() - st.at > STATE_MS) return back(`error=${encodeURIComponent("That login expired: start it again")}`);
  states.delete(c.req.query("state")!);
  const denied = c.req.query("error_description") || c.req.query("error");
  if (denied) return back(`error=${encodeURIComponent(denied)}`);
  try {
    const got = await finishLogin(kind, c.req.query("code") ?? "", redirectFor(c, kind), st.verifier);
    const saved = saveAccounts(user.username, got.map((a) => ({ ...a, ...(st.projectId ? { projectId: st.projectId } : {}) })));
    for (const a of saved) void pullOne(user, a.key);
    return back(`connected=${saved.length}`);
  } catch (e) {
    return back(`error=${encodeURIComponent(e instanceof Error ? e.message : String(e))}`);
  }
});

/** Add an account by handle, read on the user's own Apify token (public numbers). Instagram handles go to the Analyzer. */
connectorsApp.post("/handles", async (c) => {
  const user = c.get("user");
  if (nobody(user)) return c.json({ error: "Connect accounts from your own account" }, 403);
  const body = (await c.req.json().catch(() => null)) as { platform?: unknown; handle?: unknown; projectId?: unknown } | null;
  const platform = PLATFORMS.find((p) => p.id === body?.platform)?.id;
  const handle = typeof body?.handle === "string" ? body.handle.trim().replace(/^@/, "").replace(/^https?:\/\/[^/]+\/@?/, "").replace(/[/?#].*$/, "") : "";
  if (!platform || !/^[\w.-]{1,100}$/.test(handle)) return c.json({ error: "Pick a platform and a handle" }, 400);
  if (platform === "instagram") return c.json({ error: "Instagram handles go in the Content Analyzer" }, 400);
  const [a] = saveAccounts(user.username, [{ platform, platformId: handle.toLowerCase(), handle, via: "apify", ...(typeof body?.projectId === "string" && body.projectId ? { projectId: body.projectId } : {}) }]);
  void pullOne(user, a!.key);
  return c.json(publicAccount({ ...a!, pulling: true }), 201);
});

connectorsApp.patch("/accounts/:key", async (c) => {
  const user = c.get("user");
  const body = (await c.req.json().catch(() => null)) as { projectId?: unknown } | null;
  if (!body || !("projectId" in body)) return c.json({ error: "Nothing to change" }, 400);
  const projectId = typeof body.projectId === "string" && body.projectId ? body.projectId : undefined;
  const a = patchAccount(user.username, c.req.param("key"), { projectId });
  return a ? c.json(publicAccount(a)) : c.json({ error: "Not found" }, 404);
});

connectorsApp.post("/accounts/:key/pull", async (c) => {
  const user = c.get("user");
  const a = findAccount(user.username, c.req.param("key"));
  if (!a) return c.json({ error: "Not found" }, 404);
  void pullOne(user, a.key);
  return c.json(publicAccount({ ...a, pulling: true }));
});

connectorsApp.delete("/accounts/:key", (c) => (removeAccount(c.get("user").username, c.req.param("key")) ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404)));

const pulling = new Set<string>();

/** Read one account now; an Instagram login is handed to the Analyzer, which pulls it on that login. */
async function pullOne(user: SessionUser | string, key: string): Promise<void> {
  const name = typeof user === "string" ? user : user.username;
  const a = findAccount(name, key);
  if (!a || pulling.has(`${name}/${key}`)) return;
  pulling.add(`${name}/${key}`);
  try {
    if (a.platform === "instagram") {
      const rec = typeof user === "string" ? findUser(user) : null;
      const who = typeof user !== "string" ? user : rec ? sessionOf(rec) : user === LOCAL_USER.username ? LOCAL_USER : null;
      const analyzerId = who ? await addLoginAccount(who, a.handle, a.projectId) : undefined;
      patchAccount(name, key, { analyzerId, pulledAt: Date.now(), pullError: analyzerId ? undefined : "The Analyzer could not add it" });
      return;
    }
    const fresh = a.via === "login" ? await freshToken(a) : {};
    if (fresh.token !== a.token) patchAccount(name, key, fresh); // TikTok's refresh token changes on every refresh: keep the new one at once
    const got = await pullAccount({ ...a, ...fresh } as StoredAccount, name);
    patchAccount(name, key, { stats: got.stats, posts: got.posts.sort((x, y) => y.at - x.at).slice(0, 100), name: got.name || a.name, avatar: got.avatar || a.avatar, pulledAt: Date.now(), pullError: undefined });
  } catch (e) {
    patchAccount(name, key, { pullError: (e instanceof Error ? e.message : String(e)).slice(0, 300), pulledAt: Date.now() });
  } finally {
    pulling.delete(`${name}/${key}`);
  }
}

/** Logins are read every 12 hours (free, official APIs); handles only when asked (each run costs the user's Apify). */
const EVERY_MS = 12 * 60 * 60_000;
export function startConnectorPulls(): void {
  if (process.env.NODE_ENV === "test") return;
  setInterval(() => {
    for (const u of listUsers())
      for (const a of readConnectors(u.username).accounts)
        if (a.via === "login" && a.platform !== "instagram" && Date.now() - (a.pulledAt ?? 0) > EVERY_MS) void pullOne(u.username, a.key);
  }, 60 * 60_000).unref();
}

/** The project's connected channels for the Workshop folder: numbers and recent posts, newest first. */
export function channelFiles(username: string, projectId?: string): Record<string, string> {
  if (!projectId) return {};
  const files: Record<string, string> = {};
  const mine = readConnectors(username).accounts.filter((a) => a.projectId === projectId && a.platform !== "instagram" && a.posts?.length);
  for (const a of mine) {
    const s = a.stats ?? {};
    const head = [s.followers !== undefined ? `${s.followers.toLocaleString("en-US")} followers` : "", s.views !== undefined ? `${s.views.toLocaleString("en-US")} views all time` : "", a.pulledAt ? `read ${new Date(a.pulledAt).toISOString().slice(0, 10)}` : ""].filter(Boolean).join(" · ");
    const rows = (a.posts ?? []).map((p) => `| ${new Date(p.at).toISOString().slice(0, 10)} | ${p.views ?? ""} | ${p.likes ?? ""} | ${p.comments ?? ""} | ${p.shares ?? ""} | ${p.text.replace(/\s+/g, " ").replace(/\|/g, "/").slice(0, 140)} | ${p.url ?? ""} |`);
    files[`channels/${a.platform}-${a.handle.replace(/[^\w.-]/g, "_")}.md`] =
      `# ${PLATFORMS.find((p) => p.id === a.platform)!.label} @${a.handle}${a.name ? ` (${a.name})` : ""}\n${head}\n\n| date | views | likes | comments | shares | text | link |\n|---|---|---|---|---|---|---|\n${rows.join("\n")}\n`;
  }
  return files;
}

export type { SocialPlatform };
