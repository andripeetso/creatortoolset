import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../env";
import { canonicalPostUrl, shortcodeToMediaId } from "./url";
import { igUserFile, InstagramError } from "./base";
import type {
  CatalogItem,
  CatalogPage,
  Comment,
  CommentsStatus,
  PostCreator,
  PostInfo,
  PostInfoSlide,
  PostKind,
  ProfileInfo,
} from "./types";

/**
 * Reading other creators' public posts, profiles and comment threads: Apify actors on the user's own Apify token,
 * billed by Apify to them. The token lives per user at $DATA_DIR/instagram/users/<username>/apify.json (mode 0600)
 * and is never returned.
 *
 * Local-only fallback: APIFY_TOKEN in .env is read only by `fromEnv` below, and only for the `local` user while
 * APP_SECRET is unset (one person's own machine). With APP_SECRET set, or for any other user, it is ignored, so a
 * multi-user server never shares one key between accounts. There is no other way in: no session cookies, no
 * server-wide token.
 */
const POST_ACTOR = "apify~instagram-scraper";
const COMMENT_ACTOR = "apify~instagram-comment-scraper";
const RUN_TIMEOUT_S = 300;

export const APIFY_MISSING_MSG =
  "Reading other creators' posts needs your own Apify key: add it in Settings → API keys";
export const APIFY_INVALID_MSG =
  "Apify token is invalid or expired — paste a fresh token from console.apify.com";
/** How a post or profile was read: the one way left for other creators' posts (snapshots keep it as their source). */
export type IngestMode = "apify";

export interface StoredApify {
  token: string;
  savedAt: number;
  savedBy: string;
  valid: boolean | null;
  checkedAt?: number;
  account?: { id: string; username?: string };
  invalidReason?: string;
  source: "file" | "env";
  /** One actor run at a time — for plans with a low concurrent-runs cap. */
  slow?: boolean;
}

export interface ApifyStatus {
  configured: boolean;
  valid: boolean | null;
  checkedAt?: number;
  savedAt?: number;
  savedBy?: string;
  account?: { id: string; username?: string };
  invalidReason?: string;
  source: "file" | "env" | "none";
  slow?: boolean;
  /** The last four characters of the token (never the token). */
  last4?: string;
}

export type IngestGate =
  | { ok: true; mode: IngestMode }
  | { ok: false; mode: IngestMode; error: string; code: "NO_APIFY" | "APIFY_INVALID" };

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
function optCount(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v)) && Number(v) >= 0) {
    return Number(v);
  }
  return undefined;
}

let envApify: StoredApify | null | undefined;
let writeQ: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeQ.then(fn, fn);
  writeQ = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function writeFileAtomic(target: string, data: string, mode: number): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  await writeFile(tmp, data, { mode });
  await rename(tmp, target);
}

function fromEnv(username: string): StoredApify | null {
  if (username !== "local" || env.appSecret) return null;
  if (envApify !== undefined) return envApify;
  const token = (process.env.APIFY_TOKEN || "").trim();
  envApify = token
    ? {
        token,
        savedAt: 0,
        savedBy: "env",
        valid: null,
        source: "env",
      }
    : null;
  return envApify;
}

export async function readApify(username: string): Promise<StoredApify | null> {
  try {
    const raw = JSON.parse(await readFile(igUserFile(username, "apify.json"), "utf-8")) as StoredApify;
    if (typeof raw?.token !== "string" || !raw.token.trim()) return fromEnv(username);
    return { ...raw, token: raw.token.trim(), source: "file" };
  } catch {
    return fromEnv(username);
  }
}

export function writeApify(username: string, s: StoredApify): Promise<void> {
  return serialized(async () => {
    if (s.source === "env") {
      if (username === "local") envApify = s;
      return;
    }
    await writeFileAtomic(igUserFile(username, "apify.json"), JSON.stringify(s), 0o600);
  });
}

export function clearApify(username: string): Promise<void> {
  return serialized(async () => {
    await rm(igUserFile(username, "apify.json"), { force: true }).catch(() => {});
    if (username === "local") envApify = null;
  });
}

