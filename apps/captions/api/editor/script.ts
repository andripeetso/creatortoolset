import type { Line, Sentence, Take, VersionPlan } from "../../contracts/editor";
import { aiFor, completeWithFallback } from "../ai-complete";
import { parseJsonObject } from "../lib/instagram/vision";
import { MacClaudeError } from "../lib/mac-claude";
import { libraryDb } from "../library/db";
import { whoFor } from "../library/describe";
import { NeedsKey } from "../library/transcribe";
import { packInstructions } from "../lib/packs";
import { skillText } from "../lib/skills";
import { finishedBlock } from "./finished";
import { readStep, saveStep, type EditMeta } from "./store";
import { styleBlock } from "./styles";
import type { StepContext } from "./worker";

/**
 * The AI Editor's script step: the AI groups the numbered sentences into lines, lists and scores each line's takes,
 * and orders lines into the versions asked for; then code hands out the takes (allocate) so versions share as little
 * voice as they can. The prompt is the task and the answer's shape; the only taste in it is the user's own brief.
 * It runs on the creator's AI (aiFor "editor"): no route parks the step with what to add, a Mac that is off too.
 */

/** A take scored under this is used only when a line has nothing better. */
export const USABLE = 0.5;

const SYSTEM = `You plan the edit of a video from its raw footage. The footage is transcribed into numbered sentences, in recording order, across one or more source files. The speaker often says the same thing more than once: each attempt is a take.

Group the sentences into lines: a line is one thing the finished video says. A line's text is the words its best take speaks, not a summary: the cut keeps the words of each take that match it. For each line, list every take of it in the footage. A take is a run of consecutive sentences, first..last, from one source file, with a score from 0 to 1 for how usable it is. Sentences the video does not need belong to no line.

Then plan the versions asked for: each version is an order of line ids that makes a whole video. Versions may use different lines and orders. Follow the user's brief.

Answer with JSON only, in this shape:
{"lines":[{"id":"L1","text":"the line's words as its best take says them","takes":[{"first":3,"last":4,"score":0.9}]}],"versions":[{"name":"a short name","lines":["L1","L2"]}]}`;

export interface ScriptInput {
  sentences: Sentence[];
  /** source version id → its title, in the order the sentences are numbered */
  titles: Record<string, string>;
  brief: string;
  script: string;
  versions: number;
  targetS: number;
  /** Installed packs' instructions for editor.script (api/lib/packs.ts), added after the app's own system prompt. */
  packText?: string;
  /** For an edit in an editing style: the closest edits its maker finished in that style (finished.ts), after the target length. */
  examples?: string;
}

export function scriptPrompt(i: ScriptInput): { system: string; user: string } {
  const ids = Object.keys(i.titles);
  const tag = (src: string) => `S${ids.indexOf(src) + 1}`;
  const parts = [`Brief:\n${i.brief.trim() || "(none)"}`];
  if (i.script.trim()) parts.push(`The script the takes were read from:\n${i.script.trim()}`);
  parts.push(`Versions: ${i.versions}`);
  if (i.targetS) parts.push(`Target length: about ${i.targetS} seconds`);
  if (i.examples) parts.push(i.examples);
  parts.push(`Sources:\n${ids.map((id) => `${tag(id)} = ${JSON.stringify(i.titles[id])}`).join("\n")}`);
  parts.push(
    `Sentences (number, source, seconds, text):\n${i.sentences.map((s) => `${s.n} ${tag(s.src)} ${s.s.toFixed(1)}-${s.e.toFixed(1)} ${s.text}`).join("\n")}`,
  );
  return { system: i.packText ? `${SYSTEM}\n\n${i.packText}` : SYSTEM, user: parts.join("\n\n") };
}

export interface RawScript {
  lines: { id: string; text: string; takes: Take[] }[];
  versions: { name: string; lines: string[] }[];
}

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max: number) => (typeof v === "string" || typeof v === "number" ? String(v).trim().slice(0, max) : "");

/** The answer's shape, checked: lines is a non-empty list; anything malformed inside is passed on for takeMap to drop with a note. */
export function parseScript(text: string): RawScript {
  const o = parseJsonObject(text);
  if (!Array.isArray(o.lines) || !o.lines.length) throw new Error("The AI's answer has no lines");
  return {
    lines: o.lines.filter(obj).map((l) => ({
      id: str(l.id, 40),
      text: str(l.text, 2000),
      takes: (Array.isArray(l.takes) ? l.takes : []).filter(obj).map((t) => ({ first: Number(t.first), last: Number(t.last), score: Number(t.score) })),
    })),
    versions: (Array.isArray(o.versions) ? o.versions : []).filter(obj).map((v) => ({
      name: str(v.name, 80),
      lines: (Array.isArray(v.lines) ? v.lines : []).map((x) => str(x, 40)),
    })),
  };
}

export interface Mapped {
  lines: Line[];
  versions: { name: string; title: string; lines: string[] }[];
  notes: string[];
}

