import { AsyncLocalStorage } from "node:async_hooks";
import { instagramLogin } from "../connectors/store";
import { parseInstagramUrl } from "./url";
import type { CatalogItem, CatalogPage, CatalogVisibility, Comment, ProfileInfo, VisibilityBasis } from "./types";
import { InstagramError } from "./base";
import { env } from "../env";
import {
  DAY_MS,
  insightDayCovered,
  mergeInsightDays,
  type InsightDay,
  type MineAccountStats,
} from "./account-insights";

export type { MineAccountStats } from "./account-insights";

/**
 * Official Instagram Graph API for the Toolset user's own professional
 * account (Analyzer `mine` only). Other creators stay on the user's own Apify key.
 * Credentials are install-wide: META_ACCESS_TOKEN + INSTAGRAM_USER_ID,
 * read from the .env. They read one Instagram account, so only the
 * owner's (SOCIAL_FEED_OWNER) Mine account uses them. Never persist paging.next — it embeds the token.
 */

const BASE = "https://graph.facebook.com/v21.0";
const TIMEOUT_MS = 90_000;
const PROFILE_FIELDS =
  "id,username,name,biography,followers_count,follows_count,media_count,profile_picture_url";
const MEDIA_FIELDS =
  "id,media_type,media_product_type,caption,timestamp,permalink,media_url,thumbnail_url,like_count,comments_count,is_shared_to_feed,insights.metric(views,reach,saved,shares,total_interactions,ig_reels_avg_watch_time)";
// Instagram silently leaves a post out of a /media page when it can't return
// that post's nested insights (seen 2026-09-24: 235 of 236). The plain
// listing is the complete one.
const PLAIN_MEDIA_FIELDS = MEDIA_FIELDS.split(",insights")[0]!;
const COMMENT_FIELDS =
  "id,text,username,like_count,timestamp,replies.limit(25){id,text,username,like_count,timestamp}";
export const GRAPH_MISSING_MSG =
  "Meta Graph is not configured — set META_ACCESS_TOKEN and INSTAGRAM_USER_ID";
export const MINE_CATALOG_CAP = Math.max(1, Math.floor(Number(process.env.INSTAGRAM_MINE_CATALOG_CAP) || 500));

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const optCount = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
};

function parseGraphTime(raw: string): number {
  if (!raw) return 0;
  const iso = raw.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : 0;
}

type GraphCreds = { token: string; userId: string };
const scoped = new AsyncLocalStorage<GraphCreds>();

/** The install's own login (META_ACCESS_TOKEN + INSTAGRAM_USER_ID): the owner's account and the social feed. */
function envCreds(): GraphCreds | null {
  const token = (process.env.META_ACCESS_TOKEN ?? "").trim();
  const userId = (process.env.INSTAGRAM_USER_ID ?? "").trim();
  if (!token || !userId) return null;
  return { token, userId };
}

/** The login every Graph call uses: the account a pull runs for (withGraphCreds), else the install's own. */
export function graphCreds(): GraphCreds | null {
  return scoped.getStore() ?? envCreds();
}

export function graphConfigured(): boolean {
  return graphCreds() !== null;
}

/**
 * The Graph login for an Analyzer account: the connected Meta login for that handle (Settings → Connectors),
 * else the install's login for the account marked Mine. Another user's Mine account never
 * gets the install's login (it would be filled with the token's account).
 */
export function graphCredsFor(account?: { mine?: boolean; owner?: string; username?: string } | null): GraphCreds | null {
  if (!account) return null;
  const own = account.owner && account.username ? instagramLogin(account.owner, account.username) : null;
  if (own) return own;
  if (!account.mine) return null;
  return (account.owner ?? "").toLowerCase() === (env.appSecret ? env.adminUsername : "local") ? envCreds() : null;
}

/** Run a pull with one account's Graph login: every Graph call inside it uses that login. */
export function withGraphCreds<T>(creds: GraphCreds | null, fn: () => Promise<T>): Promise<T> {
  return creds ? scoped.run(creds, fn) : fn();
}

/** Mine-account catalog/profile can use Graph even without an Apify key. */
export function mineUsesGraph(account?: { mine?: boolean; owner?: string; username?: string } | null): boolean {
  return graphCredsFor(account) !== null;
}

