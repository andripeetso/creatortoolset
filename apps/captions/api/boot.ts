import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { HttpBindings } from "@hono/node-server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./router";
import { createContext } from "./context";
import { aiApp } from "./ai";
import { clipAgentApp } from "./clip-agent";
import { cleanApp } from "./clean";
import { clipsApp } from "./clips";
import { documentsApp } from "./documents";
import { enhanceApp } from "./enhance";
import { exportApp, resolveFontsDir } from "./export";
import { exportsApp } from "./exports";
import { hfApp } from "./hfproxy";
import { instagramApp } from "./instagram";
import { workshopApp, workshopLibraryApp, workshopShareApp } from "./workshop";
import { reviewApp, uploadRelayApp } from "./review";
import { libraryApp } from "./library/routes";
import { collectionApp } from "./library/collections";
import { searchApp } from "./library/search";
import { publicShareApp, shareApp } from "./library/shares";
import { startLibraryWorker } from "./library/worker";
import { startTrashPurge } from "./library/trash";
import { startWatchFolders, watchApp } from "./library/watch";
import { storageApp } from "./library/usage";
import { editorApp } from "./editor/routes";
import { startEditorWorker } from "./editor/worker";
import { presetsApp } from "./presets";
import { packCatalogApp } from "./pack-catalog";
import { packsApp } from "./packs";
import { projectsApp } from "./projects";
import { storiesApp } from "./stories";
import { accountProfileApp } from "./account-profile";
import { transcribeApp } from "./transcribe";
import { authApp, getApiKeyUser, getSessionUser, innerCall, inviteApp, jobTokenUser, ruleFor, sessionOf, type AuthVars } from "./auth";
import { adminApp } from "./admin";
import { workspaceApp } from "./workspace";
import { viewAsTarget } from "./lib/view-as";
import { grantsApp } from "./library/grants";
import { assistantApp } from "./assistant";
import { automationsApp, startAutomations } from "./automations";
import { providersApp } from "./providers";
import { mcpApp } from "./mcp";
import { connectorsApp, startConnectorPulls, tiktokVerifyFile } from "./connectors";
import { ownerProfileApp } from "./owner-profile";
import { devicesApp } from "./devices";
import { connectApp } from "./connect/routes";
import { tunnelHostname } from "./connect/state";
import { deviceForToken } from "./lib/devices";
import { serviceKeysApp } from "./service-keys";
import { myKeysApp } from "./my-keys";
import { setupApp } from "./setup";
import { workPrefsApp } from "./work-prefs";
import { captionLayoutApp } from "./caption-layout";
import { mountAdminRoutes, mountAnsweredRoutes, mountGatedRoutes, mountLibraryRoutes, mountOpenRoutes, mountPlugins, mountPublicRoutes, mountReplacedRoutes, pluginBodyLimitExempt, replacedLargeBody, startPlugins } from "./lib/plugin";
import { serverPlugins } from "./plugins.gen";
import { signInCallbackApp, signInStartApp } from "./sign-in";
import { activityApp } from "./activity";
import { VISITOR, mayUse, touchActive, type Tool } from "./users";
import { env, hostedMode } from "./lib/env";
import { disableRequestTimeouts } from "./lib/incoming";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import path from "node:path";

// surface font resolution at boot — a missing dir means every render
// would silently use the wrong fonts (exports now refuse to run instead)
console.log(
  `[fonts] ${resolveFontsDir() ?? "NOT FOUND (public/fonts) — renders will be rejected"}`,
);

const app = new Hono<{ Bindings: HttpBindings; Variables: AuthVars }>();

/**
 * The names a server on this Mac (CT_LOCAL=1) answers to: loopback, the Mac's own name, its addresses and the
 * PUBLIC_ORIGIN host (a tailnet or relay name). Anything else is a page that pointed its DNS at this Mac to read it.
 */
