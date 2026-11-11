import { Hono } from "hono";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { AuthVars } from "./auth";
import {
  assembleParts,
  MAX_UPLOAD_BYTES,
  PART_SIZE,
  partsStatus,
  readUploadState,
  receivePart,
  startUpload,
  writeBody,
} from "./lib/uploads";
import {
  AiProviderError,
  anyAiConfigured,
  completeWithFallback,
  aiFor,
} from "./ai-complete";
import { ffmpegCommand } from "./ffmpeg-runtime";
import { deviceStatus, deviceTranscribes, DEVICE_AUDIO, transcribeOnDevice } from "./lib/device-transcribe";
import { env } from "./lib/env";
import {
  applyTranscriptCleanup,
  CLEANUP_CHUNK,
  CLEANUP_SYSTEM,
  cleanupSlice,
  cleanupUserPrompt,
  CORRECT_SYSTEM,
  parseCleanupPayload,
  plainWords,
} from "./lib/clip-cleanup";
import { announceSoon } from "./lib/announce-soon";
import { workEnded } from "./assistant";
import { capChapters, chapterCountRange, timedTranscript } from "./lib/timed-transcript";
import { type SessionUser } from "./users";
import {
  cloudTranscribeBlock,
  transcribeWav,
  userMayCloudTranscribe,
} from "./transcribe";

/**
 * Clips — a Loom-style screen recorder inside Creator Toolset.
 * Recordings live at $DATA_DIR/clips/<id>/, fully separate from caption
 * projects. After upload the server transcribes (Deepgram, when unlocked)
 * and titles/summarizes (same AI keys as caption cadence).
 *
 * Layout:
 *   meta.json     session state
 *   recording     original upload (webm/mp4)
 *   transcript.json
 *   thumb.jpg
 */

export const clipsApp = new Hono<{ Variables: AuthVars }>();

const CLIPS_DIR = path.join(env.dataDir, "clips");
const okId = (id: string) => /^[a-z0-9-]{6,40}$/.test(id);
const sesDir = (id: string) => path.join(CLIPS_DIR, id);
const recordingPath = (id: string) => path.join(sesDir(id), "recording");
const transcriptPath = (id: string) => path.join(sesDir(id), "transcript.json");
const thumbPath = (id: string) => path.join(sesDir(id), "thumb.jpg");
const wavPath = (id: string) => path.join(sesDir(id), "audio.wav");
const partsDir = (id: string) => path.join(sesDir(id), "upload.parts");