export function insightsFromGraph(raw: unknown): CatalogItem["insights"] {
  const data = isRec(raw) && Array.isArray(raw.data) ? raw.data : [];
  const out: NonNullable<CatalogItem["insights"]> = {};
  for (const row of data) {
    if (!isRec(row)) continue;
    const name = str(row.name);
    const values = Array.isArray(row.values) ? row.values[0] : null;
    const value = isRec(values) ? optCount(values.value) : optCount(row.value);
    if (value === undefined) continue;
    if (name === "views" || name === "plays") out.views = value;
    else if (name === "reach") out.reach = value;
    else if (name === "saved") out.saved = value;
    else if (name === "shares") out.shares = value;
    else if (name === "total_interactions") out.interactions = value;
    else if (name === "ig_reels_avg_watch_time") out.avgWatchMs = value;
  }
  return Object.keys(out).length ? out : undefined;
}

export function commentFromGraph(raw: Rec): Comment | null {
  const id = str(raw.id);
  if (!id) return null;
  const from = isRec(raw.from) ? raw.from : null;
  const repliesRaw = isRec(raw.replies) && Array.isArray(raw.replies.data) ? raw.replies.data : [];
  const replies = repliesRaw
    .map((row) => (isRec(row) ? commentFromGraph(row) : null))
    .filter((c): c is Comment => !!c);
  return {
    id,
    text: typeof raw.text === "string" ? raw.text : "",
    createdAt: parseGraphTime(str(raw.timestamp)),
    user: {
      username: str(raw.username) || (from ? str(from.username) : "") || "instagram",
      id: from ? str(from.id) : "",
    },
    likeCount: optCount(raw.like_count) ?? 0,
    replyCount: replies.length,
    replies,
  };
}

export function catalogItemFromGraph(raw: Rec, now = Date.now()): CatalogItem | null {
  const permalink = str(raw.permalink);
  if (!permalink) return null;
  let parsed: ReturnType<typeof parseInstagramUrl>;
  try {
    parsed = parseInstagramUrl(permalink);
  } catch {
    return null;
  }
  if (parsed.kind !== "post") return null;
  const mediaType = str(raw.media_type).toUpperCase();
  const product = str(raw.media_product_type).toUpperCase();
  const isCarousel = mediaType === "CAROUSEL_ALBUM";
  const isReel = !isCarousel && (product === "REELS" || parsed.reelHint);
  const caption = str(raw.caption);
  const takenAt = parseGraphTime(str(raw.timestamp));
  const insights = insightsFromGraph(raw.insights);
  const shared = raw.is_shared_to_feed;
  return {
    shortcode: parsed.shortcode,
    url: parsed.canonical,
    kind: isCarousel ? "carousel" : isReel ? "reel" : "post",
    takenAt,
    thumbnailUrl: str(raw.thumbnail_url) || str(raw.media_url) || undefined,
    captionPreview: caption ? caption.slice(0, 180) : undefined,
    caption: caption || undefined,
    graphId: str(raw.id) || undefined,
    graph: {
      mediaType: str(raw.media_type) || undefined,
      productType: str(raw.media_product_type) || undefined,
      permalink,
      mediaUrl: str(raw.media_url) || undefined,
      thumbnailUrl: str(raw.thumbnail_url) || undefined,
      seenAt: now,
      insightsAt: insights ? now : undefined,
    },
    isSharedToFeed: typeof shared === "boolean" ? shared : undefined,
    insights,
    counts: {
      likes: optCount(raw.like_count),
      comments: optCount(raw.comments_count),
      plays: insights?.views,
    },
  };
}

type VisibilityInput = Pick<CatalogItem, "kind" | "isSharedToFeed">;

/**
 * Trial or public from the official login only: a reel's is_shared_to_feed, and every other kind is public. Nothing
 * else (no read of Instagram's web pages): a reel without the flag stays unknown. Returns the evidence it used too.
 */
export function classifyVisibilityWithBasis(item: VisibilityInput): { visibility?: CatalogVisibility; basis?: VisibilityBasis } {
  if (item.isSharedToFeed === true) return { visibility: "public", basis: "shared_to_feed" };
  if (item.isSharedToFeed === false) return { visibility: "trial", basis: "not_shared_to_feed" };
  if (item.kind !== "reel") return { visibility: "public", basis: "kind" };
  return {};
}

export const classifyVisibility = (item: VisibilityInput): CatalogVisibility | undefined => classifyVisibilityWithBasis(item).visibility;

