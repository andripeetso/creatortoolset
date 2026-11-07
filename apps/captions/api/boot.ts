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
import { workshopApp, workshopShareApp } from "./workshop";
import { reviewApp } from "./review";
import { libraryApp } from "./library/routes";
import { collectionApp } from "./library/collections";
import { publicShareApp, shareApp } from "./library/shares";
import { startLibraryWorker } from "./library/worker";
import { startTrashPurge } from "./library/trash";
import { presetsApp } from "./presets";
import { projectsApp } from "./projects";
import { storiesApp } from "./stories";
import { transcribeApp } from "./transcribe";
import { authApp, getApiKeyUser, getSessionUser, type AuthVars } from "./auth";
import { providersApp } from "./providers";
import { mcpApp } from "./mcp";
import { workspaceApp } from "./workspace";
import { connectorsApp, startConnectorPulls, tiktokVerifyFile } from "./connectors";
import { macAppPublic, macAppRelease } from "./mac-app";
import { devicesApp } from "./devices";
import { deviceForToken } from "./lib/devices";
import { adminApp } from "./admin";
import { serviceKeysApp } from "./service-keys";
import { captionLayoutApp } from "./caption-layout";
import { GUEST_USER, mayUse, touchActive, type Tool } from "./users";
import { env } from "./lib/env";
import { disableRequestTimeouts } from "./lib/incoming";

// surface font resolution at boot — a missing dir means every render
// would silently use the wrong fonts (exports now refuse to run instead)
console.log(
  `[fonts] ${resolveFontsDir() ?? "NOT FOUND (public/fonts) — renders will be rejected"}`,
);

const app = new Hono<{ Bindings: HttpBindings; Variables: AuthVars }>();

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
    c.req.path.startsWith("/api/library/uploads/") ||
    (c.req.method === "POST" && /^\/api\/workshop-share\/[^/]+\/deliveries$/.test(c.req.path))
  ) {
    return next();
  }
  // Without a Content-Length, hono's bodyLimit re-wraps the request via
  // `new Request(...)`, which the node adapters choke on. Browser JSON
  // fetches always declare a length; refuse chunked bodies and let
  // body-less POSTs (logout, guest login) through untouched.
  if (!c.req.raw.headers.has("content-length")) {
    return c.req.raw.headers.has("transfer-encoding")
      ? c.json({ error: "Length Required" }, 411)
      : next();
  }
  return limit(c, next);
});

// guests are ephemeral: block everything that would persist on the
// server (project storage, background exports, sync renders). Review and the
// Audio Enhancer take guests under their own caps and short keeps.
const GUEST_BLOCKED = [
  "/api/projects",
  "/api/exports",
  "/api/export",
  "/api/clean",
  "/api/clips",
  "/api/documents",
  "/api/instagram",
  "/api/workshop",
  "/api/connectors",
  "/api/stories",
  "/api/library",
];

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
const PUBLIC_REVIEW = new RegExp(`^/api/review/[sp]/${PUBLIC_UUID}(?:/|$)`, "i");
// Media Library share links (api/library/shares.ts): the shared view and its media, and the password unlock
const PUBLIC_LIBRARY_SHARE = /^\/api\/library\/s\/[A-Za-z0-9_-]{22}(?:\/|$)/;
const PUBLIC_LIBRARY_SHARE_WRITE = /^\/api\/library\/s\/[A-Za-z0-9_-]{22}\/unlock$/;
const REVIEW = /^\/api\/review(?:\/|$)/;
// what a demo visitor can't do in their copy of Review: add videos or references (a
// timeline file is fine), start a Caption Studio project
const DEMO_REVIEW_OFF = new RegExp(
  `^/api/review/uploads(?:/|$)|^/api/review/assets/${PUBLIC_UUID}/v/\\d+/(?:captions|refs)$`, "i");
