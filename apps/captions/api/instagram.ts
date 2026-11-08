import { Hono } from "hono";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { sessionOf, type AuthVars } from "./auth";
import { aiFor, anyAiConfigured, completeWithFallback, AiProviderError } from "./ai-complete";
import type { MacUsage } from "./lib/mac-claude";
import {
  anyVisionConfigured,
  completeVisionWithFallback,
  type VisionImage,
} from "./ai-vision";
import { ffmpegCommand } from "./ffmpeg-runtime";
import { extractClipJpegFrame } from "./lib/clip-frame";
import {
  availabilitySnapshot,
  checkApify,
  clearApify,
  fetchCatalogViaApify,
  fetchCommentsViaApify,
  fetchPostsViaApify,
  fetchProfileViaApify,
  ingestGate,
  normalizeApifyPost,
  publicApifyStatus,
  readApify,
  writeApify,
  type IngestMode,
  type StoredApify,
  updateApify,
} from "./lib/instagram/apify";
import { applyMineVisibility, fetchMineAccountStats, fetchMineCatalog, fetchMineCatalogAll, fetchMineComments, fetchMineDailyInsights, fetchMineInsights, fetchMineProfile, fetchMineSharedToFeed, graphConfigured, graphCredsFor, mineUsesGraph, MINE_CATALOG_CAP, withGraphCreds, type MineAccountStats } from "./lib/instagram/graph";
import { mergeAccountStats, nextGraphDaily, type GraphDaily, type InsightDay } from "./lib/instagram/account-insights";
import { annotateComments, QUESTION_MIN } from "./lib/instagram/comment-judge";
import {
  labelPosts,
  LABELS_VERSION,
  performanceBy,
  type PostLabel,
} from "./lib/instagram/post-labels";
import { countReplies, mergeComments } from "./lib/instagram/comments";
import {
  DownloadError,
  downloadToFile,
  extensionFor,
} from "./lib/instagram/download";
import { expandJobs, isJobDone, jobRecords, jobStatusOf, parseRecipe, parseRunWhen, patchJob, recipeFromPreset, retryJobs, stampExistingPull, wants } from "./lib/instagram/recipe";
import { buildSearchText, matchesQuery } from "./lib/instagram/search";
import { appendSnapshot, diffSnapshots, loadSnapshots, snapshotFromCounts } from "./lib/instagram/snapshots";
import { coercePostIdea, IDEA_SYSTEM, ideaUserMessage, parseIdeaPayload, existingFolderFor } from "./lib/instagram/idea";
import {
  IDEA_BOARD_SYSTEM,
  ideaBoardUserMessage,
  omitWorkshopPiles,
  parseIdeaBoard,
  type IdeaBoard,
  type IdeaCatalogRow,
} from "./lib/instagram/idea-board";
import { coerceTag, mergeTags, parseTagsPayload, TAGS_SYSTEM, tagsHaystack } from "./lib/instagram/tags";
import { packInstructions } from "./lib/packs";
import { cleanPostSlideText } from "./lib/instagram/slide-text";
import { buildFindDoc, queryTerms, rankFind, type FindDoc } from "./lib/instagram/find";
import { applyRelevance, relevance, RERANK_MIN_TERMS, RERANK_TOP } from "./lib/instagram/rerank";
import { PostBatcher } from "./lib/instagram/apify-batch";
import { fitPacks, selectTopComments } from "./lib/instagram/pack";
import { postToMarkdown, type SourcePart } from "../src/lib/instagram-markdown";
import { dhashFromGray, fingerprintFrameTimes, sameMedia, samePost, HASH_H, HASH_W } from "./lib/instagram/fingerprint";
import { env } from "./lib/env";
import { commentThemes, hookPatterns, kindAverages, catalogMix, medianPlays, playsPerDay, postingCadence, stackStatusFromMembers, visibilitySplit } from "./lib/instagram/analysis";
import { detectReposts } from "./lib/instagram/duplicates";
import { cosine, makeEmbedding, embedSource, type Embedding } from "./lib/instagram/embed";
import {
  applyKeep,
  ideaStatusOf,
  keepLabel,
  onShelf,
  parseIdeaStatus,
  parseKeep,
  parseRank,
  parseSavedFor,
  parseShelf,
  matchesSavedFor,
  virality,
  type KeepChoice,
  type Shelf,
} from "./lib/instagram/research";
import { accountOwnsPost, nextMineFlags, postInProject } from "./lib/instagram/mine";
import { accountProjects, inProject, resolveProjectId } from "./lib/workshop/workspace";
import { catalogNewestAt, mergeCatalog, mergeCatalogCounts, parseCatalogCount } from "./lib/instagram/catalog";
import { IG_ROOT, InstagramError, igCredsDir, igUserFile } from "./lib/instagram/base";
import type {
  AccountContext,
  AccountJobType,
  AccountMeta,
  CatalogItem,
  CatalogPage,
  Comment,
  CommentsFile,
  JobType,
  PostInfo,
  PostMeta,
  PostStep,
  ProfileInfo,
  Recipe,
  Slide,
  Snapshot,
  MediaFingerprint,
  JobStatus,
  PostKind,
  StackMeta,
  Tag,
} from "./lib/instagram/types";
import { POST_STATUS_MOVES } from "./lib/instagram/types";
import { move } from "./lib/transition";
import {
  InstagramUrlError,
  canonicalPostUrl,
  canonicalProfileUrl,
  extractInstagramProfiles,
  extractInstagramUrls,
  parseInstagramUrl,
  parseProfileHandle,
  shortcodeToMediaId,
} from "./lib/instagram/url";
import {
  YoutubeUrlError,
  extractYoutubeUrls,
  parseYoutubeUrl,
  type YoutubeRef,
} from "./lib/youtube/url";
import { fetchYoutubeViaApify } from "./lib/youtube/fetch";
import { normalizeYoutubeItem, pickSrt } from "./lib/youtube/normalize";
import {
  VISION_SYSTEM,
  frameSampleTimes,
  parseVisionPayload,
  visionUserText,
} from "./lib/instagram/vision";
import { cloudTranscribeBlock, transcribeWav } from "./transcribe";
import { keyFor, type Actor } from "./my-keys";

/** The TypeSafe key that serves `who` (my-keys.ts), or "": its features fall back without one. */
const typesafeFor = (who: Actor) => keyFor(who, "TYPESAFE_API_KEY").key;
import { LOCAL_USER, bumpUsage, findUser, type SessionUser } from "./users";
import type { LibraryPost, OwnPost } from "./lib/workshop/folder";

/**
 * Instagram Analyzer — library of accounts and posts. Jobs (stats, media,
 * transcript, vision, comments, tags) run on demand. Other creators' posts are read on the user's own Apify key
 * (lib/instagram/apify.ts); the account's own posts and numbers through the official login (lib/instagram/graph.ts).
 * Paid steps (transcripts, judging) run on the post owner's keys (my-keys.ts keyFor).
 *
 * Layout:
 *   users/<user>/apify.json
 *   accounts/<id>/{meta,catalog,snapshots}.json
 *   <postId>/meta.json
 *   <postId>/snapshots.json
 *   <postId>/media/ …
 */

export const instagramApp = new Hono<{ Variables: AuthVars }>();

const mb = (v: string | undefined, d: number) =>
  Math.max(1, Number(v) || d) * 1024 * 1024;
const MAX_SLIDE_BYTES = mb(process.env.INSTAGRAM_MAX_SLIDE_MB, 200);
const MAX_POST_BYTES = mb(process.env.INSTAGRAM_MAX_POST_MB, 500);
const MAX_TOTAL_BYTES =
  Math.max(1, Number(process.env.INSTAGRAM_MAX_TOTAL_GB) || 20) * 1024 ** 3;
const KEEP_DAYS = Math.max(0, Number(process.env.INSTAGRAM_KEEP_DAYS) || 0);
const MAX_CONCURRENT = Math.max(
  1,
  Number(process.env.INSTAGRAM_CONCURRENCY) || 4,
);
const MAX_BATCH = Math.max(1, Math.min(50, Number(process.env.INSTAGRAM_MAX_BATCH) || 25));
const VISION_FRAMES = Math.max(
  1,
  Math.min(12, Number(process.env.INSTAGRAM_VISION_FRAMES) || 6),
);
const MAX_COMMENTS = Math.max(
  20,
  Number(process.env.INSTAGRAM_MAX_COMMENTS) || 1000,
);
const THUMB_MAX_BYTES = 8 * 1024 * 1024;
const RESTART_MSG = "Interrupted by a server restart — retry.";
const SKIP_TOP = new Set(["users", "accounts", "stacks"]);

const okId = (id: string) => /^[a-z0-9-]{6,40}$/.test(id);
const okSlide = (s: string) => /^\d{1,2}$/.test(s);
const postDir = (id: string) => path.join(IG_ROOT, id);
const metaPath = (id: string) => path.join(postDir(id), "meta.json");
const infoPath = (id: string) => path.join(postDir(id), "info.json");
const snapshotsPath = (id: string) => path.join(postDir(id), "snapshots.json");
const mediaDir = (id: string) => path.join(postDir(id), "media");
const thumbsDir = (id: string) => path.join(postDir(id), "thumbs");
const visionDir = (id: string) => path.join(postDir(id), "vision");
const transcriptsDir = (id: string) => path.join(postDir(id), "transcripts");
const commentsPath = (id: string) => path.join(postDir(id), "comments.json");
const searchPath = (id: string) => path.join(postDir(id), "search.txt");
const embeddingPath = (id: string) => path.join(postDir(id), "embedding.json");
const ACCOUNTS_ROOT = path.join(IG_ROOT, "accounts");
const STACKS_ROOT = path.join(IG_ROOT, "stacks");
const accountDir = (id: string) => path.join(ACCOUNTS_ROOT, id);
const accountMetaPath = (id: string) => path.join(accountDir(id), "meta.json");
const accountCatalogPath = (id: string) => path.join(accountDir(id), "catalog.json");
const accountGraphCommentsPath = (id: string) => path.join(accountDir(id), "graph-comments.json");
const accountSnapshotsPath = (id: string) => path.join(accountDir(id), "snapshots.json");
const accountGraphStatsPath = (id: string) => path.join(accountDir(id), "graph-stats.json");
const accountGraphDailyPath = (id: string) => path.join(accountDir(id), "graph-daily.json");
const accountLabelsPath = (id: string) => path.join(accountDir(id), "labels.json");

/**
 * "What works": Jev's hook / format / call-to-action label for each post,
 * cached per account by shortcode; posts not labelled yet (or labelled
 * with an older list) are labelled now. Null without a TypeSafe key or
 * when Jev fails, so the page just leaves the section out.
 */
async function whatWorksFor(who: Actor, account: { id: string; username: string; biography?: string }, catalog: CatalogItem[], signal?: AbortSignal) {
  const accountId = account.id;
  const key = typesafeFor(who);
  if (!key || !catalog.length) return null;
  let labels: Record<string, PostLabel> = {};
  try {
    labels = JSON.parse(await readFile(accountLabelsPath(accountId), "utf-8")) as Record<string, PostLabel>;
  } catch {
    /* first run */
  }
  const todo = catalog.filter(
    (row) => row.caption?.trim() && labels[row.shortcode]?.v !== LABELS_VERSION,
  );
  if (todo.length) {
    try {
      const fresh = await labelPosts(
        key,
        todo.map((row) => ({ id: row.shortcode, text: row.caption ?? "" })),
        `@${account.username}${account.biography?.trim() ? `, whose bio says: ${account.biography.trim().replace(/\s+/g, " ")}` : ""}`,
        signal,
      );
      for (const [code, label] of fresh) labels[code] = label;
      await mkdir(accountDir(accountId), { recursive: true });
      await writeFile(accountLabelsPath(accountId), JSON.stringify(labels));
    } catch (e) {
      console.warn(`[instagram] labelling posts failed: ${errorMessage(e)}`);
      if (!Object.keys(labels).length) return null;
    }
  }
  const posts = catalog.map((row) => ({
    id: row.shortcode,
    // trial reels reach non-followers: only compare like with like
    group: `${row.kind}/${row.visibility ?? "public"}`,
    views: row.insights?.views ?? row.counts.plays ?? 0,
  }));
  const by = (dim: "hook" | "format" | "cta") =>
    performanceBy(posts, (code) => labels[code]?.[dim]);
  return { hook: by("hook"), format: by("format"), cta: by("cta"), labelled: Object.keys(labels).length };
}
const accountAvatarPath = (id: string) => path.join(accountDir(id), "avatar.jpg");
const stackPath = (id: string) => path.join(STACKS_ROOT, `${id}.json`);
const nn = (i: number) => String(i).padStart(2, "0");
const wavPath = (id: string, i: number) =>
  path.join(postDir(id), `audio-${nn(i)}.wav`);
const transcriptPath = (id: string, i: number) =>
  path.join(transcriptsDir(id), `${nn(i)}.json`);
const visionJpeg = (id: string, i: number) =>
  path.join(visionDir(id), `${nn(i)}.jpg`);
const thumbJpeg = (id: string, i: number) =>
  path.join(thumbsDir(id), `${nn(i)}.jpg`);
export const postFramesDir = (id: string, i: number) =>
  path.join(postDir(id), "frames", nn(i));
const abs = (id: string, rel: string) => path.join(postDir(id), rel);

interface JobOptions {
  force?: boolean;
  more?: boolean;
  /** Run transcript, slide text, comments, tags and idea even though the media is already in the library. */
  ignoreDuplicate?: boolean;
}

/** Jobs that cost money or minutes; skipped when the same media is already in the library. */
const SKIP_FOR_DUPLICATES = new Set<JobType>(["transcript", "vision", "comments", "tags", "idea"]);

type QueueItem = { kind: "post" | "account"; id: string };

interface TranscriptWord {
  text: string;
  start: number;
  end: number;
}

const active = new Map<string, PostMeta>();
const accountActive = new Map<string, AccountMeta>();
const children = new Map<string, Set<ChildProcess>>();
const aborts = new Map<string, AbortController>();
const jobUsers = new Map<string, SessionUser>();
const jobKinds = new Map<string, JobType[]>();
const accountJobKinds = new Map<string, AccountJobType[]>();
const accountJobOpts = new Map<string, { count?: number; more?: boolean }>();
const jobOpts = new Map<string, JobOptions>();
const queue: QueueItem[] = [];

/**
 * Post lookups through Apify are batched per token: everything enqueued
 * within a short window goes out as one actor run instead of one run per
 * post, which is where most of the Apify bill went.
 */
const APIFY_BATCH_WAIT_MS = Math.max(200, Number(process.env.APIFY_BATCH_WAIT_MS) || 1500);
const APIFY_BATCH_SIZE = Math.max(1, Math.min(50, Number(process.env.APIFY_BATCH_SIZE) || 20));
const postBatchers = new Map<string, PostBatcher<{ raw: unknown; info: PostInfo }>>();
function postBatcherFor(username: string) {
  let b = postBatchers.get(username);
  if (!b) {
    b = new PostBatcher(
      (urls, resultsType) => fetchPostsViaApify(urls, { username, resultsType }),
      { waitMs: APIFY_BATCH_WAIT_MS, maxSize: APIFY_BATCH_SIZE },
    );
    postBatchers.set(username, b);
  }
  return b;
}
/** Info fetched at enqueue time so a batch of posts shares one run; consumed by loadPostInfo. */
const infoPrefetch = new Map<string, Promise<{ raw: unknown; info: PostInfo } | null>>();

function prefetchInfo(meta: PostMeta, user: SessionUser): void {
  if (!meta.url || !meta.shortcode || meta.platform === "youtube") return;
  const p = (async () => {
    const gate = await ingestGate(user.username);
    if (!gate.ok) return null;
    return postBatcherFor(user.username).request(meta.url, meta.kind === "reel");
  })();
  p.catch(() => {});
  infoPrefetch.set(meta.id, p);
}
/** Work asked for while the same post / account is already running; starts when the run ends. */
const followUps = new Map<string, { user: SessionUser; jobs: JobType[]; opts: JobOptions }>();
const accountFollowUps = new Map<
  string,
  { user: SessionUser; jobs: AccountJobType[]; opts: { count?: number; more?: boolean } }
>();
/** Callers waiting for an account's run (and its follow-ups) to finish — see whenAccountIdle. */
const idleWaiters = new Map<string, Set<() => void>>();
const writeQ = new Map<string, Promise<unknown>>();
let running = 0;

void mkdir(IG_ROOT, { recursive: true }).catch(() => {});
void mkdir(ACCOUNTS_ROOT, { recursive: true }).catch(() => {});

/* ---- persistence ---- */

