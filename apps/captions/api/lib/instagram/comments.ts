import type { Comment } from "./types";

/** Comments come from Apify (apify.ts fetchCommentsViaApify) or, on the account's own posts, the official login. */

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
