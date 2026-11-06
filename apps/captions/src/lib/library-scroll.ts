/** True if replacing the results with `nextHeight` would clamp window scroll. */
export function shrinkWouldClamp(
  scrollY: number,
  viewportHeight: number,
  documentHeight: number,
  resultsHeight: number,
  nextHeight = 0,
): boolean {
  const lost = Math.max(0, resultsHeight - nextHeight);
  const maxScrollAfter = Math.max(0, documentHeight - lost - viewportHeight);
  return scrollY > maxScrollAfter + 1;
}

/** Shrink a height lock as the user scrolls up, never below the real content. */
export function decayHeightLock(
  lock: number,
  resultsTop: number,
  naturalHeight: number,
  viewportHeight: number,
): number {
  if (!lock) return 0;
  const needed = Math.max(0, viewportHeight - resultsTop);
  const next = Math.min(lock, Math.max(needed, naturalHeight));
  return next <= naturalHeight ? 0 : next;
}
