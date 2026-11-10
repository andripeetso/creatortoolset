/**
 * Client side of Content Analyzer (api/instagram.ts). Paste posts or
 * accounts; jobs (stats, media, tags, …) run now or later.
 */
import {
  fmtCount,
  fmtMmSs,
  kindLabel,
  postToMarkdown,
  timedTranscriptText,
  transcriptParagraphs,
  type TranscriptWord,
} from "./instagram-markdown";
import { appendProjectId, projectBody } from "./workspace";

export { fmtCount, fmtMmSs, kindLabel, postToMarkdown, timedTranscriptText, transcriptParagraphs };
export type { TranscriptWord };

// The unions live on the server (api/lib/instagram/types.ts); the client only imports their types.
import type {
  AccountJobType,
  CommentsStatus,
  IdeaStatus,
  JobStatus,
  JobType,
  PartStatus,
  PostKind,
  PostStatus,
  PostStep,
  RecipePreset,
  RunWhen,
  SavedFor,
  TagKind,
} from "../../api/lib/instagram/types";
export type {
  AccountJobType,
  CommentsStatus,
  IdeaStatus,
  JobStatus,
  JobType,
  PartStatus,
  PostKind,
  PostStatus,
  PostStep,
  RecipePreset,
  RunWhen,
  SavedFor,
  TagKind,
};

export const JOB_TYPES: JobType[] = [
  "info",
  "stats",
  "media",
  "transcript",
  "vision",
  "comments",
  "tags",
  "idea",
];

export const JOB_LABELS: Record<JobType, string> = {
  info: "Info",
  stats: "Stats",
  media: "Media",
  transcript: "Transcript",
  vision: "On-screen text",
  comments: "Comments",
  tags: "Tags",
  idea: "Idea",
};

/** Media is always pulled: every recipe starts from info + stats + media. */
const PRESET_JOBS: Record<Exclude<RecipePreset, "custom">, JobType[]> = {
  stats: ["info", "stats", "media"],
  watch: ["info", "stats", "media", "transcript", "vision"],
  full: ["info", "stats", "media", "transcript", "vision", "comments", "tags", "idea"],
};

/**
 * What the UI shows as one switch. Transcript (video audio) and slide
 * text (vision over frames/images) are one "read it" action for the
 * user; info and media are always on.
 */
export interface JobGroup {
  id: "info" | "stats" | "media" | "read" | "comments" | "tags" | "idea";
  label: string;
  hint: string;
  types: JobType[];
  locked?: boolean;
}

export const JOB_GROUPS: JobGroup[] = [
  { id: "info", label: "Info", hint: "Caption, creator, date", types: ["info"], locked: true },
  { id: "stats", label: "Stats", hint: "Plays, likes, comments + a snapshot", types: ["stats"] },
  { id: "media", label: "Media", hint: "Every slide downloaded", types: ["media"], locked: true },
  {
    id: "read",
    label: "Transcript & on-screen text",
    hint: "Speech to text for videos, on-screen text for every slide",
    types: ["transcript", "vision"],
  },
  { id: "comments", label: "Comments", hint: "Public comments with replies", types: ["comments"] },
  { id: "tags", label: "Tags", hint: "AI topic / format / hook tags", types: ["tags"] },
  {
    id: "idea",
    label: "Idea",
    hint: "Grand idea plus a takeaway one-liner",
    types: ["idea"],
  },
];

const STATUS_RANK: JobStatus[] = ["running", "error", "pending", "done", "skipped", "idle"];

/** One status for a group of job records: running wins, then error, pending, done. */
export function groupStatus(jobs: JobRecord[] | undefined, types: JobType[]): JobStatus {
  const seen: JobStatus[] = types
    .map((t) => jobs?.find((j) => j.type === t)?.status ?? "idle")
    .filter((st) => st !== "idle");
  if (!seen.length) return "idle";
  for (const st of STATUS_RANK) if (seen.includes(st)) return st;
  return "idle";
}

export function groupError(jobs: JobRecord[] | undefined, types: JobType[]): string | undefined {
  for (const t of types) {
    const err = jobs?.find((j) => j.type === t)?.error;
    if (err) return err;
  }
  return undefined;
}

export const isGroupOn = (jobs: JobType[], group: JobGroup) =>
  group.types.every((t) => jobs.includes(t));

/** Instagram's auto alt text ("Photo by X on August 25, 2026.") says nothing. */
const AUTO_ALT = /^(photo|video|image) (by|shared by) .+ on [a-z]+ \d{1,2}, \d{4}\.?$/i;

export function usefulAltText(s: { accessibilityCaption?: string }): string | undefined {
  const alt = s.accessibilityCaption?.trim();
  if (!alt || AUTO_ALT.test(alt)) return undefined;
  return alt;
}

const JOB_DEPS: Record<JobType, JobType[]> = {
  info: [],
  stats: ["info"],
  media: ["info"],
  transcript: ["info", "media"],
  vision: ["info", "media"],
  comments: ["info"],
  tags: ["info"],
  idea: ["info"],
};

export interface Recipe {
  preset: RecipePreset;
  jobs: JobType[];
}

export interface JobRecord {
  type: JobType;
  status: JobStatus;
  error?: string;
}

export interface Tag {
  id: string;
  label: string;
  kind: TagKind;
  source: "ai" | "user";
  confidence?: number;
}

export interface PostIdea {
  title: string;
  takeaway: string;
}

export interface LibraryIdea {
  id: string;
  title: string;
  description: string;
  postIds: string[];
}

export interface IdeaBoard {
  generatedAt: number;
  ideas: LibraryIdea[];
  /** Made by Claude on the paired Mac: measured tokens and API-equivalent cost. */
  usage?: { tokens: number; costUsd: number };
}

export interface Snapshot {
  at: number;
  source: "apify" | "session" | "graph";
  likes?: number;
  comments?: number;
  plays?: number;
  followers?: number;
  following?: number;
  posts?: number;
}

