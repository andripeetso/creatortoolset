/**
 * Instagram link parsing. Accepts post / reel / tv URLs (with or without
 * the creator's username in the path), login-redirect URLs that carry the
 * target in ?next=, and the opaque /share/... links the mobile app
 * produces (kept as links: nothing here fetches instagram.com; the
 * user's own Apify key reads them).
 */

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const SHORTCODE = /^[A-Za-z0-9_-]{5,40}$/;
const POST_PATH = /(?:^|\/)(p|reel|reels|tv)\/([A-Za-z0-9_-]{5,40})(?=\/|$|\?)/;
const POST_IN_TEXT =
  /instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]{5,40})/;
const SHARE_PATH = /^\/share\//;
const PAGE_HOSTS = new Set([
  "instagram.com",
  "www.instagram.com",
  "m.instagram.com",
]);

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
const HANDLE = /^[A-Za-z0-9._]{1,30}$/;

export class InstagramUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstagramUrlError";
  }
}

/** Instagram's shortcode is a base-64 big-endian encoding of the media id. */
export function shortcodeToMediaId(code: string): string {
  if (!SHORTCODE.test(code)) {
    throw new InstagramUrlError("Not an Instagram shortcode");
  }
  let n = 0n;
  for (const ch of code) n = n * 64n + BigInt(ALPHABET.indexOf(ch));
  return n.toString();
}

export function canonicalPostUrl(shortcode: string, reel: boolean): string {
  return reel
    ? `https://www.instagram.com/reel/${shortcode}/`
    : `https://www.instagram.com/p/${shortcode}/`;
}

export interface PostRef {
  shortcode: string;
  /** The URL said reel/tv rather than p; the media info is authoritative. */
  reelHint: boolean;
}

export type ParsedInstagramUrl =
  | ({ kind: "post"; canonical: string } & PostRef)
  | { kind: "share"; url: string }
  | { kind: "profile"; username: string; url: string };

export function canonicalProfileUrl(username: string): string {
  return `https://www.instagram.com/${username}/`;
}

export function parseProfileHandle(raw: string): string | null {
  const t = raw.trim();
  if (t.startsWith("@") && HANDLE.test(t.slice(1))) return t.slice(1);
  if (HANDLE.test(t)) return t;
  try {
    const url = toUrl(t);
    if (postFromUrl(url) || SHARE_PATH.test(url.pathname)) return null;
    const m = /^\/([A-Za-z0-9._]{1,30})\/?$/.exec(url.pathname);
    if (!m) return null;
    const user = m[1];
    if (RESERVED_PROFILES.has(user.toLowerCase())) return null;
    return user;
  } catch {
    return null;
  }
}

function toUrl(raw: string): URL {
  let text = raw.trim();
  if (!text) throw new InstagramUrlError("Paste an Instagram link");
  if (!/^https?:\/\//i.test(text)) text = `https://${text.replace(/^\/+/, "")}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new InstagramUrlError("That is not a valid link");
  }
  if (!PAGE_HOSTS.has(url.hostname.toLowerCase())) {
    throw new InstagramUrlError("Only instagram.com links are supported");
  }
  return url;
}

/** Post reference from a URL's path, or from the ?next= of a login redirect. */
export function postFromUrl(url: URL): PostRef | null {
  const m = POST_PATH.exec(url.pathname);
  if (m) return { shortcode: m[2], reelHint: m[1] !== "p" };
  const next = url.searchParams.get("next");
  if (next) {
    const m2 = POST_PATH.exec(next);
    if (m2) return { shortcode: m2[2], reelHint: m2[1] !== "p" };
  }
  return null;
}

/** First post link found in free text (HTML bodies, escaped JSON). */
export function postFromText(text: string): PostRef | null {
  const m = POST_IN_TEXT.exec(text.replace(/\\\//g, "/"));
  return m ? { shortcode: m[2], reelHint: m[1] !== "p" } : null;
}

const FIND_URL =
  /(?:https?:\/\/)?(?:www\.|m\.)?instagram\.com\/(?:share\/|(?:[A-Za-z0-9_.]+\/)?(?:p|reel|reels|tv)\/)[^\s<>"']+/gi;

/**
 * Every post / reel / share link in a blob of text, de-duplicated.
 * Used for batch paste (one per line, or a dumped list).
 */
export function extractInstagramUrls(text: string, limit = 40): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = new RegExp(FIND_URL.source, "gi");
  for (const m of text.matchAll(re)) {
    let raw = m[0].replace(/[),.]+$/g, "");
    if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
    let parsed: ParsedInstagramUrl;
    try {
      parsed = parseInstagramUrl(raw);
    } catch {
      continue;
    }
    const key =
      parsed.kind === "post" ? parsed.shortcode.toLowerCase() : parsed.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed.kind === "post" ? parsed.canonical : parsed.url);
    if (out.length >= limit) break;
  }
  return out;
}

export function parseInstagramUrl(raw: string): ParsedInstagramUrl {
  const trimmed = raw.trim();
  const handleOnly = trimmed.startsWith("@") ? parseProfileHandle(trimmed) : null;
  if (handleOnly) {
    return { kind: "profile", username: handleOnly, url: canonicalProfileUrl(handleOnly) };
  }
  const url = toUrl(raw);
  const post = postFromUrl(url);
  if (post) {
    return {
      kind: "post",
      ...post,
      canonical: canonicalPostUrl(post.shortcode, post.reelHint),
    };
  }
  if (SHARE_PATH.test(url.pathname)) {
    url.search = "";
    url.hash = "";
    return { kind: "share", url: url.toString() };
  }
  const username = parseProfileHandle(raw);
  if (username) {
    return { kind: "profile", username, url: canonicalProfileUrl(username) };
  }
  throw new InstagramUrlError(
    "Paste a post, reel, carousel, share link, or an Instagram profile (@user)",
  );
}

const PROFILE_FIND =
  /(?:^|[\s<(,@])(?:@|(?:https?:\/\/)?(?:www\.|m\.)?instagram\.com\/)([A-Za-z0-9._]{1,30})(?=\/?(?:[\s>),?]|$))/gi;

/** Profile URLs and @handles in free text, de-duplicated. */
export function extractInstagramProfiles(text: string, limit = 20): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = new RegExp(PROFILE_FIND.source, "gi");
  for (const m of text.matchAll(re)) {
    const user = m[1];
    if (!user || RESERVED_PROFILES.has(user.toLowerCase())) continue;
    const key = user.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(canonicalProfileUrl(user));
    if (out.length >= limit) break;
  }
  return out;
}
