import { SPEECH_WORDS_MAX, SPEECH_WORD_ALIASES_MAX, SPEECH_WORD_CHARS_MAX, type SpeechWord } from "../../contracts/voice";

/**
 * Settings → AI → Voice → Words: the names and terms every engine listens for, and what they are misheard as. Checked
 * here, at the trust boundary (PUT /api/voice-prefs); the engines get the terms, and what they wrote is rewritten to the
 * term once it comes back (speechCorrector), the same for every engine.
 */

const clean = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  return s && s.length <= SPEECH_WORD_CHARS_MAX ? s : null;
};

/** The words as stored, or the reason they are refused. A spelling is unique across all words, ignoring case. */
export function checkSpeechWords(input: unknown): SpeechWord[] | string {
  if (!Array.isArray(input)) return "words is a list of { term, soundsLike }";
  if (input.length > SPEECH_WORDS_MAX) return `At most ${SPEECH_WORDS_MAX} words`;
  const seen = new Set<string>();
  const out: SpeechWord[] = [];
  for (const w of input as { term?: unknown; soundsLike?: unknown }[]) {
    const term = clean(w?.term);
    if (!term) return `Each word needs a term of 1 to ${SPEECH_WORD_CHARS_MAX} characters`;
    if (!Array.isArray(w.soundsLike)) return `${term}: soundsLike is a list of spellings`;
    if (w.soundsLike.length > SPEECH_WORD_ALIASES_MAX) return `${term}: at most ${SPEECH_WORD_ALIASES_MAX} sounds-like spellings`;
    const spellings = [term];
    for (const raw of w.soundsLike) {
      const s = clean(raw);
      if (!s) return `${term}: each sounds-like spelling is 1 to ${SPEECH_WORD_CHARS_MAX} characters`;
      // the term itself is no misspelling of itself
      if (s.toLocaleLowerCase() !== term.toLocaleLowerCase()) spellings.push(s);
    }
    for (const s of spellings) {
      const key = s.normalize("NFC").toLocaleLowerCase();
      if (seen.has(key)) return `"${s}" is listed twice`;
      seen.add(key);
    }
    out.push({ term, soundsLike: spellings.slice(1) });
  }
  return out;
}

/** The terms the engines are told to listen for (Deepgram keyterm, OpenAI prompt); the sounds-like spellings are not. */
export const termsOf = (words: SpeechWord[] | undefined): string[] => (words ?? []).map((w) => w.term);

/** OpenAI's prompt takes about 224 tokens: the terms, joined, cut to fit. */
export const promptOf = (terms: string[]): string => terms.join(", ").slice(0, 800);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What an engine wrote, with every sounds-like spelling of a word replaced by its term: whole words only, ignoring case,
 * the longest spelling first. Built once per answer (speechCorrector), so an engine's text is rewritten in one pass.
 * shortcut: spellings are matched in the text as written, not across the engine's word timings, which is enough for
 * the names and terms people add; a spelling that an engine splits across words is left as it wrote it.
 */
export function speechCorrector(words: SpeechWord[] | undefined): (text: string) => string {
  const pairs = (words ?? [])
    .flatMap((w) => w.soundsLike.map((s) => ({ s, term: w.term })))
    .sort((a, b) => b.s.length - a.s.length);
  if (!pairs.length) return (text) => text;
  const term = new Map(pairs.map((p) => [p.s.toLocaleLowerCase(), p.term]));
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${pairs.map((p) => escape(p.s)).join("|")})(?![\\p{L}\\p{N}])`, "giu");
  return (text) => text.replace(pattern, (m) => term.get(m.toLocaleLowerCase()) ?? m);
}
