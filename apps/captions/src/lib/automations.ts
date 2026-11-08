import type { Automation, Schedule, Weekday } from "@contracts/automations";

/** Settings → Automations' calls (api/automations.ts). The form below makes the same body the MCP tool sends. */

export type AutomationView = Automation & { running: boolean; nextRun: number | null };

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

export const listAutomations = () => call<{ items: AutomationView[] }>("");
export const createAutomation = (body: AutomationFields & { enabled?: boolean }) => call<AutomationView>("", "POST", body);
export const updateAutomation = (id: string, patch: Partial<AutomationFields> & { enabled?: boolean }) => call<AutomationView>(`/${id}`, "PATCH", patch);
export const deleteAutomation = (id: string) => call<{ ok: true }>(`/${id}`, "DELETE");
export const runAutomationNow = (id: string) => call<AutomationView>(`/${id}/run`, "POST");

export type AutomationFields = Pick<Automation, "name" | "prompt" | "schedule" | "timezone">;

/** The form's state: "daily" and "weekly" use at (HH:MM) and weekday, "hours" uses every. */
export interface AutomationDraft {
  name: string;
  prompt: string;
  kind: Schedule["kind"];
  at: string;
  weekday: Weekday;
  every: number;
}

export const blankDraft = (): AutomationDraft => ({ name: "", prompt: "", kind: "daily", at: "09:00", weekday: 1, every: 6 });

export function draftOf(a: Automation): AutomationDraft {
  const s = a.schedule;
  return {
    name: a.name,
    prompt: a.prompt,
    kind: s.kind,
    at: s.kind === "hours" ? "09:00" : s.at,
    weekday: s.kind === "weekly" ? s.weekday : 1,
    every: s.kind === "hours" ? s.every : 6,
  };
}

export function draftSchedule(d: AutomationDraft): Schedule {
  if (d.kind === "hours") return { kind: "hours", every: d.every };
  if (d.kind === "weekly") return { kind: "weekly", weekday: d.weekday, at: d.at };
  return { kind: "daily", at: d.at };
}

/** The request body for a draft; timezone is the browser's zone (the server checks it). */
export function draftBody(d: AutomationDraft, timezone: string): AutomationFields {
  return { name: d.name.trim(), prompt: d.prompt.trim(), schedule: draftSchedule(d), timezone };
}
