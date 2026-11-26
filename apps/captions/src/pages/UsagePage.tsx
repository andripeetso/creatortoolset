import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { ChevronDown, RefreshCw, X } from "lucide-react";
import type { KeyBudget, ServiceLimit, ServiceUsageView } from "@contracts/service-usage";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, EmptyRow, ErrorRow, LoadingRow, Row } from "@/components/settings/ui";
import { ProviderLogo } from "@/components/settings/ProviderLogos";
import { PlanLimits } from "@/components/settings/UsageSection";
import { BudgetLines } from "@/components/settings/KeyBudget";
import { hasThisMac, useThisMac } from "@/components/settings/ThisMacSection";
import { useProviders, usageSince } from "@/lib/providers";
import { useWorkspace } from "@/lib/workspace";
import { cn } from "@/lib/utils";
import {
  NO_SERVICE_USAGE,
  SERVER_ENV,
  USAGE_RANGES,
  columnsOf,
  entriesOf,
  filterEntries,
  getServiceUsage,
  groupBy,
  serviceName,
  servicesOf,
  share,
  tokens,
  totalsOf,
  usd,
  type UsageEntry,
  type UsageGroup,
  type UsageMetric,
} from "@/lib/usage";

const RELOAD_MS = 5 * 60_000;
// one colour per provider in the chart and its list, by rank; distinct in light and dark
const COLOURS = ["#0ea5e9", "#8b5cf6", "#f59e0b", "#10b981", "#f43f5e", "#64748b"];
const BREAKDOWNS = [
  { id: "model", label: "Model" },
  { id: "day", label: "Day" },
  { id: "tool", label: "Tool" },
  { id: "env", label: "Computer" },
  { id: "workspace", label: "Workspace" },
] as const;
type Breakdown = (typeof BREAKDOWNS)[number]["id"];

/**
 * Usage (/usage): a page of its own over the page behind it, not a Settings page. What the AI calls and the paid
 * services cost and used, by provider, computer, workspace, tool, model and day, and the plans' and services' limits.
 * The selection lives in the address: `range` (days), `view` (cost, tokens, limits), `env`, `provider`, `workspace`,
 * `by`, and `key` (a service's env name: that key's own view, linked from Settings → API keys).
 */
