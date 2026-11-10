import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { jobTurn, type AuthVars } from "./auth";
import { chatBusy, chatOfTurn, routeOf, runInChat } from "./assistant";
import { deviceName, isOnline } from "./lib/devices";
import { env, hostedMode } from "./lib/env";
import type { Route } from "./lib/providers";
import { notifyWorkshopOwner } from "./review";
import { findUser, listUsers, USERNAME_RE } from "./users";
import {
  AUTOMATION_NAME_MAX,
  AUTOMATION_PROMPT_MAX,
  DESTINATIONS,
  isEffort,
  nextRunAfter,
  normalizeSchedule,
  scheduleError,
  validTimezone,
  type Automation,
  type AutomationResult,
  type Destination,
} from "../contracts/automations";
import type { Selection } from "../contracts/providers";

/**
 * Scheduled tasks (contracts/automations.ts): $DATA_DIR/automations/<user>.json, one list per account. A run is a turn
 * in one of the account's assistant chats (assistant.ts runInChat) on the AI the task names (never the workspace's AI
 * for a member, never an API key), and the inbox says it ran. startAutomations() checks once a minute in production.
 * The routes sit behind the account gate, so a Full key reaches them (your own AI over the MCP), and so does the
 * assistant's job token: a task made from a chat posts its runs in that chat and runs on that chat's AI.
 */

export const automationsApp = new Hono<{ Variables: AuthVars }>();

const RESULT_MAX = 2000;
/** A fixed-time run this late (the server or the Mac was off) is skipped, and the task waits for its next time. */
export const MISSED_MS = 10 * 60_000;
/** Which tasks are running now (this process): one run at a time per task. */
const running = new Set<string>();

/* ---- the store: sync read, sync write, so a read-modify-write can't interleave with another in this process ---- */

const dirOf = () => path.join(env.dataDir, "automations");
const fileOf = (username: string) => path.join(dirOf(), `${username}.json`);

/** A task saved before destinations and the new schedule kinds reads as a new-chat task on the same times. */
const upgrade = (a: Automation): Automation => ({
  ...a,
  schedule: normalizeSchedule(a.schedule as unknown as Record<string, unknown>),
  destination: a.destination ?? "new_chat",
});

