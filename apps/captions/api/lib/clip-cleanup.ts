export interface TimedWord {
  text: string;
  start: number;
  end: number;
  confidence?: number;
}

export interface CleanupEdit {
  i: number;
  text: string;
}

export interface CleanupPayload {
  drop: number[];
  fixes: CleanupEdit[];
}

function parseJsonObject(text: string): Record<string, unknown> {
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON");
  return JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
}

export function parseCleanupPayload(text: string): CleanupPayload {
  const obj = parseJsonObject(text);
  const drop: number[] = [];
  if (Array.isArray(obj.drop)) {
    for (const raw of obj.drop) {
      const i = Number(raw);
      if (Number.isInteger(i) && i >= 0) drop.push(i);
    }
  }
  const fixes: CleanupEdit[] = [];
  if (Array.isArray(obj.fixes)) {
    for (const it of obj.fixes) {
      if (!it || typeof it !== "object") continue;
      const rec = it as { i?: unknown; text?: unknown };
      const i = Number(rec.i);
      const word = typeof rec.text === "string" ? rec.text.trim() : "";
      if (!Number.isInteger(i) || i < 0 || !word) continue;
      fixes.push({ i, text: word.slice(0, 80) });
    }
  }
  return { drop, fixes };
}

export function applyTranscriptCleanup(
  words: TimedWord[],
  payload: CleanupPayload,
): TimedWord[] {
  const drop = new Set(
    payload.drop.filter((i) => i >= 0 && i < words.length),
  );
  const fixes = new Map<number, string>();
  for (const fix of payload.fixes) {
    if (fix.i < 0 || fix.i >= words.length) continue;
    fixes.set(fix.i, fix.text);
  }
  const next = words
    .map((w, i) => (fixes.has(i) ? { ...w, text: fixes.get(i)! } : w))
    .filter((_, i) => !drop.has(i))
    .filter((w) => w.text.length > 0);
  if (!next.length) throw new Error("cleanup removed the whole transcript");
  return next;
}

export function spokenText(words: TimedWord[]): string {
  return words.map((w) => w.text).join(" ");
}

export function numberedWords(
  words: TimedWord[],
  offset = 0,
): string {
  return words
    .map((w, i) => {
      const conf =
        typeof w.confidence === "number" && Number.isFinite(w.confidence)
          ? `\t${w.confidence.toFixed(2)}`
          : "";
      return `${offset + i}\t${w.text}${conf}`;
    })
    .join("\n");
}

export function plainWords(words: TimedWord[]): TimedWord[] {
  return words.map(({ text, start, end }) => ({ text, start, end }));
}

export const CLEANUP_CHUNK = 400;
const CONTEXT_WORDS = 24;

export function cleanupUserPrompt(
  words: TimedWord[],
  offset = 0,
  previous: TimedWord[] = [],
): string {
  const hasConf = words.some(
    (w) => typeof w.confidence === "number" && Number.isFinite(w.confidence),
  );
  const parts: string[] = [];
  if (previous.length) {
    parts.push(`Previous context (do not edit):\n${spokenText(previous)}`);
  }
  parts.push(`Spoken:\n${spokenText(words)}`);
  parts.push(
    `Numbered words (index, word${hasConf ? ", confidence 0-1" : ""}):\n${numberedWords(words, offset)}`,
  );
  return parts.join("\n\n");
}

export function cleanupSlice(
  words: TimedWord[],
  start: number,
  size = CLEANUP_CHUNK,
): { slice: TimedWord[]; previous: TimedWord[] } {
  return {
    slice: words.slice(start, start + size),
    previous: words.slice(Math.max(0, start - CONTEXT_WORDS), start),
  };
}

/** Automatic post-ASR pass: fix nonsense, keep fillers and timing. */
export const CORRECT_SYSTEM = `You correct automatic speech recognition errors in a screen-recording transcript. Return JSON only:
{"drop":[wordIndex],"fixes":[{"i":wordIndex,"text":"replacement"}]}

The numbered list is the ASR output. Confidence, when present, is 0-1 — treat low scores as more likely wrong.

Fix only:
- Homophones and near-misses that don't fit the sentence
- Garbled or nonsensical tokens given surrounding words
- UI/product names that are clearly mangled in a screen recording
- A fused/split token, by putting a short phrase on that index

Do not drop filler (um, uh, like). Do not rewrite for style, brevity, or grammar. Do not invent words that were not said. Leave a word unchanged unless you are confident it is wrong. Drop a token only if it is noise or a duplicate hallucination. Indices match the numbered list. Empty arrays are fine. No markdown.`;

/** On-demand polish: fillers plus leftover ASR mistakes. */
export const CLEANUP_SYSTEM = `Clean this screen-recording transcript. Return JSON only:
{"drop":[wordIndex],"fixes":[{"i":wordIndex,"text":"replacement"}]}
Drop filler (um, uh, er, ah, you know, like-as-filler, false starts). Fix leftover ASR errors that make a sentence not make sense. Keep meaning and the speaker's words. Indices match the numbered list. Do not drop content words. No markdown.`;
