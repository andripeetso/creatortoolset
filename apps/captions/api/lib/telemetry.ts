import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, homedir, platform } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { env } from "./env";
import { providerSettings } from "./providers";
import { connectState } from "../connect/state";
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
 * - a check-in at start and every 6 hours: a random install id ($DATA_DIR/install-id), the version, the system, how
 *   many pages were opened since the last one and which (by page name only, from PAGES), whether Connect is linked,
 *   and which AIs are set up (their kind: claude, codex…);
 * - a crash or an error: where (server or web), the message and the stack, with the home folder replaced by ~.
 * No name, account, content, file name or address.
 */
const CHECKIN_MS = 6 * 3_600_000;
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
const pingUrl = () => (process.env.CT_PING_URL || "https://creatortoolset.com/api/ping").replace(/\/$/, "");

function installId(): string {
  const file = path.join(env.dataDir, "install-id");
  const have = existsSync(file) ? readFileSync(file, "utf-8").trim() : "";
  if (ID.test(have)) return have;
  const id = randomBytes(16).toString("hex");
  mkdirSync(env.dataDir, { recursive: true });
  writeFileSync(file, id);
  return id;
}

const base = () => ({ id: installId(), version: process.env.CT_VERSION ?? "", os: platform(), arch: arch() });

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) })
    .then((r) => r.ok)
    .catch(() => false); // offline or the site down: the counts wait for the next check-in

/* ---- check-ins ---- */

let opened = 0;
let pages: Record<string, number> = {};

/** One page opened in the app (the browser tells us, lib/telemetry.ts). */
export function notePage(page: string): void {
  if (!telemetryOn()) return;
  const name = PAGES.has(page) ? page : "other";
  opened++;
  pages[name] = (pages[name] ?? 0) + 1;
}

export async function sendCheckin(): Promise<void> {
  if (!telemetryOn()) return;
  const took = { opened, pages };
  opened = 0;
  pages = {};
  let ai: string[] = [];
  try {
    ai = [...new Set(providerSettings().instances.filter((i) => i.enabled).map((i) => i.driver))].slice(0, 8);
  } catch {
    // unreadable settings: the check-in goes without
  }
  const ok = await post(pingUrl(), { ...base(), opened: took.opened, connected: connectState() !== null, ai, tools: took.pages });
  if (ok) return;
  opened += took.opened; // not delivered: they go with the next one
  for (const [k, n] of Object.entries(took.pages)) pages[k] = (pages[k] ?? 0) + n;
}

/* ---- crashes ---- */

const scrub = (s: string) => s.split(homedir()).join("~");
const lastSent = new Map<string, number>();
const repeats = new Map<string, number>();
let hourFrom = 0;
let inHour = 0;

/** A crash or an error. The same message is sent once an hour at most (its repeats ride along as `count`), 20 an hour in all. */
export function reportCrash(where: "server" | "web", error: unknown, now = Date.now()): void {
  if (!telemetryOn()) return;
  const e = error instanceof Error ? error : new Error(String(error));
  const message = scrub(`${e.name && e.name !== "Error" ? `${e.name}: ` : ""}${e.message}`).slice(0, 500);
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
