/**
 * Settings → Voice: the languages a person speaks, and which engine turns speech into text, by default and for each
 * use. One record per account ($DATA_DIR/voice-prefs/<user>.json, api/voice-prefs.ts):
 *   GET /api/voice-prefs → VoiceView   PUT /api/voice-prefs { languages?, stt? } → VoiceView
 * Every speech-to-text call asks api/lib/speech.ts `speechFor(actor, use)`, so a choice here changes that use and only
 * that one.
 *
 * Whose language is heard: what is transcribed from a workspace's videos (captions, Media Library transcripts, an AI
 * Editor edit that names none of its own) is heard in that workspace's language (Settings → Workspace → Details;
 * api/lib/video-languages.ts). The person's own list here is for what is theirs, dictation and talking to the
 * assistant, and for a workspace with no language set.
 */

/** Where speech becomes text. `mic` is talking to the assistant (the web dock and the phone). */
export const SPEECH_USES = ["captions", "transcripts", "editor", "mic"] as const;
export type SpeechUse = (typeof SPEECH_USES)[number];

/**
 * The model the AI Editor may run on the person's own computers, for English edits only: it keeps restarts and "um"/"uh"
 * as their own words, which the editor cuts at (Whisper drops them). Every other model, and every other language, leaves
 * the editor on Deepgram (api/lib/speech.ts).
 */
export const EDITOR_COMPUTER_MODEL = "parakeet-tdt-0.6b-v3";

export const SPEECH_USE_NAMES: Record<SpeechUse, string> = {
  captions: "Captions",
  transcripts: "Media Library transcripts",
  editor: "Editor",
  mic: "Assistant voice input",
};

/**
 * `auto`: the first that serves this account: its Deepgram key, then its OpenAI key, then a model on its own computers.
 * `local`: a model on the person's own computers (one they downloaded it to, strongest first; else the server itself
 * when it runs on its owner's computer), never sent to a service.
 */
export const STT_ENGINES = ["auto", "deepgram", "openai", "local"] as const;
export type SttEngine = (typeof STT_ENGINES)[number];

export interface SttChoice {
  engine: SttEngine;
  /** A model of that engine (STT_MODELS ids); absent = the engine's first that can run now (api/lib/speech.ts). */
  model?: string;
}

/** A model an engine can run, with where it comes from and what its licence allows. */
export interface SttModel {
  id: string;
  engine: Exclude<SttEngine, "auto">;
  name: string;
  /** What it is good at, in a few words (Settings shows it with the size, nothing else). */
  about: string;
  /** Who made it: the catalog line reads "Whisper large-v3 turbo by OpenAI, MIT". */
  by: string;
  /** The model's own page (its makers'), whose licence `licence` is. */
  page: string;
  /** Its licence as published on that page; every one listed allows commercial use. */
  licence: string;
  /**
   * The Hugging Face repository a computer downloads (`computer` models; apps/helper keeps the same map): a community
   * conversion of the model on `page` for the runtime that runs it (faster-whisper, onnx-asr), under the same licence.
   */
  download?: string;
  /**
   * The Mac's own version of it, in Core ML: a Whisper's folder name under argmaxinc/whisperkit-coreml (WhisperKit), or a
   * Parakeet's Hugging Face repository (FluidAudio). apps/mac Dictation/Whisper.swift ModelRegistry keeps the same ids.
   */
  coreml?: string;
  /** The first Mac app that runs its `coreml` (`runsOn`); an older one, or one that never said its version, is not offered it. */
  macSince?: string;
  /** A Mac's download size when its Core ML version differs from `mb` (`sizeOn`). */
  coremlMb?: number;
  /** Download size, for a local model. */
  mb?: number;
  /**
   * A local model one of the person's computers downloads (Download, contracts/devices.ts TRANSCRIBE_KIND): a Linux
   * helper from `download`, a Mac from `coreml` (`runsOn`). Absent = the server's own (whisper-base).
   */
  computer?: true;
  /** Languages it hears ("many" = 90 and more), from its model card. */
  languages: "many" | string[];
}

/**
 * Measured 2026-11-12 on an RTX 4080 with Estonian and English talking-head clips, scored against the speaker's own
 * transcript (tasks/voice-models-plan.md): Deepgram 28% of words wrong, Whisper large-v3 30%, turbo 30%, Parakeet 45%
 * on Estonian; Parakeet was the fastest and closest in timing on English.
 */
