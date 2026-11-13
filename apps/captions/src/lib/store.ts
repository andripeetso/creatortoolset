import { create } from "zustand";
import { extractAudio } from "./audio";
import { alignDocumentTokens } from "./align";
import { applyMasterToClip } from "./applyMaster";
import {
  boxCaps,
  cadenceFitOf,
  fillCueGaps,
  layoutCues,
  naturalCueEnds,
  segmentCues,
  snapPosSegments,
  spliceRangeIntoCues,
  nextCueId,
  type CadenceFit,
} from "./captions";
import {
  aiStatus,
  cancelCadenceRequest,
  refineSegments,
  refineSplits,
  checkAgainstScript,
} from "./refine";
import {
  applyScriptEdits,
  MAX_SCRIPT_CHARS,
  type ScriptFix,
} from "./script-check";
import { storedAutoCadence } from "./cadence-preference";
import {
  clearMarks,
  cuesFitBox,
  layoutGroups,
  marksFromCues,
  tooWideThoughts,
  unplannedBreaks,
  withSplits,
} from "./caption-layout";
import type { PosSegment, TextOverlay } from "./types";
import {
  transcribeAudio,
  transcribeCloud,
  UseBrowser,
  detectDevice,
  persistEngine,
  storedEngine,
  CLOUD_MODEL_ID,
  FIRST_JOB_MODEL,
  MODELS,
} from "./transcribe";
import { isMobileDevice } from "./mobile";
import {
  BUSY_PHASES,
  DEFAULT_STYLE,
  type CaptionStyle,
  type Cue,
  type TranscribeStatus,
  type Word,
} from "./types";

/** Singleton handle to the <video> element so any component can seek/play. */
export const playerRef: { video: HTMLVideoElement | null } = { video: null };

/** The cadence outcome for the clip on screen only ("idle" for any other clip). */
export function activeCadenceOutcome(state: {
  activeClipId: string | null;
  cadenceRunOutcome: StudioState["cadenceRunOutcome"];
  cadenceOutcomeClipId: string | null;
}): StudioState["cadenceRunOutcome"] {
  return state.cadenceOutcomeClipId === state.activeClipId
    ? state.cadenceRunOutcome
    : "idle";
}

/** The active clip cannot be played or edited while cadence is being resolved. */
export function isCadenceBusy(state: {
  refining: boolean;
  status: TranscribeStatus;
}): boolean {
  return state.refining || state.status.phase === "matching";
}

/**
 * One editor-wide lock for every caption-processing phase. Keeping this
 * separate from `isCadenceBusy` lets the UI retain cadence-only actions (Stop)
 * while playback and editing obey one consistent busy-state rule.
 */
export function isEditorBusy(state: {
  refining: boolean;
  status: TranscribeStatus;
}): boolean {
  return state.refining || BUSY_PHASES.has(state.status.phase);
}

/**
 * A clip in the project's pool. The editor's top-level state (words,
 * cues, style, videoUrl, …) always mirrors the ACTIVE clip; ClipInfo is
 * the lightweight per-clip record shown in the clip bar, and the full
 * editor state of inactive clips lives in `clipSlots` below.
 */
export interface ClipInfo {
  id: string;
  name: string;
  videoUrl: string;
  duration: number;
  /** Original clip resolution (0 = unknown). */
  sourceWidth: number;
  sourceHeight: number;
  srcFps: number | null;
  status: TranscribeStatus;
  /** True once the clip has a transcript (words exist). */
  transcribed: boolean;
  /** Upload pipeline: local (unsaved) → uploading → processing → done. */
  uploadState: "local" | "uploading" | "processing" | "done" | "error";
  uploadPct: number;
  uploadError: string | null;
  /** The server still holds the uploaded source (needed for burn-in). */
  hasOriginal: boolean;
  originalBytes: number;
  /** User marker: this variation is finished (reviewed/exported). */
  done: boolean;
}

/** Caption transfer only needs a settled transcript, not an uploaded video. */
export function isMasterApplyReady(clip: ClipInfo): boolean {
  return (
    clip.transcribed && !isEditorBusy({ status: clip.status, refining: false })
  );
}

/** Full editor state of a clip — swapped in/out on clip switches. */
export interface ClipSnapshot {
  words: Word[];
  cues: Cue[];
  /**
   * The clip's first engine transcript, captured when it landed. Full
   * re-transcribes replace it; range re-transcribes and manual edits
   * don't (they count as user edits). Apply-master diffs the master's
   * current words against this to learn exactly what the user fixed,
   * and aligns targets against it engine-to-engine. Null on saves that
   * predate the field (apply-master then knows no word edits).
   */
  originalWords: Word[] | null;
  style: CaptionStyle;
  posSegments: PosSegment[];
  texts: TextOverlay[];
  cadenceApplied: boolean;
  /** Box capacity the cadence grouping was sized for (stale detection). */
  cadenceFit: CadenceFit | null;
  /** The cadence grouping was edited (transcript/range re-transcribe). */
  cadenceDirty: boolean;
  /** User marker: this variation is finished. */
  done: boolean;
  peaks: Float32Array | null;
  pcm: Float32Array | null;
  /** Original local file — retained for recovery and upload-free export. */
  file: File | null;
}

/**
 * Inactive clips' editor state, keyed by clip id. Kept outside zustand:
 * the PCM/peaks buffers are big and the slot map is only read on
 * switches, transcription and saves — never rendered.
 */
const clipSlots = new Map<string, ClipSnapshot>();

/** Snapshot of a clip's editor state (used by saves and batch export). */
export function getClipSnapshot(id: string): ClipSnapshot | null {
  return clipSlots.get(id) ?? null;
}

/** What a clip renders from: the live editor for the active clip, its slot otherwise. */
export function clipRenderData(clipId: string) {
  const s = useStudio.getState();
  if (clipId === s.activeClipId) {
    return {
      cues: s.cues,
      style: s.style,
      posSegments: s.posSegments,
      texts: s.texts,
      duration: s.duration,
      width: s.sourceWidth || s.videoWidth,
      height: s.sourceHeight || s.videoHeight,
    };
  }
  const slot = clipSlots.get(clipId);
  const clip = s.clips.find((c) => c.id === clipId);
  if (!slot || !clip) return null;
  return {
    // passes that rebuild a background clip write its slot directly
    cues: slot.style.fillGaps ? fillCueGaps(slot.cues, clip.duration) : slot.cues,
    style: slot.style,
    posSegments: slot.posSegments,
    texts: slot.texts,
    duration: clip.duration,
    width: clip.sourceWidth,
    height: clip.sourceHeight,
  };
}

/** Retain/re-attach an original File for resumable upload and local export. */
export function retainClipSourceFile(id: string, file: File): boolean {
  const slot = clipSlots.get(id);
  const clip = useStudio.getState().clips.find((entry) => entry.id === id);
  if (!slot || !clip) return false;
  slot.file = file;
  updateClipInfo(id, {
    uploadState: "local",
    uploadPct: 0,
    uploadError: null,
    hasOriginal: false,
    originalBytes: 0,
  });
  if (useStudio.getState().activeClipId === id) {
    useStudio.setState({ importedFile: file });
  }
  return true;
}

/** Replace the whole slot registry (persist's project load). */
export function loadClipSlots(entries: [string, ClipSnapshot][]): void {
  clipSlots.clear();
  for (const [id, slot] of entries) clipSlots.set(id, slot);
  useStudio.setState({ projectLibraryOpen: false });
}

function blankSlot(style: CaptionStyle): ClipSnapshot {
  return {
    words: [],
    cues: [],
    originalWords: null,
    style,
    posSegments: [],
    texts: [],
    cadenceApplied: false,
    cadenceFit: null,
    cadenceDirty: false,
    done: false,
    peaks: null,
    pcm: null,
    file: null,
  };
}

/** Patch one clip's record in the store's clips array. */
function updateClipInfo(id: string, patch: Partial<ClipInfo>): void {
  useStudio.setState((s) => ({
    clips: s.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)),
  }));
}

/**
 * persist.ts registers its clip-save here (avoids a store ⇄ persist
 * import cycle). Called when a background clip's transcript lands.
 */
export let saveClipHook: ((clipId: string) => void) | null = null;
export function setSaveClipHook(fn: typeof saveClipHook): void {
  saveClipHook = fn;
}

/**
 * persist.ts registers its remote cleanup here. clipId null means the
 * last clip was removed — delete the whole project server-side.
 */
export let clipRemovedHook:
  ((projectId: string, clipId: string | null) => void) | null = null;
export function setClipRemovedHook(fn: typeof clipRemovedHook): void {
  clipRemovedHook = fn;
}

/**
 * persist.ts registers its clip-order save here. Fired by moveClip —
 * a reorder changes no editor state, so the autosave wouldn't see it.
 */
export let clipReorderedHook: (() => void) | null = null;
export function setClipReorderedHook(fn: typeof clipReorderedHook): void {
  clipReorderedHook = fn;
}

/**
 * Batch transcription queue. Clips are transcribed strictly one at a
 * time (the local Whisper engine is CPU/WASM-bound; cloud keeps rate
 * limits happy) with the project's current engine.
 */
const transcribeQueue: string[] = [];
let transcribeRunning = false;

let activeAudioPreparation: {
  clipId: string;
  controller: AbortController;
} | null = null;

interface ActiveCadenceRequest {
  clipId: string;
  requestId: string;
  controller: AbortController;
}

let activeCadenceRequest: ActiveCadenceRequest | null = null;

/** Running script checks, by clip id. */
const activeScriptChecks = new Map<string, AbortController>();

function abortScriptChecks(): void {
  for (const controller of activeScriptChecks.values()) controller.abort();
  activeScriptChecks.clear();
}

function cadenceRequestId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `cadence-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function enqueueTranscription(ids: string[]): void {
  // the server is making this project's captions: a run here would be a second one, and its save would be refused
  if (useStudio.getState().serverCaptioning) return;
  for (const id of ids) {
    if (!transcribeQueue.includes(id)) transcribeQueue.push(id);
  }
  void runTranscribeQueue();
}

async function runTranscribeQueue(): Promise<void> {
  if (transcribeRunning) return;
  transcribeRunning = true;
  try {
    while (transcribeQueue.length) {
      const id = transcribeQueue.shift()!;
      const ok = await transcribeClip(id);
      const phase = () =>
        useStudio.getState().clips.find((clip) => clip.id === id)?.status
          .phase;
      if (ok && phase() === "checking") await autoCheckScript(id);
      if (ok && phase() === "matching") await autoMatchCadence(id);
    }
  } finally {
    transcribeRunning = false;
  }
}

/** The only writer of a clip's processing phase, mirrored to the editor when it's on screen. */
function setClipPhase(id: string, phase: TranscribeStatus): void {
  updateClipInfo(id, { status: phase });
  if (useStudio.getState().activeClipId === id) {
    const holds = BUSY_PHASES.has(phase.phase);
    if (holds) playerRef.video?.pause();
    useStudio.setState({ status: phase, ...(holds ? { playing: false } : {}) });
  }
}

/** The one cadence outcome writer: it says which clip the outcome belongs to. */
function cadenceOutcomePatch(clipId: string | null, outcome: StudioState["cadenceRunOutcome"]) {
  return { cadenceRunOutcome: outcome, cadenceOutcomeClipId: clipId };
}

function phaseOf(id: string): string | undefined {
  return useStudio.getState().clips.find((c) => c.id === id)?.status.phase;
}

/** Resolves once no cadence pass holds the lock (a manual one or another clip's). */
async function waitForCadenceIdle(): Promise<void> {
  while (useStudio.getState().refiningClipId) {
    await new Promise<void>((resolve) => {
      const unsub = useStudio.subscribe((st) => {
        if (!st.refiningClipId) {
          unsub();
          resolve();
        }
      });
    });
  }
}

/**
 * A fresh transcript, read against the project's script before cadence
 * groups it: fixed words then land in the grouping. Skipped (straight on
 * to cadence or done) when the AI pass isn't available, fails, or is
 * stopped — the transcript as heard is still a transcript.
 */
async function autoCheckScript(id: string): Promise<void> {
  const status = await aiStatus().catch(() => null);
  const stillChecking = () =>
    useStudio.getState().clips.find((c) => c.id === id)?.status.phase ===
    "checking";
  if (status?.available && status.allowed && stillChecking()) {
    await useStudio.getState().checkScript(id).catch(() => {});
  }
  // the clip could have been re-queued/removed mid-check — only close the
  // phase this run opened
  if (stillChecking()) {
    setClipPhase(
      id,
      useStudio.getState().autoCadence ? { phase: "matching" } : { phase: "done" },
    );
  }
}

/**
 * First-shot cadence: right after a transcription lands, re-group its
 * captions with the AI pass so the transcript the user first sees already
 * matches the speech rhythm. Falls back to the deterministic grouping
 * when the pass isn't configured or fails. The clip's status shows
 * "matching" in between, holding the done-reveal (the mobile flow
 * advances on done) until the matched cues are in.
 */
async function autoMatchCadence(id: string): Promise<void> {
  const s = useStudio.getState();
  if (!s.clips.some((c) => c.id === id)) return;
  if (!clipSlots.get(id)?.words.length) return;
  // hold the done-reveal synchronously — anything advancing on "done"
  // (the mobile flow) must wait for the outcome, available or not
  setClipPhase(id, { phase: "matching" });
  useStudio.setState(cadenceOutcomePatch(id, "running"));
  const status = await aiStatus().catch(() => null);
  // The user may have stopped the pass while availability was resolving.
  if (phaseOf(id) !== "matching") return;
  // a manual pass (or another clip's) holds the lock: wait, don't skip this clip
  await waitForCadenceIdle();
  if (phaseOf(id) !== "matching") return;
  if (status?.available && status.allowed) {
    await s.refineCues(id).catch(() => {});
  } else {
    useStudio.setState(cadenceOutcomePatch(id, "failed"));
  }
  // the clip could have been re-queued/removed mid-pass — only close the
  // phase we opened
  if (phaseOf(id) === "matching") setClipPhase(id, { phase: "done" });
}

/** Clear queued-but-not-started transcriptions (project switch/reset). */
function clearTranscribeQueue(): void {
  transcribeQueue.length = 0;
  activeAudioPreparation?.controller.abort();
  activeAudioPreparation = null;
}

/**
 * File drops bypass the <input accept> filter, so non-videos have to be
 * weeded out here — one bad file would otherwise become a broken clip.
 * Pool order is deterministic: name-sorted (clip01, clip02, …).
 */
const VIDEO_EXT = /\.(mp4|webm|mov|mkv|m4v|avi|mts|m2ts|mpg|mpeg|3gp|ts)$/i;
function prepareImport(files: File[]): File[] {
  return files
    .filter((f) => f.type.startsWith("video/") || VIDEO_EXT.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/**
 * crypto.randomUUID needs a secure context — http over a LAN IP isn't
 * one, so falling back keeps imports working there. Either shape passes
 * the server's id check (lowercase alnum + dashes, 6–40 chars).
 */
function newClipId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `clip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function newProjectId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

