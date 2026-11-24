import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { env, isCloud } from "../env";
import type { SessionUser } from "../../users";
import type { CatalogItem, Comment, CommentsStatus, PostInfo, PostInfoSlide, ProfileInfo } from "./types";
import { canonicalPostUrl, shortcodeFromUrl, shortcodeToMediaId } from "./url";

// The person's own Instagram account, signed in once in a Chrome window on their Mac (they type, never this code), so
// the Media Library can add a post or reel by its link. Only its cookies are kept (0600); each read is one call to
// Instagram's own web API with them, one at a time, on demand. Instagram's terms apply to that account.

export const IG = {
  /** how long the sign-in window waits for the person */
  loginMs: 10 * 60_000,
  /** the web app's own id, which Instagram's web API asks for */
  appId: "936619743392459",
};

const home = (u: string) => path.join(env.dataDir, "instagram-login", u);
const profileOf = (u: string) => path.join(home(u), "chrome-profile");
const cookieFile = (u: string) => path.join(home(u), "cookies.json");

interface Cookies {
  sessionid: string;
  csrftoken: string;
  ds_user_id: string;
}

/** The person whose Mac this server runs on: the sign-in window opens on its screen. */
export const mayUseInstagram = (u: SessionUser) => u.role === "admin" && !isCloud();

/** Google Chrome on this Mac, or null. */
export function chromePath(): string | null {
  const app = "Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return [path.join("/", app), path.join(os.homedir(), app)].find((p) => existsSync(p)) ?? null;
}

function cookiesOf(u: string): Cookies | null {
  try {
    const c = JSON.parse(readFileSync(cookieFile(u), "utf8")) as Cookies;
    return c.sessionid ? c : null;
  } catch {
    return null;
  }
}

export function saveCookies(u: string, c: Cookies): void {
  mkdirSync(home(u), { recursive: true, mode: 0o700 });
  writeFileSync(cookieFile(u), JSON.stringify(c), { mode: 0o600 });
}

const signingIn = new Set<string>();
const lastError = new Map<string, string>();

export interface InstagramLoginState {
  chrome: boolean;
  signedIn: boolean;
  signingIn: boolean;
  error: string | null;
}

export const loginState = (u: string): InstagramLoginState => ({
  chrome: !!chromePath(),
  signedIn: !!cookiesOf(u),
  signingIn: signingIn.has(u),
  error: lastError.get(u) ?? null,
});

/** A Chrome window on Instagram's sign-in page; it closes once Instagram has set the session cookie. */
export function startSignIn(u: string): void {
  if (signingIn.has(u)) return;
  const exe = chromePath();
  if (!exe) return void lastError.set(u, "Needs Google Chrome on this Mac");
  signingIn.add(u);
  lastError.delete(u);
  void (async () => {
    const { chromium } = await import("playwright-chromium");
    mkdirSync(profileOf(u), { recursive: true, mode: 0o700 });
    const ctx = await chromium.launchPersistentContext(profileOf(u), {
      executablePath: exe,
      headless: false,
      viewport: { width: 1000, height: 800 },
      ignoreDefaultArgs: ["--enable-automation"],
      args: ["--disable-blink-features=AutomationControlled"],
    });
    let open = true;
    ctx.on("close", () => (open = false));
    try {
      // a session Instagram ended may still sit in the profile: never take it back, always a fresh sign-in
      await ctx.clearCookies();
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.goto("https://www.instagram.com/accounts/login/").catch(() => {});
      for (const end = Date.now() + IG.loginMs; open && Date.now() < end; ) {
        await new Promise((r) => setTimeout(r, 2000));
        const all = await ctx.cookies("https://www.instagram.com").catch(() => null);
        if (!all) break;
        const get = (n: string) => all.find((c) => c.name === n)?.value ?? "";
        if (get("sessionid") && get("ds_user_id")) {
          saveCookies(u, { sessionid: get("sessionid"), csrftoken: get("csrftoken"), ds_user_id: get("ds_user_id") });
          break;
        }
      }
    } finally {
      await ctx.close().catch(() => {});
    }
  })()
    .catch((e) => lastError.set(u, `Could not open Chrome: ${e instanceof Error ? e.message : String(e)}`))
    .finally(() => signingIn.delete(u));
}

