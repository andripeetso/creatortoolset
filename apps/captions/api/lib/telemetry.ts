import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, homedir, platform } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { env } from "./env";
import { ownSettings, providerSettings } from "./providers";
import { listUsers } from "../users";
import { connectState } from "../connect/state";
import { putBackFailureCounts, takeFailureCounts } from "./failures";
import { libraryDb } from "../library/db";
import type { AuthVars } from "../auth";

/**
 * Anonymous usage and crash reports (owner, 2026-11-12: "how many people actually open it and how many connected"),
 * on by default in the downloaded app, off in Settings → General.
 *
 * Only builds our release scripts make send (`CT_CHANNEL=release`, set by the Mac app's release build), so a fork, a
 * self-hosted server, a hosted server or `pnpm dev` never does. `CT_TELEMETRY=0` turns it off for good; the Settings
 * switch writes $DATA_DIR/no-ping.
 *
 * What goes to creatortoolset.com (which may pass it on to PostHog and Sentry):
 * - a check-in at start, a minute after the first page and every hour: a random install id ($DATA_DIR/install-id), the version, the system, how
 *   many pages were opened since the last one and which (by page name only, from PAGES), whether Connect is linked,
 *   and which AIs are set up (their kind: claude, codex…), and what failed since the last one (an action's name or a
 *   request's route with no ids in it, the status, how many times; never the error line, which can name a file), the
 *   actions taken since (a request's route, as above, and how many times) and how big the Media Library is (clips,
 *   hours, bytes);
 * - events, every 5 minutes: each page opened, each AI run (the job's name, the model, its tokens and API-equivalent
 *   cost) and each export (how it ended, how long it took), with the time it happened;
 * - a crash or an error: where (server or web), the message and the stack, with the home folder replaced by ~.
 * No name, account, content, file name or address.
 */
const CHECKIN_MS = 3_600_000;
// the first page of a run checks in soon after: the check-in at start comes before the window opens, so a run shorter
// than CHECKIN_MS would otherwise count as never opened
const FIRST_PAGE_MS = 60_000;
let firstPageSent = false;
const HOUR = 3_600_000;
const CRASHES_PER_HOUR = 20;
const ID = /^[a-f0-9]{32}$/;
/** The page names a check-in can carry: the app's own pages. Anything else (a plug-in's page, a typed URL) is "other". */
const PAGES = new Set([
  "home", "analyzer", "captions", "clips", "community", "documents", "editor", "enhance", "finals", "guides", "instagram",
  "library", "media", "projects", "record", "review", "settings", "stories", "video-notes", "workshop",
]);

export const telemetryBuild = () => process.env.CT_CHANNEL === "release" && process.env.CT_TELEMETRY !== "0";
const offFile = () => path.join(env.dataDir, "no-ping");
const crashFile = () => path.join(env.dataDir, "crash-pending.json");
export const telemetryOn = () => telemetryBuild() && !existsSync(offFile());
export const pingUrl = () => (process.env.CT_PING_URL || "https://creatortoolset.com/api/ping").replace(/\/$/, "");

function installId(): string {
  const file = path.join(env.dataDir, "install-id");
  const have = existsSync(file) ? readFileSync(file, "utf-8").trim() : "";
  if (ID.test(have)) return have;
  const id = randomBytes(16).toString("hex");
  mkdirSync(env.dataDir, { recursive: true });
  writeFileSync(file, id);
  return id;
}

export const base = () => ({ id: installId(), version: process.env.CT_VERSION ?? "", os: platform(), arch: arch() });

// "retry": offline or the site down, the counts wait for the next send; "refused": the site will never take them, so
// they go (kept, they would be refused again each time and block what comes after)
const post = (url: string, body: unknown): Promise<"sent" | "retry" | "refused"> =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) })
    .then((r) => (r.ok ? "sent" : r.status >= 500 ? "retry" : "refused"))
    .catch(() => "retry" as const);

/* ---- check-ins ---- */

