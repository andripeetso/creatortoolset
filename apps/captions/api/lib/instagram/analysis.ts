import type { CatalogItem, IdeaStatus, Snapshot } from "./types";

const STOP = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "is", "it", "this",
  "that", "with", "you", "your", "i", "me", "my", "we", "they", "be", "was", "are",
  "at", "as", "from", "so", "but", "not", "just", "like", "can", "if", "do", "did",
]);

export function normalizeHook(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80);
}

export function hookPatterns(
  posts: Array<{
    id: string;
    hook?: string;
    rank?: number;
    virality: number;
  }>,
): Array<{ hook: string; count: number; postIds: string[]; avgRank?: number; avgVirality: number }> {
  const map = new Map<string, { ids: string[]; ranks: number[]; vir: number }>();
  for (const p of posts) {
    const hook = p.hook ? normalizeHook(p.hook) : "";
    if (hook.length < 4) continue;
    const cur = map.get(hook) ?? { ids: [], ranks: [], vir: 0 };
    cur.ids.push(p.id);
    if (typeof p.rank === "number") cur.ranks.push(p.rank);
    cur.vir += p.virality;
    map.set(hook, cur);
  }
  return [...map.entries()]
    .map(([hook, v]) => ({
      hook,
      count: v.ids.length,
      postIds: v.ids,
      avgRank: v.ranks.length
        ? Math.round((v.ranks.reduce((a, b) => a + b, 0) / v.ranks.length) * 10) / 10
        : undefined,
      avgVirality: Math.round(v.vir / v.ids.length),
    }))
    .sort((a, b) => b.count - a.count || b.avgVirality - a.avgVirality)
    .slice(0, 24);
}

export function playsPerDay(first: Snapshot, last: Snapshot): number | undefined {
  if (first.plays === undefined || last.plays === undefined) return undefined;
  const days = Math.max((last.at - first.at) / 86_400_000, 1 / 24);
  return (last.plays - first.plays) / days;
}

export function postingCadence(
  accounts: Array<{ id: string; username: string; catalog: CatalogItem[] }>,
): Array<{
  accountId: string;
  username: string;
  count: number;
  medianGapDays?: number;
  postsPerWeek?: number;
  lastPostedAt?: number;
}> {
  return accounts
    .map((a) => {
      const times = a.catalog.map((c) => c.takenAt).filter((t) => t > 0).sort((x, y) => x - y);
      if (times.length < 2) {
        return {
          accountId: a.id,
          username: a.username,
          count: times.length,
          lastPostedAt: times[0],
        };
      }
      const gaps = [];
      for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
      gaps.sort((x, y) => x - y);
      const median = gaps[Math.floor(gaps.length / 2)];
      const span = times[times.length - 1] - times[0];
      return {
        accountId: a.id,
        username: a.username,
        count: times.length,
        medianGapDays: Math.round((median / 86_400_000) * 10) / 10,
        postsPerWeek: span > 0 ? Math.round((times.length / (span / 86_400_000 / 7)) * 10) / 10 : undefined,
        lastPostedAt: times[times.length - 1],
      };
    })
    .filter((a) => a.count > 0)
    .sort((a, b) => (b.postsPerWeek ?? 0) - (a.postsPerWeek ?? 0));
}

export function commentThemes(
  texts: string[],
): Array<{ label: string; count: number }> {
  const freq = new Map<string, number>();
  for (const raw of texts) {
    for (const w of raw.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, " ").split(/\s+/)) {
      if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 24)
    .map(([label, count]) => ({ label, count }));
}

export function stackStatusFromMembers(statuses: Array<IdeaStatus | undefined>): IdeaStatus {
  const set = new Set(statuses.map((s) => s ?? "inbox"));
  if (set.size === 1) return [...set][0]!;
  if (set.has("done")) return "idea";
  return "inbox";
}

export function catalogMix(catalog: CatalogItem[]): { reels: number; carousels: number; posts: number } {
  const mix = { reels: 0, carousels: 0, posts: 0 };
  for (const row of catalog) {
    if (row.kind === "reel") mix.reels++;
    else if (row.kind === "carousel") mix.carousels++;
    else mix.posts++;
  }
  return mix;
}

export function medianPlays(catalog: CatalogItem[]): number | undefined {
  const nums = catalog.map((r) => r.counts.plays).filter((n): n is number => typeof n === "number");
  if (!nums.length) return undefined;
  nums.sort((a, b) => a - b);
  return nums[Math.floor(nums.length / 2)];
}

export function kindAverages(
  catalog: CatalogItem[],
): Array<{ kind: CatalogItem["kind"]; count: number; avgPlays?: number }> {
  const kinds: CatalogItem["kind"][] = ["reel", "carousel", "post"];
  return kinds
    .map((kind) => {
      const rows = catalog.filter((r) => r.kind === kind);
      const plays = rows.map((r) => r.counts.plays).filter((n): n is number => typeof n === "number");
      return {
        kind,
        count: rows.length,
        avgPlays: plays.length
          ? Math.round(plays.reduce((a, b) => a + b, 0) / plays.length)
          : undefined,
      };
    })
    .filter((x) => x.count > 0);
}

/** Ratio vs account median. "low" when in the bottom fifth or ≤ 0.5×. */
export function playsVsMedian(
  plays: number | undefined,
  median: number | undefined,
  allPlays: number[],
): { ratio?: number; hint: string } {
  if (plays === undefined || !median) return { hint: "" };
  const ratio = Math.round((plays / Math.max(median, 1)) * 10) / 10;
  const below = allPlays.filter((n) => n < plays).length;
  const percentile = allPlays.length ? below / allPlays.length : 1;
  if (percentile < 0.2 || ratio <= 0.5) return { ratio, hint: "low" };
  return { ratio, hint: `${ratio}×` };
}

export interface VisibilityRollup {
  count: number;
  views?: number;
  reach?: number;
  saved?: number;
  shares?: number;
  medianPlays?: number;
}

export function visibilitySplit(catalog: CatalogItem[]): {
  public: VisibilityRollup;
  trial: VisibilityRollup;
} {
  const roll = (rows: CatalogItem[]): VisibilityRollup => {
    const sum = (pick: (r: CatalogItem) => number | undefined) => {
      let n = 0;
      let any = false;
      for (const row of rows) {
        const v = pick(row);
        if (v === undefined) continue;
        n += v;
        any = true;
      }
      return any ? n : undefined;
    };
    return {
      count: rows.length,
      views: sum((r) => r.insights?.views ?? r.counts.plays),
      reach: sum((r) => r.insights?.reach),
      saved: sum((r) => r.insights?.saved),
      shares: sum((r) => r.insights?.shares),
      medianPlays: medianPlays(rows),
    };
  };
  return {
    public: roll(catalog.filter((r) => r.visibility === "public")),
    trial: roll(catalog.filter((r) => r.visibility === "trial")),
  };
}