export interface SnapshotDiff {
  elapsedMs: number;
  likes?: number;
  comments?: number;
  plays?: number;
  followers?: number;
}

export type CatalogVisibility = "public" | "trial";

export interface CatalogItem {
  shortcode: string;
  url: string;
  kind: PostKind;
  takenAt: number;
  thumbnailUrl?: string;
  captionPreview?: string;
  caption?: string;
  graphId?: string;
  visibility?: CatalogVisibility;
  isSharedToFeed?: boolean;
  insights?: {
    reach?: number;
    saved?: number;
    shares?: number;
    views?: number;
    interactions?: number;
    avgWatchMs?: number;
  };
  counts: { likes?: number; comments?: number; plays?: number };
  prevCounts?: { likes?: number; comments?: number; plays?: number };
  starred?: boolean;
  postId?: string;
  ideaStatus?: IdeaStatus;
  rank?: number;
}

export interface InstagramAccount {
  id: string;
  igUserId: string;
  username: string;
  fullName?: string;
  biography?: string;
  profilePic?: string;
  isPrivate?: boolean;
  isVerified?: boolean;
  counts: {
    followers?: number;
    following?: number;
    posts?: number;
    fetchedAt: number;
  };
  lastCatalogAt?: number;
  catalogNewestAt?: number;
  catalogCursor?: string;
  catalogHasMore?: boolean;
  avatarUrl?: string;
  /** Posts from this account that are in the library (list endpoint only). */
  libraryCount?: number;
  owner: string;
  tags: Tag[];
  notes?: string;
  status: PostStatus;
  step?: string;
  progress: number;
  error?: string;
  jobs?: { type: AccountJobType; status: JobStatus; error?: string }[];
  createdAt: number;
  updatedAt: number;
  catalogCount?: number;
  catalog?: CatalogItem[];
  posts?: InstagramPost[];
  snapshots?: Snapshot[];
  insights?: AccountInsights;
  /** This is the Toolset user's own Instagram. */
  mine?: boolean;
}

export interface AccountInsights {
  cadence: {
    accountId: string;
    username: string;
    count: number;
    medianGapDays?: number;
    postsPerWeek?: number;
    lastPostedAt?: number;
  };
  mix: { reels: number; carousels: number; posts: number };
  byKind: Array<{ kind: PostKind; count: number; avgPlays?: number }>;
  medianPlays?: number;
  split?: {
    public: VisibilityRollup;
    trial: VisibilityRollup;
  };
  graph?: {
    fetchedAt: number;
    /** Complete Pacific days, labelled with the day each value covers. */
    days?: Array<{ date: string; endTime?: number; reach?: number; newFollows?: number }>;
    reach30d?: number;
    profileViews?: number;
    accountsEngaged?: number;
    websiteClicks?: number;
    /** Same 30 days by Graph metric name: views, reach (unique), total_interactions, likes… */
    totals?: Record<string, number>;
    viewsByFollower?: Array<{ label: string; value: number }>;
    viewsBySurface?: Array<{ label: string; value: number }>;
    countries?: Array<{ label: string; value: number }>;
    ages?: Array<{ label: string; value: number }>;
    genders?: Array<{ label: string; value: number }>;
  };
  /** Every day of reach / new follows read so far (graph-daily.json), oldest first. */
  history?: Array<{ date: string; reach?: number; newFollows?: number }>;
  duplicates: DupCluster[];
  /** Jev's labels joined with views; null without a TypeSafe key. */
  whatWorks?: WhatWorks | null;
}

export interface WhatWorksRow {
  label: string;
  posts: number;
  /** Median views of these posts ÷ median views of comparable posts. */
  lift: number;
  verdict: "better" | "worse" | "similar" | "too few";
  /** Shortcodes of the best posts with this label. */
  top: string[];
}

export interface WhatWorks {
  hook: WhatWorksRow[];
  format: WhatWorksRow[];
  cta: WhatWorksRow[];
  labelled: number;
}

export interface VisibilityRollup {
  count: number;
  views?: number;
  reach?: number;
  saved?: number;
  shares?: number;
  medianPlays?: number;
}

export interface DupCluster {
  kind: "repost" | "variation";
  score: number;
  members: Array<{ shortcode: string; captionPreview?: string; postId?: string }>;
  libraryHits: Array<{
    postId: string;
    username: string;
    shortcode: string;
    score: number;
    kind: "repost" | "variation";
  }>;
}

export interface InstagramStack {
  id: string;
  title: string;
  owner: string;
  createdAt: number;
  updatedAt: number;
  postIds: string[];
  count: number;
  avgRank?: number;
  avgVirality: number;
  done: number;
  ideaStatus?: IdeaStatus;
}

export interface QueueEntry {
  kind: "post" | "account";
  id: string;
  label: string;
  detail: string;
  state: "running" | "queued" | "failed";
  step?: string;
  progress: number;
  /** Jobs asked for while it was running; they start right after. */
  next?: string[];
  /** Failed items only. */
  error?: string;
  jobs?: string[];
  at?: number;
}

export interface QueueView {
  running: number;
  max: number;
  items: QueueEntry[];
}

export const getQueue = () => fetch("/api/instagram/queue").then((r) => json<QueueView>(r));

export interface SimilarHit {
  post: InstagramPost;
  score: number;
  /** Why it is listed: the same media, or text close enough to be the same script. */
  reason?: "media" | "text";
}

