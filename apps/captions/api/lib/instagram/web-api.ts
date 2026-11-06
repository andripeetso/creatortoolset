import { canonicalPostUrl } from "./url";
import { igHeaders, markInvalid, type StoredSession } from "./session";
import type { CatalogItem, CatalogPage, PostCreator, PostInfo, PostInfoSlide, PostKind, ProfileInfo } from "./types";

/**
 * Instagram's web JSON API (the same endpoints its own web client calls),
 * authenticated with the burner session. One shared limiter keeps every
 * request at least ~2 s apart; a login wall marks the session invalid so
 * the UI can ask for fresh cookies instead of retrying forever.
 */

export type InstagramErrorCode =
  | "SESSION"
  | "APIFY"
  | "GRAPH"
  | "RATE_LIMIT"
  | "NOT_FOUND"
  | "BLOCKED"
  | "CANCELLED"
  | "FAILED";

export class InstagramError extends Error {
  constructor(
    message: string,
    readonly code: InstagramErrorCode,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "InstagramError";
  }
}

export const SESSION_EXPIRED_MSG =
  "Instagram session expired or was logged out — paste fresh burner-account cookies";

const MEDIA_INFO_URL = (mediaId: string) =>
  `https://www.instagram.com/api/v1/media/${mediaId}/info/`;
const MIN_GAP_MS = 2000;
const JITTER_MS = 800;
const REQUEST_TIMEOUT_MS = 30_000;
const RATE_LIMIT_BACKOFF_MS = 60_000;

let gate: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new InstagramError("Cancelled", "CANCELLED", false));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new InstagramError("Cancelled", "CANCELLED", false));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Serialize Instagram requests and space them out. */
export function throttle(signal?: AbortSignal): Promise<void> {
  const run = async () => {
    const wait =
      lastRequestAt + MIN_GAP_MS + Math.random() * JITTER_MS - Date.now();
    if (wait > 0) await sleep(wait, signal);
    lastRequestAt = Date.now();
  };
  const next = gate.then(run, run);
  gate = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export interface IgRequestOptions {
  /** App user whose session file we mark invalid on a login wall. */
  username?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Internal: set false on the retry after a 429. */
  retryOnRateLimit?: boolean;
}

/**
 * GET a JSON endpoint with the session. Classifies every non-JSON answer:
 * redirects, 401/403 and HTML are the login wall; 429 backs off once.
 */
export async function igJson<T>(
  url: string,
  session: StoredSession,
  opts: IgRequestOptions = {},
): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  await throttle(opts.signal);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: igHeaders(session),
      redirect: "manual",
      signal: requestSignal(opts.signal),
    });
  } catch (e) {
    if (opts.signal?.aborted) {
      throw new InstagramError("Cancelled", "CANCELLED", false);
    }
    throw new InstagramError(
      `Instagram request failed: ${e instanceof Error ? e.message : String(e)}`,
      "FAILED",
      true,
    );
  }
  const ct = res.headers.get("content-type") || "";
  if (res.status === 429) {
    await res.body?.cancel().catch(() => {});
    if (opts.retryOnRateLimit !== false) {
      console.warn("[instagram] 429 — backing off 60 s");
      await sleep(RATE_LIMIT_BACKOFF_MS, opts.signal);
      return igJson<T>(url, session, { ...opts, retryOnRateLimit: false });
    }
    throw new InstagramError(
      "Instagram is rate limiting the session — try again in a few minutes",
      "RATE_LIMIT",
      true,
    );
  }
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    throw new InstagramError(
      "This post is private, was removed, or does not exist",
      "NOT_FOUND",
      false,
    );
  }
  if (
    (res.status >= 300 && res.status < 400) ||
    res.status === 401 ||
    res.status === 403
  ) {
    await res.body?.cancel().catch(() => {});
    await markInvalid(opts.username ?? "", `HTTP ${res.status} from ${new URL(url).pathname}`);
    throw new InstagramError(SESSION_EXPIRED_MSG, "SESSION", false);
  }
  const body = await res.text().catch(() => "");
  if (/checkpoint_required|challenge_required/i.test(body)) {
    await markInvalid(opts.username ?? "", "Instagram raised a checkpoint/challenge for this account");
    throw new InstagramError(
      "Instagram is asking the burner account to verify itself — log in from a browser, complete the check, then paste fresh cookies",
      "BLOCKED",
      false,
    );
  }
  if (!ct.includes("json")) {
    await markInvalid(
      opts.username ?? "",
      `Non-JSON answer (${ct || "no content-type"}) from ${new URL(url).pathname}`,
    );
    throw new InstagramError(SESSION_EXPIRED_MSG, "SESSION", false);
  }
  if (!res.ok) {
    throw new InstagramError(
      `Instagram API ${res.status}: ${body.slice(0, 160)}`,
      "FAILED",
      true,
    );
  }
  let data: T & { status?: string; message?: string };
  try {
    data = JSON.parse(body) as typeof data;
  } catch {
    throw new InstagramError("Instagram returned malformed JSON", "FAILED", true);
  }
  if (data?.status === "fail") {
    const msg = String(data.message || "");
    if (/login_required|not logged in/i.test(msg)) {
      await markInvalid(opts.username ?? "", msg);
      throw new InstagramError(SESSION_EXPIRED_MSG, "SESSION", false);
    }
    throw new InstagramError(
      `Instagram refused: ${msg || "unknown error"}`,
      "FAILED",
      true,
    );
  }
  return data;
}

