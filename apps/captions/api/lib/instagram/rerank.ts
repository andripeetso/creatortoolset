import { ask, noul, yes } from "../jev";

/**
 * Word search finds posts that contain the words; for a search that
 * describes something ("parents pushing back on the screen-time claim"), Jev
 * re-orders the top of the list by whether each post is actually about
 * it. Short keyword searches stay as they were.
 */

/** Only searches of at least this many terms are re-ranked. */
export const RERANK_MIN_TERMS = 3;
/** How many of the top hits Jev reads. */
export const RERANK_TOP = 30;

export interface RerankItem {
  id: string;
  /** What the post is: idea, hook, caption, a little transcript. */
  text: string;
}

/**
 * Probability each post matches the search, by id. Throws when Jev fails;
 * callers keep the word ranking then.
 */
export async function relevance(
  key: string,
  query: string,
  items: RerankItem[],
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const questions: Record<string, ReturnType<typeof noul>> = {};
  items.forEach((item, i) => {
    questions[`p${i}`] = noul(
      `Post ${i + 1}:\n"""${item.text.slice(0, 1200)}"""\nIs this post about what the search is looking for? The topic of the search is the requirement; exact wording is not.`,
    );
  });
  const answers = await ask(key, { search: query }, questions, signal);
  return new Map(items.map((item, i) => [item.id, yes(answers[`p${i}`])]));
}

/**
 * Put the re-ranked top first, most relevant first; ties and the rest
 * keep their word-search order.
 */
export function applyRelevance<T extends { id: string }>(
  hits: T[],
  scores: Map<string, number>,
): (T & { relevance?: number })[] {
  const top = hits
    .filter((h) => scores.has(h.id))
    .map((h, i) => ({ h, i, p: scores.get(h.id)! }))
    .sort((a, b) => b.p - a.p || a.i - b.i)
    .map(({ h, p }) => ({ ...h, relevance: Math.round(p * 100) / 100 }));
  const rest = hits.filter((h) => !scores.has(h.id));
  return [...top, ...rest];
}
