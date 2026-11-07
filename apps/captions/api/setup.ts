import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import type { AuthVars } from "./auth";
import { anyAiConfigured } from "./ai-complete";
import { env } from "./lib/env";
import { listDevices } from "./lib/devices";
import { readConnectors } from "./lib/connectors/store";
import { publicApifyStatus, readApify } from "./lib/instagram/apify";
import { routeFor } from "./lib/providers";
import { ownedProjects } from "./lib/workshop/workspace";
import { workspaceOf } from "./lib/workspaces";
import { libraryDb } from "./library/db";
import { keyFor } from "./my-keys";
import { DEMO_USER, isDemoName, isGuestName, USERNAME_RE, type SessionUser } from "./users";
import { MY_KEYS } from "../contracts/service-keys";
import { isTool, TOOLS, type Have, type SetupView, type Tool } from "../contracts/tools";
import { isPlan, planFromCli, type PlanId } from "../contracts/plans";

/**
 * First-run setup and Settings → Setup: the tools a person uses (their own list, apart from Admin → Access), the plan
 * their AI runs on, whether they finished setup, and what they have set up (contracts/tools.ts Have) for the
 * readiness rows. $DATA_DIR/setup/<username>.json; accounts only (a guest or a demo visitor has no setup).
 *
 *   GET /api/setup  → SetupView
 *   PUT /api/setup  { tools?: Tool[], plan?: PlanId | null, done?: boolean } → SetupView
 */

interface Saved {
  tools?: Tool[];
  plan?: PlanId;
  done?: boolean;
}

const fileOf = (u: string) => (USERNAME_RE.test(u) && !isGuestName(u) && !isDemoName(u) && u !== DEMO_USER ? path.join(env.dataDir, "setup", `${u}.json`) : null);

function read(u: string): Saved | null {
  const f = fileOf(u);
  try {
    return f ? (JSON.parse(readFileSync(f, "utf-8")) as Saved) : null;
  } catch {
    return null;
  }
}

function write(u: string, s: Saved): void {
  const f = fileOf(u);
  if (!f) throw new Error("No setup for this account");
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(`${f}.tmp`, JSON.stringify(s));
  renameSync(`${f}.tmp`, f);
}

/** What this account has set up, each the way the tool that needs it checks. */
export async function haveFor(user: SessionUser): Promise<Have[]> {
  const u = user.username;
  const have: Have[] = MY_KEYS.filter((k) => keyFor(user, k.env).key).map((k) => k.env);
  if (anyAiConfigured(user)) have.push("ai");
  if (routeFor(u, user.role === "admin", "workshop")) have.push("ownAi");
  if ((await ownedProjects(u)).length) have.push("project");
  if (readConnectors(u).accounts.some((a) => a.platform === "instagram" && a.via === "login")) have.push("instagram");
  if (publicApifyStatus(await readApify(u)).configured) have.push("apify");
  const w = workspaceOf(u);
  if (w && libraryDb().prepare("SELECT 1 FROM libraries WHERE workspace_id = ? LIMIT 1").get(w.id)) have.push("library");
  return have;
}

/** The plan a CLI on one of this account's Macs reported (the Mac app's report), if any says one. */
const detectedPlan = (u: string): PlanId | null =>
  listDevices((d) => d.owner === u).flatMap((d) => d.report?.drivers ?? []).map((r) => planFromCli(r.plan)).find(Boolean) ?? null;

async function view(user: SessionUser): Promise<SetupView> {
  const s = read(user.username) ?? {};
  return { tools: s.tools ?? null, plan: s.plan ?? null, detected: detectedPlan(user.username), done: !!s.done, have: await haveFor(user) };
}

export const setupApp = new Hono<{ Variables: AuthVars }>();

setupApp.use("*", async (c, next) => (fileOf(c.get("user").username) && !c.get("user").demo ? next() : c.json({ error: "Sign in with an account to set up" }, 403)));

setupApp.get("/", async (c) => c.json(await view(c.get("user"))));

setupApp.put("/", async (c) => {
  const user = c.get("user");
  const b = (await c.req.json().catch(() => null)) as { tools?: unknown; plan?: unknown; done?: unknown } | null;
  if (!b) return c.json({ error: "Send { tools, plan, done }" }, 400);
  const next = { ...(read(user.username) ?? {}) };
  if (b.tools !== undefined) {
    if (!Array.isArray(b.tools) || !b.tools.every(isTool)) return c.json({ error: `tools: some of ${TOOLS.join(", ")}` }, 400);
    next.tools = TOOLS.filter((t) => (b.tools as Tool[]).includes(t));
  }
  if (b.plan !== undefined) {
    if (b.plan !== null && !isPlan(b.plan)) return c.json({ error: "No such plan" }, 400);
    if (b.plan === null) delete next.plan;
    else next.plan = b.plan;
  }
  if (b.done !== undefined) next.done = b.done === true;
  write(user.username, next);
  return c.json(await view(user));
});
