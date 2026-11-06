import type { Document } from "./types";
import type { ReviewPost } from "./review";

/**
 * "Ask about this": a small side chat about one
 * slide or a selection in it. It sees that part, where it sits in the piece and
 * the account's most saved posts as a yardstick, not the session, the sources
 * or the conversation, and it can only answer: there is no way for it to edit.
 */

export interface AsideInput {
  doc: Pick<Document, "kind" | "blocks">;
  blockId?: string;
  /** The slide's current text (maybe unsaved) and, when the author selected words, the range. */
  text: string;
  start?: number;
  end?: number;
  question: string;
  /** This side chat so far. */
  history: Array<{ role: "user" | "assistant"; text: string }>;
  best: ReviewPost[];
}

const MEDIUM: Partial<Record<Document["kind"], string>> = {
  carousel: "an Instagram carousel: designed slides people read on their phone and swipe, not something said out loud",
  reel: "a talking-to-camera reel: words said out loud, with a line or two on screen",
  ad: "paid social ad copy",
};

export function buildAsidePrompt(input: AsideInput): { system: string; user: string } {
  const at = input.doc.blocks.findIndex((b) => b.id === input.blockId);
  const unit = input.doc.kind === "carousel" ? "slide" : "part";
  const where = at >= 0 ? `${unit} ${at + 1} of ${input.doc.blocks.length}` : `one ${unit}`;
  const picked = input.start !== undefined && input.end !== undefined && input.end > input.start;
  const shown = picked ? `${input.text.slice(0, input.start)}«${input.text.slice(input.start, input.end)}»${input.text.slice(input.end)}` : input.text;
  const system = `The author is asking about one part of their piece, ${MEDIUM[input.doc.kind] ?? "a post"}. You see only that part${picked ? " (the words they selected are marked «like this»)" : ""}, where it sits, and the account's most saved posts. Answer what they ask, plainly and briefly, the way you'd tell a friend who makes content. You can't change the piece: if a different line would help, show one or two as examples in your answer. Plain text.`;
  const best = input.best.length
    ? `\n\nThe account's posts people saved and sent the most, how each one opens:\n${input.best
        .map((p) => `- ${p.views.toLocaleString("en-US")} views, ${p.keptPer1k.toFixed(1)} saves+shares per 1,000: ${(p.text.trim().split(/\n/, 1)[0] ?? "").slice(0, 200)}`)
        .join("\n")}`
    : "";
  const chat = input.history.length ? `\n\nSo far in this side chat:\n${input.history.map((m) => `${m.role === "user" ? "Author" : "You"}: ${m.text}`).join("\n")}` : "";
  return { system, user: `${where[0]!.toUpperCase() + where.slice(1)}:\n${shown}${best}${chat}\n\nAuthor now: ${input.question}` };
}