/** The AI's lines and versions checked against the sentences: takes outside the footage or across two files are dropped with a note. */
export function takeMap(raw: RawScript, sentences: Sentence[], count: number): Mapped {
  const notes: string[] = [];
  const byN = new Map(sentences.map((s) => [s.n, s]));
  const max = sentences.length;
  const lines: Line[] = [];
  for (const l of raw.lines) {
    if (!l.id || lines.some((x) => x.id === l.id)) {
      notes.push(`A line with ${l.id ? `a second id “${l.id}”` : "no id"} was left out`);
      continue;
    }
    const takes: Take[] = [];
    for (const t of l.takes) {
      const a = byN.get(t.first);
      const b = byN.get(t.last);
      const range = `${t.first}-${t.last}`;
      if (!Number.isInteger(t.first) || !Number.isInteger(t.last) || !a || !b || t.first > t.last) notes.push(`Line ${l.id}: take ${range} is not in sentences 1-${max}: dropped`);
      else if (a.src !== b.src) notes.push(`Line ${l.id}: take ${range} runs across two files: dropped`);
      else takes.push({ first: t.first, last: t.last, score: Number.isFinite(t.score) ? Math.min(1, Math.max(0, t.score)) : 0 });
    }
    if (!takes.length) {
      notes.push(`Line ${l.id} has no take in the footage: left out`);
      continue;
    }
    lines.push({ id: l.id, text: l.text, takes: takes.sort((x, y) => y.score - x.score) });
  }
  const known = new Set(lines.map((l) => l.id));
  const versions: Mapped["versions"] = [];
  for (const v of raw.versions) {
    const unknown = v.lines.filter((id) => !known.has(id));
    if (unknown.length) notes.push(`${v.name || "A version"} names lines that are not there (${unknown.join(", ")}): skipped them`);
    const ids = [...new Set(v.lines.filter((id) => known.has(id)))];
    if (ids.length && versions.length < count) versions.push({ name: `v${versions.length + 1}`, title: v.name || `Version ${versions.length + 1}`, lines: ids });
  }
  if (!versions.length && lines.length) versions.push({ name: "v1", title: "Version 1", lines: lines.map((l) => l.id) });
  if (versions.length < count) notes.push(`The AI planned ${versions.length} of the ${count} versions asked for`);
  return { lines, versions, notes };
}

const same = (a: Take, b: Take) => a.first === b.first && a.last === b.last;

/**
 * Hands out takes: each version in order gets, per line, the best take no earlier version used (scored USABLE or more
 * when the line has one), so versions share no voice while lines have spare takes. A line out of takes reuses its best,
 * with a note.
 */
export function allocate(lines: Line[], versions: Mapped["versions"]): { plans: VersionPlan[]; notes: string[] } {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const used = new Map<string, Take[]>();
  const notes: string[] = [];
  const plans = versions.map((v) => ({
    name: v.name,
    title: v.title,
    lines: v.lines.map((id) => {
      const line = byId.get(id)!;
      const good = line.takes.filter((t) => t.score >= USABLE);
      const pool = good.length ? good : line.takes;
      const taken = used.get(id) ?? [];
      let take = pool.find((t) => !taken.some((u) => same(u, t)));
      if (!take) {
        take = pool[0]!;
        notes.push(`${v.title} reuses line ${id}'s take ${take.first}-${take.last}: it has no other`);
      }
      used.set(id, [...taken, take]);
      return { line: id, take };
    }),
  }));
  return { plans, notes };
}

/** The Mac kinds that mean nobody is there to answer (off, or the provider gone), not that the run failed. */
function macAway(e: unknown): MacClaudeError | null {
  const m = e instanceof MacClaudeError ? e : e instanceof Error && e.cause instanceof MacClaudeError ? e.cause : null;
  return m && (m.kind === "unclaimed" || m.kind === "gone") ? m : null;
}

function titlesOf(edit: EditMeta, sentences: Sentence[]): Record<string, string> {
  const titles: Record<string, string> = {};
  const q = libraryDb().prepare("SELECT a.title FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?");
  for (const s of sentences) titles[s.src] ??= (q.get(s.src) as { title: string } | undefined)?.title ?? `Source ${edit.sources.indexOf(s.src) + 1}`;
  return titles;
}

export async function scriptStep({ edit, job, signal }: StepContext): Promise<void> {
  const analysis = readStep(edit.id, "analysis");
  if (!analysis) throw new Error("Analyze the footage first");
  const route = aiFor(whoFor(job.actor!), "editor", "AI Editor script");
  if (route.off) throw new NeedsKey(route.off);
  const { system, user } = scriptPrompt({
    sentences: analysis.sentences,
    titles: titlesOf(edit, analysis.sentences),
    brief: edit.brief,
    script: edit.script,
    versions: edit.versions,
    targetS: edit.targetS,
    // an edit made with an editing style: the person's own notes, after the packs' text (styles.ts), then the one skill
    // the style names (api/lib/skills.ts, cut there); no style adds nothing
    packText: [await packInstructions(job.actor!, "editor.script", null, { ai: route }), styleBlock(edit.style), edit.style?.skill ? await skillText(edit.createdBy, [edit.style.skill]) : ""].filter(Boolean).join("\n\n"),
    examples: finishedBlock(edit),
  });
  let raw: RawScript;
  try {
    raw = await completeWithFallback(system, user, signal, parseScript, route);
  } catch (e) {
    const away = macAway(e);
    if (away) throw new NeedsKey(away.message);
    throw e;
  }
  const mapped = takeMap(raw, analysis.sentences, edit.versions);
  if (!mapped.lines.length) throw new Error(`The AI's answer had no usable lines (${mapped.notes.slice(0, 3).join("; ")})`);
  const { plans, notes } = allocate(mapped.lines, mapped.versions);
  // the plan as the AI gave it, kept beside the one the person goes on to change: its lines and takes by number, none of its words
  await saveStep(edit.id, "first", { plans: plans.map((p) => ({ name: p.name, lines: p.lines })) });
  await saveStep(edit.id, "plan", { lines: mapped.lines, plans, notes: [...mapped.notes, ...notes] });
}
