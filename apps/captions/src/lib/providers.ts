/**
 * Client for AI providers and devices (api/providers.ts, api/devices.ts): what the Settings page shows
 * and saves. The shapes are contracts/providers.ts.
 */
import {
  DRIVER_MODELS,
  type Effort,
  type ProviderCheck,
  type ProviderInstance,
  type ProviderSettings,
  type ProvidersView,
  type Scope,
  type Selection,
} from "@contracts/providers";

export type UsageRow = ProvidersView["usage"][number];

/** A failed request carries its message, so the page can show it. */
async function json<T>(res: Response): Promise<T> {
  const j = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(j?.error || `Request failed (${res.status})`);
  return j as T;
}

const jsonInit = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const getProviders = () => fetch("/api/providers").then((r) => json<ProvidersView>(r));

/** Admins: the workspace's set (answers the admins, background work, and the team while shared). */
export const saveWorkspace = (settings: ProviderSettings) =>
  fetch("/api/providers/workspace", jsonInit(settings, "PUT")).then((r) => json<ProviderSettings>(r));

/** This account's own set; null drops it and uses the workspace's. Answers with the fresh view. */
export const saveOwn = (settings: ProviderSettings | null) =>
  fetch("/api/providers/own", jsonInit(settings, "PUT")).then((r) => json<ProvidersView>(r));

/** One short question through the instance's device. `scope` is "workspace" or the account's username. */
export const checkProvider = (scope: Scope, id: string) =>
  fetch(`/api/providers/${encodeURIComponent(scope)}/${encodeURIComponent(id)}/check`, { method: "POST" }).then((r) =>
    json<ProviderCheck>(r),
  );

export const renameDevice = (id: string, name: string) =>
  fetch(`/api/devices/${encodeURIComponent(id)}`, jsonInit({ name }, "PATCH")).then((r) => json<unknown>(r));

export const removeDevice = (id: string) =>
  fetch(`/api/devices/${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) => json<unknown>(r));

export const effortLabel = (e: Effort) => ({ low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" })[e];

/** "claude-opus-5-5" → "Claude Opus 5.5". Other ids are shown as they are, capitalised. */
export function modelName(id: string): string {
  const parts: string[] = [];
  for (const w of id.split("-")) {
    const last = parts[parts.length - 1];
    if (/^\d+$/.test(w) && last && /^\d/.test(last)) parts[parts.length - 1] = `${last}.${w}`;
    else parts.push(/^\d/.test(w) ? w : w === "gpt" ? "GPT" : w.charAt(0).toUpperCase() + w.slice(1));
  }
  return parts.join(" ");
}

/** "Claude Opus 5.5 · High" */
export const selectionLabel = (s: Selection) => `${modelName(s.model)} · ${effortLabel(s.effort)}`;

/**
 * Whether Providers tests an AI by itself, once: it is on, runs, its computer is online and has reported the tool as
 * installed, and either nothing is on record, or the last result failed and the computer has reported since (a sign-in
 * shows up that way). A tool that is off or not installed is never tested: its row says what to do.
 */
export function autoTestDue(o: { enabled: boolean; runs: boolean; online: boolean; reportAt?: number; installed?: boolean; check?: { ok: boolean; at: number } }): boolean {
  if (!o.enabled || !o.runs || !o.online || o.reportAt === undefined || o.installed !== true) return false;
  if (!o.check) return true;
  return !o.check.ok && o.reportAt > o.check.at;
}

/** The device an instance runs on. Missing = none picked: it runs nowhere. */
export const deviceOf = (inst: ProviderInstance) => inst.device ?? "";

/** Models offered for an instance: the view's list, else the driver's. */
export function modelsOf(view: ProvidersView, inst: ProviderInstance): string[] {
  return view.models[inst.id] ?? DRIVER_MODELS[inst.driver] ?? [];
}

/** The set that answers this account's jobs right now (what `using` says), or null when none does. */
export function activeSet(view: ProvidersView): { settings: ProviderSettings; scope: Scope } | null {
  if (view.using === "own" && view.own) return { settings: view.own, scope: "own" };
  if (view.using === "workspace" && view.workspace) return { settings: view.workspace.settings, scope: "workspace" };
  return null;
}

/** This Mac's device id on this server: set by the Mac app on its own page once the Mac is paired (html data-mac-device). */
export const thisMacDevice = (): string | undefined =>
  typeof document === "undefined" ? undefined : document.documentElement.dataset.macDevice || undefined;

/** The name of an instance in a scope, for usage rows. */
export function instanceName(view: ProvidersView, scope: Scope, id: string): string {
  const set = scope === "workspace" ? view.workspace?.settings : view.own;
  return set?.instances.find((i) => i.id === id)?.name ?? (id || "No AI yet");
}

export interface UsageTotals {
  calls: number;
  tokens: number;
  costUsd: number;
}

/** Usage summed per key from `since` (a ms timestamp) on. The rows are hourly, UTC keys ("2026-11-04T09"). */
export function usageBy(rows: UsageRow[], keyOf: (r: UsageRow) => string, since: number): Map<string, UsageTotals> {
  const out = new Map<string, UsageTotals>();
  for (const r of rows) {
    if (Date.parse(`${r.hour}:00:00Z`) < since) continue;
    const k = keyOf(r);
    const t = out.get(k) ?? { calls: 0, tokens: 0, costUsd: 0 };
    t.calls += r.calls;
    t.tokens += r.tokens;
    t.costUsd += r.costUsd;
    out.set(k, t);
  }
  return out;
}

/** The periods the Usage page offers, in days back from now. */
export const USAGE_PERIODS = [
  { id: 1, label: "24 hours" },
  { id: 7, label: "7 days" },
  { id: 30, label: "30 days" },
  { id: 90, label: "90 days" },
] as const;

/** A window's start: a ms timestamp `days` back (the page's own clock). */
export const usageSince = (days: number, now = Date.now()) => now - days * 864e5;