interface StudioState {
  videoUrl: string | null;
  /** The project/import view was explicitly opened from the tool hub. */
  projectLibraryOpen: boolean;
  openProjectLibrary: () => void;
  /**
   * The imported File handle, kept so the upload can stream it directly —
   * round-tripping multi-GB imports through fetch(blobUrl).blob() can fail
   * in Chrome. Null once playback runs on the server proxy.
   */
  importedFile: File | null;
  /** Why the last project save/upload failed (shown on the header badge). */
  saveError: string | null;
  /** Browser-disk recovery snapshot, independent of server/media upload. */
  localSaveState: "idle" | "saving" | "saved" | "error";
  localSaveError: string | null;
  fileName: string;
  /** Dimensions of the video being PLAYED (may be a low-res proxy). */
  videoWidth: number;
  videoHeight: number;
  /**
   * Original clip resolution (0 = unknown → falls back to videoWidth/
   * videoHeight). All pixel values in the UI are in source pixels; the
   * proxy is only a lightweight preview.
   */
  sourceWidth: number;
  sourceHeight: number;
  duration: number;
  peaks: Float32Array | null;
  pcm: Float32Array | null;

  currentTime: number;
  playing: boolean;

  words: Word[];
  cues: Cue[];
  style: CaptionStyle;
  activePreset: string | null;
  /** Caption position track: time segments with per-range box overrides. */
  posSegments: PosSegment[];
  /** Manual text-on-screen overlays, each its own timeline layer clip. */
  texts: TextOverlay[];
  selectedTextId: number | null;

  status: TranscribeStatus;
  model: string;
  /** Automatically run the cadence pass when a fresh transcript lands. */
  autoCadence: boolean;
  setAutoCadence: (enabled: boolean) => void;
  /** The project's clip pool. Top-level editor state mirrors the active one. */
  clips: ClipInfo[];
  activeClipId: string | null;
  /** Clip the AI cadence pass is running for (null = none running). */
  refiningClipId: string | null;
  /**
   * True while the ACTIVE clip's cadence pass runs — the transcript,
   * box and timeline locks read this. False when another clip's pass is
   * running in the background (its own editing is locked only while
   * it's active).
   */
  refining: boolean;
  /** Last cadence-pass failure, shown in the style panel. */
  refineError: string | null;
  /**
   * The active clip's transcript was written by another engine than the person's (their computers were off): why, shown
   * quietly for a while (Player). A new object each run, so the same words show again.
   */
  transcribeNote: { text: string } | null;
  /** Outcome of the most recent cadence request; drives truthful completion UI. */
  cadenceRunOutcome: "idle" | "running" | "completed" | "cancelled" | "failed";
  /** The clip the outcome above belongs to; read it through activeCadenceOutcome. */
  cadenceOutcomeClipId: string | null;
  /**
   * The current cue grouping came from the AI cadence pass. While true,
   * resizing the caption box (or changing the font size) never re-segments
   * — the grouping is the source of truth and the transcript lines stay
   * put. A capacity change instead makes the cadence STALE (see
   * cadenceFit), offering an explicit re-match. Cleared by anything that
   * re-flows the captions: a new transcription, or an explicit
   * segmentation-mode change (words-per-caption / fit-box).
   */
  cadenceApplied: boolean;
  /**
   * Box capacity (boxW/boxH/fontSizePct) at the moment the cadence pass
   * landed. When the live style drifts from it the grouping no longer
   * fits the box — cadenceStale() — and the UI offers a re-match. Null
   * unless cadenceApplied.
   */
  cadenceFit: CadenceFit | null;
  /**
   * The transcript was edited after the cadence pass landed (words
   * fixed, captions split/merged, a range re-transcribed) — the grouping
   * is now the user's own, so the cadence button offers a re-match.
   * Cleared when a pass (re-)lands. Irrelevant unless cadenceApplied.
   */
  cadenceDirty: boolean;
  transcriptVisible: boolean;
  /** Project frame rate — drives timecode display and export default. */
  fps: number;
  setFps: (fps: number) => void;
  /**
   * Detected source frame rate: the server's ffprobe of the uploaded
   * original, or a playback estimate for clips the server never sees.
   * Null until known. Feeds `fps` unless the user picked one themselves.
   */
  srcFps: number | null;
  setSrcFps: (fps: number, source: "probe" | "estimate") => void;
  /** True once the user explicitly chose an fps — detection stops overriding. */
  fpsManual: boolean;
  /** Stable client-generated project id; null only when no project is open. */
  projectId: string | null;
  /** The idempotent server-side project shell has been confirmed. */
  serverProjectReady: boolean;
  /** Optimistic server revision used by conflict-safe project sync. */
  serverRevision: number;
  /** A newer server revision exists; local work is preserved as a conflict. */
  serverConflict: boolean;
  /**
   * The server itself is making this project's captions (a video sent from the assistant's chat,
   * api/captions-job.ts): nothing transcribes here meanwhile, and the captions come in when they are saved.
   */
  serverCaptioning: boolean;
  /**
   * A fresh import shows the project-setup dialog (name + how to caption)
   * while the upload runs in the background. Cleared on dismiss, on
   * loading a saved session, and on reset.
   */
  setupPending: boolean;
  dismissSetup: () => void;
  /** Rename the project — autosaved once the project exists on the server. */
  setFileName: (name: string) => void;
  /**
   * Project persistence phase for data saves. Uploads are tracked per
   * clip (ClipInfo.uploadState) since a batch imports many at once.
   */
  saveState: "idle" | "saving" | "saved" | "error";

  /** Import one or more videos as a NEW project (replaces the current one). */
  importFiles: (files: File[]) => void;
  importFile: (f: File) => void;
  /**
   * Add clips to the CURRENT project's pool. They inherit the project's
   * settings (style seed, fps, engine) and are queued for transcription
   * right away.
   */
  addClips: (files: File[]) => void;
  /** Make another clip of the project active in the editor. */
  switchClip: (id: string) => void;
  /**
   * Clip-bar multi-selection (checkboxes / shift / ⌘) — shared with the
   * export dialog (export selected) and apply-master (apply to selected).
   */
  selectedClipIds: string[];
  setSelectedClipIds: (ids: string[]) => void;
  /**
   * Move a clip to a new position in the pool. The first clip is the
   * MASTER clip — its fixed transcript and cadence are the reference
   * the other clips copy via applyMasterToAll.
   */
  moveClip: (from: number, to: number) => void;
  /** Rename a clip (persists with the clip's next save — forced here). */
  renameClip: (id: string, name: string) => void;
  /** The ACTIVE clip's done marker (mirrors its slot; see ClipInfo.done). */
  done: boolean;
  /** Flip a clip's done marker (finished variations stay visible in the bar). */
  toggleClipDone: (id: string) => void;
  /** Remove a clip from the pool (server delete happens via persist). */
  removeClip: (id: string) => void;
  /** True while the master transcript is being applied to the pool. */
  applyingMaster: boolean;
  /** True while another browser tab has Caption Studio open (autosaves collide). */
  tabConflict: boolean;
  setTabConflict: (v: boolean) => void;
  /** Progress of the running apply-master pass (null = not running). */
  applyMasterProgress: { done: number; total: number } | null;
  /**
   * Per-clip outcome of the last apply-master run: clip id → match
   * coverage (0-1). Coverage below the transfer threshold means the clip
   * was skipped (different video). Cleared on the next run or reset.
   */
  masterApplyResults: Record<string, number> | null;
  /** Clip id → words inserted from the master to fill transcription holes. */
  masterApplyInserted: Record<string, number> | null;
  /** Clip id → target words corrected against the master reference. */
  masterApplyCorrected: Record<string, number> | null;
  /**
   * Replay what the user changed on the master clip (the first clip) onto
   * clips with settled transcripts, regardless of upload state: its word
   * fixes where a clip says the same words, and its caption breaks,
   * cadence and captions layer where the two share words. Everything
   * else stays each clip's own (applyMaster.ts). With `onlyIds` (a
   * clip-bar selection) only those clips are targets; without it every
   * eligible clip is. Clips that barely match the master (different
   * video) are left untouched.
   */
  applyMasterToAll: (onlyIds?: string[]) => Promise<void>;
  /** Transcribe every clip that doesn't have a transcript yet. */
  transcribeAll: () => void;

  /**
   * Decode audio (waveform peaks + transcription PCM) from the current
   * video if not already in memory. Used after playback switches to the
   * server proxy, when the raw import was too large to decode client-side.
   */
  ensureAudio: () => Promise<void>;
  setVideoMeta: (w: number, h: number, d: number) => void;
  setCurrentTime: (t: number) => void;
  setPlaying: (p: boolean) => void;
  seek: (t: number) => void;
  runTranscription: () => Promise<void>;
  /**
   * Selected timeline section in seconds (shift-drag on the tracks) —
   * the target of retranscribeRange. Cleared on clip switch/reset.
   */
  rangeSel: { start: number; end: number } | null;
  setRangeSel: (r: { start: number; end: number } | null) => void;
  /**
   * Re-run the transcription engine on just the selected section of the
   * active clip, then splice the fresh words into the transcript (the
   * rest of the captions keep their grouping). Fixes engine dead zones
   * without redoing the whole clip.
   */
  retranscribeRange: () => Promise<void>;
  /**
   * AI cadence pass: re-group the current words into cues that match the
   * speech rhythm, sized to the current caption box. Runs automatically
   * after each transcription lands (per clip, via the transcribe queue)
   * and on demand (transcript panel / caption-box re-match). `clipId`
   * targets a specific clip — including background ones; defaults to the
   * active clip. Undoable for the active clip.
   */
  refineCues: (clipId?: string) => Promise<void>;
  /**
   * Plan split points for the thought lines too wide for the current box
   * (a small AI request with just those lines). Runs right after a match
   * lands, and from "Re-match for this size" when the box got narrower.
   * The thoughts themselves don't change.
   */
  fitSplits: (clipId?: string) => Promise<void>;
  /** A fitSplits request is running for the active clip. */
  fittingSplits: boolean;
  /** Stop the active browser request and its server-side model call. */
  cancelCadence: () => void;
  /**
   * Drop the AI cadence grouping and re-segment deterministically with
   * the current style/box.
   */
  resetCadence: () => void;
  /**
   * The script the project's video was filmed from ("" = none). When set,
   * every fresh transcript is checked against it before cadence.
   */
  script: string;
  setScript: (script: string) => void;
  /**
   * AI script check: fix words the engine mis-heard, using the script as
   * the reference. Runs automatically after a transcription lands (the
   * clip's `checking` phase) and on demand for the active clip. Timings
   * and caption grouping stay; undoable for the active clip.
   */
  checkScript: (clipId?: string) => Promise<void>;
  /** Stop the running script check; the transcript stays as heard. */
  cancelScriptCheck: () => void;
  /** Clip id → what its last script check fixed (for review, not saved). */
  scriptFixes: Record<string, ScriptFix[]>;
  /** Hide the active clip's script check summary. */
  dismissScriptFixes: () => void;
  scriptCheckError: string | null;
  setStyle: (patch: Partial<CaptionStyle>) => void;
  applyPreset: (name: string, s: CaptionStyle) => void;
  setModel: (m: string) => void;
  /**
   * Commit the transcript document: one token array per line, one line
   * per caption. Word timings are preserved via alignment against the
   * current words. Returns true when the store actually changed.
   */
  applyTranscript: (lineTokens: string[][]) => boolean;
  undoEdit: () => boolean;
  redoEdit: () => boolean;
  updateCueTimes: (cueId: number, start: number, end: number) => void;
  /** Push an undo snapshot — call once at the start of a drag gesture. */
  snapshotHistory: () => void;
  /** Fill gaps on/off: captions stay up until the next one, through every re-layout. */
  fillGaps: () => void;
  toggleTranscript: () => void;
  reset: () => void;

