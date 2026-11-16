/**
 * Editor steps that run on a device (a Mac on the account, paired in Settings → Devices). A device declares the step
 * kinds it can run when it claims work; the server hands it only device kinds (api/editor/engine.ts) and only jobs of
 * its own account's edits. Routes (api/devices.ts, under /api/devices/relay/, Authorization: Bearer ctd_…):
 *   POST editor/claim          DeviceClaimBody → DeviceClaim      declare kinds, take one step (or job: null)
 *   POST editor/job/:id/beat                    → { ok: boolean } keep a step's lease while it runs (every 15 s or so)
 *   POST editor/job/:id/done                    → DeviceEnded     the step finished
 *   POST editor/job/:id/fail   { error }        → DeviceEnded     the step failed (retried later, or failed after 3 tries; a
 *                                                                 cards-draw whose script threw fails at once, api/editor/worker.ts)
 * A device never asks for a step on a clock. Its long poll for AI requests (POST wait) lists the kinds it would claim
 * right now, `{ blobs, editor: string[] }`: they are kept as the kinds it declares (an empty list: none), and when a
 * claim made now would be handed a step the poll is answered at once with EDITOR_HINT, after any AI request. The device
 * then claims. A poll that lists no `editor` changes nothing and is never answered with the hint.
 *   GET  editor/job/:id/cards                   → CardsDraw       a cards-draw step: what to draw
 *   POST editor/job/:id/cards/:cardId           multipart: `clip` (H.264 mp4, no sound) and `still` three times (PNG, 540 px
 *                                               wide: first, middle and last frame) → { ok: true }; then done or fail
 * ok is false when the device does not hold that step (not claimed by it, or already released). A device that is not
 * online (no call in the last 40 s) loses the steps it holds; they go back in the queue.
 */

/**
 * The step kind of the Resolve bridge (the Mac app's ResolveBridge). A device is handed it only while its account has an
 * installed pack with Resolve items (api/lib/packs.ts resolveGranted); without one the helper stays off.
 */
export const RESOLVE_KIND = "resolve";

/**
 * The step kind that draws an edit's cards (the Mac app's sandboxed page). The script in a CardsDraw is an AI's output:
 * it runs only there, never on the server and never in a page of this app.
 */
export const CARDS_DRAW_KIND = "cards-draw";

/**
 * The kind that cuts a still picture out of its background on a Mac (api/lib/cutouts.ts; the Mac app's Cutout.swift). Not an
 * edit step: a person's call queues it (the cut-out plug-in), and a Mac lists, is hinted and claims it on the road above.
 *   GET  cutout/:id                             → the picture (PNG, JPEG or HEIC)
 *   POST cutout/:id        multipart `cutout`: the PNG, its background see-through → DeviceEnded
 *   POST cutout/:id/fail   { error }            → DeviceEnded
 */
export const CUTOUT_KIND = "cutout";

/**
 * The kind that splits a still picture into what a design is made of (api/lib/cutouts.ts; the Mac app's Split.swift): its
 * words, read with where each line lies, its colour and how heavy its letters are; each piece that stands out, cut out;
 * and what is left, with the words and pieces painted over. The road is the cut-out's, its answer is SplitLayout:
 *   GET  cutout/:id                             → the picture (PNG, JPEG or HEIC)
 *   POST cutout/:id        multipart `layout` (SplitLayout, JSON), `background` (PNG), `piece0`, `piece1`… (PNG) → DeviceEnded
 *   POST cutout/:id/fail   { error }            → DeviceEnded
 */
export const SPLIT_KIND = "split";

/**
 * The kind that turns speech into text with a model downloaded on the person's own computer (api/lib/computer-transcribe.ts),
 * for the Media Library's transcripts when their engine is `local` (api/lib/speech.ts speechFor). Not an edit step: it is
 * listed, hinted and claimed on the road above, with what the computer holds in the claim:
 *   claim { kinds: [..., "transcribe"], models: [ids it has], getting: [ids it is downloading],
          asked?: [ids its person got on it itself since its last claim (a Mac's Dictation)] }
 *     → { job, models: [ids its owner wants on it] }   it downloads each wanted one it lacks (STT_MODELS `download`, a
 *       Hugging Face repository) and deletes each it has that is not wanted, then claims again
 *   GET  transcribe/:id            → the audio: WAV, 16 kHz mono 16-bit; the job's `model` and `languages` say how
 *   POST transcribe/:id            TranscribeResult → DeviceEnded
 *   POST transcribe/:id/fail       { error } → DeviceEnded
 * A transcript goes to the strongest of the account's computers that is on and has the model (computer-transcribe.ts
 * strongest). The long poll is also answered with the hint when the wanted models differ from what the computer said
 * it has, so a Download pressed in Settings reaches it at once. While it works, it keeps its long poll going (or it is
 * not online, and the transcript goes back in the queue).
 */
