import { isSentenceEnd } from "../../src/lib/caption-constraints";
import { completeWithFallback, type ProviderOpts } from "../ai-complete";

/**
 * Match cadence, server side. The model rewrites the transcript as lines,
 * one thought per line, and marks with "|" where a long line may be
 * split. Code aligns those lines back to the timed words and returns one
 * mark per word (see Word.cut): 2 a new thought, 1 a fine split point,
 * 0 keep with the previous word. The marks don't depend on the caption
 * box, so the client re-lays them out for any box size without asking
 * the model again.
 */

export type Mark = 0 | 1 | 2;

export const CADENCE_SYSTEM = `You set the on-screen captions for a short spoken video (fast, edited social-media speech). Rewrite the transcript as lines, one thought per line, the way the speaker delivers it.

Rules:
- Keep every word exactly as given, in the same order, with its punctuation — including repeated words and filler. Do not add, drop, fix or reorder anything.
- A line is one thought: what the listener takes in as one beat. It does not have to be a full sentence. It can be a setup whose payoff is the next line, or a single word the speaker gives its own beat.
- Never pull the first words of the next thought onto a line to fill it. Never leave the last words of a thought for the next line.
- A sentence end always ends a line. A comma does not have to.
- Inside a line, put " | " at each place it could be split cleanly if the screen is too narrow — between phrases, never inside words that belong together ("a month old", "of course", "every single day"). A short line needs none.

Example of the style (a different passage):
Our sample app | opens on a short tour
at a steady | pace,
built its first screen
and shipped it in May.
So here's | everything it does
to help you start
with a clean,
simple,
useful page
that you can use today.
So the first thing is
movement | every single day
from the very beginning.
Doing as much | floor time
as possible

Respond with only a JSON object: {"lines": ["...", "..."]}`;

/**
 * The words to lay out, with a little of the text around them so a
 * setup or payoff just outside the piece still reads as one.
 */
export function cadencePrompt(
  words: { text: string }[],
  context: { before?: string; after?: string } = {},
): string {
  const parts: string[] = [];
  if (context.before) {
    parts.push(`Just before this part (context only — do not include it):\n${context.before}`);
  }
  parts.push(`Transcript (${words.length} words):\n${words.map((w) => w.text).join(" ")}`);
  if (context.after) {
    parts.push(`Just after this part (context only — do not include it):\n${context.after}`);
  }
  return parts.join("\n\n");
}

/**
 * Words per Match cadence request. A reel goes in one request: measured
 * on a real reel, ~120-word pieces were slower (the wait is the slowest
 * piece) and grouped worse (less context). Only long transcripts split.
 */
export const PIECE_WORDS = 500;
/**
 * On the API key a request still running after 40 s gets an identical
 * second one, and the first answer wins (same model and prompt). A provider
 * on the Mac is never hedged: a second run only doubles the Mac's work.
 */
export const HEDGE_AFTER_MS = 40_000;
/** How long before a hedged second request: never on the Mac (15 min = past any answer). */
export const hedgeAfter = (opts: { provider?: ProviderOpts; hedgeAfterMs?: number }) =>
  opts.hedgeAfterMs ?? (opts.provider?.only?.includes("mac") ? 15 * 60_000 : HEDGE_AFTER_MS);
/** Words of neighbouring text each piece sees for context. */
const CONTEXT_WORDS = 40;
/** Model requests in flight at once for one transcript. */
const MAX_PARALLEL = 6;

/**
 * Cut the words into pieces of about `target` words, only at sentence
 * ends (so no thought is cut in half). Returns [start, end) ranges.
 */
export function splitAtSentences(
  words: { text: string }[],
  target = PIECE_WORDS,
): [number, number][] {
  const ends: number[] = [];
  for (let i = 1; i <= words.length; i++) {
    if (i === words.length || isSentenceEnd(words[i - 1].text)) ends.push(i);
  }
  const pieces: [number, number][] = [];
  let at = 0;
  while (at < words.length) {
    if (words.length - at <= target * 1.5) {
      pieces.push([at, words.length]);
      break;
    }
    // the sentence end closest to the target size, not below half of it
    let best = -1;
    for (const e of ends) {
      if (e - at < target / 2) continue;
      if (e - at > target * 2) break;
      if (best < 0 || Math.abs(e - at - target) < Math.abs(best - at - target)) best = e;
    }
    const end = best > 0 ? best : Math.min(words.length, at + target);
    pieces.push([at, end]);
    at = end;
  }
  return pieces;
}

