import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { transcribeWav } from "../transcribe";
import { deviceTranscribes, DEVICE_AUDIO, transcribeOnDevice } from "../lib/device-transcribe";
import { isAdminActor, keyFor } from "../my-keys";
import { findUser } from "../users";
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

/** What transcribes for `actor`: their key, else this computer when the server is on it. Throws NeedsKey when there is neither. */
export function transcribeRoute(actor: string | null): { provider: "deepgram" | "openai"; key: string } | { provider: "device" } {
  const dg = keyFor(actor, "DEEPGRAM_API_KEY");
  if (!dg.missing) return { provider: "deepgram", ...dg };
  const oa = keyFor(actor, "OPENAI_API_KEY");
  if (!oa.missing) return { provider: "openai", ...oa };
  if (deviceTranscribes()) return { provider: "device" };
  throw new NeedsKey("Add your Deepgram (or OpenAI) key in Settings → My API keys");
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

/** Stores a version's transcript (and its words, when given) and rewrites its search rows (FTS5 has no upsert), in one transaction. */
export function saveTranscript(db: DatabaseSync, versionId: string, provider: string, language: string | null, segments: Segment[], words?: TimedWord[]): void {
  db.exec("BEGIN");
  try {
    db.prepare("INSERT OR REPLACE INTO transcripts (version_id, provider, language, text, segments, created_at, words) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      versionId,
      provider,
      language,
      segments.map((s) => s.text).join(" "),
      JSON.stringify(segments),
      Date.now(),
      words ? JSON.stringify(words) : null,
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

async function deepgram(file: string, actor: string): Promise<Transcribed> {
  const role = isAdminActor(actor) ? "admin" : (findUser(actor)?.role ?? "user");
  const r = await transcribeWav(await readFile(file), { username: actor, role, cloud: true, off: [] }, { fillers: true });
  if ("error" in r) throw new Error(r.error);
  const words = r.words.map((w) => ({ w: w.text, s: w.start, e: w.end, ...(w.confidence !== undefined ? { c: w.confidence } : {}) }));
  return { segments: wordsToSegments(r.words), words, language: "en" };
}

// ponytail: OpenAI's endpoint takes 25 MB, about 100 minutes of the 32 kbps audio sent here; longer files need chunks
async function openai(file: string, key: string): Promise<Transcribed> {
  const form = new FormData();
  form.set("file", new Blob([await readFile(file)], { type: "audio/mp4" }), "audio.m4a");
  form.set("model", process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1");
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

/**
 * A file's transcript as its actor's key gives it, or this computer: the route first (no audio is cut without one),
 * then the provider. Throws NeedsKey without a route. `status` names an on-device run (a version's id) for deviceStatus.
 */
export async function transcribeFile(src: string, actor: string | null, scratch: string, status: string = src): Promise<Transcribed & { provider: "deepgram" | "openai" | "device" }> {
  const route = transcribeRoute(actor);
  await mkdir(scratch, { recursive: true });
  const out = path.join(scratch, `transcribe-${randomUUID()}.${route.provider === "deepgram" ? "wav" : route.provider === "openai" ? "m4a" : "f32"}`);
  try {
    if (route.provider === "device") await ffmpegTo(out, ["-i", src, ...DEVICE_AUDIO]);
    else await ffmpegTo(out, ["-i", src, "-vn", "-ac", "1", "-ar", "16000", ...(route.provider === "deepgram" ? ["-c:a", "pcm_s16le"] : ["-c:a", "aac", "-b:a", "32k"])]);
    const t = route.provider === "device" ? await device(out, status) : route.provider === "deepgram" ? await deepgram(out, actor ?? "") : await openai(out, route.key);
    return { ...t, provider: route.provider };
  } finally {
    await rm(out, { force: true });
  }
}

/** Transcribes one version's audio as its job's actor, and stores it. */
export async function transcribeVersion(db: DatabaseSync, versionId: string, src: string, actor: string | null, scratch: string): Promise<void> {
  const { provider, segments, words, language } = await transcribeFile(src, actor, scratch, versionId);
  saveTranscript(db, versionId, provider, language, segments, words);
}