export async function updateApify(
  username: string,
  patch: (s: StoredApify) => StoredApify,
): Promise<StoredApify | null> {
  const s = await readApify(username);
  if (!s) return null;
  const next = patch(s);
  await writeApify(username, next);
  return next;
}

export function markApifyInvalid(username: string, reason: string): Promise<StoredApify | null> {
  console.warn(`[instagram] apify marked invalid: ${reason}`);
  return updateApify(username, (s) => ({
    ...s,
    valid: false,
    checkedAt: Date.now(),
    invalidReason: reason.slice(0, 200),
  }));
}

export function publicApifyStatus(s: StoredApify | null): ApifyStatus {
  if (!s) return { configured: false, valid: null, source: "none" };
  return {
    configured: true,
    valid: s.valid,
    checkedAt: s.checkedAt,
    savedAt: s.savedAt || undefined,
    savedBy: s.savedBy,
    account: s.account,
    invalidReason: s.invalidReason,
    source: s.source,
    slow: s.slow === true,
    // the last four characters only, for the masked row on API keys
    last4: s.token ? s.token.slice(-4) : undefined,
  };
}

export async function ingestGate(username: string): Promise<IngestGate> {
  const a = await readApify(username);
  if (!a) return { ok: false, mode: "apify", error: APIFY_MISSING_MSG, code: "NO_APIFY" };
  if (a.valid === false) return { ok: false, mode: "apify", error: APIFY_INVALID_MSG, code: "APIFY_INVALID" };
  return { ok: true, mode: "apify" };
}

export async function availabilitySnapshot(username: string): Promise<{ available: boolean; apify: ApifyStatus }> {
  const apify = publicApifyStatus(await readApify(username));
  return { available: apify.configured && apify.valid !== false, apify };
}

/**
 * Cheap validity probe against Apify's own users/me endpoint.
 */
