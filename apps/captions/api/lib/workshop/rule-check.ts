import { ask, noul, yes } from "../jev";
import type { Document, Rule } from "./types";

/**
 * After a workshop turn edits the draft, Jev checks it against the rules
 * the document runs under, one yes/no each, in one request. Only clear
 * breaks come back as flags; nothing is blocked (gateCompanionEdits still
 * does the blocking it always did).
 */

export interface RuleFlag {
  /** Rule id, or "question-caption" / "question-pinned". */
  id: string;
  name: string;
  /** Jev's probability that the draft breaks it, 0–1. */
  p: number;
}

/** A flag needs at least this probability: only clear breaks. */
export const FLAG_MIN = 0.85;
/** Rules checked per turn. */
const MAX_RULES = 24;

function draftText(doc: Document): string {
  const parts: string[] = [];
  if (doc.hooks?.length) parts.push(`Opening options:\n${doc.hooks.map((h) => `- ${h.text}`).join("\n")}`);
  parts.push(`Piece:\n${doc.blocks.map((b) => b.text).join("\n")}`);
  return parts.join("\n\n").slice(0, 8000);
}

export async function checkDraft(
  key: string,
  doc: Document,
  rules: Rule[],
  signal?: AbortSignal,
): Promise<RuleFlag[]> {
  const active = rules.filter((r) => r.text.trim()).slice(0, MAX_RULES);
  const questions: Record<string, ReturnType<typeof noul>> = {};
  active.forEach((r, i) => {
    // the rule is the requirement; taste and style choices are not breaks
    questions[`rule${i}`] = noul(
      `Does the draft clearly break this writing rule? Answer yes only for a clear break of what the rule requires, not for a matter of taste or a borderline case.\nRule: ${r.text.slice(0, 800)}`,
    );
  });
  const caption = doc.caption?.text.trim();
  const pinned = doc.pinned?.text.trim();
  if (caption) {
    questions.captionQuestion = noul(
      `Post description: "${caption.slice(0, 1500)}"\nIs this text asking the audience a question they are meant to answer — even if it has no question mark?`,
    );
  }
  if (pinned) {
    questions.pinnedQuestion = noul(
      `Pinned comment: "${pinned.slice(0, 800)}"\nIs this text asking the audience a question they are meant to answer — even if it has no question mark?`,
    );
  }
  if (!Object.keys(questions).length) return [];
  const answers = await ask(key, { draft: draftText(doc) }, questions, signal);
  const flags: RuleFlag[] = [];
  active.forEach((r, i) => {
    const p = yes(answers[`rule${i}`]);
    if (p >= FLAG_MIN) flags.push({ id: r.id, name: r.name, p });
  });
  const cq = yes(answers.captionQuestion);
  if (cq >= FLAG_MIN) flags.push({ id: "question-caption", name: "The description asks a question", p: cq });
  const pq = yes(answers.pinnedQuestion);
  if (pq >= FLAG_MIN) flags.push({ id: "question-pinned", name: "The pinned comment asks a question", p: pq });
  return flags.sort((a, b) => b.p - a.p);
}
