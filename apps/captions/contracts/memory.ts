/**
 * What the assistant keeps from one chat to the next: things the person said about themselves or their work, in their
 * own words. Server: api/lib/memory.ts (the store and its guard), api/memory.ts (the routes). Page: Settings → Memory.
 */

/** One kept sentence. `project`: the Workshop project it was said for; none = about the person, in every project. */
export interface MemoryFact {
  id: string;
  /** The person's words as they wrote them in the chat. */
  text: string;
  at: number;
  project?: { id: string; name: string };
}

/** The most characters of kept lines one account holds, so the most that ever reach a prompt ("- " and the line end counted). */
export const MEMORY_CAP = 2000;
/** One kept sentence: at least a few words, at most a short paragraph. */
export const MEMORY_QUOTE_MIN = 8;
export const MEMORY_QUOTE_MAX = 300;

/** Spacing and the shape of quote marks evened out; the letters stay as written. */
export const tidy = (s: string): string => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
/** How two wordings are compared: tidy(), in one case. */
export const even = (s: string): string => tidy(s).toLowerCase();