let opened = 0;
let pages: Record<string, number> = {};
let actions: Record<string, number> = {};
const ACTION_KEYS = 200;
const ACTIONS_SENT = 60;

/** A request a signed-in person made, by its route ("POST /api/library/assets/:id/tags"): writes, exports and downloads. */
export function noteAction(method: string, route: string): void {
  if (!route.startsWith("/api/") || /^\/api\/(telemetry|bug-report)/.test(route)) return;
  // a read counts only when it makes a file (an export, a download), never a list that is read again and again
  if ((method === "GET" && !/\/(export(\.md)?|download)$/.test(route)) || method === "HEAD" || method === "OPTIONS") return;
  if (!telemetryOn()) return;
  const key = `${method} ${route}`.slice(0, 120);
  if (key in actions || Object.keys(actions).length < ACTION_KEYS) actions[key] = (actions[key] ?? 0) + 1;
}

/** How big the Media Library is: clips, hours and bytes (the newest version of each, trash left out). */
function librarySize(): { clips: number; hours: number; gb: number } | undefined {
  try {
    const r = libraryDb()
      .prepare(
        `SELECT COUNT(*) AS n, IFNULL(SUM(json_extract(v.probe, '$.duration')), 0) AS secs, IFNULL(SUM(v.bytes), 0) AS bytes
         FROM assets a JOIN asset_versions v ON v.id = a.current_version_id WHERE a.trashed_at IS NULL`,
      )
      .get() as { n: number; secs: number; bytes: number };
    return { clips: r.n, hours: Math.round((r.secs / 3600) * 10) / 10, gb: Math.round((r.bytes / 1e9) * 10) / 10 };
  } catch {
    return undefined; // no library yet
  }
}

/** One page opened in the app (the browser tells us, lib/telemetry.ts). */
export function notePage(page: string): void {
  if (!telemetryOn()) return;
  const name = PAGES.has(page) ? page : "other";
  opened++;
  pages[name] = (pages[name] ?? 0) + 1;
  track("page", { page: name });
  if (firstPageSent) return;
  firstPageSent = true;
  setTimeout(() => void sendCheckin(), FIRST_PAGE_MS).unref();
}

export async function sendCheckin(): Promise<void> {
  if (!telemetryOn()) return;
  const took = { opened, pages, failed: takeFailureCounts(), actions, used };
  opened = 0;
  pages = {};
  actions = {};
  used = { models: {}, jobs: {}, exports: { done: 0, failed: 0, seconds: 0 } };
  const top = Object.fromEntries(Object.entries(took.actions).sort((a, b) => b[1] - a[1]).slice(0, ACTIONS_SENT));
  const library = librarySize();
  let ai: string[] = [];
  try {
    // the server's own providers and each account's (a person's Claude Code or Codex is saved under their account)
    const all = [providerSettings(), ...listUsers().map((u) => ownSettings(u.username))].flatMap((s) => s?.instances ?? []);
    ai = [...new Set(all.filter((i) => i.enabled).map((i) => i.driver))].slice(0, 8);
  } catch {
    // unreadable settings: the check-in goes without
  }
  const sent = await post(pingUrl(), { ...base(), opened: took.opened, connected: connectState() !== null, ai, tools: took.pages, ...(took.failed.length ? { failed: took.failed } : {}), actions: top, used: took.used, ...(library ? { library } : {}) });
  if (sent !== "retry") return;
  putBackFailureCounts(took.failed);
  for (const [k, n] of Object.entries(took.actions)) actions[k] = (actions[k] ?? 0) + n;
  used = took.used; // shortcut: what came in while this one was on its way is dropped; merge if it matters
  opened += took.opened; // not delivered: they go with the next one
  for (const [k, n] of Object.entries(took.pages)) pages[k] = (pages[k] ?? 0) + n;
}

/* ---- events: one row per thing done, sent in batches ---- */

type Props = Record<string, string | number | boolean>;
const EVENTS_MAX = 1000;
const EVENTS_MS = 5 * 60_000;
const BATCH = 200;
// shortcut: events wait in memory, so a quit loses up to 15 minutes of them; keep them on disk if the counts look low
let events: Array<{ name: string; at: number; props: Props }> = [];