async function finishUpload(
  id: string,
  name: string,
  mime: string,
  owner: string,
  user: SessionUser,
): Promise<Meta> {
  const st = await stat(recordingPath(id));
  if (!st.size) throw new Error("Empty recording");
  const meta: Meta = {
    id,
    name,
    owner,
    duration: 0,
    bytes: st.size,
    mime,
    status: "processing",
    step: "thumbnail",
    progress: 0.04,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await persist(meta);
  enqueue(meta, user);
  return meta;
}

/** A Video Note on a file already on this server (one dropped in the assistant, api/assistant-files.ts): the same
 *  file under a second name, then processed like an upload. */
export async function notesFromFile(file: string, name: string, mime: string, user: SessionUser): Promise<{ id: string }> {
  const id = randomUUID();
  await mkdir(sesDir(id), { recursive: true });
  await link(file, recordingPath(id)).catch(() => copyFile(file, recordingPath(id)));
  await finishUpload(id, name.slice(0, 120), mime, user.username, user);
  return { id };
}

type Status = "processing" | "ready" | "error";

interface Chapter {
  t: number;
  title: string;
}

interface Word {
  text: string;
  start: number;
  end: number;
  confidence?: number;
}

type BlockKind =
  | "takeaways"
  | "actions"
  | "summary"
  | "chapters"
  | "quotes";

interface BlockItem {
  text: string;
  t?: number;
}

interface ClipBlock {
  id: BlockKind;
  kind: BlockKind;
  text?: string;
  items?: BlockItem[];
  chapters?: Chapter[];
}

interface Meta {
  id: string;
  name: string;
  owner?: string;
  duration: number;
  bytes: number;
  mime: string;
  status: Status;
  progress: number;
  step?: "thumbnail" | "audio" | "transcribe" | "title";
  error?: string;
  summary?: string;
  chapters?: Chapter[];
  /** Creator-chosen page sections. Absent = infer summary/chapters. */
  blocks?: ClipBlock[];
  createdAt: number;
  updatedAt: number;
}

const active = new Map<string, Meta>();
const children = new Map<string, ReturnType<typeof spawn>>();
const writeQ = new Map<string, Promise<unknown>>();
const generating = new Map<string, Set<BlockKind>>();

void mkdir(CLIPS_DIR, { recursive: true }).catch(() => {});

function claimKind(id: string, k: BlockKind): boolean {
  let set = generating.get(id);
  if (!set) {
    set = new Set();
    generating.set(id, set);
  }
  if (set.has(k)) return false;
  set.add(k);
  return true;
}

function releaseKind(id: string, k: BlockKind): void {
  const set = generating.get(id);
  if (!set) return;
  set.delete(k);
  if (!set.size) generating.delete(id);
}

const blockErrors = new Map<string, string>();

function errorKey(id: string, k: BlockKind): string {
  return `${id}:${k}`;
}

function blockErrorMap(id: string): Record<string, string> | undefined {
  const prefix = `${id}:`;
  const out: Record<string, string> = {};
  for (const [key, msg] of blockErrors) {
    if (key.startsWith(prefix)) out[key.slice(prefix.length)] = msg;
  }
  return Object.keys(out).length ? out : undefined;
}

async function runBlockJob(
  id: string,
  k: BlockKind,
  force: boolean,
): Promise<void> {
  let owner: string | undefined;
  try {
    const meta = await readMeta(id);
    if (!meta) return;
    owner = meta.owner;
    const block = await generateBlock(meta, k, force);
    await afterWrite(id, async () => {
      const fresh = await readMeta(id);
      if (!fresh) return;
      applyBlock(fresh, k, block, force);
      await persist(fresh);
    });
    blockErrors.delete(errorKey(id, k));
  } catch (e) {
    blockErrors.set(
      errorKey(id, k),
      e instanceof Error ? e.message : String(e),
    );
  } finally {
    releaseKind(id, k);
    announceSoon(owner, "clips"); // the block (or its error) is in, and it is no longer generating
  }
}

function startBlockJob(id: string, k: BlockKind, force: boolean): void {
  if (!claimKind(id, k)) return;
  blockErrors.delete(errorKey(id, k));
  void runBlockJob(id, k, force);
}

function afterWrite<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const run = () => fn();
  const next = (writeQ.get(id) ?? Promise.resolve()).then(run, run);
  writeQ.set(
    id,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

function applyBlock(
  meta: Meta,
  k: BlockKind,
  block: ClipBlock,
  replace: boolean,
): void {
  if (k === "chapters") {
    if (block.chapters?.length) meta.chapters = block.chapters;
    return;
  }
  const current = materializeBlocks(meta);
  const at = current.findIndex((b) => b.kind === k);
  if (replace) {
    if (at < 0) return;
    const next = current.slice();
    next[at] = block;
    meta.blocks = next;
  } else if (at < 0) {
    meta.blocks = [...current, block];
  }
  if (k === "summary" && block.text) meta.summary = block.text;
}

async function persist(meta: Meta): Promise<void> {
  meta.updatedAt = Date.now();
  try {
    // written beside and renamed in: a read during the save gets the note as it was, never half a file (which reads as "not found")
    const file = path.join(sesDir(meta.id), "meta.json");
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(meta));
    await rename(tmp, file);
  } catch {
    /* deleted mid-job */
  }
}

/** A background job's save: the owner's open screens follow it (at most about once a second, the last save always). */
async function jobPersist(meta: Meta): Promise<void> {
  await persist(meta);
  announceSoon(meta.owner, "clips");
}

async function readMeta(id: string): Promise<Meta | null> {
  const mem = active.get(id);
  if (mem) return mem;
  try {
    const meta: Meta = JSON.parse(
      await readFile(path.join(sesDir(id), "meta.json"), "utf-8"),
    );
    if (meta.status === "processing") {
      meta.status = "error";
      meta.error = "Interrupted by a server restart — try again.";
      await persist(meta);
    }
    return meta;
  } catch {
    return null;
  }
}

const canSee = (meta: Meta, user: SessionUser) =>
  user.role === "admin" || meta.owner === user.username;

async function publishedMeta(id: string): Promise<Meta | null> {
  if (!okId(id)) return null;
  return readMeta(id);
}

async function ownedMeta(id: string, user: SessionUser): Promise<Meta | null> {
  if (!okId(id)) return null;
  const meta = await readMeta(id);
  return meta && canSee(meta, user) ? meta : null;
}

const publicMeta = (m: Meta) => {
  const nested = m.blocks?.find((b) => b.kind === "chapters")?.chapters;
  const chapters = m.chapters?.length ? m.chapters : nested;
  const blocks = m.blocks?.filter((b) => b.kind !== "chapters");
  const gen = [...(generating.get(m.id) ?? [])];
  const errors = blockErrorMap(m.id);
  return {
    ...m,
    ...(chapters?.length ? { chapters } : {}),
    ...(blocks ? { blocks } : {}),
    ...(gen.length ? { generating: gen } : {}),
    ...(errors ? { blockErrors: errors } : {}),
    hasTranscript: existsSync(transcriptPath(m.id)),
    hasThumb: existsSync(thumbPath(m.id)),
    // a transcript being made on this computer says what it is doing (the speech model's first download, listening)
    ...(deviceStatus(m.id) ? { note: deviceStatus(m.id) } : {}),
  };
};

function probe(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", ["-v", "error", ...args, file]);
    let out = "";
    const kill = setTimeout(() => {
      p.kill("SIGKILL");
      resolve(out.trim());
    }, 15_000);
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("close", () => {
      clearTimeout(kill);
      resolve(out.trim());
    });
    p.on("error", () => {
      clearTimeout(kill);
      resolve("");
    });
  });
}

