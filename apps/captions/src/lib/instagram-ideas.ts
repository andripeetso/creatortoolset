/**
 * Group library posts by folder name. Distill files a post into a library
 * folder (reuse an existing title when the topic matches). This helper only
 * merges near-duplicate names ("Swimming for kids" / "Kids swimming").
 * Same topic with different names is the distill/reconcile job.
 */

export interface IdeaFields {
  title: string;
  takeaway: string;
}

const STOP = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "is", "it", "this",
  "that", "with", "you", "your", "why", "how", "what", "when", "who", "some", "from",
  "into", "about", "over", "not", "just", "like", "can", "if", "do", "did",
]);

function collapseDouble(s: string): string {
  const last = s[s.length - 1];
  if (s.length >= 3 && last === s[s.length - 2] && last !== "l" && last !== "s") {
    return s.slice(0, -1);
  }
  return s;
}

function stem(word: string): string {
  let s = word.replace(/['’]s$/u, "");
  if (s.length >= 6 && s.endsWith("ing")) s = collapseDouble(s.slice(0, -3));
  else if (s.length >= 5 && s.endsWith("ed") && !s.endsWith("eed")) s = collapseDouble(s.slice(0, -2));
  if (s.length >= 5 && s.endsWith("ies")) s = `${s.slice(0, -3)}y`;
  else if (s.length >= 5 && s.endsWith("sses")) s = s.slice(0, -2);
  else if (s.length >= 5 && /(s|x|z|ch|sh)es$/.test(s)) s = s.slice(0, -2);
  else if (s.length >= 5 && s.endsWith("es")) s = s.slice(0, -2);
  else if (s.length >= 4 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  return s;
}

/** Content words of an idea title or takeaway, stemmed. */
export function ideaTerms(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, " ").split(/\s+/)) {
    if (raw.length < 2 || STOP.has(raw)) continue;
    const t = stem(raw);
    if (t.length < 2 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const A = new Set(a);
  let inter = 0;
  for (const t of b) if (A.has(t)) inter++;
  const union = A.size + b.length - inter;
  return union ? inter / union : 0;
}

function subsetOverlap(a: string[], b: string[]): boolean {
  const [small, big] = a.length <= b.length ? [a, b] : [b, a];
  if (small.length < 2) return false;
  const B = new Set(big);
  return small.every((t) => B.has(t));
}

export function sameGrandIdea(a: IdeaFields, b: IdeaFields): boolean {
  const at = ideaTerms(a.title);
  const bt = ideaTerms(b.title);
  if (!at.length || !bt.length) return false;
  if (at.join(" ") === bt.join(" ")) return true;
  const jac = jaccard(at, bt);
  if (jac >= 0.6 || subsetOverlap(at, bt)) return true;
  if (jac >= 0.34 && jaccard(ideaTerms(a.takeaway), ideaTerms(b.takeaway)) >= 0.34) return true;
  return false;
}

export type IdeaCluster<T> = {
  title: string;
  takeaway: string;
  posts: T[];
};

/**
 * Greedy clusters: highest-ranked post founds a folder, later posts
 * join if the folder names are the same or near-duplicates. Cluster
 * title/takeaway come from the strongest member.
 */
export function clusterIdeaPosts<T extends { idea?: IdeaFields; rank?: number }>(
  posts: T[],
  viralityOf: (p: T) => number,
): IdeaCluster<T>[] {
  const seeded = posts.filter((p) => p.idea?.title && p.idea.takeaway);
  const order = [...seeded].sort((a, b) => {
    const ar = a.rank ?? -1;
    const br = b.rank ?? -1;
    if (ar !== br) return br - ar;
    return viralityOf(b) - viralityOf(a);
  });
  const clusters: Array<IdeaCluster<T> & { idea: IdeaFields }> = [];
  for (const p of order) {
    const idea = p.idea!;
    const hit = clusters.find((c) => sameGrandIdea(c.idea, idea));
    if (hit) hit.posts.push(p);
    else clusters.push({ title: idea.title, takeaway: idea.takeaway, posts: [p], idea });
  }
  for (const c of clusters) {
    c.posts.sort((a, b) => (b.rank ?? -1) - (a.rank ?? -1) || viralityOf(b) - viralityOf(a));
    const lead = c.posts[0]!.idea!;
    c.title = lead.title;
    c.takeaway = lead.takeaway;
  }
  clusters.sort((a, b) => b.posts.length - a.posts.length || viralityOf(b.posts[0]!) - viralityOf(a.posts[0]!));
  return clusters.map(({ title, takeaway, posts: members }) => ({ title, takeaway, posts: members }));
}

export function ideaMatchesQuery(idea: IdeaFields, q: string): boolean {
  const terms = ideaTerms(q);
  if (!terms.length) return false;
  const hay = new Set(ideaTerms(`${idea.title} ${idea.takeaway}`));
  return terms.some((t) => hay.has(t) || [...hay].some((h) => h.startsWith(t) || t.startsWith(h)));
}

/** Posts that still need a grand-idea pass and are not already in the queue. Never Know-how. */
export function needsIdeaDistill(post: {
  idea?: IdeaFields;
  status?: string;
  duplicateOf?: string;
  knowhow?: boolean;
  jobs?: Array<{ type: string; status: string }>;
}): boolean {
  if (post.idea?.title && post.idea.takeaway) return false;
  if (post.duplicateOf || post.knowhow) return false;
  if (post.status === "processing" || post.status === "error") return false;
  const st = post.jobs?.find((j) => j.type === "idea")?.status ?? "idle";
  return st === "idle";
}
