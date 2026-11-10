import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AuthVars } from "./auth";
import { answerWithTools, routeOf } from "./assistant";
import { deviceName, isOnline } from "./lib/devices";
import { env, hostedMode } from "./lib/env";
import { notifyWorkshopOwner } from "./review";
import { findUser, listUsers, USERNAME_RE } from "./users";
import {
  AUTOMATION_NAME_MAX,
  AUTOMATION_PROMPT_MAX,
  nextRunAfter,
  normalizeSchedule,
  scheduleError,
  validTimezone,
  type Automation,
  type AutomationResult,
  type Schedule,
} from "../contracts/automations";

/**
 * Automations (contracts/automations.ts): $DATA_DIR/automations/<user>.json, one list per account. A run is the
 * account's own assistant (assistant.ts answerWithTools, routeOf: never the workspace's AI for someone else, never
 * an API key) with the prompt, and its result goes to the inbox (review.ts notifyWorkshopOwner) and lastResult.
 * startAutomations() checks once a minute in production. The routes sit behind the account gate, so a Full key
 * reaches them (your own AI over the MCP) and each account sees only its own list.
 */

export const automationsApp = new Hono<{ Variables: AuthVars }>();

const RESULT_MAX = 2000;
/** Which automations are running now (this process): one run at a time per automation. */
const running = new Set<string>();

/* ---- the store: sync read, sync write, so a read-modify-write can't interleave with another in this process ---- */

const dirOf = () => path.join(env.dataDir, "automations");
const fileOf = (username: string) => path.join(dirOf(), `${username}.json`);

function readAll(username: string): Automation[] {
  if (!USERNAME_RE.test(username)) return [];
  try {
    return JSON.parse(readFileSync(fileOf(username), "utf-8")) as Automation[];
  } catch (e) {
    // no file yet is an empty list; an unreadable file is an error, never silently emptied (the next write would erase it)
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

function writeAll(username: string, list: Automation[]): void {
  mkdirSync(dirOf(), { recursive: true, mode: 0o700 });
  const file = fileOf(username);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 });
  renameSync(tmp, file);
}

/** The next scheduled run, from its last one (or from its creation). */
const nextRunOf = (a: Automation): number => nextRunAfter(a.schedule, a.timezone, a.lastRun ?? a.createdAt);

const view = (a: Automation) => ({ ...a, running: running.has(a.id), nextRun: a.enabled ? nextRunOf(a) : null });

/** Records a run's outcome in the account's list and tells the inbox. Never fails the run that reports. */
async function finish(username: string, id: string, status: AutomationResult["status"], text: string): Promise<void> {
  const result: AutomationResult = { at: Date.now(), status, text: text.slice(0, RESULT_MAX) };
  const list = readAll(username);
  const a = list.find((x) => x.id === id);
  if (a) {
    a.lastResult = result;
    writeAll(username, list);
  }
  const name = a?.name ?? "A scheduled task";
  await notifyWorkshopOwner(username, {
    kind: status === "done" ? "workshop" : "failed",
    by: "Scheduled tasks",
    name,
    text: `${status === "done" ? "" : `${status}: `}${text}`,
    href: "/settings/automations",
    ref: id,
  }).catch(() => {});
}

/* ---- one run ---- */

const NO_AI = "No Claude Code is set up for your AI here. Add it on a computer in Providers.";
// a member's route never includes the team's AI (routeOf), and a member cannot add a computer for the team: say that instead
const NO_AI_MEMBER = "Scheduled tasks need Claude Code on one of your computers. Your team's AI can't run them.";
const NOT_CLAUDE = "Scheduled tasks run on Claude Code, and your AI here is another tool. Add Claude Code on a computer.";
const noRouteText = (admin: boolean) => (admin ? NO_AI : NO_AI_MEMBER);
/** True for an admin, and for every account on an install of one's own (no team to be a member of). */
const isAdminHere = (username: string) => !hostedMode() || findUser(username)?.role === "admin";
/** Why no task can run on this route, in plain words, or null. The page shows it before a task is built; a run records it. */
export const blockOf = (route: ReturnType<typeof routeOf>, admin = true): string | null =>
  !route ? noRouteText(admin) : route.instance.driver !== "claude" ? NOT_CLAUDE : null;