export const probeDuration = async (f: string) =>
  Number(
    await probe(f, ["-show_entries", "format=duration", "-of", "csv=p=0"]),
  ) || 0;

const probeHasAudio = async (f: string) =>
  (
    await probe(f, [
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=codec_name",
      "-of",
      "csv=p=0",
    ])
  ).length > 0;

function runFfmpeg(id: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegCommand(), [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      ...args,
    ]);
    children.set(id, p);
    let err = "";
    p.stderr.on("data", (d) => {
      err += d.toString();
      if (err.length > 4000) err = err.slice(-4000);
    });
    p.on("error", (e) => {
      children.delete(id);
      reject(e);
    });
    p.on("close", (code) => {
      children.delete(id);
      if (code === 0) resolve();
      else reject(new Error(err.trim() || `ffmpeg exited ${code}`));
    });
  });
}

function parseJsonObject(text: string): Record<string, unknown> {
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON");
  return JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
}

function parseSummary(text: string): {
  title: string;
  summary: string;
  chapters: Chapter[];
} {
  const obj = parseJsonObject(text) as {
    title?: unknown;
    summary?: unknown;
    chapters?: unknown;
  };
  const title =
    typeof obj.title === "string" ? obj.title.trim().slice(0, 80) : "";
  const summary =
    typeof obj.summary === "string" ? obj.summary.trim().slice(0, 800) : "";
  const chapters: Chapter[] = [];
  if (Array.isArray(obj.chapters)) {
    for (const ch of obj.chapters) {
      if (!ch || typeof ch !== "object") continue;
      const rec = ch as { t?: unknown; title?: unknown };
      const t = Number(rec.t);
      const ct = typeof rec.title === "string" ? rec.title.trim() : "";
      if (Number.isFinite(t) && t >= 0 && ct) chapters.push({ t, title: ct });
    }
  }
  return { title, summary, chapters };
}

const BLOCK_KINDS = new Set<BlockKind>([
  "takeaways",
  "actions",
  "summary",
  "chapters",
  "quotes",
]);

function inferredBlocks(meta: Meta): ClipBlock[] {
  const out: ClipBlock[] = [];
  if (meta.summary)
    out.push({ id: "summary", kind: "summary", text: meta.summary });
  return out;
}

function materializeBlocks(meta: Meta): ClipBlock[] {
  if (!meta.blocks) meta.blocks = inferredBlocks(meta);
  const nested = meta.blocks.find((b) => b.kind === "chapters");
  if (nested?.chapters?.length && !meta.chapters?.length) {
    meta.chapters = nested.chapters;
  }
  meta.blocks = meta.blocks.filter((b) => b.kind !== "chapters");
  return meta.blocks;
}

async function loadTranscript(id: string): Promise<{
  words: Word[];
  originalWords?: Word[];
}> {
  const p = transcriptPath(id);
  if (!existsSync(p)) return { words: [] };
  try {
    const data = JSON.parse(await readFile(p, "utf-8")) as {
      words?: Word[];
      originalWords?: Word[];
    };
    return {
      words: data.words ?? [],
      ...(Array.isArray(data.originalWords)
        ? { originalWords: data.originalWords }
        : {}),
    };
  } catch {
    return { words: [] };
  }
}

async function loadWords(id: string): Promise<Word[]> {
  return (await loadTranscript(id)).words;
}

export async function getClipAgentSource(id: string) {
  const meta = await publishedMeta(id);
  if (!meta) return null;
  const nested = meta.blocks?.find((b) => b.kind === "chapters")?.chapters;
  const chapters = meta.chapters?.length ? meta.chapters : nested;
  return {
    id: meta.id,
    name: meta.name,
    duration: meta.duration,
    status: meta.status,
    summary: meta.summary,
    chapters,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    hasThumb: existsSync(thumbPath(meta.id)),
  };
}

export async function getClipRecordingPath(id: string): Promise<string | null> {
  if (!okId(id)) return null;
  const p = recordingPath(id);
  return existsSync(p) ? p : null;
}

export const clipFramesDir = (id: string) => path.join(sesDir(id), "frames");

export { loadWords, okId };

function chapterSystem(durationSec: number): string {
  const { min, max } = chapterCountRange(durationSec);
  const span =
    durationSec < 120
      ? `At most ${max} chapters, or none if it is one thought.`
      : `At most ${max} chapters (hard cap). Prefer ${min}–${max} major topic shifts spanning the full recording — do not add extra beats to fill the cap.`;
  return `Chapter-mark this screen recording. Return JSON only:
{"chapters":[{"t":seconds,"title":"short chapter"}]}
${span} First chapter near 0:00. t must match a [mm:ss] in the transcript. No markdown.`;
}

