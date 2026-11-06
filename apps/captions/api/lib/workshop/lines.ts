import type { Document } from "./types";
import { jsonObject } from "./plans";

/**
 * "Other ways to say this". The author selects words on a slide; the model returns three
 * versions of just those words, and nothing else on the piece changes.
 */

export interface LinesInput {
  doc: Pick<Document, "kind" | "blocks">;
  blockId?: string;
  /** The slide's current text (it may be unsaved), and the selected range in it. */
  text: string;
  start: number;
  end: number;
  /** What the author has said about this piece, in their words. */
  notes: string[];
}

export function buildLinesPrompt(input: LinesInput): { system: string; user: string } {
  const at = input.doc.blocks.findIndex((b) => b.id === input.blockId);
  const unit = input.doc.kind === "carousel" ? "Slide" : "Part";
  const marked = `${input.text.slice(0, input.start)}«${input.text.slice(input.start, input.end)}»${input.text.slice(input.end)}`;
  const piece = input.doc.blocks
    .map((b, i) => `${unit} ${i + 1}${i === at ? " (the one with the selection)" : ""}\n${i === at ? marked : b.text}`)
    .join("\n\n");
  const system = `The author selected words in one ${unit.toLowerCase()} of their piece, marked «like this». Give three other ways to say just those words, each one fitting where the selection sits, between the text before and after it. Say the concrete thing the way the author talks: the baby or the parent does it, not a position, a seat or a brain, and the actual case, not a summary of it. Keep their meaning. Return exactly {"options": [string, string, string]}: the replacement words only, no quote marks around them.`;
  const notes = input.notes.length ? `\n\nWhat the author has said about this piece:\n${input.notes.map((n) => `- ${n.replace(/\n+/g, " ")}`).join("\n")}` : "";
  return { system, user: `${piece}${notes}` };
}

export function parseLines(text: string): string[] {
  const o = jsonObject(text);
  const list = Array.isArray(o.options) ? o.options : [];
  const out = list.filter((x): x is string => typeof x === "string").map((x) => x.trim().replace(/^[«"“]|[»"”]$/g, "").trim()).filter(Boolean);
  if (!out.length) throw new Error("No options came back");
  return [...new Set(out)].slice(0, 3);
}
