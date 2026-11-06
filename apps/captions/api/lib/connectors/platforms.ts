import { createHash, randomBytes } from "node:crypto";
import type { LoginKind, SocialPlatform, SocialPost, SocialStats } from "../../../contracts/connectors";
import { apifyRun } from "../instagram/apify";
import { readApps, type StoredAccount } from "./store";

/**
 * The logins and the pulls.
 * Endpoints checked 2026-11-06 against Meta (Graph v27.0, Facebook Login manual flow), Google (OAuth web server
 * flow, YouTube Data v3, YouTube Analytics v2) and TikTok (Login Kit v2, Display API). A login needs its app on
 * our side: META_APP_ID/SECRET, GOOGLE_CLIENT_ID/SECRET, TIKTOK_CLIENT_KEY/SECRET. Without one the login is hidden
 * and the platform is still readable by handle through the user's own Apify token.
 */

const META = "https://graph.facebook.com/v27.0";
const TIMEOUT = 60_000;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const time = (v: unknown): number => {
  const n = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(str(v));
  return Number.isFinite(n) ? n : 0;
};

export function appFor(kind: LoginKind): { id: string; secret: string; configId?: string } | null {
  const saved = readApps()[kind];
  if (saved?.id && saved.secret) return saved;
  const [id, secret] =
    kind === "meta" ? [process.env.META_APP_ID, process.env.META_APP_SECRET] : kind === "google" ? [process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET] : [process.env.TIKTOK_CLIENT_KEY, process.env.TIKTOK_CLIENT_SECRET];
  return id?.trim() && secret?.trim() ? { id: id.trim(), secret: secret.trim() } : null;
}

async function getJson(url: string | URL, init?: RequestInit): Promise<Rec> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
  const body = (await res.json().catch(() => ({}))) as Rec;
  if (!res.ok || (isRec(body.error) && body.error.code !== "ok")) {
    const e = isRec(body.error) ? str(body.error.message) || str(body.error.code) : str(body.error_description) || str(body.error);
    throw new Error(e || `HTTP ${res.status}`);
  }
  return body;
}

const form = (params: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(params),
});

/* ---- starting a login ---- */

const META_SCOPES = ["pages_show_list", "pages_read_engagement", "pages_read_user_content", "read_insights", "business_management", "instagram_basic", "instagram_manage_insights", "instagram_manage_comments"];
const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/yt-analytics.readonly"];
const TIKTOK_SCOPES = ["user.info.basic", "user.info.profile", "user.info.stats", "video.list"];

/** The login page to send the user to, and the PKCE verifier to keep with the state (TikTok). */
export function loginUrl(kind: LoginKind, redirect: string, state: string): { url: string; verifier?: string } {
  const app = appFor(kind);
  if (!app) throw new Error("This login isn't set up on the server yet");
  if (kind === "meta") {
    const u = new URL("https://www.facebook.com/v27.0/dialog/oauth");
    // a Business-type app's "Facebook Login for Business" names its permissions in a configuration (config_id), not scope
    const which = app.configId ? { config_id: app.configId } : { scope: META_SCOPES.join(",") };
    Object.entries({ client_id: app.id, redirect_uri: redirect, state, ...which, response_type: "code" }).forEach(([k, v]) => u.searchParams.set(k, v));
    return { url: u.toString() };
  }
  if (kind === "google") {
    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    Object.entries({ client_id: app.id, redirect_uri: redirect, state, scope: GOOGLE_SCOPES.join(" "), response_type: "code", access_type: "offline", prompt: "consent", include_granted_scopes: "true" }).forEach(([k, v]) =>
      u.searchParams.set(k, v),
    );
    return { url: u.toString() };
  }
  // TikTok's docs disagree on PKCE for web; sending it is accepted either way (hex SHA-256, their desktop rule)
  const verifier = randomBytes(32).toString("hex");
  const u = new URL("https://www.tiktok.com/v2/auth/authorize/");
  Object.entries({ client_key: app.id, redirect_uri: redirect, state, scope: TIKTOK_SCOPES.join(","), response_type: "code", code_challenge: createHash("sha256").update(verifier).digest("hex"), code_challenge_method: "S256" }).forEach(([k, v]) =>
    u.searchParams.set(k, v),
  );
  return { url: u.toString(), verifier };
}

