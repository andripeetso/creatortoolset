/** How long text a viewer reads stays on screen: every tool that shows words uses these. */
export const READING = {
  /** seconds a word, once the whole line is on screen */
  perWordS: 0.3,
  /** the shortest hold of any text */
  minS: 0.8,
  /** a text's entrance (pop, fade, slide) */
  entranceS: 0.3,
} as const;

export const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** Seconds `text` needs once it is fully shown (the entrance not counted). */
export const readS = (text: string) => Math.max(READING.minS, wordCount(text) * READING.perWordS);

/** Words that can be read in a hold of `seconds`, the entrance included; 0 when not even one fits. */
export function wordBudget(seconds: number): number {
  const s = seconds - READING.entranceS;
  return s < READING.minS ? 0 : Math.floor(s / READING.perWordS + 1e-9);
}