export const TRANSCRIBE_KIND = "transcribe";

/**
 * The kind that lists a folder on the person's own Mac for the assistant's folder_list (api/lib/folder-list.ts; the Mac
 * app's FolderListJob.swift), when the folder is not on the computer this server runs on. Not an edit step: claimed on
 * the road above, through the device job routes. The claim's options: `path` (absolute, on that Mac), `depth` (levels,
 * "1" to "6") and `disk` ("1": the folder may be a drive's own top folder, as a workspace's own Storage folder may be).
 *   POST job/folder-list/:id        FolderWalk → DeviceEnded
 *   POST job/folder-list/:id/fail   { error } → DeviceEnded
 */
export const FOLDER_LIST_KIND = "folder-list";

/**
 * The kind that writes the Media Library's shot descriptions of a file kept on a Mac with nothing uploaded
 * (api/library/mac-look.ts; the Mac app's LibraryLookJob.swift). Claimed on the road above, only by the Mac the file is
 * on, of the account that added it, one at a time. The claim's options: `path` (on that Mac), `version`, `duration`
 * (seconds), `format` (the sheets', shots.ts SHEET_FORMAT) and `stretches` (JSON [[a, b], …]; "[]": read the picture).
 *   POST job/library-look/:id   { beat: true }                     → {}   keeps the job the Mac's (its lease, 5 min)
 *   POST job/library-look/:id   { signal: PictureSignal }          → { stretches: [{ seg, a, b }] }, found here
 *   POST job/library-look/:id   { sheet: { segs, jpeg, ph } }      → {}   one sheet: base64 JPEG, its stretches' picture hashes
 *   POST job/library-look/:id   { done: true, format }             → DeviceEnded: the look lane asks the AI from them once
 *   POST job/library-look/:id/fail   { error } → DeviceEnded
 * The sheets stay on the Mac; the server holds them in memory until the AI's call and keeps none.
 */
export const LIBRARY_LOOK_KIND = "library-look";

/**
 * The kind that checks a computer for helping with heavy work (setup's Help screen, Settings → Devices; api/lib/helper-check.ts).
 * Claimed on the road above, only by the computer it is for. The claim's options: `folders` (JSON, folder id → its path
 * on this computer) and `test` ("1": read part of one real file in each folder and time a short encode; "": only the
 * disks). The computer first posts its report again with its disks read now (relay/report), then:
 *   POST job/helper-check/:id        HelperCheckSent → DeviceEnded
 *   POST job/helper-check/:id/fail   { error } → DeviceEnded
 */
export const HELPER_CHECK_KIND = "helper-check";

/** What the computer found: ffmpeg runs, how fast it encodes, and each folder read or why not. */
export interface HelperCheckSent {
  ffmpeg: boolean;
  /** seconds of 720p video encoded in one second (a test only); absent when the encode failed */
  encode?: number;
  folders: Array<{ id: string; ok: boolean; error?: string }>;
}

/** A computer's last test (Device.check): what it sent, when, and each folder's name. */
export interface HelperCheck extends HelperCheckSent {
  at: number;
  folders: Array<{ id: string; name: string; ok: boolean; error?: string }>;
}

/** A HelperCheckSent from an untrusted body, only the folders asked about; null when it is not one. */
export function parseHelperCheck(v: unknown, asked: readonly string[]): HelperCheckSent | null {
  const b = v as { ffmpeg?: unknown; encode?: unknown; folders?: unknown } | null;
  if (!b || typeof b.ffmpeg !== "boolean" || !Array.isArray(b.folders)) return null;
  const folders = (b.folders as Array<Record<string, unknown> | null>).flatMap((f) =>
    typeof f?.id === "string" && asked.includes(f.id) && typeof f.ok === "boolean"
      ? [{ id: f.id, ok: f.ok, ...(typeof f.error === "string" && f.error ? { error: f.error.slice(0, 300) } : {}) }]
      : [],
  );
  const encode = typeof b.encode === "number" && Number.isFinite(b.encode) && b.encode > 0 && b.encode < 10_000 ? b.encode : undefined;
  return { ffmpeg: b.ffmpeg, ...(encode ? { encode } : {}), folders };
}

/**
 * The Prefer / Normal / Less often / Off weight (contracts/providers.ts LOAD_PREFERENCES) a test sets: Off when it can't
 * render or a folder failed to read (a job would fail there), Less often when it encodes slower than the video plays,
 * else Normal. Never Prefer: the encode's speed depends on each computer's own ffmpeg build (measured 11-15: a 32-core
 * Linux PC 3.0×, a Mac Studio 5.0×), and load balancing already weighs cores, load and memory; Prefer is the person's call.
 */