/** One thing done ("page", "ai run", "export"), with numbers and names only: never a person's words, file or account. */
export function track(name: string, props: Props = {}, now = Date.now()): void {
  if (!telemetryOn()) return;
  tally(name, props);
  if (events.length < EVENTS_MAX) events.push({ name, at: now, props });
}

/* the same AI runs and exports as totals in the check-in, so the board has them with no event store */
type Use = { runs: number; tokens: number; costUsd: number };
let used: { models: Record<string, Use>; jobs: Record<string, Use>; exports: { done: number; failed: number; seconds: number } } = { models: {}, jobs: {}, exports: { done: 0, failed: 0, seconds: 0 } };
const KEYS_MAX = 40;
function tally(name: string, p: Props): void {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  if (name === "ai run") {
    for (const [map, key] of [[used.models, String(p.model)], [used.jobs, String(p.job)]] as const) {
      if (!(key in map) && Object.keys(map).length >= KEYS_MAX) continue;
      const u = (map[key] ??= { runs: 0, tokens: 0, costUsd: 0 });
      u.runs++;
      u.tokens += num(p.tokens);
      u.costUsd = Math.round((u.costUsd + num(p.costUsd)) * 1e4) / 1e4;
    }
  } else if (name === "export") {
    used.exports[p.ok ? "done" : "failed"]++;
    used.exports.seconds += num(p.seconds);
  }
}

export async function sendEvents(): Promise<void> {
  if (!telemetryOn() || events.length === 0) return;
  const took = events;
  events = [];
  for (let i = 0; i < took.length; i += BATCH) {
    if ((await post(`${pingUrl()}/events`, { ...base(), events: took.slice(i, i + BATCH) })) !== "retry") continue;
    events = [...took.slice(i), ...events].slice(0, EVENTS_MAX); // not delivered: they go with the next batch
    return;
  }
}

/* ---- crashes ---- */

