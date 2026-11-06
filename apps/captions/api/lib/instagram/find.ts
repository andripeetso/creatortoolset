import { cosine, makeEmbedding, tokenize } from "./embed";
import { normalizeText } from "./search";
import type { PostKind } from "./types";

/**
 * Topic search for the library: "plants and gardening" should surface every
 * post about plants or gardening, best first. Terms are stemmed so plants
 * matches plant and gardening matches garden; any term can match (OR), but
 * posts covering more of the query, in more prominent fields, rank higher.
 * The hashed embedding is a tie-breaker, and a fallback only when the
 * query is a longer description with no lexical hit.
 */

export const FIND_STOP = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "is", "it", "this",
  "that", "with", "you", "your", "i", "me", "my", "we", "they", "be", "was", "are",
  "at", "as", "from", "so", "but", "not", "just", "like", "can", "if", "do", "did",
  "about", "how", "what", "why", "when", "who", "all", "any", "get", "got", "up", "out",
  "one", "more", "some", "than", "then", "there", "their", "them", "these", "those",
  "into", "over", "also", "very", "our", "us", "its", "has", "have", "had", "will",
  "would", "should", "could", "does", "dont", "im", "ive", "he", "she", "his", "her",
]);

function collapseDouble(s: string): string {
  const last = s[s.length - 1];
  if (s.length >= 3 && last === s[s.length - 2] && last !== "l" && last !== "s") {
    return s.slice(0, -1);
  }
  return s;
}

