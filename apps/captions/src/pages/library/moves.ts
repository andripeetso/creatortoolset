import type { AssetCard, Collection } from "@contracts/library";

/**
 * What a move does to the cards on screen before the server answers (LibraryPage.tsx): the cards that leave the view are
 * taken out with where each was, so Undo (or a failed request) puts them back in their places at once.
 */

/** what a clip carries when it is dragged onto a folder or a tab: the ids, joined by "," */
export const DRAG = "application/x-ct-media-item";

export type Taken ={ card: AssetCard; at: number }[];

/** `ids` out of `all`: what is left, and what was taken with each one's place. */
export function takeOut(all: readonly AssetCard[], ids: readonly string[]): { rest: AssetCard[]; taken: Taken } {
  const out = new Set(ids);
  const taken: Taken = [];
  const rest: AssetCard[] = [];
  all.forEach((card, at) => (out.has(card.id) ? taken.push({ card, at }) : rest.push(card)));
  return { rest, taken };
}

/** The taken cards back in their places (a card already there again stays once). */
export function putBack(all: readonly AssetCard[], taken: Taken): AssetCard[] {
  const out = [...all];
  for (const { card, at } of taken) if (!out.some((x) => x.id === card.id)) out.splice(Math.min(at, out.length), 0, card);
  return out;
}

export type Roll = "a" | "b";
export const ROLL_LABEL: Record<Roll, string> = { a: "A-roll", b: "B-roll" };

/** The roll a saved search lists when it is a roll and nothing else (the A-roll and B-roll folders, api/library/roll.ts). */
export function rollOfFolder(c: Collection | undefined): Roll | null {
  const q = c?.kind === "smart" ? c.query : undefined;
  return q && Object.keys(q).length === 1 && (q.roll === "a" || q.roll === "b") ? q.roll : null;
}

/** A clip the server files as A-roll or B-roll: a video that is not finished work (roll.ts fileRoll). */
export const takesRoll = (a: AssetCard) => a.kind === "video" && !a.finished && !a.review;
