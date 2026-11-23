import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { sessionOf, type AuthVars } from "./auth";
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
import { deviceStatus, deviceTranscribes, transcribeOnDevice } from "./lib/device-transcribe";
import { dropTask, keep, startTask, taskFor, taskWaitLine } from "./work/tasks";
import { env } from "./lib/env";
import { FILE_HEADERS, servedType } from "./lib/send-file";
import { currentWorkspaceId, inCurrentWorkspace } from "./lib/workspace-scope";
import { mayLeave, workspaceLibrary } from "./library/upload-gate";
import { videoLanguages } from "./lib/video-languages";
import { workspaceContext, workspaceOf } from "./lib/workshop/context";
import { isWithin, sharedFolder } from "./folders";
import type { SharedFolder, ToolFolder } from "../contracts/folders";
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
import { canSee, findUser, LOCAL_USER, type SessionUser } from "./users";
import { okId } from "./lib/ids";
import {
  cloudTranscribeBlock,
  transcribeWav,
  userMayCloudTranscribe,
} from "./transcribe";

/**
 * Clips — a screen recorder inside Creator Toolset.
 * Recordings live at $DATA_DIR/clips/<id>/, fully separate from caption
 * projects. After upload a computer makes the picture, the length and the sound (a computer task, api/work/tasks/clips.ts,
 * the one road of work/tasks.ts); the server then has the sound transcribed (Deepgram, when unlocked, on the owner's key)
 * and titles/summarizes (same AI keys as caption cadence).
 *
 * Layout:
 *   meta.json     session state
 *   recording     original upload (webm/mp4)
 *   transcript.json
 *   thumb.jpg
 */

export const clipsApp = new Hono<{ Variables: AuthVars }>();
// the restart pass runs before the first request, so no read ever has to tidy a stale state
clipsApp.use("*", async (_c, next) => {
  await resumeStoppedClips();
  await next();
});

const CLIPS_DIR = path.join(env.dataDir, "clips");
const sesDir = (id: string) => path.join(CLIPS_DIR, id);
export const recordingPath = (id: string) => path.join(sesDir(id), "recording");
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
  // in the workspace it was made in (the window's, or the chat's for one dropped in the assistant)
  const projectId = await currentWorkspaceId(user);
  const meta: Meta = {
    id,
    name,
    owner,
    ...(projectId ? { projectId } : {}),
    duration: 0,
    bytes: st.size,
    mime,
    status: "processing",
    step: "thumbnail",
    progress: 0.04,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  // in `active` before it is on disk: a note is `processing` outside it only when a restart stopped it
  enqueue(meta, user);
  await persist(meta);
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
  /** the workspace it was made in; absent on one from before workspaces (the first brand's) */
  projectId?: string;
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
  /** How many times a restart has started its processing again (resumeJob). */
  resumes?: number;
}

const active = new Map<string, Meta>();
const writeQ = new Map<string, Promise<unknown>>();
const generating = new Map<string, Set<BlockKind>>();

// a note's card runs while it is made (assistant.ts sweepWork); one a restart cut off is picked up first, as before a page read
void import("./assistant").then(({ checkWork }) => checkWork("notes", async (id) => {
  await resumeStoppedClips();
  const noteId = id.slice("notes:".length);
  const meta = active.has(noteId) ? null : await readMeta(noteId);
  if (active.has(noteId)) return null;
  if (!meta) return { status: "stopped", detail: "Deleted" };
  if (meta.status === "ready") return { status: "done", detail: "Ready" };
  return meta.status === "error" ? { status: "failed", detail: (meta.error ?? "").trim().split("\n").at(-1)!.slice(0, 160) } : { status: "stopped", detail: "Stopped" };
}));

