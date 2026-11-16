/**
 * What the assistant keeps from one chat to the next: things the person said about themselves or their work, in their
 * own words. Server: api/lib/memory.ts (the store and its guard), api/memory.ts (the routes). Page: Settings → Memory.
 */

/** One kept sentence. `project`: the Workshop project it was said for; none = about the person, in every project. */
export interface MemoryFact {
  id: string;
  /** The rule the assistant wrote from what the person said: what its prompt gets. */
  text: string;
  /** The person's own words in the chat; none on a fact kept before rules were written (then `text` is theirs). */
  said?: string;
  at: number;
  project?: { id: string; name: string };
}

/** The most characters of kept lines one account holds, so the most that ever reach a prompt ("- " and the line end counted). */
export const MEMORY_CAP = 2000;
/** One kept sentence: at least a few words, at most a short paragraph. */
export const MEMORY_QUOTE_MIN = 8;
export const MEMORY_QUOTE_MAX = 300;
/** One rule: a plain sentence. */
export const MEMORY_RULE_MAX = 200;

/** Spacing and the shape of quote marks evened out; the letters stay as written. */
export const tidy = (s: string): string => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
/** How two wordings are compared: tidy(), in one case. */
export const even = (s: string): string => tidy(s).toLowerCase();

/**
 * The quote as it stands in a text: the same words in the same order, whole words only, whatever the case, the
 * spacing or the shape of the quote marks. Returns the text's own wording (one line), or null.
 */
export function foundIn(quote: string, text: string): string | null {
  const words = tidy(quote).split(" ").filter(Boolean);
  if (!words.length) return null;
  const word = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "['‘’]").replace(/"/g, '["“”]');
  const m = new RegExp(`(?<![\\p{L}\\p{N}])${words.map(word).join("\\s+")}(?![\\p{L}\\p{N}])`, "iu").exec(text);
  return m ? m[0].replace(/\s+/g, " ") : null;
}
