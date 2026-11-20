import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { HttpBindings } from "@hono/node-server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./router";
import { createContext } from "./context";
import { aiApp } from "./ai";
import { clipAgentApp } from "./clip-agent";
import { clipsApp, resumeStoppedClips } from "./clips";
import { documentsApp } from "./documents";
import { enhanceApp, enhancesAtRisk } from "./enhance";
import { resolveFontsDir } from "./export";
import { exportsApp, exportsAtRisk, resumeFinalsSends } from "./exports";
import { hfApp } from "./hfproxy";
import { instagramApp } from "./instagram";
import { workshopApp, workshopLibraryApp, workshopShareApp } from "./workshop";
import { reviewApp, uploadRelayApp } from "./review";
import { libraryApp } from "./library/routes";
import { copiesApp } from "./library/copies";
import { uploadTargetApp } from "./library/upload-target";
import { collectionApp } from "./library/collections";
import { sfxApp } from "./library/sfx";
import { searchApp } from "./library/search";
import { relatedApp } from "./library/related";
import { publicShareApp, shareApp } from "./library/shares";
import { libraryJobsAtRisk, releaseRunningJobs, startLibraryWorker } from "./library/worker";
import { clearHeldStills } from "./library/on-mac";
import { killProcesses } from "./library/media/run";
import { startTrashPurge } from "./library/trash";
import { startWatchFolders, watchApp } from "./library/watch";
import { storageApp } from "./library/usage";
import { editorApp } from "./editor/routes";
import { nleBridgeApp } from "./editor/nle-bridge";
import { editStepsApp } from "./editor/steps";
import { foldersApp } from "./folders";
import { editorStepsAtRisk, releaseRunningSteps, startEditorWorker } from "./editor/worker";
import { serverWorkApp } from "./work/server-work-routes";
import { serverUpdateApp } from "./server-update";
import { migrateOwnerChoices, settleServerWork } from "./work/server-work";
import { migrateLibraries, migrateOnce } from "./library/migrate";
import { fixPlaceRows } from "./library/place-rows";
import { foldersOf } from "./editor/reach";
import { checkWaits } from "./work/waits";
import { startTaskTick, sweepTasks } from "./work/tasks";
import "./work/task-kinds";
import { presetsApp } from "./presets";
import { packCatalogApp } from "./pack-catalog";
import { packsApp } from "./packs";
import { skillsApp } from "./skills";
import { projectsApp } from "./projects";
import { designsApp } from "./designs";
import { storiesApp } from "./stories";
import { accountProfileApp } from "./account-profile";
import { reportCrash, startTelemetry, telemetryApp } from "./lib/telemetry";
import { transcribeApp } from "./transcribe";
import { authApp, getApiKeyUser, innerCall, inviteApp, jobTokenUser, ruleFor, sessionOf, viaTunnel, type AuthVars } from "./auth";
import { adminApp } from "./admin";
import { workspaceApp } from "./workspace";
import { viewAsTarget } from "./lib/view-as";
import { grantsApp } from "./library/grants";
import { bulkApp } from "./library/bulk";
import { assistantApp, resumeFromDisk } from "./assistant";
import { answersAtRisk, leave } from "./lib/mac-claude";
import { captionJobsAtRisk } from "./captions-job";
import { sweepAll, uploadLinkApp } from "./assistant-files";
import { memoryApp } from "./memory";
import { automationsApp, startAutomations } from "./automations";
import { providersApp } from "./providers";
import { mcpApp, pluginToolsOf } from "./mcp";
import { connectorsApp, connectorsCallbackApp, startConnectorPulls, tiktokVerifyFile } from "./connectors";
import { ownerProfileApp } from "./owner-profile";
import { devicePairApp, devicesApp } from "./devices";
import { connectApp } from "./connect/routes";
import { phoneNotifyApp } from "./connect/activity";
import { connectPublicApp } from "./connect/mint";
import { computerKey } from "./connect/keys";
import { mediaTicketApp } from "./media-ticket";
import { authClientsApp, callerOf, oauthTokenApp, scopeFor, scopeRefused, sessionRefused } from "./auth-clients";
import { allowedPeer, descriptorApp, endpointsApp, listensEverywhere } from "./descriptor";
import { connectState, tunnelHostname } from "./connect/state";
import { startConnector } from "./connect/connector";
import { deviceForToken } from "./lib/devices";
import { serviceKeysApp } from "./service-keys";
import { myKeysApp } from "./my-keys";
import { setupApp } from "./setup";
import { workPrefsApp } from "./work-prefs";
import { voicePrefsApp } from "./voice-prefs";
import { captionLayoutApp } from "./caption-layout";
import { mountAdminRoutes, mountAnsweredRoutes, mountGatedRoutes, mountLibraryRoutes, mountOpenRoutes, mountPlugins, mountPluginsList, mountPublicRoutes, mountReplacedRoutes, pluginBodyLimitExempt, replacedLargeBody, startPlugins } from "./lib/plugin";
import { serverPlugins } from "./plugins.gen";
import { clearLoadingMark, loadFolderPlugins, mountFolderPlugins, startFolderPlugin } from "./lib/folder-plugins";
import { announceWrites, syncApp } from "./lib/sync";
import { inRequestWorkspace } from "./lib/workspace-scope";
import { guardPlugins, pluginGuard, pluginWorkspacesApp } from "./lib/plugin-workspaces";
import { signInCallbackApp, signInStartApp } from "./sign-in";
import { mcpChallenge, oauthApp } from "./oauth";
import { cardApp } from "./mcp-cards";
import { activityApp } from "./activity";
import { VISITOR, mayChange, mayUse, touchActive, type Tool } from "./users";
import { env, hostedMode } from "./lib/env";
import { disableRequestTimeouts } from "./lib/incoming";
import { randomUUID } from "node:crypto";
import { TOOL_NAMES } from "../contracts/tools";
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
  // without APP_SECRET every request is the admin (getSessionUser): a tunnel must never serve that to the internet
  if (!env.appSecret && viaTunnel(c)) return c.json({ error: "Set APP_SECRET on this computer before it answers on the tunnel" }, 403);
  if (crossOriginWrite(c.req.method, c.req.url, c.req.header("origin"), c.req.header("authorization"))) {
    return c.json({ error: "Sent from another site" }, 403);
  }
  return next();
});

