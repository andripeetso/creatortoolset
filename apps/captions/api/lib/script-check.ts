import { MAX_SCRIPT_CHARS, type ScriptEdit } from "../../src/lib/script-check";
import { aiFor, completeWithFallback, type ProviderOpts } from "../ai-complete";
import { hedged, splitAtSentences } from "./cadence-lines";

/**
 * Script check, server side. The creator gives the script they filmed
 * from; the model reads the transcript against it and points at words
 * the speech engine mis-heard: names, brand words, uncommon terms,
 * homophones, one word heard as two. The video never matches the script
 * word for word, so the script is context, not a target: ad-libs,
 * rephrasings and skipped lines stay as spoken.
 *
 * The model only proposes. An edit survives vetScriptEdits only when
 * every word it writes is in the script, it sounds like what the engine
 * heard, and it doesn't add or drop spoken words. An edit that changes
 * the word count (a name heard as ordinary words) must also write a
 * phrase the script has, word for word. Punctuation and
 * sentence capitals come from the transcript. Timings are the client's
 * job (src/lib/script-check.ts).
 */

export { MAX_SCRIPT_CHARS, type ScriptEdit };

export interface CheckWord {
  text: string;
  confidence?: number;
}

/** Transcript words per model request. */
const PIECE_WORDS = 400;
const CONTEXT_WORDS = 20;
const MAX_PARALLEL = 4;
const HEDGE_AFTER_MS = 45_000;
/** Most transcript words one edit may replace, and most it may write. */
const MAX_SPAN = 6;
const MAX_NEW_WORDS = 8;
/** Confidence shown to the model only below this: where the engine was unsure. */
const SHOW_CONFIDENCE_BELOW = 0.9;
/** How alike the fix and what was heard must sound (0–1, see soundsAlike). */
const MIN_SOUNDS_ALIKE = 0.5;
/** A fix that changes the word count must sound closer still. */
const MIN_SOUNDS_ALIKE_REGROUPED = 0.6;

export const SCRIPT_CHECK_SYSTEM = `You proofread a speech-to-text transcript of a short video against the script the speaker wrote before filming.

The video never matches the script word for word: the speaker ad-libs, rephrases, reorders, skips lines and adds new ones. The transcript is the truth about WHAT was said. The script only tells you which names, brand words, uncommon terms and phrases the speaker uses, so you can find the places where the speech engine mis-heard them.

Fix only mis-hearings: a word or a short run of words (up to 6) that sounds like a word, name or phrase in the script, where the words around it show the speaker said the script's version. Typical:
- names and brands spelled wrong: "Jon Mcallen" → "John McAllan"
- a name the engine didn't know, heard as ordinary words that sound like it, often more or fewer words than the name and sometimes with a sound run in from the word before: "the Monty Story method" → "the Montessori method" (replace "Monty Story" with "Montessori")
- uncommon or technical words heard as common ones: "prawn position" → "prone position"
- homophones where the script has the same sentence: "their" → "there", "for" → "four"
- one word heard as two, or two words heard as one

The script is your evidence. When the words around a spot in the transcript match the words around a name or term in the script, and the spot sounds like that name, it is that name mis-heard, however different the spelling looks. Fix every place it happens, not only the first.

Never:
- change what the speaker actually said to match the script: different wording, synonyms, extra or missing words, filler and repeats all stay
- add or remove spoken words
- change punctuation, number formatting or the capitals of ordinary words
- touch a word only because the script words that part differently

Transcript lines are "index|word". A third field, where present, is the engine's confidence (0-1) for a word it was unsure of: look hardest there, but a confident word can still be wrong, names especially.

Respond with only a JSON object: {"edits": [{"from": 12, "to": 13, "text": "Montessori"}]}. from and to are the first and last transcript index the edit replaces (the same index for one word). text is what the speaker said there, spelled as in the script; it may have more or fewer words than it replaces. Edits must not overlap. Answer {"edits": []} when nothing was mis-heard.`;

