import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Asterisk, GaugeIcon, Terminal, TrendingDownIcon, TrendingUpIcon, type LucideIcon } from "lucide-react";
import { getProviders, instanceName, USAGE_PERIODS, usageBy, usageSince, type UsageTotals } from "@/lib/providers";
import { DRIVERS, type Driver, type LimitsIdentity, type LimitWindow, type ProvidersView } from "@contracts/providers";
import { tokensLabel } from "@/lib/workshop";
import { cn } from "@/lib/utils";
import {
  evenPaceLeft,
  identityKey,
  leftOf,
  limitSections,
  noticeOf,
  resetPill,
  resetsIn,
  type Pace,
  type Pool,
  type PoolMember,
} from "@/lib/limits";
import { Card, Footnote, Group, Loading, Notice } from "./ui";
import { msg } from "./helpers";

const ZERO: UsageTotals = { calls: 0, tokens: 0, costUsd: 0 };
/** Calls on the Anthropic API key (guests, the demo, image reading): the only ones that cost money. The server tallies them as "<job> (API)". */
const PAID = "api";
const isPaid = (r: { label: string }) => r.label.endsWith(" (API)");
const HOUR_MS = 3_600_000;
const STALE_MS = 15 * 60_000;
const RELOAD_MS = 60_000; // the Macs report limits every five minutes; a minute here is fresh enough

/** Settings → Usage: the plan limits left on each login first, then the calls, tokens and API-equivalent cost. */
export function UsageSection() {
  const [view, setView] = useState<ProvidersView | null>(null);
  const [error, setError] = useState<string | null>(null);

  // no refresh button: it reloads every minute on its own
  useEffect(() => {
    const quiet = () => void getProviders().then((v) => (setView(v), setError(null))).catch((e) => setError(msg(e)));
    quiet();
    const timer = setInterval(quiet, RELOAD_MS);
    return () => clearInterval(timer);
  }, []);

  if (error && !view) return <Notice tone="error">Could not load usage: {error}</Notice>;
  if (!view) return <Loading />;

  return (
    <>
      {error && <Notice tone="error">Could not refresh usage: {error}</Notice>}
      <LimitsView view={view} />
      <CostUsage view={view} />
    </>
  );
}

const PACE: Record<Pace, { label: string; icon: LucideIcon }> = {
  ahead: { label: "Ahead of pace: spending faster than the window elapses", icon: TrendingUpIcon },
  on: { label: "On pace with the window", icon: GaugeIcon },
  under: { label: "Under pace: headroom left for the rest of the window", icon: TrendingDownIcon },
};

/** A driver's mark: a small icon, not a logo. */
const MARK: Partial<Record<Driver, LucideIcon>> = { claude: Asterisk, codex: Terminal };

/** The name of the Mac a login runs on, as this account sees it. */
const macName = (view: ProvidersView, id: string) => view.devices.find((d) => d.id === id)?.name ?? "another Mac";

/** Settings → Usage → Limits: per driver, one card per window with the share left and a bar per login. */
function LimitsView({ view }: { view: ProvidersView }) {
  // the countdowns move on with each reload (the view changes) and every minute
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    queueMicrotask(() => setNow(Date.now()));
  }, [view]);
  const driverName = (d: Driver) => DRIVERS.find((x) => x.id === d)?.label ?? d;
  const sections = limitSections(view.limits, now);

  if (!view.limits.length) {
    return (
      <Group title="Limits" hint="How much of each plan is left, read from each Mac every five minutes.">
        <Notice>
          Nothing to show yet. Once a Claude or Codex AI runs on a Mac, its limits appear here within five minutes.{" "}
          <Link to="/settings/providers" className="underline underline-offset-2">Open Providers</Link>
        </Notice>
      </Group>
    );
  }

  const drivers: Driver[] = ["claude", "codex"];
  return (
    <Group title="Limits" hint="Read from each online Mac every five minutes.">
      {drivers.map((driver) => {
        const section = sections.find((s) => s.driver === driver);
        const notices = view.limits.filter((i) => i.driver === driver && noticeOf(i) !== null);
        if (!section && !notices.length) return null;
        const Mark = MARK[driver] ?? Asterisk;
        return (
          <section key={driver} className="space-y-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Mark className="size-4 text-violet-500" aria-hidden />
              {driverName(driver)}
            </h2>
            {section?.pools.map((pool) => (
              <WindowCard key={pool.key} pool={pool} view={view} now={now} />
            ))}
            {notices.length > 0 && (
              <Card>
                {notices.map((i) => (
                  <NoticeRow key={identityKey(i)} identity={i} view={view} />
                ))}
              </Card>
            )}
          </section>
        );
      })}
    </Group>
  );
}