function afterWrite<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const run = () => fn();
  const next = (writeQ.get(id) ?? Promise.resolve()).then(run, run);
  writeQ.set(
    id,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

async function persistAccount(meta: AccountMeta): Promise<void> {
  meta.updatedAt = Date.now();
  await afterWrite(`a:${meta.id}`, async () => {
    try {
      await mkdir(accountDir(meta.id), { recursive: true });
      await writeFile(accountMetaPath(meta.id), JSON.stringify(meta));
    } catch {
      /* deleted mid-job */
    }
  });
}

async function readAccount(id: string): Promise<AccountMeta | null> {
  const mem = accountActive.get(id);
  if (mem) return mem;
  try {
    // A read never writes: a stale "processing" is reconciled once, at boot (resumeInterrupted).
    return JSON.parse(await readFile(accountMetaPath(id), "utf-8")) as AccountMeta;
  } catch {
    return null;
  }
}

async function allAccountIds(): Promise<string[]> {
  try {
    return (await readdir(ACCOUNTS_ROOT, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && okId(d.name))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

async function allAccounts(): Promise<AccountMeta[]> {
  const metas = await Promise.all((await allAccountIds()).map(readAccount));
  return metas.filter((m): m is AccountMeta => !!m);
}

const listedAccount = (m: AccountMeta, user: SessionUser) =>
  m.owner === user.username || user.role === "admin";

async function ownedAccount(id: string, user: SessionUser): Promise<AccountMeta | null> {
  if (!okId(id)) return null;
  const meta = await readAccount(id);
  return meta && listedAccount(meta, user) ? meta : null;
}

async function assignMine(owner: string, accountId: string | null): Promise<void> {
  const all = await allAccounts();
  const posts = await allMetas();
  for (const { id, mine } of nextMineFlags(all, owner, accountId)) {
    const a = all.find((x) => x.id === id);
    if (!a) continue;
    if (mine) {
      a.mine = true;
      delete a.projectId;
      for (const p of posts) {
        if (p.owner !== owner || !p.projectId || !accountOwnsPost(a, p)) continue;
        delete p.projectId;
        await persist(p);
      }
    } else delete a.mine;
    await persistAccount(a);
  }
}

/** Live snapshot of a linked Analyzer account, or the owner's "my account". */
export async function ownAccountContextFor(
  user: SessionUser,
  /** a project's linked account; null = a project with none (then none, never another brand's "mine") */
  accountId?: string | null,
  opts?: { cadence?: boolean },
): Promise<AccountContext | null> {
  if (accountId === null) return null;
  const listed = (await allAccounts()).filter((a) => listedAccount(a, user));
  const acc =
    (accountId ? listed.find((a) => a.id === accountId) : undefined) ??
    listed.find((a) => a.mine && a.owner === user.username);
  if (!acc) return null;
  const base: AccountContext = {
    id: acc.id,
    username: acc.username,
    fullName: acc.fullName,
    biography: acc.biography,
    followers: acc.counts.followers,
    posts: acc.counts.posts,
    fetchedAt: acc.counts.fetchedAt || undefined,
    lastCatalogAt: acc.lastCatalogAt,
  };
  if (opts?.cadence === false) return base;
  const catalog = await loadCatalog(acc.id);
  const cadence = postingCadence([{ id: acc.id, username: acc.username, catalog }])[0];
  const mix = catalog.length ? catalogMix(catalog) : undefined;
  return {
    ...base,
    lastPostedAt: cadence?.lastPostedAt,
    postsPerWeek: cadence?.postsPerWeek,
    mix,
  };
}

async function persistStack(meta: StackMeta): Promise<void> {
  meta.updatedAt = Date.now();
  await mkdir(STACKS_ROOT, { recursive: true });
  await writeFile(stackPath(meta.id), JSON.stringify(meta));
}

async function readStack(id: string): Promise<StackMeta | null> {
  try {
    return JSON.parse(await readFile(stackPath(id), "utf-8")) as StackMeta;
  } catch {
    return null;
  }
}

async function allStacks(): Promise<StackMeta[]> {
  try {
    const names = await readdir(STACKS_ROOT);
    const metas = await Promise.all(
      names.filter((n) => n.endsWith(".json")).map((n) => readStack(n.replace(/\.json$/, ""))),
    );
    return metas.filter((m): m is StackMeta => !!m);
  } catch {
    return [];
  }
}

const listedStack = (m: StackMeta, user: SessionUser) =>
  m.owner === user.username || user.role === "admin";

async function ownedStack(id: string, user: SessionUser): Promise<StackMeta | null> {
  if (!okId(id)) return null;
  const meta = await readStack(id);
  return meta && listedStack(meta, user) ? meta : null;
}

function publicStack(m: StackMeta, posts: PostMeta[]) {
  const ranked = posts.map((p) => p.rank);
  const nums = ranked.filter((n): n is number => typeof n === "number");
  return {
    ...m,
    postIds: posts.map((p) => p.id),
    count: posts.length,
    avgRank: nums.length
      ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10
      : undefined,
    avgVirality: posts.length
      ? Math.round(posts.reduce((n, p) => n + virality(p.counts), 0) / posts.length)
      : 0,
    done: posts.filter((p) => ideaStatusOf(p.ideaStatus) === "done").length,
    ideaStatus: stackStatusFromMembers(posts.map((p) => p.ideaStatus)),
  };
}

async function applyResearch(
  meta: PostMeta,
  patch: {
    ideaStatus?: unknown;
    rank?: unknown;
    stackId?: unknown;
    savedFor?: unknown;
    knowhow?: unknown;
    idea?: unknown;
  },
  user: SessionUser,
): Promise<string | null> {
  if ("ideaStatus" in patch) {
    const s = parseIdeaStatus(patch.ideaStatus);
    if (!s) return "Status must be inbox, idea, done, or skip";
    meta.ideaStatus = s;
  }
  if ("rank" in patch) {
    if (patch.rank === null || patch.rank === "") delete meta.rank;
    else {
      const r = parseRank(patch.rank);
      if (r === undefined) return "Rank must be 1–10";
      meta.rank = r;
    }
  }
  if ("stackId" in patch) {
    if (patch.stackId === null || patch.stackId === "") delete meta.stackId;
    else if (typeof patch.stackId !== "string" || !okId(patch.stackId)) {
      return "Unknown topic stack";
    } else {
      const stack = await ownedStack(patch.stackId, user);
      if (!stack) return "Unknown topic stack";
      meta.stackId = stack.id;
    }
  }
  if ("savedFor" in patch || "knowhow" in patch) {
    const keep = parseKeep(patch);
    if (!keep) return "Kept for must be content, format, both, or Know-how";
    applyKeep(meta, keep);
  }
  if ("idea" in patch) {
    if (patch.idea === null) delete meta.idea;
    else {
      const next = coercePostIdea(patch.idea);
      if (!next) return "Idea needs a title and a takeaway";
      meta.idea = next;
    }
  }
  return null;
}

async function loadCatalog(id: string): Promise<CatalogItem[]> {
  try {
    const raw = JSON.parse(await readFile(accountCatalogPath(id), "utf-8")) as unknown;
    return Array.isArray(raw) ? (raw as CatalogItem[]) : [];
  } catch {
    return [];
  }
}

/** Temp file + rename in the same directory: readers see the old file or the new one, never half. */
async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmp, JSON.stringify(data));
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

async function saveCatalog(id: string, items: CatalogItem[]): Promise<void> {
  await mkdir(accountDir(id), { recursive: true });
  await writeJsonAtomic(accountCatalogPath(id), items);
}

async function saveGraphComments(id: string, byShortcode: Record<string, Comment[]>): Promise<void> {
  await mkdir(accountDir(id), { recursive: true });
  // an incremental sync only fetches new posts' threads — keep the rest
  let existing: Record<string, Comment[]> = {};
  try {
    existing = JSON.parse(await readFile(accountGraphCommentsPath(id), "utf-8")) as Record<string, Comment[]>;
  } catch {
    /* first sync */
  }
  await writeJsonAtomic(accountGraphCommentsPath(id), { ...existing, ...byShortcode });
}

async function saveGraphStats(id: string, stats: MineAccountStats): Promise<void> {
  await mkdir(accountDir(id), { recursive: true });
  await writeJsonAtomic(accountGraphStatsPath(id), stats);
}

async function loadGraphStats(id: string): Promise<MineAccountStats | undefined> {
  try {
    const raw = JSON.parse(await readFile(accountGraphStatsPath(id), "utf-8")) as MineAccountStats;
    return raw && typeof raw.fetchedAt === "number" ? raw : undefined;
  } catch {
    return undefined;
  }
}

async function loadGraphDaily(id: string): Promise<GraphDaily | undefined> {
  try {
    const raw = JSON.parse(await readFile(accountGraphDailyPath(id), "utf-8")) as GraphDaily;
    return raw && typeof raw.fetchedAt === "number" && Array.isArray(raw.days) ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Merges daily reach / new follows into graph-daily.json; the first run backfills two years. */
async function refreshGraphDaily(id: string, recent: InsightDay[], signal?: AbortSignal): Promise<void> {
  const next = await nextGraphDaily(await loadGraphDaily(id), recent, Date.now(), (since, until) =>
    fetchMineDailyInsights(since, until, { signal }),
  );
  if (!next) return;
  await mkdir(accountDir(id), { recursive: true });
  await writeJsonAtomic(accountGraphDailyPath(id), next);
}

async function refreshMineGraphStats(id: string, signal?: AbortSignal): Promise<void> {
  let stats: MineAccountStats;
  try {
    stats = await fetchMineAccountStats({ signal });
    // fill-only: a value this fetch couldn't read keeps the stored one
    await saveGraphStats(id, mergeAccountStats(await loadGraphStats(id), stats));
  } catch {
    return; /* catalog still useful without account-level insights */
  }
  try {
    await refreshGraphDaily(id, stats.days, signal);
  } catch {
    /* the next refresh merges again */
  }
}

async function persist(meta: PostMeta): Promise<void> {
  meta.updatedAt = Date.now();
  await afterWrite(meta.id, async () => {
    try {
      await writeFile(metaPath(meta.id), JSON.stringify(meta));
    } catch {
      /* deleted mid-job */
    }
  });
}

async function readMeta(id: string): Promise<PostMeta | null> {
  const mem = active.get(id);
  if (mem) return mem;
  try {
    // A read never writes: a stale "processing" is reconciled once, at boot (resumeInterrupted).
    return JSON.parse(await readFile(metaPath(id), "utf-8")) as PostMeta;
  } catch {
    return null;
  }
}

const canSee = (meta: PostMeta, user: SessionUser) =>
  user.role === "admin" || meta.owner === user.username;

async function ownedMeta(id: string, user: SessionUser): Promise<PostMeta | null> {
  if (!okId(id)) return null;
  const meta = await readMeta(id);
  return meta && canSee(meta, user) ? meta : null;
}

/** Public shape; slide text is served cleaned so older posts benefit too. */
const publicMeta = (m: PostMeta) => {
  const slides = m.slides.map((s) => ({ ...s }));
  cleanPostSlideText(slides, m.creator);
  return {
    ...m,
    slides,
    hasComments: existsSync(commentsPath(m.id)),
  };
};

async function allIds(): Promise<string[]> {
  try {
    return (await readdir(IG_ROOT, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !SKIP_TOP.has(d.name))
      .map((d) => d.name)
      .filter(okId);
  } catch {
    return [];
  }
}

async function allMetas(): Promise<PostMeta[]> {
  const metas = await Promise.all((await allIds()).map(readMeta));
  return metas.filter((m): m is PostMeta => !!m);
}

const listedFor = (m: PostMeta, user: SessionUser) =>
  m.owner === user.username || (user.role === "admin" && !m.owner);

const queryProjectId = (c: { req: { query: (k: string) => string | undefined } }) => {
  const id = c.req.query("projectId") || "";
  return okId(id) ? id : undefined;
};

// "Mine" is per owner: the demo's copy of an account is never the admin's own.
const ownMine = (a: AccountMeta, user: SessionUser) => !!a.mine && a.owner === user.username;

// Home list and analysis follow listedFor: an admin opens other owners' accounts by link, never lists them.
const listedAccountIn = (a: AccountMeta, user: SessionUser, scope: ProjectScope) =>
  (a.owner === user.username || (user.role === "admin" && !a.owner)) && scope.accountIn(a);

async function findByShortcode(
  shortcode: string,
  user: SessionUser,
  excludeId?: string,
): Promise<PostMeta | null> {
  for (const m of await allMetas()) {
    if (m.id === excludeId) continue;
    if (m.shortcode === shortcode && listedFor(m, user)) return m;
  }
  return null;
}

async function libraryBytes(): Promise<number> {
  return (await allMetas()).reduce((n, m) => n + (m.bytes || 0), 0);
}

async function readSearchText(id: string): Promise<string> {
  try {
    return await readFile(searchPath(id), "utf-8");
  } catch {
    return "";
  }
}

async function loadTranscript(id: string, i: number): Promise<TranscriptWord[]> {
  try {
    const data = JSON.parse(await readFile(transcriptPath(id, i), "utf-8")) as {
      words?: TranscriptWord[];
    };
    return Array.isArray(data.words) ? data.words : [];
  } catch {
    return [];
  }
}

async function loadComments(id: string): Promise<CommentsFile | null> {
  try {
    return JSON.parse(await readFile(commentsPath(id), "utf-8")) as CommentsFile;
  } catch {
    return null;
  }
}

async function writeSearchText(meta: PostMeta): Promise<void> {
  const parts: Array<string | undefined> = [
    `@${meta.creator.username}`,
    meta.creator.fullName,
    meta.caption,
    meta.kind,
    tagsHaystack(meta.tags),
    meta.idea?.title,
    meta.idea?.takeaway,
    meta.ideaStatus,
    meta.stackId,
  ];
  for (const s of meta.slides) {
    parts.push(
      s.caption,
      s.vision.hook,
      s.vision.onScreenText,
      s.vision.description,
      s.accessibilityCaption,
    );
    if (s.transcript.status === "done") {
      parts.push((await loadTranscript(meta.id, s.index)).map((w) => w.text).join(" "));
    }
  }
  const comments = await loadComments(meta.id);
  if (comments) {
    const walk = (list: Comment[]) => {
      for (const c of list) {
        parts.push(c.text, `@${c.user.username}`);
        if (c.replies?.length) walk(c.replies);
      }
    };
    walk(comments.comments);
  }
  await writeFile(searchPath(meta.id), buildSearchText(parts)).catch(() => {});
}

async function loadEmbedding(id: string): Promise<Embedding | null> {
  try {
    const raw = JSON.parse(await readFile(embeddingPath(id), "utf-8")) as Embedding;
    return Array.isArray(raw?.vector) && raw.vector.length ? raw : null;
  } catch {
    return null;
  }
}

async function saveEmbedding(meta: PostMeta): Promise<Embedding> {
  const search = await readSearchText(meta.id);
  const text = embedSource([
    `@${meta.creator.username}`,
    meta.caption,
    tagsHaystack(meta.tags),
    meta.idea?.title,
    meta.idea?.takeaway,
    meta.slides[0]?.vision.hook,
    meta.slides[0]?.vision.onScreenText,
    search,
  ]);
  const emb = makeEmbedding(text || meta.url || meta.id);
  await writeFile(embeddingPath(meta.id), JSON.stringify(emb)).catch(() => {});
  return emb;
}

async function embeddingFor(meta: PostMeta): Promise<Embedding> {
  const existing = await loadEmbedding(meta.id);
  if (existing && existing.at >= meta.updatedAt - 2000) return existing;
  return saveEmbedding(meta);
}

/* ---- topic search + source packs (used by the Content Workshop) ---- */

/** Per-post search document, rebuilt only when the post changes. */
const FIND_DOC_VERSION = 3;
const findIndex = new Map<string, { at: number; ver: number; doc: FindDoc }>();

async function findDocFor(meta: PostMeta): Promise<FindDoc> {
  const cached = findIndex.get(meta.id);
  if (cached && cached.at === meta.updatedAt && cached.ver === FIND_DOC_VERSION) return cached.doc;
  const pub = publicMeta(meta);
  const transcript: string[] = [];
  for (const s of meta.slides) {
    if (s.transcript.status !== "done") continue;
    transcript.push((await loadTranscript(meta.id, s.index)).map((w) => w.text).join(" "));
  }
  const comments: string[] = [];
  const walk = (list: Comment[]) => {
    for (const cm of list) {
      if (!cm.lowValue) comments.push(cm.text);
      if (cm.replies?.length) walk(cm.replies);
    }
  };
  walk((await loadComments(meta.id))?.comments ?? []);
  const doc = buildFindDoc({
    id: meta.id,
    kind: meta.kind,
    idea: [meta.idea?.title ?? "", meta.idea?.takeaway ?? ""],
    slides: [
      pub.slides[0]?.vision.hook ?? "",
      ...pub.slides.flatMap((s) => [s.caption ?? "", s.vision.onScreenText ?? ""]),
    ],
    caption: [
      meta.caption,
      `@${meta.creator.username}`,
      meta.creator.fullName ?? "",
      tagsHaystack(meta.tags),
    ],
    transcript: transcript.join("\n"),
    comments: comments.join("\n"),
    vector: (await embeddingFor(meta)).vector,
    virality: virality(meta.counts),
    takenAt: meta.takenAt,
  });
  findIndex.set(meta.id, { at: meta.updatedAt, ver: FIND_DOC_VERSION, doc });
  return doc;
}

/** Posts the user may read, in the order asked; unknown or foreign ids are skipped. */
export async function postsForUser(ids: string[], user: SessionUser): Promise<ReturnType<typeof publicMeta>[]> {
  const out: ReturnType<typeof publicMeta>[] = [];
  for (const id of ids) {
    if (!okId(id)) continue;
    const m = await readMeta(id);
    if (m && canSee(m, user)) out.push(publicMeta(m));
  }
  return out;
}

export async function libraryCountFor(user: SessionUser): Promise<number> {
  return (await allMetas()).filter((m) => listedFor(m, user)).length;
}

export interface SourcePack {
  id: string;
  handle: string;
  kind: PostKind;
  url: string;
  markdown: string;
  chars: number;
  truncated: boolean;
  savedFor?: PostMeta["savedFor"];
}

/** Markdown packs (caption, slide text, transcripts, top comments) trimmed to a reading budget. */
export async function packPostsForUser(
  ids: string[],
  user: SessionUser,
  opts: { perPost?: number; total?: number; comments?: boolean; parts?: SourcePart[] } = {},
): Promise<{ packs: SourcePack[]; warning?: string; missing: string[] }> {
  const wants = (part: SourcePart) => !opts.parts || opts.parts.includes(part);
  const packs: SourcePack[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const m = okId(id) ? await readMeta(id) : null;
    if (!m || !canSee(m, user)) {
      missing.push(id);
      continue;
    }
    const pub = publicMeta(m);
    const transcripts: Record<number, TranscriptWord[]> = {};
    if (wants("transcript")) {
      for (const s of m.slides) {
        if (s.transcript.status === "done") transcripts[s.index] = await loadTranscript(m.id, s.index);
      }
    }
    const comments = opts.comments === false || !wants("comments") ? [] : selectTopComments((await loadComments(m.id))?.comments ?? []);
    const markdown = postToMarkdown(pub, transcripts, comments, { parts: opts.parts });
    packs.push({
      id: m.id,
      handle: m.creator.username,
      kind: m.kind,
      url: m.url,
      markdown,
      chars: markdown.length,
      truncated: false,
      savedFor: m.savedFor,
    });
  }
  const fitted = fitPacks(packs, opts);
  return { packs: fitted.packs, warning: fitted.warning, missing };
}

/* ---- the Workshop's folder on the Mac ---- */

const fullPacks = new Map<string, { at: number; markdown: string }>();

/** A post in full (slide text, transcript, caption, top comments), remembered until the post changes. */
async function fullPack(m: PostMeta): Promise<string> {
  const hit = fullPacks.get(m.id);
  if (hit && hit.at === m.updatedAt) return hit.markdown;
  const transcripts: Record<number, TranscriptWord[]> = {};
  for (const s of m.slides) {
    if (s.transcript.status === "done") transcripts[s.index] = await loadTranscript(m.id, s.index);
  }
  const markdown = postToMarkdown(publicMeta(m), transcripts, selectTopComments((await loadComments(m.id))?.comments ?? []));
  fullPacks.set(m.id, { at: m.updatedAt, markdown });
  return markdown;
}

/**
 * Every post on the linked (or "my") account: the Analyzer's catalog row, plus the library's full text when it has the post.
 */
export async function ownPostsForWorkshop(user: SessionUser, accountId?: string | null): Promise<{ handle: string; posts: OwnPost[] } | null> {
  if (accountId === null) return null; // a project with no Instagram linked: no "my posts", never another brand's
  const listed = (await allAccounts()).filter((a) => listedAccount(a, user));
  const acc = (accountId ? listed.find((a) => a.id === accountId) : undefined) ?? listed.find((a) => a.mine && a.owner === user.username);
  if (!acc) return null;
  const handle = acc.username.toLowerCase();
  const byCode = new Map<string, PostMeta>();
  for (const m of await allMetas()) if (canSee(m, user) && m.platform !== "youtube" && m.creator.username.toLowerCase() === handle) byCode.set(m.shortcode, m);
  const posts: OwnPost[] = [];
  for (const item of await loadCatalog(acc.id)) {
    const m = byCode.get(item.shortcode);
    const slides = m?.kind === "carousel" ? m.slides.map((s) => s.vision.onScreenText ?? "").filter((t) => t.trim()) : undefined;
    posts.push({ item, markdown: m ? await fullPack(m) : undefined, ...(slides?.length ? { slides } : {}) });
  }
  return { handle: acc.username, posts };
}

/**
 * One of the user's own posts by its shortcode: the account's synced catalog first; a post too new to be synced is looked for in the last few the
 * Graph lists, when the account is the one the Graph token belongs to.
 */
export async function findOwnPost(user: SessionUser, shortcode: string, accountId?: string | null): Promise<{ handle: string; post: OwnPost } | null> {
  const own = await ownPostsForWorkshop(user, accountId);
  if (!own) return null;
  const hit = own.posts.find((p) => p.item.shortcode === shortcode);
  if (hit) return { handle: own.handle, post: hit };
  const acc = (await allAccounts()).find((a) => a.mine && a.owner === user.username && a.username.toLowerCase() === own.handle.toLowerCase());
  const creds = graphCredsFor(acc);
  if (!acc || !creds) return null;
  const recent = await withGraphCreds(creds, () => fetchMineCatalog({ cap: 12 })).catch(() => null);
  const item = recent?.items.find((i) => i.shortcode === shortcode);
  return item ? { handle: own.handle, post: { item } } : null;
}

/**
 * The comments on one of the user's own posts, for a Workshop share link's Questions: the
 * Graph thread (read again when `fresh`; scraped instead when Graph sends no names), or the Analyzer's scrape; and the
 * account's own earlier replies to comments, across its posts, as examples of how it answers.
 */
export async function ownPostComments(
  user: SessionUser,
  shortcode: string,
  fresh: boolean,
  accountId?: string | null,
): Promise<{ handle?: string; caption?: string; comments: Comment[]; replies: Array<{ comment: string; reply: string }> }> {
  const listed = (await allAccounts()).filter((a) => listedAccount(a, user));
  const accounts = accountId ? listed.filter((a) => a.id === accountId) : accountId === null ? [] : listed.filter((a) => a.mine);
  let acc: AccountMeta | undefined;
  let item: CatalogItem | undefined;
  for (const a of accounts) {
    item = (await loadCatalog(a.id)).find((i) => i.shortcode === shortcode);
    if (item) {
      acc = a;
      break;
    }
  }
  let graph: Record<string, Comment[]> = {};
  if (acc) {
    const creds = graphCredsFor(acc);
    if (fresh && item?.graphId && creds) {
      // ponytail: Graph's first 50 comments, page with `paging.next` if posts outgrow that
      const list = (await withGraphCreds(creds, () => fetchMineComments([item.graphId!]))).get(item.graphId);
      if (list?.length) await saveGraphComments(acc.id, { [shortcode]: list });
    }
    graph = await readFile(accountGraphCommentsPath(acc.id), "utf-8").then((t) => JSON.parse(t) as Record<string, Comment[]>, () => ({}));
  }
  const meta = (await allMetas()).find((m) => m.shortcode === shortcode && canSee(m, user));
  // one source, never both: Graph's ids and Apify's aren't known to match, and a merge could list a comment twice
  let comments = graph[shortcode] ?? [];
  if (!comments.length) comments = (meta ? await loadComments(meta.id) : null)?.comments ?? [];
  // Graph sends no usernames without Meta's comment permission (every one reads "instagram"), so the author's own replies
  // can't be told apart; when asked to read again, the post is scraped instead (the visitor's Apify key)
  if (fresh && !comments.some((c) => c.user.id)) {
    const scraped = await fetchCommentsViaApify(`https://www.instagram.com/p/${shortcode}/`, { username: user.username, cap: MAX_COMMENTS }).catch(() => null);
    if (scraped?.comments.length) comments = scraped.comments;
  }
  const handle = (acc?.username ?? meta?.creator.username)?.toLowerCase();
  const replies: Array<{ comment: string; reply: string; at: number }> = [];
  if (handle) {
    for (const list of Object.values(graph))
      for (const c of list)
        for (const r of c.replies ?? []) if (r.user.username.toLowerCase() === handle && c.text.trim() && r.text.trim()) replies.push({ comment: c.text, reply: r.text, at: r.createdAt });
  }
  return {
    handle,
    caption: item?.caption ?? meta?.caption,
    comments,
    replies: replies.sort((a, b) => b.at - a.at).slice(0, 40).map(({ comment, reply }) => ({ comment, reply })),
  };
}

/** The account marked "my account" (the one Instagram login), if any. */
export async function mineAccountId(user: SessionUser): Promise<string | undefined> {
  return (await ownerMine(user))?.id;
}

/**
 * Saved posts and followed accounts from before projects were kept apart go into `projectId` (once, see
 * scopeOldRecords in workshop.ts). The user's own accounts and their posts are left to follow the project that links them.
 */
export async function scopeOldAnalyzer(user: SessionUser, projectId: string): Promise<{ posts: number; accounts: number }> {
  const links = await accountProjects(user.username);
  const accounts = (await allAccounts()).filter((a) => a.owner === user.username);
  const own = accounts.filter((a) => a.mine || links.has(a.id));
  let posts = 0;
  for (const m of await allMetas()) {
    if (m.owner !== user.username || m.projectId || own.some((a) => accountOwnsPost(a, m))) continue;
    m.projectId = projectId;
    await persist(m);
    posts++;
  }
  let n = 0;
  for (const a of accounts) {
    if (a.projectId || own.includes(a)) continue;
    a.projectId = projectId;
    await persistAccount(a);
    n++;
  }
  return { posts, accounts: n };
}

/** The user's whole Analyzer library in this project (every shelf), each post in full. */
export async function libraryForWorkshop(user: SessionUser, projectId?: string): Promise<LibraryPost[]> {
  const out: LibraryPost[] = [];
  const scope = await projectScope(user, projectId);
  for (const m of await allMetas()) {
    if (!listedFor(m, user) || !scope.postIn(m) || !postInProject(m, projectId, { mine: scope.mine })) continue;
    out.push({
      id: m.id,
      handle: m.creator.username,
      kind: m.kind,
      takenAt: m.takenAt,
      plays: m.counts.plays,
      idea: m.idea?.title,
      savedFor: m.savedFor,
      markdown: await fullPack(m),
    });
  }
  return out;
}

function parseUserTags(raw: unknown[]): Tag[] {
  const out: Tag[] = [];
  for (const item of raw) {
    const tag =
      typeof item === "string"
        ? coerceTag({ label: item, kind: "custom" }, "user")
        : coerceTag(item, "user");
    if (tag) out.push({ ...tag, source: "user" });
  }
  return out;
}

/* ---- media helpers ---- */

function probe(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", ["-v", "error", ...args, file]);
    let out = "";
    const kill = setTimeout(() => {
      p.kill("SIGKILL");
      resolve(out.trim());
    }, 15_000);
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("close", () => {
      clearTimeout(kill);
      resolve(out.trim());
    });
    p.on("error", () => {
      clearTimeout(kill);
      resolve("");
    });
  });
}

const probeDuration = async (f: string) =>
  Number(await probe(f, ["-show_entries", "format=duration", "-of", "csv=p=0"])) || 0;

const probeHasAudio = async (f: string) =>
  (
    await probe(f, [
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=codec_name",
      "-of",
      "csv=p=0",
    ])
  ).length > 0;

const probeSize = async (f: string): Promise<{ width: number; height: number }> => {
  const out = await probe(f, [
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "csv=p=0",
  ]);
  const [w, h] = out.split(",").map((n) => Number(n));
  return { width: w || 0, height: h || 0 };
};

function runFfmpeg(id: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegCommand(), [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      ...args,
    ]);
    let set = children.get(id);
    if (!set) {
      set = new Set();
      children.set(id, set);
    }
    set.add(p);
    let err = "";
    p.stderr.on("data", (d) => {
      err += d.toString();
      if (err.length > 4000) err = err.slice(-4000);
    });
    const done = () => {
      set!.delete(p);
      if (!set!.size) children.delete(id);
    };
    p.on("error", (e) => {
      done();
      reject(e);
    });
    p.on("close", (code) => {
      done();
      if (code === 0) resolve();
      else reject(new Error(err.trim() || `ffmpeg exited ${code}`));
    });
  });
}

/** Like runFfmpeg but returns what ffmpeg writes to stdout (small outputs only). */
function ffmpegBytes(id: string, args: string[], maxBytes = 1 << 20): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-nostdin", ...args]);
    let set = children.get(id);
    if (!set) {
      set = new Set();
      children.set(id, set);
    }
    set.add(p);
    const chunks: Buffer[] = [];
    let size = 0;
    let err = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), 30_000);
    p.stdout.on("data", (d: Buffer) => {
      size += d.length;
      if (size <= maxBytes) chunks.push(d);
    });
    p.stderr.on("data", (d) => {
      err += d.toString();
      if (err.length > 2000) err = err.slice(-2000);
    });
    const done = () => {
      clearTimeout(timer);
      set!.delete(p);
      if (!set!.size) children.delete(id);
    };
    p.on("error", (e) => {
      done();
      reject(e);
    });
    p.on("close", (code) => {
      done();
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(err.trim() || `ffmpeg exited ${code}`));
    });
  });
}

