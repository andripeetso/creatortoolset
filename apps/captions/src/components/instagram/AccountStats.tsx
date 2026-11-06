import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import {
  catalogTotals,
  fmtCount,
  fmtDate,
  fmtDelta,
  getAccount,
  kindLabel,
  monthTotals,
  rowViews,
  type CatalogItem,
  type InstagramAccount,
  type Snapshot,
} from "@/lib/instagram";

type Row = { label: string; value: number };
type Point = { key: string; label: string; value: number };

/** One metric: its headline card, and the chart it opens. */
interface Series {
  id: string;
  label: string;
  value?: number;
  note?: ReactNode;
  points: Point[];
  unit: string;
  line?: boolean;
}

const LABELS: Record<string, string> = {
  FOLLOWER: "Followers",
  NON_FOLLOWER: "Non-followers",
  REEL: "Reels",
  REELS: "Reels",
  STORY: "Stories",
  POST: "Posts",
  FEED: "Feed",
  CAROUSEL_CONTAINER: "Carousels",
  AD: "Ads",
  LIVE: "Live",
  F: "Women",
  M: "Men",
  U: "Unknown",
};

const regions = (() => {
  try {
    return new Intl.DisplayNames(undefined, { type: "region" });
  } catch {
    return null;
  }
})();

function nice(label: string, country = false): string {
  if (LABELS[label]) return LABELS[label];
  if (country && /^[A-Z]{2}$/.test(label)) return regions?.of(label) ?? label;
  return label.charAt(0) + label.slice(1).toLowerCase().replace(/_/g, " ");
}

const thisMonth = () => new Date().toISOString().slice(0, 7);

const monthPoints = (entries: Array<[string, number | undefined]>): Point[] =>
  monthTotals(entries).map(({ month, value }) => ({
    key: month,
    label:
      new Date(`${month}-01T00:00:00Z`).toLocaleString(undefined, { month: "short", year: "numeric", timeZone: "UTC" }) +
      (month === thisMonth() ? " so far" : ""),
    value,
  }));

/** Followers at the last snapshot of each day. */
function followerPoints(snaps: Snapshot[]): Point[] {
  const byDay = new Map<string, Point>();
  for (const s of [...snaps].sort((a, b) => a.at - b.at)) {
    if (s.followers === undefined) continue;
    const key = new Date(s.at).toISOString().slice(0, 10);
    byDay.set(key, { key, label: fmtDate(s.at), value: s.followers });
  }
  return [...byDay.values()];
}

const hasChart = (s: Series) => (s.line ? s.points.length > 1 : s.points.some((p) => p.value > 0));