/**
 * Run `attempt`; if it hasn't settled after `afterMs`, start a second
 * identical attempt. The first success wins and the other is aborted.
 * An attempt that fails outright (every provider failed) isn't retried
 * here — completeWithFallback already did that.
 */
export function hedged<T>(
  attempt: (signal: AbortSignal) => Promise<T>,
  afterMs: number,
  outer?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controllers: AbortController[] = [];
    let settled = false;
    let pending = 0;
    let firstError: unknown;
    const finish = () => {
      settled = true;
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      for (const c of controllers) c.abort();
    };
    outer?.addEventListener("abort", onAbort);
    const start = () => {
      const controller = new AbortController();
      if (outer?.aborted) controller.abort();
      controllers.push(controller);
      pending++;
      attempt(controller.signal).then(
        (value) => {
          if (settled) return;
          finish();
          for (const c of controllers) if (c !== controller) c.abort();
          resolve(value);
        },
        (error) => {
          pending--;
          if (settled) return;
          firstError ??= error;
          // still waiting to hedge, or the other attempt is still running
          if (pending > 0) return;
          finish();
          reject(firstError);
        },
      );
    };
    const timer = setTimeout(() => {
      if (!settled && pending > 0 && !outer?.aborted) start();
    }, afterMs);
    start();
  });
}

/** Thought marks for a whole transcript: pieces in parallel, joined. */
export async function thoughtMarks(
  words: { text: string }[],
  opts: {
    signal?: AbortSignal;
    pieceWords?: number;
    provider?: ProviderOpts;
    hedgeAfterMs?: number;
  } = {},
): Promise<Mark[]> {
  const pieces = splitAtSentences(words, opts.pieceWords ?? PIECE_WORDS);
  const text = (a: number, b: number) =>
    words
      .slice(Math.max(0, a), Math.min(words.length, b))
      .map((w) => w.text)
      .join(" ");
  const results: Mark[][] = new Array(pieces.length);
  let next = 0;
  const worker = async () => {
    while (next < pieces.length) {
      const k = next++;
      const [a, b] = pieces[k];
      const piece = words.slice(a, b);
      const prompt = cadencePrompt(piece, {
        before: a > 0 ? text(a - CONTEXT_WORDS, a) : undefined,
        after: b < words.length ? text(b, b + CONTEXT_WORDS) : undefined,
      });
      results[k] = await hedged(
        (signal) =>
          completeWithFallback(
            CADENCE_SYSTEM,
            prompt,
            signal,
            (answer) => marksFromLines(parseThoughtLines(answer), piece),
            opts.provider,
          ),
        hedgeAfter(opts),
        opts.signal,
      );
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(MAX_PARALLEL, pieces.length) }, worker),
  );
  return results.flat();
}

/**
 * Split points for thought lines that don't fit the box. The thoughts are
 * given and stay as they are: the model only says where each long line
 * may split. Telling the thought pass the width instead made it chop
 * thoughts into short lines, so this is a separate, much smaller request.
 */
export const SPLIT_SYSTEM = `You fit spoken caption lines into a narrow caption box. Each line is one thought and stays one thought.

For each line, put " | " at the places where it can be split so that every piece fits the given number of characters (counting spaces). Split between phrases, where a speaker could take a breath. Never split inside words that belong together ("a month old", "of course", "every single day", "the tummy time program"), and avoid leaving one short word alone on a piece.

Keep every word exactly as given, in the same order, and return the same number of lines. Respond with only a JSON object: {"lines": ["...", "..."]}`;

/** Long lines per split request. */
const SPLIT_BATCH = 6;

export function splitPrompt(lines: string[], maxChars: number): string {
  // models can't count characters exactly: plan for a little less
  const fit = Math.max(8, maxChars - 3);
  return `Every piece must be at most ${fit} characters.\n\n${lines.join("\n")}`;
}

/**
 * Ask where each line may split. Returns, per line, the word indices a
 * new piece may start at. Line breaks the model adds count as split
 * points too — never as new thoughts.
 */