function parseItems(text: string, max = 10): BlockItem[] {
  const obj = parseJsonObject(text);
  const raw = Array.isArray(obj.items) ? obj.items : [];
  const out: BlockItem[] = [];
  for (const it of raw) {
    if (!it || typeof it !== "object") continue;
    const rec = it as { text?: unknown; t?: unknown };
    const itemText = typeof rec.text === "string" ? rec.text.trim() : "";
    if (!itemText) continue;
    const t = Number(rec.t);
    out.push({
      text: itemText.slice(0, 280),
      ...(Number.isFinite(t) && t >= 0 ? { t } : {}),
    });
    if (out.length >= max) break;
  }
  if (!out.length) throw new Error("empty items");
  return out;
}

function parseChaptersPayload(text: string): Chapter[] {
  const obj = parseJsonObject(text);
  const chapters: Chapter[] = [];
  if (Array.isArray(obj.chapters)) {
    for (const ch of obj.chapters) {
      if (!ch || typeof ch !== "object") continue;
      const rec = ch as { t?: unknown; title?: unknown };
      const t = Number(rec.t);
      const ct = typeof rec.title === "string" ? rec.title.trim() : "";
      if (Number.isFinite(t) && t >= 0 && ct) {
        chapters.push({ t, title: ct.slice(0, 80) });
      }
    }
  }
  if (!chapters.length) throw new Error("empty chapters");
  return chapters;
}

async function generateBlock(
  meta: Meta,
  kind: BlockKind,
  force = false,
): Promise<ClipBlock> {
  if (!force && kind === "summary" && meta.summary) {
    return { id: "summary", kind: "summary", text: meta.summary };
  }
  if (!force && kind === "chapters" && meta.chapters?.length) {
    return { id: "chapters", kind: "chapters", chapters: meta.chapters };
  }
  if (!anyAiConfigured(meta.owner)) {
    throw new AiProviderError("AI is not configured", "FAILED", false);
  }
  const words = await loadWords(meta.id);
  if (!words.length) throw new Error("No transcript to generate from");
  const ai = aiFor(meta.owner, "notes", "Video Notes");
  const excerpt = timedTranscript(words);
  const user = `Duration: ${Math.round(meta.duration)}s\nTranscript:\n${excerpt}`;

  if (kind === "summary") {
    const out = await completeWithFallback(
      `Summarize this screen recording. Return JSON only: {"text":"2-4 sentences covering the whole recording"}. Ground every claim in the transcript. No markdown.`,
      user,
      undefined,
      (t) => {
        const text =
          typeof parseJsonObject(t).text === "string"
            ? String(parseJsonObject(t).text).trim().slice(0, 800)
            : "";
        if (!text) throw new Error("empty summary");
        return text;
      },
      ai,
    );
    meta.summary = out;
    return { id: "summary", kind: "summary", text: out };
  }

  if (kind === "chapters") {
    const chapters = await completeWithFallback(
      chapterSystem(meta.duration),
      user,
      undefined,
      parseChaptersPayload,
      ai,
    );
    meta.chapters = capChapters(chapters, chapterCountRange(meta.duration).max);
    return { id: "chapters", kind: "chapters", chapters: meta.chapters };
  }

  const long = meta.duration >= 10 * 60;
  if (kind === "takeaways") {
    const items = await completeWithFallback(
      `Extract the main takeaways a viewer should remember from the full recording, not just the opening. Return JSON only:
{"items":[{"text":"one sentence","t":seconds}]}
${long ? "6-10" : "3-6"} items spanning the whole talk. Each item is a real point from the transcript, not generic advice. t is optional, seconds from start, only if it maps to a [mm:ss] in the transcript. No markdown.`,
      user,
      undefined,
      (t) => parseItems(t, long ? 12 : 8),
      ai,
    );
    return { id: "takeaways", kind: "takeaways", items };
  }

  if (kind === "actions") {
    const items = await completeWithFallback(
      `Turn this recording into an action plan for the person it was made for, covering the full recording. Return JSON only:
{"items":[{"text":"imperative next step","t":seconds}]}
${long ? "6-12" : "3-8"} concrete todos (fix X, change Y, add Z). Skip fluff. t optional. No markdown.`,
      user,
      undefined,
      (t) => parseItems(t, long ? 14 : 10),
      ai,
    );
    return { id: "actions", kind: "actions", items };
  }

  const items = await completeWithFallback(
    `Pick the most useful spoken lines from the full recording. Return JSON only:
{"items":[{"text":"short quote","t":seconds}]}
${long ? "4-8" : "3-6"} quotes, lightly cleaned, still in the speaker's voice. t in seconds from a [mm:ss] in the transcript. No markdown.`,
    user,
    undefined,
    (t) => parseItems(t, long ? 10 : 8),
    ai,
  );
  return { id: "quotes", kind: "quotes", items };
}