export function StatsSection({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="mb-3 flex min-h-6 items-center justify-between gap-2">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Kpi({ s, on, onPick }: { s: Series; on: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      disabled={!hasChart(s)}
      aria-pressed={on}
      onClick={onPick}
      className={`rounded-lg border px-3 py-2.5 text-left disabled:cursor-default ${
        on ? "border-violet-500/60 bg-violet-500/10" : "border-zinc-800 enabled:hover:border-zinc-600"
      }`}
    >
      <p className="text-xs text-zinc-500">{s.label}</p>
      <p className="text-2xl font-semibold text-zinc-100" title={s.value?.toLocaleString()}>
        {fmtCount(s.value)}
      </p>
      {s.note ? <p className="text-[11px] text-zinc-500">{s.note}</p> : null}
    </button>
  );
}

function Chart({ s }: { s: Series }) {
  const [hover, setHover] = useState<number | null>(null);
  const pts = s.points;
  const i = hover ?? pts.length - 1;
  const vals = pts.map((p) => p.value);
  const lo = s.line ? Math.min(...vals) : 0;
  const hi = Math.max(...vals);
  const y = (v: number) => (hi === lo ? 50 : ((v - lo) / (hi - lo)) * 100);
  const x = (k: number) => ((k + 0.5) / pts.length) * 100;
  const top = (v: number) => 100 - (5 + y(v) * 0.9);
  return (
    <div>
      <p className="text-xs text-zinc-400">
        {pts[i].label} · <span className="font-medium text-zinc-100">{pts[i].value.toLocaleString()}</span> {s.unit}
      </p>
      <div className="relative mt-3 h-36" onMouseLeave={() => setHover(null)}>
        {s.line ? (
          <>
            <svg
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              className="absolute inset-0 h-full w-full overflow-visible text-violet-400"
            >
              <polyline
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                points={pts.map((p, k) => `${x(k)},${top(p.value)}`).join(" ")}
              />
            </svg>
            <span
              className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-violet-400 ring-2 ring-[#131318]"
              style={{ left: `${x(i)}%`, top: `${top(pts[i].value)}%` }}
            />
          </>
        ) : null}
        <div className="absolute inset-0 flex items-end gap-[2px]">
          {pts.map((p, k) => (
            <div
              key={p.key}
              className="flex h-full flex-1 items-end justify-center"
              onMouseEnter={() => setHover(k)}
              onClick={() => setHover(k)}
            >
              {s.line ? (
                k === i ? <span className="h-full w-px bg-zinc-700" /> : null
              ) : (
                <div
                  className={`w-full max-w-6 rounded-t-[4px] ${k === i ? "bg-violet-400" : "bg-violet-600/60"}`}
                  style={{ height: `${y(p.value)}%`, minHeight: p.value ? 2 : 0 }}
                />
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="mt-1.5 flex justify-between border-t border-zinc-800 pt-1.5 text-[10px] text-zinc-600">
        <span>{pts[0].label}</span>
        {s.line ? (
          <span>
            {lo.toLocaleString()} – {hi.toLocaleString()}
          </span>
        ) : null}
        <span>{pts[pts.length - 1].label}</span>
      </div>
    </div>
  );
}

function Facts({ items }: { items: Array<[string, number | string | undefined]> }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
      {items
        .filter(([, v]) => v !== undefined)
        .map(([label, v]) => (
          <div key={label}>
            <dt className="text-[11px] text-zinc-500">{label}</dt>
            <dd
              className="text-base font-semibold text-zinc-100"
              title={typeof v === "number" ? v.toLocaleString() : undefined}
            >
              {typeof v === "number" ? fmtCount(v) : v}
            </dd>
          </div>
        ))}
    </dl>
  );
}

function Table({ head, rows }: { head: string[]; rows: Array<Array<string | number | undefined>> }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-[11px] text-zinc-500">
          {head.map((h, i) => (
            <th key={`${h}-${i}`} className={`pb-1.5 font-normal ${i ? "text-right" : "text-left"}`}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={String(r[0])} className="border-t border-zinc-800">
            {r.map((v, i) => (
              <td key={i} className={`py-1.5 ${i ? "text-right tabular-nums text-zinc-100" : "text-zinc-300"}`}>
                {typeof v === "number" ? fmtCount(v) : (v ?? "—")}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Shares of a whole as thin horizontal bars, largest first. */
function Shares({ title, rows, country }: { title: string; rows: Row[]; country?: boolean }) {
  const shown = rows.filter((r) => r.value > 0);
  const sum = shown.reduce((n, r) => n + r.value, 0) || 1;
  const max = Math.max(1, ...shown.map((r) => r.value));
  return (
    <div>
      <p className="mb-2 text-xs text-zinc-400">{title}</p>
      <div className="flex flex-col gap-2">
        {shown.map((r) => (
          <div key={r.label} title={r.value.toLocaleString()}>
            <div className="flex justify-between text-xs">
              <span className="truncate text-zinc-300">{nice(r.label, country)}</span>
              <span className="ml-2 tabular-nums text-zinc-400">{Math.round((r.value / sum) * 100)}%</span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-zinc-800">
              <div className="h-full rounded-full bg-violet-500" style={{ width: `${(r.value / max) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The headline: followers, posts (and trials on your own account) and views
 * big on one line; the rest of what the listed posts add up to below it.
 */
export function AccountTotals({
  account,
  catalog,
  className = "",
  children,
}: {
  account: InstagramAccount;
  catalog: CatalogItem[];
  className?: string;
  children?: ReactNode;
}) {
  const all = catalogTotals(catalog);
  const split = !!account.mine && catalog.some((r) => r.visibility);
  const trials = catalog.filter((r) => r.visibility === "trial").length;
  const some = (n: number) => (all.posts && n ? n : undefined);
  const big: Array<[number | undefined, string]> = [
    [account.counts.followers, "followers"],
    [split ? all.posts - trials : account.counts.posts, "posts"],
    [split && trials ? trials : undefined, "trials"],
    [some(all.views), "views"],
  ];
  const small: Array<[number | undefined, string]> = [
    [some(all.likes), "likes"],
    [some(all.comments), "comments"],
    [some(all.saves), "saves"],
    [some(all.shares), "shares"],
    [some(Math.round(all.views / all.posts)), "views per post"],
  ];
  const partial = !split && all.posts > 0 && all.posts < (account.counts.posts ?? 0);
  return (
    <div className={className}>
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
        {big.map(([n, label]) =>
          n === undefined ? null : (
            <span key={label} className="text-sm text-zinc-400" title={n.toLocaleString()}>
              <span className="text-xl font-semibold text-zinc-100">{fmtCount(n)}</span> {label}
            </span>
          ),
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px] text-zinc-500">
        {small.map(([n, label]) =>
          n === undefined ? null : (
            <span key={label} title={n.toLocaleString()}>
              <span className="font-medium text-zinc-300">{fmtCount(n)}</span> {label}
            </span>
          ),
        )}
        {partial ? (
          <span>
            · from {all.posts} of {fmtCount(account.counts.posts)} posts
          </span>
        ) : null}
        {children}
      </div>
    </div>
  );
}

/** All stats, one card per topic: growth charts, the last 30 days, posting, audience. */
export function AccountStats({
  account,
  catalog,
  children,
}: {
  account: InstagramAccount;
  catalog: CatalogItem[];
  children?: ReactNode;
}) {
  const [pick, setPick] = useState<string | null>(null);
  const ins = account.insights;
  const g = account.mine ? ins?.graph : undefined;
  const history = account.mine ? (ins?.history ?? []) : [];
  const t = g?.totals ?? {};
  const all = catalogTotals(catalog);
  const followers = followerPoints(account.snapshots ?? []);
  const change = followers.length > 1 ? followers[followers.length - 1].value - followers[0].value : undefined;
  const follows30 = g?.days?.reduce((n, d) => n + (d.newFollows ?? 0), 0);
  const series: Series[] = [
    {
      id: "views",
      label: "Views",
      value: all.views || undefined,
      note: t.views !== undefined ? `${fmtCount(t.views)} in the last 30 days` : "all listed posts",
      points: monthPoints(
        catalog.filter((r) => r.takenAt).map((r): [string, number | undefined] => [
          new Date(r.takenAt).toISOString(),
          rowViews(r),
        ]),
      ),
      unit: "views on the posts published that month",
    },
    ...(g
      ? [
          {
            id: "reach",
            label: "Reached",
            value: t.reach ?? g.reach30d,
            note: "accounts, last 30 days",
            points: monthPoints(history.map((d): [string, number | undefined] => [d.date, d.reach])),
            unit: "accounts reached (daily reach added up)",
          },
          {
            id: "follows",
            label: "New follows",
            value: follows30 || undefined,
            note: "last 30 days",
            points: monthPoints(history.map((d): [string, number | undefined] => [d.date, d.newFollows])),
            unit: "new follows",
          },
        ]
      : []),
    {
      id: "followers",
      label: "Followers",
      value: account.counts.followers,
      note:
        change !== undefined ? (
          <>
            <span className={change < 0 ? "text-red-400" : "text-emerald-400"}>{fmtDelta(change)}</span> since{" "}
            {followers[0].label}
          </>
        ) : undefined,
      points: followers,
      unit: "followers",
      line: true,
    },
  ].filter((s) => s.value !== undefined);
  const charted = series.filter(hasChart);
  const active = charted.find((s) => s.id === pick) ?? charted[0];

  const split = account.mine ? ins?.split : undefined;
  const audience: Array<[string, Row[] | undefined, boolean?]> = [
    ["Countries", g?.countries?.slice(0, 5), true],
    ["Ages", g?.ages && [...g.ages].sort((a, b) => a.label.localeCompare(b.label))],
    ["Gender", g?.genders],
  ];

  return (
    <div className="space-y-3">
      {series.length ? (
        <StatsSection title="Growth">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {series.map((s) => (
              <Kpi key={s.id} s={s} on={s === active} onPick={() => setPick(s.id)} />
            ))}
          </div>
          {active ? (
            <div className="mt-4">
              <Chart key={active.id} s={active} />
            </div>
          ) : null}
        </StatsSection>
      ) : null}

      {g ? (
        <StatsSection title="Last 30 days">
          <Facts
            items={[
              ["Interactions", t.total_interactions],
              ["Accounts engaged", g.accountsEngaged],
              ["Profile views", g.profileViews],
              ["Link taps", t.profile_links_taps ?? g.websiteClicks],
              ["Likes", t.likes],
              ["Comments", t.comments],
              ["Saves", t.saves],
              ["Shares", t.shares],
              ["Story replies", t.replies],
            ]}
          />
          {g.viewsByFollower?.length || g.viewsBySurface?.length ? (
            <div className="mt-4 grid gap-5 border-t border-zinc-800 pt-4 sm:grid-cols-2">
              {g.viewsByFollower?.length ? <Shares title="Views from" rows={g.viewsByFollower} /> : null}
              {g.viewsBySurface?.length ? <Shares title="Views on" rows={g.viewsBySurface} /> : null}
            </div>
          ) : null}
        </StatsSection>
      ) : null}

      {ins && catalog.length ? (
        <StatsSection title="Posting">
          <Facts
            items={[
              ["Posts per week", ins.cadence.postsPerWeek],
              ["Days between posts", ins.cadence.medianGapDays],
              ["Last post", ins.cadence.lastPostedAt ? fmtDate(ins.cadence.lastPostedAt) : undefined],
            ]}
          />
          <div className="mt-4 grid gap-5 border-t border-zinc-800 pt-4 sm:grid-cols-2">
            <Table
              head={["Format", "Posts", "Avg views"]}
              rows={ins.byKind.filter((k) => k.count).map((k) => [kindLabel(k.kind), k.count, k.avgPlays])}
            />
            {split ? (
              <Table
                head={["", "Posts", "Median views", "Reach", "Saved"]}
                rows={[
                  ["Public", split.public.count, split.public.medianPlays, split.public.reach, split.public.saved],
                  ["Trial", split.trial.count, split.trial.medianPlays, split.trial.reach, split.trial.saved],
                ]}
              />
            ) : null}
          </div>
          {all.top ? (
            <p className="mt-4 truncate border-t border-zinc-800 pt-3 text-xs text-zinc-500">
              Most viewed ({fmtCount(rowViews(all.top))}):{" "}
              <a href={all.top.url} target="_blank" rel="noreferrer" className="text-zinc-300 hover:text-violet-300">
                {all.top.captionPreview || all.top.shortcode}
              </a>
            </p>
          ) : null}
        </StatsSection>
      ) : null}

      {audience.some(([, rows]) => rows?.length) ? (
        <StatsSection title="Who you reached this month">
          <div className="grid gap-5 sm:grid-cols-3">
            {audience.map(([title, rows, country]) =>
              rows?.length ? <Shares key={title} title={title} rows={rows} country={country} /> : null,
            )}
          </div>
        </StatsSection>
      ) : null}

      {children}
    </div>
  );
}

/** The phone Analyzer: one account's stats behind its headline numbers, fetched on its own. */
export function AccountStatsCard({ id }: { id: string }) {
  const [account, setAccount] = useState<InstagramAccount | null>(null);
  useEffect(() => {
    getAccount(id)
      .then(setAccount)
      .catch(() => {});
  }, [id]);
  if (!account) return null;
  const catalog = account.catalog ?? [];
  const views30 = account.insights?.graph?.totals?.views;
  return (
    <details className="group rounded-xl border border-zinc-800 bg-zinc-900/40 px-3 py-2.5">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium text-zinc-100">@{account.username}</span>
          <span className="text-zinc-500">
            {" "}
            · {fmtCount(catalogTotals(catalog).views)} views
            {views30 !== undefined ? ` · ${fmtCount(views30)} in 30d` : ""}
          </span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-zinc-500 transition-transform group-open:rotate-180" />
      </summary>
      <AccountTotals account={account} catalog={catalog} className="mb-3 mt-3" />
      <AccountStats account={account} catalog={catalog} />
    </details>
  );
}