export function localHostAllowed(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  const name = hostname().toLowerCase();
  const allowed = new Set(["localhost", "127.0.0.1", "::1", name, name.replace(/\.local$/, "") + ".local"]);
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) allowed.add(a.address.toLowerCase().replace(/%.*$/, ""));
  }
  try {
    if (process.env.PUBLIC_ORIGIN) allowed.add(new URL(process.env.PUBLIC_ORIGIN).hostname.toLowerCase().replace(/^\[|\]$/g, ""));
  } catch { /* not a URL: nothing more allowed */ }
  // a linked computer answers on its own tunnel name (api/connect); requests on it are remote (api/auth.ts viaTunnel)
  const tunnel = tunnelHostname();
  if (tunnel) allowed.add(tunnel.toLowerCase());
  return allowed.has(h);
}
/**
 * A change sent by a page from another origin (CT_LOCAL=1). Every port of 127.0.0.1 is one "site" to a browser, so
 * the SameSite=Lax cookie rides along on a form or text/plain POST from any other local web server; the Origin header
 * says where it came from. Requests with an Authorization header (API keys, the Mac's token) are no browser's.
 */
export function crossOriginWrite(method: string, url: string, origin: string | undefined, authorization: string | undefined): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(method) || origin === undefined || authorization) return false;
  if (origin === process.env.PUBLIC_ORIGIN?.replace(/\/$/, "")) return false;
  try {
    return new URL(origin).host !== new URL(url).host;
  } catch {
    return true; // "null" (a sandboxed frame, a file) or garbage
  }
}
app.use(async (c, next) => {
  // on for a Mac server (CT_LOCAL=1) and for any computer linked to the connect broker: its tunnel must not answer other names
  if (process.env.CT_LOCAL !== "1" && !tunnelHostname()) return next();
  if (!localHostAllowed(new URL(c.req.url).hostname)) return c.json({ error: "Unknown host" }, 400);
  if (crossOriginWrite(c.req.method, c.req.url, c.req.header("origin"), c.req.header("authorization"))) {
    return c.json({ error: "Sent from another site" }, 403);
  }
  return next();
});

// 50 MB body cap, except video uploads and transcription audio
const limit = bodyLimit({ maxSize: 50 * 1024 * 1024 });
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);
app.use(async (c, next) => {
  if (
    !BODY_METHODS.has(c.req.method) ||
    c.req.path.startsWith("/api/projects") ||
    c.req.path.startsWith("/api/transcribe") ||
    c.req.path.startsWith("/api/enhance") ||
    c.req.path.startsWith("/api/clean") ||
    c.req.path.startsWith("/api/clips") ||
    c.req.path.startsWith("/api/review/uploads") ||
    c.req.path.startsWith("/api/uploads/relay") ||
    c.req.path.startsWith("/api/library/uploads/") ||
    (c.req.method === "POST" && /^\/api\/workshop-share\/[^/]+\/deliveries$/.test(c.req.path)) ||
    replacedLargeBody(c.req.path) ||
    // a plug-in route that takes a large upload (plugin.ts bodyLimitExempt); the route checks its own access first
    pluginBodyLimitExempt(serverPlugins, c.req.method, c.req.path)
  ) {
    return next();
  }
  // Without a Content-Length, hono's bodyLimit re-wraps the request via
  // `new Request(...)`, which the node adapters choke on. Browser JSON
  // fetches always declare a length; refuse chunked bodies and let
  // body-less POSTs (logout) through untouched.
  if (!c.req.raw.headers.has("content-length")) {
    return c.req.raw.headers.has("transfer-encoding")
      ? c.json({ error: "Length Required" }, 411)
      : next();
  }
  return limit(c, next);
});

const PUBLIC_UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PUBLIC_CLIP_GET = new RegExp(
  `^/api/clips/${PUBLIC_UUID}(?:/(?:play|thumb|transcript))?$`,
  "i",
);
const PUBLIC_AGENT_GET =
  /^\/api\/agent-(?:context\.json|transcript\.json|frame\.jpg)$/;