/* ---- media info ---- */

export interface RawVersion {
  width?: number;
  height?: number;
  url?: string;
}

export interface RawMediaItem {
  pk?: string | number;
  id?: string;
  code?: string;
  media_type?: number;
  product_type?: string;
  taken_at?: number;
  caption?: { text?: string } | null;
  user?: {
    pk?: string | number;
    id?: string | number;
    username?: string;
    full_name?: string;
  };
  like_count?: number;
  comment_count?: number;
  play_count?: number;
  ig_play_count?: number;
  view_count?: number;
  video_duration?: number;
  video_versions?: RawVersion[];
  image_versions2?: { candidates?: RawVersion[] };
  carousel_media?: RawMediaItem[];
  original_width?: number;
  original_height?: number;
  accessibility_caption?: string;
  has_audio?: boolean;
}

export async function fetchMediaInfo(
  mediaId: string,
  session: StoredSession,
  opts: IgRequestOptions = {},
): Promise<RawMediaItem> {
  const data = await igJson<{ items?: RawMediaItem[] }>(
    MEDIA_INFO_URL(mediaId),
    session,
    opts,
  );
  const item = data.items?.[0];
  if (!item) {
    throw new InstagramError(
      "This post is private, was removed, or does not exist",
      "NOT_FOUND",
      false,
    );
  }
  return item;
}

const bestVersion = (list?: RawVersion[]): RawVersion | undefined =>
  (list ?? [])
    .filter((v) => typeof v?.url === "string" && v.url)
    .sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];

const count = (n: unknown): number | undefined =>
  typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;

function slideFrom(
  raw: RawMediaItem,
  index: number,
  opts: { child?: boolean } = {},
): PostInfoSlide | null {
  const image = bestVersion(raw.image_versions2?.candidates);
  const video = raw.media_type === 2 ? bestVersion(raw.video_versions) : undefined;
  const acc =
    typeof raw.accessibility_caption === "string" && raw.accessibility_caption.trim()
      ? raw.accessibility_caption.trim().slice(0, 500)
      : undefined;
  // Carousel children can carry their own caption (per-slide captions);
  // the top-level item's caption is the post caption, not a slide caption.
  const caption =
    opts.child && typeof raw.caption?.text === "string" && raw.caption.text.trim()
      ? raw.caption.text.trim().slice(0, 2200)
      : undefined;
  if (video?.url) {
    return {
      index,
      kind: "video",
      url: video.url,
      width: video.width ?? raw.original_width ?? 0,
      height: video.height ?? raw.original_height ?? 0,
      durationS: count(raw.video_duration),
      coverUrl: image?.url,
      accessibilityCaption: acc,
      caption,
    };
  }
  if (image?.url) {
    return {
      index,
      kind: "image",
      url: image.url,
      width: image.width ?? raw.original_width ?? 0,
      height: image.height ?? raw.original_height ?? 0,
      accessibilityCaption: acc,
      caption,
    };
  }
  return null;
}

/** Shape the raw items[0] into what the pipeline stores and downloads. */
export function normalizePostInfo(
  item: RawMediaItem,
  fallback: { shortcode: string; mediaId: string },
): PostInfo {
  const isCarousel = item.media_type === 8 && (item.carousel_media?.length ?? 0) > 0;
  const kind: PostKind = isCarousel
    ? "carousel"
    : item.media_type === 2 && item.product_type === "clips"
      ? "reel"
      : "post";
  const rawSlides = isCarousel ? item.carousel_media! : [item];
  const slides: PostInfoSlide[] = [];
  rawSlides.forEach((raw, i) => {
    const slide = slideFrom(raw, slides.length, { child: isCarousel });
    if (slide) slides.push(slide);
    else console.warn(`[instagram] slide ${i + 1} has no downloadable media`);
  });
  if (!slides.length) {
    throw new InstagramError(
      "Instagram returned this post without any downloadable media",
      "FAILED",
      false,
    );
  }
  const shortcode = typeof item.code === "string" && item.code ? item.code : fallback.shortcode;
  const user = item.user ?? {};
  const creator: PostCreator = {
    username: typeof user.username === "string" ? user.username : "instagram",
    fullName:
      typeof user.full_name === "string" && user.full_name.trim()
        ? user.full_name.trim()
        : undefined,
    id: String(user.pk ?? user.id ?? ""),
  };
  return {
    shortcode,
    mediaId: fallback.mediaId,
    kind,
    url: canonicalPostUrl(shortcode, kind === "reel"),
    creator,
    takenAt: count(item.taken_at) ? item.taken_at! * 1000 : 0,
    caption: typeof item.caption?.text === "string" ? item.caption.text : "",
    counts: {
      likes: count(item.like_count),
      comments: count(item.comment_count),
      plays: count(item.play_count) ?? count(item.ig_play_count) ?? count(item.view_count),
    },
    slides,
  };
}

