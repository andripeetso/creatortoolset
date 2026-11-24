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
const PERSONA_BASIS = 300;

/** The personas as saved or drafted: a name and a paragraph each (and what it rests on), empty ones dropped, at most MAX_PERSONAS. */
export function parsePersonas(raw: unknown): Persona[] {
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  return (Array.isArray(raw) ? raw : [])
    .map((p: { name?: unknown; about?: unknown; basis?: unknown } | null) => {
      const basis = str(p?.basis, PERSONA_BASIS);
      return { name: str(p?.name, PERSONA_NAME), about: str(p?.about, PERSONA_ABOUT), ...(basis ? { basis } : {}) };
    })
    .filter((p) => p.name && p.about)
    .slice(0, MAX_PERSONAS);
}

type Split = Array<{ label: string; value: number }>;

/** The account's audience numbers from its Meta sign-in, as shares: who actually watches. "" with none. */
export function renderAudienceNumbers(s: { ages?: Split; genders?: Split; countries?: Split; viewsByFollower?: Split } | undefined): string {
  const line = (name: string, rows: Split | undefined, n: number) => {
    const total = rows?.reduce((t, r) => t + r.value, 0) ?? 0;
    if (!rows?.length || !total) return "";
    return `${name}: ${[...rows].sort((a, b) => b.value - a.value).slice(0, n).map((r) => `${r.label} ${Math.round((r.value * 100) / total)}%`).join(", ")}`;
  };
  const lines = [line("Ages", s?.ages, 6), line("Genders", s?.genders, 3), line("Countries", s?.countries, 6), line("Views, last 30 days", s?.viewsByFollower, 2)].filter(Boolean);
  return lines.length ? `Who watches (the account's audience numbers):\n${lines.join("\n")}` : "";
}

/** What viewers wrote under the account's posts, the account's own replies left out, most-liked first: the audience in its own words. */
export function renderAudienceComments(byPost: Array<{ post: string; comments: Array<{ text: string; user: { username: string }; likeCount: number }> }>, handle: string, perPost = 20): { text: string; count: number } {
  let count = 0;
  const blocks = byPost
    .map(({ post, comments }) => {
      const theirs = comments
        .filter((c) => c.user.username.toLowerCase() !== handle.toLowerCase() && c.text.trim())
        .sort((a, b) => b.likeCount - a.likeCount)
        .slice(0, perPost);
      count += theirs.length;
      return theirs.length ? `Under "${post.replace(/\s+/g, " ").slice(0, 120)}":\n${theirs.map((c) => `- ${c.text.replace(/\s+/g, " ").slice(0, 240)}`).join("\n")}` : "";
    })
    .filter(Boolean);
  return { text: blocks.length ? `What viewers wrote under its most-viewed posts:\n\n${blocks.join("\n\n")}` : "", count };
}

export const PERSONAS_SYSTEM = `A creator wants each draft read, before posting, by the people who actually watch their account. From the material on the workspace, write ${MAX_PERSONAS - 1} to ${MAX_PERSONAS} personas of those people.

Weigh the evidence in this order, and say which you used:
1. The audience numbers (ages, countries, followers against non-followers): who is really there, in what share.
2. The comments: the viewers' own words. What they ask, struggle with, praise, tag others for, and the words they use.
3. The posts: which got the most views, and which were saved and shared most, tell what each kind of viewer comes for.
4. The account's bio, the workspace's instructions, its files and what the creator wrote: what it offers and who it means to reach. Where the creator says who watches, that corrects the data; where they only say who they want, keep the personas to who is there.

- Split by what people want and how much they already know and trust the account, not by age alone. Bigger groups first.
- One persona is someone who doesn't follow the account yet, seeing it among strangers' posts; base them on the non-follower share where there is one.
- "name": a short label a person would say, like "New parent, follows for tips" (no first names).
- "about": one paragraph in the second person ("You…"): your situation, what you scroll for, what you already know, what makes you stop, save or send, what makes you swipe away, and whether you follow the account. Use words the comments use.
- "basis": one line on the evidence behind it ("Ages 25–34 are 41%; comments ask about sleep"). Where the material says little, say so and keep the persona plain rather than invent detail.

Answer with JSON only: {"personas":[{"name":"…","about":"…","basis":"…"}]}`;

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
