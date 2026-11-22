import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { jobTurn, type AuthVars } from "./auth";
import { chatBusy, chatOfTurn, isAdminHere, routeOf, runInChat, setRunEnded, toolsUrl } from "./assistant";
import { announceSoon } from "./lib/announce-soon";
import { deviceName, isOnline } from "./lib/devices";
import { env } from "./lib/env";
import type { Route } from "./lib/providers";
import { notifyWorkshopOwner } from "./review";
import { listUsers, USERNAME_RE } from "./users";
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
import { currentWorkspaceId, inCurrentWorkspace } from "./lib/workspace-scope";
import { projectOf } from "./lib/project-of";

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
// "Run it now"'s card runs while the task does (assistant.ts sweepWork): its answer is in the task's own chat
void import("./assistant").then(({ checkWork }) => checkWork("automation", (id) => (running.has(id.slice("automation:".length)) ? null : { status: "done", detail: "Ran: the answer is in its chat" })));

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

/** The account's tasks for a workspace being deleted (lib/workspace-delete.ts), `pick` by their workspace, and their delete. */
export function workspaceTasks(username: string, pick: (project?: string) => boolean): { n: number; drop: () => Promise<void> } {
  const ids = new Set(readAll(username).filter((a) => pick(a.project)).map((a) => a.id));
  return {
    n: ids.size,
    drop: async () => {
      if (ids.size) writeAll(username, readAll(username).filter((a) => !ids.has(a.id)));
    },
  };
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

// what is missing, as Settings names it: the page shows it where New task would be, a task's row after "Skipped"
const NO_AI = "Needs an AI provider";
// a member's route never includes the team's AI (routeOf), and a member cannot add a computer for the team: say that instead
const NO_AI_MEMBER = "Needs Claude Code on a computer";
const NOT_CLAUDE = "Needs Claude Code";
const AI_GONE = "AI provider not found or turned off";
/** Why no task can run for this account, in plain words, or null. The page shows it before a task is built. */
export const blockOf = (route: Route | null, admin = true): string | null =>
  !route ? (admin ? NO_AI : NO_AI_MEMBER) : route.instance.driver !== "claude" ? NOT_CLAUDE : null;

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
  if (!url) return { skip: "Needs the server's address (PUBLIC_ORIGIN, the server's own address, set in its settings)" };
  if (!isOnline(route.device)) return { wait: `${deviceName(route.device)} is offline` };
  if (a.destination !== "new_chat" && chatBusy(username, a.chat)) return { wait: "its chat is busy" };
  return { route, url };
}

const prefaceOf = (a: Automation): string =>
  `This is a run of the scheduled task "${a.name}". Nobody is at the screen: do the work with the app's tools, and don't open pages with navigate.${a.project ? ` Its workspace is ${a.project}.` : ""}`;

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
  announceSoon(username, "automations"); // the row shows the result (a skipped run has no start or end to tell)
  if (again) return;
  await notifyWorkshopOwner(username, {
    kind: r.status === "done" ? "workshop" : "failed",
    by: "Scheduled tasks",
    name: a?.name ?? "A scheduled task",
    text: `${r.status === "done" ? "" : `${r.status === "error" ? "Failed" : "Skipped"}: `}${r.text}`,
    href: r.chat ? `/?chat=${r.chat}` : `/settings/automations?task=${id}`,
    ref: id,
    workspace: a?.project,
  }).catch(() => {});
}

// a run whose reply went on after a restart of the server (assistant.ts onAdopt) is recorded like any other
setRunEnded((username, id, result) => void finish(username, id, result));