const runPrompt = (a: Automation): string =>
  `This is a scheduled run of the automation "${a.name}". Nobody is at the screen: do the work with the app's tools, and don't open pages with navigate.${a.project ? ` Its Workshop project is ${a.project}.` : ""}\n\n${a.prompt}`;

/**
 * Runs one automation on the account's own AI, or says why it didn't (skipped: no AI, not Claude Code, the Mac
 * offline, no address for the tools). Resolves once the result is recorded.
 */
export async function runAutomation(username: string, a: Automation): Promise<void> {
  const admin = isAdminHere(username);
  const route = routeOf(username, admin);
  if (!route) return finish(username, a.id, "skipped", noRouteText(admin));
  if (route.instance.driver !== "claude") return finish(username, a.id, "skipped", NOT_CLAUDE);
  if (!isOnline(route.device)) return finish(username, a.id, "skipped", `${deviceName(route.device)} is offline, so this run was skipped.`);
  // the tools' address: PUBLIC_ORIGIN, else the Mac app's own server on this Mac (CT_LOCAL), where the Mac's AI runs too
  const origin = process.env.PUBLIC_ORIGIN?.replace(/\/$/, "") || (process.env.CT_LOCAL === "1" && process.env.PORT ? `http://127.0.0.1:${process.env.PORT}` : "");
  if (!origin) return finish(username, a.id, "skipped", "This server doesn't know its own address, so the task can't reach the app's tools. Ask whoever runs this server.");
  try {
    const text = await answerWithTools(username, route, `${origin}/api/mcp`, runPrompt(a), {
      label: "Scheduled task",
      turn: `automation:${a.id}`,
      background: true,
    });
    await finish(username, a.id, "done", text);
  } catch (e) {
    await finish(username, a.id, "error", e instanceof Error ? e.message : String(e));
  }
}

/** Starts the run: sets lastRun and the running flag, clears the flag when it ends. Never rejects (a timer must not crash the server). */
function start(username: string, a: Automation, now: number, run: (username: string, a: Automation) => Promise<void>): Promise<void> {
  running.add(a.id);
  try {
    const list = readAll(username);
    const cur = list.find((x) => x.id === a.id);
    if (cur) {
      cur.lastRun = now;
      writeAll(username, list);
    }
  } catch (e) {
    running.delete(a.id);
    console.error("[automations]", e);
    return Promise.resolve();
  }
  return run(username, a)
    .catch((e) => console.error("[automations]", e))
    .finally(() => running.delete(a.id));
}

/**
 * Starts every enabled automation whose next run has come (no catch-up storm: a missed slot runs once, then the
 * next one is counted from now). Resolves when the runs it started have ended. Exported for tests (`run` is the runner).
 */
export async function tick(now = Date.now(), run: (username: string, a: Automation) => Promise<void> = runAutomation): Promise<void> {
  const starts: Promise<void>[] = [];
  for (const u of listUsers()) {
    // one account's unreadable file must not hold up everyone else's runs this minute
    try {
      for (const a of readAll(u.username)) {
        if (!a.enabled || running.has(a.id) || nextRunOf(a) > now) continue;
        starts.push(start(u.username, a, now, run));
      }
    } catch (e) {
      console.error("[automations]", u.username, e);
    }
  }
  await Promise.all(starts);
}

/** Production only (dev servers share their data folder with test data). */
export function startAutomations(): void {
  if (!env.isProduction || !env.appSecret) return;
  setInterval(() => void tick().catch((e) => console.error("[automations]", e)), 60_000).unref();
}

/* ---- REST ---- */

type Input = Record<string, unknown>;

