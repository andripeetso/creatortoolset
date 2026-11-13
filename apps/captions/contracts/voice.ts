/**
 * Settings → AI → Voice: the languages a person speaks in their videos, and which engine turns speech into text, by
 * default and for each use. One record per account ($DATA_DIR/voice-prefs/<user>.json, api/voice-prefs.ts):
 *   GET /api/voice-prefs → VoiceView   PUT /api/voice-prefs { languages?, stt? } → VoiceView
 * Every speech-to-text call asks api/lib/speech.ts `speechFor(actor, use)`, so a choice here changes that use and only
 * that one. A project or an edit can name its own language (it wins over these).
 */

/** Where speech becomes text. `mic` is talking to the assistant (the web dock and the phone). */
export const SPEECH_USES = ["captions", "transcripts", "editor", "mic"] as const;
export type SpeechUse = (typeof SPEECH_USES)[number];

export const SPEECH_USE_NAMES: Record<SpeechUse, string> = {
  captions: "Captions",
  transcripts: "Media Library transcripts",
  editor: "AI Editor",
  mic: "Talking to the assistant",
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
  /** One line: what it is good at, measured where we measured. */
  about: string;
  /** Where it is hosted (the model's own page). */
  page: string;
  /** Its licence as published on that page; every one listed allows commercial use. */
  licence: string;
  /** Download size, for a local model. */
  mb?: number;
  /** A local model one of the person's computers downloads (Download, contracts/devices.ts TRANSCRIBE_KIND); absent = the server's own (whisper-base). */
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
  { id: "nova-3", engine: "deepgram", name: "Deepgram Nova-3", about: "Keeps every um and restart, which the AI Editor cuts at",
    page: "https://developers.deepgram.com/docs/models-languages-overview", licence: "Paid API, your own key", languages: "many" },
  { id: "whisper-1", engine: "openai", name: "OpenAI Whisper", about: "Tidies speech: an um or a restart is often left out",
    page: "https://platform.openai.com/docs/guides/speech-to-text", licence: "Paid API, your own key", languages: "many" },
  // what a computer downloads is the page's own repository: a conversion for its runtime (faster-whisper, onnx-asr)
  { id: "whisper-large-v3", engine: "local", name: "Whisper large-v3", about: "The closest a free model came to Deepgram on Estonian (30% words wrong), best with a graphics card",
    page: "https://huggingface.co/Systran/faster-whisper-large-v3", licence: "MIT", mb: 3090, languages: "many", computer: true },
  { id: "whisper-large-v3-turbo", engine: "local", name: "Whisper large-v3 turbo", about: "As close as large-v3 on Estonian, twice as fast with half the memory",
    page: "https://huggingface.co/deepdml/faster-whisper-large-v3-turbo-ct2", licence: "MIT", mb: 1621, languages: "many", computer: true },
  // its card lists 25 languages; on Estonian it got nearly half the words wrong, so it is offered for English only
  { id: "parakeet-tdt-0.6b-v3", engine: "local", name: "Parakeet TDT 0.6B v3", about: "English only: the fastest, and the closest word times",
    page: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx", licence: "CC-BY-4.0, by NVIDIA", mb: 2550, languages: ["en"], computer: true },
  { id: "whisper-base", engine: "local", name: "Whisper base", about: "Small and quick, the one the browser already uses",
    page: "https://huggingface.co/onnx-community/whisper-base", licence: "Apache-2.0", mb: 291, languages: "many" },
];

export interface VoicePrefs {
  /** ISO 639-1 codes, the ones spoken in this person's videos; empty = detect it each time. */
  languages: string[];
  stt: { default: SttChoice; per: Partial<Record<SpeechUse, SttChoice>> };
}

export const DEFAULT_VOICE_PREFS: VoicePrefs = { languages: [], stt: { default: { engine: "auto" }, per: {} } };

/** What one use runs on now, for the page: the engine that will be asked, or why none can be. */
export type SttResolved =
  | { use: SpeechUse; engine: Exclude<SttEngine, "auto">; model: string }
  | { use: SpeechUse; needs: string };

export interface VoiceView extends VoicePrefs {
  /** Each use as it resolves for this account right now. */
  resolved: SttResolved[];
  /** Engines that can serve this account now (a key, this computer, or a computer of theirs with a model), so the page offers only those. */
  available: Exclude<SttEngine, "auto">[];
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
  /** ready: downloaded; downloading: under way; asked: Download was pressed, the computer has not started (it is off) */
  models: { id: string; state: "ready" | "downloading" | "asked" }[];
}

/** A two-letter language code. */
export const isLanguage = (s: unknown): s is string => typeof s === "string" && /^[a-z]{2}$/.test(s);
