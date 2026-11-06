import { isSentenceEnd, lineBreakCost } from "./caption-constraints";
import type { Cue, Word } from "./types";

/**
 * Caption layout for the bounding-box mode.
 *
 * Words may carry a `cut` mark from the Match cadence pass (the boundary
 * before the word: 2 = a new thought, 1 = a fine place to split a line
 * that is too wide, 0/absent = keep together). Marks do not depend on
 * the box, so resizing the box only re-runs this file.
 *
 * - A thought (words between two thought marks or sentence ends) is one
 *   line when it fits. A line never carries the next thought's words.
 * - A thought wider than the box splits into the fewest, most even
 *   lines, preferring cut-1 points, then Netflix line treatment.
 * - A caption stacks whole lines, up to the box's line count. A 1-line
 *   box only ever gets 1-line captions.
 *
 * Every renderer draws `cue.lines`, so the preview and every export show
 * exactly these lines.
 */

export interface BoxCaps {
  maxChars: number;
  maxLines: number;
}

/** Longest stretch of speech one stacked caption may cover, seconds. */
const MAX_STACK_SECONDS = 5;
/** A pause at least this long always starts a new caption. */
const STACK_GAP_SECONDS = 1.2;
/** Cost of using one more line than the fewest possible for a thought. */
const EXTRA_LINE_COST = 2;
/** Cost of a split that leaves one word alone on its line. */
const LONE_WORD_COST = 3;

/** Line lengths are measured in characters, spaces included. */
function prefixLengths(words: { text: string }[]): number[] {
  const p = [0];
  for (const w of words) p.push(p[p.length - 1] + w.text.length);
  return p;
}

/**
 * Split one run of words (a thought) into lines that fit maxChars.
 * Returns the word count of each line. A single word wider than the box
 * gets a line of its own rather than being dropped.
 */
function splitIntoLines(
  words: Word[],
  maxChars: number,
  marked: boolean,
): number[] {
  const n = words.length;
  if (n === 0) return [];
  const pre = prefixLengths(words);
  const width = (a: number, b: number) => pre[b] - pre[a] + (b - a - 1);
  const fits = (a: number, b: number) => b - a === 1 || width(a, b) <= maxChars;
  if (fits(0, n)) return [n];

  // greedy filling gives the fewest possible lines
  let k = 0;
  for (let a = 0; a < n; ) {
    let b = a + 1;
    while (b < n && fits(a, b + 1)) b++;
    k++;
    a = b;
  }
  const splitCost = (i: number) => {
    const rule = lineBreakCost(words, i);
    if (!marked) return rule;
    return (words[i].cut === 1 ? 0 : 4) + rule * 0.5;
  };

  // exactly `lines` lines: minimise split cost plus unevenness
  const solve = (lines: number) => {
    const target = (width(0, n) - (lines - 1)) / lines;
    const balance = (a: number, b: number) => {
      const d = (width(a, b) - target) / Math.max(1, maxChars);
      return d * d * 3;
    };
    const dp: Float64Array[] = [];
    const from: Int32Array[] = [];
    for (let l = 0; l <= lines; l++) {
      dp.push(new Float64Array(n + 1).fill(Infinity));
      from.push(new Int32Array(n + 1).fill(-1));
    }
    dp[0][0] = 0;
    for (let l = 1; l <= lines; l++) {
      for (let j = l; j <= n; j++) {
        for (let i = j - 1; i >= l - 1; i--) {
          if (!fits(i, j)) break;
          const prev = dp[l - 1][i];
          if (prev === Infinity) continue;
          const c =
            prev +
            balance(i, j) +
            (i > 0 ? splitCost(i) : 0) +
            (j - i === 1 ? LONE_WORD_COST : 0);
          if (c < dp[l][j]) {
            dp[l][j] = c;
            from[l][j] = i;
          }
        }
      }
    }
    const counts: number[] = [];
    let j = n;
    for (let l = lines; l > 0; l--) {
      const i = from[l][j];
      counts.unshift(j - i);
      j = i;
    }
    return { cost: dp[lines][n], counts };
  };

  // one extra line is worth it when it avoids a bad break (a line ending
  // on "the", "a", "as"…); never more than one
  const best = solve(k);
  if (n > k + 1) {
    const more = solve(k + 1);
    if (more.cost + EXTRA_LINE_COST < best.cost) return more.counts;
  }
  return best.counts;
}

interface Line {
  /** Index of the line's first word in the full word list. */
  a: number;
  /** One past the line's last word. */
  b: number;
  thought: number;
}

/**
 * Break words into display lines. With `thoughts`, every thought mark
 * starts a line; without, only sentence ends do (manual captions keep the
 * user's grouping and just wrap to the width).
 */