const PUBLIC_DOC_GET = new RegExp(
  `^/api/documents/${PUBLIC_UUID}(?:/assets/[a-z0-9-]+\\.jpe?g)?$`,
  "i",
);
// Content Workshop share links (workshop.ts workshopShareApp): the shared pieces' text and layouts, no account
const PUBLIC_WORKSHOP = new RegExp(`^/api/workshop-share/${PUBLIC_UUID}(?:/deliveries/${PUBLIC_UUID}|/deliveries\\.zip)?$`, "i");
// …and what a freelancer does on it: mark progress, upload the finals (2 GB each, streamed)
const PUBLIC_WORKSHOP_WRITE = new RegExp(`^/api/workshop-share/${PUBLIC_UUID}/(?:progress|deliveries)$`, "i");
// review share links (a video or a project): reviewers read, comment and approve without an account
export const PUBLIC_REVIEW = new RegExp(`^/api/review/[sp]/${PUBLIC_UUID}(?:/|$)`, "i");
// Media Library share links (api/library/shares.ts): the shared view and its media, and the password unlock
const PUBLIC_LIBRARY_SHARE = /^\/api\/library\/s\/[A-Za-z0-9_-]{22}(?:\/|$)/;
const PUBLIC_LIBRARY_SHARE_WRITE = /^\/api\/library\/s\/[A-Za-z0-9_-]{22}\/unlock$/;
const REVIEW = /^\/api\/review(?:\/|$)/;
const REVIEW_COMMENT = new RegExp(`^/api/review/assets/${PUBLIC_UUID}/comments/[^/]+$`, "i");
export const REVIEW_UPLOAD = new RegExp(`^/api/review/uploads(?:/${PUBLIC_UUID}/(?:parts/\\d+|complete))?$`, "i");
// the upload relay (review.ts uploadRelayApp): the same calls as REVIEW_UPLOAD, on the route the relay setting names. Login
// is required (not exempt); an AI key may upload the same way it uploads a video. Golden test: review-exempt.test.ts.
export const UPLOAD_RELAY = new RegExp(`^/api/uploads/relay(?:/${PUBLIC_UUID}/(?:parts/\\d+|complete))?$`, "i");
// what an AI access key may call, route by route: Review reads, resolving a comment and uploading a
// video or a new version (a final cut) for any account.
const KEY_ROUTES: [string, RegExp][] = [["GET", REVIEW], ["PATCH", REVIEW_COMMENT], ["POST", REVIEW_UPLOAD], ["POST", UPLOAD_RELAY]];
const FULL_KEY_NEVER = /^\/api\/(?:admin|workspace|providers|devices|service-keys|my-keys)(?:\/|$)/;
const keyRoute = (routes: [string, RegExp][], method: string, p: string) =>
  routes.some(([m, r]) => m === method && r.test(p));

// Apps switched off per account (users.ts `off`). The others are
// only hidden in the app: what they hold is the user's own either way, and
// their APIs serve each other (Review and Guides play Video Notes).
export const TOOL_GATES: [string, Tool[]][] = [
  ["/api/enhance", ["enhance"]],
  ["/api/clean", ["clean"]],
  ["/api/library", ["media"]],
  ["/api/editor", ["editor"]],
  // the Analyzer and the Workshop read each other's APIs
  ["/api/instagram", ["instagram", "workshop"]],
  ["/api/workshop", ["instagram", "workshop"]],
];

let environmentId = "";
/** This data folder's id (DATA_DIR/environment.json), made once: the Mac app tells its own server from another program. */
export function environmentOf(): string {
  if (environmentId) return environmentId;
  const file = path.join(env.dataDir, "environment.json");
  try {
    environmentId = (JSON.parse(readFileSync(file, "utf8")) as { id?: string }).id ?? "";
  } catch { /* first start */ }
  if (!environmentId) {
    environmentId = randomUUID();
    mkdirSync(env.dataDir, { recursive: true });
    writeFileSync(file, JSON.stringify({ id: environmentId }));
  }
  return environmentId;
}

// the deploy's readiness check (scripts/deploy.sh): before the account gate, nothing about users or secrets
app.get("/api/health", (c) =>
  c.json({
    ok: true,
    environment: environmentOf(),
    uptimeSec: Math.round(process.uptime()),
    rssMb: Math.round(process.memoryUsage().rss / 1048576),
  }),
);

