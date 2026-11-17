/**
 * Updating a server opened by its address, from Settings → Storage → Update, at /api/server-update.
 *
 * The app cannot update itself: it runs from a build it must not write to. The machine it runs on does
 * (scripts/server-update.sh, on a timer). Each run writes `server-update/status.json` into the data folder, and
 * updates once `server-update/request` is there. No recent status means no updater on that machine, and Settings
 * shows nothing.
 *
 * An update never cuts work this server is doing. Before it restarts, the updater writes `server-update/drain` and
 * waits: while that file is fresh, the library's and the AI Editor's job loops take no new job, so the ones running
 * finish, and /api/health counts them until they have. The updater writes it again on every run while it waits, so
 * one that stops leaves no server paused for longer than DRAIN_MS.
 *
 *   GET  /          → ServerUpdateView (admin)
 *   POST /request   → ServerUpdateView (admin): asks for the update; does nothing when none is waiting
 */
import { Hono } from "hono";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ServerUpdateView } from "../contracts/server-update";
import type { AuthVars } from "./auth";
import { env } from "./lib/env";
import { onLeave } from "./lib/sync";

export const serverUpdateApp = new Hono<{ Variables: AuthVars }>();

/** The updater writes its status on every run: one older than this means it no longer runs. */
const STALE_MS = 60 * 60_000;
const dir = () => path.join(env.dataDir, "server-update");
const request = () => path.join(dir(), "request");
const DRAIN_MS = 10 * 60_000;

// a reload's old process (lib/sync.ts leave) claims nothing more: its replacement runs the jobs
let left = false;
onLeave(() => (left = true));

/** An update is waiting for this server's running jobs: take no new one (the job loops ask before each claim). */
export function draining(now = Date.now()): boolean {
  if (left) return true;
  try {
    return now - statSync(path.join(dir(), "drain")).mtimeMs < DRAIN_MS;
  } catch {
    return false;
  }
}

const int = (v: unknown, min: number, max: number): number | null => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null);

export function readServerUpdate(now = Date.now()): ServerUpdateView {
  const file = path.join(dir(), "status.json");
  try {
    if (now - statSync(file).mtimeMs > STALE_MS) return { available: false };
    const s = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    return {
      available: true,
      behind: int(s.behind, 0, Number.MAX_SAFE_INTEGER) ?? 0,
      nightly: int(s.nightly, 1, Number.MAX_SAFE_INTEGER),
      requested: existsSync(request()),
      waiting: s.waiting === true,
      failed: s.failed === true,
    };
  } catch {
    return { available: false };
  }
}

serverUpdateApp.use("*", async (c, next) => (c.get("user").role === "admin" ? next() : c.json({ error: "Only an admin updates the server" }, 403)));

serverUpdateApp.get("/", (c) => c.json(readServerUpdate()));

serverUpdateApp.post("/request", (c) => {
  const view = readServerUpdate();
  if (!view.available) return c.json({ error: "This server has no updater" }, 409);
  if (view.behind === 0) return c.json(view);
  mkdirSync(dir(), { recursive: true });
  writeFileSync(request(), `${c.get("user").username} ${new Date().toISOString()}\n`);
  return c.json({ ...view, requested: true } satisfies ServerUpdateView);
});