/** This account's notes being made and sections being written, for Home (api/activity.ts); with `keep`, one workspace's. */
export async function notesWork(username: string, keep?: ((own?: string) => boolean) | null) {
  const mine = (m: Meta | null) => m?.owner === username && (!keep || keep(m.projectId));
  const writing = (await Promise.all([...generating.keys()].filter((id) => !active.has(id)).map(readMeta))).filter(mine);
  return [
    ...[...active.values()].filter((m) => mine(m) && m.status === "processing").map((m) => ({ id: m.id, name: m.name, progress: m.progress, section: false })),
    ...writing.map((m) => ({ id: m!.id, name: m!.name, progress: undefined, section: true })),
  ];
}

void mkdir(CLIPS_DIR, { recursive: true }).catch(() => {});

/** What a stopped note says (Stop, POST /:id/stop): its processing ended by the person, not failed. */
export const STOPPED = "Stopped";
/** Each note's Stop: its processing and its sections being written take this signal at their start; Stop aborts it. */
const stops = new Map<string, AbortController>();
function stopSignal(id: string): AbortSignal {
  let c = stops.get(id);
  if (!c) stops.set(id, (c = new AbortController()));
  return c.signal;
}
/** A run's end: the note's Stop goes once nothing of it runs (a newer run's Stop stays). */
function releaseStop(id: string, signal: AbortSignal): void {
  if (stops.get(id)?.signal === signal && !active.has(id) && !generating.get(id)?.size) stops.delete(id);
}

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
  const signal = stopSignal(id);
  try {
    const meta = await readMeta(id);
    if (!meta) return;
    owner = meta.owner;
    const block = await generateBlock(meta, k, force, signal);
    await afterWrite(id, async () => {
      const fresh = await readMeta(id);
      // a section stopped meanwhile keeps what the note had
      if (!fresh || signal.aborted) return;
      applyBlock(fresh, k, block, force);
      await persist(fresh);
    });
    blockErrors.delete(errorKey(id, k));
  } catch (e) {
    if (signal.aborted) return; // stopped: no error to show (finally still releases it)
    blockErrors.set(
      errorKey(id, k),
      e instanceof Error ? e.message : String(e),
    );
  } finally {
    releaseKind(id, k);
    releaseStop(id, signal);
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
    return active.get(id) ?? meta;
  } catch {
    return null;
  }
}


async function publishedMeta(id: string): Promise<Meta | null> {
  if (!okId(id)) return null;
  return readMeta(id);
}

async function ownedMeta(id: string, user: SessionUser): Promise<Meta | null> {
  if (!okId(id)) return null;
  const meta = await readMeta(id);
  return meta && canSee(meta, user) ? meta : null;
}

/** "Waits for one of your computers…" while the note's task has no computer to take it. */
const waitLine = (m: Meta): string | undefined => {
  const t = m.status === "processing" ? taskFor(NOTES_TASK, m.id) : undefined;
  return t && taskWaitLine(t);
};

/** `writingBefore`: the sections being written before `m` was read from disk (GET /:id). */
const publicMeta = (m: Meta, writingBefore: Iterable<BlockKind> = []) => {
  const nested = m.blocks?.find((b) => b.kind === "chapters")?.chapters;
  const chapters = m.chapters?.length ? m.chapters : nested;
  const blocks = m.blocks?.filter((b) => b.kind !== "chapters");
  const gen = [...new Set([...writingBefore, ...(generating.get(m.id) ?? [])])];
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
    ...(deviceStatus(m.id) ? { note: deviceStatus(m.id) } : waitLine(m) ? { note: waitLine(m) } : {}),
  };
};

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

/** Whose published clip it is: its frames are made on that person's computers (lib/clip-frame.ts). */
export const clipOwner = async (id: string): Promise<string> => (await publishedMeta(id))?.owner ?? "";

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

/** Most of its workspace a call about one note carries. */
const WORKSPACE_MAX = 6000;

/**
 * What a call that writes about a note reads: the workspace the note is in (lib/workshop/context.ts: its own, or the
 * first brand's for one from before workspaces), so the product, the game or the people are named as the workspace
 * names them, then its length and what was said. A note in no workspace reads as it always did.
 */