// 50 MB body cap, except video uploads and transcription audio
const MAX_BODY = 50 * 1024 * 1024;
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);
app.use(async (c, next) => {
  if (
    !BODY_METHODS.has(c.req.method) ||
    c.req.path.startsWith("/api/projects") ||
    c.req.path.startsWith("/api/transcribe") ||
    c.req.path.startsWith("/api/enhance") ||
    c.req.path.startsWith("/api/clips") ||
    c.req.path.startsWith("/api/review/uploads") ||
    c.req.path.startsWith("/api/uploads/relay") ||
    c.req.path.startsWith("/api/library/uploads/") ||
    // a file a device made for a plug-in's job (devices.ts): the device token is checked before it is read
    (c.req.method === "POST" && /^\/api\/devices\/relay\/job\/[^/]+\/\d+\/file$/.test(c.req.path)) ||
    // a computer task's made file (capped at the route) and a call carrying its sound (work/tasks.ts): the device token is checked first
    /^\/api\/devices\/relay\/work\/task\/\d+\/(?:file|call\/[\w-]+)$/.test(c.req.path) ||
    (c.req.method === "POST" && /^\/api\/workshop-share\/[^/]+\/deliveries$/.test(c.req.path)) ||
    replacedLargeBody(c.req.path) ||
    // a plug-in route that takes a large upload (plugin.ts bodyLimitExempt); the route checks its own access first
    pluginBodyLimitExempt(serverPlugins, c.req.method, c.req.path)
  ) {
    return next();
  }
  // Browser JSON fetches always declare a length; refuse chunked bodies and let
  // body-less POSTs (logout) through untouched.
  if (!c.req.raw.headers.has("content-length")) {
    return c.req.raw.headers.has("transfer-encoding")
      ? c.json({ error: "Length Required" }, 411)
      : next();
  }
  // The cap is read from the header alone, never from the body: asking the request for its body starts the node
  // request flowing into a web stream nobody reads, and a route that then streams the request itself (an upload
  // part, a Review reference) stalls after the first socket read (about 64 KB).
  return Number(c.req.raw.headers.get("content-length")) > MAX_BODY ? c.text("Payload Too Large", 413) : next();
});