function crawlProgress(meta: Meta, hi: number): () => void {
  const t = setInterval(() => {
    if (active.get(meta.id) !== meta) return;
    if (meta.progress >= hi - 0.01) return;
    meta.progress = Math.min(hi - 0.01, meta.progress + 0.015);
    void jobPersist(meta);
  }, 700);
  return () => clearInterval(t);
}

async function processClip(id: string, user: SessionUser): Promise<void> {
  const meta = active.get(id);
  if (!meta) return;
  const src = recordingPath(id);
  let stopCrawl = () => {};
  try {
    meta.step = "thumbnail";
    meta.progress = 0.08;
    await jobPersist(meta);
    const duration = await probeDuration(src);
    if (duration) meta.duration = duration;
    const dur = Math.max(0, meta.duration);
    const ss = dur > 2 ? "1" : "0";
    await runFfmpeg(id, [
      "-ss",
      ss,
      "-i",
      src,
      "-frames:v",
      "1",
      "-q:v",
      "4",
      thumbPath(id),
    ]).catch(() => {});

    // no key: a server on its owner's computer transcribes by itself (lib/device-transcribe.ts); a lock stays a lock
    const onDevice = userMayCloudTranscribe(user) && !!cloudTranscribeBlock(user) && deviceTranscribes();
    const canTranscribe = onDevice || !cloudTranscribeBlock(user);
    let words: Word[] = [];
    if (canTranscribe && (await probeHasAudio(src))) {
      meta.step = "audio";
      meta.progress = 0.22;
      await jobPersist(meta);
      await runFfmpeg(id, [
        "-i",
        src,
        ...(onDevice ? DEVICE_AUDIO : ["-vn", "-ac", "1", "-ar", "16000", "-f", "wav"]),
        wavPath(id),
      ]);
      meta.step = "transcribe";
      meta.progress = 0.38;
      await jobPersist(meta);
      stopCrawl = crawlProgress(meta, 0.72);
      const result = onDevice ? await transcribeOnDevice(wavPath(id), id) : await transcribeWav(await readFile(wavPath(id)), user);
      stopCrawl();
      await rm(wavPath(id), { force: true }).catch(() => {});
      if ("error" in result) throw new Error(result.error);
      words = result.words;
      // ASR error-correction pass: rewrite only tokens that don't make
      // sense. Timestamps stay put so captions stay in sync.
      if (words.length && anyAiConfigured(user)) {
        try {
          words = await rewriteTranscriptWords(words, CORRECT_SYSTEM, user.username);
        } catch (e) {
          if (!(e instanceof AiProviderError)) throw e;
          console.warn(`[clips] transcript correct skipped: ${e.message}`);
        }
      }
      if (words.length) {
        await writeFile(
          transcriptPath(id),
          JSON.stringify({ words: plainWords(words) }),
        );
      }
    }

    if (words.length && anyAiConfigured(user)) {
      meta.step = "title";
      meta.progress = Math.max(meta.progress, 0.78);
      await jobPersist(meta);
      stopCrawl = crawlProgress(meta, 0.96);
      const excerpt = timedTranscript(words);
      const { min: chMin, max: chMax } = chapterCountRange(meta.duration);
      const chapterHint =
        meta.duration < 120
          ? `At most ${chMax} chapters, or none if it is one thought.`
          : `At most ${chMax} chapters (hard cap). Prefer ${chMin}–${chMax} major topic shifts spanning the full recording — do not add extra beats to fill the cap.`;
      try {
        const out = await completeWithFallback(
          `You title, summarize, and chapter-mark a screen recording from its transcript. Return JSON only:
{"title":"short title, max 8 words","summary":"2-4 sentences covering the whole recording","chapters":[{"t":seconds,"title":"short chapter"}]}
${chapterHint} First chapter near 0:00. t matches [mm:ss] in the transcript. No markdown.`,
          `Duration: ${Math.round(meta.duration)}s\nTranscript:\n${excerpt}`,
          undefined,
          parseSummary,
          aiFor(meta.owner, "notes", "Video Notes"),
        );
        if (out.title) meta.name = out.title;
        if (out.summary) meta.summary = out.summary;
        if (out.chapters.length) {
          meta.chapters = capChapters(out.chapters, chMax);
        }
      } catch (e) {
        if (!(e instanceof AiProviderError)) throw e;
        console.warn(`[clips] AI title skipped: ${e.message}`);
      }
      if (!meta.chapters?.length) {
        try {
          await generateBlock(meta, "chapters");
        } catch (e) {
          if (!(e instanceof AiProviderError)) throw e;
          console.warn(`[clips] chapters skipped: ${e.message}`);
        }
      }
      stopCrawl();
    }

    if (active.get(id) !== meta) return;
    meta.status = "ready";
    meta.step = undefined;
    meta.progress = 1;
    meta.error = undefined;
    await jobPersist(meta);
  } catch (e) {
    stopCrawl();
    if (active.get(id) !== meta) return;
    meta.status = "error";
    meta.error = e instanceof Error ? e.message : String(e);
    await jobPersist(meta);
  } finally {
    stopCrawl();
    // a note the assistant started from a dropped file: its card in the chat ends, and the chat says so (a stopped one says nothing)
    if (meta.status !== "processing" && meta.owner)
      workEnded(
        meta.owner,
        `notes:${id}`,
        meta.status === "ready"
          ? { status: "done", detail: "Ready", say: `“${meta.name}” is ready.`, choices: ["Sum it up", "Show me"] }
          : { status: "failed", detail: meta.error, say: `“${meta.name}” did not finish: ${meta.error}`, choices: ["Show me"] },
      );
    active.delete(id);
    children.get(id)?.kill("SIGKILL");
    children.delete(id);
    await rm(wavPath(id), { force: true }).catch(() => {});
  }
}