  /** Split the caption position layer at time t (creates it on first split). */
  splitPosAt: (t: number) => void;
  /** Move every section edge to the nearest caption cut (one undo step). */
  snapPosToCues: () => void;
  /** Move a whole section in time (duration kept, clamped against neighbors). */
  movePosSegment: (id: number, start: number) => void;
  /** Trim one edge of a section — pulling away from a neighbor leaves a gap. */
  trimPosSegment: (id: number, side: "start" | "end", t: number) => void;
  /** Remove a section — captions fall back to the default position there. */
  deletePosSegment: (id: number) => void;
  setPosOverride: (id: number, x: number, y: number) => void;
  clearPosOverride: (id: number) => void;

  /** Add a text overlay at time t (selects it and opens inline editing). */
  addTextAt: (t: number) => void;
  updateText: (id: number, patch: Partial<TextOverlay>) => void;
  deleteText: (id: number) => void;
  setSelectedText: (id: number | null) => void;
  /** Text overlay currently in inline (on-video) edit mode. */
  editingTextId: number | null;
  setEditingText: (id: number | null) => void;

  /** Caption box selected on the video (enables arrow-key nudging). */
  boxSelected: boolean;
  setBoxSelected: (v: boolean) => void;
}

/**
 * The frame captions are laid out for: the source video (what exports
 * render at), falling back to the player's size. Null until known, so a
 * layout never runs against a 0×0 frame.
 */
function frameOf(s: {
  sourceWidth: number;
  sourceHeight: number;
  videoWidth: number;
  videoHeight: number;
}): { w: number; h: number } | null {
  const w = s.sourceWidth || s.videoWidth;
  const h = s.sourceHeight || s.videoHeight;
  return w > 0 && h > 0 ? { w, h } : null;
}

/**
 * The box is now narrower than the one the cadence match planned its
 * split marks for, and some lines had to break where it marked none —
 * worth offering "Re-match for this size". Re-matching at this width
 * makes this the planned width, so the offer doesn't come back until the
 * box shrinks again.
 */
export function narrowerThanMatched(s: {
  cadenceApplied: boolean;
  cadenceDirty: boolean;
  cadenceFit: CadenceFit | null;
  style: CaptionStyle;
  cues: Cue[];
  sourceWidth: number;
  sourceHeight: number;
  videoWidth: number;
  videoHeight: number;
}): boolean {
  if (!s.cadenceApplied || s.cadenceDirty || !s.cadenceFit || !s.style.fitBox) return false;
  const frame = frameOf(s);
  if (!frame) return false;
  const planned = boxCaps(
    { ...s.style, boxW: s.cadenceFit.boxW, fontSizePct: s.cadenceFit.fontSizePct },
    frame.w,
    frame.h,
  ).maxChars;
  const now = boxCaps(s.style, frame.w, frame.h).maxChars;
  return now < planned && unplannedBreaks(s.cues) > 0;
}

/**
 * Words to lay out for the live box. A grouping matched before thought
 * marks existed keeps its caption starts as marks, so resizing it
 * doesn't fall back to plain width-filling.
 */
function layoutWords(s: {
  cues: Cue[];
  words: Word[];
  cadenceApplied: boolean;
}): Word[] {
  if (s.cadenceApplied) {
    const marked = marksFromCues(s.cues);
    if (marked) return marked;
  }
  return s.cues.length ? s.cues.flatMap((c) => c.words) : s.words;
}

/** Re-lay the words out for the style's box; null when not in box mode. */
function relayout(s: {
  cues: Cue[];
  words: Word[];
  cadenceApplied: boolean;
  style: CaptionStyle;
  sourceWidth: number;
  sourceHeight: number;
  videoWidth: number;
  videoHeight: number;
}): { cues: Cue[]; words: Word[] } | null {
  const frame = frameOf(s);
  if (!s.style.fitBox || !frame) return null;
  const words = layoutWords(s);
  if (!words.length) return null;
  const cues = layoutCues(words, boxCaps(s.style, frame.w, frame.h), s.cues);
  return { cues, words: cues.flatMap((c) => c.words) };
}

function regen(
  words: Word[],
  style: CaptionStyle,
  w: number,
  h: number,
): Cue[] {
  return segmentCues(words, style, w, h);
}

/**
 * Captions from word groups, one caption per group. In box mode each
 * group wraps to the box, and only a group with more rows than the box
 * holds becomes two.
 */
function cuesFromGroups(
  groups: Word[][],
  style: CaptionStyle,
  frame: { w: number; h: number } | null,
  prev: Cue[],
): Cue[] {
  const cues: Cue[] =
    style.fitBox && frame
      ? layoutGroups(groups, boxCaps(style, frame.w, frame.h), nextCueId, {
          prev,
        })
      : groups.map((ws, i) => ({
          id: i < prev.length ? prev[i].id : nextCueId(),
          start: ws[0].start,
          end: ws[ws.length - 1].end + 0.08,
          words: ws,
        }));
  for (let i = 0; i < cues.length - 1; i++) {
    cues[i].end = Math.min(cues[i].end, cues[i + 1].start - 0.001);
  }
  return cues;
}

// --- edit history (transcript, caption sections, text overlays) ------------
type Snapshot = {
  words: Word[];
  cues: Cue[];
  posSegments: PosSegment[];
  texts: TextOverlay[];
  /** Rides along so undoing past the AI cadence apply restores fit state. */
  cadenceApplied: boolean;
  cadenceFit: CadenceFit | null;
  cadenceDirty: boolean;
};
let undoStack: Snapshot[] = [];
let redoStack: Snapshot[] = [];

function takeSnap(s: Snapshot): Snapshot {
  return {
    words: s.words,
    cues: s.cues,
    posSegments: s.posSegments,
    texts: s.texts,
    cadenceApplied: s.cadenceApplied,
    cadenceFit: s.cadenceFit,
    cadenceDirty: s.cadenceDirty,
  };
}

/** Mutations always replace these arrays, so same references = no change. */
function sameSnap(a: Snapshot, b: Snapshot): boolean {
  return (
    a.words === b.words &&
    a.cues === b.cues &&
    a.posSegments === b.posSegments &&
    a.texts === b.texts
  );
}

function pushUndo(s: Snapshot) {
  const top = undoStack[undoStack.length - 1];
  if (!top || !sameSnap(top, s)) undoStack.push(takeSnap(s));
  if (undoStack.length > 100) undoStack.shift();
  redoStack = [];
}

/** State patch restoring a snapshot; drops selection of texts that vanish. */
function restoreSnap(
  s: Snapshot,
  cur: Pick<StudioState, "selectedTextId" | "editingTextId">,
) {
  const alive = (id: number | null) =>
    id != null && s.texts.some((t) => t.id === id) ? id : null;
  return {
    words: s.words,
    cues: s.cues,
    posSegments: s.posSegments,
    texts: s.texts,
    cadenceApplied: s.cadenceApplied,
    cadenceFit: s.cadenceFit,
    cadenceDirty: s.cadenceDirty,
    selectedTextId: alive(cur.selectedTextId),
    editingTextId: alive(cur.editingTextId),
  };
}

/**
 * Undo history doesn't record the box, so a restored grouping may have
 * been laid out for a different size — re-lay it out when it doesn't fit.
 */
function refitAfterRestore(): void {
  const s = useStudio.getState();
  const frame = frameOf(s);
  if (!s.style.fitBox || !frame) return;
  if (cuesFitBox(s.cues, boxCaps(s.style, frame.w, frame.h))) return;
  const next = relayout(s);
  if (next) useStudio.setState(next);
}

/** Clear the transcript undo/redo history (also used when switching projects). */
export function clearEditHistory() {
  undoStack = [];
  redoStack = [];
}
const clearHistory = clearEditHistory;

// --- caption position track ------------------------------------------------
let posId = 1;
/** Keep generated segment ids clear of ids loaded from a saved session. */
export function bumpPosIdCounter(min: number): void {
  if (min > posId) posId = min;
}
/** Allocate a unique position-segment id (apply-master's layer transfer). */
export function nextPosId(): number {
  return posId++;
}
/** Shortest allowed position segment, seconds. */
const MIN_POS_SEG = 0.2;

/** Whether the caption sections can be split at `t`: not at the clip's very ends, and with sections there, inside one and off its ends. */
export function canSplitPosAt(posSegments: PosSegment[], duration: number, t: number): boolean {
  if (duration <= 0) return false;
  if (posSegments.length === 0) return t >= MIN_POS_SEG && t <= duration - MIN_POS_SEG;
  return posSegments.some((s) => t >= s.start + MIN_POS_SEG && t <= s.end - MIN_POS_SEG);
}

let textId = 1;
/** Keep generated text ids clear of ids loaded from a saved session. */
export function bumpTextIdCounter(min: number): void {
  if (min > textId) textId = min;
}

/**
 * Structural generation of the cue/word state. Bumped by every change
 * that would invalidate an in-flight AI cadence answer (resegmentation,
 * cue-time drags, undo/redo, transcript edits). refineCues captures it
 * before the request and discards the answer if it moved — this catches
 * changes the word-identity check can't see, like a box resize that
 * regroups the same word objects.
 */
let cueGen = 0;

/** Clips with a fitSplits request running (one at a time per clip). */
const splitsInFlight = new Set<string>();

function wordIdGen(cues: Cue[]): () => number {
  let max = 0;
  for (const c of cues) for (const w of c.words) if (w.id > max) max = w.id;
  let next = max + 1;
  return () => next++;
}

// --- clip swapping -----------------------------------------------------------

/** Freeze the live editor state into the outgoing clip's slot. */
function liveToSnapshot(s: StudioState): ClipSnapshot {
  return {
    words: s.words,
    cues: s.cues,
    // originalWords is never edited — the registry slot's copy (written
    // by transcription) stays authoritative through the swap
    originalWords: s.activeClipId
      ? (clipSlots.get(s.activeClipId)?.originalWords ?? null)
      : null,
    style: s.style,
    posSegments: s.posSegments,
    texts: s.texts,
    cadenceApplied: s.cadenceApplied,
    cadenceFit: s.cadenceFit,
    cadenceDirty: s.cadenceDirty,
    done: s.done,
    peaks: s.peaks,
    pcm: s.pcm,
    // Playback may already have switched to a server proxy, which clears the
    // live importedFile field. Never let a clip switch erase the retained
    // original that powers local export and browser recovery.
    file:
      s.importedFile ??
      (s.activeClipId ? (clipSlots.get(s.activeClipId)?.file ?? null) : null),
  };
}

/** State patch loading a clip's slot into the live editor. */
function snapshotToLive(
  clip: ClipInfo,
  snap: ClipSnapshot,
): Partial<StudioState> {
  return {
    videoUrl: clip.videoUrl,
    importedFile: snap.file,
    words: snap.words,
    cues: snap.cues,
    style: snap.style,
    posSegments: snap.posSegments,
    texts: snap.texts,
    cadenceApplied: snap.cadenceApplied,
    cadenceFit: snap.cadenceFit,
    cadenceDirty: snap.cadenceDirty,
    done: snap.done,
    peaks: snap.peaks,
    pcm: snap.pcm,
    status: clip.status,
    duration: clip.duration,
    sourceWidth: clip.sourceWidth,
    sourceHeight: clip.sourceHeight,
    srcFps: clip.srcFps,
    currentTime: 0,
    playing: false,
    selectedTextId: null,
    editingTextId: null,
    boxSelected: false,
    refineError: null,
    transcribeNote: null,
    rangeSel: null,
    // a cadence pass keeps running through clip switches — its lock
    // applies only while its own clip is on screen
    refining: useStudio.getState().refiningClipId === clip.id,
    fittingSplits: splitsInFlight.has(clip.id),
  };
}