function readAll(username: string): Automation[] {
  if (!USERNAME_RE.test(username)) return [];
  try {
    return (JSON.parse(readFileSync(fileOf(username), "utf-8")) as Automation[]).map(upgrade);
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

/** Changes one task in the account's list; a task deleted meanwhile is left gone. */
function update(username: string, id: string, change: (a: Automation) => void): Automation | null {
  const list = readAll(username);
  const a = list.find((x) => x.id === id);
  if (!a) return null;
  change(a);
  writeAll(username, list);
  return a;
}

/** The next run, from its last one (or from its creation); null when it is off or a once task has run. */
const nextRunOf = (a: Automation): number | null => (a.enabled ? nextRunAfter(a.schedule, a.timezone, a.lastRun ?? a.createdAt) : null);

/** As the page shows it: a fixed time already missed shows the slot after now (the scheduler skips the missed one). */
const view = (a: Automation, now = Date.now()) => {
  const due = nextRunOf(a);
  const next = due !== null && a.schedule.kind === "fixed" && now - due > MISSED_MS ? nextRunAfter(a.schedule, a.timezone, now) : due;
  return { ...a, running: running.has(a.id), nextRun: next };
};

/* ---- one run ---- */

const NO_AI = "No Claude Code is set up for your AI here. Add it on a computer in Providers.";
// a member's route never includes the team's AI (routeOf), and a member cannot add a computer for the team: say that instead
const NO_AI_MEMBER = "Scheduled tasks need Claude Code on one of your computers. Your team's AI can't run them.";
const NOT_CLAUDE = "Scheduled tasks run on Claude Code, and this AI is another tool. Edit the task to pick Claude Code.";
const AI_GONE = "The AI this task runs on is gone or switched off. Edit the task to pick another.";
/** True for an admin, and for every account on an install of one's own (no team to be a member of). */
const isAdminHere = (username: string) => !hostedMode() || findUser(username)?.role === "admin";
/** Why no task can run for this account, in plain words, or null. The page shows it before a task is built. */
export const blockOf = (route: Route | null, admin = true): string | null =>
  !route ? (admin ? NO_AI : NO_AI_MEMBER) : route.instance.driver !== "claude" ? NOT_CLAUDE : null;

/** The tools' address: PUBLIC_ORIGIN, else the Mac app's own server on this Mac (CT_LOCAL), where the Mac's AI runs too. */
const toolsUrl = () => {
  const origin = process.env.PUBLIC_ORIGIN?.replace(/\/$/, "") || (process.env.CT_LOCAL === "1" && process.env.PORT ? `http://127.0.0.1:${process.env.PORT}` : "");
  return origin ? `${origin}/api/mcp` : null;
};

/**
 * Whether a task can run now: its route; `wait` when it can run later by itself (its computer is offline, its chat is
 * answering); `skip` when a person has to change something first.
 */
export type Readiness = { route: Route; url: string } | { wait: string } | { skip: string };

export function readiness(username: string, a: Automation): Readiness {
  const admin = isAdminHere(username);
  const route = routeOf(username, admin, a.ai);
  if (!route) return { skip: a.ai ? AI_GONE : admin ? NO_AI : NO_AI_MEMBER };
  if (route.instance.driver !== "claude") return { skip: NOT_CLAUDE };
  const url = toolsUrl();
  if (!url) return { skip: "This server doesn't know its own address, so the task can't reach the app's tools. Ask whoever runs this server." };
  if (!isOnline(route.device)) return { wait: `${deviceName(route.device)} is offline` };
  if (a.destination !== "new_chat" && chatBusy(username, a.chat)) return { wait: "its chat is still answering" };
  return { route, url };
}

const prefaceOf = (a: Automation): string =>
  `This is a run of the scheduled task "${a.name}". Nobody is at the screen: do the work with the app's tools, and don't open pages with navigate.${a.project ? ` Its Workshop project is ${a.project}.` : ""}`;

/** Records a run's outcome on the task and tells the inbox. Never fails the run that reports. */
async function finish(username: string, id: string, result: Omit<AutomationResult, "at">): Promise<void> {
  const r: AutomationResult = { ...result, at: Date.now(), text: result.text.slice(0, RESULT_MAX) };
  let again = false;
  const a = update(username, id, (x) => {
    // the same skip or failure as last time is on the task already: the inbox hears it once
    again = r.status !== "done" && x.lastResult?.status === r.status && x.lastResult.text === r.text;
    x.lastResult = r;
    // a one-chat task keeps the chat its first run made (or the one it was made from, if that one is gone: the new one)
    if (r.chat && x.destination !== "new_chat") x.chat = r.chat;
  });
  if (again) return;
  await notifyWorkshopOwner(username, {
    kind: r.status === "done" ? "workshop" : "failed",
    by: "Scheduled tasks",
    name: a?.name ?? "A scheduled task",
    text: `${r.status === "done" ? "" : `${r.status === "error" ? "Failed" : "Skipped"}: `}${r.text}`,
    href: r.chat ? `/?chat=${r.chat}` : `/settings/automations?task=${id}`,
    ref: id,
  }).catch(() => {});
}

/** Runs one task as a turn in its chat and records the result. Resolves once it is recorded. */
export async function runAutomation(username: string, a: Automation, ready: { route: Route; url: string }): Promise<void> {
  try {
    const { chat, text } = await runInChat(username, {
      chat: a.destination === "new_chat" ? undefined : a.chat,
      task: { id: a.id, name: a.name },
      prompt: a.prompt,
      preface: prefaceOf(a),
      fresh: a.destination !== "continue",
      route: ready.route,
      url: ready.url,
    });
    await finish(username, a.id, { status: "done", text, chat });
  } catch (e) {
    await finish(username, a.id, { status: "error", text: e instanceof Error ? e.message : String(e) });
  }
}

/** Starts the run: sets lastRun and the running flag, clears the flag when it ends. Never rejects (a timer must not crash the server). */
function start(username: string, a: Automation, now: number, go: () => Promise<void>): Promise<void> {
  running.add(a.id);
  try {
    update(username, a.id, (x) => (x.lastRun = now));
  } catch (e) {
    running.delete(a.id);
    console.error("[automations]", e);
    return Promise.resolve();
  }
  return go()
    .catch((e) => console.error("[automations]", e))
    .finally(() => running.delete(a.id));
}

type Runner = (username: string, a: Automation, ready: { route: Route; url: string }) => Promise<void>;
type Ready = (username: string, a: Automation) => Readiness;

/**
 * Starts every enabled task whose time has come. One that can't run yet waits (it runs when its computer is back), but
 * a fixed-time run more than MISSED_MS late is skipped and the task waits for its next time; one a person has to fix
 * is skipped with the reason. Resolves when the runs it started have ended. Exported for tests.
 */
export async function tick(now = Date.now(), run: Runner = runAutomation, ready: Ready = readiness): Promise<void> {
  const starts: Promise<void>[] = [];
  for (const u of listUsers()) {
    // one account's unreadable file must not hold up everyone else's runs this minute
    try {
      for (const a of readAll(u.username)) {
        const due = nextRunOf(a);
        if (running.has(a.id) || due === null || due > now) continue;
        const r = ready(u.username, a);
        const late = a.schedule.kind === "fixed" && now - due > MISSED_MS;
        if ("route" in r && !late) {
          starts.push(start(u.username, a, now, () => run(u.username, a, r)));
          continue;
        }
        if ("wait" in r && !late) continue;
        const at = new Intl.DateTimeFormat("en-GB", { timeZone: a.timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(due));
        const why = "skip" in r ? r.skip : `Missed the ${at} run (${"wait" in r ? r.wait : "the server was off"}).`;
        update(u.username, a.id, (x) => (x.lastRun = now));
        starts.push(finish(u.username, a.id, { status: "skipped", text: why }));
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

function readAi(v: unknown): Selection | null | "bad" {
  if (v === null) return null;
  const x = (v ?? {}) as Input;
  return typeof x.instance === "string" && x.instance && typeof x.model === "string" && isEffort(x.effort) ? { instance: x.instance, model: x.model, effort: x.effort } : "bad";
}

/** The fields a request sets, each checked. `error` names the first one that is not valid. */
function readFields(b: Input): { fields: Omit<Partial<Automation>, "ai"> & { ai?: Selection | null }; error?: string } {
  const fields: Omit<Partial<Automation>, "ai"> & { ai?: Selection | null } = {};
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
  if ("destination" in b) {
    if (!DESTINATIONS.includes(b.destination as Destination)) return { fields, error: `destination: ${DESTINATIONS.join(", ")}` };
    fields.destination = b.destination as Destination;
  }
  if ("ai" in b) {
    const ai = readAi(b.ai);
    if (ai === "bad") return { fields, error: "ai: { instance, model, effort } of one of your AIs, or null for the assistant's" };
    fields.ai = ai;
  }
  if ("schedule" in b) {
    const err = scheduleError(b.schedule);
    if (err) return { fields, error: err };
    fields.schedule = normalizeSchedule(b.schedule as Input);
  }
  return { fields };
}

/** An enabled once task whose time has gone would never run: refused on save. */
const pastOnce = (a: Pick<Automation, "enabled" | "schedule">, now: number) => a.enabled && a.schedule.kind === "once" && a.schedule.runAt <= now;
const PAST_ONCE = "The run time has passed. Pick a time in the future.";

/** The account's tasks, and why none can run for it now (`blocked`, null when one can): the page then builds none. */
automationsApp.get("/", (c) => {
  const username = c.get("user").username;
  const admin = isAdminHere(username);
  return c.json({ items: readAll(username).map((a) => view(a)), blocked: blockOf(routeOf(username, admin), admin) });
});

/**
 * A new task. Made from an assistant chat (its job token), it posts in that chat and runs on that chat's AI unless the
 * request says otherwise; made elsewhere, it starts a new chat each run on the assistant's AI.
 */
automationsApp.post("/", async (c) => {
  const username = c.get("user").username;
  const b = (await c.req.json().catch(() => null)) as Input | null;
  if (!b || typeof b !== "object") return c.json({ error: "Send the scheduled task as JSON" }, 400);
  const { fields, error } = readFields(b);
  if (error) return c.json({ error }, 400);
  if (!fields.prompt || !fields.schedule) return c.json({ error: "schedule and prompt are needed" }, 400);
  // a wall-clock schedule needs a zone; an interval or one instant doesn't care
  if (!fields.timezone) {
    if (fields.schedule.kind === "fixed") return c.json({ error: "timezone (an IANA name such as Europe/Berlin) is needed for a schedule at a time of day" }, 400);
    fields.timezone = "UTC";
  }
  const turn = jobTurn(c.req.header("authorization"));
  const chat = turn ? chatOfTurn(username, turn) : null;
  const destination = fields.destination ?? (chat ? "continue" : "new_chat");
  const ai = fields.ai === undefined ? routeOf(username, isAdminHere(username))?.selection : fields.ai;
  const now = Date.now();
  const a: Automation = {
    id: randomUUID(),
    name: fields.name ?? (fields.prompt.length > 60 ? `${fields.prompt.slice(0, 59).trim()}…` : fields.prompt),
    schedule: fields.schedule,
    prompt: fields.prompt,
    enabled: fields.enabled ?? true,
    destination,
    ...(ai ? { ai: { instance: ai.instance, model: ai.model, effort: ai.effort } } : {}),
    ...(chat && destination !== "new_chat" ? { chat } : {}),
    timezone: fields.timezone,
    ...(fields.project ? { project: fields.project } : {}),
    createdAt: now,
  };
  if (pastOnce(a, now)) return c.json({ error: PAST_ONCE }, 400);
  writeAll(username, [...readAll(username), a]);
  return c.json(view(a), 201);
});

/** Only the fields given change. A new schedule, or turning it on, counts the next run from now. */
automationsApp.patch("/:id", async (c) => {
  const username = c.get("user").username;
  const list = readAll(username);
  const a = list.find((x) => x.id === c.req.param("id"));
  if (!a) return c.json({ error: "Not found" }, 404);
  const b = (await c.req.json().catch(() => null)) as Input | null;
  if (!b || typeof b !== "object") return c.json({ error: "Send the changes as JSON" }, 400);
  const { fields, error } = readFields(b);
  if (error) return c.json({ error }, 400);
  const now = Date.now();
  // it must not fire for the time it was off or set aside
  const restart = "schedule" in fields || (fields.enabled === true && !a.enabled);
  const { project, ai, ...rest } = fields;
  // a once task that has run can still be renamed: its time is checked only when the schedule or the switch changes
  if (("schedule" in fields || "enabled" in fields) && pastOnce({ ...a, ...rest }, now)) return c.json({ error: PAST_ONCE }, 400);
  Object.assign(a, rest);
  if (restart) a.lastRun = now;
  if ("project" in b) {
    if (project) a.project = project;
    else delete a.project;
  }
  if ("ai" in b) {
    if (ai) a.ai = ai;
    else delete a.ai;
  }
  if (a.destination === "new_chat") delete a.chat;
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

/** Run now: starts it and answers at once (a run takes minutes; its reply lands in its chat and the inbox). */
automationsApp.post("/:id/run", (c) => {
  const username = c.get("user").username;
  const a = readAll(username).find((x) => x.id === c.req.param("id"));
  if (!a) return c.json({ error: "Not found" }, 404);
  if (running.has(a.id)) return c.json({ error: "This task is already running" }, 409);
  const r = readiness(username, a);
  if (!("route" in r)) return c.json({ error: "wait" in r ? `Can't run it now: ${r.wait}.` : r.skip }, 409);
  // a manual run counts as its run for an interval or a fixed time; a once task keeps its date (nextRunAfter counts from
  // lastRun, and a run before that date leaves it ahead)
  void start(username, a, Date.now(), () => runAutomation(username, a, r));
  return c.json({ ...view(a), running: true }, 202);
});
