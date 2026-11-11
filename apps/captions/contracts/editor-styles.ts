import type { EditStepChoice } from "./editor-steps";

/**
 * Editing styles: a named, saved set of New edit's choices plus a short note in the person's own words. One is made
 * on the AI Editor's Editing styles tab or saved from an edit, and picked on New edit. An edit keeps its own copy of
 * what it was made with (Edit.style), so a later change to the style never changes an edit.
 *
 * Routes (api/editor/routes.ts, inside /api/editor):
 *   GET    /api/editor/styles          → EditingStylesView
 *   POST   /api/editor/styles          EditingStyleInput, or { fromEdit: <edit id>, name } → EditingStyle
 *   PUT    /api/editor/styles/:id      EditingStyleInput (the fields sent change) → EditingStyle
 *   DELETE /api/editor/styles/:id      → { ok: true }
 * POST /api/editor and PATCH /api/editor/:id take `style`: a style's id, or null for none.
 */

/** How many editing styles one account keeps. */
export const MAX_EDITING_STYLES = 40;
export const STYLE_NAME_MAX = 60;
/** The notes are the only part of a style an AI reads (the script step), so this is the most a style adds to a prompt. */
export const STYLE_NOTES_MAX = 2000;

/** How pauses are cut: `tight` is the editor's own cut, `natural` leaves short pauses in and more air around a line. */
export const PACES = ["tight", "natural"] as const;
export type Pace = (typeof PACES)[number];
export const PACE_NAME: Record<Pace, string> = { tight: "Tight", natural: "Natural" };

/** The punch-in on every other shot: the scale it is zoomed to. */
export const PUNCHES = [
  { value: 1, name: "None" },
  { value: 1.15, name: "Light" },
  { value: 1.3, name: "Strong" },
] as const;

export interface EditingStyle {
  id: string;
  name: string;
  /** how it should be cut, in the person's own words */
  notes: string;
  /** 1-5 */
  versions: number;
  /** target length in seconds, 0 = none */
  targetS: number;
  pace: Pace;
  /** one of PUNCHES' values */
  punch: number;
  /** a grade item's id (EditorDefaults.items.grade); null = the account's default when the edit is made */
  grade: string | null;
  /** a Media Library folder to take B-roll from, or none */
  brollCollectionId: string | null;
  /** the post-processing steps and their values, as an edit keeps them; null = the ones Settings → AI Editor has in use when the edit is made */
  steps: EditStepChoice[] | null;
  createdAt: number;
  updatedAt: number;
}

/** What a style is made or changed with: any of its own fields. */
export type EditingStyleInput = Partial<Omit<EditingStyle, "id" | "createdAt" | "updatedAt">>;

export interface EditingStylesView {
  styles: EditingStyle[];
  /** the style the last new edit was made with, if it is still there */
  last: string | null;
}

/** The copy an edit keeps of the style it was made with: what later steps read (the notes: the script; the pace: the cut). */
export interface EditStyleCopy {
  id: string;
  name: string;
  notes: string;
  pace: Pace;
}