/** Runs one task as a turn in its chat and records the result. Resolves once it is recorded. */
export async function runAutomation(username: string, a: Automation, ready: { route: Route; url: string }): Promise<void> {
  try {
    const { chat, text } = await runInChat(username, {
      chat: a.destination === "new_chat" ? undefined : a.chat,
      task: { id: a.id, name: a.name },
      prompt: a.prompt,
      preface: prefaceOf(a),
      // the run works in the task's workspace and is told its context, whatever the app has open then
      workspace: a.project,
      fresh: a.destination !== "continue",
      route: ready.route,
      url: ready.url,
    });
    await finish(username, a.id, { status: "done", text, chat });
  } catch (e) {
    await finish(username, a.id, { status: "error", text: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * An interval task's latest slot at or before `now` on its grid (from its last run, or its creation). A slot missed while
 * the server was off is skipped, not run in a burst, and the next one is a whole interval after this one.
 */
const latestSlot = (a: Automation, now: number): number => {
  const every = (a.schedule as { everyMinutes: number }).everyMinutes * 60_000;
  const anchor = a.lastRun ?? a.createdAt;
  return anchor + Math.floor((now - anchor) / every) * every;
};

/* ---- one run at a time across processes: two servers on one data folder would both run a due task ---- */

/** A run is minutes long; a lock older than this, or whose process is gone, was left by a crash and is taken. */
const RUN_LOCK_STALE_MS = 6 * 3_600_000;
const lockOf = (id: string) => path.join(env.dataDir, "automations-locks", `${id}.lock`);
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Takes task `id`'s run lock for this process, or false when a live process holds it. Released by releaseRunLock. */
function takeRunLock(id: string, now = Date.now()): boolean {
  const file = lockOf(id);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const make = (): boolean => {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
  };
  if (make()) return true;
  // an unreadable or just-written lock is judged by its age; a gone one is retried on the next tick
  let age = 0;
  let held: { pid?: number } = {};
  try {
    age = now - statSync(file).mtimeMs;
    held = JSON.parse(readFileSync(file, "utf-8")) ?? {};
  } catch {
    // empty, unreadable or gone: decided by age below
  }
  if (age < RUN_LOCK_STALE_MS && (!held.pid || alive(held.pid))) return false;
  rmSync(file, { force: true });
  return make();
}

const releaseRunLock = (id: string): void => rmSync(lockOf(id), { force: true });

/**
 * Starts the run: sets lastRun to `at` (the slot an interval task runs for, else now) and the running flag, and clears the
 * flag and the run lock when it ends. Never rejects (a timer must not crash the server).
 */
function start(username: string, a: Automation, at: number, go: () => Promise<void>): Promise<void> {
  running.add(a.id);
  try {
    update(username, a.id, (x) => (x.lastRun = at));
  } catch (e) {
    running.delete(a.id);
    releaseRunLock(a.id);
    console.error("[automations]", e);
    return Promise.resolve();
  }
  announceSoon(username, "automations"); // the open Settings page says Running now
  return go()
    .catch((e) => console.error("[automations]", e))
    .finally(() => {
      running.delete(a.id);
      releaseRunLock(a.id);
      announceSoon(username, "automations"); // told once the flag is down, so the row leaves Running now
    });
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
        if (running.has(a.id) || due === null || due > now || !takeRunLock(a.id, now)) continue;
        // an interval task is recorded at the slot it runs for, not at this tick: a tick a few seconds late does not move its times
        const at = a.schedule.kind === "interval" ? latestSlot(a, now) : now;
        let handed = false;
        try {
          const r = ready(u.username, a);
          const late = a.schedule.kind === "fixed" && now - due > MISSED_MS;
          if ("route" in r && !late) {
            handed = true; // start() releases the lock when the run ends
            starts.push(start(u.username, a, at, () => run(u.username, a, r)));
            continue;
          }
          if ("wait" in r && !late) continue;
          const when = new Intl.DateTimeFormat("en-GB", { timeZone: a.timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(due));
          const why = "skip" in r ? r.skip : `Missed the ${when} run (${"wait" in r ? r.wait : "the server was off"})`;
          update(u.username, a.id, (x) => (x.lastRun = at));
          starts.push(finish(u.username, a.id, { status: "skipped", text: why }));
        } finally {
          if (!handed) releaseRunLock(a.id);
        }
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
    if (b.project !== null && (typeof b.project !== "string" || b.project.length > 100)) return { fields, error: "project: a Workshop workspace id, or null" };
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
    if (ai === "bad") return { fields, error: "ai: { instance, model, effort } of one of the account's AI providers, or null for the assistant's" };
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
const PAST_ONCE = "The run time has passed";

/**
 * The account's tasks, and why none can run for it now (`blocked`, null when one can): the page then builds none.
 * ?all=1: every workspace's tasks (Settings → Scheduled tasks on All workspaces), each with the workspace it is in.
 */
automationsApp.get("/", async (c) => {
  const username = c.get("user").username;
  const admin = isAdminHere(username);
  // a task for one workspace is listed in it alone; one for no workspace in every one
  const all = c.req.query("all") === "1";
  const [here, of] = await Promise.all([all ? null : inCurrentWorkspace(c.get("user")), all ? projectOf(c.get("user")) : null]);
  const items = readAll(username).filter((a) => !a.project || !here || here(a.project));
  // a task whose workspace was deleted is the first brand's (project-of.ts): the list names that one, as the filter does
  const named = (a: Automation): Automation => (a.project && of ? { ...a, project: of(a.project) } : a);
  return c.json({ items: items.map((a) => view(named(a))), blocked: blockOf(routeOf(username, admin), admin) });
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
  // a new task is the workspace's it was made in (a chat's tasks its chat's); `project: null` asks for every workspace
  if (!("project" in b)) fields.project = await currentWorkspaceId(c.get("user"));
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
  // refused now rather than skipped at every run (readiness): the assistant on Codex has this route too
  const route = routeOf(username, isAdminHere(username), a.ai);
  if (route && route.instance.driver !== "claude") return c.json({ error: NOT_CLAUDE }, 409);
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
  if (!("route" in r)) return c.json({ error: "wait" in r ? `Could not run it now: ${r.wait}` : r.skip }, 409);
  // a manual run counts as its run for an interval or a fixed time; a once task keeps its date (nextRunAfter counts from
  // lastRun, and a run before that date leaves it ahead)
  void start(username, a, Date.now(), () => runAutomation(username, a, r));
  return c.json({ ...view(a), running: true }, 202);
});