/** Release a clip's local resources (blob URL, slot). */
function releaseClip(id: string): void {
  if (activeAudioPreparation?.clipId === id) {
    activeAudioPreparation.controller.abort();
    activeAudioPreparation = null;
  }
  const clip = useStudio.getState().clips.find((c) => c.id === id);
  if (clip?.videoUrl.startsWith("blob:")) URL.revokeObjectURL(clip.videoUrl);
  clipSlots.delete(id);
}

/**
 * Read frame dims + duration straight from a video blob (metadata only —
 * no decode). Null when the browser can't read the codec (ProRes/HEVC);
 * the server's upload probe fills those in later.
 */
function probeVideoDims(
  blob: Blob,
): Promise<{ w: number; h: number; duration: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const v = document.createElement("video");
    let settled = false;
    const done = (r: { w: number; h: number; duration: number } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(r);
    };
    const timer = setTimeout(() => done(null), 5000);
    v.preload = "metadata";
    v.muted = true;
    v.onloadedmetadata = () =>
      done(
        v.videoWidth && v.videoHeight
          ? { w: v.videoWidth, h: v.videoHeight, duration: v.duration || 0 }
          : null,
      );
    v.onerror = () => done(null);
    v.src = url;
  });
}

/**
 * Transcribe one clip with the project's engine. Works on the clip's
 * slot, so it runs identically for the active clip (mirrored into the
 * live editor) and for background clips (slot only, saved via the hook).
 * Resolves true when a fresh transcript landed (drives auto-cadence).
 */
/**
 * The page's own model on 16 kHz `pcm`: on the graphics card when there is one, and again on the processor when the
 * card fails mid-way. English-only models reject an explicit language; the others detect it (language null).
 */
async function inBrowser(pcm: Float32Array, model: string, setStatus: (s: TranscribeStatus) => void): Promise<Word[]> {
  const attempt = (device: "webgpu" | "wasm") =>
    transcribeAudio(pcm, model, null, device, {
      onLoadProgress: (progress) => setStatus({ phase: "loading", progress, detail: "" }),
      onTranscribeStart: () => setStatus({ phase: "transcribing", progress: 0 }),
    }).promise;
  if ((await detectDevice()) !== "webgpu") return attempt("wasm");
  try {
    return await attempt("webgpu");
  } catch (e) {
    console.warn("[cap-transcribe] graphics card run failed, on the processor now:", e);
    setStatus({ phase: "loading", progress: 0, detail: "" });
    return attempt("wasm");
  }
}

/**
 * The server's engine (the person's key, or their own computers: Settings → AI → Voice). When their computers can't
 * and the server has nothing else for them, the page's own model writes it, and the note says so quietly from the
 * start of that run (the progress card then shows the browser's run). A phone never downloads a model: it says why.
 */
async function fromServer(pcm: Float32Array, name: string, project: string, setStatus: (s: TranscribeStatus) => void): Promise<{ words: Word[]; note?: string }> {
  setStatus({ phase: "transcribing", progress: 0 });
  try {
    return await transcribeCloud(pcm, name, project);
  } catch (e) {
    if (!(e instanceof UseBrowser)) throw e;
    if (isMobileDevice()) throw new Error(e.why);
    useStudio.setState({ transcribeNote: { text: e.message } });
    return { words: await inBrowser(pcm, MODELS[0].id, setStatus), note: e.message };
  }
}

async function transcribeClip(id: string): Promise<boolean> {
  const s = useStudio.getState();
  const clip = s.clips.find((c) => c.id === id);
  if (!clip) return false;
  let slot = clipSlots.get(id);
  if (!slot) {
    slot = blankSlot(s.style);
    clipSlots.set(id, slot);
  }
  const isActive = () => useStudio.getState().activeClipId === id;
  // the active clip's live state may be ahead of the slot (ensureAudio
  // decodes into live state) — seed the slot from it
  if (isActive()) {
    slot.pcm = slot.pcm ?? s.pcm;
    slot.peaks = slot.peaks ?? s.peaks;
  }
  const setStatus = (status: TranscribeStatus) => setClipPhase(id, status);
  // re-transcribing? the old transcript is backed up, cleared visibly at
  // the start of the run, and restored if the run fails
  let backup: {
    words: Word[];
    cues: Cue[];
    originalWords: Word[] | null;
    cadenceApplied: boolean;
    cadenceFit: CadenceFit | null;
    cadenceDirty: boolean;
  } | null = null;
  try {
    if (slot.words.length || slot.cues.length) {
      backup = {
        words: slot.words,
        cues: slot.cues,
        originalWords: slot.originalWords,
        cadenceApplied: slot.cadenceApplied,
        cadenceFit: slot.cadenceFit,
        cadenceDirty: slot.cadenceDirty,
      };
      // status first: the autosave only fires on done/idle, so the empty
      // transcript never reaches the server while the run is in flight
      setStatus({ phase: "extracting" });
      slot.words = [];
      slot.cues = [];
      slot.cadenceApplied = false;
      slot.cadenceFit = null;
      slot.cadenceDirty = false;
      if (isActive()) {
        clearEditHistory();
        cueGen++;
        useStudio.setState({
          words: [],
          cues: [],
          cadenceApplied: false,
          cadenceFit: null,
          cadenceDirty: false,
        });
      }
    }
    // caption sizing is aspect-dependent (box capacity = chars per box) —
    // transcribing before the player metadata or the server probe landed
    // would size captions for a guessed 16:9 frame. Probe the dims from
    // the file itself first; cheap (header only) and covers the mobile
    // flow, where nothing loads the video before this point.
    let audioBlob: Blob | null = slot.file ?? null;
    if (!useStudio.getState().clips.find((c) => c.id === id)?.sourceWidth) {
      audioBlob =
        audioBlob ??
        (slot.pcm
          ? null // no local file to read; keep the server probe's fallback
          : await fetch(clip.videoUrl)
              .then((r) => r.blob())
              .catch(() => null));
      const dims = audioBlob
        ? await probeVideoDims(audioBlob).catch(() => null)
        : null;
      if (dims) {
        updateClipInfo(id, {
          sourceWidth: dims.w,
          sourceHeight: dims.h,
          ...(clip.duration ? {} : { duration: dims.duration }),
        });
        if (isActive() && useStudio.getState().sourceWidth === 0) {
          const cur = useStudio.getState();
          useStudio.setState({
            sourceWidth: dims.w,
            sourceHeight: dims.h,
            videoWidth: dims.w,
            videoHeight: dims.h,
            duration: cur.duration || dims.duration,
          });
        }
      }
    }
    const model = useStudio.getState().model;
    let pcm = slot.pcm;
    let words: Word[];
    console.log(
      `[cap-transcribe] clip=${id} engine=${model} cachedPcm=${!!pcm} slotFile=${slot.file ? `${slot.file.size}B` : "none"} videoUrl=${clip.videoUrl.slice(0, 40)}`,
    );
    // Both engines need 16 kHz mono PCM: local Whisper consumes it directly
    // and Cloud sends it as a small WAV. Demux/decode/resample all run in a
    // dedicated worker so the editor stays responsive, and the source-video
    // upload (needed only for cloud EXPORT) is never a prerequisite for
    // transcription.
    if (!pcm) {
      setStatus({
        phase: "extracting",
        progress: 0,
        detail: "Preparing audio on this device",
      });
      const blob: Blob =
        audioBlob ?? (await fetch(clip.videoUrl).then((r) => r.blob()));
      console.log(
        `[cap-transcribe] extraction source=${audioBlob ? "slot.file" : "videoUrl fetch"} bytes=${blob.size}`,
      );
      const controller = new AbortController();
      activeAudioPreparation?.controller.abort();
      activeAudioPreparation = { clipId: id, controller };
      try {
        const ex = await extractAudio(
          new File([blob], clip.name, { type: blob.type }),
          (progress, detail) =>
            setStatus({
              phase: "extracting",
              progress: Math.round(progress * 100),
              detail,
            }),
          controller.signal,
        );
        pcm = ex.pcm;
        slot.pcm = ex.pcm;
        slot.peaks = ex.peaks;
        if (!clip.duration) updateClipInfo(id, { duration: ex.duration });
        if (isActive()) {
          const cur = useStudio.getState();
          useStudio.setState({
            pcm: ex.pcm,
            peaks: ex.peaks,
            duration: cur.duration || ex.duration,
          });
        }
      } finally {
        if (activeAudioPreparation?.controller === controller) {
          activeAudioPreparation = null;
        }
      }
    }
    if (isActive()) useStudio.setState({ transcribeNote: null });
    let note: string | undefined;
    if (model === CLOUD_MODEL_ID) {
      console.log(
        `[cap-transcribe] cloud request pcmBytes=${pcm.byteLength} wavBytes~${44 + pcm.length * 2}`,
      );
      ({ words, note } = await fromServer(pcm, clip.name, s.projectId ?? "", setStatus));
      console.log(`[cap-transcribe] cloud returned words=${words.length}${note ? ` (${note})` : ""}`);
    } else {
      words = await inBrowser(pcm, model, setStatus);
    }
    // re-check the clip still exists (could be removed mid-transcription)
    const cur = useStudio.getState();
    const curClip = cur.clips.find((c) => c.id === id);
    if (!curClip) return false;
    // the slot object may have been swapped by a clip switch mid-flight —
    // write through the registry's current object, not the captured one
    let curSlot = clipSlots.get(id);
    if (!curSlot) {
      curSlot = blankSlot(slot.style);
      clipSlots.set(id, curSlot);
    }
    const cues = segmentCues(
      words,
      curSlot.style,
      curClip.sourceWidth || cur.videoWidth,
      curClip.sourceHeight || cur.videoHeight,
    );
    curSlot.words = words;
    curSlot.cues = cues;
    // a full (re-)transcription is the new baseline: apply-master diffs
    // the user's edits against this exact engine output. Copied — edit
    // paths may share word objects with the live transcript.
    curSlot.originalWords = words.map((w) => ({ ...w }));
    curSlot.cadenceApplied = false;
    curSlot.cadenceFit = null;
    curSlot.cadenceDirty = false;
    // Cloud transcription only needs PCM for the request itself. Keep the
    // lightweight waveform but release the full Float32Array once the words
    // land; a later range re-transcribe can decode on demand again.
    curSlot.pcm = model === CLOUD_MODEL_ID ? null : (curSlot.pcm ?? pcm);
    curSlot.peaks = curSlot.peaks ?? slot.peaks;
    // The script check and automatic cadence are the next phases of the
    // same processing run. Enter the first of them before resolving so the
    // editor never unlocks for a frame in the handoff.
    const completedStatus: TranscribeStatus = useStudio.getState().script.trim()
      ? { phase: "checking" }
      : useStudio.getState().autoCadence
        ? { phase: "matching" }
        : { phase: "done" };
    setClipPhase(id, completedStatus);
    updateClipInfo(id, { transcribed: true });
    if (isActive()) {
      clearEditHistory();
      cueGen++;
      useStudio.setState({
        words,
        cues,
        status: completedStatus,
        transcribeNote: note ? { text: note } : null,
        ...(model === CLOUD_MODEL_ID ? { pcm: null } : {}),
        ...(completedStatus.phase === "matching"
          ? { cadenceRunOutcome: "running" as const }
          : {}),
        cadenceApplied: false,
        cadenceFit: null,
        cadenceDirty: false,
      });
    }
    // a background clip's transcript wouldn't trigger the autosave — persist directly
    if (!isActive()) saveClipHook?.(id);
    return true;
  } catch (e) {
    // a failed re-transcribe puts the old transcript back
    if (backup) {
      const cs = clipSlots.get(id);
      if (cs) {
        cs.words = backup.words;
        cs.cues = backup.cues;
        cs.originalWords = backup.originalWords;
        cs.cadenceApplied = backup.cadenceApplied;
        cs.cadenceFit = backup.cadenceFit;
        cs.cadenceDirty = backup.cadenceDirty;
      }
      if (isActive()) {
        cueGen++;
        useStudio.setState({
          words: backup.words,
          cues: backup.cues,
          cadenceApplied: backup.cadenceApplied,
          cadenceFit: backup.cadenceFit,
          cadenceDirty: backup.cadenceDirty,
        });
      }
    }
    setStatus({
      phase: "error",
      message: e instanceof Error ? e.message : String(e),
    });
    console.error(`[cap-transcribe] clip=${id} failed:`, e);
    return false;
  }
}

/**
 * The first job: one video in, captions out, nothing to press. The video becomes a new Caption Studio project (as a
 * drop on the import screen does, replacing the open one), the setup dialog is skipped and transcription starts now,
 * on this device with no key, in whatever language is spoken. The page is /captions: the caller goes there, or stays
 * and reads `useStudio` (`status`, then `words` and `cues`). False when the file isn't a video; nothing changes then.
 * The model is this run's only: no engine choice is stored, so a person's own choice and the cloud default stay.
 * The AI cadence pass is off for this project, so the words are the end: its card, lock and Stop are a second job.
 */