const PUBLIC_UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PUBLIC_CLIP_GET = new RegExp(
  `^/api/clips/${PUBLIC_UUID}(?:/(?:play|thumb|transcript))?$`,
  "i",
);
// a shared Video Notes folder (clips.ts /f/:token): the folder's list; its clips play by their own public routes
const PUBLIC_CLIP_FOLDER_GET = /^\/api\/clips\/f\/[A-Za-z0-9_-]{22}$/;
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
// a phone's session reaches none of those, nor this computer's own connect settings (its link, tunnel and AI key)
const CLIENT_NEVER = /^\/api\/(?:admin|workspace|providers|devices|service-keys|my-keys|connect)(?:\/|$)/;
// but a chat card's two folder routes (D14), exact method and path only: browse one of the account's own computers, and
// add the folder picked there. Both need the session's write scope, the browse too: it only leads to that write
const clientCard = (method: string, p: string) => (method === "GET" && /^\/api\/devices\/[^/]+\/browse$/.test(p)) || (method === "POST" && p === "/api/devices/storage/folders");
const keyRoute = (routes: [string, RegExp][], method: string, p: string) =>
  routes.some(([m, r]) => m === method && r.test(p));

// Apps switched off per account (users.ts `off`). The others are
// only hidden in the app: what they hold is the user's own either way, and
// their APIs serve each other (Review and Guides play Video Notes).
export const TOOL_GATES: [string, Tool[]][] = [
  ["/api/enhance", ["enhance"]],
  ["/api/library", ["media"]],
  ["/api/editor", ["editor"]],
  ["/api/edit-steps", ["editor"]],
  ["/api/folders/editor", ["editor"]],
  // the Analyzer and the Workshop read each other's APIs
  ["/api/instagram", ["instagram", "workshop"]],
  ["/api/workshop", ["instagram", "workshop"]],
  // the Designer's designs, and with them its two AI tools (they call these routes as the account)
  ["/api/designs", ["design"]],
];

// Apps set to Read for an account (users.ts `read`): it opens them, but nothing but GET and HEAD reaches their routes.
// ponytail: a route that reads with POST (a search) is refused too; give it a GET or list it as a read when one turns up.
export const WRITE_GATES: [string, Tool][] = [
  ["/api/instagram", "instagram"],
  ["/api/workshop", "workshop"],
  ["/api/enhance", "enhance"],
  ["/api/projects", "captions"],
  ["/api/review", "review"],
  ["/api/library", "media"],
  ["/api/editor", "editor"],
  ["/api/edit-steps", "editor"],
  ["/api/folders/editor", "editor"],
  ["/api/folders/captions", "captions"],
  ["/api/folders/stories", "stories"],
  ["/api/folders/guides", "guides"],
  ["/api/folders/notes", "notes"],
  ["/api/folders/design", "design"],
  ["/api/stories", "stories"],
  ["/api/designs", "design"],
  ["/api/clips", "notes"],
  ["/api/documents", "guides"],
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
    // what a restart now would end, for a deploy to wait on: AI answers that stream straight to an open page (the
    // assistant's go on over a restart: lib/mac-claude.ts), and renders, voice enhances, caption jobs, and the
    // library's and the AI Editor's jobs running here (a restart would start them again from the beginning)
    answering: answersAtRisk(),
    working: exportsAtRisk() + enhancesAtRisk() + captionJobsAtRisk() + libraryJobsAtRisk() + editorStepsAtRisk(),
    rssMb: Math.round(process.memoryUsage().rss / 1048576),
  }),
);