export interface InstagramAnalysis {
  hooks: Array<{
    hook: string;
    count: number;
    postIds: string[];
    avgRank?: number;
    avgVirality: number;
  }>;
  velocity: Array<{
    id: string;
    username: string;
    caption: string;
    playsPerDay: number;
    elapsedMs: number;
    firstPlays?: number;
    lastPlays?: number;
  }>;
  cadence: Array<{
    accountId: string;
    username: string;
    count: number;
    medianGapDays?: number;
    postsPerWeek?: number;
    lastPostedAt?: number;
  }>;
  mix: Array<{
    accountId: string;
    username: string;
    reels: number;
    carousels: number;
    posts: number;
    byKind: Array<{ kind: PostKind; count: number; avgPlays?: number }>;
    medianPlays?: number;
    postsPerWeek?: number;
    medianGapDays?: number;
  }>;
  duplicates: Array<
    DupCluster & {
      accountId: string;
      username: string;
    }
  >;
  commentThemes: Array<{ label: string; count: number }>;
  /** Comments per kind, from Jev (empty when comments weren't scored). */
  commentKinds?: Record<string, number>;
  /** Most-liked questions worth answering, across the library. */
  topQuestions?: Array<{ postId: string; text: string; likes: number }>;
}

export const IDEA_STATUSES: { id: IdeaStatus; label: string }[] = [
  { id: "inbox", label: "Inbox" },
  { id: "idea", label: "In Project" },
  { id: "done", label: "Done" },
  { id: "skip", label: "Skip" },
];

export function ideaStatusOf(status: IdeaStatus | undefined): IdeaStatus {
  return status ?? "inbox";
}

export const SAVED_FOR: { id: SavedFor; label: string; hint: string }[] = [
  { id: "content", label: "Content", hint: "You might remake this idea" },
  { id: "format", label: "Format", hint: "You're keeping the layout, not the topic" },
];

/** The third "Kept for" choice. It replaces content / format rather than adding to them. */
export const KNOWHOW = {
  label: "Know-how",
  hint: "Strategy, reference, other: just saved, never indexed, in its own list",
};

export const TAG_KINDS: { id: TagKind; label: string }[] = [
  { id: "format", label: "Format" },
  { id: "topic", label: "Topic" },
  { id: "hook", label: "Hook" },
  { id: "cta", label: "CTA" },
  { id: "audience", label: "Audience" },
  { id: "custom", label: "Tag" },
];

/** Unmarked posts are content. Format is only on when someone set it. */
export function effectiveSavedFor(savedFor: SavedFor[] | undefined): SavedFor[] {
  if (!savedFor?.length) return ["content"];
  return SAVED_FOR.map((s) => s.id).filter((k) => savedFor.includes(k));
}

/** Why a post was kept: the phone Analyzer's filter chips. */
export const SHELVES = [
  { id: "all", label: "All" },
  { id: "content", label: "Content" },
  { id: "format", label: "Format" },
  { id: "knowhow", label: KNOWHOW.label },
] as const;
export type ShelfFilter = (typeof SHELVES)[number]["id"];

/** Know-how replaces Content / Format; an untagged post counts as Content. */
export function onShelf(post: Pick<InstagramPost, "knowhow" | "savedFor">, shelf: ShelfFilter): boolean {
  if (shelf === "all") return true;
  if (shelf === "knowhow") return !!post.knowhow;
  return !post.knowhow && effectiveSavedFor(post.savedFor).includes(shelf);
}

export function toggleSavedFor(current: SavedFor[] | undefined, kind: SavedFor): SavedFor[] {
  const on = new Set(effectiveSavedFor(current));
  if (on.has(kind)) on.delete(kind);
  else on.add(kind);
  const next = SAVED_FOR.map((s) => s.id).filter((k) => on.has(k));
  return next.length ? next : ["content"];
}

export const RANK_STARS = 5;

export function starsFromRank(rank: number | undefined): number {
  if (!rank) return 0;
  return Math.min(RANK_STARS, Math.max(0, Math.round(rank)));
}

export function avgRank(ranks: Array<number | undefined>): number | undefined {
  const nums = ranks.filter((n): n is number => typeof n === "number");
  if (!nums.length) return undefined;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10;
}

export function keysInRange<T>(items: T[], from: T | undefined, to: T): T[] {
  const j = items.indexOf(to);
  if (j < 0) return [to];
  const i = from === undefined ? -1 : items.indexOf(from);
  if (i < 0) return [to];
  const a = Math.min(i, j);
  const b = Math.max(i, j);
  return items.slice(a, b + 1);
}

export function accountPathFor(
  base: string,
  post: { accountId?: string; creator: { username: string } },
  accounts: Array<{ id: string; username: string }>,
): string | undefined {
  if (post.accountId) return `${base}/accounts/${post.accountId}`;
  const handle = post.creator.username?.toLowerCase();
  if (!handle) return undefined;
  const hit = accounts.find((a) => a.username.toLowerCase() === handle);
  return hit ? `${base}/accounts/${hit.id}` : undefined;
}

/** An account you pulled (profile or catalog), not one made by saving a single post of theirs. */
export function isReferenceAccount(a: { mine?: boolean; counts: { fetchedAt: number }; lastCatalogAt?: number }): boolean {
  return !!a.mine || a.counts.fetchedAt > 0 || !!a.lastCatalogAt;
}

export function mineAccount<T extends { mine?: boolean }>(accounts: T[]): T | undefined {
  return accounts.find((a) => a.mine);
}

export function isOwnPost(
  post: { accountId?: string; creator: { username?: string } },
  account?: { id: string; username: string } | null,
): boolean {
  if (!account) return false;
  if (post.accountId && post.accountId === account.id) return true;
  const handle = post.creator.username?.toLowerCase();
  return Boolean(handle && handle === account.username.toLowerCase());
}

export function virality(post: InstagramPost): number {
  if (post.counts.plays !== undefined) return post.counts.plays;
  return post.counts.likes ?? 0;
}

export const DEFAULT_CATALOG_COUNT = 12;

export function clampCatalogCount(raw: unknown, fallback = DEFAULT_CATALOG_COUNT): number {
  if (raw === null || raw === undefined || raw === "") return fallback;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(200, Math.round(n)));
}