/** A login with no usable reading: the folder, the Mac it runs on, what is wrong and where to fix it. */
function NoticeRow({ identity, view }: { identity: LimitsIdentity; view: ProvidersView }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-3 text-xs sm:px-4">
      <span className="min-w-0">
        <span className="text-foreground">
          {DRIVERS.find((x) => x.id === identity.driver)?.label ?? identity.driver} ({identity.label}) on {macName(view, identity.device)}:
        </span>{" "}
        <span className="text-muted-foreground">{noticeOf(identity)}</span>
      </span>
      <Link to="/settings/providers" className="shrink-0 underline underline-offset-2 hover:text-foreground">
        Open Your AI
      </Link>
    </div>
  );
}

/** One window across the logins: the headline share left, its trend and refill, then a bar per login. */
function WindowCard({ pool, view, now }: { pool: Pool; view: ProvidersView; now: number }) {
  const many = pool.columns.length > 1;
  const pace = pool.pace;
  const refill = pool.resets.find((r) => r.restores > 0);
  const Trend = pace ? PACE[pace].icon : null;
  return (
    <div className="grid items-center gap-x-6 gap-y-3 rounded-xl border border-border/60 p-4 md:grid-cols-[11rem_minmax(0,1fr)]">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-foreground">{pool.label}</span>
        <span className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold text-foreground tabular-nums">{pool.remaining}%</span>
          <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            left
            {pace && Trend && <Trend className="size-3.5" aria-label={PACE[pace].label} role="img" />}
          </span>
        </span>
        {refill && many && <span className="text-xs font-medium text-foreground tabular-nums">↻ +{refill.restores}%</span>}
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        {pool.columns.map((column) =>
          column.member ? (
            <Bar key={identityKey(column.identity)} member={column.member} many={many} view={view} now={now} />
          ) : null,
        )}
      </div>
    </div>
  );
}

/** A login's bar: the share left filled, the hatched part is what its reset gives back, the tick is even pace. */
function Bar({ member, many, view, now }: { member: PoolMember; many: boolean; view: ProvidersView; now: number }) {
  const w: LimitWindow = member.window;
  const remaining = leftOf(w.usedPercent);
  const even = evenPaceLeft(w, now);
  const pill = resetPill(w, now);
  const name = member.identity.label;
  const hatch = Math.min(100 - remaining, member.refill);
  const tick = even === null ? null : `clamp(3px, ${even}%, calc(100% - 3px))`;
  const used = usedHere(view, member.identity, w);
  const stale = staleLine(member.identity, now);

  return (
    <div className="min-w-0 space-y-1">
      <div
        className="relative flex h-7 items-center overflow-hidden rounded-md bg-muted text-xs"
        role="img"
        aria-label={`${name}: ${remaining}% left${resetsIn(w, now) ? `, ${resetsIn(w, now)}` : ""}`}
      >
        <div className="absolute inset-y-0 left-0 bg-violet-500/35" style={{ width: `${remaining}%` }} />
        {remaining < 100 && member.refill > 0 && hatch > 0 && (
          <div
            className="absolute inset-y-0 right-0 text-violet-500"
            style={{
              width: `${hatch}%`,
              backgroundImage: "repeating-linear-gradient(135deg, currentColor 0 1px, transparent 1px 5px)",
              opacity: 0.45,
            }}
          />
        )}
        {tick && <span className="absolute inset-y-0.5 w-0.5 rounded-full bg-foreground shadow-[0_0_0_2px_var(--card)]" style={{ left: tick }} />}
        <span className="relative flex min-w-0 flex-1 items-center gap-2 px-2.5">
          {many && <span className="min-w-0 truncate font-medium text-foreground">{name}</span>}
          {many && <span className="shrink-0 font-semibold text-foreground tabular-nums">{remaining}%</span>}
          {pill && (
            <span className="ms-auto shrink-0 rounded-sm bg-background/85 px-1.5 py-0.5 text-[11px] whitespace-nowrap text-foreground tabular-nums">
              {pill}
            </span>
          )}
        </span>
      </div>
      {(used || stale) && (
        <div className="text-[11px] text-muted-foreground tabular-nums">{[stale, used].filter(Boolean).join(" · ")}</div>
      )}
    </div>
  );
}

