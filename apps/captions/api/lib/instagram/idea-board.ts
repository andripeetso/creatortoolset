/**
 * A library idea board: a short list of strong remakeable piles, not one
 * folder per post. Regenerated as the library grows.
 */

export const MAX_LIBRARY_IDEAS = 10;

export interface LibraryIdea {
  id: string;
  title: string;
  description: string;
  postIds: string[];
}

export interface IdeaBoard {
  generatedAt: number;
  ideas: LibraryIdea[];
  /** Made by Claude on the paired Mac: its measured tokens and API-equivalent cost. */
  usage?: { tokens: number; costUsd: number };
}

export const IDEA_BOARD_SYSTEM = `You pick the strongest remakeable ideas from a private Instagram research library. Return JSON only:
{"ideas":[{"title":"Watering routines for seedlings","description":"Keep a fixed watering schedule through the first month. Root health and later growth are the same subject.","postIds":["uuid-1","uuid-2"]}]}

Rules:
- At most ${MAX_LIBRARY_IDEAS} ideas. Fewer is better. A handful of strong piles beats a long list of weak ones.
- title: 2–6 words, Title Case, the one-liner for the pile.
- description: one or two sentences. What the idea is — not a recap of each post.
- postIds: catalog ids that belong in that pile. Each id in at most one idea. Leave a post out if it does not earn a place.
- Same subject is one idea even when the claims differ (a fixed bedtime early on → sleep trouble vs mood).
- Do not invent ids. Only use ids from the catalog.

If the user message includes a current board, evolve it: keep a pile that still holds, merge piles that are the same subject, drop weak ones, add a new idea only when a new subject earned it.`;

export type IdeaCatalogRow = {
  id: string;
  kind: string;
  handle: string;
  ideaTitle?: string;
  ideaTakeaway?: string;
  hook?: string;
  caption?: string;
};

/** Posts already attached to a workshop session — not candidates for a new remake. */
export function workshopPostIds(sessions: Array<{ postIds: string[] }>): Set<string> {
  const ids = new Set<string>();
  for (const s of sessions) for (const id of s.postIds) ids.add(id);
  return ids;
}

export function omitWorkshopPosts<T extends { id: string }>(rows: T[], taken: Set<string>): T[] {
  return taken.size ? rows.filter((r) => !taken.has(r.id)) : rows;
}

export function omitWorkshopPiles<T extends { postIds: string[] }>(piles: T[], taken: Set<string>): T[] {
  if (!taken.size) return piles;
  return piles
    .map((p) => ({ ...p, postIds: p.postIds.filter((id) => !taken.has(id)) }))
    .filter((p) => p.postIds.length);
}

export function ideaBoardUserMessage(
  catalog: IdeaCatalogRow[],
  previous?: Array<{ title: string; description: string; postIds: string[] }>,
): string {
  const lines = catalog.map((p) => {
    const claim = p.ideaTitle
      ? `${p.ideaTitle} — ${p.ideaTakeaway ?? ""}`
      : p.hook || (p.caption ?? "").slice(0, 140);
    return `[${p.id}] ${p.kind} @${p.handle}\n${claim}`.trim();
  });
  const parts = [`Catalog:\n${lines.join("\n\n")}`];
  if (previous?.length) {
    parts.push(
      `Current board (evolve this — still at most ${MAX_LIBRARY_IDEAS}):\n${previous
        .map((i) => `- ${i.title}: ${i.description} (${i.postIds.join(", ")})`)
        .join("\n")}`,
    );
  }
  return parts.join("\n\n");
}

export function parseIdeaBoard(text: string, allowedIds: string[]): Omit<LibraryIdea, "id">[] {
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON in the answer");
  const obj = JSON.parse(stripped.slice(start, end + 1)) as { ideas?: unknown };
  if (!Array.isArray(obj.ideas)) throw new Error("the model returned no ideas");
  const allowed = new Set(allowedIds);
  const used = new Set<string>();
  const out: Omit<LibraryIdea, "id">[] = [];
  for (const raw of obj.ideas) {
    if (out.length >= MAX_LIBRARY_IDEAS) break;
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as { title?: unknown; description?: unknown; postIds?: unknown };
    const title = cleanTitle(typeof rec.title === "string" ? rec.title : "");
    const description = cleanDescription(typeof rec.description === "string" ? rec.description : "");
    if (!title || !description) continue;
    const postIds = (Array.isArray(rec.postIds) ? rec.postIds : [])
      .filter((id): id is string => typeof id === "string" && allowed.has(id) && !used.has(id));
    for (const id of postIds) used.add(id);
    if (!postIds.length) continue;
    out.push({ title, description, postIds });
  }
  if (!out.length) throw new Error("the model returned no usable ideas");
  return out;
}

function cleanTitle(s: string): string {
  const t = s.replace(/\s+/g, " ").replace(/^["'#]+|["']+$/g, "").trim().slice(0, 60);
  const words = t.split(" ").filter(Boolean);
  if (words.length < 2 || t.length < 8) return "";
  return words
    .map((w) => (w === w.toUpperCase() && w.length > 3 ? w.charAt(0) + w.slice(1).toLowerCase() : w))
    .join(" ");
}

function cleanDescription(s: string): string {
  const t = s.replace(/\s+/g, " ").replace(/^["']+|["']+$/g, "").trim().slice(0, 280);
  if (t.length < 12) return "";
  return t;
}