export type CatalogSort = "posted" | "plays" | "likes" | "comments";

export function sortCatalogItems(rows: CatalogItem[], sort: CatalogSort): CatalogItem[] {
  const val = (row: CatalogItem): number | undefined => {
    if (sort === "plays") return row.counts.plays;
    if (sort === "likes") return row.counts.likes;
    if (sort === "comments") return row.counts.comments;
    return row.takenAt || undefined;
  };
  return [...rows].sort((a, b) => {
    const av = val(a);
    const bv = val(b);
    if (av === undefined && bv === undefined) return 0;
    if (av === undefined) return 1;
    if (bv === undefined) return -1;
    return bv - av;
  });
}

/** A listed post's views: Graph's lifetime views, else the public play count. */
export const rowViews = (row: CatalogItem): number | undefined => row.insights?.views ?? row.counts.plays;

export interface CatalogTotals {
  posts: number;
  views: number;
  likes: number;
  comments: number;
  saves: number;
  shares: number;
  top?: CatalogItem;
}

/** Everything the listed posts add up to, and the most viewed one. */
export function catalogTotals(rows: CatalogItem[]): CatalogTotals {
  const t: CatalogTotals = { posts: rows.length, views: 0, likes: 0, comments: 0, saves: 0, shares: 0 };
  for (const r of rows) {
    const v = rowViews(r) ?? 0;
    t.views += v;
    t.likes += r.counts.likes ?? 0;
    t.comments += r.counts.comments ?? 0;
    t.saves += r.insights?.saved ?? 0;
    t.shares += r.insights?.shares ?? 0;
    if (v > (t.top ? (rowViews(t.top) ?? 0) : 0)) t.top = r;
  }
  return t;
}

/** Sums [YYYY-MM…, value] pairs per month, oldest first, months in between filled with 0. */
export function monthTotals(
  entries: Array<[string, number | undefined]>,
): Array<{ month: string; value: number }> {
  const sums = new Map<string, number>();
  for (const [key, v] of entries) {
    const month = key.slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) continue; // a bad month would never meet `last`
    sums.set(month, (sums.get(month) ?? 0) + (v ?? 0));
  }
  const months = [...sums.keys()].sort();
  if (!months.length) return [];
  const out: Array<{ month: string; value: number }> = [];
  let [y, m] = months[0].split("-").map(Number);
  const last = months[months.length - 1];
  for (;;) {
    const month = `${y}-${String(m).padStart(2, "0")}`;
    out.push({ month, value: sums.get(month) ?? 0 });
    if (month === last) return out;
    if (++m > 12) [y, m] = [y + 1, 1];
  }
}

export function expandJobs(requested: JobType[]): JobType[] {
  const set = new Set<JobType>(["info", "media"]);
  for (const job of requested) {
    for (const dep of JOB_DEPS[job] ?? []) set.add(dep);
    set.add(job);
  }
  return JOB_TYPES.filter((j) => set.has(j));
}

export function recipeFromPreset(preset: RecipePreset): Recipe {
  if (preset === "custom") return { preset, jobs: [...PRESET_JOBS.stats] };
  return { preset, jobs: [...PRESET_JOBS[preset]] };
}

// every save makes the transcript and the on-screen text
export const DEFAULT_RECIPE = recipeFromPreset("watch");

export function customRecipe(jobs: JobType[]): Recipe {
  return { preset: "custom", jobs: expandJobs(jobs) };
}

export function recipeUsesHeavyJobs(recipe: Recipe): boolean {
  return recipe.jobs.includes("comments");
}

export interface Slide {
  index: number;
  kind: "image" | "video";
  file: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  durationS?: number;
  hasAudio?: boolean;
  thumb?: string;
  accessibilityCaption?: string;
  /** Per-slide caption, when the creator wrote one for this slide. */
  caption?: string;
  fingerprint?: { h: string[]; d?: number };
  transcript: { status: PartStatus; words?: number; error?: string };
  vision: {
    status: PartStatus;
    onScreenText?: string;
    /** none, only subtitles of what is said, or text of its own */
    textKind?: "none" | "captions" | "text";
    description?: string;
    hook?: string;
    frames?: number;
    provider?: string;
    error?: string;
  };
}

export interface InstagramPost {
  id: string;
  owner?: string;
  status: PostStatus;
  step?: PostStep;
  progress: number;
  error?: string;
  warnings?: string[];
  duplicateOf?: string;
  input: string;
  url: string;
  shortcode: string;
  mediaId: string;
  kind: PostKind;
  /** Missing = Instagram. A YouTube post's kind is reel for a Short, post for a video. */
  platform?: "youtube";
  creator: { username: string; fullName?: string; id: string };
  accountId?: string;
  takenAt: number;
  pulledAt?: number;
  ageAtPullMs?: number;
  recipe?: Recipe;
  jobs?: JobRecord[];
  starred?: boolean;
  source?: "paste" | "account-catalog" | "share";
  tags?: Tag[];
  idea?: PostIdea;
  ideaStatus?: IdeaStatus;
  savedFor?: SavedFor[];
  /** Know-how (strategy, reference, other): saved, never indexed, its own list. */
  knowhow?: boolean;
  rank?: number;
  stackId?: string;
  caption: string;
  counts: { likes?: number; comments?: number; plays?: number; fetchedAt: number };
  slides: Slide[];
  comments: {
    status: CommentsStatus;
    count: number;
    replies: number;
    filteredOut?: number;
    /** Real questions the creator could answer (Jev). */
    questions?: number;
    /** One-word replies to a call to action. */
    keywords?: number;
    error?: string;
    fetchedAt?: number;
  };
  bytes: number;
  createdAt: number;
  updatedAt: number;
  hasComments: boolean;
  existing?: boolean;
}