function buildLines(
  words: Word[],
  maxChars: number,
  thoughts: boolean,
): Line[] {
  const marked = words.some((w) => w.cut !== undefined);
  const lines: Line[] = [];
  let start = 0;
  let thought = 0;
  const flush = (end: number) => {
    if (end <= start) return;
    let a = start;
    for (const count of splitIntoLines(words.slice(start, end), maxChars, marked)) {
      lines.push({ a, b: a + count, thought });
      a += count;
    }
    thought++;
    start = end;
  };
  for (let i = 1; i < words.length; i++) {
    if ((thoughts && words[i].cut === 2) || isSentenceEnd(words[i - 1].text)) {
      flush(i);
    }
  }
  flush(words.length);
  return lines;
}

/** Word count per display line for a caption's own words (width only). */
export function lineCountsFor(words: Word[], maxChars: number): number[] {
  return buildLines(words, Math.max(1, Math.floor(maxChars)), false).map(
    (l) => l.b - l.a,
  );
}

function lineWidth(words: { text: string }[]): number {
  return words.reduce((n, w, i) => n + w.text.length + (i ? 1 : 0), 0);
}

/**
 * The lines to draw for one caption: its stored layout when that still
 * matches its words and the box width, otherwise a fresh width wrap.
 */
export function cueLineCounts(
  cue: { words: Word[]; lines?: number[] },
  maxChars: number,
): number[] {
  const stored = cue.lines;
  if (
    stored?.length &&
    stored.every((c) => Number.isInteger(c) && c > 0) &&
    stored.reduce((a, c) => a + c, 0) === cue.words.length
  ) {
    let at = 0;
    const ok = stored.every((c) => {
      const line = cue.words.slice(at, at + c);
      at += c;
      return c === 1 || lineWidth(line) <= maxChars;
    });
    if (ok) return stored;
  }
  return lineCountsFor(cue.words, maxChars);
}

/** Slice any per-word array (words, styled tokens) into the counted lines. */
export function sliceLines<T>(items: T[], counts: number[]): T[][] {
  const out: T[][] = [];
  let at = 0;
  for (const c of counts) {
    out.push(items.slice(at, at + c));
    at += c;
  }
  return out;
}

/** Thought lines as [start, end) word ranges: split at thought marks and sentence ends. */
export function thoughtRanges(words: Word[]): [number, number][] {
  const out: [number, number][] = [];
  let a = 0;
  for (let i = 1; i <= words.length; i++) {
    if (i < words.length && words[i].cut !== 2 && !isSentenceEnd(words[i - 1].text)) continue;
    if (i > a) out.push([a, i]);
    a = i;
  }
  return out;
}

/** Thought lines wider than the box, the ones that need split points. */
export function tooWideThoughts(words: Word[], maxChars: number): [number, number][] {
  return thoughtRanges(words).filter(
    ([a, b]) => b - a > 1 && lineWidth(words.slice(a, b)) > maxChars,
  );
}

/**
 * Use freshly planned split points for these thought lines: 1 where a
 * line may split, 0 elsewhere inside it. Thought starts stay as they are.
 */
export function withSplits(
  words: Word[],
  ranges: [number, number][],
  splits: number[][],
): Word[] {
  const cut = new Map<number, 0 | 1>();
  ranges.forEach(([a, b], k) => {
    for (let i = a + 1; i < b; i++) cut.set(i, 0);
    for (const s of splits[k] ?? []) if (a + s < b) cut.set(a + s, 1);
  });
  return words.map((w, i) => (cut.has(i) ? { ...w, cut: cut.get(i)! } : w));
}

/**
 * How many lines start where the match didn't mark a break — the box got
 * narrower than the marks were planned for, so the layout had to guess.
 * Zero before a match (no marks to go by).
 */
export function unplannedBreaks(cues: Cue[]): number {
  if (!cues.some((c) => c.words.some((w) => w.cut !== undefined))) return 0;
  let count = 0;
  let before: Word | undefined;
  for (const c of cues) {
    const stored = c.lines;
    const counts =
      stored && stored.reduce((a, n) => a + n, 0) === c.words.length
        ? stored
        : [c.words.length];
    let at = 0;
    for (const n of counts) {
      const w = c.words[at];
      const prev = at > 0 ? c.words[at - 1] : before;
      if (w && prev && w.cut !== 1 && w.cut !== 2 && !isSentenceEnd(prev.text)) count++;
      at += n;
    }
    if (c.words.length) before = c.words[c.words.length - 1];
  }
  return count;
}

/** True when every caption fits the box: line count and line width. */
export function cuesFitBox(cues: Cue[], caps: BoxCaps): boolean {
  return cues.every((c) => {
    const counts = cueLineCounts(c, caps.maxChars);
    return counts.length <= caps.maxLines;
  });
}