export const STT_MODELS: SttModel[] = [
  { id: "nova-3", engine: "deepgram", name: "Deepgram Nova-3", by: "Deepgram", about: "Most accurate · keeps filler words",
    page: "https://developers.deepgram.com/docs/models-languages-overview", licence: "Paid API, your own key", languages: "many" },
  { id: "whisper-1", engine: "openai", name: "OpenAI Whisper", by: "OpenAI", about: "Accurate · leaves out filler words",
    page: "https://platform.openai.com/docs/guides/speech-to-text", licence: "Paid API, your own key", languages: "many" },
  // the first a computer has is the one used when no model is chosen (api/lib/speech.ts localFor): turbo is the default
  { id: "whisper-large-v3-turbo", engine: "local", name: "Whisper large-v3 turbo", by: "OpenAI", about: "Most accurate · every language",
    page: "https://huggingface.co/openai/whisper-large-v3-turbo", licence: "MIT", download: "deepdml/faster-whisper-large-v3-turbo-ct2", coreml: "openai_whisper-large-v3-v20240930_turbo", mb: 1621, languages: "many", computer: true },
  { id: "whisper-large-v3", engine: "local", name: "Whisper large-v3", by: "OpenAI", about: "Most accurate, slower · every language",
    page: "https://huggingface.co/openai/whisper-large-v3", licence: "Apache-2.0", download: "Systran/faster-whisper-large-v3", mb: 3090, languages: "many", computer: true },
  // its card lists 25 languages; on Estonian it got nearly half the words wrong, so it is offered for English only
  { id: "parakeet-tdt-0.6b-v3", engine: "local", name: "Parakeet TDT 0.6B v3", by: "NVIDIA", about: "Fastest · English",
    page: "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3", licence: "CC-BY-4.0", download: "istupakov/parakeet-tdt-0.6b-v3-onnx", coreml: "FluidInference/parakeet-tdt-0.6b-v3-coreml", macSince: "0.15.38", coremlMb: 494, mb: 2550, languages: ["en"], computer: true },
  { id: "whisper-base", engine: "local", name: "Whisper base", by: "OpenAI", about: "Smallest · every language",
    page: "https://huggingface.co/openai/whisper-base", licence: "Apache-2.0", mb: 291, languages: "many" },
  // a Mac's smaller ones (Dictation on a Mac): after the others, so none of them is a computer's default
  { id: "whisper-small", engine: "local", name: "Whisper small", by: "OpenAI", about: "Quicker, less accurate · every language",
    page: "https://huggingface.co/openai/whisper-small", licence: "Apache-2.0", coreml: "openai_whisper-small", mb: 490, languages: "many", computer: true },
  { id: "whisper-small.en", engine: "local", name: "Whisper small (English)", by: "OpenAI", about: "Quicker, less accurate · English",
    page: "https://huggingface.co/openai/whisper-small.en", licence: "Apache-2.0", coreml: "openai_whisper-small.en", mb: 488, languages: ["en"], computer: true },
  { id: "whisper-base.en", engine: "local", name: "Whisper base (English)", by: "OpenAI", about: "Smallest, least accurate · English",
    page: "https://huggingface.co/openai/whisper-base.en", licence: "Apache-2.0", coreml: "openai_whisper-base.en", mb: 145, languages: ["en"], computer: true },
  { id: "parakeet-tdt-0.6b-v2", engine: "local", name: "Parakeet TDT 0.6B v2", by: "NVIDIA", about: "Fastest · English",
    page: "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2", licence: "CC-BY-4.0", coreml: "FluidInference/parakeet-tdt-0.6b-v2-coreml", macSince: "0.15.38", mb: 475, languages: ["en"], computer: true },
];

/** Whether a Mac app of `version` is `min` or newer; a build from source ("dev") is the newest, no version the oldest. */
export const macAtLeast = (version: string | undefined, min: string): boolean => {
  if (!version) return false;
  if (version === "dev") return true;
  const a = version.split(".").map(Number), b = min.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return true;
};

/**
 * Whether a computer of this kind (its report's `os`) can download `m`: a Mac its `coreml` (one its app version runs:
 * `macSince`), any other its `download`. One that has not said what it is yet: only a model both have.
 */
export const runsOn = (m: SttModel, os: string | undefined, version?: string): boolean =>
  os === "mac" ? !!m.coreml && (!m.macSince || macAtLeast(version, m.macSince)) : os ? !!m.download : !!m.coreml && !!m.download && !m.macSince;

/** The download size on a computer that runs `os`. */
export const sizeOn = (m: SttModel, os: string | undefined): number | undefined => (os === "mac" ? m.coremlMb ?? m.mb : m.mb);

/**
 * A name or term the engines are told to listen for (`term`, the spelling kept), and what it is misheard as
 * (`soundsLike`, rewritten to `term` after the words come back). At most 100, each spelling unique and 1–50 characters.
 */
export interface SpeechWord {
  term: string;
  soundsLike: string[];
}
export const SPEECH_WORDS_MAX = 100;
export const SPEECH_WORD_ALIASES_MAX = 8;
export const SPEECH_WORD_CHARS_MAX = 50;

/**
 * Why speech could not be written down, sent as 422 `{ error, code: "SPEECH", reason, engine? }` (never 502/504, which a
 * proxy in front blanks): `error` is `speechReasonLine`'s words, and a client offers the matching next step (Settings →
 * API keys for a key, Settings → AI → Voice for a model or engine) from `reason`.
 */
export const SPEECH_REASONS = ["missing-key", "rejected-key", "rate-limit", "model-unavailable", "computer-off", "unavailable"] as const;
export type SpeechReason = (typeof SPEECH_REASONS)[number];
export const SPEECH_CODE = "SPEECH";