/** Fired after the Apify key changes (Settings → Connectors), so an open Analyzer page re-reads its availability. */
export const INSTAGRAM_CONNECTION_EVENT = "instagram-connection";

export interface ApifyStatus {
  configured: boolean;
  valid: boolean | null;
  checkedAt?: number;
  savedAt?: number;
  savedBy?: string;
  account?: { id: string; username?: string };
  invalidReason?: string;
  source: "file" | "env" | "none";
  /** One actor run at a time. */
  slow?: boolean;
  /** The last four characters of the token (never the token). */
  last4?: string;
}

export interface InstagramAvailability {
  available: boolean;
  allowed: boolean;
  cloud: boolean;
  /** why transcripts are off: the key to add, or the lock */
  cloudWhy?: string;
  ai: boolean;
  /** the user's own Apify key: the only way to read other creators' posts */
  apify: ApifyStatus;
  graph?: { configured: boolean };
  limits: { maxSlideMb: number; maxPostMb: number };
}

/** Catalog/profile for Mine can use Graph even without an Apify key. */
export function accountCatalogReady(
  avail?: InstagramAvailability | null,
  mine?: boolean,
): boolean {
  if (!avail) return false;
  if (mine && avail.graph?.configured) return true;
  return avail.available;
}

export interface InstagramComment {
  id: string;
  text: string;
  createdAt: number;
  user: { username: string; id: string };
  likeCount: number;
  replyCount: number;
  replies: InstagramComment[];
  lowValue?: boolean;
  /** Jev's read of the comment; absent when not scored. */
  judged?: {
    kind: "question" | "pushback" | "story" | "praise" | "keyword" | "other" | "spam";
    /** Probability it's worth reading, 0–1. */
    worth: number;
    /** Probability it's a real question to answer, 0–1. */
    needsAnswer: number;
  };
}

/** A comment counts as a question to answer from this probability (server: QUESTION_MIN). */
export const QUESTION_MIN = 0.6;

/** Most worth reading first; likes break ties. Unscored comments keep their order after. */
export function rankComments(list: InstagramComment[]): InstagramComment[] {
  return list
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const wa = a.c.judged?.worth;
      const wb = b.c.judged?.worth;
      if (wa !== undefined && wb !== undefined && wa !== wb) return wb - wa;
      if (wa !== undefined && wb === undefined) return -1;
      if (wa === undefined && wb !== undefined) return 1;
      return b.c.likeCount - a.c.likeCount || a.i - b.i;
    })
    .map((x) => x.c);
}

export interface CommentsFile {
  status: CommentsStatus;
  fetchedAt: number;
  total?: number;
  cursor?: string;
  error?: string;
  comments: InstagramComment[];
}


export const isProcessing = (p: InstagramPost | null | undefined) =>
  p?.status === "processing";

/** How a post is doing, for the phone list. A saved-for-later post keeps its jobs
 *  pending while it reads "ready"; a finished post can hold a failed job. */
export type PostHealth = "working" | "stuck" | "failed" | "partial" | "waiting" | "done";
/** A run that hasn't written anything for this long has stalled. */
export const STUCK_MS = 15 * 60_000;
export function postHealth(p: Pick<InstagramPost, "status" | "updatedAt" | "jobs">, now = Date.now()): PostHealth {
  if (p.status === "error") return "failed";
  if (p.status === "processing") return now - p.updatedAt > STUCK_MS ? "stuck" : "working";
  if (p.jobs?.some((j) => j.status === "error")) return "partial";
  if (p.jobs?.some((j) => j.status === "pending")) return "waiting";
  return "done";
}
/** Worth running again: everything but a live run and a finished post. */
export const needsRun = (h: PostHealth) => h !== "working" && h !== "done";

export const looksLikeInstagramUrl = (value: string) =>
  /^(https?:\/\/)?((www|m)\.)?instagram\.com\/\S+/i.test(value.trim());

/** A post/reel/share URL inside a share-sheet string (url, text, or caption). */
// Instagram posts and share links, and YouTube videos and Shorts.
const SHARE_IG_URL =
  /(?:https?:\/\/)?(?:(?:www|m)\.)?(?:instagram\.com\/(?:share\/|(?:[A-Za-z0-9_.]+\/)?(?:p|reel|reels|tv)\/)|youtube\.com\/(?:watch\?|shorts\/|live\/|embed\/)|youtu\.be\/)[^\s]+/i;