async function noteMaterial(meta: Meta, words: Word[]): Promise<string> {
  const workspace = meta.owner ? await workspaceContext(await workspaceOf(meta.owner, meta.projectId), WORKSPACE_MAX) : "";
  const about = workspace
    ? `The workspace this recording belongs to. Use it to name what is seen and said (the product, the game, its places and features, the people); never add what the transcript doesn't say:\n${workspace}\n\n`
    : "";
  return `${about}Duration: ${Math.round(meta.duration)}s\nTranscript:\n${timedTranscript(words)}`;
}

async function generateBlock(
  meta: Meta,
  kind: BlockKind,
  force = false,
  signal?: AbortSignal,
): Promise<ClipBlock> {
  if (!force && kind === "summary" && meta.summary) {
    return { id: "summary", kind: "summary", text: meta.summary };
  }
  if (!force && kind === "chapters" && meta.chapters?.length) {
    return { id: "chapters", kind: "chapters", chapters: meta.chapters };
  }
  if (!anyAiConfigured(meta.owner)) {
    throw new AiProviderError("Needs an AI provider", "FAILED", false);
  }
  const words = await loadWords(meta.id);
  if (!words.length) throw new Error("Needs a transcript");
  const ai = aiFor(meta.owner, "notes", "Video Notes");
  const user = await noteMaterial(meta, words);

  if (kind === "summary") {
    const out = await completeWithFallback(
      `Summarize this screen recording. Return JSON only: {"text":"2-4 sentences covering the whole recording"}. Ground every claim in the transcript. No markdown.`,
      user,
      signal,
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
      signal,
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
      signal,
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
      signal,
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
    signal,
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

/** A note's computer task (api/work/tasks/clips.ts): its picture, length and sound, made where its recording is. */
export const NOTES_TASK = "notes";
/** What the task is asked for: the sound for the words, in the speech model's form ("device") or for a provider ("wav"). */
export type NoteInput = { sound: "wav" | "device" | null };
/** What it made beside thumb.jpg and `sound`: the length, and whether the recording has sound at all. */
export type NoteMade = { duration: number; audio: boolean };

/** The account a note's work runs as: its owner, or the one local account of an install without sign-in. */
function ownerSession(meta: Meta): SessionUser | null {
  const rec = meta.owner ? findUser(meta.owner) : null;
  return rec ? sessionOf(rec) : !env.appSecret ? LOCAL_USER : null;
}

/**
 * Starts a note's processing: the picture, length and sound are a computer task (the server runs it itself only on This
 * Mac or with its video work on, work/tasks.ts); noteFiled takes it from there. While no computer can take it the note
 * waits, its page saying so (publicMeta's note).
 */
async function processClip(id: string, user: SessionUser): Promise<void> {
  const meta = active.get(id);
  if (!meta) return;
  meta.step = "thumbnail";
  meta.progress = 0.08;
  await jobPersist(meta);
  // no key: a server on its owner's computer transcribes by itself (lib/device-transcribe.ts); a lock stays a lock
  const onDevice = userMayCloudTranscribe(user) && !!cloudTranscribeBlock(user) && deviceTranscribes();
  const sound = onDevice ? "device" : cloudTranscribeBlock(user) ? null : "wav";
  try {
    await startTask<NoteInput, NoteMade>(NOTES_TASK, id, meta.owner ?? user.username, meta.projectId ?? null, { sound });
  } catch (e) {
    await noteFailed(id, e instanceof Error ? e.message : String(e)); // a failed run already said so: this one changes nothing
  }
}

/** The task's result, on the server: the picture and the sound filed, then the words and the notes written here. */
export async function noteFiled(id: string, made: NoteMade, files: Record<string, string>): Promise<void> {
  const meta = active.get(id) ?? (await readMeta(id));
  if (!meta || meta.status !== "processing") return; // deleted, or failed meanwhile
  active.set(id, meta);
  if (made.duration) meta.duration = made.duration;
  if (files["thumb.jpg"]) await keep(files["thumb.jpg"], thumbPath(id));
  if (files.sound) await keep(files.sound, wavPath(id));
  // stopped while its files were kept: no words are written, and the sound kept after its Stop goes
  if (active.get(id) !== meta) return void (await rm(wavPath(id), { force: true }).catch(() => {}));
  const user = ownerSession(meta);
  if (!user) return noteFailed(id, "The note's account is gone");
  void noteText(meta, user, !!files.sound);
}

/** The task failed for good: the note shows why. */
export async function noteFailed(id: string, error: string): Promise<void> {
  const meta = active.get(id) ?? (await readMeta(id));
  if (!meta || meta.status !== "processing") return;
  meta.status = "error";
  meta.error = error;
  await jobPersist(meta);
  await noteEnded(meta);
}

/** The words (the sound the task made, heard on the owner's key or by this computer's speech model) and the notes. */
async function noteText(meta: Meta, user: SessionUser, heard: boolean): Promise<void> {
  const id = meta.id;
  const signal = stopSignal(id);
  let stopCrawl = () => {};
  try {
    const onDevice = userMayCloudTranscribe(user) && !!cloudTranscribeBlock(user) && deviceTranscribes();
    let words: Word[] = [];
    if (heard) {
      meta.step = "transcribe";
      meta.progress = 0.38;
      await jobPersist(meta);
      stopCrawl = crawlProgress(meta, 0.72);
      const result = onDevice
        ? await transcribeOnDevice(wavPath(id), id)
        : await transcribeWav(await readFile(wavPath(id)), user, { languages: await videoLanguages(user.username, meta.projectId), label: "Video Notes: transcripts" });
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
      signal.throwIfAborted(); // the transcription and its correction take no signal
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
          await noteMaterial(meta, words),
          signal,
          parseSummary,
          aiFor(meta.owner, "notes", "Video Notes"),
        );
        if (out.title) meta.name = out.title;
        if (out.summary) meta.summary = out.summary;
        if (out.chapters.length) {
          meta.chapters = capChapters(out.chapters, chMax);
        }
      } catch (e) {
        if (!(e instanceof AiProviderError) || signal.aborted) throw e;
        console.warn(`[clips] AI title skipped: ${e.message}`);
      }
      if (!meta.chapters?.length) {
        try {
          await generateBlock(meta, "chapters", false, signal);
        } catch (e) {
          if (!(e instanceof AiProviderError) || signal.aborted) throw e;
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
    meta.resumes = undefined;
    await jobPersist(meta);
  } catch (e) {
    stopCrawl();
    if (active.get(id) !== meta) return;
    meta.status = "error";
    meta.error = e instanceof Error ? e.message : String(e);
    await jobPersist(meta);
  } finally {
    stopCrawl();
    // a stopped run ended at its Stop; ending it again here could take a new run's sound away
    if (!signal.aborted) await noteEnded(meta);
    releaseStop(id, signal);
  }
}

/** A note's processing is over (ready, failed or deleted): the chat's card ends, and its sound goes. */
async function noteEnded(meta: Meta): Promise<void> {
  // a note the assistant started from a dropped file: its card in the chat ends, and the chat says so (a stopped one says nothing)
  if (meta.status !== "processing" && meta.owner) {
    // an encoder's own words can run to pages: the chat gets their last line, the note's page keeps all of them
    const why = (meta.error ?? "").trim().split("\n").at(-1)!.slice(0, 160);
    workEnded(
      meta.owner,
      `notes:${meta.id}`,
      meta.status === "ready"
        ? { status: "done", detail: "Ready", say: `“${meta.name}” is ready.`, choices: ["Sum it up"] }
        : meta.error === STOPPED
          ? { status: "failed", detail: STOPPED }
          : { status: "failed", detail: why, say: `“${meta.name}” did not finish: ${why}` },
    );
  }
  if (active.get(meta.id) === meta) active.delete(meta.id);
  await rm(wavPath(meta.id), { force: true }).catch(() => {});
}

/** The most times a restart starts a note's processing again: a file that takes the server down doesn't do it forever. */
const MAX_RESUMES = 3;

/**
 * A note whose processing a server restart stopped (a build, an update) starts again in the background as its owner;
 * the video plays meanwhile. False: no owner to run it as, or it has been started again too often.
 */
// ponytail: starts over from the thumbnail, so a long transcription is done again; keep the words heard so far if that hurts
function resumeJob(meta: Meta): boolean {
  if ((meta.resumes ?? 0) >= MAX_RESUMES) return false;
  const user = ownerSession(meta);
  if (!user) return false;
  meta.resumes = (meta.resumes ?? 0) + 1;
  console.log(`[clips] ${meta.id}: processing again after a restart (${meta.resumes}/${MAX_RESUMES})`);
  enqueue(meta, user);
  return true;
}

/**
 * Once, at start (boot.ts) and before the first request (the middleware awaits it), so no read has to: every note a
 * restart stopped picks up again without anyone opening it, or fails when it has been started again too often. One
 * whose task still waits for a computer (or one holds it) keeps waiting: the task outlives a restart.
 */
let resumed: Promise<void> | undefined;
export function resumeStoppedClips(): Promise<void> {
  return (resumed ??= (async () => {
    for (const meta of await clipMetas((m) => m.status === "processing" && !active.has(m.id))) {
      const t = taskFor(NOTES_TASK, meta.id)?.state;
      if (t === "queued" || t === "running") {
        active.set(meta.id, meta);
        continue;
      }
      if (!resumeJob(meta)) {
        meta.status = "error";
        meta.error = "Processing stopped when the server restarted";
      }
      await persist(meta);
    }
  })().catch((e) => console.warn("[clips] resume:", e)));
}

function enqueue(meta: Meta, user: SessionUser): void {
  active.set(meta.id, meta);
  meta.status = "processing";
  meta.step = "thumbnail";
  meta.progress = 0.04;
  meta.error = undefined;
  void processClip(meta.id, user);
}

/** Stops a clip's work; a workspace being deleted stops its clips' too (lib/workspace-delete.ts). */
/** For tests: how many notes hold a Stop. */
export const stopsHeld = () => stops.size;

export function cancel(id: string): void {
  active.delete(id);
  dropTask(NOTES_TASK, id);
  stops.get(id)?.abort();
  stops.delete(id);
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
    ...FILE_HEADERS,
    "Content-Type": servedType(type),
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    "Last-Modified": new Date(st.mtimeMs).toUTCString(),
    ETag: `"${size}-${Math.floor(st.mtimeMs)}"`,
  };
  // Streamed from disk: buffering a whole range per viewer ran the server out of memory (2026-11-12).
  const body = (start: number, end: number) =>
    Readable.toWeb(createReadStream(p, { start, end })) as unknown as ReadableStream;
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
    return new Response(body(start, end), {
      status: 206,
      headers: {
        ...base,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }
  return new Response(body(0, size - 1), {
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

/** The folders from the top down to `id`. */
function folderTrail(folders: ToolFolder[], id: string): ToolFolder[] {
  const out: ToolFolder[] = [];
  for (let f = folders.find((x) => x.id === id); f && !out.includes(f); f = folders.find((x) => x.id === f!.parentId)) out.unshift(f);
  return out;
}

/** Every clip's meta that `keep` takes, newest first. */
async function clipMetas(keep: (m: Meta) => boolean): Promise<Meta[]> {
  let ids: string[] = [];
  try {
    ids = (await readdir(CLIPS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter(okId);
  } catch {
    return [];
  }
  const metas = (await Promise.all(ids.map(readMeta))).filter((m): m is Meta => !!m && keep(m));
  return metas.sort((a, b) => b.createdAt - a.createdAt);
}

clipsApp.get("/", async (c) => {
  const user = c.get("user");
  // the workspace the window is in keeps its own notes; a shared folder's link and a note's own link show them anywhere
  const keep = await inCurrentWorkspace(user);
  const metas = await clipMetas((m) => (m.owner === user.username || (user.role === "admin" && !m.owner)) && (!keep || keep(m.projectId)));
  return c.json(metas.map((m) => publicMeta(m)));
});

// GET /api/clips/f/:token[?f=<a folder inside>] → SharedFolder: a shared folder of Video Notes, no account needed (its
// link is the key). Only that folder and the ones inside it, and only its owner's clips in them.
clipsApp.get("/f/:token", async (c) => {
  const shared = await sharedFolder("notes", c.req.param("token"));
  if (!shared) return c.json({ error: "Not found" }, 404);
  const { data, folder: root, username } = shared;
  const at = data.folders.find((f) => f.id === (c.req.query("f") || root.id));
  if (!at || !isWithin(data, root.id, at.id)) return c.json({ error: "Not found" }, 404);
  const clips = await clipMetas((m) => m.owner === username && m.status !== "error");
  const inFolder = (fid: string) => clips.filter((m) => data.items[m.id] === fid);
  const trail = folderTrail(data.folders, at.id);
  const out: SharedFolder = {
    name: root.name,
    trail: trail.slice(trail.findIndex((f) => f.id === root.id)).map(({ id, name }) => ({ id, name })),
    folders: data.folders
      .filter((f) => f.parentId === at.id)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => ({
        id: f.id,
        name: f.name,
        count: inFolder(f.id).length + data.folders.filter((x) => x.parentId === f.id).length,
        pictures: inFolder(f.id).map((m) => m.id).filter((id) => existsSync(thumbPath(id))).slice(0, 4),
      })),
    items: inFolder(at.id).map((m) => ({ id: m.id, name: m.name, duration: m.duration, createdAt: m.createdAt, hasThumb: existsSync(thumbPath(m.id)) })),
  };
  return c.json(out, 200, { "Cache-Control": "no-store" });
});

/**
 * Blur faces in the workspace the recording goes to (upload-gate.ts mayLeave): a recording is not known to be blurred, so
 * it is not taken there. The refusal's answer, else null.
 */
async function recordingRefused(c: Context<{ Variables: AuthVars }>): Promise<Response | null> {
  const user = c.get("user");
  const left = mayLeave(await workspaceLibrary(user.username, await currentWorkspaceId(user)), {});
  return left.ok ? null : c.json(left.body, left.status);
}

clipsApp.post("/init", async (c) => {
  const refused = await recordingRefused(c);
  if (refused) return refused;
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
  const refused = await recordingRefused(c);
  if (refused) return refused;
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
  // a section is saved before it leaves `generating`: one that finishes while the note is read from disk may be missing from
  // that read, so it is still reported as being written (the next read has it), never as neither
  const writing = [...(generating.get(c.req.param("id")) ?? [])];
  const meta = await publishedMeta(c.req.param("id"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  return c.json(publicMeta(meta, writing), 200, {
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

// POST /api/clips/:id/stop → { ok }: the note's processing and the sections being written end now; the recording stays
clipsApp.post("/:id/stop", async (c) => {
  const meta = await ownedMeta(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  const processing = meta.status === "processing";
  cancel(meta.id);
  if (processing) {
    meta.status = "error";
    meta.step = undefined;
    meta.error = STOPPED;
    await jobPersist(meta);
    await noteEnded(meta);
  } else announceSoon(meta.owner, "clips"); // its sections leave `generating` as their runs end
  return c.json({ ok: true });
});

clipsApp.post("/:id/retry", async (c) => {
  const user = c.get("user");
  const meta = await ownedMeta(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  // still in `active` with its run over: that run is at its last save, and its end would take a new run's place away
  if (meta.status === "processing" || active.has(meta.id)) {
    return c.json({ error: "Already processing" }, 409);
  }
  meta.resumes = undefined;
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
    return c.json({ error: "Needs an AI provider" }, 400);
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
        ...FILE_HEADERS,
        "Content-Type": servedType(meta.mime || "video/webm"),
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
  // retried: a save of its run that lands while the folder goes would leave the folder behind, marked processing
  await rm(sesDir(id), { recursive: true, force: true, maxRetries: 3 });
  return c.json({ ok: true });
});
