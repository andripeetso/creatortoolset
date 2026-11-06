/**
 * Language rules the caption layout relies on. Sentence ends are hard:
 * a line never carries the end of one sentence into the next. Line
 * treatment (Netflix I.10) only ranks where a line that is too wide may
 * be split; it never decides where a thought ends — that is the Match
 * cadence pass's job.
 */

const ABBREV = /^(mr|mrs|ms|dr|st|vs|etc|jr|sr|prof)\.$/i;
const SENTENCE_END = /[.!?…]["'”’)]*$/u;
const CLAUSE_MARK = /[,;:]["'”’)]*$/u;

const token = (text: string) =>
  text.toLowerCase().replace(/^["'“‘(]+|[.,!?;:"'”’)]+$/gu, "");

/** Words a line should not end on when it has to be split. */
const WEAK_END = new Set(
  (
    "of and or but to into onto in on at for from with by the a an as " +
    "my your his her our their its " +
    "i we they he she you it " +
    "is are was were am be been being can could would should will have has had do does did not"
  ).split(" "),
);
/** Words a split may come before: the line starts with them. */
const GOOD_START = new Set(
  "and or but because if although while unless as to of in on at for from with by into onto through between".split(
    " ",
  ),
);

export function isSentenceEnd(text: string): boolean {
  if (/\d\.\d/.test(text)) return false;
  if (ABBREV.test(text)) return false;
  return SENTENCE_END.test(text);
}

export function sentenceStartIndexes(words: { text: string }[]): number[] {
  const starts: number[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    if (isSentenceEnd(words[i].text)) starts.push(i + 1);
  }
  return starts;
}

/**
 * Cost of splitting a too-wide line before words[i] (Netflix I.10): after
 * punctuation is best, before a conjunction or preposition is good, and
 * leaving an article, pronoun, auxiliary or preposition at the end of the
 * line is worst.
 */
export function lineBreakCost(words: { text: string }[], i: number): number {
  const prev = words[i - 1].text;
  if (CLAUSE_MARK.test(prev) || isSentenceEnd(prev)) return 0;
  if (WEAK_END.has(token(prev))) return 4;
  if (GOOD_START.has(token(words[i].text))) return 0.5;
  return 1.5;
}