const PROFILE_URL = (username: string) =>
  `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
const USER_FEED_URL = (id: string, maxId?: string) => {
  const q = maxId
    ? `?max_id=${encodeURIComponent(maxId)}`
    : "?count=12";
  return `https://www.instagram.com/api/v1/feed/user/${encodeURIComponent(id)}/${q}`;
};

function edgeCount(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  if (v && typeof v === "object" && "count" in v) return count((v as { count?: unknown }).count);
  return undefined;
}

export function profileFromWebUser(user: Record<string, unknown>): ProfileInfo {
  const username = typeof user.username === "string" ? user.username : "instagram";
  const pic =
    (typeof user.profile_pic_url_hd === "string" && user.profile_pic_url_hd) ||
    (typeof user.profile_pic_url === "string" && user.profile_pic_url) ||
    undefined;
  return {
    igUserId: String(user.pk ?? user.id ?? username),
    username,
    fullName:
      typeof user.full_name === "string" && user.full_name.trim() ? user.full_name.trim() : undefined,
    biography: typeof user.biography === "string" && user.biography ? user.biography : undefined,
    profilePic: pic,
    isPrivate: user.is_private === true,
    isVerified: user.is_verified === true,
    followers: count(user.follower_count) ?? edgeCount(user.edge_followed_by),
    following: count(user.following_count) ?? edgeCount(user.edge_follow),
    posts: count(user.media_count) ?? edgeCount(user.edge_owner_to_timeline_media),
  };
}

export async function fetchWebProfile(
  username: string,
  session: StoredSession,
  opts: IgRequestOptions = {},
): Promise<ProfileInfo> {
  const data = await igJson<{ data?: { user?: Record<string, unknown> }; user?: Record<string, unknown> }>(
    PROFILE_URL(username),
    session,
    opts,
  );
  const user = data.data?.user ?? data.user;
  if (!user) {
    throw new InstagramError("This Instagram account was not found", "NOT_FOUND", false);
  }
  return profileFromWebUser(user);
}

function catalogItemFromRaw(item: RawMediaItem): CatalogItem | null {
  const shortcode = typeof item.code === "string" ? item.code : "";
  if (!shortcode) return null;
  const isCarousel = item.media_type === 8 || !!item.carousel_media?.length;
  const isReel = !isCarousel && item.media_type === 2 && item.product_type === "clips";
  const image = bestVersion(item.image_versions2?.candidates);
  const caption = typeof item.caption?.text === "string" ? item.caption.text : "";
  const graphId =
    item.pk != null && String(item.pk).trim()
      ? String(item.pk).trim()
      : typeof item.id === "string" && item.id.trim()
        ? item.id.trim().split("_")[0]
        : undefined;
  return {
    shortcode,
    graphId,
    url: canonicalPostUrl(shortcode, isReel),
    kind: isCarousel ? "carousel" : isReel ? "reel" : "post",
    takenAt: count(item.taken_at) ? item.taken_at! * 1000 : 0,
    thumbnailUrl: image?.url,
    captionPreview: caption ? caption.slice(0, 180) : undefined,
    counts: {
      likes: count(item.like_count),
      comments: count(item.comment_count),
      plays: count(item.play_count) ?? count(item.ig_play_count) ?? count(item.view_count),
    },
  };
}

export async function fetchUserCatalog(
  igUserId: string,
  session: StoredSession,
  opts: IgRequestOptions & { cap: number; after?: string; since?: number },
): Promise<CatalogPage> {
  const cap = Math.max(1, Math.min(500, opts.cap));
  const since = opts.since && opts.since > 0 ? opts.since : undefined;
  const out: CatalogItem[] = [];
  let maxId: string | undefined = opts.after;
  let nextMaxId: string | undefined;
  let more = false;
  for (let page = 0; page < 20 && out.length < cap; page++) {
    const data = await igJson<{
      items?: RawMediaItem[];
      more_available?: boolean;
      next_max_id?: string;
    }>(USER_FEED_URL(igUserId, maxId), session, opts);
    const items = Array.isArray(data.items) ? data.items : [];
    let leftover = false;
    let crossed = false;
    for (const item of items) {
      if (out.length >= cap) {
        leftover = true;
        break;
      }
      const row = catalogItemFromRaw(item);
      if (row && !out.some((x) => x.shortcode === row.shortcode)) {
        out.push(row);
        if (since && row.takenAt > 0 && row.takenAt < since) crossed = true;
      }
    }
    nextMaxId = typeof data.next_max_id === "string" && data.next_max_id ? data.next_max_id : undefined;
    more = leftover || Boolean(data.more_available && nextMaxId);
    if (crossed) {
      more = false;
      nextMaxId = undefined;
      break;
    }
    if (out.length >= cap || !more) break;
    maxId = nextMaxId;
  }
  return { items: out.slice(0, cap), nextMaxId, more };
}
