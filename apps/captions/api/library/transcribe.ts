import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { transcribeWav } from "../transcribe";
import { DEVICE_AUDIO, transcribeOnDevice } from "../lib/device-transcribe";
import { MIC_LIMITS, needComputerOn, transcribeOnComputer, type OwnSound } from "../lib/computer-transcribe";
import { isThisMachine } from "../lib/devices";
import { readVoicePrefs, speechFor } from "../lib/speech";
import type { SpeechUse } from "../../contracts/voice";
import { isAdminActor, keyFor } from "../my-keys";
import { findUser } from "../users";
import { libraryDb } from "./db";
import { ffmpegTo } from "./media/run";

/**
 * The library's `transcribe` job (tasks/media-library-plan.md, sections 5, 6 and 11). It runs as the job's actor, on the
 * key that serves them (my-keys.ts keyFor): their own Deepgram or OpenAI key, else the server's for a platform admin.
 * Without one, a server on its owner's computer transcribes by itself (lib/device-transcribe.ts: slower, free);
 * any other server parks the job as `needs_key` with the key to add: never
 * failed, and never on another person's account.
 * Deepgram first (the request Caption Studio sends, api/transcribe.ts), else an
 * OpenAI-compatible /audio/transcriptions endpoint, else this computer.
 */

export interface Segment {
  start: number;
  end: number;
  text: string;
}

/** One spoken word, fillers and false starts kept: text, start and end in seconds, confidence 0-1 when the provider gives it. */
export interface TimedWord {
  w: string;
  s: number;
  e: number;
  c?: number;
}

/** The job can't run for this actor yet: the worker parks it as needs_key with this message. */
export class NeedsKey extends Error {}

/** The key for `actor`, or NeedsKey with what to add. */
export function needKey(actor: string | null, name: Parameters<typeof keyFor>[1]): { key: string } {
  const r = keyFor(actor, name);
  if (r.missing) throw new NeedsKey(r.missing);
  return r;
}

export type Route = { provider: "deepgram" | "openai"; key: string } | { provider: "device" } | { provider: "computer"; model: string; languages: string[] };

/**
 * What transcribes `use` for `actor` (lib/speech.ts speechFor): their key, this computer when the server is on it, or a
 * model on one of their own computers. Throws NeedsKey when there is none.
 */
export function transcribeRoute(actor: string | null, use: SpeechUse = "transcripts"): Route {
  const s = speechFor(actor, use);
  if ("needs" in s) throw new NeedsKey(s.needs);
  if (s.engine !== "local") return { provider: s.engine, key: s.key };
  return s.on === "server" ? { provider: "device" } : { provider: "computer", model: s.model, languages: s.languages };
}

/** Words into segments: one per utterance when Deepgram marks them, else a new one after a pause or 30 words. */
export function wordsToSegments(words: { text: string; start: number; end: number; utterance?: number }[]): Segment[] {
  const out: (Segment & { n: number; u?: number })[] = [];
  for (const w of words) {
    const last = out[out.length - 1];
    const split = !last || (w.utterance !== undefined ? w.utterance !== last.u : w.start - last.end > 1 || last.n >= 30);
    if (split) out.push({ start: w.start, end: w.end, text: w.text, n: 1, u: w.utterance });
    else Object.assign(last, { end: w.end, text: `${last.text} ${w.text}`, n: last.n + 1 });
  }
  return out.map(({ start, end, text }) => ({ start, end, text }));
}

/**
 * Stores a version's transcript (and its words, when given; `model`: the speech model of a computer's) and rewrites its
 * search rows (FTS5 has no upsert), in one transaction.
 */
