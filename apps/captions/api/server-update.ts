/**
 * Updating a server opened by its address, from Settings → Storage → Update, at /api/server-update.
 *
 * The app cannot update itself: it runs from a build it must not write to. The machine it runs on does
 * (scripts/server-update.sh, on a timer). Each run writes `server-update/status.json` into the data folder, and
 * updates once `server-update/request` is there. No recent status means no updater on that machine, and Settings
 * shows nothing.
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

export const serverUpdateApp = new Hono<{ Variables: AuthVars }>();

/** The updater writes its status on every run: one older than this means it no longer runs. */
const STALE_MS = 60 * 60_000;
const dir = () => path.join(env.dataDir, "server-update");
const request = () => path.join(dir(), "request");

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
