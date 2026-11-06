/**
 * Maps one YouTube Apify item (streamers/youtube-scraper, field names as
 * documented: title, text, thumbnailUrl, viewCount, likes, commentsCount,
 * date, duration "HH:MM:SS", channelName, channelUrl, subtitles[].srt)
 * onto the library's PostInfo, and turns an SRT file into timed words so
 * the transcript reads like any other post's.
 */
import type { PostInfo, SpokenWord } from "../instagram/types";
import type { YoutubeRef } from "./url";

type Rec = Record<string, unknown>;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;
const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/,/g, "")) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** "00:03:17" or "03:17" → seconds. */
export function durationSeconds(v: unknown): number | undefined {
  const s = str(v);
  if (!s || !/^\d+(:\d{1,2}){1,2}$/.test(s)) return undefined;
  return s.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
}

/** SRT time "00:01:02,500" or "00:01:02.500" → seconds. */
function srtTime(v: string): number {
  const m = /^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(v.trim());
  if (!m) return NaN;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0")) / 1000;
}

/**
 * Timed words from an SRT. Each cue's words share its time span evenly
 * (SRT has no word timing). Auto-captions repeat the previous line at the
 * start of each cue; that repeat is dropped.
 */
export function srtToWords(srt: string): SpokenWord[] {
  const out: SpokenWord[] = [];
  let prev: string[] = [];
  for (const block of srt.replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = block.trim().split("\n");
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue;
    const [from, to] = lines[at].split("-->").map(srtTime);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    const all = lines.slice(at + 1).join(" ").replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean);
    let words = all;
    if (prev.length && all.length >= prev.length && prev.every((w, i) => w === all[i])) {
      words = all.slice(prev.length);
    }
    prev = all;
    if (!words.length) continue;
    const span = Math.max(0, to - from);
    words.forEach((text, i) => {
      out.push({
        text,
        start: Math.round((from + (span * i) / words.length) * 100) / 100,
        end: Math.round((from + (span * (i + 1)) / words.length) * 100) / 100,
      });
    });
  }
  return out;
}

/** The SRT to use: English first, else the first track that came with text. */
export function pickSrt(item: Rec): string | undefined {
  const subs = Array.isArray(item.subtitles) ? (item.subtitles as Rec[]) : [];
  const withText = subs.filter((s) => str(s.srt));
  const en = withText.find((s) => str(s.language)?.toLowerCase().startsWith("en"));
  return str((en ?? withText[0])?.srt);
}

/** Channel handle (@name) or channel key, from the channel URL. */
function channelKey(channelUrl: string | undefined): string | undefined {
  const m = channelUrl && /youtube\.com\/((?:@|channel\/|c\/|user\/)[^/?#]+)/i.exec(channelUrl);
  return m ? decodeURIComponent(m[1]) : undefined;
}

export function normalizeYoutubeItem(raw: unknown, ref: YoutubeRef): PostInfo {
  const item = (raw ?? {}) as Rec;
  const channelName = str(item.channelName);
  const key = channelKey(str(item.channelUrl));
  const handle = key?.startsWith("@") ? key.slice(1) : undefined;
  const date = str(item.date);
  const takenAt = date && /^\d{4}-\d{2}-\d{2}/.test(date) ? Date.parse(date) : 0;
  const thumb = str(item.thumbnailUrl);
  const title = str(item.title);
  const text = str(item.text);
  const words = (() => {
    const srt = pickSrt(item);
    return srt ? srtToWords(srt) : undefined;
  })();
  return {
    shortcode: `yt-${ref.videoId}`,
    mediaId: "",
    kind: ref.short ? "reel" : "post",
    url: ref.canonical,
    creator: {
      username: handle ?? channelName ?? "",
      fullName: channelName,
      id: key ?? channelName ?? "",
    },
    takenAt: Number.isFinite(takenAt) ? takenAt : 0,
    caption: [title, text].filter(Boolean).join("\n\n"),
    counts: {
      likes: num(item.likes),
      comments: num(item.commentsCount),
      plays: num(item.viewCount),
    },
    slides: thumb
      ? [
          {
            index: 0,
            kind: "image",
            url: thumb,
            width: 0,
            height: 0,
            durationS: durationSeconds(item.duration),
          },
        ]
      : [],
    ...(words?.length ? { words } : {}),
  };
}
