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

export interface Edit extends EditSummary, EditBrief {
  workspaceId: string;
  jobs: EditJob[];
  /** the caller may change and run it (the creator) */
  mine: boolean;
}
