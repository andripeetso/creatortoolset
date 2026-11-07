import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { transcribeUsdPerMinute, transcribeWav } from "../transcribe";
import { isAdminActor, keyFor } from "../my-keys";
import { addSpend } from "../lib/workspaces";
import { findUser } from "../users";
import { ffmpegTo } from "./media/run";

/**
 * The library's `transcribe` job (tasks/media-library-plan.md, sections 5, 6 and 11). It runs as the job's actor, on the
 * key that serves them (my-keys.ts keyFor): their own Deepgram or OpenAI key, else the server's for a platform admin
 * or a member on an API budget, billed to them. Without one the job parks as `needs_key` with the key to add: never
 * failed, and never on another person's account.
 * Deepgram first (the request Caption Studio sends, api/transcribe.ts, which bills its own minutes), else an
 * OpenAI-compatible /audio/transcriptions endpoint.
 */

export interface Segment {
  start: number;
  end: number;
  text: string;
}

/** The job can't run for this actor yet: the worker parks it as needs_key with this message. */
export class NeedsKey extends Error {}

/** The key for `actor`, or NeedsKey with what to add. */
export function needKey(actor: string | null, name: Parameters<typeof keyFor>[1]): { key: string; bill?: string } {
  const r = keyFor(actor, name);
  if (r.missing) throw new NeedsKey(r.missing);
  return r;
}

/** Which key transcribes for `actor`, and whose budget pays. Throws NeedsKey when there is none. */
export function transcribeRoute(actor: string | null): { provider: "deepgram" | "openai"; key: string; bill?: string } {
  const dg = keyFor(actor, "DEEPGRAM_API_KEY");
  if (!dg.missing) return { provider: "deepgram", ...dg };
  const oa = keyFor(actor, "OPENAI_API_KEY");
  if (!oa.missing) return { provider: "openai", ...oa };
  throw new NeedsKey(/budget/.test(dg.missing) ? dg.missing : "Add your Deepgram (or OpenAI) key in Settings → My API keys");
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
  const role = isAdminActor(actor) ? "admin" : (findUser(actor)?.role ?? "user");
  const r = await transcribeWav(await readFile(file), { username: actor, role, cloud: true, off: [] });
  if ("error" in r) throw new Error(r.error);
  return { segments: wordsToSegments(r.words), language: "en" };
}

// ponytail: OpenAI's endpoint takes 25 MB, about 100 minutes of the 32 kbps audio sent here; longer files need chunks
async function openai(file: string, key: string): Promise<{ segments: Segment[]; language: string | null }> {
  const form = new FormData();
  form.set("file", new Blob([await readFile(file)], { type: "audio/mp4" }), "audio.m4a");
  form.set("model", process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1");
  form.set("response_format", "verbose_json");
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const r = await fetch(`${base}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
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
    const { segments, language } = route.provider === "deepgram" ? await deepgram(out, actor ?? "") : await openai(out, route.key);
    saveTranscript(db, versionId, route.provider, language, segments);
    // the Deepgram path bills its own minutes (transcribeWav)
    if (route.bill && route.provider === "openai") addSpend(route.bill, (durationS / 60) * transcribeUsdPerMinute());
  } finally {
    await rm(out, { force: true });
  }
}
