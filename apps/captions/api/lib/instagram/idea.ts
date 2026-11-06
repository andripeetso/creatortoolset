import { ask, choice } from "../jev";
import type { PostIdea } from "./types";

export const IDEA_SYSTEM = `You file one Instagram post into a private research library. Return JSON only:
{"title":"Bedtime routines for toddlers","takeaway":"A fixed bedtime in the first 1,000 days cuts later sleep trouble."}

This is filing, not naming in isolation. The library already has folders. Your job is to put this post in the right pile.

title: 2–6 words, Title Case. The folder this post belongs in — not the hook, not this post's statistic.
If the user message lists existing folders, and this post is the same TOPIC as one of them, copy that folder's title exactly. Same topic = one remakeable pile. Different claims still count as the same topic when the subject is the same (sleep trouble vs mood is still "a fixed bedtime in the first 1,000 days"). Only invent a new title when the subject is actually new.
takeaway: one sentence, the specific claim THIS post makes. No hashtags.

Examples:
- On-screen "Why Some Kids Stay Short?" about early growth → {"title":"Raising tall kids","takeaway":"Most adult height is decided early; missed growth windows stay short."}
- A reel that kids who swam before five later read earlier → {"title":"Swimming for kids","takeaway":"Kids who swam before five were about 11 months ahead in reading."}
- Carousel "children don't become geniuses because of books" → {"title":"Raising geniuses","takeaway":"Genius comes from a handful of parental habits, not more books."}
- Study: a fixed bedtime in the first 1,000 days cuts later sleep trouble → {"title":"Bedtime routines for toddlers","takeaway":"A fixed bedtime in the first 1,000 days cuts the risk of up to 30 later sleep problems."}
- Limit screens before age two for later sleep, and the library already has "Bedtime routines for toddlers" → {"title":"Bedtime routines for toddlers","takeaway":"Keeping screens low before age two supports better sleep for years."}`;

export type IdeaFolder = { title: string; takeaway: string };

function foldTitle(s: string): string {
  return s.toLowerCase().replace(/['’]/g, "").replace(/\s+/g, " ").trim();
}

export function reuseExistingTitle(title: string, existing: string[]): string {
  const key = foldTitle(title);
  return existing.find((t) => foldTitle(t) === key) ?? title;
}

export function ideaUserMessage(postText: string, folders: IdeaFolder[]): string {
  if (!folders.length) return postText;
  const list = folders
    .slice(0, 100)
    .map((f) => `- ${f.title} — ${f.takeaway}`)
    .join("\n");
  return `${postText}\n\nExisting library folders. If this post is the same topic as one of these, set title to that folder's name exactly. Same topic means one remakeable pile — a different statistic or angle still belongs there.\n${list}`;
}

export function parseIdeaPayload(text: string, existingTitles: string[] = []): PostIdea {
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON in the answer");
  const obj = JSON.parse(stripped.slice(start, end + 1)) as { title?: unknown; folder?: unknown; takeaway?: unknown };
  const idea = coercePostIdea(obj, existingTitles);
  if (!idea) throw new Error("the model returned no usable idea");
  return idea;
}

export function coercePostIdea(raw: unknown, existingTitles: string[] = []): PostIdea | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as { title?: unknown; folder?: unknown; takeaway?: unknown };
  const named = typeof rec.folder === "string" && rec.folder.trim() ? rec.folder : typeof rec.title === "string" ? rec.title : "";
  const title = cleanTitle(named);
  const takeaway = cleanTakeaway(typeof rec.takeaway === "string" ? rec.takeaway : "");
  if (!title || !takeaway) return null;
  return { title: reuseExistingTitle(title, existingTitles), takeaway };
}

function cleanTitle(s: string): string {
  const t = s.replace(/\s+/g, " ").replace(/^["'#]+|["']+$/g, "").trim().slice(0, 60);
  const words = t.split(" ").filter(Boolean);
  if (words.length < 2 || t.length < 8) return "";
  return words
    .map((w) => (w === w.toUpperCase() && w.length > 3 ? w.charAt(0) + w.slice(1).toLowerCase() : w))
    .join(" ");
}

function cleanTakeaway(s: string): string {
  const t = s.replace(/\s+/g, " ").replace(/^["']+|["']+$/g, "").trim().slice(0, 180);
  if (t.length < 12) return "";
  return t;
}

/** Jev picks an existing folder from this confidence up. */
export const FOLDER_MIN_CONFIDENCE = 0.6;
/** Most recent folders offered to Jev (a choice list, not a prompt). */
const MAX_FOLDER_CHOICES = 80;
const NEW_TOPIC = "new topic";

/**
 * Same topic as a folder that already exists? The writer names folders
 * well but only reuses one on an exact title match, so "Bedtime routines for
 * toddlers" and "Naps before age two" became two piles. Jev picks the
 * existing folder (or "new topic"); returns its title, or null to keep
 * the writer's.
 */
export async function existingFolderFor(
  postText: string,
  idea: PostIdea,
  folders: IdeaFolder[],
  signal?: AbortSignal,
): Promise<string | null> {
  const offered = folders.slice(0, MAX_FOLDER_CHOICES);
  if (!offered.length) return null;
  const criteria: Record<string, string> = {};
  for (const f of offered) criteria[f.title] = f.takeaway || f.title;
  criteria[NEW_TOPIC] = "None of these: a topic the library doesn't have yet.";
  const answers = await ask(
    {
      post: postText.slice(0, 3000),
      proposed_folder: `${idea.title} — ${idea.takeaway}`,
    },
    {
      folder: choice(
        "Which existing library folder is this post the same remakeable topic as? The topic is the requirement: a different statistic, example or angle on the same topic still belongs there. Pick \"new topic\" only when none of them is the same topic.",
        criteria,
      ),
    },
    signal,
  );
  const picked = answers.folder;
  if (!picked?.choice || picked.choice === NEW_TOPIC) return null;
  if ((picked.confidence ?? 0) < FOLDER_MIN_CONFIDENCE) return null;
  return offered.some((f) => f.title === picked.choice) ? picked.choice : null;
}