function enqueue(meta: Meta, user: SessionUser): void {
  active.set(meta.id, meta);
  meta.status = "processing";
  meta.step = "thumbnail";
  meta.progress = 0.04;
  meta.error = undefined;
  void processClip(meta.id, user);
}

function cancel(id: string): void {
  active.delete(id);
  children.get(id)?.kill("SIGKILL");
  children.delete(id);
}

async function streamFile(
  c: { req: { header: (h: string) => string | undefined } },
  p: string,
  type: string,
): Promise<Response> {
  const st = await stat(p);
  const size = st.size;
  const range = c.req.header("range");
  const base = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    "Last-Modified": new Date(st.mtimeMs).toUTCString(),
    ETag: `"${size}-${Math.floor(st.mtimeMs)}"`,
  };
  const slice = (start: number, end: number): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      createReadStream(p, { start, end })
        .on("data", (d) => chunks.push(d as Buffer))
        .on("end", () => resolve(Buffer.concat(chunks)))
        .on("error", reject);
    });
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m?.[1] ? parseInt(m[1], 10) : 0;
    const end = Math.min(m?.[2] ? parseInt(m[2], 10) : size - 1, size - 1);
    if (start >= size || start > end) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }
    const body = await slice(start, end);
    return new Response(new Uint8Array(body), {
      status: 206,
      headers: {
        ...base,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }
  const body = await slice(0, size - 1);
  return new Response(new Uint8Array(body), {
    headers: { ...base, "Content-Length": String(size) },
  });
}

clipsApp.get("/availability", (c) => {
  const user = c.get("user");
  return c.json({
    cloud: !cloudTranscribeBlock(user),
    cloudWhy: cloudTranscribeBlock(user) ?? undefined,
    ai: anyAiConfigured(user) && userMayCloudTranscribe(user),
  });
});

clipsApp.get("/", async (c) => {
  const user = c.get("user");
  let ids: string[] = [];
  try {
    ids = (await readdir(CLIPS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter(okId);
  } catch {
    return c.json([]);
  }
  const metas = (await Promise.all(ids.map(readMeta))).filter(
    (m): m is Meta =>
      !!m && (m.owner === user.username || (user.role === "admin" && !m.owner)),
  );
  metas.sort((a, b) => b.createdAt - a.createdAt);
  return c.json(metas.map(publicMeta));
});

clipsApp.post("/init", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    name?: unknown;
    mime?: unknown;
    size?: unknown;
  } | null;
  const size = Number(body?.size);
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_UPLOAD_BYTES) {
    return c.json({ error: "Invalid size" }, 400);
  }
  const id = randomUUID();
  try {
    await startUpload(partsDir(id), {
      total: size,
      partSize: PART_SIZE,
      name: (typeof body?.name === "string" ? body.name : "Untitled recording").slice(
        0,
        120,
      ),
      mime: (typeof body?.mime === "string" ? body.mime : "video/webm").slice(0, 80),
      owner: c.get("user").username,
    });
    return c.json({ id, partSize: PART_SIZE });
  } catch (e) {
    await rm(sesDir(id), { recursive: true, force: true }).catch(() => {});
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

clipsApp.get("/:id/parts", async (c) => {
  const id = c.req.param("id");
  if (!okId(id)) return c.json({ error: "Not found" }, 404);
  return partsStatus(c, partsDir(id), c.get("user"));
});

clipsApp.post("/:id/parts/:partNumber", async (c) => {
  const id = c.req.param("id");
  if (!okId(id)) return c.json({ error: "Invalid part" }, 400);
  return receivePart(c, partsDir(id), c.get("user"));
});

clipsApp.post("/:id/complete", async (c) => {
  const id = c.req.param("id");
  if (!okId(id)) return c.json({ error: "Not found" }, 404);
  const existing = await ownedMeta(id, c.get("user"));
  if (existing) return c.json(publicMeta(existing));
  const state = await readUploadState(partsDir(id));
  if (!state) return c.json({ error: "No upload in progress" }, 409);
  if (state.owner !== c.get("user").username && c.get("user").role !== "admin") {
    return c.json({ error: "Not found" }, 404);
  }
  try {
    await assembleParts(partsDir(id), recordingPath(id), state);
    const meta = await finishUpload(
      id,
      state.name,
      state.mime,
      state.owner,
      c.get("user"),
    );
    return c.json(publicMeta(meta));
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : String(e) },
      400,
    );
  }
});

clipsApp.post("/", async (c) => {
  const name = (c.req.query("name") || "Untitled recording").slice(0, 120);
  const mime = (c.req.query("mime") || "video/webm").slice(0, 80);
  const id = randomUUID();
  const dir = sesDir(id);
  try {
    await mkdir(dir, { recursive: true });
    await writeBody(c, recordingPath(id));
    const meta = await finishUpload(id, name, mime, c.get("user").username, c.get("user"));
    return c.json(publicMeta(meta));
  } catch (e) {
    active.delete(id);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

clipsApp.get("/:id", async (c) => {
  const meta = await publishedMeta(c.req.param("id"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  return c.json(publicMeta(meta), 200, {
    "Cache-Control": "no-store",
  });
});

clipsApp.patch("/:id", async (c) => {
  const meta = await ownedMeta(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  const body = (await c.req.json().catch(() => null)) as { name?: unknown };
  if (typeof body?.name === "string" && body.name.trim()) {
    meta.name = body.name.trim().slice(0, 120);
    await persist(meta);
  }
  return c.json(publicMeta(meta));
});

clipsApp.post("/:id/retry", async (c) => {
  const user = c.get("user");
  const meta = await ownedMeta(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  if (meta.status === "processing") {
    return c.json({ error: "Already processing" }, 409);
  }
  enqueue(meta, user);
  await persist(meta);
  return c.json(publicMeta(meta));
});

clipsApp.post("/:id/blocks", async (c) => {
  const user = c.get("user");
  const meta = await ownedMeta(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  const body = (await c.req.json().catch(() => null)) as { kind?: unknown };
  const kind = typeof body?.kind === "string" ? body.kind : "";
  if (!BLOCK_KINDS.has(kind as BlockKind)) {
    return c.json({ error: "Unknown block" }, 400);
  }
  const k = kind as BlockKind;
  if (k === "chapters") {
    if (meta.chapters?.length) {
      return c.json({ error: "Already on the page" }, 409);
    }
  } else if (materializeBlocks(meta).some((b) => b.kind === k)) {
    return c.json({ error: "Already on the page" }, 409);
  }
  startBlockJob(meta.id, k, false);
  return c.json(publicMeta(meta), 202);
});

clipsApp.post("/:id/blocks/:kind/retry", async (c) => {
  const user = c.get("user");
  const meta = await ownedMeta(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  const kind = c.req.param("kind");
  if (!BLOCK_KINDS.has(kind as BlockKind)) {
    return c.json({ error: "Unknown block" }, 400);
  }
  const k = kind as BlockKind;
  if (k === "chapters") {
    if (!meta.chapters?.length) {
      return c.json({ error: "Not on the page" }, 404);
    }
  } else if (materializeBlocks(meta).findIndex((b) => b.kind === k) < 0) {
    return c.json({ error: "Not on the page" }, 404);
  }
  startBlockJob(meta.id, k, true);
  return c.json(publicMeta(meta), 202);
});

clipsApp.delete("/:id/blocks/:kind", async (c) => {
  const meta = await ownedMeta(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  const kind = c.req.param("kind");
  if (!BLOCK_KINDS.has(kind as BlockKind)) {
    return c.json({ error: "Unknown block" }, 400);
  }
  const k = kind as BlockKind;
  const latest = await afterWrite(meta.id, async () => {
    const fresh = await readMeta(meta.id);
    if (!fresh) return null;
    if (k === "chapters") {
      fresh.chapters = [];
    } else {
      fresh.blocks = materializeBlocks(fresh).filter((b) => b.kind !== k);
    }
    await persist(fresh);
    return fresh;
  });
  return c.json(publicMeta(latest ?? meta));
});

clipsApp.patch("/:id/blocks", async (c) => {
  const meta = await ownedMeta(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  const body = (await c.req.json().catch(() => null)) as { order?: unknown };
  const order = Array.isArray(body?.order) ? body.order : [];
  if (
    !order.length ||
    order.some((k) => typeof k !== "string" || !BLOCK_KINDS.has(k as BlockKind))
  ) {
    return c.json({ error: "Invalid order" }, 400);
  }
  const kinds = order as BlockKind[];
  if (new Set(kinds).size !== kinds.length) {
    return c.json({ error: "Invalid order" }, 400);
  }
  try {
    const latest = await afterWrite(meta.id, async () => {
      const fresh = await readMeta(meta.id);
      if (!fresh) return null;
      const blocks = materializeBlocks(fresh);
      if (
        kinds.length !== blocks.length ||
        kinds.some((k) => !blocks.some((b) => b.kind === k))
      ) {
        throw new Error("Order must list every block on the page");
      }
      const byKind = new Map(blocks.map((b) => [b.kind, b]));
      fresh.blocks = kinds.map((k) => byKind.get(k)!);
      await persist(fresh);
      return fresh;
    });
    return c.json(publicMeta(latest ?? meta));
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : String(e) },
      400,
    );
  }
});

clipsApp.get("/:id/play", async (c) => {
  const id = c.req.param("id");
  const meta = await publishedMeta(id);
  if (!meta) return c.json({ error: "Not found" }, 404);
  const p = recordingPath(id);
  if (!existsSync(p)) return c.json({ error: "Not ready" }, 409);
  return streamFile(c, p, meta.mime || "video/webm");
});

clipsApp.get("/:id/thumb", async (c) => {
  const id = c.req.param("id");
  const meta = await publishedMeta(id);
  if (!meta) return c.json({ error: "Not found" }, 404);
  const p = thumbPath(id);
  if (!existsSync(p)) return c.json({ error: "No thumbnail" }, 404);
  return streamFile(c, p, "image/jpeg");
});

clipsApp.get("/:id/transcript", async (c) => {
  const id = c.req.param("id");
  const meta = await publishedMeta(id);
  if (!meta) return c.json({ error: "Not found" }, 404);
  const data = await loadTranscript(id);
  return c.json({
    words: data.words,
    cleaned: !!data.originalWords?.length,
  });
});

async function rewriteTranscriptWords(
  words: Word[],
  system: string,
  owner: string,
): Promise<Word[]> {
  const drop: number[] = [];
  const fixes: { i: number; text: string }[] = [];
  for (let start = 0; start < words.length; start += CLEANUP_CHUNK) {
    const { slice, previous } = cleanupSlice(words, start);
    const payload = await completeWithFallback(
      system,
      cleanupUserPrompt(slice, start, previous),
      undefined,
      parseCleanupPayload,
      aiFor(owner, "notes", "Transcript cleanup"),
    );
    drop.push(...payload.drop);
    fixes.push(...payload.fixes);
  }
  if (!drop.length && !fixes.length) return words;
  return applyTranscriptCleanup(words, { drop, fixes });
}

async function cleanupTranscriptWords(words: Word[], owner: string): Promise<Word[]> {
  return rewriteTranscriptWords(words, CLEANUP_SYSTEM, owner);
}

clipsApp.post("/:id/cleanup", async (c) => {
  const user = c.get("user");
  const meta = await ownedMeta(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  if (!anyAiConfigured(user)) {
    return c.json({ error: "AI is not configured" }, 400);
  }
  const file = await loadTranscript(meta.id);
  if (!file.words.length) {
    return c.json({ error: "No transcript to clean" }, 400);
  }
  try {
    const cleaned = await cleanupTranscriptWords(file.words, meta.owner ?? user.username);
    const original = file.originalWords ?? file.words;
    const changed =
      cleaned.length !== file.words.length ||
      cleaned.some((w, i) => w.text !== file.words[i]?.text);
    if (!changed) {
      return c.json({
        words: file.words,
        cleaned: !!file.originalWords?.length,
      });
    }
    await writeFile(
      transcriptPath(meta.id),
      JSON.stringify({
        words: plainWords(cleaned),
        originalWords: plainWords(original),
      }),
    );
    return c.json({ words: cleaned, cleaned: true });
  } catch (e) {
    if (e instanceof AiProviderError) {
      return c.json({ error: e.message, code: e.code }, 502);
    }
    return c.json(
      { error: e instanceof Error ? e.message : String(e) },
      400,
    );
  }
});

clipsApp.post("/:id/transcript/restore", async (c) => {
  const meta = await ownedMeta(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  const file = await loadTranscript(meta.id);
  if (!file.originalWords?.length) {
    return c.json({ error: "No original transcript to restore" }, 409);
  }
  await writeFile(
    transcriptPath(meta.id),
    JSON.stringify({ words: file.originalWords }),
  );
  return c.json({ words: file.originalWords, cleaned: false });
});

clipsApp.get("/:id/download", async (c) => {
  const id = c.req.param("id");
  const meta = await ownedMeta(id, c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  const p = recordingPath(id);
  if (!existsSync(p)) return c.json({ error: "Not ready" }, 409);
  const st = await stat(p);
  const ext = meta.mime.includes("mp4") ? "mp4" : "webm";
  const base =
    meta.name.replace(/[^\w.\- ]+/g, "").trim() || "clip";
  return new Response(
    Readable.toWeb(createReadStream(p)) as unknown as ReadableStream,
    {
      headers: {
        "Content-Type": meta.mime || "video/webm",
        "Content-Length": String(st.size),
        "Content-Disposition": `attachment; filename="${base}.${ext}"`,
      },
    },
  );
});

clipsApp.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const meta = await ownedMeta(id, c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  cancel(id);
  await rm(sesDir(id), { recursive: true, force: true });
  return c.json({ ok: true });
});
