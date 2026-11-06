/**
 * Shared "the paid API is empty" detection so Deepgram, ElevenLabs, and
 * the cadence models all surface the same user-facing ask: tell the admin.
 */

export const OUT_OF_CREDITS_CODE = "OUT_OF_CREDITS";

export const outOfCreditsMessage = (what: string) =>
  `${what} is out of credits, so it can't run. Tell the admin so they can top it up.`;

/** Quota / billing exhaustion — not a per-minute rate limit. */
export function isOutOfCredits(status: number, body: string): boolean {
  if (status === 402) return true;
  const text = body.toLowerCase();
  return (
    /insufficient[_\s-]?quota/.test(text) ||
    /exceeded your current quota/.test(text) ||
    /credit balance is too low/.test(text) ||
    /purchase credits/.test(text) ||
    /billing_not_active/.test(text) ||
    /quota[_\s-]?exceeded/.test(text) ||
    /quota_exceeded/.test(text) ||
    /out of credits/.test(text) ||
    /insufficient credits/.test(text) ||
    /insufficient[_\s-]?funds/.test(text) ||
    /insufficient[_\s-]?credits/.test(text) ||
    /balance is not enough/.test(text) ||
    /payment required/.test(text) ||
    /payment_required/.test(text) ||
    /usage limit/.test(text)
  );
}