export async function splitPoints(
  lines: string[][],
  maxChars: number,
  opts: { signal?: AbortSignal; provider?: ProviderOpts } = {},
): Promise<number[][]> {
  if (!lines.length) return [];
  // small batches in parallel: a reasoning model takes far longer on one
  // long list than on several short ones
  const batches: string[][][] = [];
  for (let i = 0; i < lines.length; i += SPLIT_BATCH) batches.push(lines.slice(i, i + SPLIT_BATCH));
  const answers = await Promise.all(
    batches.map((batch) => {
      const words = batch.flat().map((text) => ({ text }));
      const prompt = splitPrompt(batch.map((l) => l.join(" ")), maxChars);
      return hedged(
        (signal) =>
          completeWithFallback(
            SPLIT_SYSTEM,
            prompt,
            signal,
            (answer) => marksFromLines(parseThoughtLines(answer), words),
            opts.provider,
          ),
        HEDGE_AFTER_MS,
        opts.signal,
      );
    }),
  );
  const out: number[][] = [];
  batches.forEach((batch, b) => {
    let at = 0;
    for (const line of batch) {
      const splits: number[] = [];
      for (let k = 1; k < line.length; k++) if (answers[b][at + k] > 0) splits.push(k);
      out.push(splits);
      at += line.length;
    }
  });
  return out;
}

/** Thought lines (by word index) wider than maxChars. */
export function longThoughts(
  words: { text: string }[],
  marks: Mark[],
  maxChars: number,
): [number, number][] {
  const out: [number, number][] = [];
  let a = 0;
  for (let i = 1; i <= words.length; i++) {
    if (i < words.length && marks[i] !== 2) continue;
    const width = words.slice(a, i).reduce((n, w, k) => n + w.text.length + (k ? 1 : 0), 0);
    if (width > maxChars && i - a > 1) out.push([a, i]);
    a = i;
  }
  return out;
}

/** Pull the lines array out of the model text (tolerates fences/preamble). */
export function parseThoughtLines(text: string): string[] {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("The model returned no JSON");
  const parsed = JSON.parse(match[0]) as { lines?: unknown };
  const lines = Array.isArray(parsed.lines)
    ? parsed.lines.filter((l): l is string => typeof l === "string" && l.trim() !== "")
    : [];
  if (!lines.length) throw new Error("The model returned no caption lines");
  return lines;
}

const norm = (s: string) => {
  const n = s.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");
  return n || s;
};

/** Below this share of words matched, the model changed the transcript. */
const MIN_MATCH = 0.95;

/**
 * Align the model's lines to the timed words (longest common subsequence
 * on normalized text, so a stray dropped repeat or a fixed apostrophe
 * doesn't sink the pass) and turn line starts and "|" into marks.
 */
export function marksFromLines(
  lines: string[],
  words: { text: string }[],
): Mark[] {
  const tokens: { text: string; mark: Mark }[] = [];
  for (const line of lines) {
    let mark: Mark = 2;
    for (const part of line.replace(/\|/g, " | ").split(/\s+/)) {
      if (!part) continue;
      if (part === "|") {
        if (mark === 0) mark = 1;
        continue;
      }
      tokens.push({ text: part, mark });
      mark = 0;
    }
  }

  const n = tokens.length;
  const m = words.length;
  const a = tokens.map((t) => norm(t.text));
  const b = words.map((w) => norm(w.text));
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const marks: Mark[] = new Array(m).fill(0);
  let matched = 0;
  // a mark on a token the model reworded lands on the first word after
  // the last matched one — the word that token stood for
  let lastMatched = -1;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      if (tokens[i].mark > marks[j]) marks[j] = tokens[i].mark;
      lastMatched = j;
      matched++;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      const at = lastMatched + 1;
      if (at < m && tokens[i].mark > marks[at]) marks[at] = tokens[i].mark;
      i++;
    } else {
      j++;
    }
  }
  if (matched < m * MIN_MATCH) {
    throw new Error("The model changed the transcript words");
  }

  marks[0] = 2;
  for (let k = 1; k < m; k++) {
    if (isSentenceEnd(words[k - 1].text)) marks[k] = 2;
  }
  return marks;
}
