import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { env } from "./env";
import { keyFor } from "../my-keys";
import { deviceTranscribes } from "./device-transcribe";
import { speechComputers } from "./computer-transcribe";
import { isOnline } from "./devices";
import {
  COMPUTER_USES, DEFAULT_VOICE_PREFS, SPEECH_USES, STT_ENGINES, STT_MODELS, isLanguage,
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

/** The account's computers that `use` may run on: none for a use that does not route to computers yet (COMPUTER_USES). */
const computersFor = (actor: Actor, use: SpeechUse | undefined) => (use && COMPUTER_USES.includes(use) ? speechComputers(userOf(actor)) : []);

/**
 * Engines that can serve `use` for this account now: a key it has, the server itself, or (for COMPUTER_USES) a computer
 * of its own with a speech model. No use: the ones every use can run.
 */
export function availableEngines(actor: Actor, use?: SpeechUse): Engine[] {
  const out: Engine[] = [];
  if (!keyFor(actor, "DEEPGRAM_API_KEY").missing) out.push("deepgram");
  if (!keyFor(actor, "OPENAI_API_KEY").missing) out.push("openai");
  if (deviceTranscribes() || computersFor(actor, use).some((d) => d.stt?.held.length)) out.push("local");
  return out;
}

/** availableEngines for each use, for the Voice page's per-use rows. */
export const availableFor = (actor: Actor): Record<SpeechUse, Engine[]> =>
  Object.fromEntries(SPEECH_USES.map((use) => [use, availableEngines(actor, use)])) as Record<SpeechUse, Engine[]>;

const NEEDS: Record<Engine, string> = {
  deepgram: "Needs a Deepgram key",
  openai: "Needs an OpenAI key",
  local: "Needs a speech model on one of your computers",
};
const KEY: Partial<Record<Engine, "DEEPGRAM_API_KEY" | "OPENAI_API_KEY">> = { deepgram: "DEEPGRAM_API_KEY", openai: "OPENAI_API_KEY" };
/** A use that does not route to computers yet, asked to run on one (COMPUTER_USES). */
const COMPUTERS_ONLY_FOR = "Speech models on your computers do Media Library transcripts only";

/** `on`: a local model runs on the server itself (lib/device-transcribe.ts) or on the person's computers (lib/computer-transcribe.ts). */
export type Speech =
  | { engine: "deepgram" | "openai"; model: string; key: string; languages: string[] }
  | { engine: "local"; model: string; languages: string[]; on: "server" | "computers" };

/**
 * A local model for this account. A chosen one runs where it can: the server's own on the server (where it runs on its
 * owner's computer), a downloaded one on the person's computers, waiting for one that is off. None chosen: the first in
 * STT_MODELS that hears these languages (none: one that hears every language) on a computer that is on; else the
 * server's own; else one on a computer that is off.
 */
function localFor(actor: Actor, use: SpeechUse, chosen: string | undefined, langs: string[]): { model: string; on: "server" | "computers" } | { needs: string } {
  const routed = COMPUTER_USES.includes(use);
  const mine = computersFor(actor, use);
  const kept = (id: string) => mine.filter((d) => d.stt?.held.includes(id));
  if (chosen) {
    const m = STT_MODELS.find((x) => x.id === chosen)!;
    if (!m.computer) return deviceTranscribes() ? { model: chosen, on: "server" } : { needs: NEEDS.local };
    if (!routed) return { needs: COMPUTERS_ONLY_FOR };
    return kept(chosen).length ? { model: chosen, on: "computers" } : { needs: `Needs ${m.name} on one of your computers` };
  }
  const hears = (m: (typeof STT_MODELS)[number]) => m.languages === "many" || (langs.length > 0 && langs.every((l) => m.languages.includes(l)));
  const fit = STT_MODELS.filter((m) => m.computer && hears(m) && kept(m.id).length);
  const on = fit.find((m) => kept(m.id).some((d) => isOnline(d.id))) ?? (deviceTranscribes() ? undefined : fit[0]);
  if (on) return { model: on.id, on: "computers" };
  return deviceTranscribes() ? { model: "whisper-base", on: "server" } : { needs: routed ? NEEDS.local : COMPUTERS_ONLY_FOR };
}

/**
 * What `use` runs on for `actor`: their choice for that use, else their default; `auto` is the first that serves them
 * (Deepgram, OpenAI, a model on their own computers: localFor). `languages` (a project's or an edit's) win over the person's. Null + why when
 * nothing can serve them.
 */
export function speechFor(actor: Actor, use: SpeechUse | "default", languages?: string[]): Speech | { needs: string; key?: "DEEPGRAM_API_KEY" | "OPENAI_API_KEY" } {
  const prefs = readVoicePrefs(userOf(actor));
  const choice = (use !== "default" && prefs.stt.per[use]) || prefs.stt.default;
  const langs = languages?.length ? languages : prefs.languages;
  const can = availableEngines(actor, use === "default" ? "transcripts" : use);
  const engine = choice.engine === "auto" ? can[0] : choice.engine;
  if (!engine) return { needs: "Add your Deepgram (or OpenAI) key in Settings → API keys", key: "DEEPGRAM_API_KEY" };
  // the default row stands for every use: a local model on it is read as the transcripts' (the one use computers serve)
  const as: SpeechUse = use === "default" ? "transcripts" : use;
  // local asked of a use that can't run on computers: a model on one would not help, so it says that
  if (!can.includes(engine)) {
    if (engine === "local" && !COMPUTER_USES.includes(as)) return { needs: COMPUTERS_ONLY_FOR };
    return { needs: NEEDS[engine], ...(KEY[engine] ? { key: KEY[engine] } : {}) };
  }
  const chosen = (choice.engine === engine && choice.model) || undefined;
  if (engine === "local") {
    const l = localFor(actor, as, chosen, langs);
    return "needs" in l ? l : { engine, ...l, languages: langs };
  }
  const model = chosen || STT_MODELS.find((m) => m.engine === engine)!.id;
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