export default function UsagePage({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useSearchParams();
  const days = USAGE_RANGES.find((r) => String(r.days) === q.get("range"))?.days ?? 30;
  const metric: UsageMetric = q.get("view") === "tokens" ? "tokens" : q.get("view") === "limits" ? "limits" : "cost";
  const env = q.get("env");
  const provider = q.get("provider");
  const workspace = q.get("workspace");
  const key = q.get("key");
  const by: Breakdown = BREAKDOWNS.find((b) => b.id === q.get("by"))?.id ?? "model";
  const set = (patch: Record<string, string | null>) =>
    setQ(
      (p) => {
        const n = new URLSearchParams(p);
        for (const [k, v] of Object.entries(patch)) v ? n.set(k, v) : n.delete(k);
        return n;
      },
      { replace: true },
    );

  const { data: view, error, refresh } = useProviders();
  const projects = useWorkspace((s) => s.projects);
  useEffect(() => void useWorkspace.getState().load(), []);
  const [services, setServices] = useState<ServiceUsageView | null>(null);
  const [servicesError, setServicesError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const loadServices = useCallback(() => {
    setServicesError("");
    // always the whole 90 days: the range is picked on the page
    return getServiceUsage(usageSince(90)).then(setServices, (e: unknown) => setServicesError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => void loadServices(), [loadServices]);
  const [refreshing, setRefreshing] = useState(false);
  const reload = useCallback(() => {
    setRefreshing(true);
    void Promise.all([refresh(), loadServices()]).finally(() => {
      setNow(Date.now());
      setRefreshing(false);
    });
  }, [refresh, loadServices]);
  // the computers post their plan readings every five minutes and nothing announces one: read again at that pace
  useEffect(() => {
    const again = setInterval(() => void refresh().then(() => setNow(Date.now()), () => {}), RELOAD_MS);
    const tick = setInterval(() => setNow(Date.now()), 60_000); // the limits' countdowns
    return () => {
      clearInterval(again);
      clearInterval(tick);
    };
  }, [refresh]);

  const since = usageSince(days, now);
  const all = useMemo(() => (view ? entriesOf(view) : []), [view]);
  const shown = filterEntries(all, { since, env, provider, workspace });
  const svc = services ?? NO_SERVICE_USAGE;
  // a paid service runs on the server, for no AI provider: a computer or a provider picked leaves the keys out
  const keysShown = !provider && (!env || env === SERVER_ENV);
  const keyGroups = keysShown ? servicesOf(svc.lines, since, workspace) : [];

  const envName = (id: string) => (id === SERVER_ENV ? "This server" : (view?.devices.find((d) => d.id === id)?.name ?? "Computer removed"));
  const workspaceName = (id: string) => (id ? (projects.find((p) => p.id === id)?.name ?? "Workspace not found") : "No workspace");
  const providers = groupBy(all.filter((e) => Date.parse(`${e.hour}:00:00Z`) >= usageSince(90, now)), (e) => e.provider);
  const nameOf = (id: string) => all.find((e) => e.provider === id)?.providerName ?? id;
  const driverOf = (id: string) => all.find((e) => e.provider === id)?.driver;
  const colourOf = (id: string) => COLOURS[Math.max(0, providers.findIndex((p) => p.key === id)) % COLOURS.length]!;
  const envs = [...new Set(all.map((e) => e.env))];
  const workspaces = [...new Set([...all.map((e) => e.workspace).filter(Boolean), ...svc.lines.map((l) => l.workspace ?? "").filter(Boolean)])];
  const keys = [...new Set(svc.lines.map((l) => l.service))];

  const pick = (label: string, value: string | null, all: string, items: Array<{ id: string; label: string; group?: string }>, onPick: (v: string | null) => void) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="xs" aria-label={label} className="min-w-0 max-w-48 gap-1 px-1.5 font-normal">
          <span className="truncate">{value ? (items.find((i) => i.id === value)?.label ?? value) : all}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
        <DropdownMenuRadioGroup value={value ?? ""} onValueChange={(v) => onPick(v || null)}>
          <DropdownMenuRadioItem value="" className="text-xs">
            {all}
          </DropdownMenuRadioItem>
          {items.map((i, n) => (
            <Fragment key={i.id}>
              {i.group && i.group !== items[n - 1]?.group && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-2xs font-normal text-muted-foreground">{i.group}</DropdownMenuLabel>
                </>
              )}
              <DropdownMenuRadioItem value={i.id} className="text-xs">
                {i.label}
              </DropdownMenuRadioItem>
            </Fragment>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  const sep = (
    <span aria-hidden className="text-muted-foreground/60">
      ›
    </span>
  );

  const header = (
    <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b py-1.5 ps-5 pe-3">
      <DialogTitle className="flex min-w-0 flex-1 items-center gap-1 text-sm font-normal">
        <span className="font-medium text-foreground">Usage</span>
        {sep}
        {pick("Computer", env, "All computers", envs.map((id) => ({ id, label: envName(id) })), (v) => set({ env: v }))}
        {sep}
        {pick(
          "Provider",
          key ? `key:${key}` : provider,
          "All providers",
          [...providers.map((p) => ({ id: p.key, label: nameOf(p.key) })), ...keys.map((k) => ({ id: `key:${k}`, label: serviceName(k), group: "API keys" }))],
          (v) => (v?.startsWith("key:") ? set({ key: v.slice(4), provider: null }) : set({ provider: v, key: null })),
        )}
        {workspaces.length > 0 && (
          <>
            {sep}
            {pick("Workspace", workspace, "All workspaces", workspaces.map((id) => ({ id, label: workspaceName(id) })), (v) => set({ workspace: v }))}
          </>
        )}
      </DialogTitle>
      <div className="flex items-center gap-2">
        {metric !== "limits" && (
          <Tabs value={String(days)} onValueChange={(v) => set({ range: v === "30" ? null : v })}>
            <TabsList aria-label="Period" className="h-7">
              {USAGE_RANGES.map((r) => (
                <TabsTrigger key={r.days} value={String(r.days)} className="px-2 text-xs">
                  {r.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        )}
        <Tabs value={metric} onValueChange={(v) => set({ view: v === "cost" ? null : v })}>
          <TabsList aria-label="Show" className="h-7">
            <TabsTrigger value="cost" className="px-2 text-xs">Cost</TabsTrigger>
            <TabsTrigger value="tokens" className="px-2 text-xs">Tokens</TabsTrigger>
            <TabsTrigger value="limits" className="px-2 text-xs">Limits</TabsTrigger>
          </TabsList>
        </Tabs>
        <Button variant="ghost" size="icon-xs" aria-label="Refresh" disabled={refreshing} onClick={reload}>
          <RefreshCw className={cn(refreshing && "animate-spin")} />
        </Button>
        <DialogClose asChild>
          <Button variant="ghost" size="icon-xs" aria-label="Close">
            <X />
          </Button>
        </DialogClose>
      </div>
    </header>
  );

  let body: ReactNode;
  if (!view) body = <Card>{error ? <ErrorRow title="Could not load usage" detail={error} retry={reload} /> : <LoadingRow />}</Card>;
  else if (metric === "limits") body = <Limits view={view} now={now} services={svc.limits} budgets={svc.budgets} reload={reload} />;
  else if (key)
    body = <KeyView service={key} groups={servicesOf(svc.lines, since, workspace)} lines={svc.lines} since={since} now={now} workspace={workspace} error={servicesError} retry={loadServices} />;
  else {
    const m = metric;
    const value = (t: { costUsd: number; tokens: number }) => (m === "cost" ? usd(t.costUsd) : tokens(t.tokens));
    const total = totalsOf(shown);
    const ranked = groupBy(shown, (e) => e.provider, m);
    const hourly = days === 1;
    const groups = groupBy(shown, keyFn(by), m);
    const rows = by === "day" ? [...groups].sort((a, b) => b.key.localeCompare(a.key)) : groups;
    const label = (k: string) => (by === "model" ? k || "Not recorded" : by === "env" ? envName(k) : by === "workspace" ? workspaceName(k) : by === "day" ? dayLabel(k, hourly) : k);
    body = (
      <div className="flex flex-col gap-8">
        <section className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-4">
            <div>
              <p className="text-4xl font-semibold tabular-nums">{value(total)}</p>
              <p className="text-xs text-muted-foreground">
                {total.calls} {total.calls === 1 ? "call" : "calls"}
                {m === "cost" && " · Pay-per-use prices"}
              </p>
            </div>
            {ranked.length === 0 && <p className="text-sm text-muted-foreground">No usage</p>}
            {ranked.map((p) => (
              <button key={p.key} type="button" onClick={() => set({ provider: provider ? null : p.key })} className="flex flex-col gap-0.5 rounded-md text-left hover:bg-muted/50">
                <span className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: colourOf(p.key) }} />
                    {driverOf(p.key) && <ProviderLogo driver={driverOf(p.key)!} className="size-4" />}
                    <span className="truncate">{nameOf(p.key)}</span>
                  </span>
                  <span className="shrink-0 font-medium tabular-nums">{value(p)}</span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {m === "cost" ? `${share(p.costUsd, total.costUsd)} of cost · ${tokens(p.tokens)} tokens` : `${share(p.tokens, total.tokens)} of tokens · ${usd(p.costUsd)}`}
                </span>
              </button>
            ))}
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            <h2 className="text-sm font-medium">{`${hourly ? "Hourly" : "Daily"} ${m === "cost" ? "cost" : "tokens"}`}</h2>
            <Chart cols={columnsOf(shown, since, now, m)} order={ranked.map((p) => p.key)} colourOf={colourOf} nameOf={nameOf} format={(n) => (m === "cost" ? usd(n) : tokens(n))} hourly={hourly} />
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium">Totals</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <Metric label="Processed tokens" value={tokens(total.tokens)} />
            <Metric label="Cached input" value={tokens(total.cacheRead)} />
            <Metric label="Uncached input" value={tokens(total.input + total.cacheWrite)} />
            <Metric label="Output" value={tokens(total.output)} />
            <Metric label="Cache savings" value={usd(total.savingsUsd)} />
          </div>
          <TypeBar total={total} />
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium">Breakdown</h2>
            <Tabs value={by} onValueChange={(v) => set({ by: v === "model" ? null : v })}>
              <TabsList aria-label="Breakdown" className="h-7">
                {BREAKDOWNS.map((b) => (
                  <TabsTrigger key={b.id} value={b.id} className="px-2 text-xs">
                    {b.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
          <Table rows={rows} label={label} metric={m} />
        </section>

        {keysShown && (
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium">API keys</h2>
            <Card>
              {servicesError ? (
                <ErrorRow title="Could not load usage" detail={servicesError} retry={() => void loadServices()} />
              ) : !services ? (
                <LoadingRow />
              ) : keyGroups.length === 0 ? (
                <EmptyRow title="No API key usage" />
              ) : (
                keyGroups.map((g) => (
                  <button key={g.service} type="button" onClick={() => set({ key: g.service })} className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm hover:bg-muted/50 sm:px-4">
                    <span className="min-w-0">
                      <span className="block truncate">{serviceName(g.service)}</span>
                      <span className="block text-xs text-muted-foreground">{[`${g.calls} ${g.calls === 1 ? "call" : "calls"}`, ...unitsOf(g.units)].join(" · ")}</span>
                    </span>
                    <span className="shrink-0 font-medium tabular-nums">{usd(g.costUsd)}</span>
                  </button>
                ))
              )}
            </Card>
          </section>
        )}
      </div>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).focus();
        }}
        className="flex h-dvh w-full max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 shadow-none sm:h-[min(60rem,calc(100dvh-3rem))] sm:w-[min(80rem,calc(100vw-3rem))] sm:max-w-none sm:rounded-2xl sm:border sm:shadow-2xl lg:h-[min(60rem,calc(100dvh-5rem))] lg:w-[min(80rem,calc(100vw-5rem))]"
      >
        {header}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8">{body}</div>
      </DialogContent>
    </Dialog>
  );
}

const keyFn = (by: Breakdown) => (e: UsageEntry) => (by === "day" ? e.hour.slice(0, 10) : by === "env" ? e.env : e[by]);
const dayLabel = (k: string, hourly: boolean) => (hourly && k.length > 10 ? `${k.slice(11)}:00` : new Date(`${k.slice(0, 10)}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
const unitsOf = (u: Record<string, number>) => Object.entries(u).map(([unit, n]) => `${Number.isInteger(n) ? n : n.toFixed(1)} ${unit}`);

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

/** Tokens by type, one bar: what the answers split, and the rest (calls from before the split was kept). */
function TypeBar({ total }: { total: ReturnType<typeof totalsOf> }) {
  const parts = [
    { label: "Cached input", n: total.cacheRead, c: COLOURS[0] },
    { label: "Cache write", n: total.cacheWrite, c: COLOURS[1] },
    { label: "Input", n: total.input, c: COLOURS[2] },
    { label: "Output", n: total.output, c: COLOURS[3] },
    { label: "Not split", n: total.unsplit, c: COLOURS[5] },
  ].filter((p) => p.n > 0);
  if (!total.tokens) return null;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">Tokens by type</p>
      <div role="img" aria-label={parts.map((p) => `${p.label} ${share(p.n, total.tokens)}`).join(", ")} className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
        {parts.map((p) => (
          <div key={p.label} style={{ width: `${(p.n / total.tokens) * 100}%`, backgroundColor: p.c }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {parts.map((p) => (
          <span key={p.label} className="flex items-center gap-1.5">
            <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: p.c }} />
            {p.label} {tokens(p.n)} · {share(p.n, total.tokens)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Stacked columns per day (or hour), one colour per provider; plain divs, a title on each column. */
function Chart({ cols, order, colourOf, nameOf, format, hourly }: { cols: ReturnType<typeof columnsOf>; order: string[]; colourOf: (k: string) => string; nameOf: (k: string) => string; format: (n: number) => string; hourly: boolean }) {
  const sums = cols.map((c) => Object.values(c.by).reduce((a, b) => a + b, 0));
  const peak = Math.max(...sums, 0);
  return (
    <div className="flex flex-col gap-1">
      <div role="img" aria-label={`Peak ${format(peak)}`} className="flex h-48 items-end gap-px border-b border-border/60">
        {cols.map((c, i) => (
          <div key={c.at} title={[dayLabel(c.at, hourly), ...order.filter((k) => c.by[k]).map((k) => `${nameOf(k)}: ${format(c.by[k]!)}`)].join("\n")} className="flex h-full min-w-0 flex-1 flex-col-reverse hover:opacity-80">
            {peak > 0 &&
              order.map((k) => (c.by[k] ? <div key={k} style={{ height: `${(c.by[k]! / peak) * 100}%`, backgroundColor: colourOf(k) }} className="w-full first:rounded-b-none last:rounded-t-sm" /> : null))}
            {sums[i] === 0 && <div className="h-px w-full bg-muted" />}
          </div>
        ))}
      </div>
      <div className="flex justify-between text-2xs text-muted-foreground tabular-nums">
        <span>{cols[0] && dayLabel(cols[0].at, hourly)}</span>
        <span>{peak > 0 ? `Peak ${format(peak)}` : ""}</span>
        <span>{cols.at(-1) && dayLabel(cols.at(-1)!.at, hourly)}</span>
      </div>
    </div>
  );
}

function Table({ rows, label, metric }: { rows: UsageGroup[]; label: (k: string) => string; metric: "cost" | "tokens" }) {
  if (rows.length === 0) return <Card><EmptyRow title="No usage" /></Card>;
  const peak = Math.max(...rows.map((r) => (metric === "cost" ? r.costUsd : r.tokens)), 0);
  return (
    <Card>
      <div className="overflow-x-auto px-3 py-2 sm:px-4">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th className="py-1.5 pr-4 font-medium">Name</th>
              <th className="py-1.5 pr-4 text-right font-medium">Calls</th>
              <th className="hidden py-1.5 pr-4 text-right font-medium sm:table-cell">Cached input</th>
              <th className="py-1.5 pr-4 text-right font-medium">Tokens</th>
              <th className="py-1.5 text-right font-medium">Cost</th>
              <th className="hidden w-32 py-1.5 ps-4 md:table-cell" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-border/50">
                <td className="max-w-64 truncate py-2 pr-4">{label(r.key)}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{r.calls}</td>
                <td className="hidden py-2 pr-4 text-right tabular-nums text-muted-foreground sm:table-cell">{tokens(r.cacheRead)}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{tokens(r.tokens)}</td>
                <td className="py-2 text-right tabular-nums">{usd(r.costUsd)}</td>
                <td className="hidden py-2 ps-4 md:table-cell">
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-foreground/50" style={{ width: `${peak ? ((metric === "cost" ? r.costUsd : r.tokens) / peak) * 100 : 0}%` }} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** One API key: what it cost and used in the period, by day and by tool. */
function KeyView({ service, groups, lines, since, now, workspace, error, retry }: { service: string; groups: ReturnType<typeof servicesOf>; lines: ServiceUsageView["lines"]; since: number; now: number; workspace: string | null; error: string; retry: () => void }) {
  if (error) return <Card><ErrorRow title="Could not load usage" detail={error} retry={retry} /></Card>;
  const g = groups.find((x) => x.service === service);
  // the key's lines as chart entries: one colour, cost only
  const entries = lines
    .filter((l) => l.service === service && (!workspace || l.workspace === workspace))
    .map((l) => ({ hour: l.hour, provider: service, providerName: "", env: SERVER_ENV, workspace: l.workspace ?? "", tool: l.label, model: "", calls: l.calls, tokens: 0, costUsd: l.costUsd, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }));
  const hourly = now - since <= 864e5 + 1;
  return (
    <div className="flex flex-col gap-8">
      <section className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div>
          <p className="text-sm text-muted-foreground">{serviceName(service)}</p>
          <p className="text-4xl font-semibold tabular-nums">{usd(g?.costUsd ?? 0)}</p>
          <p className="text-xs text-muted-foreground">{[`${g?.calls ?? 0} ${g?.calls === 1 ? "call" : "calls"}`, ...unitsOf(g?.units ?? {})].join(" · ")}</p>
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <h2 className="text-sm font-medium">{hourly ? "Hourly cost" : "Daily cost"}</h2>
          <Chart cols={columnsOf(entries, since, now, "cost")} order={[service]} colourOf={() => COLOURS[0]!} nameOf={serviceName} format={usd} hourly={hourly} />
        </div>
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">By tool</h2>
        <Card>
          {!g?.tools.length ? (
            <EmptyRow title="No usage" />
          ) : (
            g.tools.map((t) => <Row key={t.label} title={t.label} description={`${t.calls} ${t.calls === 1 ? "call" : "calls"}`} control={<span className="text-sm tabular-nums">{usd(t.costUsd)}</span>} />)
          )}
        </Card>
      </section>
    </div>
  );
}

/** The plans' limits on each sign-in, then each paid service's own account limits. */
function Limits({ view, now, services, budgets, reload }: { view: NonNullable<ReturnType<typeof useProviders>["data"]>; now: number; services: ServiceLimit[]; budgets: KeyBudget[]; reload: () => void }) {
  const bridge = useThisMac(hasThisMac());
  // plan limits turned on from a row's button: the readings it starts come in now, not in five minutes
  const on = bridge?.limits;
  const wasOff = useRef(false);
  useEffect(() => {
    if (on === false) wasOff.current = true;
    else if (on && wasOff.current) {
      wasOff.current = false;
      reload();
    }
  }, [on, reload]);
  return (
    <div className="flex flex-col gap-8">
      <PlanLimits view={view} now={now} bridge={bridge} />
      <Budgets budgets={budgets} />
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">API keys</h2>
        <Card>
          {services.length === 0 ? (
            <EmptyRow title="No API key limits" />
          ) : (
            services.map((l) => {
              const pct = l.used !== undefined && l.limit ? Math.min(100, (l.used / l.limit) * 100) : null;
              const amount = l.used !== undefined && l.limit !== undefined ? `${l.used} of ${l.limit} ${l.unit}` : l.used !== undefined ? `${l.used} ${l.unit}` : l.limit !== undefined ? `${l.limit} ${l.unit}` : "";
              return (
                <Row
                  key={`${l.service}:${l.whose}:${l.label}`}
                  title={`${serviceName(l.service)} · ${l.label}`}
                  description={[l.whose === "server" ? "Server key" : null, l.resetsAt ? `Resets ${new Date(l.resetsAt).toLocaleDateString()}` : null].filter(Boolean).join(" · ") || undefined}
                  control={<span className="text-xs tabular-nums text-muted-foreground">{amount}</span>}
                >
                  {pct !== null && (
                    <div role="meter" aria-label={`${l.label}: ${Math.round(pct)}% used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} className="h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div className={cn("h-full rounded-full", pct >= 90 ? "bg-amber-500" : "bg-foreground/60")} style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </Row>
              );
            })
          )}
        </Card>
      </section>
    </div>
  );
}

/** Each key's monthly budgets and what it spent this month (api/lib/service-usage.ts), the fullest first. Shown only: they are set on Settings → API keys. */
function Budgets({ budgets }: { budgets: KeyBudget[] }) {
  const fullest = (b: KeyBudget) => Math.max(b.budget ? b.spent / b.budget : -1, ...b.workspaces.map((w) => (w.budget ? w.spent / w.budget : -1)));
  const rows = [...budgets].sort((a, b) => fullest(b) - fullest(a) || b.spent - a.spent);
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Budgets</h2>
        <Link to="/settings/keys" className="text-xs underline underline-offset-2">
          Change in API keys
        </Link>
      </div>
      <Card>
        {rows.length === 0 ? (
          <EmptyRow title="No API keys" />
        ) : (
          rows.map((b) => (
            <Row key={`${b.service}:${b.whose}`} title={serviceName(b.service)} description={b.whose === "server" ? "Server key" : undefined}>
              <BudgetLines b={b} />
            </Row>
          ))
        )}
      </Card>
    </section>
  );
}
