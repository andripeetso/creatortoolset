import { sentenceStartIndexes } from "./caption-constraints";
import { layoutCaptions, layoutGroups, type BoxCaps } from "./caption-layout";
import type { Cue, CaptionStyle, PosSegment, TextOverlay, Word } from "./types";

/**
 * Position segment containing time t. Segments are independent clips —
 * in a gap this returns null (and the caption is hidden, see below).
 * The end is 1ms-inclusive so a clip reaching the video end still
 * matches when currentTime lands exactly on the duration.
 */
export function posSegmentAt(
  segments: PosSegment[],
  t: number
): PosSegment | null {
  for (const s of segments) if (t >= s.start && t < s.end + 0.001) return s;
  return null;
}

/**
 * Are captions hidden at time t? Once the layer exists (any split), it
 * gates visibility too: captions show only inside sections, gaps hide
 * them. An empty track = always visible (no layer edits at all).
 */
export function captionHiddenAt(segments: PosSegment[], t: number): boolean {
  return segments.length > 0 && !posSegmentAt(segments, t);
}

/**
 * The caption layer's edges moved to the nearest caption cut (a cue's start
 * or end, or a video end), so no caption appears or vanishes halfway
 *. A section that shrinks to nothing held no caption's
 * middle, so the export never showed one there: it goes.
 */
export function snapPosSegments(
  segments: PosSegment[],
  cues: Cue[],
  duration: number
): PosSegment[] {
  const cuts = [0, duration, ...cues.flatMap((c) => [c.start, c.end])];
  const snap = (t: number) =>
    cuts.reduce((a, c) => (Math.abs(c - t) < Math.abs(a - t) ? c : a));
  return segments
    .map((s) => ({ ...s, start: snap(s.start), end: snap(s.end) }))
    .filter((s) => s.end > s.start);
}

/**
 * Fill gaps: each caption stays up until the next one starts, the last one
 * lingers up to 2 s (capped at the video end). The same array comes back
 * when nothing changes (undo history compares by reference).
 */
export function fillCueGaps(cues: Cue[], duration: number): Cue[] {
  let changed = false;
  const next = cues.map((c, i) => {
    const cap =
      i < cues.length - 1
        ? cues[i + 1].start - 0.001
        : Math.min(duration > 0 ? duration : c.end + 2, c.end + 2);
    if (cap <= c.end) return c;
    changed = true;
    return { ...c, end: cap };
  });
  return changed ? next : cues;
}

/** Fill gaps off: each caption ends with its last word again (as laid out). */
export function naturalCueEnds(cues: Cue[]): Cue[] {
  return cues.map((c, i) => {
    const last = c.words[c.words.length - 1];
    if (!last) return c;
    const end = last.end + 0.08;
    return { ...c, end: i < cues.length - 1 ? Math.min(end, cues[i + 1].start - 0.001) : end };
  });
}

let cueId = 0;

/** Allocate a unique cue id (shared with manual split/merge edits). */
export function nextCueId(): number {
  return cueId++;
}

/** Keep generated cue ids clear of ids loaded from a saved session. */
export function bumpCueIdCounter(min: number): void {
  if (min > cueId) cueId = min;
}

/** Average glyph width as a fraction of font size (bold display fonts). */
const CHAR_W = 0.55;
/** Line height as a fraction of font size. Matches the on-video preview (line-height 1.18). */
const LINE_H = 1.18;

/**
 * What fits inside the caption bounding box: characters per line and
 * number of lines. Derived from the box + font size relative to the
 * video frame, so preview, segmentation, and export all agree.
 */
export function boxCaps(
  style: CaptionStyle,
  frameW: number,
  frameH: number
): { maxChars: number; maxLines: number } {
  const fontPx = (style.fontSizePct / 100) * frameH;
  const maxChars = Math.max(
    4,
    Math.floor(((style.boxW / 100) * frameW) / (fontPx * CHAR_W))
  );
  const boxPx = (style.boxH / 100) * frameH;
  const maxLines = Math.max(
    1,
    Math.floor((boxPx - fontPx * 0.24) / (fontPx * LINE_H)),
  );
  return { maxChars, maxLines };
}

/**
 * The box capacity the AI cadence grouping was sized for, snapshotted
 * when the pass landed. Compared against the live style to tell whether
 * the grouping still fits the box.
 */
export interface CadenceFit {
  boxW: number;
  boxH: number;
  fontSizePct: number;
}

export function cadenceFitOf(st: CaptionStyle): CadenceFit {
  return { boxW: st.boxW, boxH: st.boxH, fontSizePct: st.fontSizePct };
}

/**
 * Lay words out for the caption box: one thought per line, lines stacked
 * up to the box's line count. `prev` keeps ids of captions that still
 * open on the same word, so a live resize doesn't restart animations.
 */
export function layoutCues(words: Word[], caps: BoxCaps, prev?: Cue[]): Cue[] {
  return layoutCaptions(words, caps, nextCueId, prev);
}

/** Attach ids and timings to word groups, clamping ends so cues never overlap. */
export function cuesFromGroups(groups: Word[][]): Cue[] {
  const cues = groups
    .filter((g) => g.length > 0)
    .map((g) => ({
      id: cueId++,
      start: g[0].start,
      end: g[g.length - 1].end + 0.08,
      words: g,
    }));
  for (let i = 0; i < cues.length - 1; i++) {
    cues[i].end = Math.min(cues[i].end, cues[i + 1].start - 0.001);
  }
  return cues;
}

/**
 * Section re-transcribe splice: replace every word whose midpoint falls
 * in [start, end) with the freshly transcribed (already time-offset)
 * rangeWords, keeping the rest of the transcript untouched. Cue breaks
 * survive by word identity — kept words open the same captions they used
 * to — while the new words are segmented fresh with the box rules.
 */