// plug-ins' open routes (machine callers with their own check): before the account gate, as the health check is
mountOpenRoutes(app, serverPlugins);
// hosted mode only: Apple / Google sign-in to a site account and linking one (sign-in.ts). A sign-in a plug-in started falls through.
if (hostedMode()) {
  app.route("/api/account", signInStartApp);
  app.route("/api/auth", signInCallbackApp);
}
// plug-ins' public routes (plugins/<id>/plugin.ts publicRoutes): before the account gate, each checks its own access
mountPublicRoutes(app, serverPlugins);

// account gate (active only when APP_SECRET is set — see api/auth.ts)
app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/auth")) return next();
  // an app Mac's relay (devices.ts): its ctd_ token only, never a cookie
  if (c.req.path.startsWith("/api/devices/relay/")) {
    if (!deviceForToken(c.req.header("authorization"))) return c.json({ error: "Unauthorized" }, 401);
    return next();
  }
  // a Full AI key is the account itself, gates and all,
  // except AI settings, paired Macs and keys; /api/auth reads only cookies, so a key never makes keys
  // The assistant's job token (auth.ts) opens /api/mcp only; the tools' own calls run as its account (innerCall), and
  // FULL_KEY_NEVER still refuses them the provider, device and key routes.
  const signedIn = getSessionUser(c.req.header("cookie")) ??
    (FULL_KEY_NEVER.test(c.req.path)
      ? null
      : getApiKeyUser(c.req.header("authorization"), "full") ??
        (c.req.path === "/api/mcp" ? jobTokenUser(c.req.header("authorization")) : null) ??
        innerCall.getStore() ?? null);
  // view-as (hosted): a platform admin reads the app as another account, read-only. The admin's own routes and the
  // sign-in routes stay the admin's; any write while viewing is refused.
  const viewed =
    hostedMode() && signedIn?.role === "admin" && !/^\/api\/(?:admin|auth)(?:\/|$)/.test(c.req.path)
      ? viewAsTarget(c.req.header("cookie"))
      : null;
  if (viewed && c.req.method !== "GET" && c.req.method !== "HEAD") {
    return c.json({ error: `Viewing as ${viewed.username}: read-only`, code: "VIEW_AS" }, 403);
  }
  const user = viewed ? sessionOf(viewed) : signedIn;
  if (
    c.req.method === "GET" &&
    (PUBLIC_CLIP_GET.test(c.req.path) ||
      PUBLIC_LIBRARY_SHARE.test(c.req.path) ||
      PUBLIC_AGENT_GET.test(c.req.path) ||
      PUBLIC_DOC_GET.test(c.req.path) ||
      PUBLIC_WORKSHOP.test(c.req.path))
  ) {
    c.set("user", user ?? VISITOR);
    if (user) touchActive(user.username);
    return next();
  }
  if (c.req.method === "POST" && (PUBLIC_WORKSHOP_WRITE.test(c.req.path) || PUBLIC_LIBRARY_SHARE_WRITE.test(c.req.path))) {
    c.set("user", user ?? VISITOR);
    return next();
  }
  if (PUBLIC_REVIEW.test(c.req.path)) {
    c.set("user", user ?? VISITOR);
    return next();
  }
  if (!user) {
    // an AI access key: KEY_ROUTES only (review.ts refuses text edits from it)
    const keyUser = keyRoute(KEY_ROUTES, c.req.method, c.req.path)
      ? getApiKeyUser(c.req.header("authorization"))
      : null;
    if (!keyUser) return c.json({ error: "Unauthorized" }, 401);
    // same rule as a signed-in user below: an unlinked member's AI key doesn't get past the team's sign-in
    if (ruleFor(keyUser.username)?.missing) {
      return c.json({ error: "Your team signs in with Google or Apple: link one in Settings → Account", code: "LINK_SIGNIN" }, 403);
    }
    c.set("user", keyUser);
    return next();
  }
  // the team signs in with Google / Apple and this account has neither linked: only /api/auth until it links one
  if (ruleFor(user.username)?.missing) {
    return c.json({ error: "Your team signs in with Google or Apple: link one in Settings → Account", code: "LINK_SIGNIN" }, 403);
  }
  const gate = TOOL_GATES.find(([p]) => c.req.path === p || c.req.path.startsWith(p + "/"));
  if (gate && !gate[1].some((t) => mayUse(user, t))) {
    return c.json({ error: "This app isn't switched on for your account", code: "TOOL_ACCESS" }, 403);
  }
  c.set("user", user);
  if (!viewed) touchActive(user.username);
  return next();
});
app.route("/api/auth", authApp);
// Settings → API keys: the outside services' keys (platform admins; never an AI key)
app.route("/api/service-keys", serviceKeysApp);
// Settings → My API keys: each account's own keys for the paid services (never through an AI key)
app.route("/api/my-keys", myKeysApp);
// first-run setup and Settings → Setup: my tools, my plan, what is set up (setup.ts)
app.route("/api/setup", setupApp);
// how a person wants to work: in the app, in their own AI, or both (contracts/work-prefs.ts)
app.route("/api/work-prefs", workPrefsApp);
app.route("/api/providers", providersApp);
// Creator Toolset as a remote MCP server (Full key only: not on the key routes): its tools call these same routes
app.route("/api/mcp", mcpApp((path, init) => Promise.resolve(app.request(path, init)), serverPlugins));
app.route("/api/assistant", assistantApp);
// automations (automations.ts): scheduled prompts for the account's own assistant; REST here, and the MCP tools in mcp.ts
app.route("/api/automations", automationsApp);
startAutomations();
app.route("/api/connectors", connectorsApp);
// TikTok's site check (TIKTOK_VERIFY_FILE / TIKTOK_VERIFY_CONTENT in .env): a public file at the root while the app is registered
app.get("/:file{tiktok[\\w-]*\\.txt}", (c) => {
  const text = tiktokVerifyFile(c.req.param("file"));
  return text === null ? c.notFound() : c.text(text);
});
startConnectorPulls();
app.route("/api/devices", devicesApp);
// Settings → Connect: link this computer to the account on the connect broker (api/connect/routes.ts)
app.route("/api/connect", connectApp);
// the menu bar panel's rows from plug-ins (activity.ts)
app.route("/api/activity", activityApp(serverPlugins));
// the Mac app's signed-in account as this server's owner (owner-profile.ts)
app.route("/api/owner-profile", ownerProfileApp);
app.use("/api/trpc/*", async (c) => {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext,
  });
});
app.route("/api/ai", aiApp);
app.route("/api/captions", captionLayoutApp);
// a plug-in that answers old or plug-in paths first (the Analyzer, the old /api/media, /api/enhance and /api/review routes):
// before the built-in routers of those paths take them, and after the account gate above
mountAnsweredRoutes(app, serverPlugins);
app.route("/api/exports", exportsApp);
app.route("/api/export", exportApp);
app.route("/api/hf", hfApp);
app.route("/api/presets", presetsApp);
app.route("/api/packs", packsApp);
app.route("/api/pack-catalog", packCatalogApp);
app.route("/api/projects", projectsApp);
app.route("/api/enhance", enhanceApp);
app.route("/api/clean", cleanApp);
app.route("/api", clipAgentApp);
app.route("/api/clips", clipsApp);
app.route("/api/documents", documentsApp);
app.route("/api/transcribe", transcribeApp);
app.route("/api/instagram", instagramApp);
app.route("/api/workshop", workshopApp);
app.route("/api/workshop-share", workshopShareApp);
app.route("/api/review", reviewApp);
// the upload relay (review.ts): the server picks chunked or direct (CT_UPLOAD_RELAY), and the browser asks it
app.route("/api/uploads/relay", uploadRelayApp);
// the public share routes first: their /s/:token must not be read as another library route
// Finals share links kept from the old app (/fs/<token>): the same token, so the same link page (/library/s/<token>)
app.get("/fs/:token", (c, next) => {
  const token = c.req.param("token");
  // the old app's links are UUIDs (finals-shares.json): those fall through to the app's page for the link, which reads
  // /api/finals-share/:token; a 22-character Media Library token is redirected as before
  if (!/^[A-Za-z0-9_-]{22}$/.test(token)) return next();
  return c.redirect(`/library/s/${token}`, 308);
});
// plug-ins' Media Library routes first: a plug-in can answer an old path the core library also serves
mountLibraryRoutes(app, serverPlugins);
app.route("/api/library", publicShareApp);
app.route("/api/library", libraryApp);
app.route("/api/library", workshopLibraryApp);
app.route("/api/library", shareApp);
app.route("/api/library", collectionApp);
app.route("/api/library", searchApp);
app.route("/api/library", watchApp);
app.route("/api/library", storageApp);
app.route("/api/library", grantsApp);
// a plug-in that replaces the AI Editor answers its root paths first (the old URLs the Mac worker posts to)
mountReplacedRoutes(app, serverPlugins);
app.route("/api/editor", editorApp);
// the library's worker: probes, thumbs and proxies queued uploads; and the trash purge (not under tests, which call them)
if (process.env.NODE_ENV !== "test") {
  startLibraryWorker();
  startEditorWorker();
  startTrashPurge();
  startWatchFolders();
  startPlugins(serverPlugins);
}
app.route("/api/stories", storiesApp);
app.route("/api/account-profile", accountProfileApp);
// plug-ins (plugins/<id>/plugin.ts, generated into api/plugins.gen.ts) mount under /api/x/<id>, behind the same login
mountPlugins(app, serverPlugins);
mountGatedRoutes(app, serverPlugins);
// hosted mode only (CT_MODE=hosted): the platform admin, the team and invite links. On one person's Mac they don't exist.
if (hostedMode()) {
  // Unset, the pack catalog proxies to creatortoolset.com, which may be this server calling itself. A warning, not a refusal.
  if (process.env.PACK_CATALOG_URL === undefined && process.env.NODE_ENV !== "test") {
    console.warn("CT_MODE=hosted but PACK_CATALOG_URL is unset: set it empty on a server that serves the pack catalog itself");
  }
  mountAdminRoutes(app, serverPlugins);
  app.route("/api/admin", adminApp);
  app.route("/api/workspace", workspaceApp);
  app.route("/api/auth", inviteApp);
}
app.all("/api/*", (c) => c.json({ error: "Not Found" }, 404));

