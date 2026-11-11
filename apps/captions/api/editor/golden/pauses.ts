import type { Line, Sentence, VersionPlan } from "../../../contracts/editor";
import type { TimedWord } from "../../library/transcribe";

/**
 * A made-up recording for the cut's tests: two lines, said once in each of two files. The first line has a 0.4 s pause
 * and a 0.8 s pause inside it, the second a 0.35 s one, with speech of 0.6 s or more around each, so a cut that
 * tightens pauses has something to tighten. No app code is imported here: a test that must run on an older checkout
 * can use it.
 */

const run = (text: string, from: number): TimedWord[] => text.split(" ").map((w, i) => ({ w, s: +(from + i * 0.3).toFixed(2), e: +(from + (i + 1) * 0.3).toFixed(2) }));

/** Each file's words: "we teach rolls | to tiny ones | every single day." then "come and | join us." */
export const words: TimedWord[] = [...run("we teach rolls", 0.5), ...run("to tiny ones", 1.8), ...run("every single day.", 3.5), ...run("come and", 6), ...run("join us.", 6.95)];

/** Loudness reads, `perSecond` a second (analyze's ENERGY_PER_SECOND): 0.5 while a word is said, silence between. */
export function energy(perSecond: number): Float32Array {
  const e = new Float32Array(9 * perSecond);
  for (const w of words) e.fill(0.5, Math.round(w.s * perSecond), Math.round(w.e * perSecond));
  return e;
}

export const sentences: Sentence[] = (["ver_a", "ver_b"] as const).flatMap((src, f) => [
  { n: f * 2 + 1, src, text: "we teach rolls to tiny ones every single day.", s: 0.5, e: 3.2 + 1.2, w0: 0, w1: 8 },
  { n: f * 2 + 2, src, text: "come and join us.", s: 6, e: 7.55, w0: 9, w1: 12 },
]);

const take = (first: number, score: number) => ({ first, last: first, score });
export const lines: Line[] = [
  { id: "L1", text: "we teach rolls to tiny ones every single day", takes: [take(1, 1), take(3, 0.9)] },
  { id: "L2", text: "come and join us", takes: [take(4, 1), take(2, 0.9)] },
];
export const plans: VersionPlan[] = [
  { name: "v1", title: "First", lines: [{ line: "L1", take: take(1, 1) }, { line: "L2", take: take(4, 1) }] },
  { name: "v2", title: "Second", lines: [{ line: "L2", take: take(2, 0.9) }, { line: "L1", take: take(3, 0.9) }] },
];

/** A 9 s phone clip held upright; `ver_a` is filmed at 25 frames a second and `ver_b` at 50. */
export const probe = { duration: 9, width: 1920, height: 1080, fps: 25, rotation: 90, format: "mov", vcodec: "h264", pixFmt: "yuv420p", acodec: "aac", timecode: "01:00:00:00" };
export const FPS = { ver_a: 25, ver_b: 50 } as const;
