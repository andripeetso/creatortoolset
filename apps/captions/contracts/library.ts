import type { PlaceWord, WhereIs } from "./places";

/**
 * Media Library: the types the web app and the server share (tasks/media-library-plan.md, section 7).
 * Routes live in api/library/routes.ts (later slices). Who may do what is in api/library/access.ts:
 * an owner of the workspace manages libraries; a member uploads, edits and shares their own assets.
 */

export type AssetKind = "video" | "image" | "audio" | "doc";
export type VersionState = "processing" | "ready" | "failed" | "missing";

export interface AssetCard {
  id: string;
  libraryId: string;
  kind: AssetKind;
  title: string;
  versionId: string;
  versionN: number;
  durationS?: number;
  /** as shown: with `turn` 90 or 270 they are the file's, swapped */
  width?: number;
  height?: number;
  /** clockwise degrees the player turns the video to show it upright (the AI's or the person's; the file is never changed). Thumb and strip are upright already */
  turn?: 90 | 180 | 270;
  thumbUrl?: string; // /api/library/media/<versionId>/thumb
  tags: string[]; // user and ai, with `aiTags` marking the AI ones
  aiTags: string[];
  description?: { text: string; source: "user" | "ai" };
  state: VersionState;
  capturedAt?: number;
  /** when it came into the library (the list's Date added) */
  addedAt?: number;
  /** the current version's file size (the list's Size) */
  bytes?: number;
  trashedAt?: number;
  /** a Review video (same id): Review owns its versions and its trash, so the library opens it there */
  review?: true;
  /** while the clip is being prepared: the step it is on (running) or waits for next (LibraryProcessing.tsx ClipStage draws it) */
  preparing?: { step: LibraryStage["kind"] | "probe" | "wave" | "sprite"; running: boolean };
  /** a `failed` clip: the step that failed and the tool's own error (ClipStage says it in words) */
  failed?: { step: "probe" | "thumb" | "wave" | "proxy"; error: string };
  /** A-roll (someone talks to the camera) or B-roll (the rest), as the library sorted it (api/library/roll.ts); videos only, once sorted */
  roll?: "a" | "b";
  /** finished work (a Review video, a version of a Finals piece, a saved export): it never has a roll */
  finished?: true;
  /** its file is on a computer: read in place from a folder there, or sent from there (Show in Finder can find it) */
  onComputer?: true;
  /** Blur faces is on and the clip has no blurred render yet: no picture, nothing plays off its computer (LIBRARY_WORDS.notBlurred) */
  notBlurred?: true;
  /** the file is on a Mac and only its index is on this server (api/library/on-mac.ts): the drive's name, else the Mac's */
  onMac?: string;
  /** on the computer that asked (`?device=`): its proxy in that computer's cache, or its original verified or found there (place rows) */
  here?: true;
  /** where its original is, seen from the computer that asked (`?device=`; none: any of the person's), from the place rows
   *  (api/library/whereis.ts, contracts/places.ts placeWordOf; src/lib/wording.ts placeLine says it). None: no computer has
   *  a place row for it (the server's own copy, or not reported by any computer yet). `place` is the filming country */
  placeWord?: PlaceWord;
  /** a strip of frames across the clip, side by side in one picture (videos, once made): hover scrub and the filmstrip */
  spriteUrl?: string;
  /** the country it was filmed in (ISO 3166-1 alpha-2), from the file's own location; never the coordinates */
  place?: string;
  /** a video's proxy where it can play (markHere): on the server (`server`, /api/library/media/<versionId>/play), in the
   *  asking computer's cache (`cached`), or both; its size as made. The editor plays it in place of the original (src/lib/here.ts editorProxy) */
  proxy?: { w: number; h: number; server?: true; cached?: true };
}

/** Frames in a clip's strip (`spriteUrl`), side by side; frame i shows the middle of the clip's i-th share (api/library/media/sprite.ts). */
export const SPRITE_FRAMES = 20;
/** A strip frame's longer side in pixels: each frame keeps the clip's own shape (an upright clip's frames stand upright). Strips made
 *  before 2026-11-19 are 160 × 90 cuts; a card reads the frame shape from the picture itself (ClipCards.tsx useStrip). */
export const SPRITE_SIDE = 256;

export interface AssetDetail extends AssetCard {
  versions: { id: string; n: number; bytes: number; createdAt: number; createdBy: string; state: VersionState }[];
  transcript?: { provider: string; segments: { start: number; end: number; text: string }[] };
  collections: { id: string; name: string }[];
  /** the file on this computer (read in place, kept on the Mac app's own server on this Mac, or where it was sent from): the admin only (search.ts sourcePathFor) */
  sourcePath?: string;
  /** the current version's background jobs: a transcribe that `needs_key` says why in `error`; one running on this computer says what it is doing there */
  jobs: { kind: string; state: "queued" | "running" | "done" | "failed" | "needs_key"; error?: string }[];
  /** its shot descriptions, in order (a person's own line wins): a video's moments, each with its start and end second */
  /** flaws: what the shot is named for, measured ("blurry", "too dark", "shaky") */
  shots?: { seg: number; a: number; b: number; text: string; source: "ai" | "user"; flaws?: string[] }[];
  /** what happens when, from Gemini watching the video with its sound (api/library/timeline.ts); absent without one */
  timeline?: TimelineEvent[];
}

/**
 * One moment of a video's timeline, in order: Gemini watched the video with its sound (api/library/timeline.ts). `sound`:
 * what the sound adds (a hit, a line, music rising); `change`: what changed from the moment before (a cut, the camera,
 * the place). Never who anyone is.
 */
export interface TimelineEvent {
  a: number;
  b: number;
  what: string;
  sound?: string;
  change?: string;
}

export interface SearchQuery {
  q?: string;
  kind?: AssetKind[];
  collectionId?: string;
  tag?: string;
  from?: number;
  to?: number;
  hasTranscript?: boolean;
  /** only A-roll or only B-roll (`?roll=a|b`) */
  roll?: "a" | "b";
  /** only these versions' assets (`?versions=id,id`, at most 200) */
  versions?: string[];
  /** plug-in sidebar filters: facet key → chosen values (api/library/sources.ts) */
  facets?: Record<string, string[]>;
  trashed?: boolean; // the trash instead of the library
  /** only clips in none of the person's folders (the library's top level); Finals and saved searches don't count */
  unfiled?: boolean;
  /** the order, sorted by the server (`?sort=`): newest added first when not given */
  sort?: LibrarySort;
  /** only clips filmed in this country (`?place=`, ISO 3166-1 alpha-2) */
  place?: string;
  /** the asker's own computer (`?device=`, the Mac app's id on this server): cards on it get `here` */
  device?: string;
  /** only clips on that computer (`?here=1`) */
  here?: true;
  /** only clips that computer last found gone (`?missing=1`, api/library/places.ts): not where they were, their disk there */
  missing?: true;
  /** only clips with every one of these tags (`?tag=a,b`) */
  tags?: string[];
  /** only clips filmed from / before these times, ms (`?filmedFrom=&filmedTo=`); a clip with no filming time by when it was added. `from`/`to` stay when it was added */
  filmedFrom?: number;
  filmedTo?: number;
  cursor?: string;
  limit?: number; // limit ≤ 200
}

