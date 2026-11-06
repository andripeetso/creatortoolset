import { useEffect, useState, type ReactNode } from "react";
import { getProviders, instanceName, USAGE_PERIODS, usageBy, usageSince, type UsageTotals } from "@/lib/providers";
import type { ProvidersView } from "@contracts/providers";
import { tokensLabel } from "@/lib/workshop";
import { cn } from "@/lib/utils";
import { Group, Loading, Notice } from "./ui";
import { msg } from "./helpers";

const ZERO: UsageTotals = { calls: 0, tokens: 0, costUsd: 0 };
/** Calls on the Anthropic API key (guests, the demo, image reading): the only ones that cost money. The server tallies them as "<job> (API)". */
const PAID = "api";
const isPaid = (r: { label: string }) => r.label.endsWith(" (API)");

/** Settings → Usage: calls, tokens and the API-equivalent cost, per provider and per job, over a period. */
export function UsageSection() {
  const [view, setView] = useState<ProvidersView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState<number>(7);

  useEffect(() => {
    getProviders().then(setView).catch((e) => setError(msg(e)));
  }, []);

  if (error) return <Notice tone="error">Could not load usage: {error}</Notice>;
  if (!view) return <Loading />;

  const since = usageSince(days);
  const byProvider = usageBy(view.usage, (r) => (isPaid(r) ? PAID : `${r.scope}\n${r.instance ?? ""}`), since);
  const paid = byProvider.get(PAID) ?? ZERO;
  const byJob = usageBy(view.usage, (r) => r.label, since);
  const total = usageBy(view.usage, () => "all", since).get("all") ?? ZERO;
  const hasWorkspace = view.usage.some((r) => r.scope === "workspace");
  const period = USAGE_PERIODS.find((p) => p.id === days)?.label.toLowerCase() ?? `${days} days`;

  const cell = (t: UsageTotals | undefined) =>
    t && t.calls ? (
      <>
        <td className="py-2 pr-4 text-foreground">{t.calls}</td>
        <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">{tokensLabel(t.tokens)}</td>
        <td className="py-2 font-mono text-xs text-foreground">${t.costUsd.toFixed(2)}</td>
      </>
    ) : (
      <>
        <td className="py-2 pr-4 text-muted-foreground/50">—</td>
        <td className="py-2 pr-4 text-muted-foreground/50">—</td>
        <td className="py-2 text-muted-foreground/50">—</td>
      </>
    );

  const table = (title: string, rows: Array<{ key: string; name: ReactNode; tag?: string; totals: UsageTotals }>) => (
    <div className="overflow-x-auto rounded-lg border border-border px-3">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="py-2 pr-4 font-medium">{title}</th>
            <th className="py-2 pr-4 font-medium">Calls</th>
            <th className="py-2 pr-4 font-medium">Tokens</th>
            <th className="py-2 font-medium">API-equivalent cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="py-3 text-muted-foreground">
                No calls in the last {period}.
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-border">
              <td className="py-2 pr-4">
                {r.name}
                {r.tag && <span className={cn("ml-2 text-[10px] uppercase tracking-wider", r.tag === "Workspace" ? "text-violet-500" : r.tag === "Paid" ? "text-amber-500" : "text-muted-foreground")}>{r.tag}</span>}
              </td>
              {cell(r.totals)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const providerRows = [...byProvider.entries()]
    .map(([k, totals]) => {
      if (k === PAID) return { key: k, name: "Anthropic API key", tag: "Paid", totals, cost: totals.costUsd };
      const [scope, instance] = k.split("\n");
      return { key: k, name: instanceName(view, scope, instance), tag: hasWorkspace ? (scope === "workspace" ? "Workspace" : "Your own") : undefined, totals, cost: totals.costUsd };
    })
    .sort((a, b) => b.cost - a.cost);
  const jobRows = [...byJob.entries()].map(([k, totals]) => ({ key: k, name: k, totals, cost: totals.costUsd })).sort((a, b) => b.cost - a.cost);

  return (
    <>
      <div role="radiogroup" aria-label="Period" className="mb-2 flex flex-wrap gap-1.5">
        {USAGE_PERIODS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={days === p.id}
            onClick={() => setDays(p.id)}
            className={cn(
              "rounded-md border px-2.5 py-1 text-xs transition-colors",
              days === p.id ? "border-violet-500/60 bg-violet-500/10 text-foreground" : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        {total.calls ? (
          <>
            {total.calls} calls · {tokensLabel(total.tokens)} tokens in the last {period}.
          </>
        ) : (
          <>Nothing ran in the last {period}.</>
        )}{" "}
        <span className="text-foreground">Spent on the API key: ${paid.costUsd.toFixed(2)}</span>
        {paid.calls ? ` (${paid.calls} call${paid.calls === 1 ? "" : "s"})` : ""}. Everything else ran on your subscriptions: its cost is what
        the same calls would cost at API prices, not a bill.
      </p>

      <Group title="By provider">{table("Provider", providerRows)}</Group>
      <Group title="By job" hint="Content Workshop, Caption Studio, the Analyzer and Video Notes.">
        {table("Job", jobRows)}
      </Group>
    </>
  );
}
