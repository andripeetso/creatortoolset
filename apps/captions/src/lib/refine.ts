import type { ScriptEdit } from "./script-check";
import type { Word } from "./types";

/**
 * Client for the server's AI caption-cadence pass (api/ai.ts): sends the
 * word list, gets back one thought mark per word (see Word.cut). The
 * marks don't depend on the caption box; the layout does that locally.
 */
export interface AiStatus {
  available: boolean; // server has at least one AI provider key
  allowed: boolean; // this account may use it (admin, or unlocked by admin)
}

export const OUT_OF_TOKENS_CODE = "OUT_OF_TOKENS";

export class AiRequestError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "AiRequestError";
    this.code = code;
  }
}

export const isOutOfTokensError = (e: unknown): e is AiRequestError =>
  e instanceof AiRequestError && e.code === OUT_OF_TOKENS_CODE;

async function throwFromAiResponse(
  res: Response,
  fallback: string
): Promise<never> {
  const e = (await res.json().catch(() => ({ error: "" }))) as {
    error?: string;
    code?: string;
  };
  throw new AiRequestError(e.error || `${fallback} (${res.status})`, e.code);
}

let aiCache: AiStatus | null = null;
export async function aiStatus(): Promise<AiStatus> {
  if (aiCache !== null) return aiCache;
  try {
    const r = await fetch("/api/ai/available");
    const d = await r.json();
    aiCache = { available: d.available === true, allowed: d.allowed === true };
  } catch {
    aiCache = { available: false, allowed: false };
  }
  return aiCache;
}

const CADENCE_TIMING_KEY = "caption-cadence-timings-v1"; // gitleaks:allow (a localStorage key name, not a secret)
const CADENCE_CHUNK_WORDS = 500;
const MAX_TIMING_SAMPLES = 12;

/**
 * Production cohorts measured 2026-07-31 with 10 runs each. The 541-word
 * transcript is faster at the median than a full 500-word request because
 * crossing the server's 500-word cap splits work into parallel model calls.
 * The long cohort also has a much wider tail, which is why its high estimate
 * is deliberately far above its median.
 */
const SHORT_COHORT = { words: 182, expected: 38.08, low: 34.42, high: 45.3 };
const SPLIT_COHORT = { words: 541, expected: 34.86, low: 25.23, high: 85.99 };
const SINGLE_CHUNK_CAP = { words: 500, expected: 50, low: 35, high: 90 };
const TWO_FULL_CHUNKS = { words: 1_000, expected: 45, low: 30, high: 105 };

interface CadenceTimingSample {
  words: number;
  seconds: number;
}

export interface CadenceDurationEstimate {
  expectedSeconds: number;
  lowSeconds: number;
  highSeconds: number;
  learnedFromRuns: number;
}

interface CadenceBaseline {
  expected: number;
  low: number;
  high: number;
}

function blendBaseline(
  from: CadenceBaseline,
  to: CadenceBaseline,
  progress: number
): CadenceBaseline {
  const t = Math.max(0, Math.min(1, progress));
  const blend = (a: number, b: number) => a + (b - a) * t;
  return {
    expected: blend(from.expected, to.expected),
    low: blend(from.low, to.low),
    high: blend(from.high, to.high),
  };
}

/** First-run estimate from measured production cohorts and server chunking. */
function baselineCadence(wordCount: number): CadenceBaseline {
  const words = Math.max(1, Math.round(wordCount));
  if (words <= SHORT_COHORT.words) {
    // Model/network setup dominates tiny requests, so duration does not
    // shrink linearly to zero with word count.
    const scale = 0.45 + 0.55 * Math.sqrt(words / SHORT_COHORT.words);
    return {
      expected: SHORT_COHORT.expected * scale,
      low: SHORT_COHORT.low * scale,
      high: SHORT_COHORT.high * scale,
    };
  }
  if (words <= CADENCE_CHUNK_WORDS) {
    return blendBaseline(
      SHORT_COHORT,
      SINGLE_CHUNK_CAP,
      (words - SHORT_COHORT.words) /
        (SINGLE_CHUNK_CAP.words - SHORT_COHORT.words)
    );
  }
  if (words <= 750) return SPLIT_COHORT;
  if (words <= TWO_FULL_CHUNKS.words) {
    return blendBaseline(
      SPLIT_COHORT,
      TWO_FULL_CHUNKS,
      (words - 750) / (TWO_FULL_CHUNKS.words - 750)
    );
  }
  const extraChunks = Math.max(0, Math.ceil(words / CADENCE_CHUNK_WORDS) - 2);
  return {
    expected: TWO_FULL_CHUNKS.expected + extraChunks * 8,
    low: TWO_FULL_CHUNKS.low + extraChunks * 5,
    high: TWO_FULL_CHUNKS.high + extraChunks * 12,
  };
}

const baselineCadenceSeconds = (wordCount: number) =>
  baselineCadence(wordCount).expected;

function readTimingSamples(): CadenceTimingSample[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const parsed = JSON.parse(localStorage.getItem(CADENCE_TIMING_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is CadenceTimingSample =>
        s &&
        typeof s.words === "number" &&
        s.words > 0 &&
        typeof s.seconds === "number" &&
        s.seconds >= 3 &&
        s.seconds <= 300
    );
  } catch {
    return [];
  }
}

