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
 *   GET    /api/editor/styles/:id/finished            → FinishedEdit[] (newest first)
 *   DELETE /api/editor/styles/:id/finished/:editId    → { ok: true }; that edit is never kept for the style again
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
  /** one of the person's own skills (contracts/skills.ts), by id, for the script step; absent or null = none */
  skill?: string | null;
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
  /** the skill the style named, by id: its text is read when the script step runs; absent = none */
  skill?: string;
}

/**
 * What an editing style learns from: the edits made with it that their maker finished (approved its Review video, or
 * sent it to Finals), each kept as it was then (api/editor/finished.ts). Every word in one is the person's own: the
 * brief they typed and what is spoken in the footage. Nothing here is written, summed up or changed by an AI.
 * The next edit in the style shows its script step the FINISHED_EXAMPLES closest ones. All of it is fixed in size:
 */
/** Finished edits one style keeps, newest first; the oldest goes when one more arrives. */
export const FINISHED_MAX = 20;
/** Finished edits the script step of an edit in the style is shown. */
export const FINISHED_EXAMPLES = 2;
/** Characters one of them takes in that prompt, its labels included. */
export const FINISHED_EXAMPLE_MAX = 1200;
export const FINISHED_BRIEF_MAX = 600;
export const FINISHED_SAID_MAX = 900;
/** Lines planned and taken out that one keeps, and the characters of each. */
export const FINISHED_CUT_LINES = 5;
export const FINISHED_CUT_MAX = 160;

export interface FinishedEdit {
  editId: string;
  /** the version that was finished: "v1".."v5" */
  variant: string;
  /** the edit's name, for the style's list; never part of a prompt. Empty when an AI's tool named the edit */
  name: string;
  at: number;
  /** what the person said the video was, as they typed it; empty when the brief came through an AI's tool */
  brief: string;
  /** the length asked for in seconds, 0 = none */
  targetS: number;
  /** how long the cut came out */
  seconds: number;
  /** the words spoken in the final takes, one line of the cut on each line, in order */
  said: string;
  /** the spoken words of lines the script step planned for this version and the person took out */
  cut: string[];
}