function staleLine(i: LimitsIdentity, now: number): string | null {
  const age = now - i.at;
  if (!i.online) return `Mac offline · last reading ${ago(age)} ago`;
  if (age > STALE_MS) return `Reading ${ago(age)} old`;
  return null;
}

/** The calls and tokens this app spent on that login since its window opened (the tally is hourly: the hour it opened counts). */
function usedHere(view: ProvidersView, i: LimitsIdentity, w: LimitWindow): string | null {
  if (w.resetsAt === undefined || !w.windowMs) return null;
  const from = w.resetsAt - w.windowMs;
  let calls = 0;
  let tokens = 0;
  for (const r of view.usage) {
    if (!r.instance || !i.instances.includes(`${r.scope}:${r.instance}`)) continue;
    if (Date.parse(`${r.hour}:00:00Z`) + HOUR_MS <= from) continue;
    calls += r.calls;
    tokens += r.tokens;
  }
  return calls ? `${calls} call${calls === 1 ? "" : "s"} · ${tokensLabel(tokens)} tokens used here` : "nothing used here yet";
}

/** "12 min", "3 h", "2 days": how old a reading is. */
function ago(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} days`;
}

/** Settings → Usage → Calls and cost: calls, tokens and the API-equivalent cost, per provider and per job, over a period. */
function CostUsage({ view }: { view: ProvidersView }) {
  const [days, setDays] = useState<number>(7);

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
    <Card className="overflow-x-auto px-3">
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
                {r.tag && <span className={cn("ml-2 text-[10px] uppercase tracking-wider", r.tag === "Workspace" ? "text-violet-500" : r.tag === "API key" ? "text-amber-500" : "text-muted-foreground")}>{r.tag}</span>}
              </td>
              {cell(r.totals)}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );

  const providerRows = [...byProvider.entries()]
    .map(([k, totals]) => {
      if (k === PAID) return { key: k, name: "Anthropic API key", tag: "API key", totals, rank: totals.costUsd };
      const [scope, instance] = k.split("\n");
      return { key: k, name: instanceName(view, scope, instance), tag: hasWorkspace ? (scope === "workspace" ? "Workspace" : "Yours") : undefined, totals, rank: totals.costUsd };
    })
    .sort((a, b) => b.rank - a.rank);
  const jobRows = [...byJob.entries()].map(([k, totals]) => ({ key: k, name: k, totals, rank: totals.costUsd })).sort((a, b) => b.rank - a.rank);

  return (
    <>
      <div role="radiogroup" aria-label="Period" className="flex flex-wrap gap-1.5">
        {USAGE_PERIODS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={days === p.id}
            onClick={() => setDays(p.id)}
            className={cn(
              "h-8 rounded-md border px-3 text-xs transition-colors",
              days === p.id ? "border-violet-500/60 bg-violet-500/10 text-foreground" : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
      <Group
        title="Summary"
        hint={
          total.calls ? (
            <>
              {total.calls} calls · {tokensLabel(total.tokens)} tokens in the last {period}. Spent on the API key: ${paid.costUsd.toFixed(2)}
              {paid.calls ? ` (${paid.calls} call${paid.calls === 1 ? "" : "s"})` : ""}.
            </>
          ) : (
            <>Nothing ran in the last {period}.</>
          )
        }
      >
        <Footnote>Everything else ran on your subscriptions. Its cost is what the same calls would cost at API prices.</Footnote>
      </Group>

      <Group title="By AI">{table("AI", providerRows)}</Group>
      <Group title="By job" hint="Content Workshop, Caption Studio, the Analyzer and Video Notes.">
        {table("Job", jobRows)}
      </Group>
    </>
  );
}
