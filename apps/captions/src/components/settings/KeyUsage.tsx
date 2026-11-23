import { useState } from "react";
import { Link } from "react-router";
import type { ServiceLimit, ServiceUsageLine, ServiceUsageView } from "@contracts/service-usage";
import { DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCachedLoad } from "@/lib/local-cache";
import { USAGE_PERIODS, usageSince } from "@/lib/providers";
import { SettingsDialog, SettingsDialogContent, SettingsSelect } from "./ui";

/**
 * What each key on the API keys page was used for (GET /api/usage/services, api/lib/service-usage.ts): a line under
 * its row and a dialog by tool. Read once for the page, 90 days, the periods cut from it here.
 */

const USAGE_URL = "/api/usage/services";
const load = async (): Promise<ServiceUsageView> => {
  const r = await fetch(`${USAGE_URL}?since=${usageSince(90)}`);
  if (!r.ok) throw new Error(`Request failed (${r.status})`);
  return (await r.json()) as ServiceUsageView;
};

/** The page's usage, null until it is read (and when it can't be: a row then shows no usage line). */
export function useServiceUsage(): ServiceUsageView | null {
  return useCachedLoad<ServiceUsageView>(USAGE_URL, load, { topic: [] }).data;
}

const hourMs = (hour: string) => Date.parse(`${hour}:00:00Z`);
export const usd = (n: number) => (n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);
const num = (n: number) => (n > 0 && n < 10 && !Number.isInteger(n) ? n.toFixed(1) : Math.round(n).toLocaleString("en-US"));
const amount = (n: number, unit: string) => (unit === "USD" ? `$${n.toFixed(2)}` : `${num(n)}${unit ? ` ${unit}` : ""}`);

/** "$4.20 of $49.00 this month", "1,200 of 10,000 characters this month", "$12.40 left". */
export function limitText(l: ServiceLimit): string | null {
  const month = /month/i.test(l.label) ? " this month" : "";
  if (l.used !== undefined && l.limit !== undefined) return `${amount(l.used, l.unit === "USD" ? "USD" : "")} of ${amount(l.limit, l.unit)}${month}`;
  if (l.used !== undefined) return `${amount(l.used, l.unit)}${month}`;
  if (l.limit !== undefined) return `${amount(l.limit, l.unit)} left`;
  return null;
}

/** The row's line: its last 30 days and its limit, or nothing when it has neither. */
export function usageLine(view: ServiceUsageView | null, service: string, now = Date.now()): string | null {
  if (!view) return null;
  const from = usageSince(30, now);
  const lines = view.lines.filter((l) => l.service === service && hourMs(l.hour) >= from);
  const calls = lines.reduce((n, l) => n + l.calls, 0);
  const cost = lines.reduce((n, l) => n + l.costUsd, 0);
  const used = calls ? `30 days: ${calls.toLocaleString("en-US")} ${calls === 1 ? "call" : "calls"}${cost ? `, ${usd(cost)}` : ""}` : null;
  const limits = view.limits.filter((l) => l.service === service).map(limitText);
  return [used, ...limits].filter(Boolean).join(" · ") || null;
}

type Group = { label: string; whose: ServiceUsageLine["whose"]; calls: number; units: number; unit: string; costUsd: number; last: number };

/** The service's calls since `since`, one group per tool and whose key, the most used first. */
export function byTool(lines: ServiceUsageLine[], service: string, since: number): Group[] {
  const out = new Map<string, Group>();
  for (const l of lines) {
    const at = hourMs(l.hour);
    if (l.service !== service || at < since) continue;
    const id = `${l.label}\t${l.whose}\t${l.unit}`;
    const g = out.get(id) ?? { label: l.label, whose: l.whose, calls: 0, units: 0, unit: l.unit, costUsd: 0, last: 0 };
    g.calls += l.calls;
    g.units += l.units;
    g.costUsd += l.costUsd;
    g.last = Math.max(g.last, at);
    out.set(id, g);
  }
  return [...out.values()].sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);
}

const WHOSE = { own: "", server: " · Server key", team: " · Team budget" } as const;

/** One key's usage by tool, for a period, with its limits and the way to the Usage page. */
export function KeyUsageDialog({ service, name, open, onOpenChange }: { service: string; name: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const view = useServiceUsage();
  const [days, setDays] = useState<number>(30);
  const groups = view ? byTool(view.lines, service, usageSince(days)) : [];
  const limits = (view?.limits ?? []).filter((l) => l.service === service);
  const total = groups.reduce((n, g) => n + g.costUsd, 0);
  return (
    <SettingsDialog open={open} onOpenChange={onOpenChange}>
      <SettingsDialogContent aria-describedby={undefined} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{name} usage</DialogTitle>
        </DialogHeader>
        <SettingsSelect label="Period" value={String(days)} onValueChange={(v) => setDays(Number(v))} options={USAGE_PERIODS.map((p) => ({ value: String(p.id), label: p.label }))} className="sm:w-40" />
        {limits.map((l, i) => {
          const text = limitText(l);
          return text && (
            <p key={i} className="text-sm">
              <span className="text-muted-foreground">{l.label}{l.whose === "server" ? " (server key)" : ""}: </span>
              {text}
            </p>
          );
        })}
        {!view ? (
          <p className="text-sm text-muted-foreground">Loading</p>
        ) : groups.length ? (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-1 font-normal">Tool</th>
                <th className="py-1 text-right font-normal">Calls</th>
                <th className="py-1 text-right font-normal">Used</th>
                <th className="py-1 text-right font-normal">Cost</th>
                <th className="py-1 text-right font-normal">Last used</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={`${g.label}\t${g.whose}\t${g.unit}`} className="border-t border-border/60">
                  <td className="py-1.5 pr-2">{g.label}{WHOSE[g.whose]}</td>
                  <td className="py-1.5 text-right tabular-nums">{g.calls.toLocaleString("en-US")}</td>
                  <td className="py-1.5 text-right tabular-nums">{amount(g.units, g.unit)}</td>
                  <td className="py-1.5 text-right tabular-nums">{g.costUsd ? usd(g.costUsd) : "–"}</td>
                  <td className="py-1.5 text-right tabular-nums text-muted-foreground">{new Date(g.last).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</td>
                </tr>
              ))}
              {total > 0 && (
                <tr className="border-t border-border/60 font-medium">
                  <td className="py-1.5" colSpan={3}>Total</td>
                  <td className="py-1.5 text-right tabular-nums">{usd(total)}</td>
                  <td />
                </tr>
              )}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-muted-foreground">No calls</p>
        )}
        <Link to={`/usage?key=${encodeURIComponent(service)}`} className="text-xs underline underline-offset-2" onClick={() => onOpenChange(false)}>
          Open in Usage
        </Link>
      </SettingsDialogContent>
    </SettingsDialog>
  );
}
