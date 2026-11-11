import { Hono } from "hono";
import { escHtml, plainPage } from "./lib/plain-page";
import type { Context } from "hono";
import { getSessionUser, sessionOf, type AuthVars } from "./auth";
import { env } from "./lib/env";
import { keyFor } from "./my-keys";
import { LOGINS, PLATFORMS, type ConnectorsView, type OwnInstagram, type LoginKind, type SocialPlatform, type SocialVideo } from "../contracts/connectors";
import { accountsFromGrant, finishLogin, freshToken, loginUrl, pullAccount, refreshGrant } from "./lib/connectors/platforms";
import { issuerFor, loginsHere, serviceRedeem, serviceRefresh, serviceStart, viaService, type Issuer } from "./lib/connectors/signin-service";
import { sessionSources } from "./lib/connectors/provider";
import { printPosts } from "./lib/connectors/prints";
import { findAccount, newState, patchAccount, publicAccount, readConnectors, removeAccount, saveAccounts, type StoredAccount } from "./lib/connectors/store";
import { publicApifyStatus, readApify } from "./lib/instagram/apify";
import { addLoginAccount, allAccounts } from "./instagram";
import { accountProjects } from "./lib/workshop/workspace";
import { announce } from "./lib/sync";
import { findUser, listUsers, LOCAL_USER, type SessionUser } from "./users";

/**
 * Settings → Connectors: each person connects their own social accounts. Logins (Meta, Google,
 * TikTok) read their own numbers through our registered apps; anything else is read by handle on their own Apify
 * token, so we never pay for anyone's scraping. Tokens stay in $DATA_DIR/connectors/<user>.json.
 */
export const connectorsApp = new Hono<{ Variables: AuthVars }>();

const KINDS: LoginKind[] = ["meta", "google", "tiktok"];
const STATE_MS = 15 * 60_000;
const states = new Map<string, { user: string; kind: LoginKind; issuer: Issuer; projectId?: string; verifier?: string; at: number; back: string }>();

const nobody = (u: SessionUser) => u.role === "visitor";

/** Where a login sends people back: PUBLIC_ORIGIN in production (the apps register this exact URL), else this host. */
function redirectFor(c: Context, kind: LoginKind): string {
  // a proxy in front passes Host and X-Forwarded-Proto (not X-Forwarded-Host)
  const url = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const origin = process.env.PUBLIC_ORIGIN?.replace(/\/$/, "") || `${proto}://${url.host}`;
  return `${origin}/api/connectors/callback/${kind}`;
}

async function view(c: Context<{ Variables: AuthVars }>): Promise<ConnectorsView> {
  const user = c.get("user");
  const apify = publicApifyStatus(await readApify(user.username));
  return {
    // known without asking the sign-in service: it is asked when the person presses Add (/apps/:kind), never for a list
    logins: loginsHere(),
    viaService: viaService(),
    instagram: await ownInstagram(user.username),
    apify: { configured: apify.configured, valid: apify.valid },
    youtubeKey: !!keyFor(user, "YOUTUBE_API_KEY").key,
    accounts: readConnectors(user.username).accounts.map(publicAccount),
    extras: { sessions: sessionSources() },
  };
}

/** The person's own Instagram in the Analyzer: the account marked Mine and each one a project links as its Instagram. */
async function ownInstagram(username: string): Promise<OwnInstagram[]> {
  const links = await accountProjects(username);
  return (await allAccounts())
    .filter((a) => a.owner === username && (a.mine || links.has(a.id)))
    .map((a) => ({ id: a.id, handle: a.username, followers: a.counts.followers, mine: !!a.mine, projectId: links.get(a.id) }));
}

connectorsApp.get("/", async (c) => c.json(await view(c)));

/**
 * Is this platform's sign-in on, asked when a person presses Add: this server's own app (.env; the keys never leave it)
 * answers at once, else the sign-in service is asked whether it offers the platform.
 */
