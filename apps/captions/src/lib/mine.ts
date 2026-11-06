/**
 * "Not my words": the
 * stretches of a slide that the author never said. A word counts as theirs
 * when it sits in a run of three words that appears in what they wrote or
 * dictated in this session; everything else is the AI's and gets marked.
 */

const TOKEN = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
const norm = (w: string) => w.toLowerCase().replace(/’/g, "'");

/** The author's words, as a set of three-word runs (and two-word runs for very short lines). */
export function mineIndex(texts: string[]): Set<string> {
  const grams = new Set<string>();
  for (const t of texts) {
    const w = (t.match(TOKEN) ?? []).map(norm);
    for (let k = 0; k + 3 <= w.length; k++) grams.add(w.slice(k, k + 3).join(" "));
    if (w.length === 2) grams.add(w.join(" "));
  }
  return grams;
}

/** [start, end) character ranges of `text` the author didn't say. */
export function foreignSpans(text: string, mine: Set<string>): Array<[number, number]> {
  const toks = [...text.matchAll(TOKEN)].map((m) => ({ w: norm(m[0]), start: m.index!, end: m.index! + m[0].length }));
  if (!toks.length) return [];
  const covered = toks.map(() => false);
  if (toks.length < 3) {
    if (toks.length === 2 && mine.has(`${toks[0]!.w} ${toks[1]!.w}`)) covered.fill(true);
  } else {
    for (let k = 0; k + 3 <= toks.length; k++) {
      if (mine.has(`${toks[k]!.w} ${toks[k + 1]!.w} ${toks[k + 2]!.w}`)) covered[k] = covered[k + 1] = covered[k + 2] = true;
    }
  }
  const spans: Array<[number, number]> = [];
  toks.forEach((t, i) => {
    if (covered[i]) return;
    const last = spans[spans.length - 1];
    if (last && !covered[i - 1] && i > 0) last[1] = t.end;
    else spans.push([t.start, t.end]);
  });
  return spans;
}