const REVIEW_COMMENT = new RegExp(`^/api/review/assets/${PUBLIC_UUID}/comments/[^/]+$`, "i");
const REVIEW_UPLOAD = new RegExp(`^/api/review/uploads(?:/${PUBLIC_UUID}/(?:parts/\\d+|complete))?$`, "i");
// what an AI access key may call, route by route: Review reads, resolving a comment and uploading a
// video or a new version (a final cut) for any account; for admins also the Mac app
// release (PUT /api/mac-app/release).
const KEY_ROUTES: [string, RegExp][] = [["GET", REVIEW], ["PATCH", REVIEW_COMMENT], ["POST", REVIEW_UPLOAD]];
const ADMIN_KEY_ROUTES: [string, RegExp][] = [["PUT", /^\/api\/mac-app\/release$/]];
const FULL_KEY_NEVER = /^\/api\/(?:admin|providers|devices|workspace|service-keys)(?:\/|$)/;
const keyRoute = (routes: [string, RegExp][], method: string, p: string) =>
  routes.some(([m, r]) => m === method && r.test(p));

// Apps an admin switches off per account (users.ts TOOLS). The others are
// only hidden in the app: what they hold is the user's own either way, and
// their APIs serve each other (Review and Guides play Video Notes).
export const TOOL_GATES: [string, Tool[]][] = [
  ["/api/enhance", ["enhance"]],
  ["/api/clean", ["clean"]],
  ["/api/library", ["media"]],
  // the Analyzer and the Workshop read each other's APIs
  ["/api/instagram", ["instagram", "workshop"]],
  ["/api/workshop", ["instagram", "workshop"]],
];

// the deploy's readiness check (scripts/deploy.sh): before the account gate, nothing about users or secrets
app.get("/api/health", (c) =>
  c.json({ ok: true, uptimeSec: Math.round(process.uptime()), rssMb: Math.round(process.memoryUsage().rss / 1048576) }),
);

// the Mac app's download and Sparkle appcast (mac-app.ts): public, before the account gate
app.route("/api/mac-app", macAppPublic);