export default app;

/** Why production must not start, or null. Without APP_SECRET every request is the admin (auth.ts getSessionUser). */
export const startupProblem = (): string | null =>
  env.isProduction && !env.appSecret ? "APP_SECRET is required in production: without it every request is the admin" : null;

/** CT_EXIT_WITH_PARENT=1: the Mac app holds our stdin, so it closing means the app is gone (macOS has no parent-death signal). */
export function exitWithParent(stdin: NodeJS.ReadableStream, exit: () => void): void {
  stdin.on("end", exit);
  stdin.on("close", exit);
  stdin.resume();
}

if (env.isProduction) {
  const problem = startupProblem();
  if (problem) throw new Error(problem);
  const { serve } = await import("@hono/node-server");
  const { serveStaticFiles } = await import("./lib/vite");
  serveStaticFiles(app);

  const port = parseInt(process.env.PORT || "3000");
  // HOST: the interface to listen on (the Mac app passes 127.0.0.1); unset = every interface, as in Docker
  const host = process.env.HOST || undefined;
  const server = serve(
    {
      fetch: app.fetch,
      port,
      hostname: host,
      serverOptions: { requestTimeout: 0, headersTimeout: 0 },
    },
    () => {
      console.log(`Server running on http://${host ?? "localhost"}:${port}/`);
    },
  );
  if ("requestTimeout" in server) disableRequestTimeouts(server);
  if (process.env.CT_EXIT_WITH_PARENT === "1") exitWithParent(process.stdin, () => process.exit(0));
}