/** The script, then the numbered transcript piece [a, b) with context around it. */
export function scriptCheckPrompt(
  script: string,
  words: CheckWord[],
  a = 0,
  b = words.length,
): string {
  const text = (from: number, to: number) =>
    words
      .slice(Math.max(0, from), Math.min(words.length, to))
      .map((w) => w.text)
      .join(" ");
  const lines = words.slice(a, b).map((w, k) => {
    const c = w.confidence;
    return typeof c === "number" && Number.isFinite(c) && c < SHOW_CONFIDENCE_BELOW
      ? `${a + k}|${w.text}|${c.toFixed(2)}`
      : `${a + k}|${w.text}`;
  });
  const parts = [`SCRIPT (what the speaker planned to say, context only):\n${script.trim()}`];
  if (a > 0) {
    parts.push(`Just before this part (context only):\n${text(a - CONTEXT_WORDS, a)}`);
  }
  parts.push(
    `TRANSCRIPT (${b - a} words${words.length > b - a ? `, indices ${a}-${b - 1}` : ""}):\n${lines.join("\n")}`,
  );
  if (b < words.length) {
    parts.push(`Just after this part (context only):\n${text(b, b + CONTEXT_WORDS)}`);
  }
  return parts.join("\n\n");
}

/** Pull the edits out of the model text (tolerates fences and preamble). */
export function parseScriptEdits(text: string): ScriptEdit[] {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("The model returned no JSON");
  const parsed = JSON.parse(match[0]) as { edits?: unknown };
  if (!Array.isArray(parsed.edits)) throw new Error("The model returned no edits list");
  const edits: ScriptEdit[] = [];
  for (const raw of parsed.edits) {
    if (!raw || typeof raw !== "object") continue;
    const { from, to, text: fix } = raw as Record<string, unknown>;
    if (!Number.isInteger(from) || typeof fix !== "string") continue;
    edits.push({
      from: from as number,
      to: Number.isInteger(to) ? (to as number) : (from as number),
      text: fix.trim(),
    });
  }
  return edits;
}

/** Leading punctuation, the word itself, trailing punctuation. */
function parts(token: string): [string, string, string] {
  const m = token.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u)!;
  return [m[1], m[2], m[3]];
}

/** Lowercase letters and digits only: "Mercer's," → "mercers". */
const letters = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** A word's spellings the script could hold it as (plural/possessive). */
function forms(word: string): string[] {
  const w = letters(word);
  return [w, w.replace(/s$/, "")];
}

/** The script's words in order, letters only. */
const wordList = (script: string) => script.split(/[\s/-]+/).map(letters).filter(Boolean);

/** Whether the words stand side by side, in this order, in the script. */
function hasPhrase(list: string[], phrase: string[]): boolean {
  const want = phrase.flatMap((w) => w.split("-")).map(letters).filter(Boolean);
  const same = (a: string, b: string) => forms(a).some((f) => forms(b).includes(f));
  for (let i = 0; i + want.length <= list.length; i++) {
    if (want.every((w, k) => same(w, list[i + k]))) return true;
  }
  return false;
}

function vocabulary(script: string): Set<string> {
  const set = new Set<string>();
  for (const token of script.split(/[\s/]+/)) {
    for (const piece of [token, ...token.split("-")]) {
      for (const f of forms(piece)) if (f) set.add(f);
    }
  }
  return set;
}

function levenshtein(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(
        row[j] + 1,
        next[j - 1] + 1,
        row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    row = next;
  }
  return row[b.length];
}

const likeness = (a: string, b: string) => {
  const longest = Math.max(a.length, b.length);
  return longest ? 1 - levenshtein(a, b) / longest : 1;
};

/** Consonant outline, so spellings of one sound compare equal-ish. */
const skeleton = (s: string) =>
  s
    .replace(/ph/g, "f")
    .replace(/x/g, "ks")
    .replace(/[ckq]/g, "k")
    .replace(/z/g, "s")
    .replace(/[aeiouy]/g, "")
    .replace(/(.)\1+/g, "$1");

