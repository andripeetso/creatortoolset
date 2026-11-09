import type { Comment } from "./types";

/**
 * Cheap "is this comment worth reading" heuristics. Drops one-word,
 * emoji-only, mention-only, repeated-token, obvious-spam and duplicate
 * comments. Marks rather than deletes: the UI hides low-value comments
 * by default and can show them on request.
 */

const EMOJI_RE = /[\p{Extended_Pictographic}\p{Emoji_Component}️‍]/gu;
const MENTION_RE = /@[A-Za-z0-9_.]+/g;
const URL_RE = /https?:\/\/\S+|www\.\S+/gi;
const HASHTAG_RE = /#[\p{L}\p{N}_]+/gu;
const PUNCT_RE = /[^\p{L}\p{N}\s]/gu;

const SPAM_PATTERNS = [
  /^first!*$/i,
  /\bfollow (me|back|4 follow|for follow)\b/i,
  /\bf4f\b|\bl4l\b/i,
  /\bcheck (out )?my (page|profile|bio|link)\b/i,
  /\bdm me\b/i,
  /\bpromo ?code\b/i,
  /\bfree (followers|likes|views)\b/i,
  /\bcashapp\b|\bwhatsapp\b.*\+?\d{6,}/i,
];

/** Lowercase words only: no emoji, mentions, links, hashtags or punctuation. */
export function normalizeComment(text: string): string {
  return text
    .replace(URL_RE, " ")
    .replace(MENTION_RE, " ")
    .replace(HASHTAG_RE, " ")
    .replace(EMOJI_RE, " ")
    .replace(PUNCT_RE, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param seen normalized texts already seen on this post — a repeat of
 * one of them is low value too. Pass the same set for every comment.
 */
export function isLowValue(text: string, seen?: Set<string>): boolean {
  const raw = text.trim();
  if (!raw) return true;
  if (SPAM_PATTERNS.some((re) => re.test(raw))) return true;
  const stripped = normalizeComment(raw);
  const words = stripped.split(" ").filter(Boolean);
  if (!words.length) return true; // emoji / mentions / links only
  if (words.length === 1) return true;
  if (stripped.length <= 3) return true;
  if (new Set(words).size === 1) return true; // "fire fire fire"
  if (words.length <= 3 && words.every((w) => w.length <= 2)) return true; // "so so so"
  if (seen) {
    if (seen.has(stripped)) return true;
    seen.add(stripped);
  }
  return false;
}

/** Sets `lowValue` on every comment and reply; returns how many were flagged. */
export function annotateLowValue(comments: Comment[]): { filteredOut: number } {
  const seen = new Set<string>();
  let filteredOut = 0;
  const walk = (list: Comment[]) => {
    for (const c of list) {
      c.lowValue = isLowValue(c.text, seen);
      if (c.lowValue) filteredOut++;
      if (c.replies?.length) walk(c.replies);
    }
  };
  walk(comments);
  return { filteredOut };
}

/** Merge a fresh collection into a stored one, deduping by id. */
export function mergeComments(existing: Comment[], fresh: Comment[]): Comment[] {
  const byId = new Map<string, Comment>();
  for (const c of [...existing, ...fresh]) {
    const prev = byId.get(c.id);
    if (!prev) {
      byId.set(c.id, { ...c, replies: [...(c.replies ?? [])] });
      continue;
    }
    const seen = new Set(prev.replies.map((r) => r.id));
    for (const r of c.replies ?? []) if (!seen.has(r.id)) prev.replies.push(r);
    if (c.likeCount > prev.likeCount) prev.likeCount = c.likeCount;
    if (c.replyCount > prev.replyCount) prev.replyCount = c.replyCount;
  }
  return [...byId.values()];
}

export const countReplies = (list: Comment[]): number =>
  list.reduce((n, c) => n + (c.replies?.length ?? 0), 0);