/* ---- duplicate media ---- */

const GRAY_TILE_ARGS = [
  "-frames:v",
  "1",
  "-vf",
  `scale=${HASH_W}:${HASH_H}:flags=area,format=gray`,
  "-f",
  "rawvideo",
  "-pix_fmt",
  "gray",
  "pipe:1",
];

async function grayTile(id: string, src: string, atS?: number): Promise<Uint8Array | null> {
  try {
    const seek = atS === undefined ? [] : ["-ss", atS.toFixed(2)];
    const buf = await ffmpegBytes(id, [...seek, "-i", src, ...GRAY_TILE_ARGS]);
    const need = HASH_W * HASH_H;
    return buf.length >= need ? new Uint8Array(buf.subarray(0, need)) : null;
  } catch {
    return null;
  }
}

async function fingerprintSlide(id: string, slide: Slide): Promise<MediaFingerprint | undefined> {
  if (!slide.file || !existsSync(abs(id, slide.file))) return undefined;
  const src = abs(id, slide.file);
  if (slide.kind === "video") {
    const d = slide.durationS ?? 0;
    const h: string[] = [];
    for (const t of fingerprintFrameTimes(d)) {
      const px = await grayTile(id, src, t);
      if (px) h.push(dhashFromGray(px));
    }
    return h.length ? { h, d: Number(d.toFixed(2)) } : undefined;
  }
  const px = await grayTile(id, src);
  return px ? { h: [dhashFromGray(px)] } : undefined;
}

/** Fills in missing slide fingerprints; returns whether anything changed. */
async function fingerprintPost(meta: PostMeta): Promise<boolean> {
  let changed = false;
  for (const slide of meta.slides) {
    if (slide.fingerprint) continue;
    const fp = await fingerprintSlide(meta.id, slide);
    if (fp) {
      slide.fingerprint = fp;
      changed = true;
    }
  }
  return changed;
}

/** The earliest post in this user's library carrying the same media, slide for slide. */
async function findSameMedia(meta: PostMeta, user: SessionUser): Promise<PostMeta | null> {
  const mine = meta.slides.map((s) => s.fingerprint);
  if (!mine.length || mine.some((f) => !f)) return null;
  let best: PostMeta | null = null;
  for (const m of await allMetas()) {
    if (m.id === meta.id || !listedFor(m, user)) continue;
    if (m.slides.length !== meta.slides.length) continue;
    if (!samePost(mine, m.slides.map((s) => s.fingerprint))) continue;
    if (!best || m.createdAt < best.createdAt) best = m;
  }
  return best;
}

function markDuplicate(meta: PostMeta, original: PostMeta): void {
  meta.duplicateOf = original.id;
  const when = original.takenAt ? ` from ${new Date(original.takenAt).toISOString().slice(0, 10)}` : "";
  pushWarning(
    meta,
    `Same media as @${original.creator.username}'s post${when}, already in your library — transcript, slide text, comments and tags skipped`,
  );
  for (const s of meta.slides) {
    if (s.transcript.status === "pending") s.transcript = { status: "skipped" };
    if (s.vision.status === "pending") s.vision = { status: "skipped" };
  }
  if (meta.comments.status === "pending") meta.comments = { ...meta.comments, status: "skipped" };
}

/** Undo the duplicate skip so an explicit "run anyway" has parts to work on. */
function reopenSkippedParts(meta: PostMeta): void {
  for (const s of meta.slides) {
    if (s.kind === "video" && s.transcript.status === "skipped" && s.hasAudio !== false) {
      s.transcript = { status: "pending" };
    }
    if (s.vision.status === "skipped" && s.file) s.vision = { status: "pending" };
  }
  if (meta.comments.status === "skipped") meta.comments = { ...meta.comments, status: "pending" };
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        const item = items[next++];
        await fn(item);
      }
    },
  );
  await Promise.all(workers);
}

function crawlProgress(meta: PostMeta, hi: number): () => void {
  const t = setInterval(() => {
    if (active.get(meta.id) !== meta) return;
    if (meta.progress >= hi - 0.01) return;
    meta.progress = Math.min(hi - 0.01, meta.progress + 0.01);
    void persist(meta);
  }, 700);
  return () => clearInterval(t);
}

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

function pushWarning(meta: PostMeta, text: string): void {
  meta.warnings = [...(meta.warnings ?? []).filter((w) => w !== text), text].slice(-12);
}

/* ---- pipeline ---- */

function newSlide(info: PostInfo["slides"][number]): Slide {
  return {
    index: info.index,
    kind: info.kind,
    file: "",
    mime: "",
    width: info.width,
    height: info.height,
    bytes: 0,
    durationS: info.durationS,
    accessibilityCaption: info.accessibilityCaption,
    caption: info.caption,
    transcript: { status: info.kind === "video" ? "pending" : "skipped" },
    vision: { status: "pending" },
  };
}

function applyInfo(meta: PostMeta, info: PostInfo, includeSlides: boolean): void {
  meta.shortcode = info.shortcode;
  meta.mediaId = info.mediaId;
  meta.kind = info.kind;
  meta.url = info.url;
  meta.creator = info.creator;
  meta.takenAt = info.takenAt;
  meta.caption = info.caption;
  meta.counts = { ...info.counts, fetchedAt: Date.now() };
  if (!meta.pulledAt) {
    meta.pulledAt = Date.now();
    if (meta.takenAt) meta.ageAtPullMs = Math.max(0, meta.pulledAt - meta.takenAt);
  }
  if (!includeSlides) return;
  const sameShape =
    meta.slides.length === info.slides.length &&
    meta.slides.every((s, i) => s.kind === info.slides[i].kind);
  if (!sameShape) {
    meta.slides = info.slides.map(newSlide);
    meta.bytes = 0;
    return;
  }
  meta.slides = meta.slides.map((s, i) => ({
    ...s,
    width: info.slides[i].width || s.width,
    height: info.slides[i].height || s.height,
    durationS: info.slides[i].durationS ?? s.durationS,
    accessibilityCaption: info.slides[i].accessibilityCaption ?? s.accessibilityCaption,
    caption: info.slides[i].caption ?? s.caption,
  }));
}

async function resetParts(meta: PostMeta): Promise<void> {
  await rm(mediaDir(meta.id), { recursive: true, force: true }).catch(() => {});
  await rm(transcriptsDir(meta.id), { recursive: true, force: true }).catch(() => {});
  meta.bytes = 0;
  meta.slides = meta.slides.map((s) => ({
    ...s,
    file: "",
    bytes: 0,
    transcript: { status: s.kind === "video" ? "pending" : "skipped" },
    vision: { status: "pending" },
  }));
}

async function downloadSlides(
  meta: PostMeta,
  info: PostInfo,
  signal: AbortSignal,
): Promise<void> {
  const id = meta.id;
  await mkdir(mediaDir(id), { recursive: true });
  let total = meta.slides.reduce(
    (n, s) => n + (s.file && existsSync(abs(id, s.file)) ? s.bytes : 0),
    0,
  );
  for (const [i, src] of info.slides.entries()) {
    const slide = meta.slides[i];
    if (slide.file && slide.bytes > 0 && existsSync(abs(id, slide.file))) continue;
    const tmp = path.join(mediaDir(id), `${nn(i)}.download`);
    const { bytes, mime } = await downloadToFile(src.url, tmp, {
      maxBytes: Math.min(MAX_SLIDE_BYTES, MAX_POST_BYTES - total),
      signal,
      fallbackMime: src.kind === "video" ? "video/mp4" : "image/jpeg",
    });
    const name = `${nn(i)}.${extensionFor(mime)}`;
    await rename(tmp, path.join(mediaDir(id), name));
    slide.file = `media/${name}`;
    slide.mime = mime;
    slide.bytes = bytes;
    total += bytes;
    meta.bytes = total;
    meta.progress = 0.1 + 0.35 * ((i + 1) / info.slides.length);
    await persist(meta);
  }
  meta.bytes = total;
}

const YT_IMAGE_HOST = /(^|\.)ytimg\.com$/i;

