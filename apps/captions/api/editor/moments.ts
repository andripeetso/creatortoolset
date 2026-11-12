import type { Line, Sentence, VersionPlan } from "../../contracts/editor";
import { MAX_MOMENTS } from "../../contracts/editor";
import { parseJsonObject } from "../lib/instagram/vision";

/**
 * Short videos from a long recording (an edit with `moments`): in place of matching takes to a script, the script
 * step asks the AI for the parts of the recording that stand on their own, and each becomes a version of one line and
 * one take. From there the chain is the one every edit runs: each version is cut (pauses out), drawn, and its preview
 * filed in Review. The prompt is the task and the answer's shape; what to look for is the person's own brief.
 *
 * The AI answers sentence numbers, a title and a score, never the words. Code checks every range (momentMap): inside
 * the recording, one file, the length asked for, no two over the same sentences.
 */

export const MOMENTS_SYSTEM = `You find the parts of a long recording that work as short videos on their own. The recording is transcribed into numbered sentences, in recording order, across one or more source files.

A moment is a run of consecutive sentences, first..last, from one source file, that a viewer understands without having heard the rest: it starts where a thought starts and ends where that thought lands. Moments do not overlap. Score each from 0 to 1 for how well it stands on its own. Follow the user's brief for what to look for.

Answer with JSON only, in this shape:
{"moments":[{"first":12,"last":19,"title":"a short title for it","score":0.9}]}`;

/** A moment's shortest and longest length in seconds: half to double the length asked for, or 15 to 90 when none is. */
export const momentRange = (targetS: number): [number, number] => (targetS > 0 ? [Math.max(5, targetS / 2), targetS * 2] : [15, 90]);

export interface MomentsInput {
  sentences: Sentence[];
  /** source version id → its title, in the order the sentences are numbered */
  titles: Record<string, string>;
  brief: string;
  count: number;
  targetS: number;
  /** the person's own notes of the edit's editing style (styles.ts styleBlock); no pack or skill text: those are written for matching takes to a script */
  styleText?: string;
}

export function momentsPrompt(i: MomentsInput): { system: string; user: string } {
  const ids = Object.keys(i.titles);
  const tag = (src: string) => `S${ids.indexOf(src) + 1}`;
  const [lo, hi] = momentRange(i.targetS);
  return {
    system: i.styleText ? `${MOMENTS_SYSTEM}\n\n${i.styleText}` : MOMENTS_SYSTEM,
    user: [
      `Brief:\n${i.brief.trim() || "(none)"}`,
      `Moments: up to ${i.count}, the best ones`,
      `Length: ${i.targetS > 0 ? `about ${i.targetS} seconds each, ` : ""}between ${Math.round(lo)} and ${Math.round(hi)} seconds`,
      `Sources:\n${ids.map((id) => `${tag(id)} = ${JSON.stringify(i.titles[id])}`).join("\n")}`,
      `Sentences (number, source, seconds, text):\n${i.sentences.map((s) => `${s.n} ${tag(s.src)} ${s.s.toFixed(1)}-${s.e.toFixed(1)} ${s.text}`).join("\n")}`,
    ].join("\n\n"),
  };
}

export interface RawMoment {
  first: number;
  last: number;
  title: string;
  score: number;
}

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The answer's shape, checked: moments is a non-empty list; a malformed one is passed on for momentMap to drop with a note. */
export function parseMoments(text: string): RawMoment[] {
  const o = parseJsonObject(text);
  if (!Array.isArray(o.moments) || !o.moments.length) throw new Error("The AI's answer has no moments");
  return o.moments.filter(obj).map((m) => ({
    first: Number(m.first),
    last: Number(m.last),
    title: typeof m.title === "string" ? m.title.replace(/\s+/g, " ").trim().slice(0, 80) : "",
    score: Number(m.score),
  }));
}

/**
 * The AI's moments checked against the sentences, best first, at most `count`: one outside the recording, across two
 * files, shorter or longer than asked for, or over sentences a better one already has is dropped with a note. Each
 * kept moment is a line of its own (its text: the words said in it) and a version of that one line, named m1, m2, …
 */
export function momentMap(raw: RawMoment[], sentences: Sentence[], count: number, targetS: number): { lines: Line[]; plans: VersionPlan[]; notes: string[] } {
  const byN = new Map(sentences.map((s) => [s.n, s]));
  const [lo, hi] = momentRange(targetS);
  const notes: string[] = [];
  const kept: (RawMoment & { src: string })[] = [];
  const best = [...raw].map((m) => ({ ...m, score: Number.isFinite(m.score) ? Math.min(1, Math.max(0, m.score)) : 0 })).sort((a, b) => b.score - a.score);
  for (const m of best) {
    const a = byN.get(m.first);
    const b = byN.get(m.last);
    const range = `${m.first}-${m.last}`;
    if (!Number.isInteger(m.first) || !Number.isInteger(m.last) || !a || !b || m.first > m.last) notes.push(`Moment ${range} is not in sentences 1-${sentences.length}: dropped`);
    else if (a.src !== b.src) notes.push(`Moment ${range} runs across two files: dropped`);
    else if (b.e - a.s < lo || b.e - a.s > hi) notes.push(`Moment ${range} is ${Math.round(b.e - a.s)} s, outside ${Math.round(lo)}-${Math.round(hi)} s: dropped`);
    else if (kept.some((k) => m.first <= k.last && k.first <= m.last)) notes.push(`Moment ${range} runs over a better one: dropped`);
    else if (kept.length < Math.min(count, MAX_MOMENTS)) kept.push({ ...m, src: a.src });
  }
  const lines: Line[] = kept.map((m, k) => ({
    id: `M${k + 1}`,
    text: sentences.filter((s) => s.n >= m.first && s.n <= m.last).map((s) => s.text).join(" "),
    takes: [{ first: m.first, last: m.last, score: m.score }],
  }));
  const plans: VersionPlan[] = kept.map((m, k) => ({ name: `m${k + 1}`, title: m.title || `Moment ${k + 1}`, lines: [{ line: `M${k + 1}`, take: lines[k]!.takes[0]! }] }));
  return { lines, plans, notes };
}
