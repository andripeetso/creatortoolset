import type { Automation, Destination, Schedule, Weekday } from "@contracts/automations";
import type { Selection } from "@contracts/providers";
import { fmtAgo } from "@/components/settings/helpers";

/** Settings → Scheduled tasks' calls (api/automations.ts). The assistant's schedule_task tool sends the same body. */

export type AutomationView = Automation & { running: boolean; nextRun: number | null };

const SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;
/** The form's weekday buttons, Monday first. */
export const WEEK: { day: Weekday; label: string }[] = ([1, 2, 3, 4, 5, 6, 0] as Weekday[]).map((day) => ({ day, label: SHORT[day] }));

/** "Daily at 09:00", "Weekdays at 09:00", "Mo, We at 18:30", "Once, 12 Nov 2026, 15:00", "Every 30 min", "Every 2 hours". */
export function scheduleLabel(s: Schedule, tz: string): string {
  if (s.kind === "interval") {
    const h = s.everyMinutes / 60;
    return Number.isInteger(h) ? (h === 1 ? "Every hour" : `Every ${h} hours`) : `Every ${s.everyMinutes} min`;
  }
  if (s.kind === "once") return `Once, ${new Intl.DateTimeFormat("en-GB", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).format(new Date(s.runAt))}`;
  const days = s.weekdays ?? [];
  const which =
    days.length === 0 ? "Daily" : days.length === 5 && days.every((d) => d >= 1 && d <= 5) ? "Weekdays" : WEEK.filter((w) => days.includes(w.day)).map((w) => w.label).join(", ");
  return `${which} at ${s.at}`;
}

/** "in 5 min", "in 3 h", "in 2 d": how far off the next run is. */
export function untilLabel(at: number, now: number): string {
  const min = Math.ceil((at - now) / 60_000);
  if (min < 2) return "in under a minute";
  if (min < 60) return `in ${min} min`;
  const h = Math.round(min / 60);
  return h < 24 ? `in ${h} h` : `in ${Math.round(h / 24)} d`;
}

/**
 * A task row's line: the schedule and the next run, and a failed or skipped last run (with the time a usage limit comes
 * back, when a reading knows it). A run that went fine adds nothing.
 */