/** YouTube's thumbnail is the post's picture (the Instagram CDN allow-list does not cover it). */
async function downloadYoutubeThumb(meta: PostMeta, info: PostInfo, signal: AbortSignal): Promise<void> {
  const src = info.slides[0];
  const slide = meta.slides[0];
  if (!src || !slide) return;
  const url = new URL(src.url);
  if (url.protocol !== "https:" || !YT_IMAGE_HOST.test(url.hostname)) {
    throw new Error(`Refusing to download a thumbnail from ${url.hostname}`);
  }
  const res = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
  if (!res.ok) throw new Error(`YouTube thumbnail HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length || buf.length > THUMB_MAX_BYTES) throw new Error("YouTube thumbnail is empty or too large");
  await mkdir(mediaDir(meta.id), { recursive: true });
  await writeFile(path.join(mediaDir(meta.id), `${nn(slide.index)}.jpg`), buf);
  slide.file = `media/${nn(slide.index)}.jpg`;
  slide.mime = "image/jpeg";
  slide.bytes = buf.length;
  meta.bytes = buf.length;
}

/** YouTube captions as the transcript file Browse and the Workshop already read (slide 0). */
async function saveYoutubeTranscript(meta: PostMeta, info: PostInfo): Promise<boolean> {
  if (!meta.slides.length) meta.slides = info.slides.map(newSlide);
  const slide = meta.slides[0];
  if (!slide || !info.words?.length) return false;
  await mkdir(transcriptsDir(meta.id), { recursive: true });
  await writeFile(transcriptPath(meta.id, slide.index), JSON.stringify({ words: info.words }));
  slide.transcript = { status: "done", words: info.words.length };
  return true;
}

async function prepareSlide(
  meta: PostMeta,
  slide: Slide,
  cover: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  const id = meta.id;
  const src = abs(id, slide.file);
  await mkdir(thumbsDir(id), { recursive: true });
  const thumb = thumbJpeg(id, slide.index);
  if (slide.kind === "video") {
    const [duration, hasAudio, size] = await Promise.all([
      probeDuration(src),
      probeHasAudio(src),
      probeSize(src),
    ]);
    if (duration) slide.durationS = duration;
    slide.hasAudio = hasAudio;
    if (size.width && size.height) {
      slide.width = size.width;
      slide.height = size.height;
    }
    if (!hasAudio) slide.transcript = { status: "skipped" };
    if (!existsSync(thumb)) {
      let made = false;
      if (cover) {
        const tmp = `${thumb}.download`;
        try {
          await downloadToFile(cover, tmp, {
            maxBytes: THUMB_MAX_BYTES,
            signal,
            fallbackMime: "image/jpeg",
          });
          await runFfmpeg(id, ["-i", tmp, "-vf", "scale='min(720,iw)':-2", "-q:v", "4", thumb]);
          made = true;
        } catch {
          /* fall back to a frame */
        } finally {
          await rm(tmp, { force: true }).catch(() => {});
        }
      }
      if (!made) {
        const ss = (slide.durationS ?? 0) > 1 ? "0.5" : "0";
        await runFfmpeg(id, [
          "-ss",
          ss,
          "-i",
          src,
          "-frames:v",
          "1",
          "-vf",
          "scale='min(720,iw)':-2",
          "-q:v",
          "4",
          thumb,
        ]).catch(() => {});
      }
    }
  } else {
    const size = await probeSize(src);
    if (size.width && size.height) {
      slide.width = size.width;
      slide.height = size.height;
    }
    if (!existsSync(thumb)) {
      await runFfmpeg(id, ["-i", src, "-vf", "scale='min(720,iw)':-2", "-q:v", "4", thumb]).catch(
        () => {},
      );
    }
    const vj = visionJpeg(id, slide.index);
    if (!existsSync(vj)) {
      await mkdir(visionDir(id), { recursive: true });
      await runFfmpeg(id, ["-i", src, "-vf", "scale='min(1280,iw)':-2", "-q:v", "3", vj]).catch(
        () => {},
      );
    }
  }
  slide.thumb = existsSync(thumb) ? `thumbs/${nn(slide.index)}.jpg` : undefined;
}

async function transcribeSlide(
  meta: PostMeta,
  slide: Slide,
  user: SessionUser,
): Promise<void> {
  if (slide.kind !== "video" || slide.transcript.status === "done") return;
  if (slide.hasAudio === false) {
    slide.transcript = { status: "skipped" };
    return;
  }
  const id = meta.id;
  const wav = wavPath(id, slide.index);
  try {
    await runFfmpeg(id, [
      "-i",
      abs(id, slide.file),
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "wav",
      wav,
    ]);
    const audio = await readFile(wav);
    const result = await transcribeWav(audio, user);
    if ("error" in result) throw new Error(result.error);
    const words: TranscriptWord[] = result.words.map((w) => ({
      text: w.text,
      start: w.start,
      end: w.end,
    }));
    await mkdir(transcriptsDir(id), { recursive: true });
    await writeFile(transcriptPath(id, slide.index), JSON.stringify({ words }));
    slide.transcript = { status: "done", words: words.length };
  } catch (e) {
    slide.transcript = { status: "error", error: errorMessage(e).slice(0, 300) };
  } finally {
    await rm(wav, { force: true }).catch(() => {});
  }
}

async function visionSlide(
  meta: PostMeta,
  slide: Slide,
  user: SessionUser,
  signal: AbortSignal,
): Promise<void> {
  if (slide.vision.status === "done") return;
  const id = meta.id;
  const images: VisionImage[] = [];
  let frameTimes: number[] | undefined;
  try {
    if (slide.kind === "image") {
      const p = existsSync(visionJpeg(id, slide.index))
        ? visionJpeg(id, slide.index)
        : abs(id, slide.file);
      images.push({ jpegBase64: (await readFile(p)).toString("base64") });
    } else {
      frameTimes = frameSampleTimes(slide.durationS ?? 0, VISION_FRAMES);
      for (const t of frameTimes) {
        if (signal.aborted) throw new AiProviderError("Stopped", "ABORTED", false);
        const buf = await extractClipJpegFrame({
          src: abs(id, slide.file),
          cacheDir: postFramesDir(id, slide.index),
          atMs: Math.round(t * 1000),
        });
        images.push({ jpegBase64: buf.toString("base64") });
      }
    }
    const packText = await packInstructions(user.username, "analyzer.ideas", meta.projectId ?? null);
    const { value, provider } = await completeVisionWithFallback(
      packText ? `${VISION_SYSTEM}\n\n${packText}` : VISION_SYSTEM,
      visionUserText({
        creator: meta.creator.username,
        kind: meta.kind,
        index: slide.index,
        total: meta.slides.length,
        slideKind: slide.kind,
        durationS: slide.durationS,
        caption: meta.caption,
        frameTimes,
      }),
      images,
      signal,
      parseVisionPayload,
      user,
    );
    slide.vision = {
      status: "done",
      onScreenText: value.onScreenText || undefined,
      textKind: value.textKind,
      description: value.description || undefined,
      hook: slide.index === 0 ? value.hook : undefined,
      frames: frameTimes?.length,
      provider,
    };
    bumpUsage(user.username, { aiRuns: 1 });
  } catch (e) {
    if (e instanceof AiProviderError && e.code === "ABORTED") throw e;
    slide.vision = { status: "error", error: errorMessage(e).slice(0, 300) };
  }
}

async function setStep(meta: PostMeta, step: PostStep, progress: number): Promise<void> {
  meta.step = step;
  meta.progress = progress;
  await persist(meta);
}

async function loadPostInfo(
  meta: PostMeta,
  mode: IngestMode,
  username: string,
  signal?: AbortSignal,
): Promise<{ raw: unknown; info: PostInfo }> {
  if (meta.platform === "youtube") {
    // YouTube always goes through Apify, whatever mode Instagram uses.
    const ref = parseYoutubeUrl(meta.url);
    if (!ref) throw new InstagramError("Not a YouTube link", "NOT_FOUND", false);
    return fetchYoutubeViaApify(ref, { username, signal });
  }
  const pre = infoPrefetch.get(meta.id);
  infoPrefetch.delete(meta.id);
  if (pre) {
    const hit = await pre.catch(() => null);
    if (hit) return hit;
  }
  return postBatcherFor(username).request(meta.url, meta.kind === "reel");
}

async function findAccount(
  user: SessionUser,
  igUserId: string,
  username: string,
): Promise<AccountMeta | null> {
  // The user's own record first: an admin also sees other owners' copies of the same handle.
  const all = (await allAccounts())
    .filter((a) => listedAccount(a, user))
    .sort((a, b) => Number(b.owner === user.username) - Number(a.owner === user.username));
  if (igUserId) {
    const byId = all.find((a) => a.igUserId && a.igUserId === igUserId);
    if (byId) return byId;
  }
  const handle = username.toLowerCase();
  return all.find((a) => a.username.toLowerCase() === handle) ?? null;
}

let accountLock: Promise<void> = Promise.resolve();

/** Serialized: two posts by the same creator in flight at once must share one account. */
async function ensureAccountForCreator(meta: PostMeta, user: SessionUser): Promise<void> {
  const prev = accountLock;
  let release!: () => void;
  accountLock = new Promise<void>((r) => (release = r));
  await prev;
  try {
    await ensureAccountForCreatorUnlocked(meta, user);
  } finally {
    release();
  }
}

async function ensureAccountForCreatorUnlocked(
  meta: PostMeta,
  user: SessionUser,
): Promise<void> {
  const username = meta.creator.username;
  const igUserId = meta.creator.id;
  if (!username && !igUserId) return;
  const existing = await findAccount(user, igUserId, username);
  const now = Date.now();
  const acc =
    existing ??
    ({
      id: randomUUID(),
      igUserId: igUserId || username,
      username: username || "instagram",
      fullName: meta.creator.fullName,
      owner: user.username,
      ...(meta.projectId ? { projectId: meta.projectId } : {}),
      tags: [],
      counts: { fetchedAt: 0 },
      status: "ready",
      progress: 1,
      createdAt: now,
      updatedAt: now,
    } satisfies AccountMeta);
  if (!existing) await persistAccount(acc);
  else if (username && acc.username !== username) {
    acc.username = username;
    if (meta.creator.fullName) acc.fullName = meta.creator.fullName;
    await persistAccount(acc);
  }
  meta.accountId = acc.id;
  if (acc.mine) delete meta.projectId;
  await saveCatalog(acc.id, mergeLibraryIntoCatalog(await loadCatalog(acc.id), [meta]));
}

async function recordPostSnapshot(meta: PostMeta, source: IngestMode): Promise<void> {
  await appendSnapshot(
    snapshotsPath(meta.id),
    snapshotFromCounts(meta.counts, source),
  );
}

function applyProfile(acc: AccountMeta, info: ProfileInfo): void {
  acc.igUserId = info.igUserId || acc.igUserId;
  acc.username = info.username || acc.username;
  acc.fullName = info.fullName ?? acc.fullName;
  acc.biography = info.biography ?? acc.biography;
  acc.profilePic = info.profilePic ?? acc.profilePic;
  acc.isPrivate = info.isPrivate ?? acc.isPrivate;
  acc.isVerified = info.isVerified ?? acc.isVerified;
  acc.counts = {
    followers: info.followers,
    following: info.following,
    posts: info.posts,
    fetchedAt: Date.now(),
  };
}

async function cacheAvatar(acc: AccountMeta, picUrl: string | undefined, signal?: AbortSignal): Promise<void> {
  if (!picUrl) return;
  try {
    await mkdir(accountDir(acc.id), { recursive: true });
    await downloadToFile(picUrl, accountAvatarPath(acc.id), {
      maxBytes: Math.min(THUMB_MAX_BYTES, 2 * 1024 * 1024),
      signal,
      fallbackMime: "image/jpeg",
    });
  } catch {
    /* keep the initial circle — CDN URLs expire and hotlink */
  }
}

async function snapshotAccount(acc: AccountMeta, source: Snapshot["source"]): Promise<void> {
  await appendSnapshot(accountSnapshotsPath(acc.id), {
    at: Date.now(),
    source,
    followers: acc.counts.followers,
    following: acc.counts.following,
    posts: acc.counts.posts,
  });
}

type AccountPullMode = IngestMode | "graph";

async function refreshProfile(
  acc: AccountMeta,
  url: string,
  mode: AccountPullMode,
  user: string,
  signal?: AbortSignal,
): Promise<void> {
  const info = await loadProfile(acc.username, url, mode, user, signal);
  applyProfile(acc, info);
  await cacheAvatar(acc, info.profilePic, signal);
  await snapshotAccount(acc, mode);
}

async function loadProfile(
  username: string,
  url: string,
  mode: AccountPullMode,
  user: string,
  signal?: AbortSignal,
): Promise<ProfileInfo> {
  if (mode === "graph") return fetchMineProfile({ signal });
  return fetchProfileViaApify(url, { username: user, signal });
}

async function fetchAccountFeed(
  acc: AccountMeta,
  url: string,
  mode: AccountPullMode,
  user: string,
  cap: number,
  signal?: AbortSignal,
  after?: string,
  since?: number,
): Promise<CatalogPage> {
  if (mode === "graph") {
    if (!after) return fetchMineCatalogAll({ signal, since });
    return fetchMineCatalog({ cap, after, signal });
  }
  return fetchCatalogViaApify(url, { username: user, cap, signal });
}

async function accountPullMode(user: string, acc: { mine?: boolean; owner?: string }): Promise<AccountPullMode> {
  if (mineUsesGraph(acc)) return "graph";
  const gate = await ingestGate(user);
  if (!gate.ok) throw new InstagramError(gate.error, "APIFY", false);
  return gate.mode;
}

async function enrichMineCatalog(
  items: CatalogItem[],
  acc: AccountMeta,
  user: string,
  signal?: AbortSignal,
  known: CatalogItem[] = [],
): Promise<CatalogItem[]> {
  const knownCodes = new Set(known.map((row) => row.shortcode));
  const fresh = knownCodes.size ? items.filter((row) => !knownCodes.has(row.shortcode)) : items;
  const needShared = items
    .filter((row) => row.graphId && typeof row.isSharedToFeed !== "boolean")
    .map((row) => row.graphId!);
  // trial or public from the official login's is_shared_to_feed only: no crawl of Instagram's web pages, no paid scrape
  const shared = await fetchMineSharedToFeed(needShared, { signal });
  let classified = applyMineVisibility(items, shared);
  // returned by this fetch without insights read in it (nested insights can fail) — else they freeze
  const insightIds = classified
    .filter((row) => row.graphId && row.graph && row.graph.seenAt > (row.graph.insightsAt ?? 0))
    .map((row) => row.graphId!);
  if (insightIds.length) {
    try {
      const extra = await fetchMineInsights(insightIds, { signal });
      const readAt = Date.now();
      classified = classified.map((row) => {
        const insights = row.graphId ? extra.get(row.graphId) : undefined;
        if (!insights || !row.graph) return row;
        return {
          ...row,
          insights,
          graph: { ...row.graph, insightsAt: readAt },
          counts: { ...row.counts, plays: row.counts.plays ?? insights.views },
        };
      });
    } catch {
      /* nested insights already tried on /media */
    }
  }
  const commentIds = (knownCodes.size ? fresh : classified)
    .map((row) => row.graphId)
    .filter((id): id is string => Boolean(id));
  try {
    const comments = await fetchMineComments(commentIds, { signal });
    const byShortcode: Record<string, Comment[]> = {};
    for (const row of classified) {
      if (!row.graphId) continue;
      const list = comments.get(row.graphId);
      if (list?.length) byShortcode[row.shortcode] = list;
    }
    if (Object.keys(byShortcode).length) await saveGraphComments(acc.id, byShortcode);
  } catch {
    /* catalog still useful without comment threads */
  }
  return classified;
}

async function ownerMine(user: SessionUser): Promise<AccountMeta | null> {
  return (await allAccounts()).find((a) => ownMine(a, user)) ?? null;
}

type ProjectScope = Awaited<ReturnType<typeof projectScope>>;

/**
 * What one project's view holds. An account belongs to
 * the project that links it as its Instagram, else the one it was added in, else to every project; a post saved
 * with no project follows the account that posted it. "My account" is no longer in every project: only in its own.
 * No project = everything.
 */
async function projectScope(user: SessionUser, projectId?: string) {
  const links = projectId ? await accountProjects(user.username) : new Map<string, string>();
  const accounts = (await allAccounts()).filter((a) => a.owner === user.username);
  const home = (a: AccountMeta) => links.get(a.id) ?? a.projectId;
  const accountIn = (a: AccountMeta) => !projectId || !home(a) || home(a) === projectId;
  const elsewhere = projectId ? accounts.filter((a) => !accountIn(a)) : [];
  const mine = accounts.find((a) => ownMine(a, user)) ?? null;
  return {
    accountIn,
    mine: mine && accountIn(mine) ? mine : null,
    postIn: (m: PostMeta) => !projectId || m.projectId === projectId || !elsewhere.some((a) => accountOwnsPost(a, m)),
  };
}

/** Listed posts in a project. Know-how posts only when `shelf` asks for them. */
async function metasInProject(
  user: SessionUser,
  projectId?: string,
  focus?: AccountMeta | null,
  shelf: Shelf = "library",
): Promise<PostMeta[]> {
  const scope = await projectScope(user, projectId);
  return (await allMetas()).filter(
    (m) => onShelf(m, shelf) && listedFor(m, user) && scope.postIn(m) && postInProject(m, projectId, { focus, mine: scope.mine }),
  );
}

function catalogItemFromPost(meta: PostMeta): CatalogItem {
  return {
    shortcode: meta.shortcode || meta.id,
    url: meta.url,
    kind: meta.kind,
    takenAt: meta.takenAt || meta.createdAt,
    thumbnailUrl: meta.slides[0]?.thumb ? `/api/instagram/${meta.id}/thumb/0` : undefined,
    captionPreview: meta.caption.split("\n")[0]?.slice(0, 180) || undefined,
    counts: {
      likes: meta.counts.likes,
      comments: meta.counts.comments,
      plays: meta.counts.plays,
    },
    starred: meta.starred,
    postId: meta.id,
    ideaStatus: meta.ideaStatus,
    rank: meta.rank,
  };
}

function mergeLibraryIntoCatalog(catalog: CatalogItem[], posts: PostMeta[]): CatalogItem[] {
  const map = new Map<string, CatalogItem>();
  for (const row of catalog) map.set(row.shortcode, row);
  for (const p of posts) {
    const key = p.shortcode || p.id;
    const item = catalogItemFromPost(p);
    const old = map.get(key);
    map.set(key, {
      ...(old ?? item),
      ...item,
      starred: old?.starred || item.starred,
      thumbnailUrl: item.thumbnailUrl || old?.thumbnailUrl,
      captionPreview: item.captionPreview || old?.captionPreview,
      caption: old?.caption ?? item.caption,
      graphId: old?.graphId ?? item.graphId,
      // raw Graph values (CDN URLs) — thumbnailUrl above is the local thumb path
      graph: old?.graph ?? item.graph,
      visibility: old?.visibility ?? item.visibility,
      visibilityBasis: old?.visibility ? old.visibilityBasis : item.visibilityBasis,
      isSharedToFeed: old?.isSharedToFeed ?? item.isSharedToFeed,
      insights: old?.insights ?? item.insights,
      counts: { ...old?.counts, ...item.counts },
      prevCounts: old?.prevCounts,
      postId: p.id,
      ideaStatus: item.ideaStatus ?? old?.ideaStatus,
      rank: item.rank ?? old?.rank,
    });
  }
  return [...map.values()].sort((a, b) => {
    if (Boolean(a.postId) !== Boolean(b.postId)) return a.postId ? -1 : 1;
    return (b.takenAt || 0) - (a.takenAt || 0);
  });
}

async function tagPost(meta: PostMeta, user: SessionUser, signal: AbortSignal): Promise<void> {
  const packText = await packInstructions(user.username, "analyzer.ideas", meta.projectId ?? null);
  const tags = await completeWithFallback(packText ? `${TAGS_SYSTEM}\n\n${packText}` : TAGS_SYSTEM, await postReadText(meta), signal, parseTagsPayload, aiFor(user, "analyzer", "Analyzer tags"));
  meta.tags = mergeTags(meta.tags, tags);
  bumpUsage(user.username, { aiRuns: 1 });
}

async function libraryIdeaFolders(user: SessionUser, exceptId = ""): Promise<Array<{ title: string; takeaway: string }>> {
  const byTitle = new Map<string, { title: string; takeaway: string }>();
  for (const m of await allMetas()) {
    if ((exceptId && m.id === exceptId) || !listedFor(m, user)) continue;
    const title = m.idea?.title?.trim();
    const takeaway = m.idea?.takeaway?.trim();
    if (!title || !takeaway || byTitle.has(title)) continue;
    byTitle.set(title, { title, takeaway });
  }
  return [...byTitle.values()];
}

function ideaBoardPath(username: string, projectId?: string): string {
  return igUserFile(username, projectId ? `idea-board-${projectId}.json` : "idea-board.json");
}

async function readIdeaBoard(user: SessionUser, projectId?: string): Promise<IdeaBoard> {
  const files = projectId
    ? [ideaBoardPath(user.username, projectId), ideaBoardPath(user.username)]
    : [ideaBoardPath(user.username)];
  const known = new Set(
    (await metasInProject(user, projectId)).map((m) => m.id),
  );
  for (const file of files) {
    try {
      const raw = JSON.parse(await readFile(file, "utf-8")) as IdeaBoard;
      if (!raw || !Array.isArray(raw.ideas)) continue;
      return {
        generatedAt: typeof raw.generatedAt === "number" ? raw.generatedAt : 0,
        ideas: raw.ideas
          .filter((i) => i && typeof i.title === "string" && Array.isArray(i.postIds))
          .map((i) => ({
            id: typeof i.id === "string" ? i.id : randomUUID(),
            title: i.title,
            description: typeof i.description === "string" ? i.description : "",
            postIds: i.postIds.filter((id) => known.has(id)),
          }))
          .filter((i) => i.postIds.length),
      };
    } catch {
      /* try next */
    }
  }
  return { generatedAt: 0, ideas: [] };
}

async function writeIdeaBoard(user: SessionUser, board: IdeaBoard, projectId?: string): Promise<void> {
  await mkdir(igCredsDir(user.username), { recursive: true });
  await writeFile(ideaBoardPath(user.username, projectId), JSON.stringify(board));
}

function ideaCatalog(metas: PostMeta[]): IdeaCatalogRow[] {
  return [...metas]
    .sort((a, b) => (b.rank ?? -1) - (a.rank ?? -1) || virality(b.counts) - virality(a.counts))
    .slice(0, 80)
    .map((m) => ({
      id: m.id,
      kind: m.kind,
      handle: m.creator.username,
      ideaTitle: m.idea?.title,
      ideaTakeaway: m.idea?.takeaway,
      hook: m.slides[0]?.vision.hook,
      caption: m.caption?.slice(0, 160),
    }));
}

/** Source post ids already in this user's workshop sessions. */
async function workshopSourcePostIds(user: SessionUser): Promise<Set<string>> {
  const root = path.join(env.dataDir, "workshop", "sessions");
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return new Set();
  }
  const taken = new Set<string>();
  await Promise.all(
    names.map(async (id) => {
      try {
        const raw = JSON.parse(await readFile(path.join(root, id, "meta.json"), "utf-8")) as {
          owner?: string;
          sources?: Array<{ postId?: string }>;
        };
        if (!raw || (user.role !== "admin" && raw.owner !== user.username)) return;
        for (const s of raw.sources ?? []) {
          if (typeof s.postId === "string" && s.postId) taken.add(s.postId);
        }
      } catch {
        /* missing or junk session dir */
      }
    }),
  );
  return taken;
}

const boardLocks = new Map<string, Promise<IdeaBoard>>();

async function generateIdeaBoard(
  user: SessionUser,
  signal?: AbortSignal,
  projectId?: string,
): Promise<IdeaBoard> {
  const key = `${user.username}:${projectId ?? ""}`;
  const pending = boardLocks.get(key);
  if (pending) return pending;
  const run = generateIdeaBoardNow(user, signal, projectId).finally(() => boardLocks.delete(key));
  boardLocks.set(key, run);
  return run;
}

async function generateIdeaBoardNow(
  user: SessionUser,
  signal?: AbortSignal,
  projectId?: string,
): Promise<IdeaBoard> {
  if (!anyAiConfigured(user)) throw new Error("No AI provider is set up for you (Settings → AI providers)");
  const metas = (await metasInProject(user, projectId)).filter((m) => !m.duplicateOf);
  const taken = await workshopSourcePostIds(user);
  const catalog = ideaCatalog(metas.filter((m) => !taken.has(m.id)));
  if (!catalog.length) {
    const board: IdeaBoard = { generatedAt: Date.now(), ideas: [] };
    await writeIdeaBoard(user, board, projectId);
    return board;
  }
  const previous = omitWorkshopPiles((await readIdeaBoard(user, projectId)).ideas, taken);
  // the Analyzer's AI provider (Admin → AI providers), its usage on the board
  let usage: MacUsage | undefined;
  const mac = aiFor(user, "analyzer", "Idea board");
  const packText = await packInstructions(user.username, "analyzer.ideas", projectId ?? null);
  const parsed = await completeWithFallback(
    packText ? `${IDEA_BOARD_SYSTEM}\n\n${packText}` : IDEA_BOARD_SYSTEM,
    ideaBoardUserMessage(catalog, previous.length ? previous : undefined),
    signal,
    (text) => parseIdeaBoard(text, catalog.map((p) => p.id)),
    mac && { ...mac, onUsage: (u) => (usage = u) },
  );
  bumpUsage(user.username, { aiRuns: 1 });
  const board: IdeaBoard = {
    generatedAt: Date.now(),
    ideas: parsed.map((i) => ({ ...i, id: randomUUID() })),
    ...(usage ? { usage } : {}),
  };
  await writeIdeaBoard(user, board, projectId);
  return board;
}

async function ideaPost(meta: PostMeta, user: SessionUser, signal: AbortSignal): Promise<void> {
  const text = await postReadText(meta);
  const folders = await libraryIdeaFolders(user, meta.id);
  const titles = folders.map((f) => f.title);
  const packText = await packInstructions(user.username, "analyzer.ideas", meta.projectId ?? null);
  const idea = await completeWithFallback(
    packText ? `${IDEA_SYSTEM}\n\n${packText}` : IDEA_SYSTEM,
    ideaUserMessage(text, folders),
    signal,
    (answer) => parseIdeaPayload(answer, titles),
    aiFor(user, "analyzer", "Analyzer filing"),
  );
  // a new folder name may still be a topic the library already has
  const tsKey = typesafeFor(user);
  if (tsKey && folders.length && !titles.includes(idea.title)) {
    const existing = await existingFolderFor(tsKey, text, idea, folders, signal).catch((e) => {
      console.warn(`[instagram] folder check failed, keeping the new folder: ${errorMessage(e)}`);
      return null;
    });
    if (existing) idea.title = existing;
  }
  meta.idea = idea;
  bumpUsage(user.username, { aiRuns: 1 });
}

async function postReadText(meta: PostMeta): Promise<string> {
  const parts = [
    `Creator: @${meta.creator.username}`,
    `Kind: ${meta.kind}`,
    meta.caption ? `Caption: ${meta.caption.slice(0, 1500)}` : "",
  ];
  for (const s of meta.slides) {
    if (s.vision.hook) parts.push(`Hook: ${s.vision.hook}`);
    if (s.vision.onScreenText) parts.push(`On-screen${s.vision.textKind === "captions" ? " (only subtitles of what is said)" : ""}: ${s.vision.onScreenText.slice(0, 400)}`);
    if (s.vision.description) parts.push(`Slide: ${s.vision.description}`);
    if (s.transcript.status === "done") {
      const words = await loadTranscript(meta.id, s.index);
      if (words.length) parts.push(`Transcript: ${words.map((w) => w.text).join(" ").slice(0, 800)}`);
    }
  }
  return parts.filter(Boolean).join("\n");
}

async function cachedInfo(meta: PostMeta): Promise<PostInfo | null> {
  try {
    const raw = JSON.parse(await readFile(infoPath(meta.id), "utf-8")) as Record<string, unknown>;
    if (!raw || typeof raw !== "object") return null;
    if (meta.platform === "youtube") {
      const ref = parseYoutubeUrl(meta.url);
      return ref ? normalizeYoutubeItem(raw, ref) : null;
    }
    // an Apify item; anything else (read some other way before) is read again
    return "shortCode" in raw || "shortcode" in raw || "childPosts" in raw ? normalizeApifyPost(raw, meta.url) : null;
  } catch {
    return null;
  }
}

async function processPost(id: string): Promise<void> {
  const meta = active.get(id);
  if (!meta) return;
  const user = jobUsers.get(id)!;
  const requested = expandJobs(jobKinds.get(id) ?? meta.recipe?.jobs ?? ["info", "stats"]);
  const opts = jobOpts.get(id) ?? {};
  const ac = new AbortController();
  aborts.set(id, ac);
  const signal = ac.signal;
  let stopCrawl = () => {};
  const still = () => active.get(id) === meta && !signal.aborted;
  let fetched: { raw: unknown; info: PostInfo } | undefined;
  try {
    const gate = await ingestGate(user.username);
    if (!gate.ok) throw new InstagramError(gate.error, "APIFY", false);
    // YouTube has no album to crawl: its thumbnail is the one slide, so the slide always exists.
    const youtube = meta.platform === "youtube";
    const srcMode = youtube ? "apify" : gate.mode;
    const includeSlides = requested.includes("media") || youtube;

    const ensureInfo = async (): Promise<PostInfo> => {
      if (fetched) return fetched.info;
      const hadShortcode = Boolean(meta.shortcode);
      await setStep(meta, "info", 0.06);
      fetched = await loadPostInfo(meta, gate.mode, user.username, signal);
      await writeFile(infoPath(id), JSON.stringify(fetched.raw)).catch(() => {});
      applyInfo(meta, fetched.info, includeSlides);
      // A YouTube channel is not an Instagram account; never file it as one.
      if (!youtube) await ensureAccountForCreator(meta, user);
      await persist(meta);
      if (!hadShortcode && meta.shortcode) {
        const dup = await findByShortcode(meta.shortcode, user, meta.id);
        if (dup) {
          meta.duplicateOf = dup.id;
          throw new Error("This post is already in your library");
        }
      }
      return fetched.info;
    };

    for (const job of requested) {
      if (!still()) return;
      const already = isJobDone(meta.jobs, job);
      if (already && !opts.force && !(job === "comments" && opts.more) && job !== "stats") continue;
      if (job === "stats" && already && !opts.force && requested.length > 1 && fetched) {
        meta.jobs = patchJob(meta.jobs, job, { status: "done" });
        continue;
      }
      if (SKIP_FOR_DUPLICATES.has(job) && meta.duplicateOf) {
        if (opts.force || opts.ignoreDuplicate) {
          reopenSkippedParts(meta);
        } else {
          meta.jobs = patchJob(meta.jobs, job, { status: "skipped", error: undefined });
          await persist(meta);
          continue;
        }
      }
      if (youtube && job === "comments") {
        meta.comments = { ...meta.comments, status: "skipped" };
        meta.jobs = patchJob(meta.jobs, job, { status: "skipped" });
        continue;
      }
      meta.jobs = patchJob(meta.jobs, job, { status: "running", error: undefined });
      await persist(meta);
      try {
        if (job === "info") {
          const info = await ensureInfo();
          await recordPostSnapshot(meta, srcMode);
          if (!includeSlides) {
            for (const s of meta.slides) {
              s.transcript = { status: "skipped" };
              s.vision = { status: "skipped" };
            }
            if (meta.comments.status === "pending") meta.comments = { ...meta.comments, status: "skipped" };
          }
          void info;
        } else if (job === "stats") {
          const info = fetched ? fetched.info : await ensureInfo();
          if (!fetched) {
            applyInfo(meta, info, false);
          }
          meta.counts = { ...info.counts, fetchedAt: Date.now() };
          await recordPostSnapshot(meta, srcMode);
        } else if (job === "media") {
          let info = fetched?.info ?? (await cachedInfo(meta));
          if (!info) info = await ensureInfo();
          applyInfo(meta, info, true);
          await setStep(meta, "download", 0.1);
          if (youtube) await downloadYoutubeThumb(meta, info, signal);
          else await downloadSlides(meta, info, signal);
          if (!still()) return;
          await setStep(meta, "thumbs", 0.45);
          for (const slide of meta.slides) {
            await prepareSlide(meta, slide, info.slides[slide.index]?.coverUrl, signal);
            if (!still()) return;
          }
          await fingerprintPost(meta);
          if (!still()) return;
          if (!opts.force && !opts.ignoreDuplicate) {
            const dup = await findSameMedia(meta, user);
            if (dup) markDuplicate(meta, dup);
            else if (meta.duplicateOf && !(await readMeta(meta.duplicateOf))) meta.duplicateOf = undefined;
          }
        } else if (job === "transcript") {
          if (youtube) {
            const info = fetched?.info ?? (await cachedInfo(meta)) ?? (await ensureInfo());
            if (await saveYoutubeTranscript(meta, info)) {
              meta.jobs = patchJob(meta.jobs, job, { status: "done" });
            } else {
              pushWarning(meta, "No transcript yet: YouTube has no captions for this video, and the server cannot download its audio");
              meta.jobs = patchJob(meta.jobs, job, { status: "skipped" });
            }
            await persist(meta);
            continue;
          }
          for (const slide of meta.slides) {
            if (
              slide.kind === "video" &&
              slide.transcript.status === "done" &&
              !existsSync(transcriptPath(id, slide.index))
            ) {
              slide.transcript = { status: "pending" };
            }
          }
          const videos = meta.slides.filter(
            (s) => s.kind === "video" && s.transcript.status === "pending",
          );
          if (!videos.length) {
            meta.jobs = patchJob(meta.jobs, job, { status: "skipped" });
            continue;
          }
          const blocked = cloudTranscribeBlock(user);
          if (blocked) {
            for (const s of videos) s.transcript = { status: "skipped" };
            pushWarning(meta, `Transcripts skipped — ${blocked}`);
            meta.jobs = patchJob(meta.jobs, job, { status: "skipped" });
            continue;
          }
          await setStep(meta, "transcribe", 0.52);
          stopCrawl = crawlProgress(meta, 0.7);
          await mapLimit(videos, 2, async (slide) => {
            if (!still()) return;
            await transcribeSlide(meta, slide, user);
            await persist(meta);
          });
          stopCrawl();
        } else if (job === "vision") {
          const pending = meta.slides.filter((s) => s.vision.status === "pending" || (opts.force && s.file));
          if (opts.force) {
            for (const s of pending) s.vision = { status: "pending" };
          }
          const work = meta.slides.filter((s) => s.vision.status === "pending");
          if (!work.length) {
            meta.jobs = patchJob(meta.jobs, job, { status: "skipped" });
            continue;
          }
          if (!anyVisionConfigured(user)) {
            for (const s of work) s.vision = { status: "skipped" };
            pushWarning(meta, "Slide text skipped — no vision-capable AI key is configured");
            meta.jobs = patchJob(meta.jobs, job, { status: "skipped" });
            continue;
          }
          await setStep(meta, "vision", 0.7);
          stopCrawl = crawlProgress(meta, 0.88);
          await mapLimit(work, 2, async (slide) => {
            if (!still()) return;
            await visionSlide(meta, slide, user, signal);
            await persist(meta);
          });
          cleanPostSlideText(meta.slides, meta.creator);
          stopCrawl();
        } else if (job === "comments") {
          await setStep(meta, "comments", 0.88);
          stopCrawl = crawlProgress(meta, 0.98);
          await collectCommentsForPost(meta, gate.mode, user.username, signal, opts.more === true);
          stopCrawl();
        } else if (job === "tags") {
          if (!anyAiConfigured(user)) {
            pushWarning(meta, "Tags skipped — no AI key is configured");
            meta.jobs = patchJob(meta.jobs, job, { status: "skipped" });
            continue;
          }
          await setStep(meta, "vision", 0.9);
          await tagPost(meta, user, signal);
        } else if (job === "idea") {
          if (!anyAiConfigured(user)) {
            pushWarning(meta, "Idea skipped — no AI key is configured");
            meta.jobs = patchJob(meta.jobs, job, { status: "skipped" });
            continue;
          }
          await setStep(meta, "idea", 0.94);
          await ideaPost(meta, user, signal);
        }
        if (job !== "comments") {
          const failedPart =
            job === "transcript"
              ? meta.slides.some((s) => s.transcript.status === "error")
              : job === "vision"
                ? meta.slides.some((s) => s.vision.status === "error")
                : false;
          meta.jobs = patchJob(meta.jobs, job, {
            status: failedPart ? "error" : "done",
            error: failedPart ? "One or more slides failed" : undefined,
          });
        } else {
          meta.jobs = patchJob(meta.jobs, job, {
            status: meta.comments.status === "failed" ? "error" : "done",
            error: meta.comments.error,
          });
        }
        await persist(meta);
      } catch (e) {
        if (e instanceof InstagramError && e.code === "CANCELLED") throw e;
        meta.jobs = patchJob(meta.jobs, job, {
          status: "error",
          error: errorMessage(e).slice(0, 300),
        });
        throw e;
      }
    }

    if (!still()) return;
    await writeSearchText(meta);
    await saveEmbedding(meta);
    meta.status = "ready";
    meta.step = undefined;
    meta.progress = 1;
    meta.error = undefined;
    if (
      !meta.idea &&
      !meta.duplicateOf &&
      !meta.knowhow &&
      anyAiConfigured(user) &&
      jobStatusOf(meta.jobs, "idea") === "idle"
    ) {
      const user = jobUsers.get(id);
      if (user) {
        const prev = followUps.get(id);
        followUps.set(id, {
          user: prev?.user ?? user,
          jobs: expandJobs([...(prev?.jobs ?? []), "idea"]),
          opts: prev?.opts ?? {},
        });
        meta.jobs = patchJob(meta.jobs, "idea", { status: "pending" });
      }
    }
    await persist(meta);
  } catch (e) {
    stopCrawl();
    if (active.get(id) !== meta) return;
    meta.status = "error";
    meta.step = undefined;
    meta.error = errorMessage(e);
    await persist(meta);
    console.warn(`[instagram] ${meta.shortcode || meta.input} failed: ${meta.error}`);
  } finally {
    stopCrawl();
    active.delete(id);
    aborts.delete(id);
    jobUsers.delete(id);
    jobKinds.delete(id);
    jobOpts.delete(id);
    for (const p of children.get(id) ?? []) p.kill("SIGKILL");
    children.delete(id);
    const next = followUps.get(id);
    followUps.delete(id);
    if (next && existsSync(metaPath(id))) {
      enqueue(meta, next.user, next.jobs, next.opts);
      await persist(meta).catch(() => {});
    }
  }
}

/**
 * Collect comments on the user's Apify key and store them with the low-value filter applied.
 * Never fatal for the post: a failure leaves `comments.status = "failed"`
 * plus a warning, and the UI offers Re-fetch.
 */
async function collectCommentsForPost(
  meta: PostMeta,
  mode: IngestMode,
  username: string,
  signal: AbortSignal,
  more: boolean,
): Promise<void> {
  if (meta.counts.comments === 0) {
    meta.comments = { status: "complete", count: 0, replies: 0, fetchedAt: Date.now() };
    await persist(meta);
    return;
  }
  const existing = await loadComments(meta.id);
  const have = existing?.comments.length ?? 0;
  const cap = more ? have + countReplies(existing?.comments ?? []) + MAX_COMMENTS : MAX_COMMENTS;
  try {
    const result: { comments: Comment[]; status: CommentsFile["status"]; cursor?: string } = await fetchCommentsViaApify(meta.url, { username, cap, signal });
    const merged = mergeComments(existing?.comments ?? [], result.comments);
    // Jev scores new comments; the word filter decides without a key
    const { filteredOut, questions, keywords } = await annotateComments(typesafeFor(username), merged, { caption: meta.caption, handle: meta.creator.username }, signal);
    const file: CommentsFile = {
      status: result.status,
      fetchedAt: Date.now(),
      total: meta.counts.comments,
      cursor: result.cursor,
      comments: merged,
    };
    await writeFile(commentsPath(meta.id), JSON.stringify(file));
    meta.comments = {
      status: result.status,
      count: merged.length,
      replies: countReplies(merged),
      filteredOut,
      questions,
      keywords,
      fetchedAt: Date.now(),
    };
    meta.warnings = (meta.warnings ?? []).filter((w) => !w.startsWith("Comments:"));
  } catch (e) {
    if (signal.aborted || (e instanceof InstagramError && e.code === "CANCELLED")) throw e;
    const message = errorMessage(e).slice(0, 300);
    meta.comments = {
      ...meta.comments,
      status: "failed",
      error: message,
      fetchedAt: Date.now(),
    };
    pushWarning(meta, `Comments: ${message}`);
    console.warn(`[instagram] ${meta.shortcode} comments failed: ${message}`);
  }
  await persist(meta);
}

function enqueue(
  meta: PostMeta,
  user: SessionUser,
  jobs: JobType[],
  opts: JobOptions = {},
): void {
  active.set(meta.id, meta);
  jobUsers.set(meta.id, user);
  const expanded = expandJobs(jobs);
  jobKinds.set(meta.id, expanded);
  jobOpts.set(meta.id, opts);
  if (!isJobDone(meta.jobs, "info") || opts.force || expanded.includes("stats")) {
    prefetchInfo(meta, user);
  }
  meta.status = "processing";
  meta.step = "queued";
  meta.progress = jobs.length === 1 && jobs[0] === "comments" ? 0.88 : 0;
  meta.error = undefined;
  if (!queue.some((q) => q.kind === "post" && q.id === meta.id)) {
    queue.push({ kind: "post", id: meta.id });
  }
  pump();
}

function enqueueAccount(
  meta: AccountMeta,
  user: SessionUser,
  jobs: AccountJobType[],
  opts: { count?: number; more?: boolean } = {},
): void {
  accountActive.set(meta.id, meta);
  jobUsers.set(`a:${meta.id}`, user);
  accountJobKinds.set(meta.id, jobs);
  accountJobOpts.set(meta.id, opts);
  meta.status = "processing";
  meta.step = "queued";
  meta.progress = 0;
  meta.error = undefined;
  if (!queue.some((q) => q.kind === "account" && q.id === meta.id)) {
    queue.push({ kind: "account", id: meta.id });
  }
  pump();
}

/** Queue a run, or — if the post is already running — remember it for right after. */
function queueOrFollowUp(
  meta: PostMeta,
  user: SessionUser,
  jobs: JobType[],
  opts: JobOptions,
): "started" | "queued" {
  if (!active.has(meta.id)) {
    enqueue(meta, user, jobs, opts);
    return "started";
  }
  const prev = followUps.get(meta.id);
  const merged = expandJobs([...(prev?.jobs ?? []), ...jobs]);
  followUps.set(meta.id, {
    user,
    jobs: merged,
    opts: {
      force: Boolean(prev?.opts.force || opts.force),
      more: Boolean(prev?.opts.more || opts.more),
      ignoreDuplicate: Boolean(prev?.opts.ignoreDuplicate || opts.ignoreDuplicate),
    },
  });
  for (const t of merged) meta.jobs = patchJob(meta.jobs, t, { status: "pending" });
  return "queued";
}

function queueOrFollowUpAccount(
  meta: AccountMeta,
  user: SessionUser,
  jobs: AccountJobType[],
  opts: { count?: number; more?: boolean },
): "started" | "queued" {
  if (!accountActive.has(meta.id)) {
    enqueueAccount(meta, user, jobs, opts);
    return "started";
  }
  const prev = accountFollowUps.get(meta.id);
  const merged = [...new Set([...(prev?.jobs ?? []), ...jobs])];
  accountFollowUps.set(meta.id, {
    user,
    jobs: merged,
    opts: { count: opts.count ?? prev?.opts.count, more: Boolean(prev?.opts.more || opts.more) },
  });
  // Patch only the named jobs (like the post side): a running one keeps its status, the others keep their errors until re-queued.
  meta.jobs = merged.reduce<NonNullable<AccountMeta["jobs"]>>(
    (list, type) => {
      if (list.find((j) => j.type === type)?.status === "running") return list;
      return [...list.filter((j) => j.type !== type), { type, status: "pending" as JobStatus }];
    },
    [...(meta.jobs ?? [])],
  );
  return "queued";
}

function pump(): void {
  while (running < MAX_CONCURRENT && queue.length > 0) {
    const item = queue.shift()!;
    if (item.kind === "post" && !active.has(item.id)) continue;
    if (item.kind === "account" && !accountActive.has(item.id)) continue;
    running++;
    const run = item.kind === "account" ? processAccount(item.id) : processPost(item.id);
    void run.catch(() => {}).finally(() => {
      running--;
      pump();
    });
  }
}

function cancel(id: string): void {
  const at = queue.findIndex((q) => q.kind === "post" && q.id === id);
  if (at >= 0) queue.splice(at, 1);
  // Terminal on disk too: a cancelled run must not look "processing" to the boot pass.
  const live = active.get(id);
  if (live) {
    live.status = move(POST_STATUS_MOVES, live.status, "error", "post");
    live.step = undefined;
    live.error = "Cancelled";
    live.jobs = (live.jobs ?? []).map((j) =>
      j.status === "running" || j.status === "pending" ? { ...j, status: "error" as JobStatus, error: "Cancelled" } : j,
    );
    void persist(live).catch(() => {});
  }
  active.delete(id);
  aborts.get(id)?.abort();
  aborts.delete(id);
  for (const p of children.get(id) ?? []) p.kill("SIGKILL");
  children.delete(id);
  jobUsers.delete(id);
  jobKinds.delete(id);
  jobOpts.delete(id);
  followUps.delete(id);
  infoPrefetch.delete(id);
}

async function processAccount(id: string): Promise<void> {
  const meta = accountActive.get(id);
  if (!meta) return;
  // the account's own Meta login when it has one (Settings → Connectors), else the install's
  return withGraphCreds(graphCredsFor(meta), () => processAccountWith(id, meta));
}

async function processAccountWith(id: string, meta: NonNullable<ReturnType<typeof accountActive.get>>): Promise<void> {
  const user = jobUsers.get(`a:${id}`)!;
  const jobs = accountJobKinds.get(id) ?? ["profile", "catalog"];
  const opts = accountJobOpts.get(id) ?? {};
  const ac = new AbortController();
  aborts.set(`a:${id}`, ac);
  const signal = ac.signal;
  try {
    const mode = await accountPullMode(user.username, meta);
    const url = canonicalProfileUrl(meta.username);
    for (const job of jobs) {
      meta.step = job;
      meta.progress = job === "profile" ? 0.2 : job === "catalog" ? 0.5 : 0.8;
      await persistAccount(meta);
      if (job === "profile") {
        await refreshProfile(meta, url, mode, user.username, signal);
      } else if (job === "catalog" || job === "stats") {
        await refreshProfile(meta, url, mode, user.username, signal);
        const existing = await loadCatalog(meta.id);
        if (job === "stats") {
          if (existing.length > 0) {
            const page = await fetchAccountFeed(
              meta,
              url,
              mode,
              user.username,
              mode === "graph" ? MINE_CATALOG_CAP : existing.length,
              signal,
            );
            const library = (await allMetas()).filter((m) => listedFor(m, user) && accountOwnsPost(meta, m));
            let merged = mergeLibraryIntoCatalog(
              mode === "graph" ? mergeCatalog(existing, page.items) : mergeCatalogCounts(existing, page.items),
              library,
            );
            if (mode === "graph") {
              merged = await enrichMineCatalog(merged, meta, user.username, signal);
              meta.catalogHasMore = page.more;
              if (page.nextMaxId) meta.catalogCursor = page.nextMaxId;
              else if (!page.more) meta.catalogCursor = undefined;
            }
            await saveCatalog(meta.id, merged);
            if (mode === "graph") {
              // a full Graph pull: keep the incremental catalog watermark in step
              const newest = catalogNewestAt(merged);
              if (newest && !page.more) meta.catalogNewestAt = newest;
              meta.lastCatalogAt = Date.now();
              await refreshMineGraphStats(meta.id, signal);
            }
          }
        } else {
          const pageSize =
            meta.mine || mode === "graph" ? MINE_CATALOG_CAP : parseCatalogCount(opts.count);
          const watermark =
            meta.catalogHasMore === false
              ? (meta.catalogNewestAt ?? catalogNewestAt(existing))
              : undefined;
          const incremental = Boolean(meta.mine && !opts.more && existing.length && watermark);
          let cap = incremental && mode === "apify" ? 100 : pageSize;
          let after: string | undefined;
          if (opts.more) {
            if (mode !== "apify" && meta.catalogCursor) {
              after = meta.catalogCursor;
              cap = pageSize;
            } else {
              cap = existing.length + pageSize;
            }
          }
          const page = await fetchAccountFeed(
            meta,
            url,
            mode,
            user.username,
            cap,
            signal,
            after,
            incremental ? watermark : undefined,
          );
          if (!incremental) {
            if (page.nextMaxId) meta.catalogCursor = page.nextMaxId;
            else if (!page.more) meta.catalogCursor = undefined;
            meta.catalogHasMore = page.more;
          }
          const library = (await allMetas()).filter((m) => listedFor(m, user) && accountOwnsPost(meta, m));
          let merged = mergeLibraryIntoCatalog(mergeCatalog(existing, page.items), library);
          if (mode === "graph") {
            merged = await enrichMineCatalog(
              merged,
              meta,
              user.username,
              signal,
              incremental ? existing : [],
            );
          }
          await saveCatalog(meta.id, merged);
          const newest = catalogNewestAt(merged);
          if (newest && meta.catalogHasMore === false) meta.catalogNewestAt = newest;
          meta.lastCatalogAt = Date.now();
          if (mode === "graph") await refreshMineGraphStats(meta.id, signal);
        }
      } else if (job === "tags") {
        if (!anyAiConfigured(user)) throw new Error("Tags skipped — no AI key is configured");
        const catalog = await loadCatalog(meta.id);
        const captions = catalog
          .slice(0, 12)
          .map((c) => c.captionPreview)
          .filter(Boolean)
          .join("\n");
        const packText = await packInstructions(user.username, "analyzer.ideas", meta.projectId ?? null);
        const tags = await completeWithFallback(
          packText ? `${TAGS_SYSTEM}\n\n${packText}` : TAGS_SYSTEM,
          [`@${meta.username}`, meta.biography || "", captions].filter(Boolean).join("\n"),
          signal,
          parseTagsPayload,
          aiFor(user, "analyzer", "Analyzer tags"),
        );
        meta.tags = mergeTags(meta.tags, tags);
        bumpUsage(user.username, { aiRuns: 1 });
      }
    }
    meta.status = "ready";
    meta.step = undefined;
    meta.progress = 1;
    meta.error = undefined;
    await persistAccount(meta);
  } catch (e) {
    if (accountActive.get(id) !== meta) return;
    meta.status = "error";
    meta.step = undefined;
    meta.error = errorMessage(e);
    await persistAccount(meta);
    console.warn(`[instagram] account @${meta.username} failed: ${meta.error}`);
  } finally {
    accountActive.delete(id);
    aborts.delete(`a:${id}`);
    jobUsers.delete(`a:${id}`);
    accountJobKinds.delete(id);
    accountJobOpts.delete(id);
    const next = accountFollowUps.get(id);
    accountFollowUps.delete(id);
    if (next && existsSync(accountDir(id))) {
      enqueueAccount(meta, next.user, next.jobs, next.opts);
      await persistAccount(meta).catch(() => {});
    }
    if (!accountActive.has(id)) settleIdle(id);
  }
}

/* ---- retention ---- */

async function sweep(): Promise<void> {
  const now = Date.now();
  const hour = 3600 * 1000;
  for (const id of await allIds()) {
    if (active.has(id)) continue;
    const dir = postDir(id);
    if (!existsSync(metaPath(id))) {
      const st = await stat(dir).catch(() => null);
      if (st && now - st.mtimeMs > hour) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
      continue;
    }
    for (const sub of [dir, mediaDir(id), thumbsDir(id)]) {
      const names = await readdir(sub).catch(() => [] as string[]);
      for (const name of names) {
        if (!/\.(part|download)$/.test(name) && !/^audio-\d+\.wav$/.test(name)) continue;
        const p = path.join(sub, name);
        const st = await stat(p).catch(() => null);
        if (st && now - st.mtimeMs > hour) await rm(p, { force: true }).catch(() => {});
      }
    }
    if (KEEP_DAYS > 0) {
      const meta = await readMeta(id);
      if (meta && meta.status !== "processing" && now - meta.createdAt > KEEP_DAYS * 86400 * 1000) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}
void sweep();
setInterval(() => void sweep(), 6 * 3600 * 1000).unref();

/* ---- resume after a restart ---- */

function sessionUserFor(owner: string | undefined): SessionUser | null {
  if (!env.appSecret) return LOCAL_USER;
  if (!owner) return null;
  const rec = findUser(owner);
  return rec && sessionOf(rec);
}

/**
 * A deploy or crash used to leave every in-flight post as "Interrupted by
 * a server restart". Instead, re-queue the jobs that were pending or
 * running when the process died, so work started from the UI finishes
 * without anyone watching.
 */
async function resumeInterrupted(): Promise<void> {
  let resumed = 0;
  for (const id of await allIds()) {
    if (active.has(id)) continue;
    let meta: PostMeta;
    try {
      meta = JSON.parse(await readFile(metaPath(id), "utf-8")) as PostMeta;
    } catch {
      continue;
    }
    if (meta.status !== "processing") continue;
    const pending = (meta.jobs ?? [])
      .filter((j) => j.status === "running" || j.status === "pending")
      .map((j) => j.type);
    const user = sessionUserFor(meta.owner);
    if (!pending.length || !user) {
      // Nothing to resume: fail the post and its open jobs, so Retry offers them.
      meta.status = move(POST_STATUS_MOVES, meta.status, "error", "post");
      meta.step = undefined;
      meta.error = RESTART_MSG;
      meta.jobs = (meta.jobs ?? []).map((j) =>
        j.status === "running" || j.status === "pending" ? { ...j, status: "error" as JobStatus, error: RESTART_MSG } : j,
      );
      await persist(meta);
      continue;
    }
    pushWarning(meta, "Resumed after a server restart");
    enqueue(meta, user, pending, {});
    await persist(meta);
    resumed++;
  }
  if (resumed) console.log(`[instagram] resumed ${resumed} interrupted post job(s)`);
  // Accounts have no resume path: a run cut off by the restart fails, with its open jobs.
  for (const id of await allAccountIds()) {
    if (accountActive.has(id)) continue;
    let meta: AccountMeta;
    try {
      meta = JSON.parse(await readFile(accountMetaPath(id), "utf-8")) as AccountMeta;
    } catch {
      continue;
    }
    if (meta.status !== "processing") continue;
    meta.status = "error";
    meta.step = undefined;
    meta.error = RESTART_MSG;
    meta.jobs = (meta.jobs ?? []).map((j) =>
      j.status === "running" || j.status === "pending" ? { ...j, status: "error" as JobStatus, error: RESTART_MSG } : j,
    );
    await persistAccount(meta);
  }
}
setTimeout(() => void resumeInterrupted().catch(() => {}), 1500).unref();

/** Older posts were saved before fingerprints existed; hash them once so duplicates are caught. */
async function backfillFingerprints(): Promise<void> {
  let done = 0;
  for (const id of await allIds()) {
    if (active.has(id)) continue;
    let meta: PostMeta;
    try {
      meta = JSON.parse(await readFile(metaPath(id), "utf-8")) as PostMeta;
    } catch {
      continue;
    }
    if (meta.status === "processing") continue;
    if (!meta.slides.some((s) => s.file && !s.fingerprint)) continue;
    if (!(await fingerprintPost(meta))) continue;
    await afterWrite(id, async () => {
      if (active.has(id)) return;
      await writeFile(metaPath(id), JSON.stringify(meta)).catch(() => {});
    });
    done++;
  }
  if (done) console.log(`[instagram] fingerprinted media on ${done} post(s)`);
}
setTimeout(() => void backfillFingerprints().catch(() => {}), 8000).unref();

/** Earlier builds could create one account per in-flight post; fold those into one. */
async function mergeDuplicateAccounts(): Promise<void> {
  const groups = new Map<string, AccountMeta[]>();
  for (const a of await allAccounts()) {
    const key = `${a.owner}|${a.username.toLowerCase()}`;
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  let merged = 0;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort(
      (a, b) =>
        (b.counts.fetchedAt > 0 ? 1 : 0) - (a.counts.fetchedAt > 0 ? 1 : 0) || a.createdAt - b.createdAt,
    );
    const keep = list[0]!;
    if (keep.status === "processing" || list.some((a) => accountActive.has(a.id))) continue;
    let catalog = await loadCatalog(keep.id);
    for (const dup of list.slice(1)) {
      catalog = mergeCatalog(catalog, await loadCatalog(dup.id));
      if (!keep.igUserId || keep.igUserId === keep.username) keep.igUserId = dup.igUserId || keep.igUserId;
      keep.fullName ||= dup.fullName;
      for (const m of await allMetas()) {
        if (m.accountId !== dup.id) continue;
        m.accountId = keep.id;
        await persist(m);
      }
      await rm(accountDir(dup.id), { recursive: true, force: true }).catch(() => {});
      merged++;
    }
    await saveCatalog(keep.id, catalog);
    await persistAccount(keep);
  }
  if (merged) console.log(`[instagram] merged ${merged} duplicate account(s)`);
}
setTimeout(() => void mergeDuplicateAccounts().catch(() => {}), 4000).unref();

function settleIdle(id: string): void {
  const waiters = idleWaiters.get(id);
  idleWaiters.delete(id);
  for (const done of waiters ?? []) done();
}

/* ---- streaming ---- */

/**
 * `maxAge` in seconds. A post's slides and thumbnails keep 30 days.
 */
async function streamFile(
  c: { req: { header: (h: string) => string | undefined } },
  p: string,
  type: string,
  maxAge = 3600,
): Promise<Response> {
  const st = await stat(p);
  const size = st.size;
  const range = c.req.header("range");
  const base = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Cache-Control": `private, max-age=${maxAge}`,
    "Last-Modified": new Date(st.mtimeMs).toUTCString(),
    ETag: `"${size}-${Math.floor(st.mtimeMs)}"`,
  };
  const body = (start: number, end: number) =>
    Readable.toWeb(createReadStream(p, { start, end })) as unknown as ReadableStream;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m?.[1] ? parseInt(m[1], 10) : 0;
    const end = Math.min(m?.[2] ? parseInt(m[2], 10) : size - 1, size - 1);
    if (start >= size || start > end) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }
    return new Response(body(start, end), {
      status: 206,
      headers: {
        ...base,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }
  return new Response(body(0, size - 1), {
    headers: { ...base, "Content-Length": String(size) },
  });
}

/* ---- routes: capability + Apify key (before /:id) ---- */

instagramApp.get("/availability", async (c) => {
  const user = c.get("user");
  const snap = await availabilitySnapshot(user.username);
  return c.json({
    available: snap.available,
    allowed: user.role === "admin",
    cloud: !cloudTranscribeBlock(user),
    cloudWhy: cloudTranscribeBlock(user) ?? undefined,
    ai: anyVisionConfigured(user),
    apify: snap.apify,
    graph: { configured: graphConfigured() },
    limits: {
      maxSlideMb: Math.round(MAX_SLIDE_BYTES / 1024 / 1024),
      maxPostMb: Math.round(MAX_POST_BYTES / 1024 / 1024),
    },
  });
});

/** What the workers are doing right now, for the queue dock. In-memory only. */
instagramApp.get("/queue", async (c) => {
  const user = c.get("user");
  const queuedKeys = new Set(queue.map((q) => `${q.kind}:${q.id}`));
  const items: Array<{
    kind: "post" | "account";
    id: string;
    label: string;
    detail: string;
    state: "running" | "queued" | "failed";
    step?: string;
    progress: number;
    next?: string[];
    error?: string;
    /** Failed items: which jobs errored, so a retry can target them. */
    jobs?: string[];
    at?: number;
  }> = [];
  for (const [id, m] of active) {
    if (!listedFor(m, user)) continue;
    items.push({
      kind: "post",
      id,
      label: m.creator.username ? `@${m.creator.username}` : m.shortcode || m.input,
      detail: (m.caption.split("\n").find((l) => l.trim()) ?? "").slice(0, 80),
      state: queuedKeys.has(`post:${id}`) ? "queued" : "running",
      step: m.step,
      progress: m.progress,
      next: followUps.get(id)?.jobs,
    });
  }
  for (const [id, m] of accountActive) {
    if (!listedAccount(m, user)) continue;
    items.push({
      kind: "account",
      id,
      label: `@${m.username}`,
      detail: m.fullName ?? "",
      state: queuedKeys.has(`account:${id}`) ? "queued" : "running",
      step: m.step,
      progress: m.progress,
      next: accountFollowUps.get(id)?.jobs,
    });
  }
  items.sort((a, b) => (a.state === b.state ? 0 : a.state === "running" ? -1 : 1));
  const failed: typeof items = [];
  for (const m of await allMetas()) {
    if (m.status !== "error" || active.has(m.id) || !listedFor(m, user)) continue;
    failed.push({
      kind: "post",
      id: m.id,
      label: m.creator.username ? `@${m.creator.username}` : m.shortcode || m.input,
      detail: (m.caption.split("\n").find((l) => l.trim()) ?? "").slice(0, 80),
      state: "failed",
      progress: 0,
      error: (m.error ?? "Failed").slice(0, 200),
      jobs: (m.jobs ?? []).filter((j) => j.status === "error").map((j) => j.type),
      at: m.updatedAt,
    });
  }
  for (const a of await allAccounts()) {
    if (a.status !== "error" || accountActive.has(a.id) || !listedAccount(a, user)) continue;
    failed.push({
      kind: "account",
      id: a.id,
      label: `@${a.username}`,
      detail: a.fullName ?? "",
      state: "failed",
      progress: 0,
      error: (a.error ?? "Failed").slice(0, 200),
      jobs: (a.jobs ?? []).filter((j) => j.status === "error").map((j) => j.type),
      at: a.updatedAt,
    });
  }
  failed.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  return c.json({ running, max: MAX_CONCURRENT, items: [...items, ...failed.slice(0, 50)] });
});

instagramApp.get("/apify", async (c) => {
  const username = c.get("user").username;
  return c.json(publicApifyStatus(await readApify(username)));
});

instagramApp.put("/apify", async (c) => {
  const username = c.get("user").username;
  const body = (await c.req.json().catch(() => null)) as { token?: unknown } | null;
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (token.length < 8) {
    return c.json(
      { error: "Paste an Apify API token from console.apify.com → Settings → Integrations" },
      400,
    );
  }
  const stored: StoredApify = {
    token,
    savedAt: Date.now(),
    savedBy: username,
    valid: null,
    source: "file",
  };
  await writeApify(username, stored);
  const checked = await checkApify(username);
  return c.json(publicApifyStatus(checked ?? stored));
});

instagramApp.put("/apify/slow", async (c) => {
  const username = c.get("user").username;
  const body = (await c.req.json().catch(() => null)) as { slow?: unknown } | null;
  const next = await updateApify(username, (s) => ({ ...s, slow: body?.slow === true }));
  if (!next) return c.json({ error: "No Apify token saved" }, 404);
  return c.json(publicApifyStatus(next));
});

instagramApp.post("/apify/check", async (c) => {
  const username = c.get("user").username;
  const checked = await checkApify(username);
  if (!checked) return c.json({ error: "No Apify token saved" }, 404);
  return c.json(publicApifyStatus(checked));
});

instagramApp.delete("/apify", async (c) => {
  const username = c.get("user").username;
  await clearApify(username);
  return c.json(publicApifyStatus(await readApify(username)));
});

/* ---- routes: library ---- */

instagramApp.get("/", async (c) => {
  const user = c.get("user");
  const q = (c.req.query("q") || "").trim();
  const account = (c.req.query("account") || "").trim();
  const tag = (c.req.query("tag") || "").trim().toLowerCase();
  const sort = (c.req.query("sort") || "pulled").trim();
  const starred = c.req.query("starred") === "1";
  const idea = parseIdeaStatus(c.req.query("idea"));
  const savedFor = parseSavedFor(c.req.query("savedFor"));
  const stack = (c.req.query("stack") || "").trim();
  const shelf = parseShelf(c.req.query("shelf"));
  const projectId = queryProjectId(c);
  const focus = account
    ? okId(account)
      ? await ownedAccount(account, user)
      : await findAccount(user, "", account.replace(/^@/, ""))
    : null;
  const metas = await metasInProject(user, projectId, focus, shelf);
  for (const m of metas) {
    if (!m.accountId && (m.creator.id || m.creator.username)) {
      await ensureAccountForCreator(m, user);
      await persist(m);
    }
  }
  let out = metas;
  if (account && !focus) {
    out = out.filter(
      (m) => m.accountId === account || m.creator.username.toLowerCase() === account.replace(/^@/, "").toLowerCase(),
    );
  }
  if (starred) out = out.filter((m) => m.starred);
  if (idea) out = out.filter((m) => ideaStatusOf(m.ideaStatus) === idea);
  if (savedFor?.length) out = out.filter((m) => savedFor.every((k) => matchesSavedFor(m.savedFor, k)));
  if (stack) out = out.filter((m) => m.stackId === stack);
  if (tag) {
    out = out.filter((m) => (m.tags ?? []).some((t) => t.label.toLowerCase() === tag || `${t.kind}:${t.label}`.toLowerCase() === tag));
  }
  if (q) {
    const kept: PostMeta[] = [];
    for (const m of out) {
      const hay =
        (await readSearchText(m.id)) ||
        buildSearchText([`@${m.creator.username}`, m.creator.fullName, m.caption, tagsHaystack(m.tags)]);
      if (matchesQuery(q, hay)) kept.push(m);
    }
    out = kept;
  }
  out.sort((a, b) => {
    if (sort === "posted") return (b.takenAt || 0) - (a.takenAt || 0);
    if (sort === "plays" || sort === "virality") return virality(b.counts) - virality(a.counts);
    if (sort === "rank") return (b.rank ?? -1) - (a.rank ?? -1);
    if (sort === "account") return (a.creator.username || "").localeCompare(b.creator.username || "");
    if (sort === "age") return (b.ageAtPullMs || 0) - (a.ageAtPullMs || 0);
    return (b.pulledAt || b.createdAt) - (a.pulledAt || a.createdAt);
  });
  return c.json(out.map(publicMeta));
});

type IngestOne =
  | { ok: true; meta: PostMeta; existing?: boolean }
  | { ok: false; error: string; status: 400 | 409 | 500 };

async function ingestOne(
  input: string,
  user: SessionUser,
  mode: IngestMode,
  queued: Map<string, PostMeta>,
  recipe: Recipe,
  run: "now" | "later",
  projectId?: string,
  keep?: KeepChoice,
): Promise<IngestOne> {
  let ytRef: YoutubeRef | null;
  let parsed: ReturnType<typeof parseInstagramUrl> | null = null;
  try {
    ytRef = parseYoutubeUrl(input);
    if (!ytRef) parsed = parseInstagramUrl(input);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof InstagramUrlError || e instanceof YoutubeUrlError ? e.message : "Invalid link",
      status: 400,
    };
  }
  if (parsed?.kind === "profile") {
    return { ok: false, error: "Use Add account for profile links", status: 400 };
  }
  const shortcode = ytRef ? `yt-${ytRef.videoId}` : parsed?.kind === "post" ? parsed.shortcode : "";
  const reelHint = ytRef ? ytRef.short : parsed?.kind === "post" ? parsed.reelHint : false;
  const url = ytRef ? ytRef.canonical : parsed?.kind === "post" ? parsed.canonical : (parsed?.url ?? "");
  if (shortcode && queued.has(shortcode)) {
    return { ok: true, meta: queued.get(shortcode)!, existing: true };
  }
  if (shortcode) {
    const existing = await findByShortcode(shortcode, user);
    if (existing) {
      const mineAcc = await ownerMine(user);
      if (projectId && !existing.projectId && !(mineAcc && accountOwnsPost(mineAcc, existing))) {
        existing.projectId = projectId;
        await persist(existing);
      }
      queued.set(shortcode, existing);
      return { ok: true, meta: existing, existing: true };
    }
  }
  if (wants(recipe, "media") && (await libraryBytes()) >= MAX_TOTAL_BYTES) {
    return {
      ok: false,
      error: `The Instagram library is over its ${Math.round(MAX_TOTAL_BYTES / 1024 ** 3)} GB quota — delete some posts first`,
      status: 409,
    };
  }
  const id = randomUUID();
  const now = Date.now();
  const later = run === "later";
  const meta: PostMeta = {
    id,
    owner: user.username,
    ...(projectId ? { projectId } : {}),
    ...(ytRef ? { platform: "youtube" as const } : {}),
    status: later ? "ready" : "processing",
    step: later ? undefined : "queued",
    progress: later ? 0 : 0,
    input,
    url,
    shortcode,
    mediaId: shortcode && !ytRef ? shortcodeToMediaId(shortcode) : "",
    kind: reelHint ? "reel" : "post",
    creator: { username: "", id: "" },
    takenAt: 0,
    caption: "",
    counts: { fetchedAt: 0 },
    slides: [],
    comments: {
      status: wants(recipe, "comments") ? "pending" : "skipped",
      count: 0,
      replies: 0,
    },
    bytes: 0,
    createdAt: now,
    updatedAt: now,
    recipe,
    jobs: jobRecords(recipe, later ? "pending" : "pending"),
    source: parsed?.kind === "share" ? "share" : "paste",
    tags: [],
    ideaStatus: "inbox",
  };
  if (keep) applyKeep(meta, keep);
  try {
    await mkdir(postDir(id), { recursive: true });
    await persist(meta);
  } catch (e) {
    await rm(postDir(id), { recursive: true, force: true }).catch(() => {});
    return { ok: false, error: errorMessage(e), status: 500 };
  }
  if (shortcode) queued.set(shortcode, meta);
  if (!later) enqueue(meta, user, recipe.jobs);
  return { ok: true, meta };
}

instagramApp.post("/", async (c) => {
  const user = c.get("user");
  const body = (await c.req.json().catch(() => null)) as {
    url?: unknown;
    urls?: unknown;
    recipe?: unknown;
    run?: unknown;
    projectId?: unknown;
    savedFor?: unknown;
    knowhow?: unknown;
  } | null;
  const keep = parseKeep(body);
  if (!keep) return c.json({ error: "Kept for must be content, format, both, or Know-how" }, 400);
  const chunks: string[] = [];
  if (Array.isArray(body?.urls)) {
    for (const u of body.urls) if (typeof u === "string") chunks.push(u);
  }
  if (typeof body?.url === "string") chunks.push(body.url);
  const blob = chunks.join("\n");
  const inputs = [...new Set([...extractInstagramUrls(blob, MAX_BATCH + 1), ...extractYoutubeUrls(blob, MAX_BATCH + 1)])];
  if (!inputs.length) {
    return c.json({ error: "Paste a link to an Instagram post, reel or carousel, or a YouTube video or Short" }, 400);
  }
  if (inputs.length > MAX_BATCH) {
    return c.json({ error: `Paste at most ${MAX_BATCH} links at a time` }, 400);
  }
  const recipe = parseRecipe(body?.recipe);
  const run = parseRunWhen(body?.run);
  const projectId = await resolveProjectId(
    user,
    typeof body?.projectId === "string" ? body.projectId : undefined,
  );
  let mode: IngestMode = "apify";
  if (run === "now") {
    const gate = await ingestGate(user.username);
    if (!gate.ok) return c.json({ error: gate.error, code: gate.code }, 409);
    mode = gate.mode;
  }
  const posts: Array<ReturnType<typeof publicMeta> & { existing?: boolean }> = [];
  const errors: { input: string; error: string }[] = [];
  const queued = new Map<string, PostMeta>();
  let created = 0;
  let toppedUp = 0;
  let failStatus: 400 | 409 | 500 = 400;
  for (const input of inputs) {
    const result = await ingestOne(input, user, mode, queued, recipe, run, projectId, keep);
    if (result.ok) {
      if (result.existing) {
        // Already in the library: run whatever this recipe adds; finished jobs are skipped.
        const moved = applyKeep(result.meta, keep);
        const action = stampExistingPull(result.meta, recipe, run);
        if (action === "enqueue") {
          enqueue(result.meta, user, recipe.jobs);
          toppedUp++;
        }
        if (action !== "skip" || moved) await persist(result.meta);
      }
      posts.push({ ...publicMeta(result.meta), existing: result.existing === true });
      if (!result.existing) created++;
    } else {
      errors.push({ input, error: result.error });
      failStatus = result.status;
    }
  }
  if (!posts.length) {
    return c.json({ error: errors[0]?.error || "Ingest failed", errors }, failStatus);
  }
  return c.json({ posts, errors }, (created || toppedUp) && run === "now" ? 202 : 200);
});

/** Why a shared link was saved but not crawled, worded for a phone (no "paste above"). */
function shareLaterReason(code: string): string {
  if (code === "APIFY_INVALID") return "your Apify key needs replacing in Settings → Connectors";
  return "add your Apify key in Settings → Connectors to crawl it";
}

/**
 * POST /share {text, savedFor?, knowhow?}: whatever a phone's share sheet hands
 * over, a bare link or a caption with one inside (the Creator Toolset iPhone
 * app's share extension), and why it is kept: content, format, or Know-how.
 * Post links are saved and crawled now when crawling is set up, otherwise saved
 * for later; with no post link, a profile link adds the account. `message` is
 * the one line the phone shows.
 */
instagramApp.post("/share", async (c) => {
  const user = c.get("user");
  const body = (await c.req.json().catch(() => null)) as {
    text?: unknown;
    savedFor?: unknown;
    knowhow?: unknown;
    projectId?: unknown;
  } | null;
  const text = typeof body?.text === "string" ? body.text : "";
  const keep = parseKeep(body);
  if (!keep) return c.json({ error: "Kept for must be content, format, both, or Know-how" }, 400);
  const gate = await ingestGate(user.username);
  const run = gate.ok ? "now" : "later";
  const later = gate.ok ? "" : ` for later: ${shareLaterReason(gate.code)}`;

  const inputs = [...new Set([...extractInstagramUrls(text, MAX_BATCH), ...extractYoutubeUrls(text, MAX_BATCH)])].slice(0, MAX_BATCH);
  if (inputs.length) {
    // Kept from the phone to read or remake: transcript and slide text come with it.
    const recipe = recipeFromPreset("watch");
    // the project picked on the phone's share card, else the current one
    const projectId = await resolveProjectId(user, typeof body?.projectId === "string" && okId(body.projectId) ? body.projectId : undefined);
    const queued = new Map<string, PostMeta>();
    const posts: ReturnType<typeof publicMeta>[] = [];
    const errors: { input: string; error: string }[] = [];
    let created = 0;
    let moved = false;
    let failStatus: 400 | 409 | 500 = 400;
    for (const input of inputs) {
      const result = await ingestOne(input, user, gate.mode, queued, recipe, run, projectId, keep);
      if (!result.ok) {
        errors.push({ input, error: result.error });
        failStatus = result.status;
        continue;
      }
      if (!result.existing) created++;
      else {
        const changed = applyKeep(result.meta, keep);
        moved ||= changed;
        // Shared again: refresh its numbers, as a paste would.
        const refresh = run === "now" && stampExistingPull(result.meta, recipe, run) === "enqueue";
        if (refresh) enqueue(result.meta, user, recipe.jobs);
        if (refresh || changed) await persist(result.meta);
      }
      posts.push(publicMeta(result.meta));
    }
    if (!posts.length) return c.json({ error: errors[0].error, errors }, failStatus);
    const where = keepLabel(posts[0]);
    const saved = `${created > 1 ? `Saved ${created} posts` : "Saved"} to ${where}`;
    const message = created
      ? gate.ok
        ? where === "Know-how" ? saved : `${saved}, crawling now`
        : `${saved}${later}`
      : moved
        ? `Already in your library, moved to ${where}`
        : "Already in your library";
    return c.json({ message, posts, accounts: [], errors }, created && gate.ok ? 202 : 200);
  }

  const profile = extractInstagramProfiles(text, 1)[0];
  if (profile) {
    const result = await addAccountFor(user, profile, { run, mine: false });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    const name = `@${result.meta.username}`;
    const message = result.existing
      ? `${name} is already in your library`
      : gate.ok
        ? `Added ${name}, pulling their posts`
        : `Added ${name}${later}`;
    return c.json(
      { message, posts: [], accounts: [publicAccount(result.meta)], errors: [] },
      !result.existing && gate.ok ? 202 : 200,
    );
  }

  return c.json({ error: "No Instagram link in what you shared" }, 400);
});

instagramApp.get("/stacks", async (c) => {
  const user = c.get("user");
  const projectId = queryProjectId(c);
  const posts = await metasInProject(user, projectId);
  const byStack = new Map<string, PostMeta[]>();
  for (const p of posts) {
    if (!p.stackId) continue;
    const list = byStack.get(p.stackId) ?? [];
    list.push(p);
    byStack.set(p.stackId, list);
  }
  const stacks = (await allStacks()).filter((s) => listedStack(s, user) && inProject(s, projectId));
  return c.json(stacks.map((s) => publicStack(s, byStack.get(s.id) ?? [])));
});

instagramApp.post("/stacks", async (c) => {
  const user = c.get("user");
  const body = (await c.req.json().catch(() => null)) as {
    title?: unknown;
    postIds?: unknown;
  } | null;
  const title =
    typeof body?.title === "string" ? body.title.trim().slice(0, 80) : "";
  const ids = Array.isArray(body?.postIds)
    ? body.postIds.filter((id): id is string => typeof id === "string" && okId(id))
    : [];
  if (!title) return c.json({ error: "Name this topic" }, 400);
  if (ids.length < 2) return c.json({ error: "Pick at least two posts to stack" }, 400);
  const now = Date.now();
  const projectId = await resolveProjectId(user);
  const stack: StackMeta = {
    id: randomUUID(),
    title,
    owner: user.username,
    ...(projectId ? { projectId } : {}),
    createdAt: now,
    updatedAt: now,
    ideaStatus: "inbox",
  };
  const members: PostMeta[] = [];
  for (const id of ids) {
    const meta = await ownedMeta(id, user);
    if (!meta) continue;
    meta.stackId = stack.id;
    await persist(meta);
    members.push(meta);
  }
  if (members.length < 2) {
    for (const m of members) {
      delete m.stackId;
      await persist(m);
    }
    return c.json({ error: "Pick at least two posts you own" }, 400);
  }
  await persistStack(stack);
  return c.json(publicStack(stack, members), 201);
});

instagramApp.patch("/stacks/:id", async (c) => {
  const user = c.get("user");
  const stack = await ownedStack(c.req.param("id"), user);
  if (!stack) return c.json({ error: "Not found" }, 404);
  const body = (await c.req.json().catch(() => null)) as {
    title?: unknown;
    add?: unknown;
    remove?: unknown;
    ideaStatus?: unknown;
  } | null;
  if (body && "ideaStatus" in body) {
    const s = parseIdeaStatus(body.ideaStatus);
    if (!s) return c.json({ error: "Status must be inbox, idea, done, or skip" }, 400);
    stack.ideaStatus = s;
    for (const m of await allMetas()) {
      if (m.stackId !== stack.id || !listedFor(m, user)) continue;
      m.ideaStatus = s;
      await persist(m);
    }
  }
  if (typeof body?.title === "string" && body.title.trim()) {
    stack.title = body.title.trim().slice(0, 80);
  }
  await persistStack(stack);
  const add = Array.isArray(body?.add)
    ? body.add.filter((id): id is string => typeof id === "string" && okId(id))
    : [];
  const remove = Array.isArray(body?.remove)
    ? body.remove.filter((id): id is string => typeof id === "string" && okId(id))
    : [];
  for (const id of add) {
    const meta = await ownedMeta(id, user);
    if (!meta) continue;
    meta.stackId = stack.id;
    await persist(meta);
  }
  for (const id of remove) {
    const meta = await ownedMeta(id, user);
    if (!meta || meta.stackId !== stack.id) continue;
    delete meta.stackId;
    await persist(meta);
  }
  const members = (await allMetas()).filter((m) => listedFor(m, user) && m.stackId === stack.id);
  if (members.length < 2) {
    for (const m of members) {
      delete m.stackId;
      await persist(m);
    }
    await rm(stackPath(stack.id), { force: true });
    return c.json({ ok: true, dissolved: true });
  }
  return c.json(publicStack(stack, members));
});

instagramApp.delete("/stacks/:id", async (c) => {
  const user = c.get("user");
  const stack = await ownedStack(c.req.param("id"), user);
  if (!stack) return c.json({ error: "Not found" }, 404);
  for (const m of await allMetas()) {
    if (m.stackId !== stack.id || !listedFor(m, user)) continue;
    delete m.stackId;
    await persist(m);
  }
  await rm(stackPath(stack.id), { force: true });
  return c.json({ ok: true });
});

instagramApp.post("/research", async (c) => {
  const user = c.get("user");
  const body = (await c.req.json().catch(() => null)) as {
    ids?: unknown;
    ideaStatus?: unknown;
    rank?: unknown;
    stackId?: unknown;
    savedFor?: unknown;
    knowhow?: unknown;
  } | null;
  const ids = Array.isArray(body?.ids)
    ? body.ids.filter((id): id is string => typeof id === "string" && okId(id))
    : [];
  if (!ids.length) return c.json({ error: "Pick at least one post" }, 400);
  const posts: PostMeta[] = [];
  for (const id of ids) {
    const meta = await ownedMeta(id, user);
    if (!meta) continue;
    const err = await applyResearch(meta, body ?? {}, user);
    if (err) return c.json({ error: err }, 400);
    await persist(meta);
    posts.push(meta);
  }
  return c.json({ posts: posts.map(publicMeta) });
});

instagramApp.get("/ideas", async (c) => {
  return c.json(await readIdeaBoard(c.get("user"), queryProjectId(c)));
});

instagramApp.post("/ideas", async (c) => {
  try {
    const body = (await c.req.json().catch(() => null)) as { projectId?: unknown } | null;
    const projectId =
      typeof body?.projectId === "string" && okId(body.projectId) ? body.projectId : queryProjectId(c);
    return c.json(await generateIdeaBoard(c.get("user"), undefined, projectId));
  } catch (e) {
    return c.json({ error: errorMessage(e) }, 400);
  }
});

instagramApp.get("/analysis", async (c) => {
  const user = c.get("user");
  const projectId = queryProjectId(c);
  const posts = await metasInProject(user, projectId);
  const scope = await projectScope(user, projectId);
  const accounts = (await allAccounts()).filter((a) => listedAccountIn(a, user, scope));
  const hooks = hookPatterns(
    posts.map((p) => ({
      id: p.id,
      hook: p.slides[0]?.vision.hook || (p.tags ?? []).find((t) => t.kind === "hook")?.label,
      rank: p.rank,
      virality: virality(p.counts),
    })),
  );
  const velocity: Array<{
    id: string;
    username: string;
    caption: string;
    playsPerDay: number;
    elapsedMs: number;
    firstPlays?: number;
    lastPlays?: number;
  }> = [];
  for (const p of posts) {
    const snaps = await loadSnapshots(snapshotsPath(p.id));
    if (snaps.length < 2) continue;
    const first = snaps[0]!;
    const last = snaps[snaps.length - 1]!;
    const rate = playsPerDay(first, last);
    if (rate === undefined) continue;
    velocity.push({
      id: p.id,
      username: p.creator.username,
      caption: p.caption.split("\n")[0]?.slice(0, 80) || p.url,
      playsPerDay: Math.round(rate),
      elapsedMs: last.at - first.at,
      firstPlays: first.plays,
      lastPlays: last.plays,
    });
  }
  velocity.sort((a, b) => Math.abs(b.playsPerDay) - Math.abs(a.playsPerDay));
  const catalogs = await Promise.all(
    accounts.map(async (a) => ({
      id: a.id,
      username: a.username,
      catalog: await loadCatalog(a.id),
    })),
  );
  const cadence = postingCadence(catalogs);
  const mix = catalogs
    .filter((a) => a.catalog.length > 0)
    .map((a) => ({
      accountId: a.id,
      username: a.username,
      ...catalogMix(a.catalog),
      byKind: kindAverages(a.catalog),
      medianPlays: medianPlays(a.catalog),
      postsPerWeek: cadence.find((c) => c.accountId === a.id)?.postsPerWeek,
      medianGapDays: cadence.find((c) => c.accountId === a.id)?.medianGapDays,
    }));
  const duplicates = catalogs.flatMap((a) =>
    detectReposts(
      a.catalog.map((row) => ({
        shortcode: row.shortcode,
        captionPreview: row.captionPreview,
        caption: row.caption,
        kind: row.kind,
        postId: row.postId,
      })),
      posts.map((p) => ({
        id: p.id,
        shortcode: p.shortcode,
        caption: p.caption,
        username: p.creator.username,
        kind: p.kind,
      })),
    ).map((cluster) => ({ ...cluster, accountId: a.id, username: a.username })),
  );
  duplicates.sort((a, b) => b.score - a.score);
  const texts: string[] = [];
  // what commenters say, from Jev's read of each comment
  const commentKinds: Record<string, number> = {};
  const openQuestions: { postId: string; text: string; likes: number; p: number }[] = [];
  for (const p of posts) {
    const file = await loadComments(p.id);
    if (!file) continue;
    const walk = (list: Comment[]) => {
      for (const cm of list) {
        if (!cm.lowValue) texts.push(cm.text);
        if (cm.judged) {
          commentKinds[cm.judged.kind] = (commentKinds[cm.judged.kind] ?? 0) + 1;
          if (cm.judged.needsAnswer >= QUESTION_MIN) {
            openQuestions.push({ postId: p.id, text: cm.text, likes: cm.likeCount, p: cm.judged.needsAnswer });
          }
        }
        if (cm.replies?.length) walk(cm.replies);
      }
    };
    walk(file.comments);
  }
  openQuestions.sort((a, b) => b.likes - a.likes || b.p - a.p);
  return c.json({
    hooks,
    velocity: velocity.slice(0, 24),
    cadence,
    mix,
    duplicates: duplicates.slice(0, 24),
    commentThemes: commentThemes(texts),
    commentKinds,
    topQuestions: openQuestions.slice(0, 12).map(({ postId, text, likes }) => ({ postId, text, likes })),
  });
});

instagramApp.get("/similar", async (c) => {
  const user = c.get("user");
  const q = (c.req.query("q") || "").trim();
  if (q.length < 3) return c.json({ error: "Describe the idea in a few words" }, 400);
  const projectId = queryProjectId(c);
  const query = makeEmbedding(q);
  const scored = [];
  for (const p of await metasInProject(user, projectId)) {
    const emb = await embeddingFor(p);
    scored.push({ post: publicMeta(p), score: cosine(query.vector, emb.vector) });
  }
  scored.sort((a, b) => b.score - a.score);
  return c.json(scored.filter((s) => s.score > 0).slice(0, 24));
});

/**
 * Everything in a research library is the same niche, so "similar" only
 * means near-duplicates: the same media, or text so close it is the same
 * script. Loose topical overlap is what the stacks and tags are for.
 */
const SAME_TEXT_MIN = 0.55;

instagramApp.get("/similar/:id", async (c) => {
  const user = c.get("user");
  const meta = await ownedMeta(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  const mine = await embeddingFor(meta);
  const myFps = meta.slides.map((s) => s.fingerprint);
  const scored: Array<{ post: ReturnType<typeof publicMeta>; score: number; reason: "media" | "text" }> = [];
  for (const p of (await allMetas()).filter((m) => onShelf(m, "library") && listedFor(m, user) && m.id !== meta.id)) {
    const theirs = p.slides.map((s) => s.fingerprint);
    const whole = myFps.length > 0 && myFps.every(Boolean) && samePost(myFps, theirs);
    const anySlide =
      !whole && myFps.some((f) => !!f && theirs.some((t) => !!t && sameMedia(f, t)));
    const text = cosine(mine.vector, (await embeddingFor(p)).vector);
    if (whole || anySlide) scored.push({ post: publicMeta(p), score: Math.max(text, 0.99), reason: "media" });
    else if (text >= SAME_TEXT_MIN) scored.push({ post: publicMeta(p), score: text, reason: "text" });
  }
  scored.sort((a, b) => b.score - a.score);
  return c.json(scored.slice(0, 8));
});

/** Ranked topic search: any query term can match, more terms in better fields rank higher. */
/** What each source has, by part, so the Workshop's AI can decide what to pull. */
export interface SourceIndexEntry {
  id: string;
  handle: string;
  kind: PostKind;
  url: string;
  hook: string;
  has: { slides: number; transcript: number; caption: number; comments: number };
  savedFor?: PostMeta["savedFor"];
  accountId?: string;
}

/**
 * Workshop: transcribe the posts that were never transcribed and wait for it
 * (up to `waitMs`), so the AI reads the words instead of an empty pull.
 */
export async function transcribeForUser(ids: string[], user: SessionUser, waitMs = 90_000): Promise<void> {
  const metas = (await Promise.all(ids.map((id) => ownedMeta(id, user)))).filter(
    (m): m is PostMeta => !!m && !isJobDone(m.jobs, "transcript"),
  );
  if (!metas.length || !(await ingestGate(user.username)).ok) return;
  for (const meta of metas) {
    meta.jobs = patchJob(meta.jobs, "transcript", { status: "pending" });
    queueOrFollowUp(meta, user, ["transcript"], {});
    await persist(meta);
  }
  for (const until = Date.now() + waitMs; Date.now() < until; ) {
    await new Promise((r) => setTimeout(r, 1500));
    const now = await Promise.all(metas.map((m) => readMeta(m.id)));
    if (now.every((m) => !m || ["done", "skipped", "error"].includes(jobStatusOf(m.jobs, "transcript")))) return;
  }
}

export async function sourceIndexForUser(ids: string[], user: SessionUser): Promise<SourceIndexEntry[]> {
  const out: SourceIndexEntry[] = [];
  for (const id of ids) {
    const m = okId(id) ? await readMeta(id) : null;
    if (!m || !canSee(m, user)) continue;
    const slides = m.slides.reduce((n, s) => n + (s.vision.hook?.length ?? 0) + (s.vision.onScreenText?.length ?? 0) + (s.vision.description?.length ?? 0) + (s.caption?.length ?? 0), 0);
    const transcript = m.slides.reduce((n, s) => n + (s.transcript.status === "done" ? (s.transcript.words ?? 0) : 0), 0);
    const hook =
      m.idea?.title?.trim() ||
      m.slides[0]?.vision.hook?.trim() ||
      m.caption.split("\n").find((l) => l.trim())?.trim() ||
      "";
    out.push({
      id: m.id,
      handle: m.creator.username,
      kind: m.kind,
      url: m.url,
      hook: hook.slice(0, 140),
      has: { slides, transcript, caption: m.caption.trim().length, comments: m.comments?.count ?? 0 },
      savedFor: m.savedFor,
      accountId: m.accountId,
    });
  }
  return out;
}

/** Jev's relevance per search, briefly: the search box re-asks as you type. */
const rerankCache = new Map<string, { scores: Map<string, number>; at: number }>();
const RERANK_TTL_MS = 10 * 60_000;
function pruneRerankCache(): void {
  const now = Date.now();
  for (const [k, v] of rerankCache) if (now - v.at > RERANK_TTL_MS) rerankCache.delete(k);
  while (rerankCache.size > 500) rerankCache.delete(rerankCache.keys().next().value!);
}

/** What a post is about, for the re-ranker. */
function rerankText(m: PostMeta): string {
  return [
    m.idea ? `Topic: ${m.idea.title} — ${m.idea.takeaway}` : "",
    m.slides[0]?.vision.hook ? `Hook: ${m.slides[0].vision.hook}` : "",
    m.caption ? `Caption: ${m.caption.slice(0, 700)}` : "",
    m.slides[0]?.vision.description ? `Shows: ${m.slides[0].vision.description.slice(0, 300)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Ranked topic search over the library this user can see (the Workshop's AI uses it too). */
export async function findPostsForUser(
  q: string,
  user: SessionUser,
  opts: { kind?: PostKind; limit?: number; accountId?: string; projectId?: string } = {},
) {
  const focus = opts.accountId ? await ownedAccount(opts.accountId, user) : null;
  const metas = opts.accountId && !focus
    ? []
    : await metasInProject(user, opts.projectId, focus);
  const byId = new Map(metas.map((m) => [m.id, m]));
  const docs: FindDoc[] = [];
  for (const m of metas) docs.push(await findDocFor(m));
  const all = rankFind(q, docs);
  const counts: Record<PostKind, number> = { reel: 0, carousel: 0, post: 0 };
  for (const h of all) counts[byId.get(h.id)!.kind]++;
  const limit = Math.max(1, Math.min(200, opts.limit ?? 80));
  let ranked: ((typeof all)[number] & { relevance?: number })[] = opts.kind
    ? all.filter((h) => byId.get(h.id)!.kind === opts.kind)
    : all;
  // a descriptive search: Jev re-orders the top by what the posts are about
  const tsKey = typesafeFor(user);
  if (tsKey && queryTerms(q).length >= RERANK_MIN_TERMS && ranked.length > 1) {
    const top = ranked.slice(0, RERANK_TOP);
    const key = `${user.username}|${opts.projectId ?? ""}|${q.toLowerCase()}|${top.map((h) => h.id).join(",")}`;
    try {
      let scores = rerankCache.get(key)?.scores;
      if (!scores) {
        scores = await relevance(tsKey, q, top.map((h) => ({ id: h.id, text: rerankText(byId.get(h.id)!) })));
        rerankCache.set(key, { scores, at: Date.now() });
        pruneRerankCache();
      }
      ranked = applyRelevance(ranked, scores);
    } catch (e) {
      console.warn(`[instagram] search re-rank failed, keeping word order: ${errorMessage(e)}`);
    }
  }
  const hits = ranked.slice(0, limit).map((h) => ({
    post: publicMeta(byId.get(h.id)!),
    score: Math.round(h.score * 1000) / 1000,
    matches: h.matches,
    commentsOnly: h.commentsOnly,
    ...(h.relevance !== undefined ? { relevance: h.relevance } : {}),
  }));
  return { hits, counts };
}

instagramApp.get("/find", async (c) => {
  const user = c.get("user");
  const q = (c.req.query("q") || "").trim();
  if (q.length < 2) return c.json({ error: "Type at least two characters" }, 400);
  const kindRaw = c.req.query("kind");
  const kind = kindRaw === "reel" || kindRaw === "carousel" || kindRaw === "post" ? kindRaw : undefined;
  const accountId = (c.req.query("account") || "").trim();
  const limit = Number(c.req.query("limit")) || 80;
  return c.json(
    await findPostsForUser(q, user, {
      kind,
      limit,
      accountId: okId(accountId) ? accountId : undefined,
      projectId: queryProjectId(c),
    }),
  );
});

instagramApp.post("/packs", async (c) => {
  const user = c.get("user");
  const body = (await c.req.json().catch(() => null)) as {
    ids?: unknown;
    perPost?: unknown;
    total?: unknown;
  } | null;
  const ids = Array.isArray(body?.ids)
    ? body.ids.filter((x): x is string => typeof x === "string").slice(0, 40)
    : [];
  if (!ids.length) return c.json({ error: "Pick at least one post" }, 400);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
  try {
    return c.json(await packPostsForUser(ids, user, { perPost: num(body?.perPost), total: num(body?.total) }));
  } catch (e) {
    return c.json({ error: errorMessage(e) }, 400);
  }
});

const publicAccount = (m: AccountMeta, catalogCount = 0) => ({
  ...m,
  profilePic: undefined,
  avatarUrl: existsSync(accountAvatarPath(m.id))
    ? `/api/instagram/accounts/${m.id}/avatar`
    : undefined,
  catalogCount,
});

instagramApp.get("/accounts", async (c) => {
  const user = c.get("user");
  const q = (c.req.query("q") || "").trim().replace(/^@/, "");
  const projectId = queryProjectId(c);
  const scope = await projectScope(user, projectId);
  const list = (await allAccounts()).filter((a) => listedAccountIn(a, user, scope));
  const posts = (await allMetas()).filter((m) => listedFor(m, user));
  const out = [];
  for (const a of list) {
    if (q && !a.username.toLowerCase().includes(q.toLowerCase()) && !a.fullName?.toLowerCase().includes(q.toLowerCase())) {
      continue;
    }
    const catalog = await loadCatalog(a.id);
    const owned = posts.filter((p) => accountOwnsPost(a, p) && (a.mine || inProject(p, projectId))).length;
    out.push({ ...publicAccount(a, Math.max(catalog.length, owned)), libraryCount: owned });
  }
  out.sort((a, b) => Number(!!b.mine) - Number(!!a.mine) || b.updatedAt - a.updatedAt);
  return c.json(out);
});

type AddAccount =
  | { ok: true; meta: AccountMeta; existing: boolean }
  | { ok: false; error: string; code?: string; status: 400 | 409 };

/** Add a profile (URL or @handle) to the library, or find it there; pull it when run is "now". */
async function addAccountFor(
  user: SessionUser,
  raw: string,
  opts: { run: "now" | "later"; mine: boolean; count?: unknown; projectId?: string },
): Promise<AddAccount> {
  const { run, mine } = opts;
  const username = parseProfileHandle(raw) || (raw.startsWith("@") ? raw.slice(1) : "");
  if (!username) {
    return { ok: false, error: "Paste an Instagram profile URL or @username", status: 400 };
  }
  const existing = await findAccount(user, "", username);
  if (run === "now") {
    const pullingMine = mine || existing?.mine === true;
    if (!mineUsesGraph({ mine: pullingMine, owner: existing?.owner ?? user.username, username })) {
      const gate = await ingestGate(user.username);
      if (!gate.ok) return { ok: false, error: gate.error, code: gate.code, status: 409 };
    }
  }
  const now = Date.now();
  const projectId = await resolveProjectId(user, opts.projectId);
  const meta =
    existing ??
    ({
      id: randomUUID(),
      igUserId: "",
      username,
      owner: user.username,
      ...(projectId && !mine ? { projectId } : {}),
      tags: [],
      counts: { fetchedAt: 0 },
      status: run === "later" ? "ready" : "processing",
      progress: run === "later" ? 0 : 0,
      createdAt: now,
      updatedAt: now,
    } satisfies AccountMeta);
  if (!existing) await persistAccount(meta);
  else if (projectId && !meta.projectId && !mine) {
    meta.projectId = projectId;
    await persistAccount(meta);
  }
  if (mine) await assignMine(user.username, meta.id);
  if (run === "now") enqueueAccount(meta, user, ["profile", "catalog"], { count: parseCatalogCount(opts.count) });
  return { ok: true, meta: (await readAccount(meta.id)) ?? meta, existing: !!existing };
}

/**
 * An Instagram account connected through its own Meta login (Settings → Connectors) goes into the Analyzer and is
 * pulled on that login (graphCredsFor). The first one becomes "my account" when there is none yet.
 */
export async function addLoginAccount(user: SessionUser, username: string, projectId?: string): Promise<string | undefined> {
  const r = await addAccountFor(user, `@${username}`, { run: "now", mine: !(await mineAccountId(user)), projectId });
  return r.ok ? r.meta.id : undefined;
}

instagramApp.post("/accounts", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    url?: unknown;
    username?: unknown;
    run?: unknown;
    count?: unknown;
    mine?: unknown;
    projectId?: unknown;
  } | null;
  const raw =
    typeof body?.username === "string"
      ? body.username
      : typeof body?.url === "string"
        ? body.url
        : "";
  const result = await addAccountFor(c.get("user"), raw, {
    run: parseRunWhen(body?.run),
    mine: body?.mine === true,
    count: body?.count,
    projectId: typeof body?.projectId === "string" ? body.projectId : undefined,
  });
  if (!result.ok) {
    const { error, code, status } = result;
    return c.json(code ? { error, code } : { error }, status);
  }
  return c.json(publicAccount(result.meta), result.existing ? 200 : 202);
});

instagramApp.get("/accounts/:id/avatar", async (c) => {
  const meta = await ownedAccount(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  const p = accountAvatarPath(meta.id);
  if (!existsSync(p)) return c.json({ error: "No avatar" }, 404);
  return streamFile(c, p, "image/jpeg");
});

instagramApp.get("/accounts/:id", async (c) => {
  const user = c.get("user");
  const meta = await ownedAccount(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  const posts = (await allMetas()).filter((m) => listedFor(m, user) && accountOwnsPost(meta, m));
  posts.sort((a, b) => (b.takenAt || b.createdAt) - (a.takenAt || a.createdAt));
  for (const p of posts) {
    if (p.accountId === meta.id) continue;
    p.accountId = meta.id;
    await persist(p);
  }
  const catalog = mergeLibraryIntoCatalog(await loadCatalog(meta.id), posts);
  await saveCatalog(meta.id, catalog);
  const snapshots = await loadSnapshots(accountSnapshotsPath(meta.id));
  const library = (await allMetas()).filter((m) => listedFor(m, user));
  const cadence = postingCadence([
    { id: meta.id, username: meta.username, catalog },
  ])[0];
  const [graph, daily] = await Promise.all([loadGraphStats(meta.id), loadGraphDaily(meta.id)]);
  const whatWorks = await whatWorksFor(user, meta, catalog, c.req.raw.signal);
  return c.json({
    ...publicAccount(meta, catalog.length),
    catalog,
    posts: posts.map(publicMeta),
    snapshots,
    insights: {
      cadence: cadence ?? {
        accountId: meta.id,
        username: meta.username,
        count: catalog.length,
      },
      mix: catalogMix(catalog),
      byKind: kindAverages(catalog),
      medianPlays: medianPlays(catalog),
      split: visibilitySplit(catalog),
      graph,
      history: daily?.days,
      whatWorks,
      duplicates: detectReposts(
        catalog.map((row) => ({
          shortcode: row.shortcode,
          captionPreview: row.captionPreview,
          caption: row.caption,
          kind: row.kind,
          postId: row.postId,
        })),
        library.map((p) => ({
          id: p.id,
          shortcode: p.shortcode,
          caption: p.caption,
          username: p.creator.username,
          kind: p.kind,
        })),
      ),
    },
  });
});

instagramApp.post("/accounts/:id/jobs", async (c) => {
  const user = c.get("user");
  const meta = await ownedAccount(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  const body = (await c.req.json().catch(() => null)) as {
    types?: unknown;
    count?: unknown;
    more?: unknown;
  } | null;
  const types: AccountJobType[] = Array.isArray(body?.types)
    ? body.types.filter((t): t is AccountJobType =>
        t === "profile" || t === "catalog" || t === "stats" || t === "tags",
      )
    : ["catalog"];
  if (!types.length) return c.json({ error: "Pick at least one job" }, 400);
  if (!mineUsesGraph(meta)) {
    const gate = await ingestGate(user.username);
    if (!gate.ok) return c.json({ error: gate.error, code: gate.code }, 409);
  }
  queueOrFollowUpAccount(meta, user, types, {
    count: parseCatalogCount(body?.count),
    more: body?.more === true,
  });
  await persistAccount(meta);
  return c.json(publicAccount(meta), 202);
});

instagramApp.post("/accounts/:id/pull", async (c) => {
  const user = c.get("user");
  const meta = await ownedAccount(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  const body = (await c.req.json().catch(() => null)) as {
    shortcodes?: unknown;
    recipe?: unknown;
    run?: unknown;
  } | null;
  const codes = Array.isArray(body?.shortcodes)
    ? body.shortcodes.filter((s): s is string => typeof s === "string" && s.length >= 5)
    : [];
  if (!codes.length) return c.json({ error: "Pick at least one video" }, 400);
  const recipe = parseRecipe(body?.recipe);
  const run = parseRunWhen(body?.run);
  let mode: IngestMode = "apify";
  if (run === "now") {
    const gate = await ingestGate(user.username);
    if (!gate.ok) return c.json({ error: gate.error, code: gate.code }, 409);
    mode = gate.mode;
  }
  const catalog = await loadCatalog(meta.id);
  const queued = new Map<string, PostMeta>();
  const posts: Array<ReturnType<typeof publicMeta> & { existing?: boolean }> = [];
  const errors: { input: string; error: string }[] = [];
  let started = false;
  for (const code of codes) {
    const row = catalog.find((x) => x.shortcode === code);
    const url = row?.url || canonicalPostUrl(code, row?.kind === "reel");
    const result = await ingestOne(url, user, mode, queued, recipe, run, meta.projectId);
    if (result.ok) {
      let dirty = false;
      let action: ReturnType<typeof stampExistingPull> | null = null;
      if (result.existing) {
        action = stampExistingPull(result.meta, recipe, run);
        dirty = action !== "skip";
      } else {
        result.meta.source = "account-catalog";
        result.meta.accountId = meta.id;
        result.meta.starred = true;
        dirty = true;
        if (run === "now") started = true;
      }
      if (row?.ideaStatus) {
        result.meta.ideaStatus = row.ideaStatus;
        dirty = true;
      }
      if (typeof row?.rank === "number") {
        result.meta.rank = row.rank;
        dirty = true;
      }
      if (action === "enqueue") {
        enqueue(result.meta, user, recipe.jobs);
        started = true;
        dirty = true;
      }
      if (dirty) await persist(result.meta);
      if (row) {
        row.postId = result.meta.id;
        row.starred = true;
      }
      posts.push({ ...publicMeta(result.meta), existing: result.existing === true });
    } else {
      errors.push({ input: url, error: result.error });
    }
  }
  await saveCatalog(meta.id, catalog);
  return c.json({ posts, errors }, started ? 202 : 200);
});

instagramApp.put("/accounts/:id/tags", async (c) => {
  const user = c.get("user");
  const meta = await ownedAccount(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  const body = (await c.req.json().catch(() => null)) as { tags?: unknown } | null;
  if (!Array.isArray(body?.tags)) return c.json({ error: "tags must be an array" }, 400);
  meta.tags = parseUserTags(body.tags);
  await persistAccount(meta);
  return c.json(publicAccount(meta));
});

instagramApp.patch("/accounts/:id", async (c) => {
  const user = c.get("user");
  const meta = await ownedAccount(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  const body = (await c.req.json().catch(() => null)) as { mine?: unknown } | null;
  if (!body || !("mine" in body)) return c.json({ error: "Nothing to update" }, 400);
  await assignMine(meta.owner, body.mine === true ? meta.id : null);
  const next = (await readAccount(meta.id)) ?? meta;
  return c.json(publicAccount(next));
});

instagramApp.patch("/accounts/:id/catalog", async (c) => {
  const user = c.get("user");
  const acc = await ownedAccount(c.req.param("id"), user);
  if (!acc) return c.json({ error: "Not found" }, 404);
  const body = (await c.req.json().catch(() => null)) as {
    shortcode?: unknown;
    ideaStatus?: unknown;
    rank?: unknown;
  } | null;
  const code = typeof body?.shortcode === "string" ? body.shortcode : "";
  const catalog = await loadCatalog(acc.id);
  const row = catalog.find((r) => r.shortcode === code);
  if (!row) return c.json({ error: "Not in catalog" }, 404);
  if (body && "ideaStatus" in body) {
    const s = parseIdeaStatus(body.ideaStatus);
    if (!s) return c.json({ error: "Status must be inbox, idea, done, or skip" }, 400);
    row.ideaStatus = s;
  }
  if (body && "rank" in body) {
    if (body.rank === null || body.rank === "") delete row.rank;
    else {
      const r = parseRank(body.rank);
      if (r === undefined) return c.json({ error: "Rank must be 1–10" }, 400);
      row.rank = r;
    }
  }
  await saveCatalog(acc.id, catalog);
  if (row.postId) {
    const post = await ownedMeta(row.postId, user);
    if (post) {
      const err = await applyResearch(post, body ?? {}, user);
      if (!err) await persist(post);
    }
  }
  return c.json(row);
});

instagramApp.delete("/accounts/:id", async (c) => {
  const meta = await ownedAccount(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  await rm(accountDir(meta.id), { recursive: true, force: true });
  return c.json({ ok: true });
});

instagramApp.get("/:id", async (c) => {
  const user = c.get("user");
  const meta = await ownedMeta(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  if (!meta.accountId && (meta.creator.id || meta.creator.username)) {
    const acc = await findAccount(user, meta.creator.id, meta.creator.username);
    if (acc) {
      meta.accountId = acc.id;
      await persist(meta);
    }
  }
  return c.json(publicMeta(meta), 200, { "Cache-Control": "no-store" });
});

function slideOf(meta: PostMeta, raw: string): Slide | null {
  if (!okSlide(raw)) return null;
  return meta.slides[Number(raw)] ?? null;
}

const SLIDE_CACHE_S = 30 * 24 * 3600;

instagramApp.get("/:id/media/:slide", async (c) => {
  const meta = await ownedMeta(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  const slide = slideOf(meta, c.req.param("slide"));
  if (!slide?.file) return c.json({ error: "Not ready" }, 409);
  const p = abs(meta.id, slide.file);
  if (!existsSync(p)) return c.json({ error: "Not ready" }, 409);
  return streamFile(c, p, slide.mime || (slide.kind === "video" ? "video/mp4" : "image/jpeg"), SLIDE_CACHE_S);
});

instagramApp.get("/:id/thumb/:slide", async (c) => {
  const meta = await ownedMeta(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  const slide = slideOf(meta, c.req.param("slide"));
  if (!slide) return c.json({ error: "Not found" }, 404);
  const p = slide.thumb ? abs(meta.id, slide.thumb) : "";
  if (!p || !existsSync(p)) return c.json({ error: "No thumbnail" }, 404);
  return streamFile(c, p, "image/jpeg", SLIDE_CACHE_S);
});

instagramApp.get("/:id/transcript/:slide", async (c) => {
  const meta = await ownedMeta(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  const slide = slideOf(meta, c.req.param("slide"));
  if (!slide) return c.json({ error: "Not found" }, 404);
  return c.json({ words: await loadTranscript(meta.id, slide.index) });
});

const hasUnjudged = (list: Comment[]): boolean =>
  list.some((cm) => (!cm.judged && cm.text.trim() !== "") || hasUnjudged(cm.replies ?? []));

const stripLowValue = (list: Comment[]): Comment[] =>
  list
    .filter((cm) => !cm.lowValue)
    .map((cm) => ({ ...cm, replies: stripLowValue(cm.replies ?? []) }));

instagramApp.get("/:id/comments", async (c) => {
  const meta = await ownedMeta(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  const file = await loadComments(meta.id);
  if (!file) {
    return c.json({ status: meta.comments.status, fetchedAt: 0, comments: [] });
  }
  // comments fetched before Jev scored them get scored the first time
  // they're opened, once
  const tsKey = typesafeFor(c.get("user"));
  if (tsKey && hasUnjudged(file.comments)) {
    const tally = await annotateComments(tsKey, file.comments, { caption: meta.caption, handle: meta.creator.username }, c.req.raw.signal).catch(
      () => null,
    );
    if (tally && !hasUnjudged(file.comments)) {
      await writeFile(commentsPath(meta.id), JSON.stringify(file));
      meta.comments = { ...meta.comments, ...tally };
      await persist(meta);
    }
  }
  const all = c.req.query("all") === "1";
  return c.json({
    ...file,
    comments: all ? file.comments : stripLowValue(file.comments),
  });
});

instagramApp.post("/:id/retry", async (c) => {
  const user = c.get("user");
  const meta = await ownedMeta(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  const gate = await ingestGate(user.username);
  if (!gate.ok) return c.json({ error: gate.error, code: gate.code }, 409);
  const body = (await c.req.json().catch(() => null)) as { force?: unknown } | null;
  const force = body?.force === true;
  if (force && meta.status === "processing") {
    return c.json({ error: "Wait for the current run to finish before redoing everything" }, 409);
  }
  const jobs = retryJobs(meta.recipe, meta.jobs);
  if (force) await resetParts(meta);
  queueOrFollowUp(meta, user, jobs, { force });
  await persist(meta);
  return c.json(publicMeta(meta), 202);
});

instagramApp.post("/:id/jobs", async (c) => {
  const user = c.get("user");
  const meta = await ownedMeta(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  const gate = await ingestGate(user.username);
  if (!gate.ok) return c.json({ error: gate.error, code: gate.code }, 409);
  const body = (await c.req.json().catch(() => null)) as {
    types?: unknown;
    recipe?: unknown;
    force?: unknown;
    ignoreDuplicate?: unknown;
  } | null;
  if (body?.force === true && meta.status === "processing") {
    return c.json({ error: "Wait for the current run to finish before redoing everything" }, 409);
  }
  const recipe = body?.recipe ? parseRecipe(body.recipe) : meta.recipe;
  const types = Array.isArray(body?.types)
    ? (body.types as JobType[])
    : recipe?.jobs ?? ["info", "stats"];
  const jobs = expandJobs(types);
  if (body?.force === true && jobs.includes("media")) await resetParts(meta);
  meta.recipe = recipe ?? meta.recipe;
  for (const t of jobs) {
    meta.jobs = patchJob(meta.jobs, t, { status: "pending" });
  }
  queueOrFollowUp(meta, user, jobs, {
    force: body?.force === true,
    ignoreDuplicate: body?.ignoreDuplicate === true,
  });
  await persist(meta);
  return c.json(publicMeta(meta), 202);
});

instagramApp.post("/:id/comments/refetch", async (c) => {
  const user = c.get("user");
  const meta = await ownedMeta(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  if (!meta.shortcode && !meta.url) return c.json({ error: "Resolve the post first" }, 409);
  const gate = await ingestGate(user.username);
  if (!gate.ok) return c.json({ error: gate.error, code: gate.code }, 409);
  const body = (await c.req.json().catch(() => null)) as { more?: unknown } | null;
  queueOrFollowUp(meta, user, ["comments"], { more: body?.more === true });
  await persist(meta);
  return c.json(publicMeta(meta), 202);
});

instagramApp.post("/:id/refresh-counts", async (c) => {
  const user = c.get("user");
  const meta = await ownedMeta(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  if (meta.status === "processing") return c.json({ error: "Already processing" }, 409);
  const gate = await ingestGate(user.username);
  if (!gate.ok) {
    return c.json({ error: gate.error, code: gate.code }, 409);
  }
  try {
    const snaps = await loadSnapshots(snapshotsPath(meta.id));
    const { info } = await loadPostInfo(meta, gate.mode, user.username);
    meta.counts = { ...info.counts, fetchedAt: Date.now() };
    meta.caption = info.caption || meta.caption;
    const list = await appendSnapshot(snapshotsPath(meta.id), snapshotFromCounts(meta.counts, gate.mode));
    const prev = snaps[snaps.length - 1] ?? list[0];
    const latest = list[list.length - 1];
    await persist(meta);
    return c.json({
      ...publicMeta(meta),
      diff: prev && latest ? diffSnapshots(prev, latest) : undefined,
      snapshots: list,
    });
  } catch (e) {
    const status =
      e instanceof InstagramError && e.code === "APIFY" ? 409 : 502;
    return c.json({ error: errorMessage(e) }, status);
  }
});

instagramApp.get("/:id/snapshots", async (c) => {
  const meta = await ownedMeta(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  const snapshots = await loadSnapshots(snapshotsPath(meta.id));
  const first = snapshots[0];
  const prev = snapshots.length > 1 ? snapshots[snapshots.length - 2] : first;
  const last = snapshots[snapshots.length - 1];
  return c.json({
    snapshots,
    vsFirst: first && last ? diffSnapshots(first, last) : null,
    vsPrevious: prev && last ? diffSnapshots(prev, last) : null,
  });
});

instagramApp.put("/:id/tags", async (c) => {
  const user = c.get("user");
  const meta = await ownedMeta(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  const body = (await c.req.json().catch(() => null)) as { tags?: unknown } | null;
  if (!Array.isArray(body?.tags)) return c.json({ error: "tags must be an array" }, 400);
  meta.tags = parseUserTags(body.tags);
  await writeSearchText(meta);
  await persist(meta);
  await saveEmbedding(meta);
  return c.json(publicMeta(meta));
});

instagramApp.patch("/:id/research", async (c) => {
  const user = c.get("user");
  const meta = await ownedMeta(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  const body = (await c.req.json().catch(() => null)) as {
    ideaStatus?: unknown;
    rank?: unknown;
    stackId?: unknown;
    savedFor?: unknown;
    knowhow?: unknown;
    idea?: unknown;
  } | null;
  const err = await applyResearch(meta, body ?? {}, user);
  if (err) return c.json({ error: err }, 400);
  if (body && "idea" in body) {
    await writeSearchText(meta);
    await saveEmbedding(meta);
  }
  await persist(meta);
  return c.json(publicMeta(meta));
});

instagramApp.delete("/:id", async (c) => {
  const meta = await ownedMeta(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  cancel(meta.id);
  findIndex.delete(meta.id);
  await rm(postDir(meta.id), { recursive: true, force: true });
  return c.json({ ok: true });
});

export { okId as okInstagramId, DownloadError as InstagramDownloadError };
