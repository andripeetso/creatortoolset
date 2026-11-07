/**
 * AI Editor: raw takes from the Media Library → draft timelines the user finishes in their own editor.
 *
 * Contract (api/editor/routes.ts, mounted at /api/editor, tool `editor`):
 *   POST   /api/editor                     NewEdit → { id }
 *   GET    /api/editor                     → EditSummary[] (mine; a workspace owner: the workspace's too)
 *   GET    /api/editor/:id                 → Edit
 *   PATCH  /api/editor/:id                 EditPatch (the creator) → Edit
 *   POST   /api/editor/:id/run             { from?: EditStep } (the creator) → Edit
 *   POST   /api/editor/:id/jobs/:jobId/retry  (the creator) → Edit
 *   POST   /api/editor/:id/stop            stops queued and running steps → Edit
 *   DELETE /api/editor/:id                 to the trash (kept LIBRARY_TRASH_DAYS)
 * Every step runs as the edit's creator, on their own keys and AI: a workspace owner sees, stops and deletes, never runs.
 */

export const EDIT_STEPS = ["analyze", "script", "draft", "broll"] as const;
export type EditStep = (typeof EDIT_STEPS)[number];

export const MAX_VERSIONS = 5;

/** What the user says about the video. */
export interface EditBrief {
  name: string;
  brief: string;
  /** optional script text the takes were read from */
  script: string;
  /** how many versions to cut, 1-5 */
  versions: number;
  /** target length in seconds, 0 = none */
  targetS: number;
  /** a library collection to take B-roll from, or none */
  brollCollectionId: string | null;
  /** punch-in zoom on jump cuts */
  framing: { punch: number };
}

export type NewEdit = Partial<EditBrief> & { sources: string[] };
export type EditPatch = Partial<Omit<EditBrief, "framing">>;

export interface EditJob {
  id: number;
  kind: string;
  /** "" for a whole-edit step, else the version's name */
  variant: string;
  state: "queued" | "running" | "done" | "failed" | "needs_key";
  attempts: number;
  /** the failure, or for needs_key what to add */
  error: string | null;
}

export interface EditSummary {
  id: string;
  name: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** library version ids, in the order picked */
  sources: string[];
  /** the latest job's state and kind, if any ran */
  last: Pick<EditJob, "kind" | "state"> | null;
}

/** One spoken sentence of the footage (analyze): numbered from 1 across every source, in recording order. */
export interface Sentence {
  n: number;
  /** the library version it was said in */
  src: string;
  text: string;
  /** seconds in the source */
  s: number;
  e: number;
  /** its first and last word, indexes into the version's transcript words */
  w0: number;
  w1: number;
}

/** One reading of a line: sentences first..last (one source), scored 0-1 by the AI. */
export interface Take {
  first: number;
  last: number;
  score: number;
}

/** One thing the video says, with every take of it the footage has, best first. */
export interface Line {
  id: string;
  text: string;
  takes: Take[];
}

/** One version's cut (script): its lines in order, each with the take handed to it. */
export interface VersionPlan {
  /** "v1".."v5": the draft's file name and job variant */
  name: string;
  /** what the AI called it */
  title: string;
  lines: { line: string; take: Take }[];
}

export interface Edit extends EditSummary, EditBrief {
  workspaceId: string;
  jobs: EditJob[];
  /** the caller may change and run it (the creator) */
  mine: boolean;
  /** how many sentences analyze found */
  sentences: number;
  lines: Line[];
  plans: VersionPlan[];
  /** what a step skipped or could not do (a source with no sound, a take out of range…) */
  notes: string[];
}
