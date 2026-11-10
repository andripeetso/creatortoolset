import { EFFORTS, type Effort, type Selection } from "./providers";

/**
 * Scheduled tasks (api/automations.ts): a prompt the account's AI runs on its own, posting each run into an assistant
 * chat. A schedule is a wall-clock time on chosen weekdays in the task's timezone, one date and time, or a repeat
 * interval. No cron strings.
 */

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type Schedule =
  /** At `at` (HH:MM) on these weekdays (0 = Sunday); none listed = every day. */
  | { kind: "fixed"; at: string; weekdays?: Weekday[] }
  /** Once, at this instant (epoch ms). */
  | { kind: "once"; runAt: number }
  | { kind: "interval"; everyMinutes: number };

/**
 * Where runs go: new_chat = a new assistant chat each run; continue = one chat, each run carries on its conversation;
 * fresh = one chat, each run answers without the earlier runs' context.
 */
export type Destination = "new_chat" | "continue" | "fresh";
export const DESTINATIONS: readonly Destination[] = ["new_chat", "continue", "fresh"];

export interface AutomationResult {
  at: number;
  /** done = the answer; error = the run failed; skipped = nothing ran (no AI, Mac offline, …) */
  status: "done" | "error" | "skipped";
  text: string;
  /** The chat the run posted in. */
  chat?: string;
}

export interface Automation {
  id: string;
  name: string;
  schedule: Schedule;
  prompt: string;
  enabled: boolean;
  /** Which AI runs it: an AI (on one computer), its model and thinking. Absent = the assistant's AI at run time. */
  ai?: Selection;
  destination: Destination;
  /** The chat continue and fresh runs post in: set by the first run, or the chat the task was made from. */
  chat?: string;
  /** A Workshop project id: the run is told which project it works in. */
  project?: string;
  /** IANA name, such as Europe/Berlin: the account's zone when it was made. */
  timezone: string;
  createdAt: number;
  /** When it last started (epoch ms); the next run is counted from here. */
  lastRun?: number;
  lastResult?: AutomationResult;
}

export const AUTOMATION_NAME_MAX = 80;
export const AUTOMATION_PROMPT_MAX = 4000;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** A week, in minutes. */
export const INTERVAL_MAX = 7 * 24 * 60;
export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

const isWeekday = (d: unknown): d is Weekday => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6;
/** runAt as epoch ms: a number, or an ISO date and time with its offset (what an AI sends). NaN when neither. */
const runAtOf = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && /([zZ]|[+-]\d{2}:\d{2})$/.test(v) ? Date.parse(v) : NaN);

/** Why a schedule is not valid, or null. */
export function scheduleError(s: unknown): string | null {
  const x = (s ?? {}) as Record<string, unknown>;
  if (x.kind === "fixed") {
    if (typeof x.at !== "string" || !TIME_RE.test(x.at)) return "schedule.at is the time as HH:MM (24 hours), such as 09:00";
    if (x.weekdays !== undefined && !(Array.isArray(x.weekdays) && x.weekdays.length > 0 && x.weekdays.every(isWeekday)))
      return "schedule.weekdays lists days 0 (Sunday) to 6 (Saturday); leave it out for every day";
    return null;
  }
  if (x.kind === "once") return Number.isFinite(runAtOf(x.runAt)) ? null : "schedule.runAt is a date and time with its offset, such as 2026-11-12T15:00:00+01:00";
  if (x.kind === "interval")
    return Number.isInteger(x.everyMinutes) && (x.everyMinutes as number) >= 1 && (x.everyMinutes as number) <= INTERVAL_MAX
      ? null
      : `schedule.everyMinutes is a whole number of minutes, 1 to ${INTERVAL_MAX}`;
  return "schedule.kind is fixed, once or interval";
}

/**
 * The schedule with only its own fields (after scheduleError returned null). Also reads a task saved before these
 * kinds: daily, weekly on one day, every N hours.
 */
export function normalizeSchedule(s: Record<string, unknown>): Schedule {
  if (s.kind === "daily") return { kind: "fixed", at: s.at as string };
  if (s.kind === "weekly") return { kind: "fixed", at: s.at as string, weekdays: [s.weekday as Weekday] };
  if (s.kind === "hours") return { kind: "interval", everyMinutes: (s.every as number) * 60 };
  if (s.kind === "once") return { kind: "once", runAt: runAtOf(s.runAt) };
  if (s.kind === "interval") return { kind: "interval", everyMinutes: s.everyMinutes as number };
  const days = [...new Set((s.weekdays as Weekday[] | undefined) ?? [])].sort((a, b) => a - b);
  return { kind: "fixed", at: s.at as string, ...(days.length && days.length < 7 ? { weekdays: days } : {}) };
}

/** A thinking level the providers know. */
export const isEffort = (e: unknown): e is Effort => (EFFORTS as readonly unknown[]).includes(e);

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The wall clock of instant t in zone tz, read as if it were UTC (ms). */
function wallOf(t: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(t));
  const v = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return Date.UTC(v("year"), v("month") - 1, v("day"), v("hour"), v("minute"), v("second"));
}

const offsetAt = (t: number, tz: string) => wallOf(t, tz) - Math.floor(t / 1000) * 1000;

/**
 * The instant whose wall clock in tz reads `wall` (ms as UTC). In a DST gap (a time that doesn't exist that day)
 * it gives the instant after the jump; a repeated time gives its later occurrence (the standard-time one). Either way
 * the day after is back on time.
 */
function instantOf(wall: number, tz: string): number {
  const o1 = offsetAt(wall, tz);
  const t1 = wall - o1;
  const o2 = offsetAt(t1, tz);
  return o1 === o2 ? t1 : wall - o2;
}

/**
 * The first run strictly after `after` (epoch ms), or null (a once task whose time has gone). An interval counts from
 * `after`; a fixed time is a wall clock in tz.
 */
export function nextRunAfter(s: Schedule, tz: string, after: number): number | null {
  if (s.kind === "interval") return after + s.everyMinutes * 60_000;
  if (s.kind === "once") return s.runAt > after ? s.runAt : null;
  const [h, m] = s.at.split(":").map(Number) as [number, number];
  const local = new Date(wallOf(after, tz));
  const y = local.getUTCFullYear();
  const mo = local.getUTCMonth();
  const d = local.getUTCDate();
  const days = s.weekdays?.length ? new Set<number>(s.weekdays) : null;
  // a slot is at most 7 days away, so 9 candidate days always reach one
  for (let k = 0; k <= 8; k++) {
    const day = Date.UTC(y, mo, d + k);
    if (days && !days.has(new Date(day).getUTCDay())) continue;
    const t = instantOf(day + (h * 60 + m) * 60_000, tz);
    if (t > after) return t;
  }
  throw new Error("nextRunAfter: no slot within 9 days");
}
