import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { env } from "./env";
import { keyFor } from "../my-keys";
import { deviceTranscribes } from "./device-transcribe";
import {
  DEFAULT_VOICE_PREFS, SPEECH_USES, STT_ENGINES, STT_MODELS, isLanguage,
  type SpeechUse, type SttChoice, type SttEngine, type SttResolved, type VoicePrefs,
} from "../../contracts/voice";

/**
 * The one place that decides which engine turns speech into text, for whom and for what (contracts/voice.ts). Every
 * speech-to-text call asks `speechFor`; nothing else reads the voice prefs.
 */

type Actor = Parameters<typeof keyFor>[0];
type Engine = Exclude<SttEngine, "auto">;

const fileOf = (username: string) => path.join(env.dataDir, "voice-prefs", `${username}.json`);
const userOf = (actor: Actor) => (typeof actor === "string" ? actor : actor?.username) ?? "";

export function readVoicePrefs(username: string): VoicePrefs {
  try {
    const kept = JSON.parse(readFileSync(fileOf(username), "utf-8")) as Partial<VoicePrefs>;
    return { languages: kept.languages ?? [], stt: { default: kept.stt?.default ?? { engine: "auto" }, per: kept.stt?.per ?? {} } };
  } catch {
    return structuredClone(DEFAULT_VOICE_PREFS);
  }
}

const choiceError = (c: unknown): string | null => {
  const o = c as SttChoice | null;
  if (!o || typeof o !== "object" || !STT_ENGINES.includes(o.engine)) return `engine is one of ${STT_ENGINES.join(", ")}`;
  if (o.model !== undefined && !STT_MODELS.some((m) => m.id === o.model && m.engine === o.engine)) return `${o.model} is not a ${o.engine} model`;
  return null;
};

/** Apply a change; an unknown value is an error, a missing one keeps what was there. `per.<use>: null` clears a use. */
export function writeVoicePrefs(username: string, b: Record<string, unknown>): VoicePrefs | string {
  const next = readVoicePrefs(username);
  if (b.languages !== undefined) {
    if (!Array.isArray(b.languages) || !b.languages.every(isLanguage)) return "languages is a list of two-letter codes (empty: detect it)";
    next.languages = [...new Set(b.languages as string[])];
  }
  const stt = b.stt as { default?: unknown; per?: Record<string, unknown> } | undefined;
  if (stt?.default !== undefined) {
    const e = choiceError(stt.default);
    if (e) return e;
    next.stt.default = stt.default as SttChoice;
  }
  for (const [use, c] of Object.entries(stt?.per ?? {})) {
    if (!SPEECH_USES.includes(use as SpeechUse)) return `${use} is not one of ${SPEECH_USES.join(", ")}`;
    if (c === null) {
      delete next.stt.per[use as SpeechUse];
      continue;
    }
    const e = choiceError(c);
    if (e) return e;
    next.stt.per[use as SpeechUse] = c as SttChoice;
  }
  const file = fileOf(username);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(next));
  renameSync(`${file}.tmp`, file);
  return next;
}

/** Engines that can serve this account now: a key it has, or this computer. */
export function availableEngines(actor: Actor): Engine[] {
  const out: Engine[] = [];
  if (!keyFor(actor, "DEEPGRAM_API_KEY").missing) out.push("deepgram");
  if (!keyFor(actor, "OPENAI_API_KEY").missing) out.push("openai");
  if (deviceTranscribes()) out.push("local");
  return out;
}

const NEEDS: Record<Engine, string> = {
  deepgram: "Needs a Deepgram key",
  openai: "Needs an OpenAI key",
  local: "Runs only on a server on your own computer",
};
const KEY: Partial<Record<Engine, "DEEPGRAM_API_KEY" | "OPENAI_API_KEY">> = { deepgram: "DEEPGRAM_API_KEY", openai: "OPENAI_API_KEY" };

export type Speech =
  | { engine: "deepgram" | "openai"; model: string; key: string; languages: string[] }
  | { engine: "local"; model: string; languages: string[] };

/**
 * What `use` runs on for `actor`: their choice for that use, else their default; `auto` is the first that serves them
 * (Deepgram, OpenAI, this computer). `languages` (a project's or an edit's) win over the person's. Null + why when
 * nothing can serve them.
 */
export function speechFor(actor: Actor, use: SpeechUse | "default", languages?: string[]): Speech | { needs: string; key?: "DEEPGRAM_API_KEY" | "OPENAI_API_KEY" } {
  const prefs = readVoicePrefs(userOf(actor));
  const choice = (use !== "default" && prefs.stt.per[use]) || prefs.stt.default;
  const langs = languages?.length ? languages : prefs.languages;
  const can = availableEngines(actor);
  const engine = choice.engine === "auto" ? can[0] : choice.engine;
  if (!engine) return { needs: "Add your Deepgram (or OpenAI) key in Settings → API keys", key: "DEEPGRAM_API_KEY" };
  if (!can.includes(engine)) return { needs: NEEDS[engine], ...(KEY[engine] ? { key: KEY[engine] } : {}) };
  const model = (choice.engine === engine && choice.model) || STT_MODELS.find((m) => m.engine === engine)!.id;
  if (engine === "local") return { engine, model, languages: langs };
  const name = engine === "deepgram" ? "DEEPGRAM_API_KEY" : "OPENAI_API_KEY";
  return { engine, model, key: keyFor(actor, name).key, languages: langs };
}

/** One use (or the default) as it resolves now, for the Voice page. */
export function resolvedOne(actor: Actor, use: SpeechUse | "default"): SttResolved {
  const s = speechFor(actor, use);
  return "needs" in s ? { use, ...s } : { use, engine: s.engine, model: s.model };
}

/**
 * What a job run on one of the person's own computers is told (the AI Editor's claim): the engine and model `speechFor`
 * picks, never the key (that computer uses its own), and the languages, which go along even when no engine serves
 * this account here.
 */
export function speechJob(actor: Actor, use: SpeechUse, languages?: string[]): { engine?: Engine; model?: string; languages: string[] } {
  const s = speechFor(actor, use, languages);
  if ("needs" in s) return { languages: languages?.length ? languages : readVoicePrefs(userOf(actor)).languages };
  return { engine: s.engine, model: s.model, languages: s.languages };
}

/** Every use as it resolves now, for the Voice page. */
export const resolvedFor = (actor: Actor): SttResolved[] => SPEECH_USES.map((use) => resolvedOne(actor, use));