type NewAccount = Omit<StoredAccount, "key" | "connectedAt">;

/* ---- finishing a login: the accounts it gives ---- */

export async function finishLogin(kind: LoginKind, code: string, redirect: string, verifier?: string): Promise<NewAccount[]> {
  const app = appFor(kind)!;
  if (kind === "meta") {
    const short = await getJson(`${META}/oauth/access_token?${new URLSearchParams({ client_id: app.id, client_secret: app.secret, redirect_uri: redirect, code })}`);
    const long = await getJson(`${META}/oauth/access_token?${new URLSearchParams({ grant_type: "fb_exchange_token", client_id: app.id, client_secret: app.secret, fb_exchange_token: str(short.access_token) })}`);
    const fields = "id,name,username,access_token,followers_count,picture{url},instagram_business_account{id,username,name,profile_picture_url,followers_count,media_count}";
    const pages = await getJson(`${META}/me/accounts?${new URLSearchParams({ fields, limit: "100", access_token: str(long.access_token) })}`);
    const out: NewAccount[] = [];
    for (const p of Array.isArray(pages.data) ? pages.data.filter(isRec) : []) {
      const token = str(p.access_token); // a Page token from a long-lived user token does not expire
      const pic = isRec(p.picture) && isRec(p.picture.data) ? str(p.picture.data.url) : undefined;
      out.push({ platform: "facebook", platformId: str(p.id), handle: str(p.username) || str(p.name), name: str(p.name), avatar: pic, via: "login", token, stats: { followers: num(p.followers_count) } });
      const ig = isRec(p.instagram_business_account) ? p.instagram_business_account : null;
      if (ig) out.push({ platform: "instagram", platformId: str(ig.id), handle: str(ig.username), name: str(ig.name), avatar: str(ig.profile_picture_url) || undefined, via: "login", token, stats: { followers: num(ig.followers_count), posts: num(ig.media_count) } });
    }
    if (!out.length) throw new Error("That Facebook login manages no Pages. An Instagram professional account is read through the Facebook Page it is linked to");
    return out;
  }
  if (kind === "google") {
    const t = await getJson("https://oauth2.googleapis.com/token", form({ client_id: app.id, client_secret: app.secret, code, grant_type: "authorization_code", redirect_uri: redirect }));
    const token = str(t.access_token);
    const ch = await getJson("https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails&mine=true", { headers: { Authorization: `Bearer ${token}` } });
    const items = Array.isArray(ch.items) ? ch.items.filter(isRec) : [];
    if (!items.length) throw new Error("That Google account has no YouTube channel");
    return items.map((c) => {
      const sn = isRec(c.snippet) ? c.snippet : {};
      return {
        platform: "youtube" as const,
        platformId: str(c.id),
        handle: str(sn.customUrl).replace(/^@/, "") || str(sn.title),
        name: str(sn.title),
        avatar: isRec(sn.thumbnails) && isRec(sn.thumbnails.default) ? str(sn.thumbnails.default.url) : undefined,
        via: "login" as const,
        token,
        refresh: str(t.refresh_token) || undefined,
        expiresAt: Date.now() + (num(t.expires_in) ?? 3600) * 1000,
      };
    });
  }
  const t = await getJson("https://open.tiktokapis.com/v2/oauth/token/", form({ client_key: app.id, client_secret: app.secret, code, grant_type: "authorization_code", redirect_uri: redirect, ...(verifier ? { code_verifier: verifier } : {}) }));
  const token = str(t.access_token);
  const me = await tiktokUser(token);
  return [{ platform: "tiktok", platformId: str(t.open_id) || me.id, handle: me.handle, name: me.name, avatar: me.avatar, via: "login", token, refresh: str(t.refresh_token), expiresAt: Date.now() + (num(t.expires_in) ?? 7200) * 1000 }];
}

