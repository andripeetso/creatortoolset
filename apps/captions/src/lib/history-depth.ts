/** What the top bar's Back and Forward may step to (react-router keeps each entry's index in history.state.idx): up to
 *  the deepest entry reached (a push drops the ones ahead), skipping entries that were a modal (Settings, Community,
 *  Projects), so the arrows only ever move between pages. */
export const historyDepth = { deepest: 0, modal: new Set<number>() };

/** How many entries to step from `idx` (-1 back, 1 forward) to the nearest page; 0 when there is none. */
export function pageStep(idx: number, dir: -1 | 1): number {
  for (let i = idx + dir; i >= 0 && i <= historyDepth.deepest; i += dir) if (!historyDepth.modal.has(i)) return i - idx;
  return 0;
}