connectorsApp.get("/apps/:kind", async (c) => {
  const kind = c.req.param("kind") as LoginKind;
  if (nobody(c.get("user"))) return c.json({ error: "Connect accounts from your own account" }, 403);
  if (!KINDS.includes(kind)) return c.json({ error: "Unknown login" }, 404);
  return c.json({ on: !!(await issuerFor(kind)) });
});

/** TikTok's "verify URL ownership" file, at the site's root (boot.ts mounts this before the app). .env: TIKTOK_VERIFY_FILE + TIKTOK_VERIFY_CONTENT. */
export function tiktokVerifyFile(name: string): string | null {
  const file = process.env.TIKTOK_VERIFY_FILE?.trim();
  const content = process.env.TIKTOK_VERIFY_CONTENT?.trim();
  return file && content && file === name ? content : null;
}

/** Start a login: the page to open (the browser goes there and comes back to /callback). */
connectorsApp.get("/login/:kind", async (c) => {
  const user = c.get("user");
  const kind = c.req.param("kind") as LoginKind;
  if (nobody(user)) return c.json({ error: "Connect accounts from your own account" }, 403);
  if (!KINDS.includes(kind)) return c.json({ error: "Unknown login" }, 404);
  const issuer = await issuerFor(kind);
  if (!issuer) return c.json({ error: `${LOGINS.find((l) => l.id === kind)!.label} login isn't set up on this server yet` }, 409);
  const state = newState();
  // the service's start page, or the platform's own login with this server's app
  const { url, verifier } = issuer === "service" ? serviceStart(kind, redirectFor(c, kind), state) : loginUrl(kind, redirectFor(c, kind), state);
  for (const [k, v] of states) if (Date.now() - v.at > STATE_MS) states.delete(k);
  const back = c.req.query("back")?.startsWith("/") && !c.req.query("back")!.startsWith("//") ? c.req.query("back")! : "/settings/connectors";
  states.set(state, { user: user.username, kind, issuer, projectId: c.req.query("projectId") || undefined, verifier, at: Date.now(), back });
  return c.redirect(url);
});

/**
 * The platform's (or the sign-in service's) way back. Mounted before the account gate (boot.ts): the Mac app opens a
 * sign-in in the computer's browser (platforms refuse sign-in inside an app's web view), where this server's session
 * cookie is not. The state names the account that started it (single use, 15 minutes), so the account is saved for
 * that person either way; a browser without their session gets a page that sends them back to the app.
 */
export const connectorsCallbackApp = new Hono();

