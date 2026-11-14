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
 *   POST   /api/editor/:id/drafts/:name/cut      { asset, n, edits } (the creator): Review's timeline edits on that version cut into the draft, with no AI → Edit; its next version is made
 *   GET    /api/editor/:id/sentences       → Sentence[] (what analyze found, for playing a take)
 *   PUT    /api/editor/:id/lines           PlansPatch (the creator): takes swapped or lines reordered → Edit; redrafts what changed
 *   DELETE /api/editor/:id                 to the trash (kept LIBRARY_TRASH_DAYS)
 *   GET    /api/editor/defaults            → EditorDefaults (the set a new edit gets, and the items each slot can take)
 *   PUT    /api/editor/defaults/:slot      { id: string | null } (null = back to the built-in one) → EditorDefaults
 *   GET, POST /api/editor/styles, PUT, DELETE /api/editor/styles/:id   the person's editing styles (contracts/editor-styles.ts)
 *   /api/editor/animation-styles…        the person's animation styles and their pictures (contracts/editor-styles.ts)
 *   GET    /api/editor/:id/cards/:variant/:card/still   a card's middle frame, as the Mac drew it (PNG)
 *   POST   /api/editor/:id/cards/:variant/:card/like    its still goes into the animation style's Made & liked → Edit
 *   POST   /api/editor/:id/cards/:variant/again         the version's cards are made again from nothing → Edit
 *   GET    /api/editor/voice               → VoicesView (the voices of the person's ElevenLabs account)
 *   POST   /api/editor/voice               NewVoice → MadeVoice: text spoken by one of them, saved in the Media Library as a take
 * Every step runs as the edit's creator, on their own keys and AI: a workspace owner sees, stops and deletes, never runs.
 *
 * A take with no picture (a voice recording, or a voice made from the script) makes a video with nothing filmed: its
 * whole picture comes from the B-roll folder, or from every clip sorted B-roll when the edit names none (api/editor/broll.ts).
 */

import type { EditStyleCopy, WorkingSize } from "./editor-styles";

export const EDIT_STEPS = ["analyze", "script", "draft", "broll"] as const;
export type EditStep = (typeof EDIT_STEPS)[number];

export const MAX_VERSIONS = 5;
/** The most short videos one long recording is cut into (EditBrief.moments). */
export const MAX_MOMENTS = 20;

/** What the user says about the video. */
export interface EditBrief {
  name: string;
  brief: string;
  /** optional script text the takes were read from */
  script: string;
  /** how many versions to cut, 1-5 */
  versions: number;
  /** target length in seconds, 0 = none (with `moments`: about how long each one is) */
  targetS: number;
  /**
   * Short videos from a long recording: the AI finds up to this many parts that stand on their own (1 to MAX_MOMENTS)
   * and each is cut as a version of its own, named m1, m2, … (api/editor/moments.ts). Absent: an edit as it always was.
   */
  moments?: number;
  /** a library collection to take B-roll from, or none */
  brollCollectionId: string | null;
  /** punch-in zoom on jump cuts */
  framing: { punch: number };
  /** the per-edit flags a plug-in declared (EditFlag), by id: on or off. A new edit records every declared flag. */
  flags: Record<string, boolean>;
  /** the languages spoken in the footage (two-letter codes); they win over the person's Settings → AI → Voice
   *  languages when its takes are transcribed. Missing or empty = the person's. */
  languages?: string[];
}

/** A per-edit flag a plug-in declares (plug-in `editFlags`): a chip on the edit, saved with it. Shows nothing else. */
export interface EditFlag {
  id: string;
  label: string;
  /** the chip's state on a new edit; off when absent */
  default?: boolean;
}

/** What an edit is made with: one item per slot, by id (the built-in ids are in BUILT_IN_BUNDLE). */
export const EDIT_SLOTS = ["designSystem", "grade", "voiceMix", "sfxSet"] as const;
export type EditSlot = (typeof EDIT_SLOTS)[number];
export const EDIT_SLOT_NAME: Record<EditSlot, string> = { designSystem: "Design", grade: "Grade", voiceMix: "Voice mix", sfxSet: "Sound effects" };
export type EditBundle = Record<EditSlot, string>;

/** The set every edit starts with when no default is chosen: plain design, no grade, voice levelled only, no sound effects. */
export const BUILT_IN_BUNDLE: EditBundle = { designSystem: "plain", grade: "none", voiceMix: "level", sfxSet: "none" };

/** One item a slot can use. `from` is the pack it came from, null for the built-in ones. */
export interface EditItem {
  id: string;
  title: string;
  from: string | null;
}

/** The editor defaults of one person: the set a new edit gets (`bundle`), their own choices, and what each slot can take. */
export interface EditorDefaults {
  bundle: EditBundle;
  chosen: Partial<EditBundle>;
  items: Record<EditSlot, EditItem[]>;
}

/** `style`: an editing style's id (its choices go under the ones sent here), or null for none. Left out: none. */
export type NewEdit = Partial<EditBrief> & { sources: string[]; style?: string | null };
export type EditPatch = Partial<Omit<EditBrief, "framing">> & { style?: string | null };

export interface EditJob {
  id: number;
  kind: string;
  /** "" for a whole-edit step, else the version's name */
  variant: string;
  state: "queued" | "running" | "done" | "failed" | "needs_key";
  attempts: number;
  /** the failure, or for needs_key what to add */
  error: string | null;
  /** while it runs: what it is doing now, when the step says (a first-time install, waiting for the person's AI) */
  line?: string;
}

export interface EditSummary {
  id: string;
  name: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** library version ids, in the order picked */
  sources: string[];
  /** clips still uploading from a phone (its New edit); the edit starts by itself when the last is in, and these become `sources` */
  uploads?: { id: string; version?: string }[];
  /** the latest job's state and kind, if any ran; `stopped`: it failed because the person stopped it */
  last: (Pick<EditJob, "kind" | "state"> & { stopped?: true }) | null;
  /** the project it is in (GET /api/editor; one from before edits had a project is the first brand's); absent for a person with no project */
  projectId?: string;
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
  /** the items the edit was made with, recorded when it was created: changing the default later does not change it */
  bundle: EditBundle;
  /** the editing style it was made with, as it was then; absent for an edit made with none */
  style?: EditStyleCopy;
  /** the working size its style named (the timeline's frame); absent or null = the footage's own */
  size?: WorkingSize | null;
  /** per source version: the speaker's eye line, a fraction of the picture's height from the top (punch-ins keep it in place) */
  eyeline: Record<string, number>;
  /** per source version: the eye line found on this computer at analyze, used where `eyeline` has none */
  eyelineFound?: Record<string, number>;
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
  /** the flags the loaded plug-ins declare, shown as chips; `flags` above holds this edit's state for each */
  flagDefs: EditFlag[];
  /** each version's cards, for an edit whose style names an animation style and whose card step has run; else absent */
  cards?: Record<string, EditCards>;
  /** an edit in passes: the next pass Carry on queues (POST /api/editor/:id/pass), and whether it waits for it (nothing queued or running) */
  passes?: { waiting: boolean; next: "broll" | "cards" | null };
}

/** One version's cards as the edit page shows them. */
export interface EditCards {
  /** the cards with a clip, in the order planned */
  cards: { id: string; text: string; liked: boolean }[];
  /** why there are none, or fewer than planned ("Cards: no Mac with Creator Toolset is on") */
  note?: string;
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

/** The eye line when the user has set none and none was found: a little above the middle, where a speaker's eyes usually are. */
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
  /** a clip that is the edit's own file and not footage from the library (a card): its path inside the edit's folder */
  file?: string;
}

/** A draft: one version's cut, the single model every export and check reads. */
export interface Timeline {
  name: string;
  fps: number;
  width: number;
  height: number;
  sources: Record<string, TimelineSource>;
  /** V1 speaker, V2 B-roll (cutaways over the speaker, which keeps running under them), A1 voice, A2 music, A3 sound effects */
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

/** A voice of the person's ElevenLabs account. `own`: one they made or cloned, not one given to everyone. */
export interface Voice {
  id: string;
  name: string;
  own: boolean;
  /** a short sample to listen to, when the voice has one */
  preview?: string;
}

/** The voices to choose from, the account's own first, and the id of the one used last (null: none yet). */
export interface VoicesView {
  voices: Voice[];
  last: string | null;
}

/** `voice`: a voice's id or name; left out, the one used last. `name`: the recording's title in the library. */
export interface NewVoice {
  text: string;
  voice?: string;
  name?: string;
}

/** The recording as saved in the Media Library: `versionId` is a source for a new edit. */
export interface MadeVoice {
  versionId: string;
  assetId: string;
  libraryId: string;
  name: string;
  voice: Pick<Voice, "id" | "name">;
}

/** Where footage picked from this computer goes in the Media Library (the A-roll folder unless a plug-in says otherwise). */
export interface FootageTarget {
  libraryId: string;
  collectionId: string;
}
