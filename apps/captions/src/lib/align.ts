import type { Word } from "./types";

export function tokenize(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

// Case/punctuation-insensitive comparison so fixing "hello," → "Hello"
// still counts as the same word and keeps its original timing.
export function norm(s: string): string {
  const n = s.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");
  return n || s;
}

/**
 * Align edited tokens against existing timed words.
 * Matched words (longest common subsequence) keep their id and timing;
 * inserted/reworded tokens get timings interpolated between their
 * matched neighbours (or spread across the span when nothing matches).
 */
export function alignTokensToWords(
  tokens: string[],
  words: Word[],
  span: { start: number; end: number },
  nextId: () => number
): Word[] {
  const n = tokens.length;
  const m = words.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        norm(tokens[i]) === norm(words[j].text)
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: (Word | undefined)[] = new Array(n);
  // old index of each matched token, so a reworded run can inherit the
  // cadence mark of the words it replaced
  const oldAt = new Int32Array(n).fill(-1);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (norm(tokens[i]) === norm(words[j].text)) {
      // keep every field (timing provenance, cadence mark), new text
      out[i] = { ...words[j], text: tokens[i] };
      oldAt[i] = j;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  let k = 0;
  while (k < n) {
    if (out[k]) {
      k++;
      continue;
    }
    let e = k;
    while (e < n && !out[e]) e++;
    const left = k > 0 ? out[k - 1]!.end : span.start;
    const right = e < n ? out[e]!.start : span.end;
    const lo = Math.min(left, right);
    // guarantee each inserted word some width even in a zero-length gap
    const hi = Math.max(right, lo + 0.12 * (e - k));
    const step = (hi - lo) / (e - k);
    const firstOld = k > 0 ? oldAt[k - 1] + 1 : 0;
    const lastOld = e < n ? oldAt[e] : m;
    const inheritedCut = firstOld < lastOld ? words[firstOld].cut : undefined;
    for (let q = k; q < e; q++) {
      out[q] = {
        id: nextId(),
        text: tokens[q],
        start: lo + (q - k) * step,
        end: lo + (q - k + 1) * step,
        ...(q === k && inheritedCut !== undefined ? { cut: inheritedCut } : {}),
      };
    }
    k = e;
  }
  return out as Word[];
}

/**
 * Align a whole edited transcript (token lines; one line = one caption)
 * against the current timed word list. Trims the unchanged common
 * prefix/suffix first so the expensive LCS only runs on the edited
 * region — keeps commits fast even on hour-long transcripts.
 * Returns one Word[] per line.
 */
export function alignDocumentTokens(
  lineTokens: string[][],
  oldWords: Word[],
  span: { start: number; end: number },
  nextId: () => number
): Word[][] {
  const flat = lineTokens.flat();
  const n = flat.length;
  const m = oldWords.length;

  let p = 0;
  while (p < n && p < m && norm(flat[p]) === norm(oldWords[p].text)) p++;
  let s = 0;
  while (s < n - p && s < m - p && norm(flat[n - 1 - s]) === norm(oldWords[m - 1 - s].text)) s++;

  const midTokens = flat.slice(p, n - s);
  const midOld = oldWords.slice(p, m - s);
  const midSpan = {
    start: p > 0 ? oldWords[p - 1].end : span.start,
    end: s > 0 ? oldWords[m - s].start : span.end,
  };

  let midAligned: Word[];
  const CAP = 4_000_000; // dp cells — beyond this, fall back to even spread
  if (midTokens.length === 0) {
    midAligned = [];
  } else if ((midTokens.length + 1) * (midOld.length + 1) <= CAP) {
    midAligned = alignTokensToWords(midTokens, midOld, midSpan, nextId);
  } else {
    const step = Math.max(0.05, (midSpan.end - midSpan.start) / midTokens.length);
    midAligned = midTokens.map((t, i) => ({
      id: nextId(),
      text: t,
      start: midSpan.start + i * step,
      end: midSpan.start + (i + 1) * step,
    }));
  }

  const flatOut: Word[] = [
    ...flat.slice(0, p).map((t, i) => ({ ...oldWords[i], text: t })),
    ...midAligned,
    ...flat.slice(n - s).map((t, i) => ({ ...oldWords[m - s + i], text: t })),
  ];

  const out: Word[][] = [];
  let k = 0;
  for (const line of lineTokens) {
    out.push(flatOut.slice(k, k + line.length));
    k += line.length;
  }
  return out;
}