/** Timing and ids for laid-out groups. Ends never overlap the next start. */
function toCues(
  groups: { words: Word[]; lines: number[] }[],
  nextId: () => number,
  prev?: Cue[],
): Cue[] {
  // a caption that still opens on the same word keeps its id, so a live
  // resize doesn't replay its entrance animation every frame
  const prevIds = new Map<number, number>();
  for (const c of prev ?? []) if (c.words.length) prevIds.set(c.words[0].id, c.id);
  const used = new Set<number>();
  const cues: Cue[] = groups.map((g) => {
    let id = prevIds.get(g.words[0].id);
    if (id === undefined || used.has(id)) id = nextId();
    used.add(id);
    return {
      id,
      start: g.words[0].start,
      end: g.words[g.words.length - 1].end + 0.08,
      words: g.words,
      lines: g.lines,
    };
  });
  for (let i = 0; i < cues.length - 1; i++) {
    cues[i].end = Math.min(cues[i].end, cues[i + 1].start - 0.001);
  }
  return cues;
}

/**
 * Lay words out for a box: thought lines, stacked into captions of at
 * most maxLines lines. Stacking prefers full boxes, never splits one
 * thought across captions unless it has more lines than the box, and
 * prefers starting a caption at a sentence start.
 */
export function layoutCaptions(
  words: Word[],
  caps: BoxCaps,
  nextId: () => number,
  prev?: Cue[],
): Cue[] {
  if (!words.length) return [];
  const maxChars = Math.max(1, Math.floor(caps.maxChars));
  const maxLines = Math.max(1, Math.floor(caps.maxLines));
  const lines = buildLines(words, maxChars, true);
  const m = lines.length;
  const startOf = (l: Line) => words[l.a].start;
  const endOf = (l: Line) => words[l.b - 1].end;

  const cost = new Float64Array(m + 1).fill(Infinity);
  const from = new Int32Array(m + 1).fill(-1);
  cost[0] = 0;
  for (let j = 1; j <= m; j++) {
    for (let i = j - 1; i >= 0 && j - i <= maxLines; i--) {
      if (j - i > 1) {
        if (endOf(lines[j - 1]) - startOf(lines[i]) > MAX_STACK_SECONDS) break;
        const gap = startOf(lines[i + 1]) - endOf(lines[i]);
        if (gap >= STACK_GAP_SECONDS) break;
      }
      if (cost[i] === Infinity) continue;
      let c = cost[i] + 1;
      if (i > 0) {
        if (lines[i].thought === lines[i - 1].thought) c += 10;
        else if (isSentenceEnd(words[lines[i].a - 1].text)) c -= 0.3;
      }
      if (c < cost[j]) {
        cost[j] = c;
        from[j] = i;
      }
    }
  }

  const groups: { words: Word[]; lines: number[] }[] = [];
  for (let j = m; j > 0; ) {
    const i = from[j];
    const span = lines.slice(i, j);
    groups.unshift({
      words: words.slice(span[0].a, span[span.length - 1].b),
      lines: span.map((l) => l.b - l.a),
    });
    j = i;
  }
  return toCues(groups, nextId, prev);
}

/**
 * Caption groups chosen elsewhere (manual lines, apply-master, a range
 * re-transcribe) laid out for the box: each group wraps to the width and
 * is split into more captions only when it has more lines than fit.
 */
export function layoutGroups(
  groups: Word[][],
  caps: BoxCaps,
  nextId: () => number,
  opts: { thoughts?: boolean; prev?: Cue[] } = {},
): Cue[] {
  const maxChars = Math.max(1, Math.floor(caps.maxChars));
  const maxLines = Math.max(1, Math.floor(caps.maxLines));
  const out: { words: Word[]; lines: number[] }[] = [];
  for (const g of groups) {
    if (!g.length) continue;
    const counts = buildLines(g, maxChars, !!opts.thoughts).map((l) => l.b - l.a);
    let at = 0;
    for (let i = 0; i < counts.length; i += maxLines) {
      const chunk = counts.slice(i, i + maxLines);
      const n = chunk.reduce((a, c) => a + c, 0);
      out.push({ words: g.slice(at, at + n), lines: chunk });
      at += n;
    }
  }
  return toCues(out, nextId, opts.prev);
}

/** Words without their cadence marks (reset to the plain layout). */
export function clearMarks(words: Word[]): Word[] {
  return words.map((w) => {
    if (w.cut === undefined) return w;
    const copy = { ...w };
    delete copy.cut;
    return copy;
  });
}

/**
 * Captions matched before thought marks existed: their caption starts
 * become thought marks, so a resize keeps the grouping instead of
 * falling back to width-filling.
 */
export function marksFromCues(cues: Cue[]): Word[] | null {
  const flat = cues.flatMap((c) => c.words);
  if (!flat.length || flat.some((w) => w.cut !== undefined)) return null;
  const starts = new Set<Word>();
  for (const c of cues) if (c.words.length) starts.add(c.words[0]);
  return flat.map((w, i) => ({ ...w, cut: i > 0 && starts.has(w) ? 2 : 0 }));
}
