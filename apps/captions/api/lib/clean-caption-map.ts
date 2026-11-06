import type { Cue, Word, PosSegment, TextOverlay } from "../../src/lib/types";
import {
  timelineDuration,
  type TimelineSpan,
} from "../../contracts/clean-timeline";

/** Split timed annotations at removed regions and repeat them when a scene repeats. */
export function remapCaptionData(
  data: Record<string, unknown>,
  spans: TimelineSpan[],
  speed: number,
) {
  function times<T extends { start: number; end: number }>(
    item: T,
    span: TimelineSpan,
  ): T | null {
    const start = Math.max(item.start, span.start),
      end = Math.min(item.end, span.end);
    return end > start
      ? {
          ...item,
          start: span.outputStart + (start - span.start) / speed,
          end: span.outputStart + (end - span.start) / speed,
        }
      : null;
  }
  const mapWords = (words: Word[]) =>
    spans
      .flatMap((span) =>
        words.flatMap((w) => {
          const mapped = times(w, span);
          return mapped ? [mapped] : [];
        }),
      )
      .map((w, id) => ({ ...w, id }));
  const words = mapWords((data.words as Word[] | undefined) ?? []);
  const wordIds = new Map<string, number>();
  let nextId = 0;
  spans.forEach((span, index) => {
    for (const word of (data.words as Word[] | undefined) ?? [])
      if (times(word, span)) wordIds.set(`${index}:${word.id}`, nextId++);
  });
  const cues: Cue[] = [];
  let wordId = words.length;
  for (const [index, span] of spans.entries())
    for (const cue of (data.cues as Cue[] | undefined) ?? []) {
      const mapped = times(cue, span);
      if (!mapped) continue;
      const kept = cue.words.flatMap((w) => {
        const item = times(w, span);
        return item
          ? [{ ...item, id: wordIds.get(`${index}:${w.id}`) ?? wordId++ }]
          : [];
      });
      if (kept.length)
        cues.push({
          ...mapped,
          id: cues.length,
          words: kept,
          lines: kept.length === cue.words.length ? cue.lines : undefined,
        });
    }
  function annotations<T extends { id: number; start: number; end: number }>(
    items: T[],
  ) {
    return spans
      .flatMap((span) =>
        items.flatMap((item) => {
          const mapped = times(item, span);
          return mapped ? [mapped] : [];
        }),
      )
      .map((item, id) => ({ ...item, id }));
  }
  const originalPositions =
    (data.posSegments as PosSegment[] | undefined) ?? [];
  let posSegments = annotations(originalPositions);
  // An empty visibility lane means always visible. Preserve an explicitly hidden result.
  if (originalPositions.length && !posSegments.length)
    posSegments = [
      { id: 0, start: 0, end: timelineDuration(spans), x: null, y: null },
    ];
  return {
    ...data,
    duration: timelineDuration(spans),
    words,
    cues,
    originalWords: Array.isArray(data.originalWords)
      ? mapWords(data.originalWords)
      : null,
    posSegments,
    texts: annotations((data.texts as TextOverlay[] | undefined) ?? []),
    peaks: null,
    done: false,
    cadenceDirty: true,
  };
}