export function statusOf(a: AutomationView, now: number, limitReset: string | null): { line: string; problem?: { tone: "broken" | "attention"; text: string } } {
  const next = a.running ? "Running now" : !a.enabled ? "Paused" : a.nextRun ? `Next run ${untilLabel(a.nextRun, now)}` : "Not scheduled";
  // a time of day on another zone's clock (made in another browser) says which zone
  const elsewhere = a.schedule.kind === "fixed" && a.timezone !== Intl.DateTimeFormat().resolvedOptions().timeZone ? ` (${a.timezone})` : "";
  const line = `${scheduleLabel(a.schedule, a.timezone)}${elsewhere} · ${next}`;
  const r = a.lastResult;
  if (!r || r.status === "done") return { line };
  const ago = fmtAgo(r.at, now);
  const reset = r.status === "error" && /usage limit/i.test(r.text) && limitReset ? ` · ${limitReset}` : "";
  return { line, problem: { tone: r.status === "error" ? "broken" : "attention", text: `${r.status === "error" ? "Failed" : "Skipped"} ${ago}: ${r.text.split("\n")[0]}${reset}` } };
}

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(`/api/automations${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => null);
  if (!r) throw new Error("Can't reach the server");
  const data = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `Failed (${r.status})`);
  return data;
}

export type AutomationBody = Pick<Automation, "name" | "prompt" | "schedule" | "timezone" | "enabled" | "destination"> & { ai: Selection | null; project: string | null };

export const listAutomations = () => call<{ items: AutomationView[]; blocked: string | null }>("");
export const createAutomation = (body: AutomationBody) => call<AutomationView>("", "POST", body);
export const updateAutomation = (id: string, patch: Partial<AutomationBody>) => call<AutomationView>(`/${id}`, "PATCH", patch);
export const deleteAutomation = (id: string) => call<{ ok: true }>(`/${id}`, "DELETE");
export const runAutomationNow = (id: string) => call<AutomationView>(`/${id}/run`, "POST");

export type ScheduleMode = Schedule["kind"];

/** The form's state. Each schedule mode keeps its own fields, so switching modes and back loses nothing. */
export interface AutomationDraft {
  name: string;
  prompt: string;
  enabled: boolean;
  destination: Destination;
  /** A Workshop project id, "" for none. */
  project: string;
  /** The computer the task runs on: picks which AIs the Model list offers. */
  device: string;
  ai: Selection | null;
  mode: ScheduleMode;
  at: string;
  /** Every day when all seven are on. */
  weekdays: Weekday[];
  /** A `datetime-local` value in this browser's zone, such as 2026-11-12T15:00. */
  runAt: string;
  every: number;
  unit: "minutes" | "hours";
}

const ALL_DAYS: Weekday[] = [0, 1, 2, 3, 4, 5, 6];

/** A Date as a `datetime-local` value in this browser's zone. */
export function localInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const blankDraft = (now = Date.now()): AutomationDraft => ({
  name: "",
  prompt: "",
  enabled: true,
  destination: "new_chat",
  project: "",
  device: "",
  ai: null,
  mode: "fixed",
  at: "09:00",
  weekdays: ALL_DAYS,
  runAt: localInput(new Date(now + 3_600_000)),
  every: 1,
  unit: "hours",
});

export function draftOf(a: Automation, device = ""): AutomationDraft {
  const s = a.schedule;
  const blank = blankDraft();
  return {
    ...blank,
    name: a.name,
    prompt: a.prompt,
    enabled: a.enabled,
    destination: a.destination,
    project: a.project ?? "",
    device,
    ai: a.ai ?? null,
    mode: s.kind,
    ...(s.kind === "fixed" ? { at: s.at, weekdays: s.weekdays?.length ? s.weekdays : ALL_DAYS } : {}),
    ...(s.kind === "once" ? { runAt: localInput(new Date(s.runAt)) } : {}),
    ...(s.kind === "interval" ? (s.everyMinutes % 60 === 0 ? { every: s.everyMinutes / 60, unit: "hours" as const } : { every: s.everyMinutes, unit: "minutes" as const }) : {}),
  };
}

export function draftSchedule(d: AutomationDraft): Schedule {
  if (d.mode === "interval") return { kind: "interval", everyMinutes: d.unit === "hours" ? d.every * 60 : d.every };
  if (d.mode === "once") return { kind: "once", runAt: new Date(d.runAt).getTime() };
  const days = [...new Set(d.weekdays)].sort((a, b) => a - b);
  return { kind: "fixed", at: d.at, ...(days.length < 7 ? { weekdays: days } : {}) };
}

/** Why the draft can't be saved, or null. */
export function draftError(d: AutomationDraft, now = Date.now()): string | null {
  if (!d.prompt.trim()) return "Say what the task should do.";
  if (!d.name.trim()) return "Give the task a name.";
  if (!d.ai) return "Pick the AI it runs on.";
  if (d.mode === "fixed" && d.weekdays.length === 0) return "Pick at least one day.";
  if (d.mode === "interval" && !(Number.isInteger(d.every) && d.every >= 1)) return "Run every: a whole number, 1 or more.";
  if (d.mode === "once") {
    const t = new Date(d.runAt);
    if (Number.isNaN(t.getTime())) return "Pick a date and time.";
    // a time a daylight saving change skips reads back as another time
    if (localInput(t) !== d.runAt) return "That time doesn't exist in your time zone.";
    if (d.enabled && t.getTime() <= now) return "The run time has passed. Pick a time in the future.";
  }
  return null;
}

/** The request body for a draft; timezone is the task's own (a new one gets this browser's). */
export function draftBody(d: AutomationDraft, timezone: string): AutomationBody {
  return {
    name: d.name.trim(),
    prompt: d.prompt.trim(),
    schedule: draftSchedule(d),
    timezone,
    enabled: d.enabled,
    destination: d.destination,
    ai: d.ai,
    project: d.project || null,
  };
}