export function weightFor(c: HelperCheckSent): number {
  if (!c.ffmpeg || !c.encode || c.folders.some((f) => !f.ok)) return 0;
  return c.encode >= 1 ? 50 : 25;
}

/** What a computer sends back: the words heard, with times in seconds, and the language heard (ISO 639-1) or null. */
export interface TranscribeResult {
  words: { text: string; start: number; end: number }[];
  language: string | null;
}

/** Most words in one result (about 30 hours of talk), and most models one computer lists. */
export const TRANSCRIBE_MAX_WORDS = 300_000;
const MODELS_MAX = 20;

/** A list of model ids from an untrusted body, keeping those `known` names; null when it is not such a list. */
export function parseModels(value: unknown, known: (id: string) => boolean): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MODELS_MAX || !value.every((m) => typeof m === "string")) return null;
  return [...new Set((value as string[]).filter(known))];
}

/** A TranscribeResult from an untrusted body, or why not. */
export function parseTranscribeResult(v: unknown): TranscribeResult | string {
  const o = v as { words?: unknown; language?: unknown } | null;
  if (!o || !Array.isArray(o.words)) return "words: a list of { text, start, end }";
  if (o.words.length > TRANSCRIBE_MAX_WORDS) return `More than ${TRANSCRIBE_MAX_WORDS} words`;
  const words: TranscribeResult["words"] = [];
  for (const w of o.words as Record<string, unknown>[]) {
    const { text, start, end } = w ?? {};
    if (typeof text !== "string" || typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start)
      return "Each word is { text, start, end }, its times in seconds with end not before start";
    if (text.trim()) words.push({ text: text.trim().slice(0, 100), start, end });
  }
  const language = typeof o.language === "string" && /^[a-z]{2,3}$/.test(o.language) ? o.language : null;
  return { words, language };
}

/** What a cards-draw step asks a Mac to draw: one script for every card of a version, and each card's length and content. */
export interface CardsDraw {
  /** the picture's size in pixels (even numbers) and its frames a second */
  width: number;
  height: number;
  fps: number;
  /** defines kitFrame(t, card) and paints into #stage */
  script: string;
  cards: { id: string; seconds: number; content: { id: string; text: string; line: string } }[];
}

/** The whole answer to a long poll that says an editor step waits. It has no `id`: an answer with one is an AI request. */
export const EDITOR_HINT = { editor: true } as const;

/** The answer to done and fail. `editor: true`: another step this device could claim waits, so it may claim at once. */
export interface DeviceEnded {
  ok: boolean;
  editor?: true;
}

/** Most kinds one device may declare. */
export const DEVICE_KINDS_MAX = 20;
const KIND = /^[a-z][a-z0-9-]{0,39}$/;

/** The kinds a device declares: a list of lowercase words, no repeats. Null when the value is not such a list. */
export function parseKinds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > DEVICE_KINDS_MAX) return null;
  if (!value.every((k) => typeof k === "string" && KIND.test(k))) return null;
  return [...new Set(value as string[])];
}

export interface DeviceClaimBody {
  kinds: string[];
  /** with TRANSCRIBE_KIND: the speech models it has, and the ones it is downloading now */
  models?: string[];
  getting?: string[];
  /** the ones its person got on the computer itself since its last claim; one that went from it was removed there */
  asked?: string[];
}

/** A step handed to a device: its job id, its kind, and the edit it belongs to ("" variant = the whole edit). */
export interface DeviceJob {
  id: number;
  kind: string;
  editId: string;
  variant: string;
  /** a transcribe job: the model to run, and the languages spoken (empty: hear which) */
  model?: string;
  languages?: string[];
  /** a recording someone waits on (the mic): a computer hears it with a model it has loaded, or refuses it at once */
  soon?: boolean;
  /** a plug-in's job (ServerPlugin.deviceJobs): what it needs to know, as words */
  options?: Record<string, string>;
  /** a step that reads the edit's footage (api/editor/reach.ts): each file, by its library version id */
  footage?: DeviceFootage[];
}

/**
 * One footage file of a step, as the computer that took it gets at it: `path`, where it is on this computer (already
 * rewritten for it: a shared folder may be /Volumes/Footage on one computer and /mnt/footage or Z:\ on another), or
 * `copy`, the server's copy to download into its own cache and work on there:
 *   GET relay/editor/job/:id/footage/:version   → the file ("original": the video file; "proxy": only its smaller copy)
 */
export type DeviceFootage = { id: string } & ({ path: string } | { copy: "original" | "proxy" });

export interface DeviceClaim {
  job: DeviceJob | null;
  /** to a device that declares TRANSCRIBE_KIND: the speech models its owner wants on it */
  models?: string[];
}