/** Forgets the cookies and the Chrome profile. */
export function signOut(u: string): void {
  rmSync(home(u), { recursive: true, force: true });
  lastError.delete(u);
}

/* ---- a post by its link ---- */

export class InstagramRefused extends Error {}

/** A link's post code and the media id Instagram's API takes (a private post's code carries 28 more characters). */
export function postOf(link: string): { code: string; id: string } {
  const code = shortcodeFromUrl(link);
  if (!code) throw new InstagramRefused("Needs a link to an Instagram post or reel");
  return { code, id: shortcodeToMediaId(code.length > 28 ? code.slice(0, -28) : code) };
}

export interface PostFile {
  url: string;
  kind: "video" | "picture";
}

interface Version {
  url: string;
  width?: number;
  height?: number;
}
interface Item {
  code?: string;
  user?: { username?: string };
  video_versions?: Version[];
  image_versions2?: { candidates?: Version[] };
  carousel_media?: Item[];
}

const largest = (v?: Version[]) => v?.reduce<Version | undefined>((a, b) => (!a || (b.width ?? 0) > (a.width ?? 0) ? b : a), undefined);

/** Each video or picture of a post (a carousel's in order), the largest Instagram gives. */
export function filesOf(item: Item): PostFile[] {
  const one = (i: Item): PostFile | null => {
    const video = largest(i.video_versions)?.url;
    if (video) return { url: video, kind: "video" };
    const pic = largest(i.image_versions2?.candidates)?.url;
    return pic ? { url: pic, kind: "picture" } : null;
  };
  return (item.carousel_media?.length ? item.carousel_media.map(one) : [one(item)]).filter((f): f is PostFile => !!f);
}

// one call at a time for the whole server, a few seconds apart: on demand, at a person's pace
let turn: Promise<unknown> = Promise.resolve();
let lastCall = 0;
export const PACE = { ms: 3000 };

/** One call to Instagram's web API with the person's own sign-in, in turn; a signed-out session forgets the cookies. */
function igCall<T>(u: string, url: string, init: { form?: Record<string, string>; signal?: AbortSignal; what?: string } = {}): Promise<T> {
  const run = turn.then(async () => {
    const wait = lastCall + PACE.ms - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await callNow<T>(u, url, init);
    } finally {
      lastCall = Date.now();
    }
  });
  turn = run.catch(() => {});
  return run;
}