// plug-ins' open routes (machine callers with their own check): before the account gate, as the health check is
// The Mac app closing our stdin means the app is gone or is restarting us. That can happen while a plug-in from the
// folder is loading, and it is not that plug-in's doing: the mark that would blame it at the next start comes down
// first. So this is set up before the first plug-in loads, not after the server is listening.
if (process.env.CT_EXIT_WITH_PARENT === "1") {
  exitWithParent(process.stdin, () => {
    clearLoadingMark();
    // an update or Quit stops us mid-step: those steps run again as soon as we're back, the try not counted
    releaseRunningSteps();
    releaseRunningJobs();
    killProcesses(); // no ffmpeg outlives us (a library job's on a computer, a step's here)
    process.exit(0);
  });
}
// plug-ins from the person's own folder (the Mac app's server only, lib/folder-plugins.ts): each is built, loaded and
// checked by itself before anything is mounted, so one that fails is left out and the app starts without it
serverPlugins.push(...(await loadFolderPlugins(serverPlugins, (all) => void pluginToolsOf(all))));
mountOpenRoutes(app, serverPlugins);
// hosted mode only: Apple / Google sign-in to a site account and linking one (sign-in.ts). A sign-in a plug-in started falls through.
if (hostedMode()) {
  app.route("/api/account", signInStartApp);
  app.route("/api/auth", signInCallbackApp);
}
// plug-ins' public routes (plugins/<id>/plugin.ts publicRoutes): before the account gate, each checks its own access
mountPublicRoutes(app, serverPlugins);
// a file the user's own AI sends with curl (MCP upload_file): the link in the path is its only credential
app.route("/api/upload", uploadLinkApp);
// a computer with no browser swaps its owner's one-time code for its token (devices.ts): the code is its only credential
app.route("/api/devices/pair", devicePairApp);
// a social sign-in's way back may land in the computer's browser, without the session: its state names the account
app.route("/api/connectors", connectorsCallbackApp);
// an AI app (ChatGPT, Claude) connecting to /api/mcp by signing in (oauth.ts): each route checks its own access
app.route("/", oauthApp);
// phones (auth-clients.ts, connect/mint.ts): who this server is, a code swapped for a session, and the connect
// service's signed health and mint requests through the tunnel; each checks its own credential
app.route("/", descriptorApp);
app.route("/", oauthTokenApp);
app.route("/api/connect", connectPublicApp);
// a picture or video in a card an AI app shows (mcp-cards.ts): a signed link, since the card's frame has no sign-in
app.route("/", cardApp((path, init) => Promise.resolve(app.request(path, init))));

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
  // a phone's client session (auth-clients.ts): read before the cookie, and a request with one is answered by it alone
  const client = callerOf(c);
  if (client.kind === "error") return sessionRefused(c, client.code);
  if (client.kind === "token") {
    // a device's session is never the account's keys, AI settings, computers or admin, whatever its scopes
    if (CLIENT_NEVER.test(c.req.path)) {
      if (!clientCard(c.req.method, c.req.path)) return c.json({ error: "A device signed in with a pairing link can't open this.", code: "NOT_FOR_CLIENTS" }, 403);
      if (!client.row.scopes.includes("write")) return scopeRefused(c, "write");
    }
    const need = scopeFor(c.req.method, c.req.path);
    if (!client.row.scopes.includes(need)) return scopeRefused(c, need);
    c.set("clientSession", client.row.id);
  }
  const signedIn = client.kind === "token" || client.kind === "cookie" ? client.user :
    (FULL_KEY_NEVER.test(c.req.path)
      ? null
      : getApiKeyUser(c.req.header("authorization"), "full", c.req.path) ??
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
      PUBLIC_CLIP_FOLDER_GET.test(c.req.path) ||
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
      ? getApiKeyUser(c.req.header("authorization"), "review", c.req.path)
      : null;
    if (!keyUser) {
      // an AI app reads where to sign in from this header (oauth.ts)
      if (c.req.path === "/api/mcp") c.header("WWW-Authenticate", mcpChallenge(c));
      return c.json({ error: "Unauthorized" }, 401);
    }
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
  const writeGate = c.req.method === "GET" || c.req.method === "HEAD" ? undefined : WRITE_GATES.find(([p]) => c.req.path === p || c.req.path.startsWith(p + "/"));
  if (writeGate && !mayChange(user, writeGate[1])) {
    return c.json({ error: `${TOOL_NAMES[writeGate[1]]} is read-only for your account`, code: "READ_ONLY" }, 403);
  }
  c.set("user", user);
  if (!viewed) touchActive(user.username);
  return next();
});
// the workspace the window is in (X-CT-Workspace): every tool keeps its things to it (lib/workspace-scope.ts)
app.use("/api/*", inRequestWorkspace);
// live change notices (api/lib/sync.ts): every write below announces its topic to the writer's open tabs
app.use("/api/*", announceWrites);
app.route("/api/sync", syncApp);
// who has access, and how this computer is reached, are changed by a browser's cookie in every mode, so a page from
// another site never reaches them: the browser must say it came from here and send JSON (which no plain form can).
// A device's own token is exempt; the connect service's signed calls carry JSON and no Origin, so they pass.
const ACCESS_WRITE = /^\/api\/(?:auth\/(?:pairing-links|clients)|connect)(?:\/|$)/;
const sameSiteWrites: MiddlewareHandler = async (c, next) => {
  if (c.req.method !== "POST" || !ACCESS_WRITE.test(c.req.path) || c.req.header("authorization")) return next();
  if (crossOriginWrite(c.req.method, c.req.url, c.req.header("origin"), undefined) || !/^application\/json\b/i.test(c.req.header("content-type") ?? "")) {
    return c.json({ error: "Sent from another site" }, 403);
  }
  return next();
};
app.use("/api/auth/*", sameSiteWrites);
app.use("/api/connect/*", sameSiteWrites);
app.route("/api/auth", authClientsApp);
// tickets for what cannot sign each request (players, web views, background uploads): media-ticket.ts
app.route("/api/auth", mediaTicketApp);
app.route("/api/auth", authApp);
app.route("/api/server", endpointsApp);
// Settings → API keys: the outside services' keys (platform admins; never an AI key)
app.route("/api/service-keys", serviceKeysApp);
// Settings → API keys: each account's own keys for the paid services (never through an AI key)
app.route("/api/my-keys", myKeysApp);
// first-run setup and Settings → Setup: my tools, my plan, what is set up (setup.ts)
app.route("/api/setup", setupApp);
// how a person wants to work: in the app, in their own AI, or both (contracts/work-prefs.ts)
app.route("/api/work-prefs", workPrefsApp);
// Settings → AI → Voice: languages and the speech-to-text engine per use (contracts/voice.ts)
app.route("/api/voice-prefs", voicePrefsApp);
app.route("/api/providers", providersApp);
// Creator Toolset as a remote MCP server (Full key only: not on the key routes): its tools call these same routes
app.route("/api/mcp", mcpApp((path, init) => Promise.resolve(app.request(path, init)), serverPlugins));
app.route("/api/assistant", assistantApp);
// what the assistant keeps from one chat to the next (memory.ts): only a reply being written can add to it
app.route("/api/memory", memoryApp);
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
app.route("/api/work/server-work", serverWorkApp);
app.route("/api/server-update", serverUpdateApp);
// Settings → Connect: link this computer to the account on the connect broker (api/connect/routes.ts)
app.route("/api/connect", connectApp);
// phone notifications through the connect service: the switch (api/connect/activity.ts; importing it starts the listeners)
app.route("/api/connect", phoneNotifyApp);
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
app.route("/api/hf", hfApp);
app.route("/api/presets", presetsApp);
app.route("/api/packs", packsApp);
// Settings → Skills: a person's own skills (skills.ts)
app.route("/api/skills", skillsApp);
app.route("/api/pack-catalog", packCatalogApp);
app.route("/api/projects", projectsApp);
app.route("/api/enhance", enhanceApp);
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
app.route("/api/upload-target", uploadTargetApp);
app.route("/api/library", publicShareApp);
app.route("/api/library", copiesApp);
app.route("/api/library", libraryApp);
app.route("/api/library", workshopLibraryApp);
app.route("/api/library", shareApp);
app.route("/api/library", collectionApp);
app.route("/api/sfx", sfxApp);
app.route("/api/library", searchApp);
app.route("/api/library", relatedApp);
app.route("/api/library", watchApp);
app.route("/api/library", storageApp);
app.route("/api/library", grantsApp);
app.route("/api/library", bulkApp);
// the chat's editor commands, on whichever editor answers below (editor/nle-bridge.ts)
app.route("/api/editor/nle", nleBridgeApp);
// a plug-in that replaces the AI Editor answers its root paths first (the old URLs the Mac worker posts to)
mountReplacedRoutes(app, serverPlugins);
app.route("/api/editor", editorApp);
app.route("/api/edit-steps", editStepsApp);
// CT_WORKER=<server address>: this process is a computer working for that server (api/work/computer.ts), with the
// plug-ins' editor steps loaded above and nothing else: no HTTP server, no library or editor loop of its own
const workerFor = process.env.CT_WORKER;
// the library's worker: probes, thumbs and proxies queued uploads; and the trash purge (not under tests, which call them)
if (process.env.NODE_ENV !== "test" && !workerFor) {
  settleServerWork(); // before the loops: a new server starts with its video work off (work/server-work.ts)
  migrateOwnerChoices(); // after it: settle writes the file the migration keeps
  try {
    // one place row per file on a computer, under a folder that exists (library/place-rows.ts); nothing to do the second time
    const fixed = fixPlaceRows(foldersOf);
    console.log(`[library] place rows: ${fixed.merged} merged, ${fixed.repointed} moved to their folder`);
  } catch (e) {
    console.warn("[library] the place rows fix-up failed:", e instanceof Error ? e.message : e);
  }
  void migrateOnce().catch((e) => console.warn("[library] the one-time migration failed:", e instanceof Error ? e.message : e)); // once per data folder (library/migrated.json)
  // libraries with clips are set up (setupAt, UNIFIED-PRD 4.6); without it every existing workspace would get the setup card
  void migrateLibraries().catch((e) => console.error("library migration failed", e));
  // Blur faces: a description's stills written out for a call a stop cut short (on-mac.ts heldDir) never outlive it
  void clearHeldStills();
  startLibraryWorker();
  setInterval(() => {
    try {
      checkWaits();
    } catch (e) {
      console.warn("[library] the wait check failed:", e instanceof Error ? e.message : e);
    }
  }, 60_000).unref();
  startEditorWorker();
  // computer tasks (work/tasks.ts): a queued one the server may run once its video work is switched on
  void sweepTasks().then(startTaskTick);
  startTrashPurge();
  startWatchFolders();
  startPlugins(serverPlugins, startFolderPlugin);
  // the downloaded app's anonymous check-ins and crash reports (lib/telemetry.ts; off in Settings → General)
  startTelemetry();
  // assistant messages that waited for their videos when the server stopped
  resumeFromDisk();
  // a render whose send to Finals the restart cut off goes again, a minute on: in a deploy's reload the process
  // before this one may still be sending it, and two sends at once could both miss the other's file
  setTimeout(() => void resumeFinalsSends().catch((e) => console.warn("[exports] Finals after the restart:", e)), 60_000).unref();
  // dropped files: the 7-day ones, and uploads nobody finished (no part for an hour)
  void sweepAll();
  setInterval(() => void sweepAll(), 3600_000).unref();
}
app.route("/api/stories", storiesApp);
// designs: carousel slides, covers and thumbnails as pages of layers (contracts/design.ts); each route checks what the design is made from
app.route("/api/designs", designsApp);
app.route("/api/folders", foldersApp);
app.route("/api/account-profile", accountProfileApp);
app.route("/api/telemetry", telemetryApp);
// plug-ins (plugins/<id>/plugin.ts, generated into api/plugins.gen.ts) mount under /api/x/<id>, behind the same login
// a plug-in off in the workspace a request works in refuses it (lib/plugin-workspaces.ts); mounted before its routes
guardPlugins(app, serverPlugins);
mountPlugins(app, serverPlugins, pluginGuard);
mountPluginsList(app);
app.route("/api/plugins", pluginWorkspacesApp);
mountFolderPlugins(app);
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
// Hono's own answer for an error no route caught, plus a crash report (lib/telemetry.ts)
app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  console.error(err);
  reportCrash("server", err);
  return c.text("Internal Server Error", 500);
});

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

