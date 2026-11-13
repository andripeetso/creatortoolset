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
 * `auto`: the first that serves this account: its Deepgram key, then its OpenAI key, then this computer (a server on its
 * owner's computer only). `local`: a model on the person's own computers, never sent anywhere.
 */
export const STT_ENGINES = ["auto", "deepgram", "openai", "local"] as const;
export type SttEngine = (typeof STT_ENGINES)[number];

export interface SttChoice {
  engine: SttEngine;
  /** A model of that engine (STT_MODELS ids); absent = the engine's first. */
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
  | { use: SpeechUse | "default"; engine: Exclude<SttEngine, "auto">; model: string }
  /** `key`: the key that would serve it (its button opens that row of API keys); none for a local engine. */
  | { use: SpeechUse | "default"; needs: string; key?: "DEEPGRAM_API_KEY" | "OPENAI_API_KEY" };

export interface VoiceView extends VoicePrefs {
  /** Each use as it resolves for this account right now. */
  resolved: SttResolved[];
  /** The default choice as it resolves now (`use: "default"`). */
  resolvedDefault: SttResolved;
  /** Engines that can serve this account now (a key, or this computer), so the page offers only those. */
  available: Exclude<SttEngine, "auto">[];
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