/** A login's token, renewed when it is about to run out (Google: an hour; TikTok: two hours and a new refresh token every time). */
export async function freshToken(a: StoredAccount): Promise<Pick<StoredAccount, "token" | "refresh" | "expiresAt">> {
  if (!a.expiresAt || a.expiresAt - Date.now() > 5 * 60_000 || !a.refresh) return { token: a.token, refresh: a.refresh, expiresAt: a.expiresAt };
  if (a.platform === "youtube") {
    const app = appFor("google")!;
    const t = await getJson("https://oauth2.googleapis.com/token", form({ client_id: app.id, client_secret: app.secret, refresh_token: a.refresh, grant_type: "refresh_token" }));
    return { token: str(t.access_token), refresh: str(t.refresh_token) || a.refresh, expiresAt: Date.now() + (num(t.expires_in) ?? 3600) * 1000 };
  }
  const app = appFor("tiktok")!;
  const t = await getJson("https://open.tiktokapis.com/v2/oauth/token/", form({ client_key: app.id, client_secret: app.secret, grant_type: "refresh_token", refresh_token: a.refresh }));
  return { token: str(t.access_token), refresh: str(t.refresh_token) || a.refresh, expiresAt: Date.now() + (num(t.expires_in) ?? 7200) * 1000 };
}

/* ---- pulls ---- */

export interface Pulled {
  stats: SocialStats;
  posts: SocialPost[];
  name?: string;
  avatar?: string;
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const DAYS = 28;

async function tiktokUser(token: string) {
  const fields = "open_id,avatar_url,display_name,username,follower_count,following_count,likes_count,video_count";
  const r = await getJson(`https://open.tiktokapis.com/v2/user/info/?fields=${fields}`, { headers: { Authorization: `Bearer ${token}` } });
  const u = isRec(r.data) && isRec(r.data.user) ? r.data.user : {};
  return {
    id: str(u.open_id),
    handle: str(u.username) || str(u.display_name),
    name: str(u.display_name),
    avatar: str(u.avatar_url) || undefined,
    stats: { followers: num(u.follower_count), following: num(u.following_count), likes: num(u.likes_count), posts: num(u.video_count) } as SocialStats,
  };
}

async function pullFacebook(a: StoredAccount): Promise<Pulled> {
  const q = (p: Record<string, string>) => new URLSearchParams({ ...p, access_token: a.token ?? "" });
  const page = await getJson(`${META}/${a.platformId}?${q({ fields: "name,username,followers_count,picture{url}" })}`);
  const posts = await getJson(`${META}/${a.platformId}/posts?${q({ fields: "id,message,created_time,permalink_url,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)", limit: "50" })}`);
  const until = Math.floor(Date.now() / 1000);
  const days = new Map<string, NonNullable<SocialStats["days"]>[number]>();
  // one metric at a time: Meta retires Page metrics often, and one gone must not lose the others
  for (const [metric, key] of [["page_media_view", "views"], ["page_follows", "followersGained"]] as const) {
    const r = await getJson(`${META}/${a.platformId}/insights?${q({ metric, period: "day", since: String(until - DAYS * 86400), until: String(until) })}`).catch(() => null);
    for (const row of r && Array.isArray(r.data) ? r.data.filter(isRec) : [])
      for (const v of Array.isArray(row.values) ? row.values.filter(isRec) : []) {
        const day = isoDay(time(v.end_time));
        days.set(day, { ...(days.get(day) ?? { day }), [key]: num(v.value) });
      }
  }
  const total = (v: unknown) => (isRec(v) && isRec(v.summary) ? num(v.summary.total_count) : undefined);
  return {
    name: str(page.name),
    avatar: isRec(page.picture) && isRec(page.picture.data) ? str(page.picture.data.url) : undefined,
    stats: { followers: num(page.followers_count), days: [...days.values()].sort((x, y) => x.day.localeCompare(y.day)) },
    posts: (Array.isArray(posts.data) ? posts.data.filter(isRec) : []).map((p) => ({
      id: str(p.id),
      url: str(p.permalink_url) || undefined,
      at: time(p.created_time),
      text: str(p.message),
      likes: total(p.reactions),
      comments: total(p.comments),
      shares: isRec(p.shares) ? num(p.shares.count) : undefined,
    })),
  };
}

const isoDuration = (v: string) => {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(v);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : undefined;
};

async function pullYoutube(a: StoredAccount): Promise<Pulled> {
  const h = { headers: { Authorization: `Bearer ${a.token}` } };
  const ch = await getJson(`https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails&id=${a.platformId}`, h);
  const c = Array.isArray(ch.items) && isRec(ch.items[0]) ? ch.items[0] : {};
  const st = isRec(c.statistics) ? c.statistics : {};
  const uploads = isRec(c.contentDetails) && isRec(c.contentDetails.relatedPlaylists) ? str(c.contentDetails.relatedPlaylists.uploads) : "";
  let posts: SocialPost[] = [];
  if (uploads) {
    const list = await getJson(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${uploads}`, h);
    const ids = (Array.isArray(list.items) ? list.items.filter(isRec) : []).map((i) => (isRec(i.snippet) && isRec(i.snippet.resourceId) ? str(i.snippet.resourceId.videoId) : "")).filter(Boolean);
    if (ids.length) {
      const vids = await getJson(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${ids.join(",")}`, h);
      posts = (Array.isArray(vids.items) ? vids.items.filter(isRec) : []).map((v) => {
        const sn = isRec(v.snippet) ? v.snippet : {};
        const s = isRec(v.statistics) ? v.statistics : {};
        return {
          id: str(v.id),
          url: `https://www.youtube.com/watch?v=${str(v.id)}`,
          at: time(sn.publishedAt),
          text: [str(sn.title), str(sn.description).slice(0, 500)].filter(Boolean).join("\n"),
          views: num(s.viewCount),
          likes: num(s.likeCount),
          comments: num(s.commentCount),
          duration: isRec(v.contentDetails) ? isoDuration(str(v.contentDetails.duration)) : undefined,
        };
      });
    }
  }
  const end = isoDay(Date.now());
  const start = isoDay(Date.now() - DAYS * 86_400_000);
  const rep = await getJson(`https://youtubeanalytics.googleapis.com/v2/reports?${new URLSearchParams({ ids: "channel==MINE", startDate: start, endDate: end, metrics: "views,estimatedMinutesWatched,subscribersGained", dimensions: "day", sort: "day" })}`, h).catch(() => null);
  const days = (rep && Array.isArray(rep.rows) ? rep.rows : []).filter(Array.isArray).map((r) => ({ day: str(r[0]), views: num(r[1]), watchMinutes: num(r[2]), followersGained: num(r[3]) }));
  return { stats: { followers: num(st.subscriberCount), views: num(st.viewCount), posts: num(st.videoCount), days }, posts };
}

