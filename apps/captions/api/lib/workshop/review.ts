import type { Document } from "./types";

/**
 * "Read as a follower": a button, not a pass. A second
 * model (Claude Fable on the Mac) reads the piece the way one of the account's
 * followers would, with little context on purpose: the piece as posted, who
 * the followers are, and the account's posts people saved and sent most. Not
 * the session, the sources, the angle talk or any rules, so nothing anchors
 * it. Its read lands in the chat, where the writer sees it next turn.
 */

export const REVIEW_MODEL = "claude-fable-5-1";

export interface ReviewPost {
  date: string;
  views: number;
  keptPer1k: number;
  text: string;
}

const KIND_WORD: Partial<Record<Document["kind"], string>> = { reel: "reel", carousel: "carousel", ad: "ad" };

/** The piece the way it reaches a phone: slides (or the script), nothing else. */
export function pieceAsPosted(doc: Document): string {
  if (doc.kind === "carousel") return doc.blocks.map((b, i) => `Slide ${i + 1}\n${b.text.trim()}`).join("\n\n");
  if (doc.kind === "reel") {
    const hooks = (doc.hooks ?? []).map((h, i) => `Opening ${i + 1}: ${h.text.trim()}`).join("\n");
    return [hooks, doc.blocks.map((b) => b.text.trim()).join("\n\n")].filter(Boolean).join("\n\n");
  }
  return doc.blocks.map((b) => b.text.trim()).join("\n\n");
}

/** Who the followers are: the project's audience field, else the "Audience:" paragraph of its instructions. */
export function audienceOf(p: { audience?: string; notes?: string } | null | undefined): string {
  if (p?.audience?.trim()) return p.audience.trim();
  const line = /^Audience:\s*(.+)$/im.exec(p?.notes ?? "");
  return line?.[1]?.trim() ?? "";
}

export function buildReviewPrompt(input: { doc: Document; handle?: string; audience: string; best: ReviewPost[]; packText?: string }): { system: string; user: string } {
  const kind = KIND_WORD[input.doc.kind] ?? "post";
  const who = input.audience ? `You're one of the people this account posts for: ${input.audience}` : "You're one of the people this account posts for.";
  const base = `${who} You follow ${input.handle ? `@${input.handle}` : "this account"}. A new ${kind} from them just came up in your feed. Read it the way you would on your phone${kind === "carousel" ? ", one slide at a time" : ""}, and be honest about how it lands.

Then tell the author, briefly and plainly:
- Where you'd stop ${kind === "reel" ? "watching" : "swiping"}, and the line that lost you. If you'd get to the end, say so and why.${kind === "carousel" ? "\n- Instagram shows a carousel a second time opening on slide 2. Would slide 1 stop your thumb? Would slide 2, seen first?" : ""}
- What you took away, in one sentence, in your own words. If you can't, say that.
- Would you save it, or send it to someone? Who, and why or why not.
- Lines that sounded like a brand or a machine instead of a person, quoted.
- What you expected and didn't get.

You're a reader, not an editor: don't rewrite the piece. Under 250 words, plain text, short labels at most.`;
  const best = input.best.length
    ? `How this account sounds when it works: the posts people saved and sent the most (saves + shares per 1,000 views), with what was said in them.\n\n${input.best
        .map((p) => `[${p.date} · ${p.views.toLocaleString("en-US")} views · ${p.keptPer1k.toFixed(1)} per 1,000]\n${p.text.trim().slice(0, 1500)}`)
        .join("\n\n")}`
    : "";
  const system = input.packText ? `${base}\n\n${input.packText}` : base;
  return { system, user: [`The new ${kind}:\n\n${pieceAsPosted(input.doc)}`, best].filter(Boolean).join("\n\n---\n\n") };
}
