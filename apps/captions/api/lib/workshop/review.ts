import type { Document, Persona } from "./types";

/**
 * "Read as a follower": a button, not a pass. A second
 * model (Claude Fable on the Mac) reads the piece the way one of the account's
 * followers would, with little context on purpose: the piece as posted, who
 * the followers are, and the account's posts people saved and sent most. Not
 * the session, the sources, the angle talk or any rules, so nothing anchors
 * it. Each of the workspace's personas reads it on its own; the reads land in
 * the chat as one message, where the writer sees them next turn.
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

export const MAX_PERSONAS = 4;
const PERSONA_NAME = 60;
const PERSONA_ABOUT = 800;

/** The personas as saved or drafted: a name and a paragraph each, empty ones dropped, at most MAX_PERSONAS. */
export function parsePersonas(raw: unknown): Persona[] {
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  return (Array.isArray(raw) ? raw : [])
    .map((p: { name?: unknown; about?: unknown } | null) => ({ name: str(p?.name, PERSONA_NAME), about: str(p?.about, PERSONA_ABOUT) }))
    .filter((p) => p.name && p.about)
    .slice(0, MAX_PERSONAS);
}

export const PERSONAS_SYSTEM = `A creator wants their drafts read by the people they make them for, before posting. From what you're given about the workspace (its instructions, the account, its posts), write ${MAX_PERSONAS - 1} to ${MAX_PERSONAS} personas of the people who actually watch it.

- Each is one real kind of viewer, different from the others in what they want and how much they already know or trust the account. One is someone who doesn't follow the account yet and sees it come up among strangers' posts.
- "name": a short label a person would say, like "New parent, follows for tips" (no first names).
- "about": one paragraph in the second person ("You…"): who you are, your situation, what you scroll for, what makes you stop, save or send, what makes you swipe away, and whether you follow the account.
- Only what the material supports; where it says little, keep the persona plain rather than invent detail.

Answer with JSON only: {"personas":[{"name":"…","about":"…"}]}`;

/** The AI's answer: the JSON object (or a bare array) anywhere in the text. */
export function parsePersonaDraft(text: string): Persona[] {
  const at = text.search(/[[{]/);
  let raw: unknown = null;
  try {
    raw = JSON.parse(text.slice(at, Math.max(text.lastIndexOf("}"), text.lastIndexOf("]")) + 1));
  } catch {
    throw new Error("Could not read the drafted personas");
  }
  const list = parsePersonas(Array.isArray(raw) ? raw : (raw as { personas?: unknown } | null)?.personas);
  if (!list.length) throw new Error("Could not read the drafted personas");
  return list;
}

export function buildReviewPrompt(input: { doc: Document; handle?: string; persona: Persona; best: ReviewPost[]; packText?: string }): { system: string; user: string } {
  const kind = KIND_WORD[input.doc.kind] ?? "post";
  const base = `You're one of the people ${input.handle ? `@${input.handle}` : "this account"} posts for: ${input.persona.name}. ${input.persona.about} A new ${kind} from them just came up in your feed. Read it the way you would on your phone${kind === "carousel" ? ", one slide at a time" : ""}, and be honest about how it lands.

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