async function pullTiktok(a: StoredAccount): Promise<Pulled> {
  const me = await tiktokUser(a.token ?? "");
  const fields = "id,title,video_description,create_time,share_url,view_count,like_count,comment_count,share_count,duration";
  const posts: SocialPost[] = [];
  let cursor: number | undefined;
  for (let page = 0; page < 3; page++) {
    const r = await getJson(`https://open.tiktokapis.com/v2/video/list/?fields=${fields}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${a.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ max_count: 20, ...(cursor ? { cursor } : {}) }),
    });
    const d = isRec(r.data) ? r.data : {};
    for (const v of Array.isArray(d.videos) ? d.videos.filter(isRec) : [])
      posts.push({ id: str(v.id), url: str(v.share_url) || undefined, at: time(v.create_time), text: str(v.video_description) || str(v.title), views: num(v.view_count), likes: num(v.like_count), comments: num(v.comment_count), shares: num(v.share_count), duration: num(v.duration) });
    if (!d.has_more) break;
    cursor = num(d.cursor);
  }
  return { name: me.name, avatar: me.avatar, stats: me.stats, posts };
}

/* ---- by handle, on the user's own Apify token (public numbers) ---- */

export const APIFY_ACTORS: Record<Exclude<SocialPlatform, "instagram">, string> = {
  tiktok: "clockworks~tiktok-scraper",
  x: "apidojo~tweet-scraper",
  youtube: "streamers~youtube-scraper",
  facebook: "apify~facebook-posts-scraper",
};

export function apifyInput(platform: Exclude<SocialPlatform, "instagram">, handle: string): Rec {
  if (platform === "tiktok") return { profiles: [handle], resultsPerPage: 50, profileSorting: "latest" };
  if (platform === "x") return { twitterHandles: [handle], maxItems: 50, sort: "Latest" };
  if (platform === "youtube") return { startUrls: [{ url: `https://www.youtube.com/@${handle}` }], maxResults: 50, maxResultsShorts: 50, maxResultStreams: 0 };
  return { startUrls: [{ url: `https://www.facebook.com/${handle}` }], resultsLimit: 50 };
}

/** One actor item → a post; the profile numbers the actors carry on each item go to stats. */
export function apifyPost(platform: Exclude<SocialPlatform, "instagram">, i: Rec): SocialPost | null {
  if (platform === "tiktok") return { id: str(i.id), url: str(i.webVideoUrl) || undefined, at: time(i.createTimeISO), text: str(i.text), views: num(i.playCount), likes: num(i.diggCount), comments: num(i.commentCount), shares: num(i.shareCount), duration: isRec(i.videoMeta) ? num(i.videoMeta.duration) : undefined };
  if (platform === "x") return { id: str(i.id), url: str(i.url) || undefined, at: time(i.createdAt), text: str(i.text), views: num(i.viewCount), likes: num(i.likeCount), comments: num(i.replyCount), shares: (num(i.retweetCount) ?? 0) + (num(i.quoteCount) ?? 0), saves: num(i.bookmarkCount) };
  if (platform === "youtube") return { id: str(i.id), url: str(i.url) || undefined, at: time(i.date), text: [str(i.title), str(i.text).slice(0, 500)].filter(Boolean).join("\n"), views: num(i.viewCount), likes: num(i.likes), comments: num(i.commentsCount) };
  return { id: str(i.postId), url: str(i.url) || undefined, at: time(i.time), text: str(i.text), views: num(i.viewsCount), likes: num(i.likes), comments: num(i.comments), shares: num(i.shares) };
}

function apifyStats(platform: Exclude<SocialPlatform, "instagram">, items: Rec[]): Pick<Pulled, "stats" | "name" | "avatar"> {
  const first = items[0] ?? {};
  if (platform === "tiktok" && isRec(first.authorMeta)) {
    const m = first.authorMeta;
    return { name: str(m.nickName) || str(m.name), avatar: str(m.avatar) || undefined, stats: { followers: num(m.fans), following: num(m.following), likes: num(m.heart), posts: num(m.video) } };
  }
  if (platform === "x" && isRec(first.author)) {
    const m = first.author;
    return { name: str(m.name), avatar: str(m.profilePicture) || undefined, stats: { followers: num(m.followers), following: num(m.following), posts: num(m.statusesCount) } };
  }
  if (platform === "youtube") return { name: str(first.channelName), stats: { followers: num(first.numberOfSubscribers) } };
  return { name: str(first.pageName), stats: {} };
}

async function pullApify(a: StoredAccount, username: string): Promise<Pulled> {
  const platform = a.platform as Exclude<SocialPlatform, "instagram">;
  const items = (await apifyRun(APIFY_ACTORS[platform], apifyInput(platform, a.handle), { username })).filter(isRec).filter((i) => !i.error);
  if (!items.length) throw new Error(`Apify found nothing for @${a.handle} on ${platform}`);
  return { ...apifyStats(platform, items), posts: items.map((i) => apifyPost(platform, i)).filter((p): p is SocialPost => !!p && !!p.id) };
}

/** Read an account's numbers and recent posts: its login when it has one, else Apify on the user's token. */
export async function pullAccount(a: StoredAccount, username: string): Promise<Pulled> {
  if (a.via === "apify") return pullApify(a, username);
  if (a.platform === "facebook") return pullFacebook(a);
  if (a.platform === "youtube") return pullYoutube(a);
  if (a.platform === "tiktok") return pullTiktok(a);
  throw new Error("Instagram is read by the Content Analyzer");
}