async function callNow<T>(u: string, url: string, { form, signal, what = "the post" }: { form?: Record<string, string>; signal?: AbortSignal; what?: string }): Promise<T> {
  signal?.throwIfAborted();
  const c = cookiesOf(u);
  if (!c) throw new InstagramRefused("Needs an Instagram sign-in");
  const r = await fetch(`https://www.instagram.com${url}`, {
    method: form ? "POST" : "GET",
    headers: {
      cookie: `sessionid=${c.sessionid}; csrftoken=${c.csrftoken}; ds_user_id=${c.ds_user_id}`,
      "x-ig-app-id": IG.appId,
      "x-csrftoken": c.csrftoken,
      "x-requested-with": "XMLHttpRequest",
      referer: "https://www.instagram.com/",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(form ? { body: new URLSearchParams(form).toString() } : {}),
    redirect: "manual",
    ...(signal ? { signal } : {}),
  });
  const body = (await r.json().catch(() => null)) as (T & { message?: string }) | null;
  // a signed-out session: Instagram sends to its login page, or says login_required
  if (r.status === 401 || (r.status >= 300 && r.status < 400) || body?.message === "login_required" || body?.message === "checkpoint_required") {
    rmSync(cookieFile(u), { force: true });
    throw new InstagramRefused("Instagram signed this account out. Sign in again");
  }
  if (r.status === 429 || /wait a few minutes/i.test(body?.message ?? "")) throw new InstagramRefused("Instagram asked to wait. Try again later");
  if (r.status === 404) throw new InstagramRefused(`${what.charAt(0).toUpperCase()}${what.slice(1)} not found`);
  if (!r.ok || !body) throw new InstagramRefused(`Could not read ${what}. Try again later`);
  return body;
}

/** A post's files and whose it is, read with the person's own sign-in. */
export async function readPost(u: string, link: string): Promise<{ username: string; code: string; files: PostFile[] }> {
  const { code, id } = postOf(link);
  const body = await igCall<{ items?: Item[] }>(u, `/api/v1/media/${id}/info/`);
  const item = body.items?.[0];
  if (!item) throw new InstagramRefused("Post not found");
  const files = filesOf(item);
  if (!files.length) throw new InstagramRefused("This post has no video or photo");
  return { username: item.user?.username ?? "instagram", code: item.code ?? code, files };
}

/* ---- an account's profile, grid and Reels tab (the Content Analyzer, an own account with no Meta sign-in) ---- */

/** Signed in here: the Content Analyzer may read through it. */
export const hasInstagramSession = (u: string) => !!cookiesOf(u);

interface FeedItem extends Item {
  pk?: string | number;
  user?: { username?: string; full_name?: string; pk?: string | number };
  video_duration?: number;
  accessibility_caption?: string;
  carousel_media?: FeedItem[];
  taken_at?: number;
  media_type?: number;
  product_type?: string;
  caption?: { text?: string } | null;
  like_count?: number;
  comment_count?: number;
  play_count?: number;
  view_count?: number;
}

/** One item of the web API's feed as the Content Analyzer's catalog item. */
export function catalogItemOf(i: FeedItem): CatalogItem | null {
  if (!i.code) return null;
  const reel = i.product_type === "clips";
  const caption = i.caption?.text ?? "";
  return {
    shortcode: i.code,
    ...(i.pk != null ? { graphId: String(i.pk).split("_")[0] } : {}),
    url: canonicalPostUrl(i.code, reel),
    kind: i.media_type === 8 || i.carousel_media?.length ? "carousel" : reel ? "reel" : "post",
    takenAt: (i.taken_at ?? 0) * 1000,
    thumbnailUrl: largest(i.image_versions2?.candidates ?? i.carousel_media?.[0]?.image_versions2?.candidates)?.url,
    captionPreview: caption ? caption.slice(0, 180) : undefined,
    counts: { likes: i.like_count, comments: i.comment_count, plays: i.play_count ?? i.view_count },
  };
}

/** An account's profile, by its handle. */
export async function readProfile(u: string, handle: string, signal?: AbortSignal): Promise<ProfileInfo> {
  const what = `@${handle}`;
  const p = await igCall<{ data?: { user?: WebUser } }>(u, `/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`, { signal, what });
  const w = p.data?.user;
  if (!w?.id) throw new InstagramRefused(`${what} not found`);
  return {
    igUserId: w.id,
    username: w.username ?? handle,
    fullName: w.full_name || undefined,
    biography: w.biography || undefined,
    profilePic: w.profile_pic_url_hd || w.profile_pic_url || undefined,
    isPrivate: w.is_private,
    isVerified: w.is_verified,
    followers: w.edge_followed_by?.count,
    following: w.edge_follow?.count,
    posts: w.edge_owner_to_timeline_media?.count,
  };
}

/** The account's grid and its Reels tab (reels kept off the grid too), newest first, up to `cap`. */
export async function readAccount(u: string, handle: string, cap: number, signal?: AbortSignal, id?: string): Promise<CatalogItem[]> {
  const what = `@${handle}`;
  const w = { id: id ?? (await readProfile(u, handle, signal)).igUserId };
  const found = new Map<string, CatalogItem>();
  const take = (list: FeedItem[] = []) => list.map(catalogItemOf).forEach((c) => c && !found.has(c.shortcode) && found.set(c.shortcode, c));
  for (let max = "", n = 0; n < cap; ) {
    const page = await igCall<{ items?: FeedItem[]; more_available?: boolean; next_max_id?: string }>(u, `/api/v1/feed/user/${w.id}/?count=33${max ? `&max_id=${max}` : ""}`, { signal, what });
    take(page.items);
    n += page.items?.length ?? 0;
    if (!page.more_available || !page.next_max_id || !page.items?.length) break;
    max = page.next_max_id;
  }
  for (let max = "", n = 0; n < cap; ) {
    const page = await igCall<{ items?: { media?: FeedItem }[]; paging_info?: { max_id?: string; more_available?: boolean } }>(u, "/api/v1/clips/user/", {
      form: { target_user_id: w.id, page_size: "24", include_feed_video: "true", ...(max ? { max_id: max } : {}) },
      signal,
      what,
    });
    take(page.items?.map((x) => x.media).filter((m): m is FeedItem => !!m));
    n += page.items?.length ?? 0;
    if (!page.paging_info?.more_available || !page.paging_info.max_id || !page.items?.length) break;
    max = page.paging_info.max_id;
  }
  return [...found.values()].sort((a, b) => b.takenAt - a.takenAt).slice(0, cap);
}

interface WebUser {
  id?: string;
  username?: string;
  full_name?: string;
  biography?: string;
  profile_pic_url?: string;
  profile_pic_url_hd?: string;
  is_private?: boolean;
  is_verified?: boolean;
  edge_followed_by?: { count?: number };
  edge_follow?: { count?: number };
  edge_owner_to_timeline_media?: { count?: number };
}

/* ---- one post in full, and its comments (the Content Analyzer's own reads, when there is no Apify key) ---- */


/** A post as the Content Analyzer's pipeline takes it: its slides (videos with their poster), caption and counts. */
export async function readPostInfo(u: string, url: string, signal?: AbortSignal): Promise<{ raw: unknown; info: PostInfo }> {
  const { code, id } = postOf(url);
  const body = await igCall<{ items?: FeedItem[] }>(u, `/api/v1/media/${id}/info/`, { signal });
  const raw = body.items?.[0];
  if (!raw) throw new InstagramRefused("Post not found");
  const card = catalogItemOf(raw);
  const slideOf = (i: FeedItem, index: number): PostInfoSlide | null => {
    const video = largest(i.video_versions);
    const pic = largest(i.image_versions2?.candidates);
    const v = video ?? pic;
    if (!v) return null;
    return {
      index,
      kind: video ? "video" : "image",
      url: v.url,
      width: v.width ?? 0,
      height: v.height ?? 0,
      ...(video && i.video_duration ? { durationS: i.video_duration } : {}),
      ...(video && pic ? { coverUrl: pic.url } : {}),
      ...(i.accessibility_caption ? { accessibilityCaption: i.accessibility_caption } : {}),
    };
  };
  const slides = (raw.carousel_media?.length ? raw.carousel_media : [raw]).map(slideOf).filter((x): x is PostInfoSlide => !!x);
  return {
    raw,
    info: {
      shortcode: raw.code ?? code,
      mediaId: String(raw.pk ?? id).split("_")[0]!,
      kind: card?.kind ?? "post",
      url: card?.url ?? url,
      creator: { username: raw.user?.username ?? "", ...(raw.user?.full_name ? { fullName: raw.user.full_name } : {}), id: String(raw.user?.pk ?? "") },
      takenAt: (raw.taken_at ?? 0) * 1000,
      caption: raw.caption?.text ?? "",
      counts: card?.counts ?? {},
      slides,
    },
  };
}

interface WebComment {
  pk?: string | number;
  text?: string;
  created_at?: number;
  user?: { pk?: string | number; username?: string };
  comment_like_count?: number;
  child_comment_count?: number;
}

/** A post's comments, newest pages first, up to `cap` (their replies are counted, not read). */
export async function readComments(u: string, url: string, cap: number, signal?: AbortSignal): Promise<{ comments: Comment[]; status: CommentsStatus; cursor?: string }> {
  const { id } = postOf(url);
  const comments: Comment[] = [];
  let cursor = "";
  for (;;) {
    const page = await igCall<{ comments?: WebComment[]; next_min_id?: string; has_more_comments?: boolean; has_more_headload_comments?: boolean }>(
      u,
      `/api/v1/media/${id}/comments/?can_support_threading=true&permalink_enabled=false${cursor ? `&min_id=${encodeURIComponent(cursor)}` : ""}`,
      { signal },
    );
    for (const c of page.comments ?? [])
      comments.push({
        id: String(c.pk ?? ""),
        text: c.text ?? "",
        createdAt: (c.created_at ?? 0) * 1000,
        user: { username: c.user?.username ?? "", id: String(c.user?.pk ?? "") },
        likeCount: c.comment_like_count ?? 0,
        replyCount: c.child_comment_count ?? 0,
        replies: [],
      });
    const more = !!page.next_min_id && (page.has_more_comments || page.has_more_headload_comments) && !!page.comments?.length;
    if (!more) return { comments: comments.slice(0, cap), status: "complete" };
    cursor = page.next_min_id!;
    if (comments.length >= cap) return { comments: comments.slice(0, cap), status: "capped", cursor };
  }
}
