/**
 * Which of the author's posts and rewrites sit next to the piece. Writing like one person stops getting
 * better after about five of their own texts, so the five closest to this piece matter more
 * than all of them: the 15 posts nearest in words, of those the 5 most saved and shared; the rewrites nearest in
 * words, topped up with the newest. Everything else stays in the folder.
 */
import type { EditPair } from "./edit-log";
import { keptPer1k, type OwnPost } from "./folder";
import { postWords, tfidf } from "./posted";

const POOL = 15;
/** A repost of the same script counts once: the same words add nothing. */
const SAME = 0.8;

export function closestPosts(query: string, posts: OwnPost[], n = 5): OwnPost[] {
  const withWords = posts.filter((p) => postWords(p).trim());
  const { vec, cos } = tfidf([query, ...withWords.map(postWords)]);
  const q = vec(query);
  const ranked = withWords
    .map((p) => ({ p, v: vec(postWords(p)) }))
    .map((x) => ({ ...x, s: cos(q, x.v) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, POOL)
    .sort((a, b) => (keptPer1k(b.p.item) ?? -1) - (keptPer1k(a.p.item) ?? -1)); // stable: posts without numbers keep their order
  const out: typeof ranked = [];
  for (const x of ranked) if (out.length < n && !out.some((o) => cos(o.v, x.v) > SAME)) out.push(x);
  return out.map((x) => x.p);
}

export function closestPairs(query: string, pairs: EditPair[], n: number): EditPair[] {
  const text = (p: EditPair) => `${p.from}\n${p.to}`;
  const { vec, cos } = tfidf([query, ...pairs.map(text)]);
  const q = vec(query);
  const near = pairs
    .map((p) => ({ p, s: cos(q, vec(text(p))) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, n)
    .map((x) => x.p);
  const newest = [...pairs].reverse().filter((p) => !near.includes(p));
  return [...near, ...newest].slice(0, n);
}