export async function checkApify(
  username: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StoredApify | null> {
  const s = await readApify(username);
  if (!s) return null;
  let valid = false;
  let reason: string | undefined;
  let apifyUsername: string | undefined;
  let accountId: string | undefined;
  try {
    const res = await fetchImpl("https://api.apify.com/v2/users/me", {
      headers: { Authorization: `Bearer ${s.token}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      reason = `Apify refused the token (HTTP ${res.status})`;
    } else if (res.ok) {
      const j = (await res.json().catch(() => null)) as {
        data?: { username?: unknown; id?: unknown };
        username?: unknown;
        id?: unknown;
      } | null;
      const data = j?.data ?? j;
      apifyUsername = data && typeof data.username === "string" ? data.username : undefined;
      accountId = data && (typeof data.id === "string" || typeof data.id === "number")
        ? String(data.id)
        : undefined;
      valid = true;
    } else {
      await res.body?.cancel().catch(() => {});
      reason = `Apify check failed (HTTP ${res.status})`;
    }
  } catch (e) {
    reason = e instanceof Error ? e.message : String(e);
  }
  const next: StoredApify = {
    ...s,
    valid,
    checkedAt: Date.now(),
    invalidReason: valid ? undefined : reason,
    account: valid
      ? { id: accountId ?? s.account?.id ?? "", username: apifyUsername ?? s.account?.username }
      : s.account,
  };
  await writeApify(username, next);
  return next;
}

export interface ApifyFetchOptions {
  username: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Test hook for the retry backoff. */
  sleep?: (ms: number) => Promise<void>;
}

async function requireApify(username: string): Promise<StoredApify> {
  const a = await readApify(username);
  if (!a) throw new InstagramError(APIFY_MISSING_MSG, "APIFY", false);
  if (a.valid === false) throw new InstagramError(APIFY_INVALID_MSG, "APIFY", false);
  return a;
}

/* ---- run limiter + retries ----
 * Apify caps concurrent actor runs per account (5 on the free plan) and
 * answers HTTP 402 "concurrent-runs-limit-exceeded" past it. Runs are
 * gated per token so the app stays under the cap, and a 402 of that kind,
 * a 429, a 5xx or a network error is retried with a growing wait.
 */
const MAX_RUNS = Math.max(1, Number(process.env.APIFY_MAX_CONCURRENT) || 8);
const RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 180_000];

const runSlots = new Map<string, { active: number; waiters: Array<() => void> }>();

async function acquireRunSlot(
  username: string,
  limit: number,
  signal?: AbortSignal,
): Promise<() => void> {
  let slot = runSlots.get(username);
  if (!slot) {
    slot = { active: 0, waiters: [] };
    runSlots.set(username, slot);
  }
  const s = slot;
  while (s.active >= limit) {
    if (signal?.aborted) throw new InstagramError("Cancelled", "CANCELLED", false);
    await new Promise<void>((resolve) => {
      const wake = () => {
        signal?.removeEventListener("abort", wake);
        resolve();
      };
      signal?.addEventListener("abort", wake, { once: true });
      s.waiters.push(wake);
    });
  }
  s.active++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    s.active--;
    s.waiters.shift()?.();
  };
}

/** How many actor runs this user has going right now (for tests and logs). */
export function activeApifyRuns(username: string): number {
  return runSlots.get(username)?.active ?? 0;
}

function apifyErrorInfo(text: string): { type: string; message: string } {
  try {
    const j = JSON.parse(text) as { error?: { type?: string; message?: string } };
    return { type: j?.error?.type ?? "", message: j?.error?.message ?? "" };
  } catch {
    return { type: "", message: "" };
  }
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export async function apifyRun(
  actor: string,
  input: unknown,
  opts: ApifyFetchOptions,
): Promise<unknown[]> {
  const stored = await requireApify(opts.username);
  const limit = stored.slow ? 1 : MAX_RUNS;
  const sleep = opts.sleep ?? ((ms: number) => sleepAbortable(ms, opts.signal));
  const release = await acquireRunSlot(opts.username, limit, opts.signal);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await apifyRunOnce(actor, input, opts, stored.token);
      } catch (e) {
        const retryable = e instanceof InstagramError && e.retryable && e.code !== "CANCELLED";
        if (!retryable || attempt >= RETRY_DELAYS_MS.length || opts.signal?.aborted) throw e;
        const ms = RETRY_DELAYS_MS[attempt]!;
        console.warn(`[instagram] apify: ${(e as Error).message.slice(0, 120)} — retrying in ${Math.round(ms / 1000)}s`);
        await sleep(ms);
        if (opts.signal?.aborted) throw new InstagramError("Cancelled", "CANCELLED", false);
      }
    }
  } finally {
    release();
  }
}

async function tokenRefused(token: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchImpl("https://api.apify.com/v2/users/me", {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    await res.body?.cancel().catch(() => {});
    return res.status === 401 || res.status === 403;
  } catch {
    return false;
  }
}

async function apifyRunOnce(
  actor: string,
  input: unknown,
  opts: ApifyFetchOptions,
  token: string,
): Promise<unknown[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout((RUN_TIMEOUT_S + 10) * 1000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?timeout=${RUN_TIMEOUT_S}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(input),
      signal,
    });
  } catch (e) {
    if (opts.signal?.aborted) {
      throw new InstagramError("Cancelled", "CANCELLED", false);
    }
    throw new InstagramError(
      `Apify request failed: ${e instanceof Error ? e.message : String(e)}`,
      "APIFY",
      true,
    );
  }
  const text = await res.text().catch(() => "");
  // A hit monthly usage limit is a 403 too, so only a token users/me also refuses is invalid.
  if ((res.status === 401 || res.status === 403) && (await tokenRefused(token, fetchImpl))) {
    await markApifyInvalid(opts.username, `HTTP ${res.status} from Apify`);
    throw new InstagramError(APIFY_INVALID_MSG, "APIFY", false);
  }
  if (!res.ok) {
    const { type, message } = apifyErrorInfo(text);
    if (res.status === 402 && type === "concurrent-runs-limit-exceeded") {
      throw new InstagramError(
        "Apify is already running as many actors as your plan allows",
        "APIFY",
        true,
      );
    }
    if (res.status === 402 || res.status === 403) {
      throw new InstagramError(
        `Apify refused the run: ${message || text.slice(0, 180)}`,
        "APIFY",
        false,
      );
    }
    throw new InstagramError(
      `Apify actor failed (HTTP ${res.status}): ${message || text.slice(0, 180)}`,
      res.status === 400 ? "FAILED" : "APIFY",
      res.status >= 500 || res.status === 429,
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new InstagramError("Apify returned malformed JSON", "APIFY", true);
  }
  if (Array.isArray(data)) return data;
  if (isRec(data) && Array.isArray(data.items)) return data.items;
  const err =
    isRec(data) && isRec(data.error) && typeof data.error.message === "string"
      ? data.error.message
      : "Unexpected Apify response";
  throw new InstagramError(err, "APIFY", true);
}

function looksLikePost(v: unknown): v is Rec {
  if (!isRec(v)) return false;
  return !!(
    str(v.shortCode) ||
    str(v.shortcode) ||
    str(v.displayUrl) ||
    str(v.videoUrl) ||
    (Array.isArray(v.childPosts) && v.childPosts.length)
  );
}

function altOf(raw: Rec): string | undefined {
  const a = str(raw.alt) || str(raw.accessibilityCaption);
  return a ? a.slice(0, 500) : undefined;
}

function slideFromApify(
  raw: Rec,
  index: number,
  opts: { child?: boolean } = {},
): PostInfoSlide | null {
  const video = str(raw.videoUrl);
  const image =
    str(raw.displayUrl) ||
    (Array.isArray(raw.images) && typeof raw.images[0] === "string" ? raw.images[0] : "");
  const w = num(raw.dimensionsWidth);
  const h = num(raw.dimensionsHeight);
  const acc = altOf(raw);
  // Carousel children may carry a per-slide caption; the top-level item's
  // caption is the post caption and must not be copied onto the slide.
  const childCaption = opts.child ? str(raw.caption).trim() : "";
  const caption = childCaption ? childCaption.slice(0, 2200) : undefined;
  if (video) {
    return {
      index,
      kind: "video",
      url: video,
      width: w,
      height: h,
      durationS: num(raw.videoDuration) || undefined,
      coverUrl: image || undefined,
      accessibilityCaption: acc,
      caption,
    };
  }
  if (image) {
    return {
      index,
      kind: "image",
      url: image,
      width: w,
      height: h,
      accessibilityCaption: acc,
      caption,
    };
  }
  return null;
}

function mediaIdOf(raw: Rec, shortcode: string): string {
  const id = raw.id;
  if (typeof id === "number" && Number.isFinite(id)) return String(Math.trunc(id));
  if (typeof id === "string" && /^\d+$/.test(id.trim())) return id.trim();
  try {
    return shortcode ? shortcodeToMediaId(shortcode) : "";
  } catch {
    return typeof id === "string" ? id : "";
  }
}

function takenAtOf(raw: Rec): number {
  const ts = raw.timestamp;
  if (typeof ts === "string") {
    const n = Date.parse(ts);
    return Number.isFinite(n) ? n : 0;
  }
  const n = num(ts);
  if (!n) return 0;
  return n > 1e12 ? n : n * 1000;
}

/** Shape an Apify instagram-scraper item into the pipeline's PostInfo. */
export function normalizeApifyPost(raw: Rec, fallbackUrl: string): PostInfo {
  const shortcode = str(raw.shortCode) || str(raw.shortcode);
  const type = str(raw.type);
  const product = str(raw.productType);
  const children = Array.isArray(raw.childPosts) ? raw.childPosts.filter(isRec) : [];
  const carouselUrls = Array.isArray(raw.carouselImages)
    ? raw.carouselImages.filter((u): u is string => typeof u === "string" && !!u)
    : [];
  const isCarousel =
    type === "Sidecar" ||
    product === "carousel_container" ||
    children.length > 1 ||
    carouselUrls.length > 1;
  const isReel =
    !isCarousel &&
    (type === "Video" ||
      product === "clips" ||
      /\/reels?\//i.test(fallbackUrl) ||
      /\/reels?\//i.test(str(raw.url)));
  const kind: PostKind = isCarousel ? "carousel" : isReel ? "reel" : "post";
  const slides: PostInfoSlide[] = [];
  if (isCarousel && children.length) {
    for (const child of children) {
      const slide = slideFromApify(child, slides.length, { child: true });
      if (slide) slides.push(slide);
    }
  } else if (isCarousel && carouselUrls.length) {
    for (const url of carouselUrls) {
      slides.push({
        index: slides.length,
        kind: "image",
        url,
        width: 0,
        height: 0,
      });
    }
  } else {
    const slide = slideFromApify(raw, 0);
    if (slide) slides.push(slide);
  }
  if (!slides.length) {
    throw new InstagramError(
      "Apify returned this post without any downloadable media",
      "FAILED",
      false,
    );
  }
  if (!shortcode) {
    throw new InstagramError("Apify returned a post without a shortcode", "FAILED", false);
  }
  const creator: PostCreator = {
    username: str(raw.ownerUsername) || "instagram",
    fullName: str(raw.ownerFullName) || undefined,
    id: raw.ownerId !== undefined && raw.ownerId !== null ? String(raw.ownerId) : "",
  };
  const url = str(raw.url) || canonicalPostUrl(shortcode, kind === "reel");
  return {
    shortcode,
    mediaId: mediaIdOf(raw, shortcode),
    kind,
    url,
    creator,
    takenAt: takenAtOf(raw),
    caption: typeof raw.caption === "string" ? raw.caption : "",
    counts: {
      likes: optCount(raw.likesCount),
      comments: optCount(raw.commentsCount),
      plays: optCount(raw.videoPlayCount) ?? optCount(raw.videoViewCount),
    },
    slides,
  };
}

export async function fetchPostViaApify(
  url: string,
  opts: ApifyFetchOptions & { reelHint?: boolean },
): Promise<{ raw: unknown; info: PostInfo }> {
  const first = opts.reelHint ? "reels" : "posts";
  const second = first === "reels" ? "posts" : "reels";
  const run = (resultsType: "posts" | "reels") =>
    apifyRun(
      POST_ACTOR,
      { directUrls: [url], resultsType, resultsLimit: 1 },
      opts,
    );
  let items = await run(first);
  let raw = items.find(looksLikePost);
  if (!raw) {
    items = await run(second);
    raw = items.find(looksLikePost);
  }
  if (!raw) {
    throw new InstagramError(
      /\/share\//i.test(url)
        ? "Could not resolve this share link via Apify — paste a /p/ or /reel/ URL instead"
        : "Apify returned no post for this link",
      "NOT_FOUND",
      false,
    );
  }
  return { raw, info: normalizeApifyPost(raw, url) };
}

const POST_URL_CODE = /\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})/;

export function shortcodeFromUrl(url: string): string | null {
  return POST_URL_CODE.exec(url)?.[1] ?? null;
}

/**
 * One actor run for many post URLs. Returns what came back keyed by the
 * input URL; callers retry the other resultsType for the rest.
 */
export async function fetchPostsViaApify(
  urls: string[],
  opts: ApifyFetchOptions & { resultsType: "posts" | "reels" },
): Promise<Map<string, { raw: unknown; info: PostInfo }>> {
  const items = (
    await apifyRun(POST_ACTOR, { directUrls: urls, resultsType: opts.resultsType, resultsLimit: 1 }, opts)
  ).filter(looksLikePost);
  const out = new Map<string, { raw: unknown; info: PostInfo }>();
  for (const url of urls) {
    const code = shortcodeFromUrl(url);
    const raw = items.find(
      (it) =>
        (code && (str(it.shortCode) === code || str(it.shortcode) === code)) ||
        str(it.inputUrl) === url ||
        str(it.url) === url,
    );
    if (raw) out.set(url, { raw, info: normalizeApifyPost(raw, url) });
  }
  return out;
}

function toApifyComment(raw: Rec): Comment | null {
  const username =
    str(raw.ownerUsername) || (isRec(raw.owner) ? str(raw.owner.username) : "");
  const id = String(raw.id ?? "");
  if (!id || !username) return null;
  if ("shortCode" in raw && "caption" in raw && !("text" in raw)) return null;
  const text = typeof raw.text === "string" ? raw.text : "";
  const replies = Array.isArray(raw.replies)
    ? raw.replies.map((r) => (isRec(r) ? toApifyComment(r) : null)).filter((c): c is Comment => !!c)
    : [];
  return {
    id,
    text,
    createdAt: takenAtOf(raw),
    user: {
      username,
      id: raw.ownerId !== undefined && raw.ownerId !== null ? String(raw.ownerId) : "",
    },
    likeCount: num(raw.likesCount),
    replyCount: num(raw.repliesCount) || replies.length,
    replies,
  };
}

function looksLikeApifyComment(raw: Rec): boolean {
  const username =
    str(raw.ownerUsername) || (isRec(raw.owner) ? str(raw.owner.username) : "");
  const id = String(raw.id ?? "");
  if (!id || !username) return false;
  if ("shortCode" in raw && "caption" in raw && typeof raw.text !== "string") return false;
  return typeof raw.text === "string" || Array.isArray(raw.replies);
}

/** Map Apify comment-scraper items (nested replies or parentCommentId). */
export function commentsFromApify(items: unknown[]): Comment[] {
  const rows: { c: Comment; parent?: string }[] = [];
  for (const item of items) {
    if (!isRec(item) || !looksLikeApifyComment(item)) continue;
    const c = toApifyComment(item);
    if (!c) continue;
    const parent = str(item.parentCommentId) || str(item.parentId) || undefined;
    rows.push({ c, parent });
  }
  const top = new Map<string, Comment>();
  const pending: { c: Comment; parent: string }[] = [];
  for (const row of rows) {
    if (!row.parent) {
      const prev = top.get(row.c.id);
      if (!prev) top.set(row.c.id, row.c);
      else {
        const seen = new Set(prev.replies.map((r) => r.id));
        for (const r of row.c.replies) if (!seen.has(r.id)) prev.replies.push(r);
      }
      continue;
    }
    pending.push({ c: row.c, parent: row.parent });
  }
  for (const row of pending) {
    const parent = top.get(row.parent);
    if (!parent) {
      if (!top.has(row.c.id)) top.set(row.c.id, row.c);
      continue;
    }
    if (!parent.replies.some((r) => r.id === row.c.id)) parent.replies.push(row.c);
    parent.replyCount = Math.max(parent.replyCount, parent.replies.length);
  }
  return [...top.values()];
}

export async function fetchCommentsViaApify(
  url: string,
  opts: ApifyFetchOptions & { cap: number },
): Promise<{ comments: Comment[]; status: CommentsStatus }> {
  const base = { directUrls: [url], resultsLimit: opts.cap };
  let items: unknown[];
  try {
    items = await apifyRun(COMMENT_ACTOR, { ...base, includeNestedComments: true }, opts);
  } catch (e) {
    if (e instanceof InstagramError && e.code === "FAILED") {
      items = await apifyRun(COMMENT_ACTOR, base, opts);
    } else {
      throw e;
    }
  }
  const comments = commentsFromApify(items);
  const stored = comments.reduce((n, c) => n + 1 + (c.replies?.length ?? 0), 0);
  return { comments, status: stored >= opts.cap ? "capped" : "complete" };
}

export function profileFromApify(raw: Rec): ProfileInfo | null {
  const username = str(raw.username) || str(raw.ownerUsername);
  const id =
    raw.id !== undefined && raw.id !== null
      ? String(raw.id)
      : str(raw.ownerId) || str(raw.pk);
  if (!username && !id) return null;
  if (looksLikePost(raw) && !str(raw.biography) && !str(raw.followersCount)) return null;
  return {
    igUserId: id || username,
    username: username || "instagram",
    fullName: str(raw.fullName) || str(raw.full_name) || undefined,
    biography: str(raw.biography) || str(raw.bio) || undefined,
    profilePic:
      str(raw.profilePicUrlHD) || str(raw.profilePicUrl) || str(raw.profilePic) || undefined,
    isPrivate: raw.private === true || raw.isPrivate === true,
    isVerified: raw.verified === true || raw.isVerified === true,
    followers: optCount(raw.followersCount) ?? optCount(raw.followers),
    following: optCount(raw.followsCount) ?? optCount(raw.followingCount) ?? optCount(raw.followings),
    posts: optCount(raw.postsCount) ?? optCount(raw.mediaCount),
  };
}

export function catalogItemFromApify(raw: Rec): CatalogItem | null {
  const shortcode = str(raw.shortCode) || str(raw.shortcode);
  if (!shortcode) return null;
  const type = str(raw.type);
  const product = str(raw.productType);
  const children = Array.isArray(raw.childPosts) ? raw.childPosts.length : 0;
  const isCarousel =
    type === "Sidecar" || product === "carousel_container" || children > 1;
  const isReel =
    !isCarousel &&
    (type === "Video" || product === "clips" || /\/reels?\//i.test(str(raw.url)));
  const caption = typeof raw.caption === "string" ? raw.caption : "";
  const rawId = raw.id ?? raw.pk;
  const graphId =
    rawId == null || rawId === "" ? undefined : String(rawId).trim().split("_")[0] || undefined;
  return {
    shortcode,
    graphId,
    url: str(raw.url) || canonicalPostUrl(shortcode, isReel),
    kind: isCarousel ? "carousel" : isReel ? "reel" : "post",
    takenAt: takenAtOf(raw),
    thumbnailUrl: str(raw.displayUrl) || str(raw.thumbnailUrl) || undefined,
    captionPreview: caption ? caption.slice(0, 180) : undefined,
    counts: {
      likes: optCount(raw.likesCount),
      comments: optCount(raw.commentsCount),
      plays: optCount(raw.videoPlayCount) ?? optCount(raw.videoViewCount),
    },
  };
}

export async function fetchProfileViaApify(
  url: string,
  opts: ApifyFetchOptions,
): Promise<ProfileInfo> {
  const items = await apifyRun(
    POST_ACTOR,
    { directUrls: [url], resultsType: "details", resultsLimit: 1 },
    opts,
  );
  for (const item of items) {
    if (!isRec(item)) continue;
    const info = profileFromApify(item);
    if (info) return info;
  }
  throw new InstagramError("Apify returned no profile for this account", "NOT_FOUND", false);
}

export async function fetchCatalogViaApify(
  url: string,
  opts: ApifyFetchOptions & { cap: number; reels?: boolean },
): Promise<CatalogPage> {
  const cap = Math.max(1, Math.min(500, opts.cap));
  const wantReels = opts.reels !== false;
  const run = (resultsType: "posts" | "reels") =>
    apifyRun(POST_ACTOR, { directUrls: [url], resultsType, resultsLimit: cap }, opts);
  let posts: unknown[] = [];
  let reels: unknown[] = [];
  try {
    if (wantReels) [posts, reels] = await Promise.all([run("posts"), run("reels")]);
    else posts = await run("posts");
  } catch (e) {
    if (!(e instanceof InstagramError && e.code === "FAILED")) throw e;
    posts = await run("posts");
  }
  const map = new Map<string, CatalogItem>();
  const ingest = (items: unknown[]) => {
    for (const item of items) {
      if (!isRec(item)) continue;
      const latest = Array.isArray(item.latestPosts) ? item.latestPosts : [];
      const rows = latest.length ? latest : [item];
      for (const row of rows) {
        if (!isRec(row)) continue;
        const cat = catalogItemFromApify(row);
        if (!cat) continue;
        if (!map.has(cat.shortcode)) map.set(cat.shortcode, cat);
      }
    }
  };
  ingest(posts);
  ingest(reels);
  const list = [...map.values()].sort((a, b) => b.takenAt - a.takenAt);
  return { items: list.slice(0, cap), more: list.length >= cap };
}

