/**
 * AI Editor: raw takes from the Media Library → draft timelines the user finishes in their own editor.
 *
 * Contract (api/editor/routes.ts, mounted at /api/editor, tool `editor`):
 *   POST   /api/editor                     NewEdit → { id }
 *   GET    /api/editor                     → EditSummary[] (mine; a workspace owner: the workspace's too)
 *   GET    /api/editor/:id                 → Edit
 *   PATCH  /api/editor/:id                 EditPatch (the creator) → Edit
 *   POST   /api/editor/:id/run             { from?: EditStep, now?: true } (the creator) → Edit
 *   POST   /api/editor/:id/feedback        { text } what the person said about the cut, kept word for word; queues the next version → Edit & { queued }
 *   POST   /api/editor/:id/jobs/:jobId/retry  (the creator) → Edit
 *   POST   /api/editor/:id/stop            stops queued and running steps → Edit
 *   PUT    /api/editor/:id/eyeline/:versionId  { y: 0..1 } (the creator) → Edit
 *   GET    /api/editor/:id/drafts/:name    → Draft
 *   GET    /api/editor/:id/drafts/:name/export?format=otio|fcpxml|zip   the draft for the user's own editor (a download)
 *   POST   /api/editor/:id/drafts/:name/review   renders the draft's preview again and files it in Review (the creator) → Edit
 *   POST   /api/editor/:id/drafts/:name/cut      { asset?, n?, edits } (the creator): timeline edits cut into the draft, with no AI → Edit; rendered and filed in Review
 *   POST   /api/editor/:id/drafts/:name/revise   the open comments on its newest Review version: each answered, the cut changed only where they ask (an AI step, revise.ts) → Edit; 400 with none
 *   POST   /api/editor/:id/drafts/:name/sent-back  { file, text }: a timeline changed in another editing app (OTIO, FCPXML, FCP 7 XML, EDL) as the draft, no AI → Edit; rendered and filed in Review
 *                                                 as that video's next version. With asset/n: edits made on that Review version; without: on the draft as it is
 *                                                 now (Draft.view); `edits` may be [] then, when the draft is not what Review has (clips put on it): it is rendered as it is
 *   POST   /api/editor/:id/drafts/:name/voice    { voice?, mix? } (the creator): Review's voice controls kept for the edit (EditVoice; `mix` by
 *                                                 the stem group's key) → 201 { voice: EditVoice }; the draft is cut again with them, only its sound
 *   POST   /api/editor/:id/drafts/:name/duplicate  (the creator) → 201 { name }: the draft as a new version (next free v1…v9), no AI; its preview is made
 *   PUT    /api/editor/:id/drafts/:name/timeline  { timeline } (the creator): the editor's whole timeline kept as the draft, judged first → Edit; rendered and filed in Review
 *   GET    /api/editor/:id/clips/:clip           → { source, sound }: a Media Library clip as the editor lays it (its rate, length, size; whether it has sound)
 *   PATCH  /api/editor/:id/versions/:name        { label?, trashed? } (the creator) → Edit["marks"]: rename ("" clears) or delete (trashed: false = Undo) a version
 *   POST   /api/editor/empty                     { name?, projectId? } → 201 { id, draft }: an edit with no footage and one empty draft (v1)
 *   POST   /api/editor/:id/restore               out of the trash again (Undo of DELETE; the maker and the workspace owner)
 *   GET    /api/editor/:id/sentences       → Sentence[] (what analyze found, for playing a take)
 *   PUT    /api/editor/:id/lines           PlansPatch (the creator): takes swapped or lines reordered → Edit; redrafts what changed
 *   GET    /api/editor/:id/takes/:line     → LineTakes: the take picker's takes of one line, each cut as a draft would cut it (no AI, nothing decoded)
 *   GET    /api/editor/chat?edit=<id>      → EditorChatView: the newest chat with the assistant about that edit (none: no edit, the AI Editor's own)
 *   POST   /api/editor/chat                { text, edit? } a message to that chat, answered by the person's own AI → EditorChatView
 *   DELETE /api/editor/chat?edit=<id>      a new conversation about it: the old chat stays among the person's chats → EditorChatView
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
import type { Coverage, Focus, PlanEffect, PlanFrame, PlanText } from "./edit-plan";
import type { TimelineView } from "./edit-timeline";
import type { Grade } from "./grade";

export const EDIT_STEPS = ["analyze", "script", "draft", "broll"] as const;
export type EditStep = (typeof EDIT_STEPS)[number];

export const MAX_VERSIONS = 5;

/**
 * A cut's name (owner, 2026-11-20): each round of an edit is the next draft (its Review version number, as every
 * send-back files the next version), and the alternatives inside one round are Version A, B, C; `version` only when a
 * round has several. "Draft 2", "Draft 2 · Version B".
 */