/** Light English stemmer: possessives, -ing, -ed, plurals. Consistent, not perfect. */
export function stem(word: string): string {
  let s = word.replace(/['’]s$/u, "");
  if (s.length >= 6 && s.endsWith("ing")) s = collapseDouble(s.slice(0, -3));
  else if (s.length >= 5 && s.endsWith("ed") && !s.endsWith("eed")) s = collapseDouble(s.slice(0, -2));
  if (s.length >= 5 && s.endsWith("ies")) s = `${s.slice(0, -3)}y`;
  else if (s.length >= 5 && s.endsWith("sses")) s = s.slice(0, -2);
  else if (s.length >= 5 && /(s|x|z|ch|sh)es$/.test(s)) s = s.slice(0, -2);
  else if (s.length >= 4 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  return s;
}

/** Stemmed, de-duplicated content terms of a text, in order of appearance. */
export function termsOf(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tokenize(text)) {
    const tok = raw.replace(/^#+/, "");
    if (tok.length < 2 || FIND_STOP.has(tok)) continue;
    const t = stem(tok);
    if (t.length < 2 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** Exact stem, or a longer form of the same word (garden ↔ gardener). */
export function termInSet(set: Set<string>, t: string): boolean {
  if (set.has(t)) return true;
  if (t.length < 4) return false;
  for (const w of set) {
    if (w.length < 4) continue;
    if (w.startsWith(t) || t.startsWith(w)) return true;
  }
  return false;
}

export const queryTerms = termsOf;

/**
 * Where a word comes from decides how much it is worth: the distilled
 * idea first, then the creator's on-screen text, what they said, the
 * Instagram caption after that. Comments are the audience talking —
 * they are not searched.
 */
export const FIELD_WEIGHTS = { idea: 5, slides: 4, transcript: 3, caption: 2, comments: 0.5 } as const;
export type FindField = keyof typeof FIELD_WEIGHTS;
/** Best field first. Comments stay on the doc but are not a match field. */
export const FIELD_ORDER: FindField[] = ["idea", "slides", "transcript", "caption"];
export const FIELD_LABELS: Record<FindField, string> = {
  idea: "idea",
  slides: "on-screen",
  transcript: "transcript",
  caption: "caption",
  comments: "comments",
};
const FIELD_TIER: Record<FindField, number> = { idea: 0, slides: 1, transcript: 2, caption: 3, comments: 4 };

/** 0 = idea, 1 = on-screen, 2 = transcript, 3 = caption, 5 = similar wording only. */
export function matchTier(matches: FindMatch[]): number {
  if (!matches.length) return 5;
  return Math.min(...matches.map((m) => FIELD_TIER[m.field]));
}

export interface FindDoc {
  id: string;
  kind: PostKind;
  sets: Record<FindField, Set<string>>;
  /** Normalized slide text + transcript + caption, for the phrase bonus (comments excluded). */
  phrase: string;
  vector: number[];
  virality: number;
  takenAt: number;
}

export interface FindDocInput {
  id: string;
  kind: PostKind;
  /** Distilled idea title + takeaway. */
  idea: string[];
  /** Slide-1 hook, per-slide creator captions, on-screen text. */
  slides: string[];
  transcript: string;
  /** Post caption, handle, name, tags. */
  caption: string[];
  comments: string;
  vector: number[];
  virality: number;
  takenAt: number;
}

export function buildFindDoc(input: FindDocInput): FindDoc {
  const idea = input.idea.join("\n");
  const slides = input.slides.join("\n");
  const caption = input.caption.join("\n");
  return {
    id: input.id,
    kind: input.kind,
    sets: {
      idea: new Set(termsOf(idea)),
      slides: new Set(termsOf(slides)),
      transcript: new Set(termsOf(input.transcript)),
      caption: new Set(termsOf(caption)),
      comments: new Set(termsOf(input.comments)),
    },
    phrase: normalizeText([idea, slides, input.transcript, caption].join("\n")),
    vector: input.vector,
    virality: input.virality,
    takenAt: input.takenAt,
  };
}

export interface FindMatch {
  term: string;
  /** The most valuable field the term was found in. */
  field: FindField;
}

export interface FindHit {
  id: string;
  score: number;
  matches: FindMatch[];
  /** Every matched term came from comments only — the audience said it, not the creator. */
  commentsOnly: boolean;
  lexical: number;
  semantic: number;
}

const PHRASE_BONUS = 0.15;
const SEMANTIC_WEIGHT = 0.5;
const SEMANTIC_ONLY_MIN = 0.2;
const COVERAGE_WEIGHT = 0.25;

export function rankFind(
  q: string,
  docs: FindDoc[],
  opts: { kind?: PostKind; limit?: number } = {},
): FindHit[] {
  const terms = queryTerms(q);
  if (!terms.length) return [];
  const qvec = makeEmbedding(q).vector;
  const phrase = terms.length >= 2 ? normalizeText(q) : "";
  const maxWeight = FIELD_WEIGHTS.slides;
  const hits: Array<FindHit & { virality: number; takenAt: number }> = [];
  for (const doc of docs) {
    if (opts.kind && doc.kind !== opts.kind) continue;
    let lexical = 0;
    const matches: FindMatch[] = [];
    for (const t of terms) {
      const field = FIELD_ORDER.find((f) => termInSet(doc.sets[f], t));
      if (!field) continue;
      lexical += FIELD_WEIGHTS[field];
      matches.push({ term: t, field });
    }
    const semantic = Math.max(0, cosine(qvec, doc.vector));
    if (!matches.length && (terms.length < 3 || semantic < SEMANTIC_ONLY_MIN)) continue;
    const commentsOnly = matches.length > 0 && matches.every((m) => m.field === "comments");
    if (commentsOnly) continue;
    const lexNorm = lexical / (maxWeight * terms.length);
    const coverage = matches.length / terms.length;
    const phraseBonus = phrase && doc.phrase.includes(phrase) ? PHRASE_BONUS : 0;
    const score = lexNorm + COVERAGE_WEIGHT * coverage + phraseBonus + SEMANTIC_WEIGHT * semantic;
    hits.push({ id: doc.id, score, matches, commentsOnly, lexical, semantic, virality: doc.virality, takenAt: doc.takenAt });
  }
  // Coverage first: a post with both words in its caption beats one with a
  // single word in its idea.
  hits.sort(
    (a, b) =>
      b.matches.length - a.matches.length ||
      matchTier(a.matches) - matchTier(b.matches) ||
      b.score - a.score ||
      b.virality - a.virality ||
      b.takenAt - a.takenAt,
  );
  const limit = opts.limit && opts.limit > 0 ? opts.limit : hits.length;
  return hits
    .slice(0, limit)
    .map(({ id, score, matches, commentsOnly, lexical, semantic }) => ({ id, score, matches, commentsOnly, lexical, semantic }));
}