// The app's own folder (dist/boot.js's parent) stays as <app>: its paths say where in the code an error happened. Any other
// path is the person's (a video's file name can be a name) and goes, quoted ones first since they can hold spaces.
const appDir = path.resolve(path.dirname(process.argv[1] ?? "."), "..");
export const scrub = (s: string) =>
  s
    .split(appDir).join("<app>")
    .replace(/(['"`])(?:~|\/|[A-Za-z]:\\)[^'"`]*\1/g, "$1<path>$1")
    // a person's own folders, whose names may have spaces: up to the file's extension, else to an error code (ENOENT) or the next ":", ",", bracket or line end
    .replace(/(^|[\s(=:])(?:~|\/(?:Users|home|Volumes|mnt|media))\/(?:[^\n'"`(),:]*?\.[A-Za-z0-9]{1,5}(?=[\s:,)'"`]|$)(?![^\n:,()'"`]*\/)|[^\n'"`(),:]*?(?= [A-Z][A-Z0-9_]{2,}\b|[\n'"`(),:]|$))/g, "$1<path>")
    .replace(/(^|[\s(=:])(?:~|\/(?!\/))[^\s'"`(),]*/g, "$1<path>")
    .split(homedir()).join("~");
const RECENT_ERRORS = 20;
export const recentErrors: Array<{ at: number; where: "server" | "web"; message: string; stack?: string }> = [];
const lastSent = new Map<string, number>();
const repeats = new Map<string, number>();
let hourFrom = 0;
let inHour = 0;

/** A crash or an error. The same message is sent once an hour at most (its repeats ride along as `count`), 20 an hour in all. */
export function reportCrash(where: "server" | "web", error: unknown, now = Date.now()): void {
  const e = error instanceof Error ? error : new Error(String(error));
  const message = scrub(`${e.name && e.name !== "Error" ? `${e.name}: ` : ""}${e.message}`).slice(0, 500);
  // kept even with reports off: a bug report the person sends themselves carries the last few (api/bug-report.ts)
  const stack = scrub(e.stack ?? "").split("\n").slice(1, 7).map((l) => l.trim()).filter(Boolean).join("\n");
  recentErrors.push({ at: now, where, message, ...(stack ? { stack } : {}) });
  if (recentErrors.length > RECENT_ERRORS) recentErrors.shift();
  if (!telemetryOn()) return;
  const key = `${where}|${message}`;
  if (now - (lastSent.get(key) ?? -Infinity) < HOUR) return void repeats.set(key, (repeats.get(key) ?? 0) + 1);
  if (now - hourFrom >= HOUR) [hourFrom, inHour] = [now, 0];
  if (inHour >= CRASHES_PER_HOUR) return;
  inHour++;
  lastSent.set(key, now);
  const count = 1 + (repeats.get(key) ?? 0);
  repeats.delete(key);
  void post(`${pingUrl()}/crash`, { ...base(), where, message, stack: scrub(e.stack ?? "").slice(0, 4000), count });
}

/** A crash that ends the process can't wait for a request: it is written down and sent at the next start. */
function keepFatal(error: unknown): void {
  if (!telemetryOn()) return;
  try {
    const e = error instanceof Error ? error : new Error(String(error));
    writeFileSync(crashFile(), JSON.stringify({ name: e.name, message: e.message, stack: e.stack }));
  } catch {
    // the disk is full or gone: nothing to keep it on
  }
}

function sendKeptFatal(): void {
  if (!existsSync(crashFile())) return;
  try {
    const kept = JSON.parse(readFileSync(crashFile(), "utf-8")) as { name?: string; message?: string; stack?: string };
    reportCrash("server", Object.assign(new Error(kept.message ?? ""), { name: kept.name ?? "Error", stack: kept.stack }));
  } catch {
    // unreadable: dropped
  }
  rmSync(crashFile(), { force: true });
}

export function startTelemetry(): void {
  if (!telemetryBuild()) return;
  // the monitor only watches: Node still prints the error and stops, as it does without it
  process.on("uncaughtExceptionMonitor", keepFatal);
  sendKeptFatal();
  void sendCheckin();
  setInterval(() => void sendCheckin(), CHECKIN_MS).unref();
  setInterval(() => void sendEvents(), EVENTS_MS).unref();
}

/* ---- the app's side: the Settings switch, page opens and the page's errors ---- */

export const telemetryApp = new Hono<{ Variables: AuthVars }>();

// available: this build reports at all (the switch shows only then)
telemetryApp.get("/", (c) => c.json({ available: telemetryBuild(), on: telemetryOn() }));

telemetryApp.put("/", async (c) => {
  if (c.get("user").role !== "admin") return c.json({ error: "Admins only" }, 403);
  if (!telemetryBuild()) return c.json({ error: "This build doesn't send reports" }, 404);
  const b = (await c.req.json().catch(() => null)) as { on?: unknown } | null;
  if (typeof b?.on !== "boolean") return c.json({ error: "on must be true or false" }, 400);
  if (b.on) rmSync(offFile(), { force: true });
  else {
    mkdirSync(env.dataDir, { recursive: true });
    writeFileSync(offFile(), "");
  }
  return c.json({ available: true, on: telemetryOn() });
});

telemetryApp.post("/view", async (c) => {
  const b = (await c.req.json().catch(() => null)) as { page?: unknown } | null;
  if (typeof b?.page === "string") notePage(b.page);
  return c.body(null, 204);
});

telemetryApp.post("/error", async (c) => {
  if (Number(c.req.header("content-length") ?? 0) > 16_384) return c.json({ error: "Too large" }, 413);
  const b = (await c.req.json().catch(() => null)) as { name?: unknown; message?: unknown; stack?: unknown } | null;
  if (typeof b?.message !== "string") return c.json({ error: "message is required" }, 400);
  const e = new Error(b.message);
  e.name = typeof b.name === "string" ? b.name.slice(0, 64) : "Error";
  e.stack = typeof b.stack === "string" ? b.stack : "";
  reportCrash("web", e);
  return c.body(null, 204);
});