export const draftName = (n: number, version?: string) => `Draft ${n}${version ? ` · Version ${version}` : ""}`;
/** The most short videos one long recording is cut into (EditBrief.moments). */
export const MAX_MOMENTS = 20;

/** The frames a moment can be reframed to, and their sizes. */
export const MOMENT_SHAPES = { "9:16": { w: 1080, h: 1920 }, "4:5": { w: 1080, h: 1350 }, "1:1": { w: 1080, h: 1080 } } as const;
export type MomentShape = keyof typeof MOMENT_SHAPES;

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
  /** with `moments`: the frame each is cut to, the picture following who talks (or the subject); absent = as filmed */
  shape?: MomentShape;
  /** a library collection to take B-roll from, or none */
  brollCollectionId: string | null;
  /** punch-in zoom on jump cuts */
  framing: { punch: number };
  /** the per-edit flags a plug-in declared (EditFlag), by id: on or off. A new edit records every declared flag. */
  flags: Record<string, boolean>;
  /** the languages spoken in the footage (two-letter codes), for when its takes are transcribed. Missing or empty =
   *  its workspace's language (Settings → Workspace → Details), else the person's own list (Settings → Voice). */
  languages?: string[];
  /**
   * Not cut around what is said: the AI plans the shots from the brief, to a song or the footage's own sound (a hard
   * edit on the beat, a recap, a music video, gameplay), api/editor/plan.ts. Footage where nobody speaks is planned this
   * way without it. Absent: cut around speech when someone speaks.
   */
  plan?: boolean;
  /** the song to cut to: a library version id (a Music item). Absent: one among the sources, else the library's, else none */
  song?: string | null;
  /** the voice of its recordings (api/editor/voice-mix.ts); absent = as recorded */
  voice?: EditVoice;
}

/**
 * An edit's voice. Nothing is done to the voice until the person picks an enhancer, and the recording as it is stays one
 * click away (Review's voice controls, "Off"). Every voice, enhanced or not, comes out at one loudness.
 */
export interface EditVoice {
  /** what every recording plays: "off" = as recorded, else an Audio Enhancer engine id (GET /api/enhance/availability) */
  fx: string;
  /** a recording's own enhancer over `fx` ("off" = as recorded), by its library version id; only while `fx` is not off */
  per?: Record<string, string>;
  /** a recording's share of its enhanced voice against the original, 0..1 in steps of 0.05, by version id; absent = 1 */
  mix?: Record<string, number>;
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
  /** while it runs: what it is doing now, when the step says (a first-time install, waiting for the person's AI); queued:
   *  why no computer has taken it, when none that runs it can read its footage ("Only Mac Studio can read Footage") */
  line?: string;
  /** queued with no reader and Downloads off: the library whose server copies would let it run (reach.ts downloadsAsk) */
  downloads?: { libraryId: string; workspace: string };
  /** while it runs on one of the person's computers: that computer's name and, while it downloads, the bytes done and
   *  total and the seconds left */
  progress?: { device: string; done?: number; total?: number; leftS?: number };
  /** what its AI calls spent, every run of it added up: calls, tokens and the API price in dollars */
  usage?: { calls: number; tokens: number; costUsd: number };
  /** a cards step that waits on its look sheet for the person's go or a note (POST /api/editor/:id/jobs/:job/go); the
   *  picture is GET /api/editor/:id/jobs/:job/sheet.jpg, `at` changes with each new sheet */
  sheet?: { at: number };
}

