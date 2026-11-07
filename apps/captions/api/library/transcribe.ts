import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { transcribeWav } from "../transcribe";
import { env } from "../lib/env";
import { addSpend, budgetLeft } from "../lib/workspaces";
import { findUser, LOCAL_USER } from "../users";
import { ffmpegTo } from "./media/run";

/**
 * The library's `transcribe` job (tasks/media-library-plan.md, sections 5, 6 and 11). It runs as the job's actor:
 * the server's transcription key (Settings → API keys or the .env) answers a platform admin, and a workspace member
 * on an API budget while the budget lasts, billed to them. Anyone else, or no key at all, parks the job as
 * `needs_key`: never failed, and never on another person's account.
 * Deepgram first (the request Caption Studio sends, api/transcribe.ts), else an OpenAI-compatible
 * /audio/transcriptions endpoint.
 */

export interface Segment {
  start: number;
  end: number;
  text: string;
}

/** The job can't run for this actor yet: the worker parks it as needs_key with this message. */
export class NeedsKey extends Error {}

// ponytail: one flat, rounded-up rate for both providers; check your provider's price sheet and set the env value
const usdPerMinute = () => Number(process.env.LIBRARY_TRANSCRIBE_USD_PER_MIN) || 0.01;

/** A platform admin, or the solo install's own account (APP_SECRET unset): the server's keys are theirs. */
export const isAdminActor = (name: string) => findUser(name)?.role === "admin" || (!env.appSecret && name === LOCAL_USER.username);

/**
 * May the server's paid keys run for `actor`, and whose budget pays: a platform admin (nobody's), or a member on a
 * workspace API budget while it lasts (theirs). Throws NeedsKey otherwise. `what` names the work in the message.
 */
export function keyRoute(actor: string | null, what: string): { bill?: string } {
  const name = actor ?? "";
  if (isAdminActor(name)) return {};
  const left = budgetLeft(name);
  if (left === null) throw new NeedsKey(`${what} uses the server's key: ask the workspace owner for an API budget`);
  if (left <= 0) throw new NeedsKey("Your AI budget for this month is used up");
  return { bill: name };
}

/** Which key transcribes for `actor`, and whose budget pays. Throws NeedsKey when there is no route. */
export function transcribeRoute(actor: string | null): { provider: "deepgram" | "openai"; bill?: string } {
  const route = keyRoute(actor, "Transcription");
  const provider = process.env.DEEPGRAM_API_KEY ? "deepgram" : process.env.OPENAI_API_KEY ? "openai" : null;
  if (!provider) throw new NeedsKey("No transcription key: an admin adds Deepgram or OpenAI in Settings → API keys");
  return { provider, ...route };
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

/** Stores a version's transcript and rewrites its search rows (FTS5 has no upsert), in one transaction. */
export function saveTranscript(db: DatabaseSync, versionId: string, provider: string, language: string | null, segments: Segment[]): void {
  db.exec("BEGIN");
  try {
    db.prepare("INSERT OR REPLACE INTO transcripts (version_id, provider, language, text, segments, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      versionId,
      provider,
      language,
      segments.map((s) => s.text).join(" "),
      JSON.stringify(segments),
      Date.now(),
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

async function deepgram(file: string, actor: string): Promise<{ segments: Segment[]; language: string | null }> {
  const role = findUser(actor)?.role ?? "admin";
  const r = await transcribeWav(await readFile(file), { username: actor, role, cloud: true, off: [] });
  if ("error" in r) throw new Error(r.error);
  return { segments: wordsToSegments(r.words), language: "en" };
}

// ponytail: OpenAI's endpoint takes 25 MB, about 100 minutes of the 32 kbps audio sent here; longer files need chunks
async function openai(file: string): Promise<{ segments: Segment[]; language: string | null }> {
  const form = new FormData();
  form.set("file", new Blob([await readFile(file)], { type: "audio/mp4" }), "audio.m4a");
  form.set("model", process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1");
  form.set("response_format", "verbose_json");
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const r = await fetch(`${base}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!r.ok) throw new Error(`Transcription ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  const data = (await r.json()) as { language?: string; text?: string; segments?: { start: number; end: number; text: string }[] };
  const segments = (data.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: s.text.trim() })).filter((s) => s.text);
  return { segments, language: data.language ?? null };
}

/** Transcribes one version's audio as its job's actor: the route first (no audio is cut without one), then the provider. */
export async function transcribeVersion(db: DatabaseSync, versionId: string, src: string, durationS: number, actor: string | null, scratch: string): Promise<void> {
  const route = transcribeRoute(actor);
  const out = path.join(scratch, `transcribe-${randomUUID()}.${route.provider === "deepgram" ? "wav" : "m4a"}`);
  try {
    const codec = route.provider === "deepgram" ? ["-c:a", "pcm_s16le"] : ["-c:a", "aac", "-b:a", "32k"];
    await ffmpegTo(out, ["-i", src, "-vn", "-ac", "1", "-ar", "16000", ...codec]);
    const { segments, language } = route.provider === "deepgram" ? await deepgram(out, actor ?? "") : await openai(out);
    saveTranscript(db, versionId, route.provider, language, segments);
    if (route.bill) addSpend(route.bill, (durationS / 60) * usdPerMinute());
  } finally {
    await rm(out, { force: true });
  }
}