export type LibrarySort = "new" | "old" | "name" | "name-za" | "longest" | "shortest" | "filmed" | "filmed-old" | "biggest" | "smallest" | "kind" | "kind-za";

/** GET /api/library/:id/tags */
export interface TagCount {
  tag: string;
  count: number;
}

export interface SearchHit {
  asset: AssetCard;
  seconds?: number;
  snippet?: string;
}

export interface ShareInput {
  target: { kind: "asset" | "version" | "collection" | "piece"; id: string };
  scope: "view" | "download" | "comment";
  expiresInDays: number; // default 7, max 90
  password?: string;
}

/** What the owner switches on per library. Both spend AI on every upload, so both start off. */
export interface LibrarySettings {
  describe: boolean; // the AI writes a description and tags for each new video
  embed: boolean; // semantic search: search by meaning as well as by words
  /** search by picture: what each shot shows, matched with what is typed (api/library/pictures.ts); absent on an older server */
  pictures?: boolean;
  look: boolean; // the AI writes a line for each shot of a longer video that isn't a talking take (Shot descriptions)
  timeline: boolean; // Gemini watches each of those videos and writes its timeline (Timelines): on a Gemini key with its sound, on Antigravity its picture only
  /** what watches (WATCH_MODELS); absent: the first */
  timelineModel?: WatchModel;
  proxy: boolean; // Generate proxies for imported media: a proxy for each video the window cannot play as it is (4K, 10-bit, a camera's own format)
  /** Proxy quality (PROXY_QUALITIES); absent: "standard". Changing it affects new proxies only. */
  proxyQuality?: ProxyQuality;
  /** transcripts at import (Analysis effort Low and up); absent: on */
  transcribe?: boolean;
  /** Analysis effort Max: talking takes get shot descriptions too (with lookLevel "detailed") */
  lookTalking?: boolean;
  /** when setup was finished (ISO); absent: not set up, so mediaReady is false and the Library opens setup */
  setupAt?: string;
  /** Use default folders: missing Source media / Project files / Final exports are made at the default paths; absent: on */
  defaultFolders?: boolean;
  /**
   * What a file added from a computer the server is not on sends to the server: "none" (the default) indexes it where it
   * is; "proxies" sends it, keeps only its proxy and forgets the original there; "all" keeps the video file and its proxy.
   * A stored `true` / `false` (before 2026-11-15) reads as "all" / "none".
   */
  upload: LibraryUpload;
  /**
   * Blur faces (owner only; absent: off): only a clip's blurred render, and pictures cut from it, leave the owner's
   * computers. Upload is then Off ("none") or Blurred ("proxies": the blurred render is the clip's proxy); a clip with no
   * blurred render yet is kept as under Off (api/library/upload-gate.ts mayLeave).
   */
  blurFaces?: boolean;
  /** The same for a final (a file that goes into Finals, from a project's folder in the Finals folder): "all" when unset,
   *  so a phone can download the finished file to post it. */
  finalsUpload?: LibraryUpload;
  /** how the library is organized, chosen on its first run (absent: not chosen yet); api/library/organize.ts */
  organize?: Organize;
  /** how densely shots are described (LOOK_LEVELS); absent: "standard" */
  lookLevel: LookLevel;
  /** dollars a month (UTC) shot descriptions may cost in this library's workspace, by the usage tally; null: no cap */
  lookBudget: number | null;
}

/**
 * How densely the library describes shots: a long take is split into pieces of `piece` to `long` seconds, each piece
 * one line (api/library/look.ts shotsOf). Cost and time follow the count of pieces, about 8 / `long` times Standard's.
 * The level is part of the lines' stamp (api/library/shots.ts levelVersion), so lines of one level never pass as another's.
 */
export type LookLevel = "light" | "standard" | "detailed";
export const LOOK_LEVELS: readonly { value: LookLevel; label: string; long: number; piece: number }[] = [
  { value: "light", label: "Light", long: 24, piece: 12 },
  { value: "standard", label: "Standard", long: 8, piece: 4 },
  { value: "detailed", label: "Detailed", long: 4, piece: 2 },
];
export const lookLevelOf = (v: unknown): LookLevel => (LOOK_LEVELS.some((l) => l.value === v) ? (v as LookLevel) : "standard");
/**
 * What a library's Timelines watch with (api/library/timeline.ts), the default first. The two Gemini models run on the
 * person's Gemini API key and hear the sound: measured 2026-11-16 on 9 clips, 3.8 Flash found 42 of 44 moments, with
 * cause across shots, retakes and sound onsets right; 3.5 Flash-Lite found 34, coarser, at about a third of the cost.
 * Antigravity is the person's own AI provider (a Google sign-in, no key): it sees the picture only, so its timelines
 * have no sound notes.
 */