export interface EditSummary {
  id: string;
  name: string;
  createdBy: string;
  /** the maker's name and picture, where the edit's workspace has a team (Settings → Team); one person's own edits carry none */
  maker?: { name: string; picture: string | null };
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
  /** GET /api/editor only: how many versions it has (drafts not deleted), and the newest one's Review still (/api/review/assets/<asset>/v/<n>/thumb) */
  versionCount?: number;
  still?: { asset: string; n: number };
  /** what its steps' AI calls spent so far, in dollars at the API's price (absent: nothing yet) */
  costUsd?: number;
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

/** A take as the take picker lays it on a timeline: its recording, its seconds there, and the parts its cut keeps. */
export interface TakeCut extends Take {
  /** the library version it was said in (a timeline source key) */
  src: string;
  /** seconds in the source, first sentence's start to last's end */
  s: number;
  e: number;
  /** source frames [in, out) the cut keeps, in order (restarts and long pauses out, as the draft step cuts) */
  cut: [number, number][];
}

/** GET /:id/takes/:line: a line's takes, best first as the script ranked them, and each one's source as a timeline keeps it. */
export interface LineTakes {
  line: string;
  text: string;
  takes: TakeCut[];
  sources: Record<string, TimelineSource>;
}

/** /api/editor/chat: the person's chat with the assistant about one edit, as an edit's thread shows it (the phone's too). */
export interface EditorChatView {
  /** the assistant chat (none yet: the first message makes it) */
  chat?: string;
  messages: { id: string; role: "user" | "assistant"; text: string; at: number; steps?: string[]; error?: boolean; edit?: string }[];
  /** the reply being written now: `claimed` once it has started working */
  turn: { at: number; claimed: boolean; steps: string[] } | null;
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
  /** where the workspace has a team: by version, the name of whoever asked for its newest cut */
  askedBy?: Record<string, string>;
  /** its name and the trash are its maker's and the workspace owner's, not the caller's */
  locked?: true;
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
  /** a planned edit: the footage its cut was made from, and each file left out (Review names those) */
  coverage?: Coverage;
  /** by version name: the name the person gave it, and when it was deleted (hidden on the project page; drafts and Review stay) */
  marks?: Record<string, VersionMark>;
}

export interface VersionMark {
  label?: string;
  trashedAt?: number;
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
  /** who asked for this version (a teammate's next version is theirs); absent on one from before it was kept */
  by?: string;
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
  /** the editor's Freeze Frame: the item holds its first frame to its end */
  freeze?: boolean;
  /* A planned edit's shot (api/editor/plan.ts); absent on every other item. Times are seconds inside the item. */
  /** 1 = as filmed */
  speed?: number;
  /** speed over the item's own time, from 0 to its length */
  ramp?: Array<{ t: number; speed: number }>;
  fx?: PlanEffect[];
  enter?: "cut" | "flash" | "whip" | "dissolve";
  /** how it sits in the frame (PlanShot.frame); its zoom is the main picture's size, so an export shows that much */
  frame?: PlanFrame;
  /** pictures stacked in a column with it: a source key in Timeline.sources and its in-point (source frames) */
  split?: Array<{ src: string; in: number; focus?: Focus }>;
  /** where the crop sits in the room the picture leaves (PlanShot.focus): the preview draws it; an export keeps the centre */
  focus?: Focus;
  /**
   * A reframed shot's window over time (api/editor/framing.ts followPath): Focus.x from `t` seconds into the item, eased
   * to the next key, two keys at one time a cut. It moves x only; the preview draws it, the exports key it (framing.ts panKeys).
   */
  path?: { t: number; x: number }[];
  /** what a hand in Review set the path to (edit-timeline.ts ItemEdit.crop): held at x, or following Speaker n; absent = who talks */
  crop?: WindowCrop;
  /* Set in the editor (src/lib/nle), in its names; what this server's renders draw of them is Renders. */
  /** timeline frames of fade from black / silence at the start, and to it at the end */
  fade_in?: number;
  fade_out?: number;
  /** false: switched off, as if not there */
  enabled?: boolean;
  /** its own setting of a processing the editor's page offers, by name; absent = the timeline's (src/lib/nle/model.ts processingOf) */
  processing?: Record<string, unknown>;
}

/**
 * A reframed shot's window set by hand: held at x (Focus.x), following Speaker n (0 = whoever talks), or following what
 * the person clicked on (`subject`: `t` seconds in the source, `x` `y` fractions of the picture; api/editor/subject.ts).
 */
export type WindowCrop = { x: number } | { speaker: number } | { subject: { t: number; x: number; y: number } };

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
  tracks: Record<TrackId, { name: string; items: Item[]; /** a picture track switched off, a sound track muted (the editor's) */ hidden?: boolean; mute?: boolean }>;
  /** one per script line, at the line's first frame; colour is an OTIO marker colour (RED, BLUE, …) */
  markers: { rec: number; name: string; color: string; note: string }[];
  /**
   * Who talks when (api/editor/speakers.ts), on the timeline's frames: Speaker 1, 2, … in the order they first talk, 0 =
   * someone not in the picture. Found for a reframed moment; absent where nobody looked.
   */
  speakers?: { rec: number; len: number; speaker: number }[];
  /**
   * A reframed source's window paths in its own seconds (framing.ts): following who talks, or with no faces the subject
   * (`auto`), each speaker alone, so a shot cut from it can be set to any of them by hand (edits.ts), and each subject
   * clicked in Review once a computer has followed it (`picked`, by framing.ts pickKey; preview.ts).
   */
  reframe?: Record<string, { auto: { t: number; x: number }[]; speakers: Record<number, { t: number; x: number }[]>; picked?: Record<string, { t: number; x: number }[]> }>;
  /** the timeline's setting of each processing the editor's page offers, by name; a clip's own is its item's `processing` (src/lib/nle/model.ts processingOf) */
  processing?: Record<string, unknown>;
  /** a planned edit (api/editor/plan.ts): the kind it is, in the brief's words, and its texts (seconds on the timeline). Absent: cut around speech */
  plan?: { kind: string; texts?: PlanText[] };
}

