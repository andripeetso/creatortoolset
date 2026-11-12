import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { EditCards } from "../../../contracts/editor";
import { writeJsonAtomic } from "../../library/media/run";
import { editDir } from "../store";

/**
 * What the card step keeps for one version, beside the edit's drafts:
 *   cards/<variant>.json            this state
 *   cards/<variant>/script.txt      the script the AI wrote. It is text here: nothing on the server and no page of the
 *                                   app runs it. It goes to a Mac through the device contract and runs in its sandbox.
 *   cards/<variant>/<id>.mp4        a card's clip, with <id>.first.png, <id>.middle.png and <id>.last.png
 *   cards/<variant>/draw/…          what a Mac has sent of the draw that is out; taken up when the draw ends
 * Every number here is a cap in code.
 */

/** Cards a version gets at most. */
export const MAX_CARDS = 6;
/** Characters on a card at most. */
export const CARD_TEXT_MAX = 60;
/** The longest script taken from the AI, in characters. A longer answer is refused, never cut. */
export const SCRIPT_MAX = 60_000;
/** A version's cards are sent to be drawn at most this many times: the script as made, its fix when it threw on the Mac, and once more when the look at the stills corrects it. */
export const MAX_DRAWS = 3;
/** AI calls a version's cards take at most: plan, make, fix, look. The fourth only for a version whose script threw and was fixed. */
export const MAX_CALLS = 4;
/** The Mac's words about a script that threw, in characters, that the fix call carries at most. */
export const ERROR_MAX = 500;
/** Notes this step writes start with this. */
export const CARDS_NOTE = "Cards: ";

export const STILLS = ["first", "middle", "last"] as const;

export interface PlannedCard {
  /** c1..c6 */
  id: string;
  text: string;
  /** the take of the line it sits on (its first and last sentence): a script run again gives lines new ids, never new takes */
  first: number;
  last: number;
  /** the words that take speaks */
  line: string;
  /** how long it shows */
  seconds: number;
}

export interface CardsState {
  /** the animation style the cards are made in */
  style: string;
  /** AI calls made so far */
  calls: number;
  /** what the plan call gave; absent until it has run */
  cards?: PlannedCard[];
  /** the size and rate the Mac draws at */
  width?: number;
  height?: number;
  fps?: number;
  /** how many times a Mac was asked to draw */
  draws: number;
  /** a draw is out since then */
  askedAt?: number;
  /** the stills were looked at (or there was no reason to) */
  looked?: boolean;
  /** the Mac's words when the script as made threw on it, until the fix is sent to be drawn */
  threw?: string;
  /** the fix was asked for (once a version) */
  fixed?: boolean;
  /** the cards that have a clip */
  drawn: string[];
  /** the cards whose still the person put in the style's Made & liked */
  liked: string[];
  /** why the version has no cards, or not all of them */
  note?: string;
  /** the cards the cut as it is now has no room for, each with why */
  left?: string[];
  /** nothing more to make: a later cut places what is here, with no AI call */
  done?: boolean;
}

const VARIANT = /^(v[1-9]|m[1-9]\d?)$/; // a draft's name, as store.ts has it
const CARD = /^c[1-9]$/;

/** The folder a version's script and clips are in, relative to the edit's folder (a timeline source's `file` starts with it). */
export const cardsFolder = (variant: string) => `cards/${variant}`;
const stateFile = (editId: string, variant: string) => path.join(editDir(editId), "cards", `${variant}.json`);
export const cardsDir = (editId: string, variant: string) => path.join(editDir(editId), cardsFolder(variant));
export const scriptFile = (editId: string, variant: string) => path.join(cardsDir(editId, variant), "script.txt");
/** A card's clip (`still` absent) or one of its stills; `draw`: of the draw that is out. Null for a name that is no card. */
export function cardFile(editId: string, variant: string, id: string, still?: (typeof STILLS)[number], draw = false): string | null {
  if (!VARIANT.test(variant) || !CARD.test(id)) return null;
  return path.join(cardsDir(editId, variant), draw ? "draw" : "", still ? `${id}.${still}.png` : `${id}.mp4`);
}

export function readCards(editId: string, variant: string): CardsState | null {
  if (!VARIANT.test(variant)) return null;
  try {
    return JSON.parse(readFileSync(stateFile(editId, variant), "utf8")) as CardsState;
  } catch {
    return null;
  }
}

export async function saveCards(editId: string, variant: string, state: CardsState): Promise<void> {
  await mkdir(cardsDir(editId, variant), { recursive: true });
  await writeJsonAtomic(stateFile(editId, variant), state);
}

/** A version's cards go: the state, the script and every clip. */
export async function clearCards(editId: string, variant: string): Promise<void> {
  if (!VARIANT.test(variant)) return;
  await rm(stateFile(editId, variant), { force: true });
  await rm(cardsDir(editId, variant), { recursive: true, force: true });
}

/** A note as the page shows it: under "Cards: ", unless the words (a Mac's own sentence) already start with it. */
const noteOf = (why: string) => (/^Cards\b/.test(why) ? why : `${CARDS_NOTE}${why}`);

/** The edit page's view of each version's cards (Edit.cards); undefined when no version has any state. */
export function cardsView(editId: string, variants: string[]): Record<string, EditCards> | undefined {
  if (!existsSync(path.join(editDir(editId), "cards"))) return undefined;
  const out: Record<string, EditCards> = {};
  for (const v of variants) {
    const st = readCards(editId, v);
    if (!st) continue;
    out[v] = {
      cards: (st.cards ?? []).filter((c) => st.drawn.includes(c.id)).map((c) => ({ id: c.id, text: c.text, liked: st.liked.includes(c.id) })),
      ...(st.note || st.left?.length ? { note: noteOf([st.note, ...(st.left ?? [])].filter(Boolean).join("; ")) } : {}),
    };
  }
  return Object.keys(out).length ? out : undefined;
}