export type GeminiModel = "gemini-3.8-flash" | "gemini-3.5-flash-lite";
export type WatchModel = GeminiModel | "antigravity";
export const WATCH_MODELS: readonly { value: WatchModel; label: string; note: string }[] = [
  { value: "gemini-3.8-flash", label: "Gemini 3.8 Flash", note: "Picture and sound, most moments" },
  { value: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", note: "Picture and sound, fewer moments" },
  { value: "antigravity", label: "Antigravity", note: "Picture only, no sound" },
];
export const watchModelOf = (v: unknown): WatchModel => (WATCH_MODELS.some((m) => m.value === v) ? (v as WatchModel) : WATCH_MODELS[0]!.value);
/** A new library's monthly cap on shot descriptions, in dollars (API-equivalent on an AI provider). */
export const LOOK_BUDGET_DEFAULT = 20;

/**
 * The files the Library takes as pictures (photos): the web's own formats, HEIC, and camera RAW (11-19: RAW is read by
 * the Mac app's own decoder, Import.swift thumb). One list for the server's kinds, the page's index and the drop.
 */
export const PICTURE_FILE = /\.(jpe?g|png|heic|heif|webp|gif|tiff?|dng|cr2|cr3|arw|nef|raf|rw2|orf)$/i;

/**
 * Camera RAW: a photo only when a computer indexes it in place and makes its picture there (POST /:id/on-mac); an
 * upload, an add in place on the server or a save from the server is refused with RAW_FROM_COMPUTER, so a RAW file never
 * reaches the server's own picture making (ffmpeg can't read it).
 */
export const RAW_FILE = /\.(dng|cr2|cr3|arw|nef|raf|rw2|orf)$/i;
export const RAW_FROM_COMPUTER = "RAW photos are added from a folder on your computer";

/** Hosted media: what the server keeps. Read only through hostsOriginals / hostsProxies (never `upload ===`). */
export type LibraryUpload = "none" | "originals" | "proxies" | "all";
export const LIBRARY_UPLOADS: readonly LibraryUpload[] = ["none", "originals", "proxies", "all"];
export const hostsOriginals = (u: LibraryUpload | null | undefined): boolean => u === "originals" || u === "all";
export const hostsProxies = (u: LibraryUpload | null | undefined): boolean => u === "proxies" || u === "all";
/** Under Blur faces Upload is Off or Blurred, stored as "none" and "proxies" (the blurred render is the proxy). */
export const BLURRED_UPLOADS: readonly LibraryUpload[] = ["none", "proxies"];
/** What a new file sends: under Blur faces nothing, since a file is not blurred when it is added. */
export const uploadSent = (s: { upload: LibraryUpload; blurFaces?: boolean }): LibraryUpload => (s.blurFaces ? "none" : s.upload);
/** Upload off: nothing of the library's is kept on the server (the one place the "none" word is compared). */
export const hostsNone = (u: LibraryUpload | null | undefined): boolean => !hostsOriginals(u) && !hostsProxies(u);
/** The Hosted media switches back to the one stored value. */
export const uploadFrom = (originals: boolean, proxies: boolean): LibraryUpload =>
  originals && proxies ? "all" : originals ? "originals" : proxies ? "proxies" : "none";

/**
 * Hosted media as the owner sets it (setup step 5 and the owner page, one component): the Upload to server master, and
 * under it Final exports, Proxies and Originals in any mix. Off = nothing goes up, final exports included. Stored as the
 * two values it always was (upload, finalsUpload; a missing finalsUpload is "all", as the server reads it).
 */
export interface HostedMix {
  finals: boolean;
  proxies: boolean;
  originals: boolean;
}
export const HOSTED_OFF: HostedMix = { finals: false, proxies: false, originals: false };
/** What the master turns on when there is no earlier mix to bring back (a new library's default). */
export const HOSTED_DEFAULT: HostedMix = { finals: true, proxies: false, originals: false };
export const hostedOn = (m: HostedMix): boolean => m.finals || m.proxies || m.originals;
export const hostedOf = (s: { upload?: LibraryUpload | null; finalsUpload?: LibraryUpload | null }): HostedMix => ({
  finals: !hostsNone(s.finalsUpload ?? "all"),
  proxies: hostsProxies(s.upload),
  originals: hostsOriginals(s.upload),
});
/** The mix as stored; `finalsWas` keeps a finals value other than "all" (Smaller copies) while Final exports stays on. */
export const hostedSettings = (m: HostedMix, finalsWas?: LibraryUpload | null): { upload: LibraryUpload; finalsUpload: LibraryUpload } => ({
  upload: uploadFrom(m.originals, m.proxies),
  finalsUpload: m.finals ? (finalsWas && !hostsNone(finalsWas) ? finalsWas : "all") : "none",
});

/** Proxy quality (UNIFIED-PRD §4.1): short side cap, CRF and max video rate; never upscaled, never above 0.8 × the source's rate. */
export type ProxyQuality = "low" | "standard" | "high";
export const PROXY_QUALITIES: readonly { value: ProxyQuality; label: string; short: number; crf: number; maxKbps: number }[] = [
  { value: "low", label: "Low (540p)", short: 540, crf: 28, maxKbps: 2000 },
  { value: "standard", label: "Standard (720p)", short: 720, crf: 26, maxKbps: 4000 },
  { value: "high", label: "High (1080p)", short: 1080, crf: 23, maxKbps: 8000 },
];
export const proxyQualityOf = (v: unknown): ProxyQuality => (PROXY_QUALITIES.some((q) => q.value === v) ? (v as ProxyQuality) : "standard");

/** A proxy's size from its source's upright size (api/library/media/proxy.ts makeProxy's scale): the short side to the quality's cap, never upscaled, both sides even. */
export function proxySize(width: number, height: number, quality: ProxyQuality): { w: number; h: number } {
  const q = PROXY_QUALITIES.find((x) => x.value === quality) ?? PROXY_QUALITIES[1]!;
  const short = Math.min(width, height);
  const even = (n: number) => Math.trunc(n / 2) * 2;
  return { w: even(Math.min(width, (q.short * width) / short)), h: even(Math.min(height, (q.short * height) / short)) };
}

/**
 * Analysis effort (UNIFIED-PRD §4.4): one slider over the existing flags, which stay the store. flagsOf writes them;
 * levelOf reads back the lowest level that covers every step they run.
 */
export type AnalysisLevel = "off" | "low" | "medium" | "high" | "xhigh" | "max";
export const ANALYSIS_LEVELS: readonly { value: AnalysisLevel; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" },
];
export const ANALYSIS_DEFAULT: AnalysisLevel = "high";
export type AnalysisFlags = Pick<LibrarySettings, "describe" | "embed" | "pictures" | "look" | "lookLevel" | "timeline" | "transcribe" | "lookTalking">;
export function flagsOf(level: AnalysisLevel): AnalysisFlags {
  const n = ANALYSIS_LEVELS.findIndex((l) => l.value === level);
  const look: LookLevel = n >= 4 ? "detailed" : n === 2 ? "light" : "standard";
  return { transcribe: n >= 1, describe: n >= 1, embed: n >= 1, pictures: n >= 1, look: n >= 2, lookLevel: look, timeline: n >= 3, lookTalking: n >= 5 };
}
export function levelOf(s: Partial<AnalysisFlags>): AnalysisLevel {
  let n = s.transcribe !== false || s.describe || s.embed || s.pictures ? 1 : 0;
  if (s.look) {
    const l = lookLevelOf(s.lookLevel);
    n = Math.max(n, l === "light" ? 2 : l === "standard" ? 3 : s.lookTalking ? 5 : 4);
  }
  if (s.timeline) n = Math.max(n, 3);
  return ANALYSIS_LEVELS[n]!.value;
}

/** Organization: "ai" Smart folders (the default for new libraries), "own" Organize yourself. "default" is a stored value
 *  from before (Default folders), read as "own" by organizeOf. */
export type Organize = "default" | "ai" | "own";
export const organizeOf = (v: unknown): "ai" | "own" | undefined => (v === "ai" ? "ai" : v === "own" || v === "default" ? "own" : undefined);


/** GET /api/library/:id/space: what the library's own made files take (the person's own files are not in it). */
export interface LibrarySpace {
  /** the library's videos by where their files are: on a Mac (indexed there), read in place on this server's computer, stored by this server */
  videos: { onMac: number; inPlace: number; stored: { bytes: number; files: number } };
  proxies: { bytes: number; files: number };
  /** the cards' pictures and sound pictures: made at once again, so they are said, not cleared */
  pictures: { bytes: number; files: number };
  /** the downloaded speech and search models, on a server on the person's own computer only */
  models: { bytes: number } | null;
}

/** What a step held for the person needs, in a few words, and the page where they add it. */
export const NEEDS: Record<LibraryStep, { needs: string; href: string }> = {
  files: { needs: "a look", href: "/library" },
  transcript: { needs: "a transcription key", href: "/settings/keys" },
  describe: { needs: "an AI provider", href: "/settings/providers" },
  look: { needs: "an AI provider", href: "/settings/providers" },
  embed: { needs: "an OpenAI key", href: "/settings/keys" },
};

/** "5 descriptions need an AI provider", and where to add it. */
export function waitingLine(w: { step: LibraryStep; count: number; away?: boolean; computer?: boolean; reason?: string; href?: string }): { text: string; href: string } {
  const one = w.count === 1;
  if (w.reason) return { text: `${stepCount(w)} · ${w.reason}`, href: w.href ?? "/settings/devices" };
  // a shot description parked for the Mac its file is on waits for a computer too, never for an AI provider
  if (w.away || w.computer)
    return { text: `${stepCount(w)} ${one ? "waits" : "wait"} for one of your computers`, href: w.href ?? "/settings/devices" };
  return { text: `${stepCount(w)} ${one ? "needs" : "need"} ${NEEDS[w.step].needs}`, href: w.href ?? NEEDS[w.step].href };
}

/** "6 descriptions", "1 file". */
export function stepCount(w: { step: LibraryStep; count: number }): string {
  const [thing, things] = {
    files: ["file", "files"],
    transcript: ["transcript", "transcripts"],
    describe: ["description", "descriptions"],
    look: ["shot description", "shot descriptions"],
    embed: ["search entry", "search entries"],
  }[w.step];
  return `${w.count.toLocaleString()} ${w.count === 1 ? thing : things}`;
}

/** One of the caller's libraries. */
/** One step of a library's processing: the server's own work on the files, the transcript, the AI's description, search by meaning. */
export type LibraryStep = "files" | "transcript" | "describe" | "look" | "embed";

/**
 * What a step runs on for the asking account: their connected AI (`provider`, on its subscription), their own Anthropic
 * key (`api`), the team's budget (`budget`), a transcription key, this computer (`device`, free), the server (`server`);
 * `none`: nothing to run it on yet (`missing` says what to add); `off`: the library has the step switched off.
 */
/** `device`: the server itself, on its owner's computer; `computer`: a model downloaded on one of the person's computers. */
export type LibraryStepRoute = "provider" | "api" | "budget" | "deepgram" | "openai" | "device" | "computer" | "server" | "none" | "off";

export interface LibraryStepEstimate {
  step: LibraryStep;
  route: LibraryStepRoute;
  missing?: string;
  /** dollars for these clips; on `provider` what the API would have charged (the subscription pays, its limits count) */
  usd: number;
  seconds: number;
  /** pace and cost come from this server's own finished runs, not the starting guess */
  measured: boolean;
}

/** GET /api/library/:id/estimate?clips&bytes: what processing that many clips would take, before they go in. */
export interface LibraryEstimate {
  clips: number;
  /** of footage, from the bytes at this library's own bytes per second */
  minutes: number;
  steps: LibraryStepEstimate[];
  /** the whole run: the slowest step (steps run side by side) */
  seconds: number;
  /** the library makes proxies (its settings): the files step counts them */
  proxies?: boolean;
  /** describe on the person's own Anthropic key instead (it runs six at once; a connected AI runs two): when that is faster */
  withApiKey?: { seconds: number; usd: number };
  /** the Effort row: ready footage not analyzed yet at this library's level (seconds), and an hour of it there (dollars) */
  unanalyzed?: { seconds: number; hourUsd: number };
  /** shot descriptions of one hour of footage at each level (LOOK_LEVELS), on the look's route; absent when it has none */
  lookLevels?: { level: LookLevel; seconds: number; usd: number }[];
  /** what shot descriptions cost this month in this library's workspace, in dollars */
  lookSpent?: number;
  /** the asker has a Gemini key, so the library's Timelines run (api/library/timeline.ts) */
  timelineKey?: boolean;
  /** a timeline of one hour of footage at the library's level, by Gemini model (WATCH_MODELS); absent without a Gemini key */
  timelineModels?: { model: WatchModel; usd: number }[];
  /** the asker has Antigravity among their AI providers, so Timelines can watch on it */
  timelineAntigravity?: boolean;
  /** what stopped the library's last watch: the Gemini key's free-tier daily quota, or its prepaid credit running out (api/library/timeline.ts watchStopped) */
  timelineStopped?: "free" | "credit";
}

/** One step of a library's preparing, as the person sees it go by: how many clips have it, of how many. */
export interface LibraryStage {
  /** thumb = pictures, proxy = lighter copies, fingerprint = duplicate checks, transcribe, describe, look = shot descriptions, timeline = Gemini's timelines (progress only, no job of their own), embed = search by meaning */
  kind: "thumb" | "proxy" | "fingerprint" | "transcribe" | "describe" | "look" | "timeline" | "embed";
  done: number;
  /** done, failed and still to do since this run of the queue began: neither number goes down while it runs */
  of: number;
  failed: number;
  /** the clip it is on right now */
  now?: string;
}

/** GET /api/library/:id/progress: the processing still to do in a library. Nothing to do = `left` 0. */
export interface LibraryProgress {
  /** steps done since the queue was last empty, and steps still to do (a file a watch folder has found counts as one) */
  done: number;
  left: number;
  /** clips with a step still to run here (a held one does not count), and the files a watch folder has found and not handed over */
  clips: number;
  /** how far this run is, 0 to 1: each clip counts the same, by the share of its steps through; a clip still to come counts 0 */
  share: number;
  /** time left at this server's pace */
  seconds: number;
  /** jobs waiting for a key or an AI, with what to add */
  waiting: {
    step: LibraryStep;
    count: number;
    missing: string;
    /** held back by the AI plan's usage limit */
    limit?: boolean;
    /** waits for the computer the files are on (shot descriptions of files kept on a Mac): `missing` says which */
    computer?: boolean;
    /** waits for one of the person's computers to be on: this server does not do that video work (worker.ts leftToComputers) */
    away?: boolean;
    wait?: "offline" | "stuck" | "needs" | "set" | "cannot";
    reason?: string;
    href?: string;
    mine?: boolean;
    device?: string;
    devices?: string[];
  }[];
  /** each step's count, in the order they run; only the steps this run has */
  stages?: LibraryStage[];
}

/** GET /api/library/:id/status: the whole library, not one run. Each step counts over the clips in it now (the trash left out). */
export interface LibraryStatus {
  clips: number;
  /** files that could not be read as video or sound */
  unreadable: number;
  /** done + failed + open = of; open is queued, running or waiting for a key */
  stages: (Omit<LibraryStage, "now"> & { open: number })[];
}

export interface LibrarySummary {
  id: string;
  name: string;
  storage: "local" | "s3" | "bunny";
  settings: LibrarySettings;
  /** the team owner's, in a workspace given to this person (Settings → Team): to look at and download, never change */
  readOnly?: true;
  /** read-only all the same, but it takes this person's uploads: the owner set their Media Library to Read & write */
  canAdd?: true;
  /** shared with members of the owner's workspace: the server serves its proxies to them under any Upload setting (team proxies, R2) */
  shared?: true;
}

/**
 * Where a library's files live, as its owner sets it (PUT /api/library/:id/storage): the server's disk, the server's
 * bucket (set up by whoever runs the server), the library's own S3-compatible bucket, or Bunny Storage. Own keys may be
 * left out to keep the ones already saved; they are never sent back. Bunny takes the account's API key once: the server
 * makes a storage zone and a token-signed pull zone with it and keeps only the zone's own keys, never the account key.
 */
/**
 * `proxies: true` on a bucket or Bunny: only the proxies go there, one for every video, and the originals stay on this
 * disk ("Proxies only"); allowed while the library holds files. `{ kind: "local" }` then brings the proxies back here.
 */
export type LibraryStorageInput =
  | { kind: "local" }
  | { kind: "s3"; mode: "server"; proxies?: boolean }
  | { kind: "s3"; mode: "own"; endpoint: string; region?: string; bucket: string; pathStyle?: boolean; accessKey?: string; secretKey?: string; proxies?: boolean }
  | { kind: "bunny"; apiKey?: string; region?: BunnyRegion; proxies?: boolean };

/** Bunny Storage's main regions, as its API names them. */
export const BUNNY_REGIONS = [
  { id: "DE", name: "Europe (Germany)" },
  { id: "NY", name: "New York" },
  { id: "LA", name: "Los Angeles" },
  { id: "SG", name: "Singapore" },
] as const;
export type BunnyRegion = (typeof BUNNY_REGIONS)[number]["id"];

/** GET /api/library/:id/usage, the owner only. */
export interface LibraryStorage {
  kind: "local" | "s3" | "bunny";
  mode?: "server" | "own";
  endpoint?: string; // own bucket only
  region?: string;
  bucket?: string;
  zone?: string; // Bunny: the storage zone's name
  pathStyle?: boolean;
  keysSet: boolean; // own bucket: its keys are saved (they never leave the server)
  serverBucket: boolean; // the server offers a bucket for libraries
  locked: boolean; // the library holds files: where they live can't change (the keys can)
  storedBytes?: number; // bucket libraries: bytes in the bucket now
  days: { day: string; storedBytes: number }[]; // bucket libraries: the last 30 days with a change, newest first
  /** kind "local" with "Proxies only": where the proxies are (storedBytes and days are then theirs) */
  proxies?: { kind: "s3" | "bunny"; mode?: "server" | "own"; bucket?: string; zone?: string; endpoint?: string; region?: string; pathStyle?: boolean; keysSet: boolean };
}

export interface AssetPage {
  items: AssetCard[];
  next?: string; // cursor for the next page
}

/** A folder or collection (manual: its items; smart: the saved SearchQuery, run on every read). */
export interface Collection {
  id: string;
  name: string;
  parentId: string | null;
  kind: "manual" | "smart";
  query?: SearchQuery; // smart only
  count?: number; // a folder's items; an A-roll or B-roll folder's clips of that roll
  /** up to four of its clips' pictures (thumb addresses), for its card: a folder's, or an A-roll or B-roll folder's */
  covers?: string[];
  /** a folder with no pictures: up to three of the songs or sounds in it, for its card */
  sounds?: string[];
  /** a smart folder: what goes in it, in the person's own words; the AI files the library's clips by it (api/library/smart.ts) */
  rule?: string;
  /** a smart folder sorting the library into itself right now */
  sorting?: true;
  createdBy: string;
}

/** Reorganize (POST /api/library/:id/collections/suggest): one way to sort the library, its smart folders and their counts. */
export interface ReorganizeWay {
  name: string;
  folders: { name: string; rule: string; count?: number }[];
}

/** A share as its owner or creator lists it. `id` is the token's sha256, the handle for revoke: the token itself is shown once. */
export interface ShareRow {
  id: string;
  target: ShareInput["target"];
  scope: ShareInput["scope"];
  locked: boolean;
  createdBy: string;
  expiresAt: number;
  views: number;
}

export interface ShareCreated {
  id: string;
  token: string;
  url: string; // /library/s/<token>, in the web app
  expiresAt: number;
}

/** What a share link shows: one video (or a collection's videos), with media URLs on the share route. */
export interface SharedItem {
  id: string;
  title: string;
  kind: AssetKind;
  versionId: string;
  durationS?: number;
  width?: number;
  height?: number;
  thumbUrl?: string;
  playUrl: string;
  sourceUrl?: string; // scope download only
}

export interface SharedView {
  locked: boolean;
  name?: string; // not sent while locked
  scope?: ShareInput["scope"];
  items: SharedItem[];
}

/** A watch folder (api/library/timeline.ts): a folder on the server's own disk whose new files join the library. */
export interface WatchFolder {
  path: string; // absolute, on the server's disk
  mode: "reference" | "copy"; // reference: the file stays where it is; copy: stored in the library like an upload
  /** reference only: each file is first copied into a folder of this folder's name here (on this disk, subfolders kept), then read where the copy is */
  copyTo?: string;
  collectionId?: string; // a manual folder the files go into
  addedBy: string; // the owner who added it; imports are theirs
  /** a Finals folder: only these subfolders are read, each a Workshop project's (folder name → project id) */
  projects?: Record<string, string>;
}

/** GET /api/library/:id/watch. `allowed` is false on a hosted server: it cannot see the folders on your computer. */
export interface WatchStatus {
  allowed: boolean;
  /** where a folder's files are copied when the person keeps a copy (their Library folder's Footage on this computer); "~/" is the home folder */
  copyTo?: string;
  /** `files`: the media files the last look at the folder found; `adding`: how many of them are still to be taken in. */
  folders: (WatchFolder & { found: boolean; imported: number; files: number; adding: number })[];
  missing: number; // versions whose original is gone from its folder
}

/** A video that shares pictures with a clip (api/library/similar.ts): `overlap` is the share of the clip's seconds found in it. */
export interface SimilarMatch {
  assetId: string;
  libraryId: string;
  versionId: string;
  title: string;
  thumbUrl: string;
  overlap: number; // 0..1
}

/**
 * A piece: library versions grouped with one winner (the Finals list is the pieces of its collection). Items are
 * versions; `externalRef` is for items from another source (a catalog clip), set by the source, never by a request.
 */
export interface Piece {
  id: string;
  label: string;
  collectionId: string | null;
  createdBy: string;
  items: PieceItem[];
  /** The owner's picked frame (`?v=` stamped); absent or null = the automatic cover (the winner's thumbnail). */
  coverUrl?: string | null;
  /** A picked frame that waits for one of the owner's computers to make it: the line it waits with. */
  coverWaits?: string;
  /** Whether the viewer may change it: every item is theirs to change. Set on the single-piece read only. */
  writable?: boolean;
}

export interface PieceItem {
  id: string;
  label: string | null;
  position: number;
  winner: boolean; // at most one per piece
  versionId: string | null;
  externalRef: string | null; // exactly one of versionId and externalRef is set
  postDescription: string | null; // the text under a post, for this version
  postings: Posting[];
}

/** Where an item was posted (one version can be posted to several platforms, or several times). */
export interface Posting {
  id: number;
  platform: string;
  url: string | null;
  postedAt: number;
  createdBy: string;
}

/**
 * Own-bucket presets for the storage form: Amazon S3 and Cloudflare R2 (with Bunny, the three storages offered; any other
 * S3-compatible provider is typed in by hand), and where each makes its keys. R2's endpoint is per account: `endpoint` is "" and
 * `endpointHint`, shown as the field's placeholder: the owner types the real address (the server rejects `<…>` text in
 * it). Amazon's endpoint is empty for real: the SDK finds it from the region. The bucket need not exist yet: saving
 * makes it, and gives it the CORS rule direct uploads need when it has none.
 */
export const S3_PRESETS = [
  { id: "aws", name: "Amazon S3", endpoint: "", endpointHint: "", region: "us-east-1", pathStyle: false, keysUrl: "https://console.aws.amazon.com/iam/home#/users" },
  { id: "r2", name: "Cloudflare R2", endpoint: "", endpointHint: "https://<account-id>.r2.cloudflarestorage.com", region: "auto", pathStyle: true, keysUrl: "https://dash.cloudflare.com/?to=/:account/r2/api-tokens" },
] as const;

export type S3PresetId = (typeof S3_PRESETS)[number]["id"];

/**
 * The form with a preset's region and path-style set, and its endpoint: a fixed one is filled in, one per account
 * (`endpointHint`) keeps what the field holds, and Amazon's clears it. The bucket and the keys are left as they are.
 */
export function applyS3Preset<T extends { endpoint: string; region: string; pathStyle: boolean }>(form: T, id: S3PresetId): T {
  const p = S3_PRESETS.find((x) => x.id === id);
  return p ? { ...form, endpoint: p.endpoint || (p.endpointHint ? form.endpoint : ""), region: p.region, pathStyle: p.pathStyle } : form;
}

/** A song or a sound effect added as one (the assistant's use_file sound): its tag, which keeps the worker's AI steps
 *  (transcript, description, search by meaning) off it, and the top-level folder it is filed in, made on first use. */
export const SOUNDS = { music: { tag: "music", folder: "Music" }, effect: { tag: "sound effect", folder: "Sound effects" } } as const;
export type Sound = keyof typeof SOUNDS;

// ── shot descriptions (tasks/flywheel/PLAN.md stage 2) ─────────────────────────────────────────────────────────────

/**
 * A video's picture as numbers, one per frame read (api/library/look.ts readPicture): sent by whichever computer can
 * read the file (the server, the studio's worker, a Mac), so the server finds the same stretches wherever it was read.
 */
export interface PictureSignal {
  fps: number;
  step: number[];
  cut: number[];
  lag: number[];
  /** each frame's odds (0 to 1) of a cut and of being in a transition, where the reading computer ran the cut model
   * (api/library/cuts.ts; the Mac app's CutModel.swift): the cuts are then found from them, else measured (cutsOf) */
  one?: number[];
  many?: number[];
}

/**
 * One stretch of a video between picture changes (a cut, or a long take split where it changes most), described by
 * the person's own AI with the workspace's context: what happens, how much, and whether its subject is easy to see.
 * Never who anyone is. The person can write their own line, which wins over the AI's.
 */
export interface Stretch {
  versionId: string;
  /** its place in the video, from 0 */
  seg: number;
  a: number;
  b: number;
  /** 0 still … 1 the most movement in this video */
  motion: number;
  /** 0 nothing changes (a menu, loading, standing) … 5 a peak of the action */
  action: number;
  /** the main subject is easy to see */
  clear: boolean;
  /** up to STRETCH_TAGS short free words */
  tags: string[];
  /** what happens, named in the workspace's words */
  text: string;
  /** 64-bit picture hash of its middle frame, hex */
  ph: string;
  /** how well it is taken, measured (api/library/look.ts qualityOf): 1 sharp, well exposed and steady … 0; null: not measured */
  quality: number | null;
  /** "blurry", "too dark", "shaky": a measure past its line */
  flaws: string[];
  source: "ai" | "user";
  /** the context stamp it was written under (lib/workshop/context.ts contextStamp) */
  stamp: string;
}
export const STRETCH_TEXT_MAX = 200;
export const STRETCH_TAGS = 3;

/**
 * POST /api/library/:id/versions/:versionId/stretches: lines another computer's look wrote for a video's stretches
 * (the ones POST …/picture answered with), under the context stamp it was written with. Each is checked and capped as
 * the server's own are.
 */
export interface StretchLines {
  stamp: string;
  lines: { seg: number; text: string; action: number; clear: boolean; tags: string[]; ph: string }[];
}

/** The file at the top of a copy's folder (contracts/devices.ts COPY_KIND): which copy it is, and each file copied, by key. */
export const COPY_MARKER = ".creatortoolset-copy.json";
export interface CopyMarker {
  library: string;
  copy: string;
  files: Record<string, { asset: string; n: number; rel: string; size: number; sha256: string }>;
}

/** A copy of the library in a folder on a computer (Settings → Media Library → Copies; api/library/copies.ts). */
export interface LibraryCopy {
  id: string;
  /** the computer's id and name; the folder on it */
  device: string;
  computer: string;
  path: string;
  /** files not in the copy yet */
  pending: number;
  /** a file is being copied now */
  copying: boolean;
  /** "reconnect": the folder or its marker is not there; "full": its disk is full */
  state: "new" | "ok" | "reconnect" | "full";
  /** when its computer was last heard from, while it is offline */
  offlineSince?: number;
  /** the computer that holds files this copy waits for, while it is offline or the files are only there */
  waitsFor?: string;
  /** files this copy lacks whose original is on no server and no computer any more ("No original for N files") */
  noOriginal?: number;
  /** files only another computer holds, which the server keeps no original of for a copy while the library's Upload to
   *  the server is not "Video files and proxies" ("Needs Upload to the server") */
  needsUpload?: true;
  /** kept by a copier the app does not run (a plug-in's): no menu */
  readOnly?: true;
}

/** One file a plug-in adds to every copy of a library (ServerPlugin.copySource): `key` stable, `rel` its path in the copy. */
export interface CopyItem {
  key: string;
  asset: string;
  rel: string;
  size: number;
  sha256?: string;
}

/** GET /api/library/:id/where?versions=a,b&device=<id>: where each version is (at most PLACES_MAX ids, only ones the caller
 *  may see), with the word for it seen from `device` (none: any of the person's computers). */
export interface WhereAnswer {
  versions: Record<string, WhereIs & { word: PlaceWord }>;
}

/**
 * Every label and tooltip more than one surface shows (owner page, member page, setup, chat), written once
 * (UNIFIED-PRD §2, SCREENS-COPY.md). Folder labels live in contracts/storage.ts (FOLDER_LABELS).
 */
export const LIBRARY_WORDS = {
  notFootage: "Inside Source media: not imported as footage",
  foldersTitle: "Folders",
  setupTitle: "Let's set up the Media Library",
  analysisStep: "Analysis and organization",
  folderInMacApp: "Folders are added in the Mac app.",
  downloadMacApp: "Download the Mac app",
  smartFoldersStatus: "Clips filed into a folder for each shoot.",
  organizeYourselfStatus: "Every clip in one list, newest first.",
  defaultFolders: { label: "Use default folders", tip: "Source media, Project files and Final exports are made in ~/Movies/Creator Toolset/<workspace>." },
  notSet: "Not set",
  organizationTitle: "Organization",
  smartFolders: { label: "Smart folders", tip: "Clips and photos are filed into a folder for each shoot, by the day and place they were filmed, as they come in. What they show becomes tags. Files on disk never move." },
  organizeYourself: { label: "Organize yourself", tip: "Every clip goes into one library. You make and fill the folders yourself." },
  proxyTitle: "Proxy workflow",
  generateProxies: { label: "Generate proxies for imported media", tip: "Creates smaller copies of your media files for faster uploads, playback and editing, and easier AI processing. Edits still make proxies of the clips they use." },
  proxyQuality: { label: "Proxy quality", tip: "Higher quality looks sharper while editing and takes more space. A proxy is never larger than its original." },
  hostedTitle: "Hosted media",
  uploadToServer: "Upload to server",
  originals: "Originals",
  proxies: "Proxies",
  finalExportsUpload: { label: "Final exports", tip: "Finished videos are uploaded so they can be reviewed and shared." },
  proxiesUpload: { tip: "Smaller copies of every clip are uploaded, so your team can play and edit them. The originals stay on your computers." },
  originalsUpload: { tip: "The full files are uploaded, so they can be downloaded anywhere." },
  blurFaces: { label: "Blur faces", tip: "Only blurred videos leave your computers. Originals are never uploaded, shared or shown to your team." },
  blurred: "Blurred",
  blurredUpload: { tip: "The blurred video of each clip is uploaded, so your team can play it. The originals stay on your computers." },
  notBlurred: "Not blurred yet",
  noServer: "No server connected",
  sourceMediaTip: "Where your media is kept, with all its subfolders. Files you add in the app are saved to the first folder.",
  projectFilesTip: "Where project work is saved: edits, renders and test renders.",
  finalExportsTip: "Where finished, clean exports are saved.",
  insideSourceMedia: "Inside Source media: not imported as footage",
  addFolder: "Add folder…",
  setFolder: "Set…",
  chooseFolder: "Choose…",
  changeFolder: "Change…",
  removeFolder: "Remove",
  libraryFolder: { label: "Library folder", tip: "Source media, Project files and Final exports are kept inside this folder." },
  folderWillBeMade: "Will be created",
  chooseEachFolder: "Choose each folder",
  /** the line over the three folders in the Library folder (11-19 sign-off B2/B3/B5) */
  foldersWillBeMade: "These folders will be created:",
  foldersInIt: "Using the folders already in it:",
  /** the owner page's box when the three are not in one Library folder */
  foldersInUse: "Using these folders:",
  foldersBeside: "Beside the first Source media folder:",
  dropMedia: "Drop media here",
  chooseFiles: "Choose files",
  noClipsYet: "No clips yet",
  proxiesHostedOn: "On while proxies are hosted",
  recommended: "Recommended",
  budget: {
    label: "Monthly budget",
    tip: "Analysis waits until next month once this workspace's library has spent this.",
    noLimit: "No limit",
    amount: "a month",
  },
  analysisTitle: "Analysis",
  effort: "Effort",
  effortTips: {
    off: "Imports only: file name, date, length and camera data. Nothing is analyzed until an edit needs it.",
    low: "Transcripts, plus a description and tags for each clip.",
    medium: "Everything in Low, plus what's on screen every 12–24 seconds.",
    high: "Everything in Medium, with what's on screen every 4–8 seconds, plus a video breakdown.",
    xhigh: "Everything in High, with what's on screen every 2–4 seconds.",
    max: "Everything in Extra high, and talking-head clips are described shot by shot too.",
  } satisfies Record<AnalysisLevel, string>,
  modelsTitle: "Models",
  descriptions: "Descriptions",
  descriptionsTip: "Writes what each clip and each shot shows, with tags. Your choice, in every workspace.",
  videoBreakdown: "Video breakdown",
  videoBreakdownTip: "Watches each video with its sound and lists what happens, with times. Set for this workspace.",
  transcripts: "Transcripts",
  transcriptsTip: "Turns speech into text, with times. Your choice, in every workspace.",
  sameAsDefault: "Same as default",
  needsKey: (name: string) => `Needs ${name} key`,
  apiKeys: "API keys",
  noModelsYet: "No AI connected yet.",
  providers: "Providers",
  download: "Download",
  downloading: "Downloading",
  downloadsTitle: "Downloads",
  setupCard: (workspace: string) => `Set up the Media Library for ${workspace} first`,
  /** a workspace whose name is known nowhere, in a card's sentence */
  thisWorkspace: "this workspace",
  setupCardMember: "This Media Library isn't set up yet: the workspace's owner sets it up.",
  setupButton: "Set up",
  downloadsCard: "This edit needs the files on your computer, and Automatic downloads is off. Turn it on?",
  downloadsButton: "Turn on",
  downloadsDone: (ask: string) => `Automatic downloads is on. Continuing: ${ask}`,
  projectsCard: (workspace: string) => `Project files folder for ${workspace}`,
  projectsUse: (path: string) => `Use ${path}`,
  projectsChoose: "Choose…",
  projectsSet: "Set: the edit carries on",
  projectsLine: (computer?: string) => `The edit waits for this folder on ${computer || "your computer"}, and carries on by itself once it is set.`,
  exportsCard: (workspace: string) => `Final exports folder for ${workspace}`,
  exportsLine: (computer?: string) => `Finished videos go into this folder on ${computer || "your computer"}.`,
  quickSetupLine: (base: string, computer?: string) =>
    `Makes Source media, Project files and Final exports in ${base} on ${computer || "your computer"}, copies imports in, with 720p proxies, High analysis and Smart folders.`,
  quickSetupButton: "Set up",
  customiseButton: "Customise",
  redo: "Redo",
  redoAll: "Redo all",
  forClips: (n: number) => (n === 1 ? "For 1 clip" : `For ${n} clips`),
} as const;

/**
 * One thing the person has to do before a tool or step can go on (UNIFIED-PRD §3.5, §4.7, §4.8; the one card contract
 * for every client, lane-d D14-CONTRACT.md). A tool answers `{ [ACTION_NEEDED]: ActionNeeded }`; every client draws the
 * card from `title`, `line`, `actions` and `missing` alone, and the server moves the chat on once it is done (setup: the
 * library's setupAt; downloads: Downloads "needed"; projects: the folder row is made and the waiting job is taken again).
 */
export type ActionAsk =
  // an AI Editor job waits for the workspace's Project files (or Final exports) folder on `device` (api/devices-storage.ts
  // ensureUseFolder; never made by itself, only by the person's tap); `path` is the default offered (libraryBase/<folder> on that computer). null: no computer of the
  // account's matched (`deviceName` is what it was called), and the card says so
  | { kind: "projects" | "exports"; workspace: string; workspaceName: string; device: string | null; deviceName?: string; path: string }
  | { kind: "downloads"; libraryId: string; workspace: string }
  | { kind: "setup"; workspace: string; workspaceName: string; owner: boolean; href: string; libraryId: string; device: string | null; deviceName?: string; defaults: QuickSetup };
export type CardAction = {
  id: "use_default" | "choose" | "turn_on" | "quick_setup" | "customise" | "retry";
  label: string;
  primary?: boolean;
  /** sent as the signed-in session, `workspace` as X-CT-Workspace; a retry with no call re-asks GET /api/assistant/action/:stepId */
  call?: { method: "GET" | "POST" | "PUT" | "PATCH"; path: string; body?: Record<string, unknown>; workspace?: string };
  /** the folder browser (GET /api/devices/:device/browse); the pick is POSTed to /api/devices/storage/folders */
  browse?: { device: string; role: "projects" | "library" | "footage"; workspace: string; start?: string };
  open?: string;
};
export type ActionNeeded = ActionAsk & { title: string; line: string; missing?: "computer"; actions: CardAction[] };
/** What an AI Editor job waits on for its Project files or Final exports folder: that folder's card, or the setup card
 *  while the workspace's Media Library is not set up (ensureUseFolder). */
export type FolderAsk = Extract<ActionNeeded, { kind: "projects" | "exports" | "setup" }>;
/** The setup card's defaults (Quick setup), as the card shows them; POST /api/library/:id/setup/quick stores them. */
export type QuickSetup = { base: string; proxy: true; proxyQuality: "720p"; effort: "high"; organize: "smart"; hosted: HostedMix };
export const quickSetup = (base: string): QuickSetup => ({ base, proxy: true, proxyQuality: "720p", effort: "high", organize: "smart", hosted: HOSTED_DEFAULT });
/** The line of a card whose computer the server can't find (`missing: "computer"`). */
export const cantFind = (computer?: string) => `Can't find ${computer || "your computer"} right now: open Creator Toolset on it`;
export const RETRY = "Retry";

/** The card for an ask: its title, line and buttons, the same on the web, the Mac app and the phone. */
export function actionCard(a: ActionAsk): ActionNeeded {
  const retry: CardAction = { id: "retry", label: RETRY, primary: true };
  if (a.kind === "downloads")
    return { ...a, title: LIBRARY_WORDS.downloadsTitle, line: LIBRARY_WORDS.downloadsCard, actions: [{ id: "turn_on", label: LIBRARY_WORDS.downloadsButton, primary: true, call: { method: "PUT", path: "/api/library/offline/downloads", body: { library: a.libraryId, mode: "needed" }, workspace: a.workspace } }] };
  if (a.kind === "setup") {
    if (!a.owner) return { ...a, title: LIBRARY_WORDS.setupCard(a.workspaceName), line: LIBRARY_WORDS.setupCardMember, actions: [] };
    if (!a.device) return { ...a, title: LIBRARY_WORDS.setupCard(a.workspaceName), line: cantFind(a.deviceName), missing: "computer", actions: [retry] };
    return {
      ...a,
      title: LIBRARY_WORDS.setupCard(a.workspaceName),
      line: LIBRARY_WORDS.quickSetupLine(a.defaults.base, a.deviceName),
      actions: [
        { id: "quick_setup", label: LIBRARY_WORDS.quickSetupButton, primary: true, call: { method: "POST", path: `/api/library/${a.libraryId}/setup/quick`, body: { device: a.device }, workspace: a.workspace } },
        { id: "customise", label: LIBRARY_WORDS.customiseButton, open: a.href },
      ],
    };
  }
  const role = a.kind === "projects" ? "projects" : "library";
  const title = a.kind === "projects" ? LIBRARY_WORDS.projectsCard(a.workspaceName) : LIBRARY_WORDS.exportsCard(a.workspaceName);
  if (!a.device) return { ...a, title, line: cantFind(a.deviceName), missing: "computer", actions: [retry] };
  return {
    ...a,
    title,
    line: a.kind === "projects" ? LIBRARY_WORDS.projectsLine(a.deviceName) : LIBRARY_WORDS.exportsLine(a.deviceName),
    actions: [
      { id: "use_default", label: LIBRARY_WORDS.projectsUse(a.path), primary: true, call: { method: "POST", path: "/api/devices/storage/folders", body: { role, host: a.device, path: a.path, make: true }, workspace: a.workspace } },
      { id: "choose", label: LIBRARY_WORDS.projectsChoose, browse: { device: a.device, role, workspace: a.workspace, start: "~" } },
    ],
  };
}
export const ACTION_NEEDED = "action_needed";
export const LIBRARY_SETUP_DONE = "library-setup-done";
