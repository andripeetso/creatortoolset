// Linked computers per account. The free tier is a number from RELAY_FREE_LIMIT. Paid tiers come from a private
// plug-in that passes its own function in its place (WP10); the public broker only knows the free number.
export type LimitFor = (accountId: string) => number;

export function freeLimit(n: number): LimitFor {
  return () => n;
}