export function saveTranscript(db: DatabaseSync, versionId: string, provider: string, language: string | null, segments: Segment[], words?: TimedWord[], model?: string): void {
  db.exec("BEGIN");
  try {
    db.prepare("INSERT OR REPLACE INTO transcripts (version_id, provider, language, text, segments, created_at, words, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      versionId,
      provider,
      language,
      segments.map((s) => s.text).join(" "),
      JSON.stringify(segments),
      Date.now(),
      words ? JSON.stringify(words) : null,
      model ?? null,
    );
    db.prepare("DELETE FROM search_segments WHERE version_id = ?").run(versionId);
    const add = db.prepare("INSERT INTO search_segments (version_id, seg, text) VALUES (?, ?, ?)");
    segments.forEach((s, i) => add.run(versionId, i, s.text));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** A version's segments, or [] when it has no transcript. */
export function segmentsOf(db: DatabaseSync, versionId: string): Segment[] {
  const row = db.prepare("SELECT segments FROM transcripts WHERE version_id = ?").get(versionId) as { segments: string } | undefined;
  return row ? (JSON.parse(row.segments) as Segment[]) : [];
}

/** A version's words, or null when its transcript has none (none yet, or made before words were kept). */
export function wordsOf(db: DatabaseSync, versionId: string): TimedWord[] | null {
  const row = db.prepare("SELECT words FROM transcripts WHERE version_id = ?").get(versionId) as { words: string | null } | undefined;
  return row?.words ? (JSON.parse(row.words) as TimedWord[]) : null;
}

export type Transcribed = { segments: Segment[]; words: TimedWord[]; language: string | null };

async function deepgram(file: string, actor: string, fillers: boolean, languages?: string[]): Promise<Transcribed> {
  const role = isAdminActor(actor) ? "admin" : (findUser(actor)?.role ?? "user");
  const r = await transcribeWav(await readFile(file), { username: actor, role, cloud: true, off: [] }, { fillers, languages });
  if ("error" in r) throw new Error(r.error);
  const words = r.words.map((w) => ({ w: w.text, s: w.start, e: w.end, ...(w.confidence !== undefined ? { c: w.confidence } : {}) }));
  return { segments: wordsToSegments(r.words), words, language: r.language };
}

// ponytail: OpenAI's endpoint takes 25 MB, about 100 minutes of the 32 kbps audio sent here; longer files need chunks
async function openai(file: string, key: string, languages?: string[]): Promise<Transcribed> {
  const form = new FormData();
  form.set("file", new Blob([await readFile(file)], { type: "audio/mp4" }), "audio.m4a");
  form.set("model", process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1");
  if (languages?.length === 1) form.set("language", languages[0]!);
  form.set("response_format", "verbose_json");
  // both, or the answer has words and no segments; this model drops most false starts
  form.append("timestamp_granularities[]", "segment");
  form.append("timestamp_granularities[]", "word");
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const r = await fetch(`${base}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!r.ok) throw new Error(`Transcription ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  const data = (await r.json()) as {
    language?: string;
    segments?: { start: number; end: number; text: string }[];
    words?: { word: string; start: number; end: number }[];
  };
  const segments = (data.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: s.text.trim() })).filter((s) => s.text);
  const words = (data.words ?? []).map((w) => ({ w: w.word.trim(), s: w.start, e: w.end })).filter((w) => w.w);
  return { segments, words, language: data.language ?? null };
}

/** On this computer: `status` names the run for whoever shows what it is doing (deviceStatus). */
async function device(file: string, status: string): Promise<Transcribed> {
  const { words, language } = await transcribeOnDevice(file, status);
  return { segments: wordsToSegments(words), words: words.map((w) => ({ w: w.text, s: w.start, e: w.end })), language };
}

/** On one of the person's own computers (lib/computer-transcribe.ts): `file` is the WAV it fetches, or the library file it cuts the sound from itself; `soon`: the mic's limits. */
async function computer(file: string | OwnSound, actor: string, model: string, languages: string[], soon: boolean, editor: boolean): Promise<Transcribed> {
  // the editor's never go to a Mac (computer-transcribe.ts isMac)
  const { words, language } = await transcribeOnComputer(actor, model, languages, file, soon ? MIC_LIMITS : { noMac: editor });
  return { segments: wordsToSegments(words), words: words.map((w) => ({ w: w.text, s: w.start, e: w.end })), language };
}

/**
 * The sound every transcript is heard from, after `-i <file>`: 16 kHz mono, as a WAV (Deepgram, a computer's model) or
 * 32 kbps AAC in an .m4a (OpenAI's endpoint). No -map: ffmpeg's own pick of the sound tracks, the same from a proxy (it
 * keeps every track) as from the original. A computer that cuts the sound itself runs the same (work/library.ts, the
 * Mac app's TranscribeJob.swift).
 */
export const soundArgs = (wav: boolean): string[] => ["-vn", "-ac", "1", "-ar", "16000", ...(wav ? ["-c:a", "pcm_s16le"] : ["-c:a", "aac", "-b:a", "32k"])];

/**
 * A file's transcript as its actor's key gives it, or this computer: the route first (no audio is cut without one),
 * then the provider. Throws NeedsKey without a route. `status` names an on-device run (a version's id) for deviceStatus.
 * `use` picks the engine (Settings → AI → Voice); `fillers` keeps "um" and "uh" (the AI Editor cuts at them); `soon`: a
 * person is waiting for it (the mic), so its audio is cut before the queued long runs and a computer must take it at
 * once (MIC_LIMITS). `route`: this engine instead of the one `use` picks (the mic's fallback when its computers can't).
 * `own`: a library file a computer cuts the sound from itself (ownSound): on a computer's model nothing is cut here,
 * and `src` is read only if that computer asks for the audio after all (an older app).
 */
export async function transcribeFile(
  src: string | (() => Promise<string>),
  actor: string | null,
  scratch: string,
  status: string = typeof src === "string" ? src : "",
  { use = "transcripts", fillers = true, soon = false, languages, route = transcribeRoute(actor, use), own }: { use?: SpeechUse; fillers?: boolean; soon?: boolean; languages?: string[]; route?: Route; own?: Omit<OwnSound, "cut"> } = {},
): Promise<Transcribed & { provider: Route["provider"]; model?: string }> {
  // no audio is cut for a computer that is off: the job waits a minute and asks again (worker.ts)
  if (route.provider === "computer") needComputerOn(actor ?? "", route.model);
  await mkdir(scratch, { recursive: true });
  const wav = route.provider === "deepgram" || route.provider === "computer";
  const out = path.join(scratch, `transcribe-${randomUUID()}.${wav ? "wav" : route.provider === "openai" ? "m4a" : "f32"}`);
  const file = async () => (typeof src === "string" ? src : src());
  let cutting: Promise<unknown> | undefined;
  const cut = async () => {
    await (cutting = (async () => ffmpegTo(out, ["-i", await file(), ...(route.provider === "device" ? DEVICE_AUDIO : soundArgs(wav))], soon))());
    return out;
  };
  try {
    if (!(route.provider === "computer" && own)) await cut();
    const t =
      route.provider === "device" ? await device(out, status)
      : route.provider === "computer" ? await computer(own ? { ...own, cut } : out, actor ?? "", route.model, languages?.length ? languages : route.languages, soon, use === "editor")
      : route.provider === "deepgram" ? await deepgram(out, actor ?? "", fillers, languages)
      : await openai(out, route.key, languages);
    return { ...t, provider: route.provider, ...(route.provider === "computer" ? { model: route.model } : {}) };
  } finally {
    await cutting?.catch(() => {}); // a cut a computer asked for that is still running writes nothing after this
    await rm(out, { force: true });
  }
}

/**
 * What a computer of `actor`'s needs to cut a library version's sound from its own copy (design 6.1): where the file is
 * on it (the index's path for it, or a storage folder it reaches; with the size to check), else the server's proxy to
 * download into its proxy cache. Never the original: a file it has neither of is cut here, when it asks for the audio.
 */
export function ownSound(versionId: string, actor: string | null): Omit<OwnSound, "cut"> | undefined {
  const r = libraryDb()
    .prepare(
      `SELECT v.id, v.source_key, v.source_path, v.mac_path, v.mac_device, v.from_path, v.from_device, v.probe, v.bytes,
         d.storage_key AS proxy, d.bytes AS proxy_bytes
       FROM asset_versions v LEFT JOIN derivatives d ON d.version_id = v.id AND d.kind = 'proxy' WHERE v.id = ?`,
    )
    .get(versionId) as
    | { id: string; source_key: string; source_path: string | null; mac_path: string | null; mac_device: string | null; from_path: string | null; from_device: string | null; probe: string | null; bytes: number; proxy: string | null; proxy_bytes: number | null }
    | undefined;
  if (!r || !actor) return undefined;
  // an original uploaded from a computer is still on that computer, where it was sent from (work/library-package.ts)
  const row = r.mac_path || !r.from_path ? r : { ...r, mac_path: r.from_path, mac_device: r.from_device };
  const seconds = Number((JSON.parse(r.probe ?? "{}") as { duration?: number }).duration) || 0;
  return {
    seconds,
    proxy: r.proxy,
    options: (device) => {
      const at = reach?.fileFor(row, device, reach.foldersOf(actor), isThisMachine);
      return {
        version: r.id,
        ...(at && "path" in at ? { path: at.path, bytes: String(r.bytes) } : {}),
        ...(r.proxy ? { proxy: String(r.proxy_bytes ?? 0) } : {}),
      };
    },
  };
}
// editor/reach.ts, loaded once a transcript asks (a static import would close a loop: reach → work → library worker → here)
let reach: typeof import("../editor/reach") | undefined;

/**
 * An AI Editor edit's ask for a version's transcript, set by analyze before it queues the transcript and cleared once
 * it is made: `by`, the account that started the edit; `languages`, the edit's (a version with none is heard in its
 * actor's Voice languages).
 */
// ponytail: kept in memory; analyze sets it again each time it looks while it waits, so a restart only loses a run already started
export const askVersionIn = new Map<string, { by: string; languages?: string[] }>();

/**
 * Where the AI Editor row (Settings → AI → Voice) sends an edit's transcript: only the row's own choice (Automatic, or
 * "Same as default", leave the editor on the library's engine, as before), resolved by speechFor "editor" for the edit's
 * languages: a key of `actor`'s, or Parakeet on `actor`'s own computers for an edit in English alone. Null when the row
 * has no choice of its own or it can't serve this edit (a need, or the row's note that it runs elsewhere): the
 * library's engine then, as before.
 */
export function editorRoute(actor: string | null, languages?: string[]): Route | null {
  const own = actor ? readVoicePrefs(actor).stt.per.editor : undefined;
  if (!own || own.engine === "auto") return null;
  const s = speechFor(actor, "editor", languages);
  if ("needs" in s) return null;
  if (s.engine !== "local") return s.note ? null : { provider: s.engine, key: s.key };
  return s.on === "computers" ? { provider: "computer", model: s.model, languages: s.languages } : null;
}

/** What a version's transcript runs on for its job's `actor`: the AI Editor row's route when an edit `actor` started asked for it, else the library's. */
export function versionRoute(actor: string | null, versionId: string): Route {
  const ask = askVersionIn.get(versionId);
  return (ask?.by === actor && editorRoute(actor, ask.languages)) || transcribeRoute(actor);
}

/** Versions an edit had heard on the AI Editor row's route ("<version>|<provider>:<model>"): heard again for it once at most (analyze.ts). */
export const heardForEditor = new Set<string>();
export const editorKey = (versionId: string, r: Route) => `${versionId}|${r.provider}:${r.provider === "computer" ? r.model : ""}`;

/**
 * Transcribes one version's audio as its job's actor, and stores it. Asked by an AI Editor edit its actor started, it
 * runs where the editor row says (editorRoute); what the person's computers can't do is made on the library's engine,
 * and the transcript is made all the same, unless the clip already has one with words: that one is kept. The library keeps one transcript a clip (Finals, search): the one the
 * editor's choice made is that clip's library transcript too, with the provider and model that made it.
 */
export async function transcribeVersion(db: DatabaseSync, versionId: string, src: string | (() => Promise<string>), actor: string | null, scratch: string): Promise<void> {
  const ask = askVersionIn.get(versionId);
  const languages = ask?.languages;
  const editor = ask?.by === actor ? editorRoute(actor, languages) : null;
  reach ??= await import("../editor/reach");
  const own = ownSound(versionId, actor);
  const make = (route?: Route) => transcribeFile(src, actor, scratch, versionId, { languages, own, ...(route ? { use: "editor" as const, route } : {}) });
  let t: Awaited<ReturnType<typeof make>>;
  try {
    t = await make(editor ?? undefined);
  } catch (e) {
    if (editor?.provider !== "computer") throw e;
    console.warn(`[transcribe] ${versionId} for ${actor}'s edit not on their computers: ${e instanceof Error ? e.message : e}`);
    // a clip that already has a transcript with words keeps it: the library's engine would only buy the same words
    // again (a computer that is off asks again after every server restart: heardForEditor lives in memory)
    if (wordsOf(db, versionId)?.length) {
      heardForEditor.add(editorKey(versionId, editor));
      if (askVersionIn.get(versionId) === ask) askVersionIn.delete(versionId);
      return;
    }
    t = await make();
  }
  if (editor) heardForEditor.add(editorKey(versionId, editor));
  saveTranscript(db, versionId, t.provider, t.language, t.segments, t.words, t.model);
  if (askVersionIn.get(versionId) === ask) askVersionIn.delete(versionId);
}

/**
 * The sound a computer cuts for a library version's transcript on its actor's key (work/library-package.ts): a WAV for
 * Deepgram, an .m4a for OpenAI's endpoint. Null for every other route: a computer's model takes the file itself
 * (ownSound), this computer's model runs here, and a route that needs a key parks the job as before.
 */
export function keySound(actor: string | null, versionId: string): "wav" | "m4a" | null {
  try {
    const p = versionRoute(actor, versionId).provider;
    return p === "deepgram" ? "wav" : p === "openai" ? "m4a" : null;
  } catch {
    return null;
  }
}

/** The words of `file`, the sound a computer cut from its own copy of a library version (soundArgs), on the actor's key. */
export async function hearSound(versionId: string, actor: string | null, file: string): Promise<Transcribed & { provider: Route["provider"] }> {
  const route = versionRoute(actor, versionId);
  const languages = askVersionIn.get(versionId)?.languages;
  if (route.provider === "deepgram") return { ...(await deepgram(file, actor ?? "", true, languages)), provider: "deepgram" };
  if (route.provider === "openai") return { ...(await openai(file, route.key, languages)), provider: "openai" };
  throw new Error("This transcript is not made on a key");
}

/** A transcript a computer's library job brought back (work/library-package.ts), filed as transcribeVersion files its own. */
export function fileTranscript(db: DatabaseSync, versionId: string, actor: string | null, t: Transcribed & { provider: string; model?: string }): void {
  const ask = askVersionIn.get(versionId);
  const editor = ask?.by === actor ? editorRoute(actor, ask.languages) : null;
  if (editor && editor.provider === t.provider) heardForEditor.add(editorKey(versionId, editor));
  saveTranscript(db, versionId, t.provider, t.language, t.segments, t.words, t.model);
  if (askVersionIn.get(versionId) === ask) askVersionIn.delete(versionId);
}