export function captionThisVideo(file: File): boolean {
  if (!prepareImport([file]).length) return false;
  const st = useStudio.getState();
  st.importFiles([file]);
  st.setFileName(file.name.replace(/\.[a-z0-9]{2,5}$/i, ""));
  useStudio.setState({ setupPending: false, model: FIRST_JOB_MODEL, autoCadence: false });
  const id = useStudio.getState().activeClipId!;
  // busy from the first frame: the editor never offers its own Transcribe button in between
  setClipPhase(id, { phase: "extracting" });
  enqueueTranscription([id]);
  return true;
}

export const useStudio = create<StudioState>((rawSet, get) => {
  // Fill gaps holds through every rebuild: any new set of captions is
  // filled while the clip's style has it on. Hand-dragged edges go through
  // rawSet (updateCueTimes) and stay where they were put.
  // ponytail: the iPhone app's re-layout (api/caption-layout.ts) doesn't
  // know the flag; fill there too if it ever re-lays out a filled clip.
  const set = (
    partial: Partial<StudioState> | ((s: StudioState) => Partial<StudioState>),
  ) =>
    rawSet((s) => {
      const p = typeof partial === "function" ? partial(s) : partial;
      if (!p.cues || !(p.style ?? s.style).fillGaps) return p;
      return { ...p, cues: fillCueGaps(p.cues, p.duration ?? s.duration) };
    });
  return {
  videoUrl: null,
  projectLibraryOpen: false,
  openProjectLibrary: () => set({ projectLibraryOpen: true }),
  importedFile: null,
  saveError: null,
  localSaveState: "idle",
  localSaveError: null,
  fileName: "",
  videoWidth: 1920,
  videoHeight: 1080,
  sourceWidth: 0,
  sourceHeight: 0,
  duration: 0,
  peaks: null,
  pcm: null,
  currentTime: 0,
  playing: false,
  words: [],
  cues: [],
  style: DEFAULT_STYLE,
  activePreset: "Classic",
  posSegments: [],
  texts: [],
  selectedTextId: null,
  status: { phase: "idle" },
  model: storedEngine() ?? MODELS[0].id,
  autoCadence: storedAutoCadence(),
  setAutoCadence: (enabled) => set({ autoCadence: enabled }),
  clips: [],
  activeClipId: null,
  selectedClipIds: [],
  setSelectedClipIds: (ids) => set({ selectedClipIds: ids }),
  refining: false,
  refiningClipId: null,
  refineError: null,
  transcribeNote: null,
  cadenceRunOutcome: "idle",
  cadenceOutcomeClipId: null,
  cadenceApplied: false,
  cadenceFit: null,
  cadenceDirty: false,
  done: false,
  transcriptVisible: true,
  projectId: null,
  serverProjectReady: false,
  serverRevision: 0,
  serverConflict: false,
  serverCaptioning: false,
  setupPending: false,
  saveState: "idle",

  dismissSetup: () => set({ setupPending: false }),

  setFileName: (name) => {
    const n = name.trim().slice(0, 120);
    if (n) set({ fileName: n });
  },

  importFiles: (files) => {
    files = prepareImport(files);
    if (!files.length) return;
    get().cancelCadence();
    abortScriptChecks();
    // dropping the current project: free every local clip resource
    for (const c of get().clips) releaseClip(c.id);
    clipSlots.clear();
    clearTranscribeQueue();
    clearHistory();
    // the current style carries over as the seed for the new project's clips
    const seedStyle = get().style;
    const clips: ClipInfo[] = files.map((f) => ({
      id: newClipId(),
      name: f.name,
      videoUrl: URL.createObjectURL(f),
      duration: 0,
      sourceWidth: 0,
      sourceHeight: 0,
      srcFps: null,
      status: { phase: "idle" },
      transcribed: false,
      uploadState: "local",
      uploadPct: 0,
      uploadError: null,
      hasOriginal: false,
      originalBytes: 0,
      done: false,
    }));
    files.forEach((f, i) => {
      clipSlots.set(clips[i].id, { ...blankSlot(seedStyle), file: f });
    });
    const first = clips[0];
    set({
      clips,
      activeClipId: first.id,
      projectLibraryOpen: false,
      ...snapshotToLive(first, clipSlots.get(first.id)!),
      fileName: first.name,
      videoWidth: 1920,
      videoHeight: 1080,
      fps: 30,
      srcFps: null,
      fpsManual: false,
      projectId: newProjectId(),
      serverProjectReady: false,
      serverRevision: 0,
      serverConflict: false,
      serverCaptioning: false,
      autoCadence: storedAutoCadence(),
      script: "",
      scriptFixes: {},
      scriptCheckError: null,
      setupPending: true,
      saveState: "idle",
      saveError: null,
      localSaveState: "saving",
      localSaveError: null,
      refiningClipId: null,
      refining: false,
      refineError: null,
      transcribeNote: null,
      cadenceRunOutcome: "idle",
      applyingMaster: false,
      applyMasterProgress: null,
      masterApplyResults: null,
      masterApplyInserted: null,
      masterApplyCorrected: null,
      rangeSel: null,
      selectedClipIds: [],
    });
  },

  importFile: (f) => get().importFiles([f]),

  addClips: (files) => {
    files = prepareImport(files);
    if (!files.length) return;
    if (get().clips.length === 0) {
      get().importFiles(files);
      return;
    }
    const seedStyle = get().style;
    const newIds: string[] = [];
    const clips = [...get().clips];
    for (const f of files) {
      const id = newClipId();
      clipSlots.set(id, { ...blankSlot(seedStyle), file: f });
      clips.push({
        id,
        name: f.name,
        videoUrl: URL.createObjectURL(f),
        duration: 0,
        sourceWidth: 0,
        sourceHeight: 0,
        srcFps: null,
        status: { phase: "idle" },
        transcribed: false,
        uploadState: "local",
        uploadPct: 0,
        uploadError: null,
        hasOriginal: false,
        originalBytes: 0,
        done: false,
      });
      newIds.push(id);
    }
    set({ clips });
    // same pool = same processing: transcribe with the project's engine
    enqueueTranscription(newIds);
  },

  switchClip: (id) => {
    const s = get();
    if (id === s.activeClipId) return;
    const clip = s.clips.find((c) => c.id === id);
    if (!clip) return;
    // freeze the outgoing clip's live state into its slot
    if (s.activeClipId && clipSlots.has(s.activeClipId)) {
      clipSlots.set(s.activeClipId, liveToSnapshot(s));
      updateClipInfo(s.activeClipId, {
        duration: s.duration,
        sourceWidth: s.sourceWidth,
        sourceHeight: s.sourceHeight,
        srcFps: s.srcFps,
        status: s.status,
        transcribed: s.words.length > 0 || s.cues.length > 0,
      });
    }
    clearHistory();
    let snap = clipSlots.get(id);
    if (!snap) {
      snap = blankSlot(s.style);
      clipSlots.set(id, snap);
    }
    set({ activeClipId: id, ...snapshotToLive(clip, snap) });
    // Decode lightweight server proxies opportunistically (ensureAudio leaves raw local sources alone).
    void get().ensureAudio();
  },

  moveClip: (from, to) => {
    const s = get();
    if (
      from === to ||
      from < 0 ||
      to < 0 ||
      from >= s.clips.length ||
      to >= s.clips.length
    )
      return;
    const clips = [...s.clips];
    const [moved] = clips.splice(from, 1);
    clips.splice(to, 0, moved);
    set({ clips });
    clipReorderedHook?.();
  },

  renameClip: (id, name) => {
    const n = name.trim().slice(0, 120);
    if (!n) return;
    updateClipInfo(id, { name: n });
    // a rename touches no editor state, so the autosave wouldn't see it —
    // force a save: full payload for the active clip, slot save otherwise
    if (id === get().activeClipId) clipReorderedHook?.();
    else saveClipHook?.(id);
  },

  toggleClipDone: (id) => {
    if (id === get().activeClipId) {
      const done = !get().done;
      set({ done });
      updateClipInfo(id, { done });
      clipReorderedHook?.();
      return;
    }
    const slot = clipSlots.get(id);
    if (!slot) return;
    slot.done = !slot.done;
    updateClipInfo(id, { done: slot.done });
    saveClipHook?.(id);
  },

  removeClip: (id) => {
    const s = get();
    const idx = s.clips.findIndex((c) => c.id === id);
    if (idx < 0) return;
    const projectId = s.projectId;
    releaseClip(id);
    const clips = s.clips.filter((c) => c.id !== id);
    // drop a pending transcription of this clip
    const qi = transcribeQueue.indexOf(id);
    if (qi >= 0) transcribeQueue.splice(qi, 1);
    if (id !== s.activeClipId) {
      set({ clips });
      if (projectId) clipRemovedHook?.(projectId, id);
      return;
    }
    // the active clip goes away — switch to a neighbor, or reset when
    // the pool is empty (the project itself is deleted via persist)
    const next = clips[Math.min(idx, clips.length - 1)];
    if (!next) {
      if (projectId) clipRemovedHook?.(projectId, null);
      get().reset();
      return;
    }
    set({ clips });
    if (projectId) clipRemovedHook?.(projectId, id);
    get().switchClip(next.id);
  },

  applyingMaster: false,
  tabConflict: false,
  setTabConflict: (v) => set({ tabConflict: v }),
  applyMasterProgress: null,
  masterApplyResults: null,
  masterApplyInserted: null,
  masterApplyCorrected: null,

  applyMasterToAll: async (onlyIds) => {
    const s = get();
    if (s.applyingMaster || s.refiningClipId) return;
    const master = s.clips[0];
    if (!master || !isMasterApplyReady(master)) return;
    const masterSnap =
      master.id === s.activeClipId
        ? liveToSnapshot(s)
        : clipSlots.get(master.id);
    if (!masterSnap) return;
    const masterWords = masterSnap.cues.length
      ? masterSnap.cues.flatMap((c) => c.words)
      : masterSnap.words;
    if (!masterWords.length) return;
    // the master's engine transcript is what its edits are measured
    // against; older saves without one have no known edits (breaks,
    // cadence and the captions layer still transfer)
    const masterOrig = masterSnap.originalWords?.length
      ? masterSnap.originalWords
      : masterWords;

    // the AI places master fixes of names and numbers the exact replay
    // couldn't (applyMaster.ts `missed`), when this account has the AI
    const ai = await aiStatus().catch(() => null);
    let check = !!(ai?.available && ai.allowed);

    const only = onlyIds ? new Set(onlyIds) : null;
    const targets = s.clips.slice(1).filter(
      (c) =>
        (!only || only.has(c.id)) &&
        isMasterApplyReady(c),
    );
    // a selection that matches nothing must never widen into "all"
    if (only && targets.length === 0) return;
    if (localStorage.getItem("debugMaster") === "1") {
      console.log("[applyMaster] master:", master.name, {
        masterWords: masterWords.length,
        targets: targets.map((t) => t.name),
      });
    }
    set({
      applyingMaster: true,
      applyMasterProgress: { done: 0, total: targets.length },
    });
    const results: Record<string, number> = {};
    const insertedCounts: Record<string, number> = {};
    const correctedCounts: Record<string, number> = {};
    let done = 0;
    try {
      for (const clip of targets) {
        const read = () => {
          const now = get();
          const active = clip.id === now.activeClipId;
          const snap = active ? liveToSnapshot(now) : clipSlots.get(clip.id);
          const words = !snap
            ? []
            : snap.cues.length
              ? snap.cues.flatMap((c) => c.words)
              : snap.words;
          return { active, snap, words };
        };
        const cur = get();
        const first = read();
        let isActive = first.active;
        const { snap, words: targetWords } = first;
        if (!snap || !targetWords.length) continue;
        if (localStorage.getItem("debugMaster") === "1") {
          console.log("[applyMaster] target:", clip.name, {
            source: isActive ? "live" : "slot",
            words: targetWords.length,
            first: targetWords.slice(0, 6).map((w) => w.text),
          });
        }
        const st = snap.style;
        const frame = frameOf({
          sourceWidth: clip.sourceWidth || cur.sourceWidth,
          sourceHeight: clip.sourceHeight || cur.sourceHeight,
          videoWidth: cur.videoWidth,
          videoHeight: cur.videoHeight,
        });
        const { maxChars, maxLines } =
          st.fitBox && frame
            ? boxCaps(st, frame.w, frame.h)
            : { maxChars: st.maxCharsPerLine, maxLines: 2 };
        const replay = (sn: ClipSnapshot, tw: Word[]) =>
          applyMasterToClip(
            masterOrig,
            masterWords,
            masterSnap.cues,
            masterSnap.posSegments,
            tw,
            sn.cues,
            maxChars,
            maxLines,
            nextPosId,
            wordIdGen(sn.cues),
          );
        const firstRes = replay(snap, targetWords);
        // barely overlapping = a different video — leave it alone
        if (!firstRes || firstRes.coverage < 0.3) {
          results[clip.id] = firstRes?.coverage ?? 0;
          continue;
        }
        let res = firstRes;
        let { words, cues } = res;
        let fixes: ScriptFix[] = [];
        if (check && res.missed.length) {
          // the script check with only those fixes as its script: it finds
          // where this take mis-heard them (vetted server-side: each word
          // it writes is in them and sounds like what was heard)
          try {
            const edits = await checkAgainstScript(res.missed.join("\n"), words);
            const now = read();
            if (
              now.active !== isActive ||
              now.words.length !== targetWords.length ||
              now.words.some((w, i) => w !== targetWords[i])
            ) {
              // the clip changed while the AI read it: replay onto what's
              // there now, without the AI's fixes
              if (!now.snap || !now.words.length) continue;
              isActive = now.active;
              const fresh = replay(now.snap, now.words);
              if (!fresh || fresh.coverage < 0.3) {
                results[clip.id] = -1; // visible "Skipped" — did NOT land
                continue;
              }
              res = fresh;
              ({ words, cues } = fresh);
            } else if (edits.length) {
              const applied = applyScriptEdits(
                cues.map((c) => c.words),
                edits,
                wordIdGen(cues),
              );
              fixes = applied.fixes.map((f) => ({ ...f, from: "master" as const }));
              cues = cuesFromGroups(applied.groups, st, frame, cues);
              words = cues.flatMap((c) => c.words);
            }
          } catch (e) {
            check = false; // the replay still lands; no AI for the rest
            console.warn("[applyMaster] AI check failed:", e);
          }
        }
        if (fixes.length) {
          const all = get().scriptFixes;
          set({ scriptFixes: { ...all, [clip.id]: [...(all[clip.id] ?? []), ...fixes] } });
        }

        cueGen++;
        if (isActive) {
          pushUndo(get());
          set({
            words,
            cues,
            // null = the master has no layer edits — keep the target's
            posSegments: res.posSegments ?? get().posSegments,
            cadenceApplied: true,
            cadenceFit: cadenceFitOf(get().style),
            cadenceDirty: false,
          });
        } else {
          const slot = clipSlots.get(clip.id);
          if (!slot) continue;
          slot.words = words;
          slot.cues = cues;
          if (res.posSegments) slot.posSegments = res.posSegments;
          slot.cadenceApplied = true;
          slot.cadenceFit = cadenceFitOf(slot.style);
          slot.cadenceDirty = false;
          saveClipHook?.(clip.id);
        }
        if (localStorage.getItem("debugMaster") === "1") {
          console.log("[applyMaster] landed:", clip.name, {
            isActive,
            words: words.length,
            inserted: res.inserted,
            corrected: res.corrected,
            filledTexts: res.inserted
              ? words
                  .filter((w) => !targetWords.some((t) => t.id === w.id))
                  .map((w) => w.text)
              : [],
          });
        }
        // the badge is earned here — only a landed apply counts
        results[clip.id] = res.coverage;
        if (res.inserted) insertedCounts[clip.id] = res.inserted;
        if (res.corrected) correctedCounts[clip.id] = res.corrected;
        set({ applyMasterProgress: { done: ++done, total: targets.length } });
      }
    } finally {
      // a full run replaces the outcome board; a selection run updates
      // only its own clips so the others keep their last result
      const merged = only
        ? { ...get().masterApplyResults, ...results }
        : results;
      const mergedInserted = only
        ? { ...get().masterApplyInserted, ...insertedCounts }
        : insertedCounts;
      const mergedCorrected = only
        ? { ...get().masterApplyCorrected, ...correctedCounts }
        : correctedCounts;
      const alive = new Set(s.clips.map((c) => c.id));
      for (const id of Object.keys(merged)) {
        if (!alive.has(id)) delete merged[id];
      }
      for (const id of Object.keys(mergedInserted)) {
        if (!alive.has(id) || !(id in results)) delete mergedInserted[id];
      }
      for (const id of Object.keys(mergedCorrected)) {
        if (!alive.has(id) || !(id in results)) delete mergedCorrected[id];
      }
      set({
        applyingMaster: false,
        applyMasterProgress: null,
        masterApplyResults: merged,
        masterApplyInserted: mergedInserted,
        masterApplyCorrected: mergedCorrected,
      });
    }
  },

  transcribeAll: () => {
    const ids = get()
      .clips.filter(
        (c) =>
          !c.transcribed &&
          c.status.phase !== "transcribing" &&
          c.status.phase !== "matching" &&
          c.status.phase !== "loading" &&
          c.status.phase !== "extracting",
      )
      .map((c) => c.id);
    enqueueTranscription(ids);
  },

  ensureAudio: async () => {
    const url = get().videoUrl;
    const clipId = get().activeClipId;
    // A video still only on this computer is decoded when its transcription starts, not before. And a read already
    // under way for this clip is the one: a second call would stop it and download the whole video again.
    if (get().pcm || !url || url.startsWith("blob:")) return;
    if (clipId && activeAudioPreparation?.clipId === clipId) return;
    const controller = new AbortController();
    if (clipId) {
      activeAudioPreparation?.controller.abort();
      activeAudioPreparation = { clipId, controller };
    }
    // the clip is what the result belongs to: its address may change under the read (the editing copy arriving)
    const shown = () => get().activeClipId === clipId;
    try {
      // ponytail: the whole editing copy is downloaded for its sound; a server-made waveform if long videos make this heavy
      const res = await fetch(url, { signal: controller.signal });
      // not on the server (yet): nothing is known about the clip's sound, and a new address for it is asked again
      if (!res.ok) return;
      const blob = await res.blob();
      try {
        const { pcm, peaks, duration } = await extractAudio(
          new File([blob], get().fileName),
          undefined,
          controller.signal,
        );
        if (!shown()) return;
        set({ pcm, peaks, duration: get().duration || duration });
      } catch {
        // The video is there and gave no sound (no audio track, a sound this browser can't decode): the clip has no
        // sound picture, said as an empty one, and the timeline keeps no lane for it. A read that was stopped (a
        // transcription or another clip took over) says nothing about the clip.
        if (!controller.signal.aborted && shown() && !get().peaks) set({ peaks: new Float32Array(0) });
      }
    } catch {
      // the download failed or was stopped: nothing is known about the clip's sound
    } finally {
      if (activeAudioPreparation?.controller === controller) {
        activeAudioPreparation = null;
      }
    }
  },

  setVideoMeta: (w, h, d) => {
    const s = get();
    const sourceW = s.sourceWidth === 0 ? w : s.sourceWidth;
    const sourceH = s.sourceHeight === 0 ? h : s.sourceHeight;
    set({
      videoWidth: w,
      videoHeight: h,
      duration: d,
      // a fresh import plays the original file itself — capture its
      // resolution unless a loaded project already told us the source's
      ...(s.sourceWidth === 0 ? { sourceWidth: w, sourceHeight: h } : {}),
    });
    // keep the clip record in sync for the bar / saves
    if (s.activeClipId) {
      updateClipInfo(s.activeClipId, {
        duration: d,
        sourceWidth: sourceW,
        sourceHeight: sourceH,
      });
    }
  },
  setCurrentTime: (t) => set({ currentTime: t }),
  setPlaying: (p) => {
    if (p && isEditorBusy(get())) {
      playerRef.video?.pause();
      set({ playing: false });
      return;
    }
    set({ playing: p });
  },

  seek: (t) => {
    if (isEditorBusy(get())) return;
    const v = playerRef.video;
    const d = get().duration;
    const clamped = Math.max(0, Math.min(t, d || t));
    if (v) v.currentTime = clamped;
    set({ currentTime: clamped });
  },

  runTranscription: async () => {
    const id = get().activeClipId;
    if (!id) return;
    enqueueTranscription([id]);
  },

  rangeSel: null,
  setRangeSel: (r) => {
    if (isEditorBusy(get())) return;
    set({ rangeSel: r });
  },

  retranscribeRange: async () => {
    const s0 = get();
    const r = s0.rangeSel;
    const id = s0.activeClipId;
    if (!r || !id || r.end - r.start < 0.1) return;
    if (isEditorBusy(s0)) return;
    const clip = s0.clips.find((c) => c.id === id);
    if (!clip) return;
    const setStatus = (status: TranscribeStatus) => setClipPhase(id, status);
    try {
      // pcm for the slice — live decode, the slot's, or fresh from the proxy
      let pcm = get().pcm ?? clipSlots.get(id)?.pcm ?? null;
      if (!pcm) {
        setStatus({ phase: "extracting" });
        const blob: Blob =
          clipSlots.get(id)?.file ??
          (await fetch(clip.videoUrl).then((res) => res.blob()));
        const controller = new AbortController();
        activeAudioPreparation?.controller.abort();
        activeAudioPreparation = { clipId: id, controller };
        const ex = await extractAudio(
          new File([blob], clip.name),
          (progress, detail) =>
            setStatus({
              phase: "extracting",
              progress: Math.round(progress * 100),
              detail,
            }),
          controller.signal,
        ).finally(() => {
          if (activeAudioPreparation?.controller === controller) {
            activeAudioPreparation = null;
          }
        });
        pcm = ex.pcm;
        const slot = clipSlots.get(id);
        if (slot) {
          slot.pcm = ex.pcm;
          slot.peaks = ex.peaks;
        }
        if (get().activeClipId === id) set({ pcm: ex.pcm, peaks: ex.peaks });
      }
      const SR = 16000;
      // transcribe a slightly WIDER slice than the selection: the engine
      // hears the surrounding context and edge words aren't cut in half —
      // but only words inside the actual selection get spliced in
      const PAD_S = 0.4;
      const sliceStart = Math.max(0, r.start - PAD_S);
      const sliceEnd = Math.min(pcm.length / SR, r.end + PAD_S);
      const a = Math.floor(sliceStart * SR);
      const b = Math.min(pcm.length, Math.ceil(sliceEnd * SR));
      if (b - a < SR * 0.15)
        throw new Error("Section is too short to transcribe");
      const slice = pcm.slice(a, b);

      const model = get().model;
      let words: Word[];
      if (model === CLOUD_MODEL_ID) {
        const heard = await fromServer(slice, clip.name, "", setStatus);
        words = heard.words;
        if (heard.note) set({ transcribeNote: { text: heard.note } });
      } else {
        words = await inBrowser(slice, model, setStatus);
      }
      // clip switched mid-flight — drop the answer
      if (get().activeClipId !== id) return;
      const nextId = wordIdGen(get().cues);
      const offset = words
        .map((w) => ({
          ...w,
          id: nextId(),
          start: w.start + sliceStart,
          end: w.end + sliceStart,
        }))
        // context words from the padding are for the engine's ears only —
        // the splice replaces exactly the selected range
        .filter(
          (w) =>
            (w.start + w.end) / 2 >= r.start && (w.start + w.end) / 2 < r.end,
        );
      pushUndo(get());
      const { words: merged, cues: out } = spliceRangeIntoCues(
        get().cues,
        r.start,
        r.end,
        offset,
        get().style,
        frameOf(get())?.w ?? get().videoWidth,
        frameOf(get())?.h ?? get().videoHeight,
      );
      cueGen++;
      if (model === CLOUD_MODEL_ID) {
        const slot = clipSlots.get(id);
        if (slot) slot.pcm = null;
      }
      set({
        words: merged,
        cues: out,
        ...(model === CLOUD_MODEL_ID ? { pcm: null } : {}),
        // fresh words spliced into a matched grouping — offer a re-match
        ...(get().cadenceApplied ? { cadenceDirty: true } : {}),
      });
      // a check or match the queue opened on this clip meanwhile closes itself
      const inFlight = phaseOf(id);
      if (inFlight !== "checking" && inFlight !== "matching") {
        setClipPhase(id, { phase: "done" });
      }
      updateClipInfo(id, { transcribed: merged.length > 0 });
    } catch (e) {
      setStatus({
        phase: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  refineCues: async (clipId) => {
    const targetId = clipId ?? get().activeClipId;
    // one pass at a time, bound to the clip it was started on
    if (!targetId || get().refiningClipId) return;
    const gen = cueGen;
    const clip = get().clips.find((c) => c.id === targetId);
    const wasActive = get().activeClipId === targetId;
    const slot = clipSlots.get(targetId);
    // words + style come from the live editor for the active clip, from
    // the clip's slot for a background one (auto-match after a queued
    // transcription)
    const words = wasActive
      ? get().cues.length
        ? get().cues.flatMap((c) => c.words)
        : get().words
      : slot?.cues.length
        ? slot.cues.flatMap((c) => c.words)
        : (slot?.words ?? []);
    if (!words.length || !slot || !clip) return;

    const request: ActiveCadenceRequest = {
      clipId: targetId,
      requestId: cadenceRequestId(),
      controller: new AbortController(),
    };
    activeCadenceRequest = request;

    if (wasActive) playerRef.video?.pause();
    set({
      refiningClipId: targetId,
      // `refining` locks the ACTIVE clip's editing — a background clip's
      // pass doesn't (its own lock applies whenever it's on screen)
      refining: wasActive,
      refineError: null,
      ...cadenceOutcomePatch(targetId, "running"),
    });
    try {
      const status = await aiStatus();
      if (request.controller.signal.aborted) return;
      if (!status.available || !status.allowed) {
        set(cadenceOutcomePatch(targetId, "failed"));
        return;
      }
      const marks = await refineSegments(words, {
        signal: request.controller.signal,
        requestId: request.requestId,
      });
      if (request.controller.signal.aborted) return;
      // discard a stale answer if anything structural changed in flight
      // (gen: undo/redo and cue-time drags on the same words; identity:
      // transcript edits and clip loads, which replace word objects). A
      // box resize doesn't count — the marks don't depend on the box.
      // The clip may have been swapped out mid-flight — check its slot.
      const stillActive = get().activeClipId === targetId;
      const current = stillActive
        ? get().cues.length
          ? get().cues.flatMap((c) => c.words)
          : get().words
        : (clipSlots.get(targetId)?.cues.flatMap((c) => c.words) ??
          clipSlots.get(targetId)?.words ??
          []);
      // cueGen is a single counter across clips — it only guards the
      // pass while its clip is on screen (structural edits there). For
      // a backgrounded clip, slot word identity is the guard: the slot
      // only changes hands via transcription/cadence/switch-freeze,
      // and anything that edits the words replaces the objects.
      const identitySame =
        current.length === words.length &&
        current.every((w, i) => w === words[i]);
      const unchanged = stillActive
        ? gen === cueGen && identitySame
        : identitySame;
      if (!unchanged) {
        set(cadenceOutcomePatch(targetId, "cancelled"));
        return;
      }
      // marks ride on new word objects — undo snapshots share the old ones
      const marked = words.map((w, i) => ({ ...w, cut: marks[i] }));
      // lay out for the box as it is NOW: it may have been resized while
      // the pass ran, and the marks don't depend on it
      const st = stillActive
        ? get().style
        : (clipSlots.get(targetId)?.style ?? slot.style);
      const frame = stillActive
        ? frameOf(get())
        : frameOf({
            sourceWidth: clip.sourceWidth || get().sourceWidth,
            sourceHeight: clip.sourceHeight || get().sourceHeight,
            videoWidth: get().videoWidth,
            videoHeight: get().videoHeight,
          });
      const caps =
        st.fitBox && frame
          ? boxCaps(st, frame.w, frame.h)
          : { maxChars: st.maxCharsPerLine, maxLines: 1 };
      const prevCues = stillActive
        ? get().cues
        : (clipSlots.get(targetId)?.cues ?? []);
      const cues = layoutCues(marked, caps, prevCues);
      const flat = cues.flatMap((c) => c.words);
      // the box the split marks are planned for (see narrowerThanMatched);
      // fitSplits below plans them for this box
      const fit = cadenceFitOf(st);
      cueGen++;
      if (stillActive) {
        pushUndo(get());
        set({
          cues,
          words: flat,
          cadenceApplied: true,
          cadenceFit: fit,
          cadenceDirty: false,
          ...cadenceOutcomePatch(targetId, "completed"),
        });
        void get().fitSplits(targetId);
      } else {
        // user moved on — land the pass in the clip's own slot and save
        const slot = clipSlots.get(targetId);
        if (!slot) return;
        slot.cues = cues;
        slot.words = flat;
        slot.cadenceApplied = true;
        slot.cadenceFit = fit;
        slot.cadenceDirty = false;
        saveClipHook?.(targetId);
        set(cadenceOutcomePatch(targetId, "completed"));
        void get().fitSplits(targetId);
      }
    } catch (e) {
      if (request.controller.signal.aborted) return;
      if (get().activeClipId === targetId) {
        set({
          refineError:
            e instanceof Error ? e.message : "AI caption pass failed",
          ...cadenceOutcomePatch(targetId, "failed"),
        });
      } else {
        set(cadenceOutcomePatch(targetId, "failed"));
      }
    } finally {
      if (activeCadenceRequest === request) {
        activeCadenceRequest = null;
        set({ refiningClipId: null, refining: false });
      }
    }
  },

  fittingSplits: false,

  fitSplits: async (clipId) => {
    const targetId = clipId ?? get().activeClipId;
    if (!targetId || splitsInFlight.has(targetId)) return;
    const clip = get().clips.find((c) => c.id === targetId);
    const slot = clipSlots.get(targetId);
    if (!clip || !slot) return;
    const read = () => {
      const s = get();
      const active = s.activeClipId === targetId;
      const cues = active ? s.cues : (clipSlots.get(targetId)?.cues ?? []);
      const style = active ? s.style : (clipSlots.get(targetId)?.style ?? slot.style);
      const frame = active
        ? frameOf(s)
        : frameOf({
            sourceWidth: clip.sourceWidth || s.sourceWidth,
            sourceHeight: clip.sourceHeight || s.sourceHeight,
            videoWidth: s.videoWidth,
            videoHeight: s.videoHeight,
          });
      return { active, cues, words: cues.flatMap((c) => c.words), style, frame };
    };
    const start = read();
    if (!start.style.fitBox || !start.frame) return;
    if (!start.words.some((w) => w.cut !== undefined)) return;
    const caps = boxCaps(start.style, start.frame.w, start.frame.h);
    const long = tooWideThoughts(start.words, caps.maxChars);
    const planned = cadenceFitOf(start.style);
    if (!long.length) {
      if (start.active) set({ cadenceFit: planned });
      else slot.cadenceFit = planned;
      return;
    }
    splitsInFlight.add(targetId);
    if (start.active) set({ fittingSplits: true });
    try {
      const splits = await refineSplits(
        long.map(([a, b]) => start.words.slice(a, b).map((w) => w.text)),
        caps.maxChars,
      );
      // the words changed meanwhile (an edit, a new match): drop the answer
      const now = read();
      const same =
        now.words.length === start.words.length &&
        now.words.every((w, i) => w === start.words[i]);
      if (!same) return;
      const words = withSplits(start.words, long, splits);
      const nowCaps =
        now.style.fitBox && now.frame
          ? boxCaps(now.style, now.frame.w, now.frame.h)
          : caps;
      const cues = layoutCues(words, nowCaps, now.cues);
      if (now.active) {
        set({ cues, words: cues.flatMap((c) => c.words), cadenceFit: planned });
      } else {
        const cur = clipSlots.get(targetId);
        if (!cur) return;
        cur.cues = cues;
        cur.words = cues.flatMap((c) => c.words);
        cur.cadenceFit = planned;
        saveClipHook?.(targetId);
      }
    } catch (e) {
      // the thought lines already landed; only the split points are
      // missing — say so only when the user asked (no clipId: the button)
      if (get().activeClipId === targetId && clipId === undefined) {
        set({ refineError: e instanceof Error ? e.message : "AI caption pass failed" });
      }
    } finally {
      splitsInFlight.delete(targetId);
      // the flag means "the clip on screen is fitting" — recompute, don't clear
      set({ fittingSplits: splitsInFlight.has(get().activeClipId ?? "") });
    }
  },

  cancelCadence: () => {
    const request = activeCadenceRequest;
    const targetId =
      request?.clipId ?? get().refiningClipId ?? get().activeClipId;
    const target = targetId
      ? get().clips.find((clip) => clip.id === targetId)
      : null;
    if (
      !request &&
      !get().refiningClipId &&
      target?.status.phase !== "matching"
    ) {
      return;
    }
    if (request) {
      request.controller.abort();
      cancelCadenceRequest(request.requestId);
      activeCadenceRequest = null;
    }
    if (targetId && target?.status.phase === "matching") {
      setClipPhase(targetId, { phase: "done" });
    }
    set({
      refiningClipId: null,
      refining: false,
      refineError: null,
      ...cadenceOutcomePatch(targetId, "cancelled"),
    });
  },

  resetCadence: () => {
    if (get().refining || !get().cadenceApplied) return;
    clearHistory();
    cueGen++;
    // back to the plain layout: drop the thought marks with the grouping
    const words = clearMarks(
      get().cues.length ? get().cues.flatMap((c) => c.words) : get().words,
    );
    const frame = frameOf(get());
    const cues = regen(
      words,
      get().style,
      frame?.w ?? get().videoWidth,
      frame?.h ?? get().videoHeight,
    );
    set({
      cues,
      words: cues.flatMap((c) => c.words),
      cadenceApplied: false,
      cadenceFit: null,
      cadenceDirty: false,
    });
  },

  script: "",
  setScript: (script) => set({ script: script.slice(0, MAX_SCRIPT_CHARS) }),
  scriptFixes: {},
  scriptCheckError: null,

  dismissScriptFixes: () => {
    const id = get().activeClipId;
    if (!id || !(id in get().scriptFixes)) return;
    const rest = { ...get().scriptFixes };
    delete rest[id];
    set({ scriptFixes: rest });
  },

  checkScript: async (clipId) => {
    const targetId = clipId ?? get().activeClipId;
    const script = get().script.trim();
    if (!targetId || !script || activeScriptChecks.has(targetId)) return;
    const clip = get().clips.find((c) => c.id === targetId);
    if (!clip || !clipSlots.has(targetId)) return;
    // the transcribe queue opens `checking` itself; on demand, this does
    const auto = clip.status.phase === "checking";
    if (!auto && (get().activeClipId !== targetId || isEditorBusy(get()))) {
      return;
    }
    const read = () => {
      const s = get();
      const active = s.activeClipId === targetId;
      const slot = clipSlots.get(targetId);
      const cues = active ? s.cues : (slot?.cues ?? []);
      const words = cues.length
        ? cues.flatMap((c) => c.words)
        : active
          ? s.words
          : (slot?.words ?? []);
      return { active, slot, cues, words };
    };
    const start = read();
    if (!start.words.length) return;

    const controller = new AbortController();
    activeScriptChecks.set(targetId, controller);
    if (!auto) setClipPhase(targetId, { phase: "checking" });
    if (start.active) set({ scriptCheckError: null });
    try {
      const edits = await checkAgainstScript(script, start.words, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      // the clip left or its words changed meanwhile: drop the answer
      const now = read();
      const clipNow = get().clips.find((c) => c.id === targetId);
      if (
        !clipNow ||
        !now.slot ||
        now.words.length !== start.words.length ||
        now.words.some((w, i) => w !== start.words[i])
      ) {
        return;
      }
      let nextWordId = now.words.reduce((m, w) => Math.max(m, w.id), 0) + 1;
      const { groups, fixes } = applyScriptEdits(
        now.cues.length ? now.cues.map((c) => c.words) : [now.words],
        edits,
        () => nextWordId++,
      );
      set({ scriptFixes: { ...get().scriptFixes, [targetId]: fixes } });
      if (!fixes.length) return;

      const s = get();
      const style = now.active ? s.style : now.slot.style;
      const frame = now.active
        ? frameOf(s)
        : frameOf({
            sourceWidth: clipNow.sourceWidth || s.sourceWidth,
            sourceHeight: clipNow.sourceHeight || s.sourceHeight,
            videoWidth: s.videoWidth,
            videoHeight: s.videoHeight,
          });
      // a fresh transcript is laid out as a fresh transcript would be; an
      // edited one keeps its captions, each wrapped for the box again
      const cues = auto
        ? regen(
            groups.flat(),
            style,
            frame?.w ?? s.videoWidth,
            frame?.h ?? s.videoHeight,
          )
        : cuesFromGroups(groups, style, frame, now.cues);
      const words = cues.flatMap((c) => c.words);
      cueGen++;
      if (now.active) {
        pushUndo(s);
        set({ cues, words });
      } else {
        now.slot.cues = cues;
        now.slot.words = words;
        saveClipHook?.(targetId);
      }
    } catch (e) {
      if (controller.signal.aborted) return;
      if (get().activeClipId === targetId) {
        set({
          scriptCheckError:
            e instanceof Error ? e.message : "Script check failed",
        });
      }
    } finally {
      if (activeScriptChecks.get(targetId) === controller) {
        activeScriptChecks.delete(targetId);
      }
      if (
        !auto &&
        get().clips.find((c) => c.id === targetId)?.status.phase === "checking"
      ) {
        setClipPhase(targetId, { phase: "done" });
      }
    }
  },

  cancelScriptCheck: () => {
    const id = get().activeClipId;
    if (!id) return;
    activeScriptChecks.get(id)?.abort();
    activeScriptChecks.delete(id);
  },

  setStyle: (patch) => {
    const s0 = get();
    // box and font edits stay live while a cadence pass runs: its marks
    // don't depend on the box, and it lays out for the live box on landing
    if (isEditorBusy(s0) && !isCadenceBusy(s0)) return;
    // uppercase / lowercase can't both be on (both off is fine)
    if (patch.uppercase) patch = { ...patch, lowercase: false };
    else if (patch.lowercase) patch = { ...patch, uppercase: false };
    const prev = s0.style;
    const style = { ...prev, ...patch };
    const changed = (k: keyof CaptionStyle) =>
      patch[k] !== undefined && patch[k] !== prev[k];
    const modeChanged = changed("wordsPerCaption") || changed("fitBox");
    const boxChanged =
      style.fitBox &&
      (changed("boxW") || changed("boxH") || changed("fontSizePct"));
    if (modeChanged) {
      if (isCadenceBusy(s0)) return;
      // a different grouping mode starts over without the cadence marks
      clearHistory();
      cueGen++;
      const words = clearMarks(
        s0.cues.length ? s0.cues.flatMap((c) => c.words) : s0.words,
      );
      const frame = frameOf(s0);
      const cues = regen(
        words,
        style,
        frame?.w ?? s0.videoWidth,
        frame?.h ?? s0.videoHeight,
      );
      set({
        style,
        activePreset: null,
        cues,
        words: cues.flatMap((c) => c.words),
        cadenceApplied: false,
        cadenceFit: null,
        cadenceDirty: false,
      });
      return;
    }
    // the box decides how many lines fit: re-lay out every change, live
    const next = boxChanged ? relayout({ ...s0, style }) : null;
    set({ style, activePreset: null, ...(next ?? {}) });
  },

  applyPreset: (name, s) => {
    const s0 = get();
    if (isEditorBusy(s0) && !isCadenceBusy(s0)) return;
    // presets carry their own box position/size — applying one places
    // the caption box where the preset wants it. Every preset is box mode.
    const style = { ...s, fitBox: true, fillGaps: s0.style.fillGaps };
    if (s0.cadenceApplied || isCadenceBusy(s0)) {
      // keep the matched grouping, laid out for the preset's box
      set({
        style,
        activePreset: name,
        ...(relayout({ ...s0, style }) ?? {}),
      });
      return;
    }
    clearHistory();
    cueGen++;
    const frame = frameOf(s0);
    const cues = regen(
      s0.words,
      style,
      frame?.w ?? s0.videoWidth,
      frame?.h ?? s0.videoHeight,
    );
    set({
      style,
      activePreset: name,
      cues,
      cadenceApplied: false,
      cadenceFit: null,
      cadenceDirty: false,
    });
  },

  setModel: (m) => {
    persistEngine(m);
    set({ model: m });
  },

  fps: 30,
  setFps: (fps) => set({ fps, fpsManual: true }),
  srcFps: null,
  fpsManual: false,
  setSrcFps: (fps, source) => {
    const s = get();
    if (!(fps > 0)) return;
    // a server probe is authoritative; an estimate never overwrites one
    if (source === "estimate" && s.srcFps !== null) return;
    set({ srcFps: fps, ...(s.fpsManual ? {} : { fps }) });
  },

  applyTranscript: (lineTokens) => {
    const state = get();
    if (isEditorBusy(state)) return false;
    const lines = lineTokens
      .map((l) => l.filter(Boolean))
      .filter((l) => l.length > 0);
    const oldWords = state.cues.flatMap((c) => c.words);

    const sameText =
      lines.flat().join(" ") === oldWords.map((w) => w.text).join(" ");
    const sameShape =
      sameText &&
      lines.length === state.cues.length &&
      state.cues.every((c, i) => c.words.length === lines[i].length);
    if (sameShape) return false;

    pushUndo(state);
    const span = {
      start: oldWords[0]?.start ?? 0,
      end: oldWords[oldWords.length - 1]?.end ?? state.duration ?? 0,
    };
    const aligned = alignDocumentTokens(
      lines,
      oldWords,
      span,
      wordIdGen(state.cues),
    );

    // each typed line is one caption
    const cues = cuesFromGroups(
      aligned,
      state.style,
      frameOf(state),
      state.cues,
    );
    cueGen++;
    // an edited grouping is the user's own — the cadence pass offers a re-match
    set({
      cues,
      words: cues.flatMap((c) => c.words),
      ...(state.cadenceApplied ? { cadenceDirty: true } : {}),
    });
    return true;
  },

  undoEdit: () => {
    if (isEditorBusy(get())) return false;
    const cur = takeSnap(get());
    let snap = undoStack.pop();
    // drag gestures snapshot before knowing whether anything will change —
    // entries identical to the current state are skipped, not spent
    while (snap && sameSnap(snap, cur)) snap = undoStack.pop();
    if (!snap) return false;
    redoStack.push(cur);
    cueGen++;
    set(restoreSnap(snap, get()));
    refitAfterRestore();
    return true;
  },

  redoEdit: () => {
    if (isEditorBusy(get())) return false;
    const cur = takeSnap(get());
    let snap = redoStack.pop();
    while (snap && sameSnap(snap, cur)) snap = redoStack.pop();
    if (!snap) return false;
    undoStack.push(cur);
    cueGen++;
    set(restoreSnap(snap, get()));
    refitAfterRestore();
    return true;
  },

  updateCueTimes: (cueId, start, end) => {
    if (isEditorBusy(get())) return;
    cueGen++;
    rawSet({
      cues: get().cues.map((c) => (c.id === cueId ? { ...c, start, end } : c)),
    });
  },

  snapshotHistory: () => {
    if (isEditorBusy(get())) return;
    pushUndo(get());
  },

  fillGaps: () => {
    if (isEditorBusy(get())) return;
    const { cues, style } = get();
    cueGen++;
    // no undo step: with it on, an undo's unfilled captions would be
    // filled again at once; the button itself switches it back
    const on = !style.fillGaps;
    set({ style: { ...style, fillGaps: on }, cues: on ? cues : naturalCueEnds(cues) });
  },

  toggleTranscript: () => set({ transcriptVisible: !get().transcriptVisible }),

  splitPosAt: (t) => {
    if (isEditorBusy(get())) return;
    const { posSegments, duration } = get();
    if (!canSplitPosAt(posSegments, duration, t)) return;
    if (posSegments.length === 0) {
      pushUndo(get());
      set({
        posSegments: [
          { id: posId++, start: 0, end: t, x: null, y: null },
          { id: posId++, start: t, end: duration, x: null, y: null },
        ],
      });
      return;
    }
    const i = posSegments.findIndex(
      (s) => t >= s.start + MIN_POS_SEG && t <= s.end - MIN_POS_SEG,
    );
    if (i < 0) return;
    pushUndo(get());
    const s = posSegments[i];
    const next = [...posSegments];
    next.splice(
      i,
      1,
      { ...s, end: t },
      { id: posId++, start: t, end: s.end, x: s.x, y: s.y },
    );
    set({ posSegments: next });
  },

  snapPosToCues: () => {
    if (isEditorBusy(get())) return;
    const { posSegments, cues, duration } = get();
    if (!posSegments.length || !cues.length) return;
    pushUndo(get());
    set({ posSegments: snapPosSegments(posSegments, cues, duration) });
  },

  movePosSegment: (id, start) => {
    if (isEditorBusy(get())) return;
    const segs = get().posSegments;
    const i = segs.findIndex((s) => s.id === id);
    if (i < 0) return;
    const s = segs[i];
    const dur = s.end - s.start;
    const lo = i > 0 ? segs[i - 1].end : 0;
    const hi = (i < segs.length - 1 ? segs[i + 1].start : get().duration) - dur;
    if (hi < lo) return; // no room to move
    const ns = Math.max(lo, Math.min(hi, start));
    const next = [...segs];
    next[i] = { ...s, start: ns, end: ns + dur };
    set({ posSegments: next });
  },

  trimPosSegment: (id, side, t) => {
    if (isEditorBusy(get())) return;
    const segs = get().posSegments;
    const i = segs.findIndex((s) => s.id === id);
    if (i < 0) return;
    const s = segs[i];
    const next = [...segs];
    if (side === "start") {
      const lo = i > 0 ? segs[i - 1].end : 0;
      next[i] = { ...s, start: Math.max(lo, Math.min(t, s.end - MIN_POS_SEG)) };
    } else {
      const hi = i < segs.length - 1 ? segs[i + 1].start : get().duration;
      next[i] = { ...s, end: Math.min(hi, Math.max(t, s.start + MIN_POS_SEG)) };
    }
    set({ posSegments: next });
  },

  deletePosSegment: (id) => {
    if (isEditorBusy(get())) return;
    pushUndo(get());
    set({ posSegments: get().posSegments.filter((s) => s.id !== id) });
  },

  setPosOverride: (id, x, y) => {
    if (isEditorBusy(get())) return;
    set({
      posSegments: get().posSegments.map((s) =>
        s.id === id ? { ...s, x, y } : s,
      ),
    });
  },

  clearPosOverride: (id) => {
    if (isEditorBusy(get())) return;
    pushUndo(get());
    set({
      posSegments: get().posSegments.map((s) =>
        s.id === id ? { ...s, x: null, y: null } : s,
      ),
    });
  },

  addTextAt: (t) => {
    if (isEditorBusy(get())) return;
    const dur = get().duration;
    if (dur <= 0) return;
    const start = Math.max(0, Math.min(t, dur - 0.5));
    // new texts start from the current caption look, then style freely
    const st = get().style;
    const tx: TextOverlay = {
      id: textId++,
      text: "Your text",
      start,
      end: Math.min(dur, start + 2.5),
      x: 50,
      y: 30,
      w: 40,
      sizePct: 5,
      color: "#FFFFFF",
      fontFamily: st.fontFamily,
      outlineColor: st.outlineColor,
      outlineWidth: st.outlineWidth,
      shadowDepth: st.shadowDepth,
      boxEnabled: false,
      boxColor: "#000000",
      rotation: 0,
    };
    pushUndo(get());
    set({
      texts: [...get().texts, tx],
      selectedTextId: tx.id,
      editingTextId: tx.id,
      boxSelected: false,
    });
  },

  updateText: (id, patch) => {
    if (isEditorBusy(get())) return;
    set({
      texts: get().texts.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    });
  },

  deleteText: (id) => {
    if (isEditorBusy(get())) return;
    pushUndo(get());
    set({
      texts: get().texts.filter((t) => t.id !== id),
      selectedTextId: get().selectedTextId === id ? null : get().selectedTextId,
      editingTextId: get().editingTextId === id ? null : get().editingTextId,
    });
  },

  setSelectedText: (id) => {
    // switching selection (or deselecting) always leaves inline edit mode;
    // only one box is ever active — selecting a text drops the caption box
    set({
      selectedTextId: id,
      editingTextId: id === get().selectedTextId ? get().editingTextId : null,
      boxSelected: id == null ? get().boxSelected : false,
    });
  },

  editingTextId: null,
  setEditingText: (id) => {
    // entering inline edit makes the whole typing session one undo step
    if (id != null && id !== get().editingTextId) pushUndo(get());
    set({ editingTextId: id });
  },

  boxSelected: false,
  setBoxSelected: (v) =>
    set(
      v
        ? { boxSelected: true, selectedTextId: null, editingTextId: null }
        : { boxSelected: false },
    ),

  reset: () => {
    get().cancelCadence();
    abortScriptChecks();
    for (const c of get().clips) releaseClip(c.id);
    clipSlots.clear();
    clearTranscribeQueue();
    const prev = get().videoUrl;
    if (prev?.startsWith("blob:")) URL.revokeObjectURL(prev);
    clearHistory();
    set({
      videoUrl: null,
      projectLibraryOpen: true,
      importedFile: null,
      saveError: null,
      localSaveState: "idle",
      localSaveError: null,
      fileName: "",
      clips: [],
      activeClipId: null,
      selectedClipIds: [],
      words: [],
      cues: [],
      posSegments: [],
      texts: [],
      selectedTextId: null,
      editingTextId: null,
      peaks: null,
      pcm: null,
      sourceWidth: 0,
      sourceHeight: 0,
      currentTime: 0,
      duration: 0,
      status: { phase: "idle" },
      playing: false,
      cadenceApplied: false,
      cadenceFit: null,
      cadenceDirty: false,
      done: false,
      refiningClipId: null,
      refining: false,
      refineError: null,
      transcribeNote: null,
      cadenceRunOutcome: "idle",
      applyingMaster: false,
      applyMasterProgress: null,
      masterApplyResults: null,
      masterApplyInserted: null,
      masterApplyCorrected: null,
      rangeSel: null,
      fps: 30,
      srcFps: null,
      fpsManual: false,
      projectId: null,
      serverProjectReady: false,
      serverRevision: 0,
      serverConflict: false,
      serverCaptioning: false,
      autoCadence: storedAutoCadence(),
      script: "",
      scriptFixes: {},
      scriptCheckError: null,
      setupPending: false,
      saveState: "idle",
    });
  },
};
});

// dev-only handle for debugging and browser-driven tests
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__studio = useStudio;
}
