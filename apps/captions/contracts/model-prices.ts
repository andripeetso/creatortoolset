/**
 * API-equivalent prices in $ per million tokens, for the models this app sends on the API path. Read 2026-11-04 from
 * the claude-api skill's bundled model table (cached 2026-10-06), not from the live pricing page. Cache writes are the
 * 5-minute price (1.25x input). An unlisted model reports tokens and $0.
 */
export const PRICE_PER_MTOK: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

/** What reading `cacheRead` tokens from the cache saved against sending them as input; 0 for an unlisted model. */
export function cacheSavingsUsd(model: string | undefined, cacheRead: number): number {
  const p = model ? PRICE_PER_MTOK[model] : undefined;
  return p ? (cacheRead * (p.input - p.cacheRead)) / 1e6 : 0;
}