if (workerFor) {
  const { cancelStep, idleFor, startComputerWorker, stopForExit } = await import("./work/computer");
  // Cancel in the Mac app's menu: the running step stops (a download within a moment, its .part kept) and ends "Stopped"
  process.on("SIGUSR2", cancelStep); // SIGUSR1 is Node's debugger
  // a stop (a service restart) kills the job's ffmpeg and waits for it, up to 10 s, rather than leaving it running
  process.once("SIGTERM", () => void stopForExit().finally(() => process.exit(0)));
  // exit 3: the server wants a newer app (the Mac app shows its update prompt); 78: its token was refused for five
  // minutes (ct-library-worker.service does not start it again until it is added again); 0: nothing to do for a while
  void startComputerWorker({ server: workerFor, token: process.env.CT_DEVICE_TOKEN ?? "", idleMs: idleFor(process.env) }).then(
    (why) => process.exit(why === "update" ? 3 : why === "refused" ? 78 : 0),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
} else if (env.isProduction) {
  const problem = startupProblem();
  if (problem) throw new Error(problem);
  const { serve } = await import("@hono/node-server");
  const { serveStaticFiles } = await import("./lib/vite");
  serveStaticFiles(app);

  const port = parseInt(process.env.PORT || "3000");
  // HOST: the interface to listen on (the Mac app passes 127.0.0.1); unset = every interface, as in Docker
  const host = process.env.HOST || undefined;
  computerKey(); // every server has its id (the descriptor's serverId) from its first start, linked or not
  const server = serve(
    {
      fetch: app.fetch,
      port,
      hostname: host,
      serverOptions: { requestTimeout: 0, headersTimeout: 0 },
    },
    () => {
      console.log(`Server running on http://${host ?? "localhost"}:${port}/`);
      // a computer linked to the account runs its tunnel while the server runs (api/connect/connector.ts)
      if (connectState()) startConnector();
      // Video Notes a restart stopped mid-processing carry on in the background
      void resumeStoppedClips().catch((e) => console.warn("[clips] resume:", e));
    },
  );
  if ("requestTimeout" in server) disableRequestTimeouts(server);
  // listening on every interface on someone's own computer: only its own networks may connect (descriptor.ts)
  if (host && listensEverywhere(host) && !hostedMode()) server.on("connection", (sock) => void (allowedPeer(sock.remoteAddress) || sock.destroy()));
  // Under pm2 a reload sends SIGINT to the old process once the new one listens: take no new requests and let the ones
  // in flight finish, so a deploy drops none (pm2's kill_timeout ends a long video stream; the player asks again).
  // The requests held open (the change stream, the computers' and workers' long polls) end at once and their callers
  // ask the new process (lib/sync.ts leave), so the old one exits well inside the kill_timeout.
  if (process.env.pm_id !== undefined)
    process.once("SIGINT", () => {
      leave();
      server.close(() => process.exit(0));
    });
  // A container stop sends SIGTERM, and the first process of a container ignores it unless it handles it: the stop
  // then waits its 10 s and kills, with the app still taking work it can't finish, and the server is away that much
  // longer (the computers' relays retry a finished answer for about 20 s). Leave at once: what a restart must not lose
  // is on disk already (upload parts, replies being written).
  process.once("SIGTERM", () => process.exit(0));
}