export function applyMineVisibility(items: CatalogItem[], shared: Map<string, boolean>): CatalogItem[] {
  return items.map((item) => {
    const isSharedToFeed = item.graphId && shared.has(item.graphId) ? shared.get(item.graphId) : item.isSharedToFeed;
    const next = { ...item, isSharedToFeed };
    const { visibility, basis } = classifyVisibilityWithBasis(next);
    return { ...next, visibility, visibilityBasis: basis };
  });
}

export function profileFromGraph(raw: Rec): ProfileInfo | null {
  const username = str(raw.username);
  const id = str(raw.id);
  if (!username || !id) return null;
  return {
    igUserId: id,
    username,
    fullName: str(raw.name) || undefined,
    biography: str(raw.biography) || undefined,
    profilePic: str(raw.profile_picture_url) || undefined,
    followers: optCount(raw.followers_count),
    following: optCount(raw.follows_count),
    posts: optCount(raw.media_count),
  };
}

export async function fetchMineProfile(opts: {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
} = {}): Promise<ProfileInfo> {
  const creds = requireCreds();
  const raw = await graphGet(creds.userId, { fields: PROFILE_FIELDS }, opts);
  const info = isRec(raw) ? profileFromGraph(raw) : null;
  if (!info) throw new InstagramError("Graph returned no profile for this account", "GRAPH", false);
  return info;
}