const startsVowel = (s: string) => /^[aeiou]/.test(s);
const startsConsonant = (s: string) => /^[b-df-hj-np-tv-xz]/.test(s);

/**
 * How alike two spellings sound, 0–1: the better of plain letter
 * likeness and consonant-outline likeness ("prawn" ~ "prone"). When one
 * side starts with a vowel and the other doesn't, the outlines also
 * compare without that first consonant: speech runs a sound across the
 * word gap (a name like "Acrobatics" heard as "…Back Rubber…"). Too-short
 * outlines ("a" vs "I") only count by letters.
 */
export function soundsAlike(heard: string, fixed: string): number {
  const a = letters(heard);
  const b = letters(fixed);
  const byLetters = likeness(a, b);
  const outlines = (sa: string, sb: string) =>
    Math.min(sa.length, sb.length) < 2 ? 0 : likeness(sa, sb);
  const sa = skeleton(a);
  const sb = skeleton(b);
  let best = Math.max(byLetters, outlines(sa, sb));
  if (startsVowel(a) && startsConsonant(b)) best = Math.max(best, outlines(sa, sb.slice(1)));
  if (startsConsonant(a) && startsVowel(b)) best = Math.max(best, outlines(sa.slice(1), sb));
  return best;
}

const startsUpper = (s: string) => /^\p{Lu}/u.test(s);

/**
 * Words the script capitalizes mid-sentence: names and brands ("at Tiny
 * Acrobatics we"), as opposed to ordinary words that only start a
 * sentence or a line there.
 */
