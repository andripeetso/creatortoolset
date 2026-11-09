/**
 * Account-level Graph insights as the app stores them: graph-stats.json
 * (the last 30 days, totals, demographics) and graph-daily.json (every day
 * of reach / new follows ever read). Pure — graph.ts does the fetching.
 */
import { mergeSnapshots, type AccountDay } from "../connectors/store";

/** Meta's account-insight days are Pacific days: each ends at midnight in Los Angeles. */
export const INSIGHTS_TIMEZONE = "America/Los_Angeles";

export const DAY_MS = 86_400_000;

export interface InsightDay {
  /** The day the value covers (a Pacific day), YYYY-MM-DD. */
  date: string;
  /** Meta's end_time for the value: the end of that day, epoch ms. */
  endTime: number;
  reach?: number;
  /** Graph follower_count with period=day: follows gained that day, not a total. */
  newFollows?: number;
}

export interface MineAccountStats {
  fetchedAt: number;
  /** Complete days of the last 30, oldest first. */
  days: InsightDay[];
  reach30d?: number;
  profileViews?: number;
  accountsEngaged?: number;
  websiteClicks?: number;
  /** Same days, by Graph metric name (graph.ts MINE_TOTALS). */
  totals?: Record<string, number>;
  /** Same days' views split into followers / non-followers, and by surface (reels, stories…). */
  viewsByFollower?: Array<{ label: string; value: number }>;
  viewsBySurface?: Array<{ label: string; value: number }>;
  countries?: Array<{ label: string; value: number }>;
  ages?: Array<{ label: string; value: number }>;
  genders?: Array<{ label: string; value: number }>;
}

/** accounts/<id>/graph-daily.json. */
export interface GraphDaily {
  /** Last time rows were merged in. */
  fetchedAt: number;
  /** When the first long backfill finished; until then each refresh tries it again. */
  backfilledAt?: number;
  /** Oldest first, one row per date. */
  days: InsightDay[];
}

/**
 * Meta stamps a daily value with the END of the day it covers: reach for
 * 22 September (Pacific) comes back as end_time 2026-09-23T07:00:00+0000.
 * Twelve hours before the end is always inside the covered day.
 */
export function insightDayCovered(endMs: number): string {
  return new Date(endMs - DAY_MS / 2).toISOString().slice(0, 10);
}

/**
 * Merge by date, oldest first. A date is never dropped, and a value the
 * newer row lacks keeps the older one; a newer value replaces an older one
 * (Meta can revise the last couple of days).
 */
export function mergeInsightDays(prev: InsightDay[], next: InsightDay[]): InsightDay[] {
  const byDate = new Map<string, InsightDay>();
  for (const row of [...prev, ...next]) {
    if (!row || typeof row.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) continue;
    const old = byDate.get(row.date);
    const endTime = Number.isFinite(row.endTime) ? row.endTime : (old?.endTime ?? 0);
    const merged: InsightDay = { date: row.date, endTime };
    const reach = row.reach ?? old?.reach;
    const newFollows = row.newFollows ?? old?.newFollows;
    if (reach !== undefined) merged.reach = reach;
    if (newFollows !== undefined) merged.newFollows = newFollows;
    byDate.set(row.date, merged);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** How far back the first refresh reads daily reach / new follows (30-day windows, ~25 calls). */
export const GRAPH_DAILY_BACKFILL_DAYS = 730;

/** The stats call already reads this many recent days. */
const RECENT_DAYS = 30;

/**
 * The next graph-daily.json, or null when there is nothing to write. Merges
 * by date, so the file never shrinks. Until one backfill has finished, it
 * first reaches back GRAPH_DAILY_BACKFILL_DAYS through `backfill`; after
 * that the stats call's recent days are enough.
 */
export async function nextGraphDaily(
  prev: GraphDaily | undefined,
  recent: InsightDay[],
  now: number,
  backfill: (sinceMs: number, untilMs: number) => Promise<{ days: InsightDay[]; complete: boolean }>,
): Promise<GraphDaily | null> {
  let rows = recent;
  let backfilledAt = prev?.backfilledAt;
  if (!backfilledAt) {
    try {
      const until = recent.length ? now - RECENT_DAYS * DAY_MS : now;
      const back = await backfill(now - GRAPH_DAILY_BACKFILL_DAYS * DAY_MS, until);
      rows = [...back.days, ...recent];
      if (back.complete) backfilledAt = now;
    } catch {
      /* the next refresh tries the backfill again */
    }
  }
  if (!rows.length && backfilledAt === prev?.backfilledAt) return null;
  const next: GraphDaily = { fetchedAt: now, days: mergeInsightDays(prev?.days ?? [], rows) };
  if (backfilledAt) next.backfilledAt = backfilledAt;
  return next;
}

/** Fill-only: a value this fetch couldn't read keeps the stored one. */
export function mergeAccountStats(
  prev: MineAccountStats | undefined,
  next: MineAccountStats,
): MineAccountStats {
  if (!prev) return next;
  return {
    fetchedAt: next.fetchedAt,
    days: next.days.length ? next.days : (prev.days ?? []),
    reach30d: next.reach30d ?? prev.reach30d,
    profileViews: next.profileViews ?? prev.profileViews,
    accountsEngaged: next.accountsEngaged ?? prev.accountsEngaged,
    websiteClicks: next.websiteClicks ?? prev.websiteClicks,
    totals: next.totals ?? prev.totals,
    viewsByFollower: next.viewsByFollower ?? prev.viewsByFollower,
    viewsBySurface: next.viewsBySurface ?? prev.viewsBySurface,
    countries: next.countries ?? prev.countries,
    ages: next.ages ?? prev.ages,
    genders: next.genders ?? prev.genders,
  };
}

/** How long one account day stays in the stored history. Each pull reads 30 days, so the rest comes from earlier pulls. */
export const DAILY_HISTORY_DAYS = 90;

/**
 * Adds a pull's account days to the account's stored daily history (store.ts `daily`). A day replaces its own row,
 * but a value the pull lacks keeps the stored one, and a day with neither value is not stored (absent, not zero).
 * Rows older than 90 days, measured from `now`, are dropped.
 */
export function nextAccountDaily(prev: AccountDay[] | undefined, days: InsightDay[], key: string, now: number): AccountDay[] {
  let out = prev ?? [];
  for (const d of [...days].sort((x, y) => x.date.localeCompare(y.date))) {
    const old = out.find((r) => r.day === d.date && r.id === key);
    const reach = d.reach ?? old?.reach;
    const newFollows = d.newFollows ?? old?.newFollows;
    if (reach === undefined && newFollows === undefined) continue;
    const row: AccountDay = { day: d.date, id: key };
    if (reach !== undefined) row.reach = reach;
    if (newFollows !== undefined) row.newFollows = newFollows;
    out = mergeSnapshots(out, d.date, [row], DAILY_HISTORY_DAYS);
  }
  return mergeSnapshots(out, new Date(now).toISOString().slice(0, 10), [], DAILY_HISTORY_DAYS);
}
