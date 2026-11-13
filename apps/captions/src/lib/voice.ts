import { STT_MODELS, type SpeechUse, type SttChoice, type SttEngine, type SttModel, type SttResolved, type VoicePrefs, type VoiceView } from "@contracts/voice";
import { useCachedLoad } from "./local-cache";

/** Settings → AI → Voice's calls (api/voice-prefs.ts, contracts/voice.ts). */

async function json<T>(res: Response): Promise<T> {
  const j = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(j?.error || `Request failed (${res.status})`);
  return j as T;
}

export const getVoice = () => fetch("/api/voice-prefs").then((r) => json<VoiceView>(r));

/** A change: languages, the default, or one use (`null` = back to the default). Answers the whole view. */
export const putVoice = (body: { languages?: string[]; stt?: { default?: SttChoice; per?: Partial<Record<SpeechUse, SttChoice | null>> } }) =>
  fetch("/api/voice-prefs", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => json<VoiceView>(r));

/** Download (keep) or remove a model on one of the person's computers (api/voice-prefs.ts PUT /models). */
export const putModel = (computer: string, model: string, keep: boolean) =>
  fetch("/api/voice-prefs/models", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ computer, model, keep }) }).then((r) => json<VoiceView>(r));

export const useVoice = () => useCachedLoad<VoiceView>("/api/voice-prefs", getVoice, { own: true });

export const ENGINE_NAMES: Record<SttEngine, string> = { auto: "Automatic", deepgram: "Deepgram", openai: "OpenAI", local: "On my computers" };

/** A use's "Same as default" in its select. */
export const SAME = "same";

/**
 * The engines a select offers: the ones that can serve this account now, plus the one it is set to (so a key removed
 * later still shows what is chosen). `auto` only on the Default; a use offers "Same as default" instead.
 */
export function engineOptions(can: Exclude<SttEngine, "auto">[], current: SttEngine | undefined, isDefault: boolean) {
  const engines = [...can, ...(current && current !== "auto" && !can.includes(current) ? [current] : [])];
  return [
    isDefault ? { value: "auto", label: ENGINE_NAMES.auto } : { value: SAME, label: "Same as default" },
    ...engines.map((e) => ({ value: e, label: ENGINE_NAMES[e] })),
  ];
}

export const modelOf = (id: string): SttModel | undefined => STT_MODELS.find((m) => m.id === id);

/** Where a need is fixed: the row of API keys the server named (none for a local engine). */
export const keyFix = (key: string | undefined): string | null => (key ? `/settings/keys#api-key-${key}` : null);

/** A need in the app's one wording ("Needs a Deepgram key"); one without a key as the server says it. */
export function needWords(r: Extract<SttResolved, { needs: string }>): string {
  if (r.key === "DEEPGRAM_API_KEY") return "Needs a Deepgram key";
  if (r.key === "OPENAI_API_KEY") return "Needs an OpenAI key";
  return r.needs;
}

/** The languages the picker offers (ISO 639-1), shown by name; the ones the speech engines here hear well. */
export const LANGUAGES = [
  "en", "et", "fi", "sv", "no", "da", "de", "nl", "fr", "es", "pt", "it", "pl", "cs", "sk", "hu", "ro", "bg", "el",
  "lt", "lv", "ru", "uk", "tr", "ar", "he", "hi", "id", "ms", "th", "vi", "zh", "ja", "ko",
] as const;

const names = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" });
  } catch {
    return null;
  }
})();
export const languageName = (code: string): string => names?.of(code) ?? code;

/** A list of codes with one added or removed, as the PUT takes it. */
export const withLanguage = (p: Pick<VoicePrefs, "languages">, code: string, on: boolean): string[] =>
  on ? [...new Set([...p.languages, code])] : p.languages.filter((c) => c !== code);