function namesIn(script: string): Set<string> {
  const names = new Set<string>();
  for (const line of script.split("\n")) {
    let sentenceStart = true;
    for (const token of line.split(/\s+/).filter(Boolean)) {
      const word = parts(token)[1];
      if (word && startsUpper(word) && !sentenceStart) names.add(word);
      sentenceStart = !word || /[.!?…:]["'”’)]*$/u.test(token);
    }
  }
  return names;
}

/**
 * Keep an edit only when it is a plausible mis-hearing fixed from the
 * script, dressed in the transcript's punctuation and sentence capitals.
 * Edits come back sorted, in range and non-overlapping.
 */
export function vetScriptEdits(
  edits: ScriptEdit[],
  words: CheckWord[],
  script: string,
): ScriptEdit[] {
  const vocab = vocabulary(script);
  const list = wordList(script);
  const names = namesIn(script);
  const scriptWords = new Set(script.split(/\s+/).map((t) => parts(t)[1]).filter(Boolean));
  const out: ScriptEdit[] = [];
  let lastTo = -1;
  for (const edit of [...edits].sort((a, b) => a.from - b.from || a.to - b.to)) {
    const { from, to } = edit;
    if (from <= lastTo || from < 0 || to < from || to >= words.length) continue;
    if (to - from + 1 > MAX_SPAN) continue;
    const heard = words.slice(from, to + 1).map((w) => w.text);
    const fixed = edit.text
      .split(/\s+/)
      .map((t) => parts(t)[1])
      .filter(Boolean);
    if (!fixed.length || fixed.length > MAX_NEW_WORDS) continue;

    // every word written must come from the script
    if (!fixed.every((w) => forms(w).some((f) => vocab.has(f)))) continue;
    const heardText = heard.join(" ");
    const fixedText = fixed.join(" ");
    if (soundsAlike(heardText, fixedText) < MIN_SOUNDS_ALIKE) continue;
    // a changed word count may only regroup what was heard into a phrase
    // the script has, never add or drop a spoken word
    if (
      fixed.length !== heard.length &&
      !(hasPhrase(list, fixed) && regroups(heard, fixed))
    ) {
      continue;
    }

    const dressed = dress(fixed, heard, names, scriptWords);
    const text = dressed.join(" ");
    if (text === heardText) continue;
    // a capitals-only change must be a name the script capitalizes
    if (
      text.toLowerCase() === heardText.toLowerCase() &&
      !dressed.every((w, k) => w === heard[k] || names.has(parts(w)[1]))
    ) {
      continue;
    }
    out.push({ from, to, text });
    lastTo = to;
  }
  return out;
}

/**
 * A run that became more or fewer words is the engine regrouping the
 * sounds of an unfamiliar name into ordinary words ("Back Breaks" for
 * "Acrobatics") only when the whole run sounds alike, and no single word
 * it gained or lost explains the difference ("the the" → "the" drops a
 * spoken word; "prone position" → "the prone position" adds one).
 */
function regroups(heard: string[], fixed: string[]): boolean {
  const now = soundsAlike(heard.join(" "), fixed.join(" "));
  if (now < MIN_SOUNDS_ALIKE_REGROUPED) return false;
  const [more, fewer] = fixed.length > heard.length ? [fixed, heard] : [heard, fixed];
  return more.every(
    (_, k) => soundsAlike(more.filter((__, j) => j !== k).join(" "), fewer.join(" ")) <= now,
  );
}

/**
 * Give the fixed words the transcript's punctuation and sentence
 * capitals: word by word when the count is unchanged, at the run's edges
 * when words were joined or split.
 */
function dress(
  fixed: string[],
  heard: string[],
  names: Set<string>,
  scriptWords: Set<string>,
): string[] {
  const capital = (word: string, like: string) => {
    const was = parts(like)[1];
    if (startsUpper(was) && !startsUpper(word)) {
      return word.charAt(0).toUpperCase() + word.slice(1);
    }
    // an ordinary word the script capitalized only to start a sentence
    const lower = word.charAt(0).toLowerCase() + word.slice(1);
    if (!startsUpper(was) && !names.has(word) && scriptWords.has(lower)) return lower;
    return word;
  };
  if (fixed.length === heard.length) {
    return fixed.map((w, k) => {
      const [lead, , trail] = parts(heard[k]);
      return lead + capital(w, heard[k]) + trail;
    });
  }
  return fixed.map((w, k) => {
    let word = k === 0 ? capital(w, heard[0]) : w;
    if (k === 0) word = parts(heard[0])[0] + word;
    if (k === fixed.length - 1) word += parts(heard[heard.length - 1])[2];
    return word;
  });
}

type CheckOpts = { signal?: AbortSignal; provider?: ProviderOpts; hedgeAfterMs?: number };

/**
 * The check runs on Caption Studio's provider, labelled "Script check"; no hedged second call on the Mac or a local
 * model, which would only double its work (Opus takes about as long per piece as the hedge waits).
 */
export function scriptCheckOpts(user: Parameters<typeof aiFor>[0], opts: CheckOpts): CheckOpts {
  const provider = aiFor(user, "captions", "Script check");
  return { ...opts, provider, ...(provider.only?.some((id) => id === "mac" || id === "localModel") ? { hedgeAfterMs: 15 * 60_000 } : {}) };
}

/** Vetted script edits for a whole transcript: pieces in parallel, joined. */
export async function scriptEdits(
  script: string,
  words: CheckWord[],
  opts: CheckOpts = {},
): Promise<ScriptEdit[]> {
  const pieces = splitAtSentences(words, PIECE_WORDS);
  const results: ScriptEdit[][] = new Array(pieces.length);
  let next = 0;
  const worker = async () => {
    while (next < pieces.length) {
      const k = next++;
      const [a, b] = pieces[k];
      const prompt = scriptCheckPrompt(script, words, a, b);
      const edits = await hedged(
        (signal) =>
          completeWithFallback(
            SCRIPT_CHECK_SYSTEM,
            prompt,
            signal,
            parseScriptEdits,
            opts.provider,
          ),
        opts.hedgeAfterMs ?? HEDGE_AFTER_MS,
        opts.signal,
      );
      // an edit reaching outside its piece is dropped, not guessed at
      results[k] = edits.filter((e) => e.from >= a && e.to < b);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(MAX_PARALLEL, pieces.length) }, worker),
  );
  return vetScriptEdits(results.flat(), words, script);
}
