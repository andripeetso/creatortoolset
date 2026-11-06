/**
 * YouTube link parsing: watch?v=, youtu.be/, /shorts/, /live/, /embed/ on
 * youtube.com, www./m. subdomains. A Short is kind "reel" in the library;
 * a long video is "post" with platform "youtube".
 */

const ID = /^[A-Za-z0-9_-]{11}$/;
const YT_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtu.be"]);
const FIND_URL = /(?:https?:\/\/)?(?:(?:www|m)\.)?(?:youtube\.com|youtu\.be)\/[^\s<>"']+/gi;

export class YoutubeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YoutubeUrlError";
  }
}

export interface YoutubeRef {
  videoId: string;
  /** Canonical watch or Shorts URL. */
  canonical: string;
  short: boolean;
}

/** Null when the text is not a YouTube link at all; throws when it is one but has no video id. */
export function parseYoutubeUrl(raw: string): YoutubeRef | null {
  let text = raw.trim();
  if (!/^(https?:\/\/|(www|m)\.|youtu\.be|youtube\.com)/i.test(text)) return null;
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!YT_HOSTS.has(host)) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  let videoId: string | undefined;
  let short = false;
  if (host.endsWith("youtu.be")) {
    videoId = parts[0];
  } else if (parts[0] === "watch") {
    videoId = url.searchParams.get("v") ?? undefined;
  } else if (parts[0] === "shorts") {
    videoId = parts[1];
    short = true;
  } else if (parts[0] === "live" || parts[0] === "embed") {
    videoId = parts[1];
  }
  if (!videoId || !ID.test(videoId)) {
    throw new YoutubeUrlError("Paste a YouTube video or Short link");
  }
  return {
    videoId,
    short,
    canonical: short
      ? `https://www.youtube.com/shorts/${videoId}`
      : `https://www.youtube.com/watch?v=${videoId}`,
  };
}

export function isYoutubeLink(raw: string): boolean {
  try {
    return parseYoutubeUrl(raw) !== null;
  } catch {
    return true;
  }
}

/** Every YouTube video / Short link in a blob of text, de-duplicated by video id. */
export function extractYoutubeUrls(text: string, limit = 40): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(FIND_URL.source, "gi"))) {
    const raw = m[0].replace(/[),.]+$/g, "");
    let ref: YoutubeRef | null;
    try {
      ref = parseYoutubeUrl(raw);
    } catch {
      continue;
    }
    if (!ref || seen.has(ref.videoId)) continue;
    seen.add(ref.videoId);
    out.push(ref.canonical);
    if (out.length >= limit) break;
  }
  return out;
}