connectorsCallbackApp.get("/callback/:kind", async (c) => {
  const st = states.get(c.req.query("state") ?? "");
  const kind = c.req.param("kind") as LoginKind;
  // the browser that started it has the person's session: back to Settings with the result; any other gets a page
  // (an own computer with no sign-in opens Settings in any browser)
  const who = getSessionUser(c.req.header("cookie"));
  const here = !env.appSecret || (st ? who?.username === st.user : !!who);
  const to = st?.back ?? "/settings/connectors";
  const back = (q: string) => {
    if (here) return c.redirect(`${to}${to.includes("?") ? "&" : "?"}${q}`);
    const p = new URLSearchParams(q);
    return p.get("connected") ? c.html(plainPage("Connected", "You can close this tab. Creator Toolset already has the account, in Settings → Social accounts.")) : c.html(plainPage("Not connected", escHtml(p.get("error") ?? "")), 400);
  };
  if (!st || st.kind !== kind || Date.now() - st.at > STATE_MS) return back(`error=${encodeURIComponent("That login expired: start it again")}`);
  const user = st.user;
  states.delete(c.req.query("state")!);
  const denied = c.req.query("error_description") || c.req.query("error");
  if (denied) return back(`error=${encodeURIComponent(denied)}`);
  try {
    // through the service the platform's code was swapped on the site: this install redeems its ticket with the verifier
    const got = st.issuer === "service" ? await accountsFromGrant(kind, await serviceRedeem(c.req.query("ticket") ?? "", st.verifier!)) : await finishLogin(kind, c.req.query("code") ?? "", redirectFor(c, kind), st.verifier);
    // connectedAt is this sign-in's moment, also for an account that was connected before: the page that started it
    // (often in another window: the Mac app sends the sign-in to the computer's browser) knows by it that it finished
    const saved = saveAccounts(user, got.map((a) => ({ ...a, connectedAt: Date.now(), issuer: st.issuer, loginStatus: "connected" as const, pullError: undefined, ...(st.projectId ? { projectId: st.projectId } : {}) })));
    // told to the person's open windows now, since this way back is no write of theirs (no session, a GET)
    announce(user, "connectors");
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

/**
 * Read one account now. An Instagram login is also handed to the Analyzer once (its deep view: catalog, comments);
 * the numbers and posts come from the login itself, through the reader registry, with or without the Analyzer.
 */
async function pullOne(user: SessionUser | string, key: string): Promise<void> {
  const name = typeof user === "string" ? user : user.username;
  const a = findAccount(name, key);
  if (!a || pulling.has(`${name}/${key}`)) return;
  pulling.add(`${name}/${key}`);
  try {
    if (a.platform === "instagram" && !a.analyzerId) {
      const rec = typeof user === "string" ? findUser(user) : null;
      const who = typeof user !== "string" ? user : rec ? sessionOf(rec) : user === LOCAL_USER.username ? LOCAL_USER : null;
      const analyzerId = who ? await addLoginAccount(who, a.handle, a.projectId) : undefined;
      if (analyzerId) patchAccount(name, key, { analyzerId });
    }
    if (a.via === "login" && a.expiresAt && a.expiresAt <= Date.now() && !a.refresh) {
      patchAccount(name, key, { loginStatus: "needs_reconnect", pullError: "The login expired. Connect it again.", pulledAt: Date.now() });
      return;
    }
    const fresh = a.via === "login" ? await freshToken(a, a.issuer === "service" ? serviceRefresh : refreshGrant) : {};
    if (fresh.token !== a.token) patchAccount(name, key, fresh); // TikTok's refresh token changes on every refresh: keep the new one at once
    const got = await pullAccount({ ...a, ...fresh } as StoredAccount, name);
    patchAccount(name, key, { stats: got.stats, posts: got.posts.sort((x, y) => y.at - x.at).slice(0, 100), ...(got.videos ? { videos: got.videos } : {}), ...(got.snapshots ? { snapshots: got.snapshots } : {}), ...(got.daily ? { daily: got.daily } : {}), name: got.name || a.name, avatar: got.avatar || a.avatar, pulledAt: Date.now(), pullError: undefined, loginStatus: "connected" });
    // the posts' videos are fingerprinted while their media URLs are fresh (in the background, like the Analyzer hand-off)
    void printPosts(name, key);
  } catch (e) {
    patchAccount(name, key, { pullError: (e instanceof Error ? e.message : String(e)).slice(0, 300), pulledAt: Date.now(), loginStatus: "error" });
  } finally {
    pulling.delete(`${name}/${key}`);
    // the numbers (or the reason there are none) are in: the open windows read the list again
    announce(name, "connectors");
  }
}

/** Logins are read every 12 hours (free, official APIs); handles only when asked (each run costs the user's Apify). */
const EVERY_MS = 12 * 60 * 60_000;
export function startConnectorPulls(): void {
  if (process.env.NODE_ENV === "test") return;
  setInterval(() => {
    for (const u of listUsers())
      for (const a of readConnectors(u.username).accounts)
        if (a.via === "login" && a.loginStatus !== "needs_reconnect" && Date.now() - (a.pulledAt ?? 0) > EVERY_MS) void pullOne(u.username, a.key);
  }, 60 * 60_000).unref();
}

const KIND_LABEL: Record<string, string> = { SHORTS: "Shorts", VIDEO_ON_DEMAND: "Long videos", LIVE_STREAM: "Live streams" };

/** A channel's every video, grouped by kind (Shorts, long videos, live streams) with the newest videos' retention at 25, 50 and 75% of the length. */
function videosFile(title: string, videos: SocialVideo[]): string {
  const kinds = new Map<string, SocialVideo[]>();
  for (const v of videos) kinds.set(v.kind, [...(kinds.get(v.kind) ?? []), v]);
  const sum = (vs: SocialVideo[], k: "views" | "watchMinutes") => vs.reduce((n, v) => n + (v[k] ?? 0), 0).toLocaleString("en-US");
  const summary = [...kinds].map(([k, vs]) => `${KIND_LABEL[k] ?? k}: ${vs.length} videos, ${sum(vs, "views")} views, ${sum(vs, "watchMinutes")} watch minutes`);
  // the first retention point at or past the share of the video, as the watch ratio (1 = the audience's average)
  const at = (v: SocialVideo, share: number) => v.retention?.find((r) => r.elapsed >= share)?.watch?.toFixed(2) ?? "";
  const rows = videos.map((v) => `| ${KIND_LABEL[v.kind] ?? v.kind} | ${v.views ?? ""} | ${v.watchMinutes ?? ""} | ${v.averageViewSeconds ?? ""} | ${v.averageViewPercent ?? ""} | ${v.likes ?? ""} | ${v.comments ?? ""} | ${v.shares ?? ""} | ${at(v, 0.25)} | ${at(v, 0.5)} | ${at(v, 0.75)} | https://www.youtube.com/watch?v=${v.id} |`);
  return `${title} · every video, all time\n${summary.join("\n")}\n\nRetention columns: the audience watch ratio 25%, 50% and 75% into the video, newest videos only.\n\n| kind | views | watch min | avg view s | avg view % | likes | comments | shares | ret 25% | ret 50% | ret 75% | link |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n${rows.join("\n")}\n`;
}

/** The project's connected channels for the Workshop folder: numbers and recent posts, newest first. */
export function channelFiles(username: string, projectId?: string): Record<string, string> {
  if (!projectId) return {};
  const files: Record<string, string> = {};
  const mine = readConnectors(username).accounts.filter((a) => a.projectId === projectId && a.platform !== "instagram" && (a.posts?.length || a.videos?.length));
  for (const a of mine) {
    const s = a.stats ?? {};
    const head = [s.followers !== undefined ? `${s.followers.toLocaleString("en-US")} followers` : "", s.views !== undefined ? `${s.views.toLocaleString("en-US")} views all time` : "", a.pulledAt ? `read ${new Date(a.pulledAt).toISOString().slice(0, 10)}` : ""].filter(Boolean).join(" · ");
    const base = `channels/${a.platform}-${a.handle.replace(/[^\w.-]/g, "_")}`;
    const title = `# ${PLATFORMS.find((p) => p.id === a.platform)!.label} @${a.handle}${a.name ? ` (${a.name})` : ""}`;
    const rows = (a.posts ?? []).map((p) => `| ${new Date(p.at).toISOString().slice(0, 10)} | ${p.views ?? ""} | ${p.likes ?? ""} | ${p.comments ?? ""} | ${p.shares ?? ""} | ${p.text.replace(/\s+/g, " ").replace(/\|/g, "/").slice(0, 140)} | ${p.url ?? ""} |`);
    if (a.posts?.length) files[`${base}.md`] = `${title}\n${head}\n\n| date | views | likes | comments | shares | text | link |\n|---|---|---|---|---|---|---|\n${rows.join("\n")}\n`;
    if (a.videos?.length) files[`${base}-videos.md`] = videosFile(title, a.videos);
  }
  return files;
}

export type { SocialPlatform };
