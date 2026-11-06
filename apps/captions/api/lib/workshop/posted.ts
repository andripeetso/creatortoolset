/**
 * Which of the author's posts a Workshop session became. The tf-idf of the Mac relay's script matcher, plus what only the server knows: a post can't be
 * older than its session, and one post belongs to one session. Only a clear match links; a pasted link
 * (`postedFromUrl`) covers the rest.
 */
import type { OwnPost } from "./folder";
import type { SessionMeta } from "./types";

const MATCH = 0.4; // cosine of the pieces' words against the post's, as the Mac relay
const MARGIN = 0.08; // ahead of the next post by this much, or it's a tie
const DAY = 86_400_000;

const words = (s: string) => s.toLowerCase().match(/[a-z']{3,}/g) ?? [];

/** A post's words: what was said, the slide text, the caption. */
export const postWords = (p: OwnPost) => [...(p.slides ?? []), p.item.caption ?? p.item.captionPreview].filter(Boolean).join("\n");

export interface Candidate {
  meta: Pick<SessionMeta, "id" | "createdAt" | "postedNot">;
  /** the pieces' blocks, descriptions and pinned comments */
  text: string;
}

/** Each candidate's post when the match is clear, newest sessions first so a remake doesn't take its original's post. */
/** tf-idf over these texts: a unit vector per text (only for texts in the list), and the cosine of two. */
export function tfidf(texts: string[]) {
  const df = new Map<string, number>();
  for (const t of texts) for (const w of new Set(words(t))) df.set(w, (df.get(w) ?? 0) + 1);
  const vec = (s: string) => {
    const tf = new Map<string, number>();
    for (const w of words(s)) tf.set(w, (tf.get(w) ?? 0) + 1);
    const v = new Map<string, number>();
    for (const [w, n] of tf) v.set(w, (1 + Math.log(n)) * Math.log(texts.length / df.get(w)!));
    const z = Math.sqrt([...v.values()].reduce((a, x) => a + x * x, 0)) || 1;
    for (const [w, x] of v) v.set(w, x / z);
    return v;
  };
  const cos = (a: Map<string, number>, b: Map<string, number>) => [...a].reduce((n, [w, x]) => n + x * (b.get(w) ?? 0), 0);
  return { vec, cos };
}

export function matchPosted(candidates: Candidate[], posts: OwnPost[], taken = new Set<string>()): Map<string, OwnPost> {
  const { vec, cos } = tfidf([...candidates.map((c) => c.text), ...posts.map(postWords)]);
  const pv = posts.map((p) => vec(postWords(p)));
  const out = new Map<string, OwnPost>();
  for (const c of [...candidates].sort((a, b) => b.meta.createdAt - a.meta.createdAt)) {
    const v = vec(c.text);
    const scored = posts
      .map((p, i) => ({ p, s: cos(v, pv[i]) }))
      .filter(({ p }) => p.item.takenAt >= c.meta.createdAt - DAY && !taken.has(p.item.shortcode) && !c.meta.postedNot?.includes(p.item.shortcode))
      .sort((a, b) => b.s - a.s);
    const [best, next] = scored;
    if (best && best.s >= MATCH && (!next || best.s - next.s >= MARGIN)) {
      out.set(c.meta.id, best.p);
      taken.add(best.p.item.shortcode);
    }
  }
  return out;
}

/** The post a pasted Instagram link points at, as the link the session keeps. */
export function postedFromUrl(raw: string): { shortcode: string; url: string } | null {
  const m = raw.trim().match(/^(?:https?:\/\/)?(?:www\.|m\.)?instagram\.com\/(?:[\w.]+\/)?(?:p|reel|reels|tv)\/([\w-]{5,})/i);
  return m ? { shortcode: m[1], url: `https://www.instagram.com/p/${m[1]}/` } : null;
}