export function spliceRangeIntoCues(
  cues: Cue[],
  start: number,
  end: number,
  rangeWords: Word[],
  style: CaptionStyle,
  frameW: number,
  frameH: number
): { words: Word[]; cues: Cue[] } {
  const flat = cues.flatMap((c) => c.words);
  const mid = (w: Word) => (w.start + w.end) / 2;
  const before = flat.filter((w) => mid(w) < start);
  const after = flat.filter((w) => mid(w) >= end);
  const all = [...before, ...rangeWords, ...after];

  // kept words that opened a caption keep opening one
  const cueStartIds = new Set(
    cues.filter((c) => c.words.length).map((c) => c.words[0].id)
  );
  // the new region is segmented on its own, then its cue starts become breaks
  const midStartWords = new Set(
    segmentCues(rangeWords, style, frameW, frameH)
      .filter((c) => c.words.length)
      .map((c) => c.words[0])
  );
  const breaks: number[] = [];
  all.forEach((w, i) => {
    if (cueStartIds.has(w.id) || midStartWords.has(w)) breaks.push(i);
  });

  const { maxChars, maxLines } = style.fitBox
    ? boxCaps(style, frameW, frameH)
    : { maxChars: style.maxCharsPerLine, maxLines: 2 };
  const out = cuesFromBreaks(all, breaks, maxChars, maxLines);
  return { words: out.flatMap((c) => c.words), cues: out };
}

/**
 * Build cues from break points (word indices that start a new caption):
 * apply-master and range re-transcribe keep existing caption starts this
 * way. A sentence end always ends its caption. Each caption wraps to the
 * box and is split further only when it has more lines than fit.
 */
export function cuesFromBreaks(
  words: Word[],
  breaks: number[],
  maxChars: number,
  maxLines: number
): Cue[] {
  if (words.length === 0) return [];
  const starts = [...new Set([0, ...breaks, ...sentenceStartIndexes(words)])]
    .filter((b) => Number.isInteger(b) && b >= 0 && b < words.length)
    .sort((a, b) => a - b);
  const groups: Word[][] = [];
  for (let i = 0; i < starts.length; i++) {
    groups.push(words.slice(starts[i], starts[i + 1] ?? words.length));
  }
  return layoutGroups(groups, { maxChars, maxLines }, nextCueId, {
    thoughts: true,
  });
}

/**
 * Segment a flat word list into caption cues.
 * - fitBox: thought lines stacked into the bounding box (see caption-layout)
 * - wordsPerCaption > 0: fixed N words per cue
 * - wordsPerCaption = 0: smart phrases (break on sentence punctuation, max words/chars/duration)
 */
export function segmentCues(
  words: Word[],
  style: CaptionStyle,
  frameW = 1920,
  frameH = 1080
): Cue[] {
  if (words.length === 0) return [];
  const groups: Word[][] = [];

  if (style.fitBox) {
    return layoutCues(words, boxCaps(style, frameW, frameH));
  }
  if (style.wordsPerCaption > 0) {
    const n = style.wordsPerCaption;
    for (let i = 0; i < words.length; i += n) {
      groups.push(words.slice(i, i + n));
    }
  } else {
    const MAX_WORDS = 8;
    const MAX_CHARS = 84;
    const MAX_DUR = 4.5;
    let current: Word[] = [];
    const flush = () => {
      if (current.length) {
        groups.push(current);
        current = [];
      }
    };
    for (const w of words) {
      const text = w.text;
      const dur = current.length ? w.end - current[0].start : 0;
      const chars = current.reduce((a, x) => a + x.text.length + 1, 0);
      if (
        current.length > 0 &&
        (current.length >= MAX_WORDS || chars > MAX_CHARS || dur > MAX_DUR)
      ) {
        flush();
      }
      current.push(w);
      if (/[.!?…]["']?$/.test(text)) flush();
      else if (/[,;:—–-]["']?$/.test(text) && current.length >= 3) flush();
    }
    flush();
  }

  return cuesFromGroups(groups);
}

/**
 * Display lines for a text overlay: hard-wraps at explicit \n, then
 * greedy word-wraps each paragraph to the overlay box width. Used by
 * both the preview and the ASS export so they always agree.
 */
export function textOverlayLines(
  t: TextOverlay,
  frameW: number,
  frameH: number
): string[] {
  const fontPx = (t.sizePct / 100) * frameH;
  const maxChars = Math.max(
    2,
    Math.floor(((t.w / 100) * frameW) / (fontPx * CHAR_W))
  );
  const lines: string[] = [];
  for (const para of t.text.split("\n")) {
    if (para.trim() === "") {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(/\s+/)) {
      if (line && (line + " " + word).length > maxChars) {
        lines.push(line);
        line = word;
      } else {
        line = line ? line + " " + word : word;
      }
    }
    if (line) lines.push(line);
  }
  return lines.length ? lines : [""];
}

/** Apply the caption style's case transform (uppercase / lowercase / as-is). */
export function caseText(
  t: string,
  style: Pick<CaptionStyle, "uppercase" | "lowercase">
): string {
  return style.uppercase
    ? t.toUpperCase()
    : style.lowercase
      ? t.toLowerCase()
      : t;
}

/** Wrap cue words into display lines given a max chars per line. */
export function wrapLines(
  words: Word[],
  maxChars: number,
  style: Pick<CaptionStyle, "uppercase" | "lowercase">
): string[] {
  const texts = words.map((w) => caseText(w.text, style));
  const lines: string[] = [];
  let line = "";
  for (const t of texts) {
    if (line && (line + " " + t).length > maxChars) {
      lines.push(line);
      line = t;
    } else {
      line = line ? line + " " + t : t;
    }
  }
  if (line) lines.push(line);
  return lines;
}