/** The sentence a person reads for a speech failure, with its next step (the server sends it as `error`; clients share it). */
export function speechReasonLine(reason: SpeechReason, engine?: string): string {
  const who = engine === "deepgram" ? "Deepgram" : engine === "openai" ? "OpenAI" : "The speech service";
  switch (reason) {
    case "missing-key":
      return engine === "deepgram" || engine === "openai"
        ? `Add your ${who} key in Settings → API keys.`
        : "Add a Deepgram or OpenAI key in Settings → API keys, or put a speech model on one of your computers.";
    case "rejected-key":
      return `${who} rejected the key. Check it in Settings → API keys.`;
    case "rate-limit":
      return `${who} has no credit left or hit its limit. Check the account, or use a speech model on one of your computers.`;
    case "model-unavailable":
      return "The speech model is not available. Choose another in Settings → Voice.";
    case "computer-off":
      return "Needs one of your computers with a speech model, turned on. Turn one on, or add a Deepgram or OpenAI key in Settings → API keys.";
    case "unavailable":
      return engine === "deepgram" || engine === "openai" ? `${who} could not write this down. Try again.` : "Could not write this down. Try again.";
  }
}

export interface VoicePrefs {
  /** ISO 639-1 codes, the ones this person speaks: dictation, talking to the assistant, and the videos of a workspace with no language of its own. */
  languages: string[];
  stt: { default: SttChoice; per: Partial<Record<SpeechUse, SttChoice>> };
  /** Names and terms every engine listens for (Settings → AI → Voice → Words). */
  words?: SpeechWord[];
}

export const DEFAULT_VOICE_PREFS: VoicePrefs = { languages: [], stt: { default: { engine: "auto" }, per: {} }, words: [] };

/** What one use runs on now, for the page: the engine that will be asked, or why none can be. */
export type SttResolved =
  /** `note`: why it runs on another engine than the one chosen (the AI Editor on Deepgram), one quiet line */
  | { use: SpeechUse | "default"; engine: Exclude<SttEngine, "auto">; model: string; note?: string }
  /** `key`: the key that would serve it (its button opens that row of API keys); none for a local engine. */
  | { use: SpeechUse | "default"; needs: string; key?: "DEEPGRAM_API_KEY" | "OPENAI_API_KEY" };

export interface VoiceView extends VoicePrefs {
  /** Each use as it resolves for this account right now. */
  resolved: SttResolved[];
  /** The default choice as it resolves now (`use: "default"`). */
  resolvedDefault: SttResolved;
  /**
   * Engines that can serve every use now (a key, or a model on the server itself), so a page that reads one list never
   * offers a use what it can't run. `availableFor` is per use: the AI Editor runs on the person's computers only with
   * EDITOR_COMPUTER_MODEL, so `local` may be in a use's list and not in this one.
   */
  available: Exclude<SttEngine, "auto">[];
  availableFor: Record<SpeechUse, Exclude<SttEngine, "auto">[]>;
  /**
   * The person's own computers that run speech models (they declare TRANSCRIBE_KIND), strongest first: the order a
   * transcript goes in. Per computer, the `computer` models it has, is downloading, or was asked to download. Download
   * and Remove: PUT /api/voice-prefs/models { computer, model, keep } → VoiceView.
   */
  computers: SttComputer[];
}

export interface SttComputer {
  id: string;
  name: string;
  online: boolean;
  /** what it is (its report): which models it can download (`runsOn`) */
  os?: "mac" | "linux" | "windows";
  /** its Mac app's version (a model's `macSince`) */
  version?: string;
  /** ready: downloaded; downloading: under way; asked: Download was pressed, the computer has not started (it is off) */
  models: { id: string; state: "ready" | "downloading" | "asked" }[];
}

/** A two-letter language code. */
export const isLanguage = (s: unknown): s is string => typeof s === "string" && /^[a-z]{2}$/.test(s);

/** The languages a project or an edit offers (the ones the speech engines here hear), by code. */
export const SPOKEN_LANGUAGES = [
  "en", "et", "fi", "sv", "no", "da", "de", "nl", "fr", "es", "pt", "it", "pl", "cs", "lv", "lt", "ru", "uk",
  "tr", "el", "hu", "ro", "bg", "hi", "ja", "ko", "zh", "id", "vi", "th",
] as const;

/** A language's English name ("et" → "Estonian"); the code itself where the runtime has no name for it. */
export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

const BY_NAME = new Map<string, string>(SPOKEN_LANGUAGES.map((c) => [languageName(c).toLowerCase(), c]));

/** Normalizes a provider's language string ("finnish", "en-US", "fi") to a 2-letter code (or trimmed lowercase when unknown), or null when empty. */
export function languageCode(raw: string | null | undefined): string | null {
  const s = raw?.trim().toLowerCase();
  if (!s) return null;
  const base = s.split(/[-_]/)[0]!;
  if (isLanguage(base)) return base;
  return BY_NAME.get(s) ?? s;
}