export async function fetchMineCatalog(opts: {
  cap: number;
  after?: string;
  since?: number;
  fields?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<CatalogPage> {
  const creds = requireCreds();
  const cap = Math.max(1, Math.min(MINE_CATALOG_CAP, opts.cap));
  const since = opts.since && opts.since > 0 ? opts.since : undefined;
  const items: CatalogItem[] = [];
  let after = opts.after?.trim() || undefined;
  let more = false;
  let nextMaxId: string | undefined;
  while (items.length < cap) {
    const limit = Math.min(100, cap - items.length);
    const params: Record<string, string> = {
      fields: opts.fields ?? MEDIA_FIELDS,
      limit: String(limit),
    };
    if (after) params.after = after;
    let page: unknown;
    try {
      page = await graphGet(`${creds.userId}/media`, params, opts);
    } catch (e) {
      if (e instanceof InstagramError && e.code === "GRAPH" && params.fields.includes("insights.")) {
        page = await graphGet(`${creds.userId}/media`, { ...params, fields: PLAIN_MEDIA_FIELDS }, opts);
      } else {
        throw e;
      }
    }
    const data = isRec(page) && Array.isArray(page.data) ? page.data : [];
    const batch: CatalogItem[] = [];
    for (const row of data) {
      if (!isRec(row)) continue;
      const item = catalogItemFromGraph(row);
      if (item) {
        items.push(item);
        batch.push(item);
      }
    }
    const paging = isRec(page) && isRec(page.paging) ? page.paging : null;
    const cursors = paging && isRec(paging.cursors) ? paging.cursors : null;
    const cursor = cursors ? str(cursors.after) : "";
    const hasNext = Boolean(paging && str(paging.next));
    if (since && batch.some((row) => row.takenAt > 0 && row.takenAt < since)) {
      more = false;
      nextMaxId = undefined;
      break;
    }
    if (!hasNext || !cursor || data.length === 0) {
      more = false;
      nextMaxId = undefined;
      break;
    }
    after = cursor;
    nextMaxId = cursor;
    more = true;
  }
  return { items, nextMaxId, more };
}

/**
 * Every Graph media item, paging until Instagram says there is no next page
 * (or `since`). A second, plain listing adds any post the insights listing
 * dropped; its insights are fetched separately later.
 */
export async function fetchMineCatalogAll(
  opts: { since?: number; signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<CatalogPage> {
  const page = await fetchMineCatalog({ ...opts, cap: MINE_CATALOG_CAP });
  if (page.more) return page;
  const plain = await fetchMineCatalog({ ...opts, cap: MINE_CATALOG_CAP, fields: PLAIN_MEDIA_FIELDS });
  const seen = new Set(page.items.map((item) => item.graphId));
  const missing = plain.items.filter((item) => item.graphId && !seen.has(item.graphId));
  if (!missing.length) return page;
  const items = [...page.items, ...missing].sort((a, b) => b.takenAt - a.takenAt);
  return { ...page, items };
}

export async function fetchMineSharedToFeed(
  graphIds: string[],
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  const ids = [...new Set(graphIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    try {
      const rows = await graphBatch(
        chunk.map((id) => ({ method: "GET", relative_url: `${id}?fields=id,is_shared_to_feed` })),
        opts,
      );
      for (const row of rows) {
        const id = str(row.id);
        if (id && typeof row.is_shared_to_feed === "boolean") out.set(id, row.is_shared_to_feed);
      }
    } catch {
      /* keep going — classify still has nested/shared flags on some rows */
    }
  }
  return out;
}

export async function fetchMineInsights(
  graphIds: string[],
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<Map<string, NonNullable<CatalogItem["insights"]>>> {
  const out = new Map<string, NonNullable<CatalogItem["insights"]>>();
  const ids = [...new Set(graphIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    try {
      const rows = await graphBatch(
        chunk.map((id) => ({
          method: "GET",
          relative_url: `${id}/insights?metric=views,reach,saved,shares,total_interactions&period=lifetime`,
        })),
        opts,
      );
      chunk.forEach((id, index) => {
        const insights = insightsFromGraph(rows[index]);
        if (insights) out.set(id, insights);
      });
    } catch {
      /* nested insights on /media already tried */
    }
  }
  return out;
}

export async function fetchMineComments(
  graphIds: string[],
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<Map<string, Comment[]>> {
  const out = new Map<string, Comment[]>();
  const ids = [...new Set(graphIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    try {
      const rows = await graphBatch(
        chunk.map((id) => ({
          method: "GET",
          relative_url: `${id}/comments?fields=${encodeURIComponent(COMMENT_FIELDS)}&limit=50`,
        })),
        opts,
      );
      chunk.forEach((id, index) => {
        const row = rows[index];
        const data = row && Array.isArray(row.data) ? row.data : [];
        const comments = data
          .map((c) => (isRec(c) ? commentFromGraph(c) : null))
          .filter((c): c is Comment => !!c);
        if (comments.length) out.set(id, comments);
      });
    } catch {
      /* catalog still useful without this chunk of threads */
    }
  }
  return out;
}

/** Meta allows at most 30 days between since and until on account insights. */
const INSIGHT_WINDOW_DAYS = 30;

/**
 * Daily reach / follower_count values labelled with the day they cover
 * (Meta's end_time is the end of that day). A value whose end_time is after
 * `fetchedAt` belongs to a day that isn't over yet and is left out.
 */
export function insightDays(raw: unknown, fetchedAt: number): InsightDay[] {
  const rows: InsightDay[] = [];
  const data = isRec(raw) && Array.isArray(raw.data) ? raw.data : [];
  for (const metric of data) {
    if (!isRec(metric)) continue;
    const name = str(metric.name);
    if (name !== "reach" && name !== "follower_count") continue;
    const values = Array.isArray(metric.values) ? metric.values : [];
    for (const val of values) {
      if (!isRec(val)) continue;
      const endTime = parseGraphTime(str(val.end_time));
      if (!endTime || endTime > fetchedAt) continue;
      const n = optCount(val.value);
      if (n === undefined) continue;
      const row: InsightDay = { date: insightDayCovered(endTime), endTime };
      if (name === "reach") row.reach = n;
      else row.newFollows = n;
      rows.push(row);
    }
  }
  return mergeInsightDays([], rows);
}

const permanentGraphError = (e: unknown): boolean =>
  e instanceof InstagramError && e.code === "GRAPH" && !e.retryable;

/**
 * Complete days of reach and new follows (Graph follower_count, period=day)
 * between two times, fetched newest first in 30-day windows. The newest
 * window must work (else this throws: token, limits, network). Older
 * windows stop at the first one Meta refuses (older than it keeps);
 * `complete` is false when a rate limit or network error cut the run short.
 * follower_count may reach back less far than reach, so once Meta refuses
 * it the rest is fetched with reach alone.
 */
export async function fetchMineDailyInsights(
  sinceMs: number,
  untilMs: number,
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch; now?: number } = {},
): Promise<{ days: InsightDay[]; complete: boolean }> {
  const creds = requireCreds();
  const fetchedAt = opts.now ?? Date.now();
  const since = Math.floor(sinceMs / 1000);
  let until = Math.floor(Math.min(untilMs, fetchedAt) / 1000);
  let metric = "reach,follower_count";
  const rows: InsightDay[] = [];
  let windows = 0;
  let complete = true;
  while (until > since) {
    const from = Math.max(since, until - INSIGHT_WINDOW_DAYS * 86_400);
    const params = { period: "day", since: String(from), until: String(until) };
    try {
      let raw: unknown;
      try {
        raw = await graphGet(`${creds.userId}/insights`, { metric, ...params }, opts);
      } catch (e) {
        if (metric === "reach" || !permanentGraphError(e)) throw e;
        metric = "reach";
        raw = await graphGet(`${creds.userId}/insights`, { metric, ...params }, opts);
      }
      rows.push(...insightDays(raw, fetchedAt));
    } catch (e) {
      if (!windows) throw e;
      if (!permanentGraphError(e)) complete = false;
      break;
    }
    windows++;
    until = from;
  }
  return { days: mergeInsightDays([], rows), complete };
}

function totalMetric(raw: unknown, name: string): number | undefined {
  const data = isRec(raw) && Array.isArray(raw.data) ? raw.data : [];
  for (const metric of data) {
    if (!isRec(metric) || str(metric.name) !== name) continue;
    const tv = isRec(metric.total_value) ? metric.total_value : null;
    const fromTotal = tv ? optCount(tv.value) : undefined;
    if (fromTotal !== undefined) return fromTotal;
    const values = Array.isArray(metric.values) ? metric.values : [];
    let sum = 0;
    let any = false;
    for (const val of values) {
      if (!isRec(val)) continue;
      const n = optCount(val.value);
      if (n === undefined) continue;
      sum += n;
      any = true;
    }
    if (any) return sum;
  }
  return undefined;
}

function demographicRows(raw: unknown): Array<{ label: string; value: number }> {
  const out: Array<{ label: string; value: number }> = [];
  const data = isRec(raw) && Array.isArray(raw.data) ? raw.data : [];
  for (const metric of data) {
    if (!isRec(metric)) continue;
    const tv = isRec(metric.total_value) ? metric.total_value : null;
    const breakdowns = tv && Array.isArray(tv.breakdowns) ? tv.breakdowns : [];
    for (const bd of breakdowns) {
      if (!isRec(bd) || !Array.isArray(bd.results)) continue;
      for (const row of bd.results) {
        if (!isRec(row)) continue;
        const dims = Array.isArray(row.dimension_values) ? row.dimension_values : [];
        const label = str(dims[0]) || "unknown";
        const value = optCount(row.value) ?? 0;
        out.push({ label, value });
      }
    }
  }
  return out.sort((a, b) => b.value - a.value).slice(0, 8);
}

/** Account totals for the same 30 days, kept by Graph metric name (`reach` here = unique accounts). */
export const MINE_TOTALS = [
  "views",
  "reach",
  "total_interactions",
  "likes",
  "comments",
  "shares",
  "saves",
  "replies",
  "profile_links_taps",
] as const;

/**
 * Account-level Graph insights: the last 30 complete days of reach / new
 * follows, totals for the same days, and reached-audience demographics.
 */
export async function fetchMineAccountStats(
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch; now?: number } = {},
): Promise<MineAccountStats> {
  const creds = requireCreds();
  const now = opts.now ?? Date.now();
  const out: MineAccountStats = { fetchedAt: now, days: [] };
  try {
    out.days = (await fetchMineDailyInsights(now - INSIGHT_WINDOW_DAYS * DAY_MS, now, { ...opts, now })).days;
    const reach = out.days.reduce((n, d) => n + (d.reach ?? 0), 0);
    if (reach) out.reach30d = reach;
  } catch {
    /* post catalog still useful */
  }
  // the totals cover the same complete days: the 30 days up to the end of the last one
  const until = Math.floor((out.days.at(-1)?.endTime ?? now) / 1000);
  const range = { since: String(until - INSIGHT_WINDOW_DAYS * 86_400), until: String(until) };
  try {
    const totals = await graphGet(
      `${creds.userId}/insights`,
      {
        metric: "profile_views,accounts_engaged,website_clicks",
        metric_type: "total_value",
        period: "day",
        ...range,
      },
      opts,
    );
    out.profileViews = totalMetric(totals, "profile_views");
    out.accountsEngaged = totalMetric(totals, "accounts_engaged");
    out.websiteClicks = totalMetric(totals, "website_clicks");
  } catch {
    /* optional totals */
  }
  // one batch item per metric, so a metric Meta refuses costs only itself
  const q = (extra: string) =>
    `${creds.userId}/insights?metric_type=total_value&period=day&since=${range.since}&until=${range.until}&${extra}`;
  try {
    const rows = await graphBatch(
      [
        ...MINE_TOTALS.map((m) => ({ method: "GET", relative_url: q(`metric=${m}`) })),
        { method: "GET", relative_url: q("metric=views&breakdown=follow_type") },
        { method: "GET", relative_url: q("metric=views&breakdown=media_product_type") },
      ],
      opts,
    );
    const totals: Record<string, number> = {};
    MINE_TOTALS.forEach((m, i) => {
      const n = totalMetric(rows[i], m);
      if (n !== undefined) totals[m] = n;
    });
    if (Object.keys(totals).length) out.totals = totals;
    const byFollower = demographicRows(rows[MINE_TOTALS.length]);
    const bySurface = demographicRows(rows[MINE_TOTALS.length + 1]);
    if (byFollower.length) out.viewsByFollower = byFollower;
    if (bySurface.length) out.viewsBySurface = bySurface;
  } catch {
    /* optional totals */
  }
  const demo = async (breakdown: string) => {
    try {
      return demographicRows(
        await graphGet(
          `${creds.userId}/insights`,
          {
            // Graph takes no since/until here; this_month replaced last_30_days in v20
            metric: "reached_audience_demographics",
            period: "lifetime",
            timeframe: "this_month",
            metric_type: "total_value",
            breakdown,
          },
          opts,
        ),
      );
    } catch {
      return [];
    }
  };
  const [countries, ages, genders] = await Promise.all([demo("country"), demo("age"), demo("gender")]);
  if (countries.length) out.countries = countries;
  if (ages.length) out.ages = ages;
  if (genders.length) out.genders = genders;
  return out;
}

function requireCreds(): { token: string; userId: string } {
  const creds = graphCreds();
  if (!creds) throw new InstagramError(GRAPH_MISSING_MSG, "GRAPH", false);
  return creds;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function graphGet(
  path: string,
  params: Record<string, string>,
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch },
): Promise<unknown> {
  const creds = requireCreds();
  const url = new URL(`${BASE}/${path.replace(/^\//, "")}`);
  url.searchParams.set("access_token", creds.token);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return readGraphResponse(await graphFetch(url, opts));
}

async function graphBatch(
  batch: Array<{ method: string; relative_url: string }>,
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch },
): Promise<Rec[]> {
  const creds = requireCreds();
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(BASE, {
      method: "POST",
      body: new URLSearchParams({ access_token: creds.token, batch: JSON.stringify(batch) }),
      signal: requestSignal(opts.signal),
    });
  } catch (e) {
    if (opts.signal?.aborted) throw new InstagramError("Cancelled", "CANCELLED", false);
    throw new InstagramError(
      `Graph request failed: ${e instanceof Error ? e.message : String(e)}`,
      "FAILED",
      true,
    );
  }
  const raw = await res.text().catch(() => "");
  if (!res.ok) throw new InstagramError(graphErrorMessage(raw, res.status), "GRAPH", res.status >= 500);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new InstagramError("Graph returned a non-JSON response", "GRAPH", true);
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((row) => {
    if (!isRec(row)) return {};
    try {
      const body = typeof row.body === "string" ? (JSON.parse(row.body) as unknown) : row.body;
      return isRec(body) ? body : {};
    } catch {
      return {};
    }
  });
}

async function graphFetch(url: URL, opts: { signal?: AbortSignal; fetchImpl?: typeof fetch }): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    return await fetchImpl(url, { signal: requestSignal(opts.signal) });
  } catch (e) {
    if (opts.signal?.aborted) throw new InstagramError("Cancelled", "CANCELLED", false);
    throw new InstagramError(
      `Graph request failed: ${e instanceof Error ? e.message : String(e)}`,
      "FAILED",
      true,
    );
  }
}

async function readGraphResponse(res: Response): Promise<unknown> {
  const body = await res.text().catch(() => "");
  if (res.status === 429) {
    throw new InstagramError(
      "Meta is rate limiting Graph — try again in a few minutes",
      "RATE_LIMIT",
      true,
    );
  }
  if (!res.ok) {
    throw new InstagramError(graphErrorMessage(body, res.status), "GRAPH", res.status >= 500);
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new InstagramError("Graph returned a non-JSON response", "GRAPH", true);
  }
}

function graphErrorMessage(body: string, status: number): string {
  try {
    const j = JSON.parse(body) as { error?: { message?: unknown; code?: unknown } };
    const msg = str(j?.error?.message);
    const code = j?.error?.code;
    if (code === 190 || /session has expired|invalid oauth/i.test(msg)) {
      return "Meta token is invalid or expired — refresh META_ACCESS_TOKEN";
    }
    if (msg) return msg;
  } catch {
    /* fall through */
  }
  return `Graph request failed (HTTP ${status})`;
}