function recordCadenceTiming(words: number, seconds: number): void {
  if (words <= 0 || seconds < 3 || seconds > 300) return;
  try {
    if (typeof localStorage === "undefined") return;
    const samples = [...readTimingSamples(), { words, seconds }].slice(
      -MAX_TIMING_SAMPLES
    );
    localStorage.setItem(CADENCE_TIMING_KEY, JSON.stringify(samples));
  } catch {
    // Estimation is optional; storage restrictions must never fail cadence.
  }
}

const roundToFive = (seconds: number) => Math.max(5, Math.round(seconds / 5) * 5);
const floorToFive = (seconds: number) => Math.max(5, Math.floor(seconds / 5) * 5);
const ceilToFive = (seconds: number) => Math.max(5, Math.ceil(seconds / 5) * 5);

/** Estimated cadence duration, calibrated by this browser's recent runs. */
export function estimateCadenceDuration(wordCount: number): CadenceDurationEstimate {
  const samples = readTimingSamples();
  const baseline = baselineCadence(wordCount);
  const ratios = samples
    .map((s) => s.seconds / baselineCadenceSeconds(s.words))
    .sort((a, b) => a - b);
  const sampleMedian = ratios.length ? ratios[Math.floor(ratios.length / 2)] : 1;
  // Let one recent outlier influence, but not dominate, the estimate. Five
  // successful runs give the browser's own median full weight.
  const confidence = Math.min(1, ratios.length / 5);
  const median = 1 + (sampleMedian - 1) * confidence;
  // A pathological run should not make every later estimate equally extreme.
  const calibration = Math.max(0.6, Math.min(2.5, median));
  const expected = Math.max(
    15,
    Math.min(150, roundToFive(baseline.expected * calibration))
  );
  return {
    expectedSeconds: expected,
    lowSeconds: Math.min(expected - 5, floorToFive(baseline.low * calibration)),
    highSeconds: Math.min(
      240,
      Math.max(expected + 5, ceilToFive(baseline.high * calibration))
    ),
    learnedFromRuns: samples.length,
  };
}

/**
 * Match cadence: one thought mark per word (0 keep with the previous
 * word, 1 fine place to split a too-wide line, 2 new thought).
 */
export async function refineSegments(
  words: Word[],
  options: { signal?: AbortSignal; requestId?: string } = {}
): Promise<(0 | 1 | 2)[]> {
  const startedAt = Date.now();
  const res = await fetch("/api/ai/segment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: options.signal,
    body: JSON.stringify({
      words: words.map((w) => ({ text: w.text, start: w.start, end: w.end })),
      requestId: options.requestId,
    }),
  });
  if (!res.ok) {
    await throwFromAiResponse(res, "AI caption pass failed");
  }
  const { marks } = (await res.json()) as { marks?: unknown };
  if (
    !Array.isArray(marks) ||
    marks.length !== words.length ||
    !marks.every((m) => m === 0 || m === 1 || m === 2)
  ) {
    throw new AiRequestError(
      "Cadence matching returned an invalid grouping. Please try again."
    );
  }
  recordCadenceTiming(words.length, (Date.now() - startedAt) / 1000);
  return marks as (0 | 1 | 2)[];
}

/**
 * Where thought lines too wide for the box may split: for each line (as
 * its words), the word indices a new piece may start at.
 */
export async function refineSplits(
  lines: string[][],
  maxChars: number,
  options: { signal?: AbortSignal } = {}
): Promise<number[][]> {
  const res = await fetch("/api/ai/split", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: options.signal,
    body: JSON.stringify({ lines, maxChars }),
  });
  if (!res.ok) await throwFromAiResponse(res, "AI caption pass failed");
  const { splits } = (await res.json()) as { splits?: unknown };
  if (
    !Array.isArray(splits) ||
    splits.length !== lines.length ||
    !splits.every(
      (s, i) =>
        Array.isArray(s) &&
        s.every((k) => Number.isInteger(k) && k > 0 && k < lines[i].length)
    )
  ) {
    throw new AiRequestError("Cadence matching returned invalid line splits. Please try again.");
  }
  return splits as number[][];
}

/** Ask the server to stop the model call as well as aborting the browser fetch. */
export function cancelCadenceRequest(requestId: string): void {
  void fetch(`/api/ai/segment/${encodeURIComponent(requestId)}`, {
    method: "DELETE",
    keepalive: true,
  }).catch(() => {
    // The editor unlocks immediately even if the best-effort server signal
    // cannot be delivered (offline/navigation).
  });
}

/**
 * Script check (api/ai.ts /script-check): the transcript read against the
 * script the video was filmed from. Answers vetted edits for mis-heard
 * words; applyScriptEdits (script-check.ts) puts them into the transcript.
 */
export async function checkAgainstScript(
  script: string,
  words: Word[],
  options: { signal?: AbortSignal } = {}
): Promise<ScriptEdit[]> {
  const res = await fetch("/api/ai/script-check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: options.signal,
    body: JSON.stringify({
      script,
      words: words.map((w) => ({
        text: w.text,
        ...(typeof w.confidence === "number" ? { confidence: w.confidence } : {}),
      })),
    }),
  });
  if (!res.ok) await throwFromAiResponse(res, "Script check failed");
  const { edits } = (await res.json()) as { edits?: unknown };
  if (
    !Array.isArray(edits) ||
    !edits.every(
      (e) =>
        e &&
        Number.isInteger(e.from) &&
        Number.isInteger(e.to) &&
        typeof e.text === "string"
    )
  ) {
    throw new AiRequestError("The script check returned an invalid answer. Please try again.");
  }
  return edits as ScriptEdit[];
}