/*
 * The edit's own timeline file (EDJ) as the studio engine and the editor (src/lib/nle/model.ts) save it: snake_case,
 * frames, fields nobody here knows kept as they are. Version 2 adds the fields below; `edjVersion` says which one a
 * file needs, and a worker never renders a file newer than the version it understands. Shared with the engine's tests
 * through contracts/edj.fixture.json (every field) and contracts/edj-golden.json (the keyframe and transition maths).
 */

/** the highest `edj_version` this code reads and writes */
export const EDJ_VERSION = 2;

/** marker colours as Resolve names them → OTIO's names: the 8 that survive a round trip through Resolve */
export const MARKER_COLORS = { Red: "RED", Yellow: "YELLOW", Green: "GREEN", Cyan: "CYAN", Blue: "BLUE", Purple: "PURPLE", Pink: "PINK", Lavender: "MAGENTA" } as const;
export type MarkerColor = keyof typeof MARKER_COLORS;
/** a timeline marker: `frame` on the timeline, `dur` frames long (1 when absent) */
export interface EdjMarker { frame: number; name: string; color: MarkerColor; note?: string; dur?: number }

/** the props a clip can key */
export const KEY_PROPS = ["zoom", "pan", "tilt", "rot", "opacity", "gain_db"] as const;
export type KeyProp = (typeof KEY_PROPS)[number];
/** how the value goes from this key to the next: the shot list's eased curve (src/lib/nle/shot.ts `ease`), a straight line, or held until the next key */
export const KEY_EASES = ["ease", "linear", "hold"] as const;
export type KeyEase = (typeof KEY_EASES)[number];
/** [source frame, value, ease]: keyed in the SOURCE's frames, so trims, slips, splits and pastes never move them; sorted, one per frame */
export type Key = [frame: number, value: number, ease: KeyEase];

export const TRANS_TYPES = ["dissolve", "dip_black", "dip_white", "crossfade"] as const;
export type TransType = (typeof TRANS_TYPES)[number];
/** a transition on the LATER clip of a cut on its track, `len` timeline frames centred on the cut, starting at it or ending at it */
export interface EdjTrans { type: TransType; len: number; at: "center" | "start" | "end" }

/** a camera conversion, per source, before the grade: a log curve (the Colour step's profiles) or an added LUT; `from: "file"` = what the file says */
export interface EdjCamera { curve?: string; lut?: string; from?: "file"; on: boolean }
export interface EdjSource { path?: string; fps?: number; dur?: number; w?: number; h?: number; camera?: EdjCamera; [k: string]: unknown }
/** a Design frame as a clip: `path` is a content-hashed PNG with alpha (a new render is a new path) */
export interface EdjDesignSource { kind: "design"; design: string; frame: string; path: string; w: number; h: number; camera?: undefined; [k: string]: unknown }

export interface EdjItem {
  src: string;
  rec: number;
  len: number;
  in: number;
  speed?: number;
  /** a prop's value when it has no keys */
  zoom?: number;
  pan?: number;
  tilt?: number;
  rot?: number;
  opacity?: number;
  gain_db?: number;
  keys?: Partial<Record<KeyProp, Key[]>>;
  trans?: EdjTrans;
  /** dB that Normalize added, on top of gain_db (or its keys) and fades */
  norm_db?: number;
  grade?: Grade;
  /** the clip's own setting of a processing, by name; absent = the timeline's `timeline.processing` (src/lib/nle/model.ts processingOf) */
  processing?: Record<string, unknown>;
  [k: string]: unknown;
}

/** captions made in Caption Studio from these A1 clips: [rec, len, src, in] each; a cut whose A1 differs has older captions */
export interface EdjCaptions { project: string; clip: string; burn: boolean; from: [rec: number, len: number, src: string, src_in: number][] }

