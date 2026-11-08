/**
 * Automations (api/automations.ts): a prompt the account's own AI assistant runs on a schedule. A schedule is a
 * wall-clock time in the automation's timezone (daily, weekly on a weekday) or every N hours. No cron strings.
 */

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type Schedule =
  | { kind: "daily"; at: string }
  | { kind: "weekly"; weekday: Weekday; at: string }
  | { kind: "hours"; every: number };

export interface AutomationResult {
  at: number;
  /** done = the answer; error = the run failed; skipped = nothing ran (no AI, Mac offline, …) */
  status: "done" | "error" | "skipped";
  text: string;
}

export interface Automation {
  id: string;
  name: string;
  schedule: Schedule;
  prompt: string;
  enabled: boolean;
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
const HOURS_MAX = 168;
export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** Why a schedule is not valid, or null. Accepts only the fields each kind uses. */
export function scheduleError(s: unknown): string | null {
  const x = (s ?? {}) as Record<string, unknown>;
  if (x.kind === "daily" || x.kind === "weekly") {
    if (typeof x.at !== "string" || !TIME_RE.test(x.at)) return "schedule.at is the time as HH:MM (24 hours), such as 09:00";
    if (x.kind === "weekly" && !(Number.isInteger(x.weekday) && (x.weekday as number) >= 0 && (x.weekday as number) <= 6))
      return "schedule.weekday is 0 (Sunday) to 6 (Saturday)";
    return null;
  }
  if (x.kind === "hours") {
    return Number.isInteger(x.every) && (x.every as number) >= 1 && (x.every as number) <= HOURS_MAX
      ? null
      : `schedule.every is a whole number of hours, 1 to ${HOURS_MAX}`;
  }
  return "schedule.kind is daily, weekly or hours";
}

/** The schedule with only its own fields (call after scheduleError returned null). */
export function normalizeSchedule(s: Record<string, unknown>): Schedule {
  if (s.kind === "weekly") return { kind: "weekly", weekday: s.weekday as Weekday, at: s.at as string };
  if (s.kind === "daily") return { kind: "daily", at: s.at as string };
  return { kind: "hours", every: s.every as number };
}

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

/** The first run strictly after `after` (epoch ms). Hours count from `after`; daily/weekly are wall-clock times in tz. */
export function nextRunAfter(s: Schedule, tz: string, after: number): number {
  if (s.kind === "hours") return after + s.every * 3_600_000;
  const [h, m] = s.at.split(":").map(Number) as [number, number];
  const local = new Date(wallOf(after, tz));
  const y = local.getUTCFullYear();
  const mo = local.getUTCMonth();
  const d = local.getUTCDate();
  // a weekly slot is at most 7 days away, so 8 candidate days always reach one
  for (let k = 0; k <= 8; k++) {
    const day = Date.UTC(y, mo, d + k);
    if (s.kind === "weekly" && new Date(day).getUTCDay() !== s.weekday) continue;
    const t = instantOf(day + (h * 60 + m) * 60_000, tz);
    if (t > after) return t;
  }
  throw new Error("nextRunAfter: no slot within 9 days");
}

/** "Every day at 09:00 (Europe/Berlin)", "Every Monday at 09:00 (…)", "Every 6 hours". */
export function describeSchedule(s: Schedule, tz: string): string {
  if (s.kind === "hours") return s.every === 1 ? "Every hour" : `Every ${s.every} hours`;
  if (s.kind === "daily") return `Every day at ${s.at} (${tz})`;
  return `Every ${DAY_NAMES[s.weekday]} at ${s.at} (${tz})`;
}
