import { keptPer1k, type OwnPost } from "./folder";

/** How many of the author's reel captions a caption turn reads. */
export const CAPTION_EXAMPLES = 8;
/** Shorter than this is a hook or a one-liner, not the caption the author writes under a reel. */
const MIN_CHARS = 120;

export interface CaptionExamples {
  /** Their newest posted reel captions, each with its numbers (keptPer1k is 0 when there are none). */
  examples: Array<{ text: string; keptPer1k: number }>;
  /** Captions already saved on this session's other pieces: the same kind of text as the one being written. */
  saved?: string[];
  median: number;
  p90: number;
}

/**
 * The captions a caption turn reads as the author's voice. Newest reel captions, not the most-saved list: that list is
 * carousels and one-liners, and its top captions were not the ones the author writes under a reel.
 * Undefined when the author has fewer than ten captions.
 */
export function captionExamplesFor(posts: OwnPost[], saved: string[] = []): CaptionExamples | undefined {
  const all = posts.map((p) => ({ kind: p.item.kind, at: p.item.takenAt, text: (p.item.caption ?? "").trim(), kept: keptPer1k(p.item) ?? 0 }));
  const lengths = all.map((p) => p.text.length).filter((n) => n > 0).sort((a, b) => a - b);
  if (lengths.length < 10) return undefined;
  const at = (q: number) => lengths[Math.min(lengths.length - 1, Math.floor(q * lengths.length))]!;
  const examples = all
    .filter((p) => p.kind === "reel" && p.text.length >= MIN_CHARS)
    .sort((a, b) => b.at - a.at)
    .slice(0, CAPTION_EXAMPLES)
    .map((p) => ({ text: p.text, keptPer1k: p.kept }));
  const others = saved.map((s) => s.trim()).filter(Boolean);
  return { examples, saved: others.length ? others : undefined, median: at(0.5), p90: at(0.9) };
}