export function instagramUrlsFromText(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = new RegExp(SHARE_IG_URL.source, "gi");
  for (const m of value.matchAll(re)) {
    let url = m[0].replace(/[),.]+$/g, "");
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    let key = url.toLowerCase();
    try {
      const u = new URL(url);
      // Instagram's shortcode is the path; a YouTube video's id is in the query, so keep the whole link.
      if (/instagram\.com$/i.test(u.hostname.replace(/^(www|m)\./i, ""))) {
        key = `${u.hostname.replace(/^(www|m)\./i, "")}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
      }
    } catch {
      /* keep the raw key */
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

export function instagramUrlFromText(value: string): string | null {
  return instagramUrlsFromText(value)[0] ?? null;
}

/** Title/text/url fields the PWA share target puts on /instagram?… */
export function shareSheetText(search: string): string {
  const params = new URLSearchParams(search);
  return [params.get("url"), params.get("text"), params.get("title")]
    .filter((v): v is string => Boolean(v))
    .join("\n")
    .trim();
}

const RESERVED_PROFILES = new Set([
  "p",
  "reel",
  "reels",
  "tv",
  "share",
  "stories",
  "accounts",
  "explore",
  "direct",
  "legal",
  "about",
  "developer",
  "privacy",
  "emails",
  "lite",
  "android",
  "ios",
  "popular",
  "directory",
]);

/** Profile URLs and @handles in free text (not post/reel/share links). */
export function instagramProfilesFromText(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (user: string) => {
    const key = user.toLowerCase();
    if (RESERVED_PROFILES.has(key) || seen.has(key)) return;
    seen.add(key);
    out.push(`https://www.instagram.com/${user}/`);
  };
  for (const m of value.matchAll(/(?:^|[\s<(])@([A-Za-z0-9._]{1,30})\b/g)) add(m[1]);
  const urlRe =
    /(?:https?:\/\/)?(?:www\.|m\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/?(?:[?#\s]|$)/gi;
  for (const m of value.matchAll(urlRe)) add(m[1]);
  return out;
}

export function analyzerHome(pathname = window.location.pathname): string {
  return pathname.startsWith("/analyzer") ? "/analyzer" : "/instagram";
}

async function json<T>(res: Response): Promise<T> {
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(j?.error || `Request failed (${res.status})`);
  return j as T;
}

const jsonInit = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const getInstagramAvailability = () =>
  fetch("/api/instagram/availability").then((r) => json<InstagramAvailability>(r));

export type ListPostsQuery = {
  q?: string;
  account?: string;
  tag?: string;
  starred?: boolean;
  idea?: IdeaStatus;
  savedFor?: SavedFor;
  /** Default: the library without Know-how. */
  shelf?: "knowhow" | "all";
  stack?: string;
  projectId?: string | null;
  sort?: "pulled" | "posted" | "plays" | "account" | "age" | "rank" | "virality";
};

export const listPosts = (query: string | ListPostsQuery = "") => {
  const params = new URLSearchParams();
  if (typeof query === "string") {
    if (query) params.set("q", query);
    appendProjectId(params);
  } else {
    if (query.q) params.set("q", query.q);
    if (query.account) params.set("account", query.account);
    if (query.tag) params.set("tag", query.tag);
    if (query.starred) params.set("starred", "1");
    if (query.idea) params.set("idea", query.idea);
    if (query.savedFor) params.set("savedFor", query.savedFor);
    if (query.shelf) params.set("shelf", query.shelf);
    if (query.stack) params.set("stack", query.stack);
    appendProjectId(params, query.projectId);
    if (query.sort && query.sort !== "pulled") params.set("sort", query.sort);
  }
  const qs = params.toString();
  return fetch(`/api/instagram${qs ? `?${qs}` : ""}`).then((r) => json<InstagramPost[]>(r));
};

/** Every word of `q` appears in the post's caption, creator or tags (for lists that aren't indexed). */
export function postMatchesText(
  post: Pick<InstagramPost, "caption" | "creator" | "tags">,
  q: string,
): boolean {
  const hay = [post.caption, `@${post.creator.username}`, post.creator.fullName ?? "", ...(post.tags ?? []).map((t) => t.label)]
    .join(" ")
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

export const ingestPosts = (
  urls: string[],
  opts: {
    recipe?: Recipe;
    run?: RunWhen;
    projectId?: string | null;
    /** Why they're kept; applied to new and already-saved posts alike. */
    savedFor?: SavedFor[];
    knowhow?: boolean;
  } = {},
) =>
  fetch(
    "/api/instagram",
    jsonInit({
      urls,
      recipe: opts.recipe,
      run: opts.run,
      ...(opts.knowhow ? { knowhow: true } : opts.savedFor ? { savedFor: opts.savedFor } : {}),
      ...projectBody(opts.projectId),
    }),
  ).then(
    async (r) => {
      const j = (await r.json().catch(() => null)) as {
        error?: string;
        posts?: InstagramPost[];
        errors?: { input: string; error: string }[];
      } | null;
      const posts = Array.isArray(j?.posts) ? j.posts : [];
      const errors = Array.isArray(j?.errors) ? j.errors : [];
      if (!r.ok && !posts.length) {
        throw new Error(j?.error || `Request failed (${r.status})`);
      }
      return { posts, errors };
    },
  );

export const ingestPost = async (url: string) => {
  const { posts, errors } = await ingestPosts([url]);
  if (!posts[0]) throw new Error(errors[0]?.error || "Ingest failed");
  return posts[0];
};

export const getPost = (id: string) =>
  fetch(`/api/instagram/${id}`).then((r) => json<InstagramPost>(r));

export const retryPost = (id: string, force = false) =>
  fetch(`/api/instagram/${id}/retry`, jsonInit({ force })).then((r) =>
    json<InstagramPost>(r),
  );

export const refetchComments = (id: string, more = false) =>
  fetch(`/api/instagram/${id}/comments/refetch`, jsonInit({ more })).then((r) =>
    json<InstagramPost>(r),
  );

export const refreshCounts = (id: string) =>
  fetch(`/api/instagram/${id}/refresh-counts`, { method: "POST" }).then((r) =>
    json<InstagramPost & { diff?: SnapshotDiff; snapshots?: Snapshot[] }>(r),
  );

export const runPostJobs = (
  id: string,
  opts: { types?: JobType[]; recipe?: Recipe; force?: boolean; ignoreDuplicate?: boolean } = {},
) => fetch(`/api/instagram/${id}/jobs`, jsonInit(opts)).then((r) => json<InstagramPost>(r));

export const getIdeaBoard = () => {
  const params = new URLSearchParams();
  appendProjectId(params);
  const qs = params.toString();
  return fetch(`/api/instagram/ideas${qs ? `?${qs}` : ""}`).then((r) => json<IdeaBoard>(r));
};
export const generateIdeaBoard = () =>
  fetch("/api/instagram/ideas", jsonInit(projectBody())).then((r) => json<IdeaBoard>(r));

export const getPostSnapshots = (id: string) =>
  fetch(`/api/instagram/${id}/snapshots`).then((r) =>
    json<{
      snapshots: Snapshot[];
      vsFirst: SnapshotDiff | null;
      vsPrevious: SnapshotDiff | null;
    }>(r),
  );

export const savePostTags = (id: string, tags: Tag[]) =>
  fetch(`/api/instagram/${id}/tags`, jsonInit({ tags }, "PUT")).then((r) =>
    json<InstagramPost>(r),
  );

export const patchPostResearch = (
  id: string,
  patch: {
    ideaStatus?: IdeaStatus;
    rank?: number | null;
    stackId?: string | null;
    savedFor?: SavedFor[];
    knowhow?: boolean;
    idea?: PostIdea | null;
  },
) =>
  fetch(`/api/instagram/${id}/research`, jsonInit(patch, "PATCH")).then((r) =>
    json<InstagramPost>(r),
  );

export const patchPostsResearch = (
  ids: string[],
  patch: {
    ideaStatus?: IdeaStatus;
    rank?: number | null;
    stackId?: string | null;
    savedFor?: SavedFor[];
    knowhow?: boolean;
  },
) =>
  fetch("/api/instagram/research", jsonInit({ ids, ...patch })).then((r) =>
    json<{ posts: InstagramPost[] }>(r),
  );

export const listStacks = () => {
  const params = new URLSearchParams();
  appendProjectId(params);
  const qs = params.toString();
  return fetch(`/api/instagram/stacks${qs ? `?${qs}` : ""}`).then((r) => json<InstagramStack[]>(r));
};

export const createStack = (title: string, postIds: string[]) =>
  fetch("/api/instagram/stacks", jsonInit({ title, postIds })).then((r) =>
    json<InstagramStack>(r),
  );

export const patchStack = (
  id: string,
  patch: { title?: string; add?: string[]; remove?: string[]; ideaStatus?: IdeaStatus },
) =>
  fetch(`/api/instagram/stacks/${id}`, jsonInit(patch, "PATCH")).then((r) =>
    json<InstagramStack | { ok: true; dissolved: true }>(r),
  );

export const searchMeaning = (q: string) => {
  const params = new URLSearchParams({ q });
  appendProjectId(params);
  return fetch(`/api/instagram/similar?${params}`).then((r) => json<SimilarHit[]>(r));
};

export type FindField = "idea" | "slides" | "transcript" | "caption" | "comments";

/** Where a word comes from decides its value: idea, on-screen, speech, then caption. */
export const FIND_FIELD_LABELS: Record<FindField, string> = {
  idea: "idea",
  slides: "on-screen",
  transcript: "transcript",
  caption: "caption",
  comments: "comments",
};

export interface FindMatch {
  /** Stemmed query term. */
  term: string;
  field: FindField;
}

export interface FindHit {
  post: InstagramPost;
  score: number;
  /** Each query term found, with the most valuable field it came from. */
  matches: FindMatch[];
  /** Only the audience said it — the creator's own text never did. */
  commentsOnly: boolean;
}

export interface FindResult {
  hits: FindHit[];
  counts: Record<PostKind, number>;
}

/** Ranked topic search over the library: any term can match, more terms rank higher. */
export const findPosts = (q: string, opts: { kind?: PostKind; limit?: number; account?: string; projectId?: string | null } = {}) => {
  const p = new URLSearchParams({ q });
  if (opts.kind) p.set("kind", opts.kind);
  if (opts.limit) p.set("limit", String(opts.limit));
  if (opts.account) p.set("account", opts.account);
  appendProjectId(p, opts.projectId);
  return fetch(`/api/instagram/find?${p}`).then((r) => json<FindResult>(r));
};

export interface SourcePack {
  id: string;
  handle: string;
  kind: PostKind;
  url: string;
  markdown: string;
  chars: number;
  truncated: boolean;
  savedFor?: SavedFor[];
}

export interface PackResult {
  packs: SourcePack[];
  warning?: string;
  missing: string[];
}

export const packPosts = (ids: string[]) =>
  fetch("/api/instagram/packs", jsonInit({ ids })).then((r) => json<PackResult>(r));

export const listSimilar = (id: string) =>
  fetch(`/api/instagram/similar/${id}`).then((r) => json<SimilarHit[]>(r));

export const getAnalysis = () => {
  const params = new URLSearchParams();
  appendProjectId(params);
  const qs = params.toString();
  return fetch(`/api/instagram/analysis${qs ? `?${qs}` : ""}`).then((r) => json<InstagramAnalysis>(r));
};

export const patchCatalogMark = (
  accountId: string,
  shortcode: string,
  patch: { ideaStatus?: IdeaStatus; rank?: number | null },
) =>
  fetch(
    `/api/instagram/accounts/${accountId}/catalog`,
    jsonInit({ shortcode, ...patch }, "PATCH"),
  ).then((r) => json<CatalogItem>(r));

export const deleteStack = (id: string) =>
  fetch(`/api/instagram/stacks/${id}`, { method: "DELETE" }).then(() => undefined);

export const listAccounts = (q = "", opts: { projectId?: string | null } = {}) => {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  appendProjectId(params, opts.projectId);
  const qs = params.toString();
  return fetch(`/api/instagram/accounts${qs ? `?${qs}` : ""}`).then((r) => json<InstagramAccount[]>(r));
};

export const addAccount = (urlOrUsername: string, opts: { run?: RunWhen; count?: number; mine?: boolean } = {}) =>
  fetch(
    "/api/instagram/accounts",
    jsonInit({ url: urlOrUsername, run: opts.run, count: opts.count, mine: opts.mine || undefined, ...projectBody() }),
  ).then((r) => json<InstagramAccount>(r));

export const patchAccount = (id: string, patch: { mine?: boolean }) =>
  fetch(`/api/instagram/accounts/${id}`, jsonInit(patch, "PATCH")).then((r) => json<InstagramAccount>(r));

export const getAccount = (id: string) =>
  fetch(`/api/instagram/accounts/${id}`).then((r) => json<InstagramAccount>(r));

export const runAccountJobs = (
  id: string,
  types: AccountJobType[],
  opts: { count?: number; more?: boolean } = {},
) =>
  fetch(`/api/instagram/accounts/${id}/jobs`, jsonInit({ types, count: opts.count, more: opts.more })).then(
    (r) => json<InstagramAccount>(r),
  );

export const pullCatalog = (
  id: string,
  shortcodes: string[],
  opts: { recipe?: Recipe; run?: RunWhen } = {},
) =>
  fetch(
    `/api/instagram/accounts/${id}/pull`,
    jsonInit({ shortcodes, recipe: opts.recipe, run: opts.run }),
  ).then(async (r) => {
    const j = (await r.json().catch(() => null)) as {
      error?: string;
      posts?: InstagramPost[];
      errors?: { input: string; error: string }[];
    } | null;
    const posts = Array.isArray(j?.posts) ? j.posts : [];
    const errors = Array.isArray(j?.errors) ? j.errors : [];
    if (!r.ok && !posts.length) {
      throw new Error(j?.error || `Request failed (${r.status})`);
    }
    return { posts, errors };
  });

export const saveAccountTags = (id: string, tags: Tag[]) =>
  fetch(`/api/instagram/accounts/${id}/tags`, jsonInit({ tags }, "PUT")).then((r) =>
    json<InstagramAccount>(r),
  );

export const deleteAccount = (id: string) =>
  fetch(`/api/instagram/accounts/${id}`, { method: "DELETE" }).then(() => undefined);

export const deletePost = (id: string) =>
  fetch(`/api/instagram/${id}`, { method: "DELETE" }).then(() => undefined);

export const getPostComments = (id: string, all = false) =>
  fetch(`/api/instagram/${id}/comments${all ? "?all=1" : ""}`).then((r) =>
    json<CommentsFile>(r),
  );

export const getSlideTranscript = (id: string, slide: number) =>
  fetch(`/api/instagram/${id}/transcript/${slide}`).then((r) =>
    json<{ words: TranscriptWord[] }>(r),
  );

export const mediaUrl = (id: string, slide: number) =>
  `/api/instagram/${id}/media/${slide}`;
export const thumbUrl = (id: string, slide: number) =>
  `/api/instagram/${id}/thumb/${slide}`;

export const saveApify = (token: string) =>
  fetch("/api/instagram/apify", jsonInit({ token }, "PUT")).then((r) =>
    json<ApifyStatus>(r),
  );

export const removeApify = () =>
  fetch("/api/instagram/apify", { method: "DELETE" }).then((r) =>
    json<ApifyStatus>(r),
  );

/* ---- presentation helpers ---- */

export function fmtDate(ts: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleDateString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function fmtAge(ms: number | undefined): string {
  if (!ms || ms < 0) return "—";
  const d = ms / 86_400_000;
  if (d < 1) {
    const h = Math.max(1, Math.round(ms / 3_600_000));
    return h === 1 ? "1 hour" : `${h} hours`;
  }
  if (d < 14) return `${Math.round(d)} days`;
  if (d < 60) return `${Math.round(d / 7)} weeks`;
  return `${(d / 365).toFixed(1)} years`;
}

/** Age of a timestamp as of now — keeps Date.now() out of render bodies. */
export const fmtAgeSince = (ts: number) => fmtAge(Date.now() - ts);

export function fmtDelta(n: number | undefined): string {
  if (n === undefined) return "—";
  if (n > 0) return `+${fmtCount(n)}`;
  if (n < 0) return `−${fmtCount(-n)}`;
  return "0";
}

export function playsVsMedian(
  plays: number | undefined,
  median: number | undefined,
  allPlays: number[],
): string {
  if (plays === undefined || !median) return "";
  const ratio = Math.round((plays / Math.max(median, 1)) * 10) / 10;
  const below = allPlays.filter((n) => n < plays).length;
  const percentile = allPlays.length ? below / allPlays.length : 1;
  if (percentile < 0.2 || ratio <= 0.5) return "low";
  return `${ratio}×`;
}

/** One colour per kind so a wall of cards reads at a glance: reels rose, carousels sky, posts emerald. */
export const kindBadgeClass = (k: PostKind) =>
  k === "reel"
    ? "bg-rose-600/85 text-white"
    : k === "carousel"
      ? "bg-sky-600/85 text-white"
      : "bg-emerald-600/85 text-white";

/** Badge text and colour: a YouTube post says YouTube where an Instagram one says its kind. */
export const postBadgeLabel = (p: { kind: PostKind; platform?: "youtube" }) =>
  p.platform === "youtube" ? "YouTube" : kindLabel(p.kind);
export const postBadgeClass = (p: { kind: PostKind; platform?: "youtube" }) =>
  p.platform === "youtube" ? "bg-red-600/85 text-white" : kindBadgeClass(p.kind);
export const openPostLabel = (p: { platform?: "youtube" }) =>
  p.platform === "youtube" ? "Open on YouTube" : "Open on Instagram";

/** Muted text variant for rows. */
export const kindTextClass = (k: PostKind) =>
  k === "reel" ? "text-rose-300" : k === "carousel" ? "text-sky-300" : "text-emerald-300";

export const KIND_FILTERS: { id: PostKind; label: string }[] = [
  { id: "reel", label: "Reels" },
  { id: "carousel", label: "Carousels" },
  { id: "post", label: "Posts" },
];

export const PROCESS_STEPS: { id: PostStep; label: string }[] = [
  { id: "queued", label: "Waiting in the queue" },
  { id: "resolve", label: "Resolving the link" },
  { id: "info", label: "Reading post details" },
  { id: "download", label: "Downloading media" },
  { id: "thumbs", label: "Preparing previews" },
  { id: "transcribe", label: "Transcribing videos" },
  { id: "vision", label: "Reading the slides" },
  { id: "comments", label: "Collecting comments" },
  { id: "idea", label: "Distilling the idea" },
];
