import type { IdeaStatus, PostCounts, SavedFor } from "./types";

export const IDEA_STATUSES: IdeaStatus[] = ["inbox", "idea", "done", "skip"];

export const IDEA_STATUS_LABEL: Record<IdeaStatus, string> = {
  inbox: "Inbox",
  idea: "In Project",
  done: "Done",
  skip: "Skip",
};

export function parseIdeaStatus(raw: unknown): IdeaStatus | undefined {
  return IDEA_STATUSES.includes(raw as IdeaStatus) ? (raw as IdeaStatus) : undefined;
}

export function parseRank(raw: unknown): number | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return undefined;
  const r = Math.round(n);
  if (r < 1 || r > 10) return undefined;
  return r;
}

export function ideaStatusOf(status: IdeaStatus | undefined): IdeaStatus {
  return status ?? "inbox";
}

export const SAVED_FOR: SavedFor[] = ["content", "format"];

/** Unmarked posts are content. Format is only on when someone set it. */
export function effectiveSavedFor(savedFor: SavedFor[] | undefined): SavedFor[] {
  if (!savedFor?.length) return ["content"];
  return SAVED_FOR.filter((k) => savedFor.includes(k));
}

export function matchesSavedFor(savedFor: SavedFor[] | undefined, want: SavedFor): boolean {
  return effectiveSavedFor(savedFor).includes(want);
}

/**
 * `[]` clears the mark. `undefined` means the value was not a saved-for
 * list (caller should 400). `"both"` is content + format.
 */
export function parseSavedFor(raw: unknown): SavedFor[] | undefined {
  if (raw === null || raw === "") return [];
  if (raw === "both") return ["content", "format"];
  if (raw === "content" || raw === "format") return [raw];
  if (!Array.isArray(raw)) return undefined;
  const out: SavedFor[] = [];
  for (const item of raw) {
    if ((item === "content" || item === "format") && !out.includes(item)) out.push(item);
  }
  if (raw.length > 0 && !out.length) return undefined;
  return SAVED_FOR.filter((k) => out.includes(k));
}

/**
 * Which posts a list shows. Know-how posts (strategy, reference, other) are
 * saved but never indexed: they stay off every research surface unless a
 * list asks for them.
 */
export type Shelf = "library" | "knowhow" | "all";

export function parseShelf(raw: unknown): Shelf {
  return raw === "knowhow" || raw === "all" ? raw : "library";
}

export function onShelf(meta: { knowhow?: boolean }, shelf: Shelf): boolean {
  if (shelf === "all") return true;
  return (meta.knowhow === true) === (shelf === "knowhow");
}

/** Why a post is kept, as chosen when saving it: content / format, or Know-how. */
export interface KeepChoice {
  savedFor?: SavedFor[];
  knowhow?: boolean;
}

/** `savedFor` / `knowhow` from a request body; `undefined` when either is invalid. */
export function parseKeep(
  body: { savedFor?: unknown; knowhow?: unknown } | null | undefined,
): KeepChoice | undefined {
  const out: KeepChoice = {};
  if (body?.savedFor !== undefined) {
    const savedFor = parseSavedFor(body.savedFor);
    if (savedFor === undefined) return undefined;
    out.savedFor = savedFor;
  }
  if (body?.knowhow !== undefined) {
    if (typeof body.knowhow !== "boolean") return undefined;
    out.knowhow = body.knowhow;
  }
  return out;
}

/**
 * Know-how moves a post off the research shelf; choosing content or format
 * brings it back. True when anything changed.
 */
export function applyKeep(meta: { savedFor?: SavedFor[]; knowhow?: boolean }, keep: KeepChoice): boolean {
  const before = keepLabel(meta);
  if (keep.savedFor) {
    if (keep.savedFor.length) meta.savedFor = keep.savedFor;
    else delete meta.savedFor;
    if (keep.knowhow === undefined) delete meta.knowhow;
  }
  if (keep.knowhow === true) meta.knowhow = true;
  else if (keep.knowhow === false) delete meta.knowhow;
  return keepLabel(meta) !== before;
}

/** "Know-how", "Content", "Format" or "Content and Format". */
export function keepLabel(meta: { savedFor?: SavedFor[]; knowhow?: boolean }): string {
  if (meta.knowhow) return "Know-how";
  return effectiveSavedFor(meta.savedFor)
    .map((k) => (k === "format" ? "Format" : "Content"))
    .join(" and ");
}

/** Mean of set ranks. Unranked posts are ignored. */
export function avgRank(ranks: Array<number | undefined>): number | undefined {
  const nums = ranks.filter((n): n is number => typeof n === "number");
  if (!nums.length) return undefined;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10;
}

/** Plays if present, otherwise likes as a stand-in. */
export function virality(counts: PostCounts | undefined): number {
  if (!counts) return 0;
  if (counts.plays !== undefined) return counts.plays;
  return counts.likes ?? 0;
}

export function avgVirality(counts: Array<PostCounts | undefined>): number {
  if (!counts.length) return 0;
  return Math.round(counts.reduce((n, c) => n + virality(c), 0) / counts.length);
}
