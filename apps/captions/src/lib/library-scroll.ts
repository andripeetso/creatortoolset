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

/**
 * Items split into `cols` columns that read down one column, then the next, each about as tall as the others
 * (`height` is each item's height in any unit). What CSS columns do, as separate stacks: WebKit lays a long CSS
 * columns box out again on nearly every scroll step, which made a feed of pictures stutter.
 */
export function flowColumns<T>(items: T[], cols: number, height: (item: T) => number): T[][] {
  const out: T[][] = [[]];
  let left = items.reduce((s, i) => s + height(i), 0);
  let used = 0;
  for (const item of items) {
    const h = height(item);
    const target = left / (cols - out.length + 1);
    // start the next column when this item would overshoot more than stopping short undershoots
    if (out.length < cols && out.at(-1)!.length && used + h - target > target - used) {
      left -= used;
      used = 0;
      out.push([]);
    }
    out.at(-1)!.push(item);
    used += h;
  }
  // always `cols` stacks, so a short list keeps its columns' width
  while (out.length < cols) out.push([]);
  return out;
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
