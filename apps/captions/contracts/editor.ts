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
 *   PUT    /api/editor/:id/eyeline/:versionId  { y: 0..1 } (the creator) → Edit
 *   GET    /api/editor/:id/drafts/:name    → Draft
 *   GET    /api/editor/:id/drafts/:name/export?format=otio|fcpxml|zip   the draft for the user's own editor (a download)
 *   POST   /api/editor/:id/drafts/:name/review   renders the draft's preview again and files it in Review (the creator) → Edit
 *   GET    /api/editor/:id/sentences       → Sentence[] (what analyze found, for playing a take)
 *   PUT    /api/editor/:id/lines           PlansPatch (the creator): takes swapped or lines reordered → Edit; redrafts what changed
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
  /** per source version: the speaker's eye line, a fraction of the picture's height from the top (punch-ins keep it in place) */
  eyeline: Record<string, number>;
  /** the versions with a draft timeline, by name */
  drafts: string[];
  jobs: EditJob[];
  /** how many sentences analyze found */
  sentences: number;
  lines: Line[];
  plans: VersionPlan[];
  /** what a step skipped or could not do (a source with no sound, a take out of range…) */
  notes: string[];
  /** each draft's preview as filed in Review: /review/<assetId>?v=<n> */
  previews: Record<string, ReviewPreview>;
}

/** A preview video in Review: its asset and version number. */
export interface ReviewPreview {
  assetId: string;
  n: number;
}

/** PUT lines: the versions that change, each with its whole line order and the take each line uses (by first/last). */
export interface PlansPatch {
  plans: { name: string; lines: { line: string; take: Pick<Take, "first" | "last"> }[] }[];
}

/** The eye line when the user has not set one: a little above the middle, where a speaker's eyes usually are. */
export const DEFAULT_EYELINE = 0.38;

export const TRACKS = ["V1", "V2", "A1", "A2", "A3"] as const;
export type TrackId = (typeof TRACKS)[number];

/**
 * One clip on a track. `rec` and `len` are timeline frames; `in` is the first frame used, in the source's own frames
 * counted from its first frame (its start timecode not included).
 */
export interface Item {
  /** the source's key in Timeline.sources (its library version id) */
  src: string;
  in: number;
  len: number;
  rec: number;
  /** scale, 1 = the source fitted into the frame */
  zoom?: number;
  /** timeline pixels the picture moves up (negative: down) */
  tilt?: number;
  gainDb?: number;
  /** items that share it move together (a speaker shot and its voice) */
  link?: string;
}

export interface TimelineSource {
  versionId: string;
  /** file name without extension, as the library shows it */
  name: string;
  fps: number;
  /** start timecode, in the source's frames */
  tc: number;
  /** length in the source's frames */
  dur: number;
  /** picture size as shown (rotation applied); 0 for sound only */
  w: number;
  h: number;
}

/** A draft: one version's cut, the single model every export and check reads. */
export interface Timeline {
  name: string;
  fps: number;
  width: number;
  height: number;
  sources: Record<string, TimelineSource>;
  /** V1 speaker, V2 B-roll, A1 voice, A2 music, A3 sound effects */
  tracks: Record<TrackId, { name: string; items: Item[] }>;
  /** one per script line, at the line's first frame; colour is an OTIO marker colour (RED, BLUE, …) */
  markers: { rec: number; name: string; color: string; note: string }[];
}

/** What the checks found on a draft; failures are notes, never a block. */
export interface QaReport {
  ok: boolean;
  notes: string[];
  /** voice this version shares with each other version: share of this version's voice frames, longest shared run */
  shared: { with: string; pct: number; longestS: number }[];
}

export interface Draft {
  timeline: Timeline;
  /** what the cut skipped (a take with no speech found…) */
  notes: string[];
  qa: QaReport;
}