export interface Edj {
  edj_version?: number;
  timeline: { fps: number; width?: number; height?: number; [k: string]: unknown };
  sources: Record<string, EdjSource | EdjDesignSource>;
  tracks: Record<string, { items: EdjItem[]; [k: string]: unknown }>;
  markers?: EdjMarker[];
  captions?: EdjCaptions;
  [k: string]: unknown;
}

/** 2 when the file uses any version-2 field, else 1 (markers and grades were already in version 1). */
export function edjVersion(edj: Edj): 1 | 2 {
  if (edj.captions) return 2;
  if (Object.values(edj.sources ?? {}).some((s) => s.camera || s.kind === "design")) return 2;
  const v2 = (it: EdjItem) => it.keys !== undefined || it.trans !== undefined || it.norm_db !== undefined;
  return Object.values(edj.tracks ?? {}).some((t) => t.items.some(v2)) ? 2 : 1;
}

const OTIO_TO_COLOR = Object.fromEntries(Object.entries(MARKER_COLORS).map(([k, v]) => [v, k])) as Record<string, MarkerColor>;
type PublicMarker = Timeline["markers"][number];
/** EDJ marker → this app's Timeline marker (`dur` has nowhere to go there) */
export const markerToPublic = (m: EdjMarker): PublicMarker => ({ rec: m.frame, name: m.name, color: MARKER_COLORS[m.color] ?? String(m.color).toUpperCase(), note: m.note ?? "" });
/** this app's Timeline marker → EDJ marker; an unknown colour is title-cased as the studio engine's OTIO reader does */
export const markerToEdj = (m: PublicMarker): EdjMarker => ({
  frame: m.rec,
  name: m.name,
  color: OTIO_TO_COLOR[m.color] ?? ((m.color[0] ?? "").toUpperCase() + m.color.slice(1).toLowerCase()) as MarkerColor,
  ...(m.note ? { note: m.note } : {}),
});

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
  exportGaps?: ExportGaps;
  /** GET only: the draft as an editable timeline (keys "<track>:<frame>", what /cut's edits name without asset) */
  view?: TimelineView;
  /** GET only: the Review version whose cut is exactly this draft; null when the draft changed since (or was never filed) */
  filed?: ReviewPreview | null;
  /** GET only: what this server's renders draw of this draft (the editor greys the rest) */
  renders?: Renders;
}

/**
 * What a server's renders draw of a timeline: the highest `edj_version`, and per track the clip and track fields of the
 * editor's (src/lib/nle/model.ts names: zoom, gain_db, fade_in, enabled, hidden, mute…). A track not listed isn't drawn.
 * The editor greys a control whose field isn't listed for its clips' track, and the save refuses a timeline that adds one.
 */
export interface Renders {
  edj_version: number;
  tracks: Record<string, string[]>;
}

/** The editors a draft's timeline file is written for. */
export type ExportEditor = "resolve" | "final-cut" | "premiere";
/** Per editor, what its file can't carry of the preview, as short phrases ("shake (54 shots)"); a missing key = all of it. */
export type ExportGaps = Partial<Record<ExportEditor, string[]>>;

/** A video editor's id on the Mac (apps/mac Editors.swift) as the file it reads; null for one that reads none (avid). */
export const exportEditor = (id: string): ExportEditor | null =>
  id === "resolve-studio" || id === "resolve" ? "resolve" : id === "final-cut" || id === "premiere" ? id : null;

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
  /** the edit to make from it (POST /api/editor's body, no sources): made on the server once a save that waits for a
   *  computer (Upload none) lands; the answer is then { waiting } */
  edit?: Omit<NewEdit, "sources">;
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

/**
 * One thing the person said about an edit's versions, kept word for word and read with every later version of that
 * edit (tasks/flywheel/PLAN.md D8): a message in chat (tool editor_feedback) or a Review comment on a version set to
 * Changes. Never rewritten or summed up; the newest is read last.
 */
export interface EditFeedback {
  at: number;
  from: "chat" | "review";
  /** the version it was said about ("v1".."v5"; a Review comment's own version) */
  variant?: string;
  /** seconds into that version, when it sits on a moment (a Review comment) */
  t?: number;
  text: string;
  /** who said it: their username */
  by: string;
}
/** Notes one edit keeps, and the characters of each. */
export const EDIT_FEEDBACK_MAX = 60;
export const EDIT_FEEDBACK_TEXT_MAX = 4000;
