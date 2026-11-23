import type { Driver, ProvidersView } from "@contracts/providers";
import type { ServiceUsageLine, ServiceUsageView } from "@contracts/service-usage";
import { MY_KEYS, SERVICE_KEYS } from "@contracts/service-keys";
import { cacheSavingsUsd } from "@contracts/model-prices";
import { deviceOf, type UsageRow } from "./providers";

/**
 * The Usage page's numbers (pages/UsagePage.tsx): the providers view's hourly lines, each named by what the page sorts
 * by (provider, computer, workspace, tool, model, day), filtered by the page's selection and summed per group.
 */

export const USAGE_RANGES = [
  { days: 1, label: "Past 24h" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
] as const;
export type UsageMetric = "cost" | "tokens" | "limits";

/** The tally's label for calls on the app's own Anthropic key. */
const API = " (API)";
const TOOL: Record<string, string> = { Automation: "Scheduled task", Stopped: "Stopped run", other: "Other" };
/** The computer of calls no computer made: the API path, a stopped run. */
export const SERVER_ENV = "server";

/** One hourly line with the names the page groups by. */
export interface UsageEntry {
  hour: string;
  /** the provider's `${scope}:${instance}`, "api" for the Anthropic key, "" for none */
  provider: string;
  providerName: string;
  driver?: Driver;
  /** the computer's id, or SERVER_ENV */
  env: string;
  workspace: string;
  tool: string;
  model: string;
  calls: number;
  tokens: number;
  costUsd: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export function entriesOf(view: Pick<ProvidersView, "usage" | "own" | "workspace">): UsageEntry[] {
  return view.usage.map((r: UsageRow) => {
    const paid = r.label.endsWith(API);
    const base = paid ? r.label.slice(0, -API.length) : r.label;
    const set = r.scope === "workspace" ? view.workspace?.settings : view.own;
    const inst = r.instance ? set?.instances.find((i) => i.id === r.instance) : undefined;
    return {
      hour: r.hour,
      provider: paid ? "api" : r.instance ? `${r.scope}:${r.instance}` : "",
      providerName: paid ? "Anthropic API key" : r.instance ? (inst?.name ?? "Not found") : "No AI provider",
      ...(inst ? { driver: inst.driver } : {}),
      env: (inst && deviceOf(inst)) || SERVER_ENV,
      workspace: r.workspace ?? "",
      tool: TOOL[base] ?? base,
      model: r.model ?? "",
      calls: r.calls,
      tokens: r.tokens,
      costUsd: r.costUsd,
      input: r.input ?? 0,
      cacheRead: r.cacheRead ?? 0,
      cacheWrite: r.cacheWrite ?? 0,
      output: r.output ?? 0,
    };
  });
}

export interface UsageFilter {
  since: number;
  env?: string | null;
  provider?: string | null;
  workspace?: string | null;
}

const hourMs = (hour: string) => Date.parse(`${hour}:00:00Z`);

export function filterEntries(entries: UsageEntry[], f: UsageFilter): UsageEntry[] {
  return entries.filter((e) => hourMs(e.hour) >= f.since && (!f.env || e.env === f.env) && (!f.provider || e.provider === f.provider) && (!f.workspace || e.workspace === f.workspace));
}

export interface UsageTotals {
  calls: number;
  tokens: number;
  costUsd: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** tokens the answer did not split by type (every call recorded before 2026-11-23) */
  unsplit: number;
  /** what the cache reads saved against the model's input price; 0 for a model with no price */
  savingsUsd: number;
}

export function totalsOf(entries: UsageEntry[]): UsageTotals {
  const t: UsageTotals = { calls: 0, tokens: 0, costUsd: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, unsplit: 0, savingsUsd: 0 };
  for (const e of entries) {
    t.calls += e.calls;
    t.tokens += e.tokens;
    t.costUsd += e.costUsd;
    t.input += e.input;
    t.cacheRead += e.cacheRead;
    t.cacheWrite += e.cacheWrite;
    t.output += e.output;
    t.unsplit += Math.max(0, e.tokens - e.input - e.cacheRead - e.cacheWrite - e.output);
    t.savingsUsd += cacheSavingsUsd(e.model, e.cacheRead);
  }
  return t;
}

export type UsageGroup = UsageTotals & { key: string };

/** The entries summed per `keyOf`, biggest first by `metric`. */
export function groupBy(entries: UsageEntry[], keyOf: (e: UsageEntry) => string, metric: "cost" | "tokens" = "cost"): UsageGroup[] {
  const by = new Map<string, UsageEntry[]>();
  for (const e of entries) {
    const k = keyOf(e);
    const list = by.get(k);
    if (list) list.push(e);
    else by.set(k, [e]);
  }
  const size = (g: UsageTotals) => (metric === "cost" ? g.costUsd : g.tokens);
  return [...by].map(([key, es]) => ({ key, ...totalsOf(es) })).sort((a, b) => size(b) - size(a) || b.calls - a.calls);
}

/**
 * The chart's columns: one per day (UTC "2026-11-23"), or one per hour for a one-day range, from `since` to `now`,
 * each with its value per provider. A column with no calls is there with no values.
 */
export function columnsOf(entries: UsageEntry[], since: number, now: number, metric: "cost" | "tokens"): Array<{ at: string; by: Record<string, number> }> {
  const hourly = now - since <= 864e5 + 1;
  const step = hourly ? 3600e3 : 864e5;
  const keyAt = (ms: number) => new Date(ms).toISOString().slice(0, hourly ? 13 : 10);
  const cols = new Map<string, Record<string, number>>();
  for (let t = Math.floor(since / step) * step; t <= now; t += step) cols.set(keyAt(t), {});
  for (const e of entries) {
    const col = cols.get(e.hour.slice(0, hourly ? 13 : 10));
    if (col) col[e.provider] = (col[e.provider] ?? 0) + (metric === "cost" ? e.costUsd : e.tokens);
  }
  return [...cols].map(([at, by]) => ({ at, by }));
}

/* ---- API keys: the paid services' lines (GET /api/usage/services) ---- */

export const NO_SERVICE_USAGE: ServiceUsageView = { lines: [], limits: [] };

/** The service lines since `since`; a server without the route yet answers 404, read as no lines. */
export async function getServiceUsage(since: number): Promise<ServiceUsageView> {
  const r = await fetch(`/api/usage/services?since=${since}`);
  if (r.status === 404) return NO_SERVICE_USAGE;
  if (!r.ok) throw new Error(`Could not load usage (${r.status})`);
  const v = (await r.json()) as Partial<ServiceUsageView>;
  return { lines: v.lines ?? [], limits: v.limits ?? [] };
}

/** A key's name as Settings → API keys shows it. */
export const serviceName = (env: string): string => (env === "APIFY_TOKEN" ? "Apify" : ([...MY_KEYS, ...SERVICE_KEYS].find((k) => k.env === env)?.name ?? env));

export interface ServiceGroup {
  service: string;
  calls: number;
  costUsd: number;
  /** units per billing unit ("minutes": 42) */
  units: Record<string, number>;
  tools: Array<{ label: string; calls: number; costUsd: number }>;
}

/** The lines since `since` (and in `workspace` when one is picked), one group per key with its tools, costliest first. */
export function servicesOf(lines: ServiceUsageLine[], since: number, workspace?: string | null): ServiceGroup[] {
  const out = new Map<string, ServiceGroup>();
  for (const l of lines) {
    if (hourMs(l.hour) < since || (workspace && l.workspace !== workspace)) continue;
    const g = out.get(l.service) ?? { service: l.service, calls: 0, costUsd: 0, units: {}, tools: [] };
    g.calls += l.calls;
    g.costUsd += l.costUsd;
    g.units[l.unit] = (g.units[l.unit] ?? 0) + l.units;
    const t = g.tools.find((x) => x.label === l.label) ?? (g.tools[g.tools.length] = { label: l.label, calls: 0, costUsd: 0 });
    t.calls += l.calls;
    t.costUsd += l.costUsd;
    out.set(l.service, g);
  }
  const groups = [...out.values()];
  for (const g of groups) g.tools.sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);
  return groups.sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);
}

/* ---- labels ---- */

export const usd = (n: number) => (n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);
export function tokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}
export const share = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "0%");