/** The fields a request sets, each checked. `error` names the first one that is not valid. */
function readFields(b: Input): { fields: Partial<Automation>; error?: string } {
  const fields: Partial<Automation> = {};
  if ("name" in b) {
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name || name.length > AUTOMATION_NAME_MAX) return { fields, error: `name: 1 to ${AUTOMATION_NAME_MAX} characters` };
    fields.name = name;
  }
  if ("prompt" in b) {
    const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
    if (!prompt || prompt.length > AUTOMATION_PROMPT_MAX) return { fields, error: `prompt: 1 to ${AUTOMATION_PROMPT_MAX} characters` };
    fields.prompt = prompt;
  }
  if ("enabled" in b) {
    if (typeof b.enabled !== "boolean") return { fields, error: "enabled: true or false" };
    fields.enabled = b.enabled;
  }
  if ("project" in b) {
    if (b.project !== null && (typeof b.project !== "string" || b.project.length > 100)) return { fields, error: "project: a Workshop project id, or null" };
    fields.project = b.project ? (b.project as string) : undefined;
  }
  if ("timezone" in b) {
    if (typeof b.timezone !== "string" || !validTimezone(b.timezone)) return { fields, error: "timezone: an IANA name such as Europe/Berlin" };
    fields.timezone = b.timezone;
  }
  if ("schedule" in b) {
    const err = scheduleError(b.schedule);
    if (err) return { fields, error: err };
    fields.schedule = normalizeSchedule(b.schedule as Record<string, unknown>) as Schedule;
  }
  return { fields };
}

/** The account's tasks, and why none can run for it now (`blocked`, null when one can): the page then builds none. */
automationsApp.get("/", (c) => {
  const username = c.get("user").username;
  const admin = isAdminHere(username);
  return c.json({ items: readAll(username).map(view), blocked: blockOf(routeOf(username, admin), admin) });
});

automationsApp.post("/", async (c) => {
  const username = c.get("user").username;
  const b = (await c.req.json().catch(() => null)) as Input | null;
  if (!b || typeof b !== "object") return c.json({ error: "Send the scheduled task as JSON" }, 400);
  const { fields, error } = readFields(b);
  if (error) return c.json({ error }, 400);
  if (!fields.name || !fields.prompt || !fields.schedule) return c.json({ error: "name, schedule and prompt are needed" }, 400);
  // a wall-clock schedule needs a zone; an every-N-hours one doesn't care
  if (!fields.timezone) {
    if (fields.schedule.kind !== "hours") return c.json({ error: "timezone (an IANA name such as Europe/Berlin) is needed for a daily or weekly schedule" }, 400);
    fields.timezone = "UTC";
  }
  const a: Automation = {
    id: randomUUID(),
    name: fields.name,
    schedule: fields.schedule,
    prompt: fields.prompt,
    enabled: fields.enabled ?? true,
    timezone: fields.timezone,
    ...(fields.project ? { project: fields.project } : {}),
    createdAt: Date.now(),
  };
  writeAll(username, [...readAll(username), a]);
  return c.json(view(a), 201);
});

automationsApp.patch("/:id", async (c) => {
  const username = c.get("user").username;
  const list = readAll(username);
  const a = list.find((x) => x.id === c.req.param("id"));
  if (!a) return c.json({ error: "Not found" }, 404);
  const b = (await c.req.json().catch(() => null)) as Input | null;
  if (!b || typeof b !== "object") return c.json({ error: "Send the changes as JSON" }, 400);
  const { fields, error } = readFields(b);
  if (error) return c.json({ error }, 400);
  // a new schedule or a re-enabled automation counts from now: it must not fire for the time it was off or set aside
  const restart = ("schedule" in fields) || (fields.enabled === true && !a.enabled);
  if (restart) a.lastRun = Date.now();
  const { project, ...rest } = fields;
  Object.assign(a, rest);
  if ("project" in b) {
    if (project) a.project = project;
    else delete a.project;
  }
  writeAll(username, list);
  return c.json(view(a));
});

automationsApp.delete("/:id", (c) => {
  const username = c.get("user").username;
  const list = readAll(username);
  const left = list.filter((x) => x.id !== c.req.param("id"));
  if (left.length === list.length) return c.json({ error: "Not found" }, 404);
  writeAll(username, left);
  return c.json({ ok: true });
});

/** Run now: starts it and answers at once (a run takes minutes; its result lands in lastResult and the inbox). */
automationsApp.post("/:id/run", (c) => {
  const username = c.get("user").username;
  const a = readAll(username).find((x) => x.id === c.req.param("id"));
  if (!a) return c.json({ error: "Not found" }, 404);
  if (running.has(a.id)) return c.json({ error: "This task is already running" }, 409);
  void start(username, a, Date.now(), runAutomation);
  return c.json({ ...view(a), running: true }, 202);
});