// account gate (active only when APP_SECRET is set — see api/auth.ts)
app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/auth")) return next();
  // an app Mac's relay (devices.ts): its ctd_ token only, never a cookie
  if (c.req.path.startsWith("/api/devices/relay/")) {
    if (!deviceForToken(c.req.header("authorization"))) return c.json({ error: "Unauthorized" }, 401);
    return next();
  }
  // a Full AI key is the account itself, gates and all,
  // except Admin, AI settings and paired Macs; /api/auth reads only cookies, so a key never makes keys
  const user = getSessionUser(c.req.header("cookie")) ??
    (FULL_KEY_NEVER.test(c.req.path) ? null : getApiKeyUser(c.req.header("authorization"), "full"));
  if (
    c.req.method === "GET" &&
    (PUBLIC_CLIP_GET.test(c.req.path) ||
      PUBLIC_LIBRARY_SHARE.test(c.req.path) ||
      PUBLIC_AGENT_GET.test(c.req.path) ||
      PUBLIC_DOC_GET.test(c.req.path) ||
      PUBLIC_WORKSHOP.test(c.req.path))
  ) {
    c.set("user", user ?? GUEST_USER);
    if (user && user.role !== "guest") touchActive(user.username);
    return next();
  }
  if (c.req.method === "POST" && (PUBLIC_WORKSHOP_WRITE.test(c.req.path) || PUBLIC_LIBRARY_SHARE_WRITE.test(c.req.path))) {
    c.set("user", user ?? GUEST_USER);
    return next();
  }
  if (PUBLIC_REVIEW.test(c.req.path)) {
    // a demo visitor comments on a share link as anyone would, never as the demo account
    c.set("user", user && !user.demo ? user : GUEST_USER);
    return next();
  }
  if (!user) {
    // an AI access key: KEY_ROUTES (review.ts refuses text edits from it),
    // ADMIN_KEY_ROUTES only when its account is an admin; nothing else
    const adminOnly = keyRoute(ADMIN_KEY_ROUTES, c.req.method, c.req.path);
    const keyUser = adminOnly || keyRoute(KEY_ROUTES, c.req.method, c.req.path)
      ? getApiKeyUser(c.req.header("authorization"))
      : null;
    if (!keyUser || (adminOnly && keyUser.role !== "admin")) return c.json({ error: "Unauthorized" }, 401);
    c.set("user", keyUser);
    return next();
  }
  if (
    user.role === "guest" &&
    GUEST_BLOCKED.some((p) => c.req.path.startsWith(p))
  ) {
    return c.json(
      {
        error: "Not available in guest mode — sign in with an account",
        code: "GUEST",
      },
      403,
    );
  }
  // "See the demo": Review is the visitor's own copy of the demo's (review.ts
  // cloneDemoReview), theirs to comment, draw and approve in, but no uploads;
  // everything else only looks, so every visitor finds the demo as it was left
  const reading = c.req.method === "GET" || c.req.method === "HEAD";
  if (user.demo && REVIEW.test(c.req.path) && (reading || !DEMO_REVIEW_OFF.test(c.req.path))) {
    c.set("user", { ...user, username: user.demo });
    return next();
  }
  if (user.demo && !reading) {
    c.header("X-Demo", "read-only");
    return c.json({ error: "", code: "DEMO" }, 403);
  }
  const gate = TOOL_GATES.find(([p]) => c.req.path === p || c.req.path.startsWith(p + "/"));
  if (gate && !gate[1].some((t) => mayUse(user, t))) {
    return c.json({ error: "This app isn't switched on for your account — ask an admin", code: "TOOL_ACCESS" }, 403);
  }
  c.set("user", user);
  touchActive(user.username);
  return next();
});
app.route("/api/auth", authApp);
app.route("/api/admin", adminApp);
// Settings → API keys: the outside services' keys (platform admins; never an AI key)
app.route("/api/service-keys", serviceKeysApp);
app.route("/api/providers", providersApp);
// Creator Toolset as a remote MCP server (Full key only: not on the key routes): its tools call these same routes
app.route("/api/mcp", mcpApp((path, init) => Promise.resolve(app.request(path, init))));
app.route("/api/workspace", workspaceApp);
app.route("/api/connectors", connectorsApp);
// TikTok's site check (Settings → Admin → Connector apps): a public file at the root while the app is registered
app.get("/:file{tiktok[\\w-]*\\.txt}", (c) => {
  const text = tiktokVerifyFile(c.req.param("file"));
  return text === null ? c.notFound() : c.text(text);
});
startConnectorPulls();
app.route("/api/devices", devicesApp);
app.route("/api/mac-app", macAppRelease);
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
app.route("/api/exports", exportsApp);
app.route("/api/export", exportApp);
app.route("/api/hf", hfApp);
app.route("/api/presets", presetsApp);
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
// the public share routes first: their /s/:token must not be read as another library route
app.route("/api/library", publicShareApp);
app.route("/api/library", libraryApp);
app.route("/api/library", shareApp);
app.route("/api/library", collectionApp);
// the library's worker: probes, thumbs and proxies queued uploads; and the trash purge (not under tests, which call them)
if (process.env.NODE_ENV !== "test") {
  startLibraryWorker();
  startTrashPurge();
}
app.route("/api/stories", storiesApp);
app.all("/api/*", (c) => c.json({ error: "Not Found" }, 404));

export default app;

/** Why production must not start, or null. Without APP_SECRET every request is the admin (auth.ts getSessionUser). */
export const startupProblem = (): string | null =>
  env.isProduction && !env.appSecret ? "APP_SECRET is required in production: without it every request is the admin" : null;

if (env.isProduction) {
  const problem = startupProblem();
  if (problem) throw new Error(problem);
  const { serve } = await import("@hono/node-server");
  const { serveStaticFiles } = await import("./lib/vite");
  serveStaticFiles(app);

  const port = parseInt(process.env.PORT || "3000");
  const server = serve(
    {
      fetch: app.fetch,
      port,
      serverOptions: { requestTimeout: 0, headersTimeout: 0 },
    },
    () => {
      console.log(`Server running on http://localhost:${port}/`);
    },
  );
  if ("requestTimeout" in server) disableRequestTimeouts(server);
}
