/**
 * Tiny full-text matcher for the Instagram library: one lowercase
 * haystack per post (creator, caption, slide text, transcripts, comment
 * text) and an every-token-must-appear query.
 */

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildSearchText(parts: Array<string | undefined | null>): string {
  return normalizeText(
    parts
      .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
      .join("\n"),
  );
}

export function queryTokens(q: string): string[] {
  return normalizeText(q)
    .split(" ")
    .filter((t) => t.length > 0);
}

export function matchesQuery(q: string, haystack: string): boolean {
  const tokens = queryTokens(q);
  if (!tokens.length) return true;
  const hay = normalizeText(haystack);
  return tokens.every((t) => hay.includes(t));
}
