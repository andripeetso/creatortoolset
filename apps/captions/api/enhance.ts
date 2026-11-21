import { Hono, type Context } from "hono";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import { link, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AuthVars } from "./auth";
import { creditBack, creditOut, isOutOfCredits, outOfCreditsMessage } from "./credits";
import type { EnhanceStatus } from "../contracts/enhance";
import { env } from "./lib/env";
import { keyFor, type Actor } from "./my-keys";
import { enhancePiece, NvidiaRefused, SR as NV_SR } from "./lib/nvidia-voice";
import { type SessionUser, bumpUsage } from "./users";
import { type Moves, move } from "./lib/transition";
import { announceSoon } from "./lib/announce-soon";
import { currentWorkspaceId, inCurrentWorkspace } from "./lib/workspace-scope";
import { dropTask, keep, startTask, taskFor, taskWaitLine } from "./work/tasks";
import { serverWorks } from "./work/server-work";

/**
 * Standalone audio enhancement — its own tool, fully separate from
 * caption projects. Upload any audio/video file and it is enhanced
 * immediately in the same go; the /enhance page then A/Bs original vs.
 * result and offers downloads (clean audio, or the video remuxed with
 * it).
 *
 * ENGINES, picked per run, every result levelled to the same -15 LUFS so
 * switching never jumps in volume:
 * - nvidia (the default): NVIDIA Studio Voice on NVIDIA's hosted API
 *   (lib/nvidia-voice.ts), in this process.
 * - elevenlabs: ElevenLabs Voice Isolator.
 * Each runs on the session owner's key (my-keys.ts keyFor: their own from Settings → API keys; the server's only
 * for the platform admin).
 * Admins can add a second pass (`?then=`): `meta.chain`, `meta.step`; a
 * pass's output feeds the next as pass-<step>.wav.
 * Strength: the page blends the original and the result live; `meta.mix`
 * keeps the pick and a download at a strength under 100 % is that blend
 * (blend-<pct>.m4a, made once), with the original levelled like the result
 * (source.m4a) so only the sound moves.
 *
 * Layout: $DATA_DIR/enhance/<id>/
 *   meta.json        session state (job status lives here too)
 *   original         the uploaded file, kept for re-runs and video mux
 *   source.m4a       original audio at the result's loudness, for A/B and blends
 *   enhanced.m4a     the result
 *   enhanced-video.* original video + clean track, stream-copied
 *   pass-<n>.wav     a pass's output, the next pass's input
 *   blend-<pct>.m4a  a download at that strength (+ blend-<pct>-video.*)
 *
 * One run per session. The built-in engines' passes, the loudness and the video remux are a computer task
 * (api/work/tasks/enhance.ts, the one road of work/tasks.ts): a computer cuts the sound and makes the files, the server
 * makes the paid engine call on the owner's key (decision 12). A plug-in engine's pass runs as that plug-in says.
 */
export const enhanceApp = new Hono<{ Variables: AuthVars }>();

const ENHANCE_DIR = path.join(env.dataDir, "enhance");
/** 0 = keep sessions until the user deletes them. */
const KEEP_DAYS = Number(process.env.ENHANCE_KEEP_DAYS || 0);
/** The engines, the default first. */
export const ENGINES = ["nvidia", "elevenlabs"] as const;
/** Every engine id: the built-in ones above, plus the ones a plug-in registers (registerEnhanceEngine). */
export type Engine = string;
type BuiltinEngine = (typeof ENGINES)[number];
/** An engine a plug-in adds. It runs its own passes and hands each result back through `enhanceHost`. */
export interface EnhanceEngine {
  id: string;
  /** Why this account can't run it now (its key, its role), or null. */
  refusal?: (user: SessionUser) => string | null;
  /** True for an account whose default engine this is (checked before NVIDIA). */
  preferred?: (user: SessionUser) => boolean;
  /** Extra fields for GET /availability. */
  availability?: (user: SessionUser) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Starts this engine's pass for `meta`; its input is `enhanceHost.stepInput(meta)`. Must not reject. */
  start: (host: EnhanceHost, meta: Meta) => Promise<void>;
  /** Routes, mounted under /api/enhance/engine/<id> (the body limit and the tool gate of /api/enhance apply). */
  routes?: Hono<any, any, any>;
}
const engines = new Map<string, EnhanceEngine>();
/** Called by a plug-in at module load, before boot mounts /api/enhance (Hono copies a sub-app's routes at mount time). */
export function registerEnhanceEngine(e: EnhanceEngine): void {
  if (!/^[a-z][a-z0-9]{1,20}$/.test(e.id)) throw new Error(`enhance engine "${e.id}": lowercase letters and digits only`);
  if ((ENGINES as readonly string[]).includes(e.id) || engines.has(e.id)) throw new Error(`enhance engine "${e.id}" is declared twice`);
  engines.set(e.id, e);
  if (e.routes) enhanceApp.route(`/engine/${e.id}`, e.routes);
}
const isEngine = (v: unknown): v is Engine =>
  typeof v === "string" && ((ENGINES as readonly string[]).includes(v) || engines.has(v));
const allEngines = (): string[] => [...ENGINES, ...engines.keys()];

const okId = (id: string) => /^[a-z0-9-]{6,40}$/.test(id);
const sesDir = (id: string) => path.join(ENHANCE_DIR, id);
const sourceAudio = (id: string) => path.join(sesDir(id), "source.m4a");
const enhancedAudio = (id: string) => path.join(sesDir(id), "enhanced.m4a");
export const ENHANCE_TASK = "enhance";
export const originalPath = (id: string) => path.join(sesDir(id), "original");
const enhancedVideo = (id: string, ext: string) =>
  path.join(sesDir(id), `enhanced-video.${ext}`);
export const passOut = (id: string, step: number) => path.join(sesDir(id), `pass-${step}.wav`);
const blendAudio = (id: string, pct: number) => path.join(sesDir(id), `blend-${pct}.m4a`);
const blendVideo = (id: string, pct: number, ext: string) => path.join(sesDir(id), `blend-${pct}-video.${ext}`);
/** Every result, and the original it's compared and blended with, at one loudness. */
export const LOUDNESS = "loudnorm=I=-15:TP=-1.5:LRA=9";

/** A session's status moves. A run is queued, then running (here or on the Mac), then done or error; a cancel gives back ready or done. */
export const ENHANCE_MOVES: Moves<EnhanceStatus> = {
  ready: ["queued", "needs_key"],
  queued: ["running", "ready", "done", "error", "needs_key"],
  running: ["queued", "ready", "done", "error", "needs_key"],
  done: ["queued", "needs_key"],
  error: ["queued", "needs_key"],
  needs_key: ["queued", "needs_key"],
};

/** An engine's key is missing for the session's owner: the run waits (needs_key) instead of failing. */
class NeedsKey extends Error {}

/** Every status change goes through here; an illegal move throws (routes answer 409). */
function setStatus(meta: Meta, to: EnhanceStatus): void {
  meta.status = move(ENHANCE_MOVES, meta.status, to, `enhance ${meta.id}`);
}

export interface Meta {
  id: string;
  name: string;
  owner?: string;
  /** The workspace it was made in (none: from before workspaces, the first brand's). Any engine keeps it: it saves this meta. */
  projectId?: string;
  hasVideo: boolean;
  duration: number;
  bytes: number;
  status: EnhanceStatus;
  /** What processes (processed) the run: an Engine; older sessions may
   *  carry legacy names, display-only. */
  engine?: string;
  /** A plug-in engine's run waiting for, or claimed by, its outside worker (`at`: when). */
  remote?: { state: "waiting" | "claimed"; at: number };
  /** The passes, in order (admins: up to two); `engine` = the first. */
  chain?: Engine[];
  /** The pass running (or next). */
  step?: number;
  /** The strength picked on the page: the result's share against the original (0..1). */
  mix?: number;
  progress: number; // 0..1
  error?: string;
  /** Container of enhanced-video.* when one was produced. */
  videoOutExt?: "mp4" | "mkv";
  /** The computer task now under way: a result or a progress note from an older one (a cancel, a new run) is left alone. */
  run?: string;
  createdAt: number;
  updatedAt: number;
}

/** Sessions with a run under way (a computer task, or a plug-in engine's step here); anything on disk claiming to run
 *  but absent here, with no task and not waiting on the Mac, was killed by a restart. */
const active = new Map<string, Meta>();
const children = new Map<string, ChildProcess>();
/** In-flight engine requests (ElevenLabs, NVIDIA), so cancel() can abort them. */
const apiCalls = new Map<string, AbortController>();
/** Sessions cancelled while no job of theirs was in memory: a plug-in engine's answer that raced the cancel is refused. */
export const cancelled = new Set<string>();
/** Runs a restart of the server would end (reconcileInterrupted fails them): a deploy waits for 0 (/api/health). A computer
 *  task outlives a restart, so only a plug-in engine's step here counts. */
export const enhancesAtRisk = (): number => [...active.values()].filter((m) => m.status === "running" && !m.run).length;
/** A plug-in engine's passes waiting for or on its own worker (out of `active`), as their saves say. ponytail: a restart forgets them until they next save. */
const away = new Map<string, Meta>();
/** This account's files being enhanced, here or by a plug-in engine's worker, for Home (api/activity.ts); `keep`: only this workspace's. */
export const enhancing = (username: string, keep?: ((own?: string) => boolean) | null) =>
  [...new Map([...away, ...active]).values()].filter((m) => m.owner === username && (m.status === "queued" || m.status === "running") && (!keep || keep(m.projectId))).map((m) => ({ id: m.id, name: m.name, waits: m.status === "queued", progress: m.progress }));

void mkdir(ENHANCE_DIR, { recursive: true }).catch(() => {});

async function persist(meta: Meta): Promise<void> {
  meta.updatedAt = Date.now();
  try {
    // whole or not at all: two saves at once (startRun's and the task's) would leave the longer one's tail behind
    const file = path.join(sesDir(meta.id), "meta.json");
    const tmp = `${file}.${randomUUID()}`;
    await writeFile(tmp, JSON.stringify(meta));
    await rename(tmp, file).catch(async (e) => {
      await rm(tmp, { force: true });
      throw e;
    });
  } catch {
    /* session may have been deleted mid-job */
  }
  // a plug-in engine's pass saves with this: Home hears when one goes to its worker and when it is back
  const was = away.has(meta.id);
  if (meta.remote && (meta.status === "queued" || meta.status === "running")) away.set(meta.id, meta);
  else away.delete(meta.id);
  if (was !== away.has(meta.id)) announceSoon(meta.owner, "enhance");
}

/** A background job's save: the owner's open screens follow it (at most about once a second, the last save always). */
async function jobPersist(meta: Meta): Promise<void> {
  await persist(meta);
  announceSoon(meta.owner, "enhance");
}

async function readMeta(id: string): Promise<Meta | null> {
  const mem = active.get(id);
  if (mem) return mem;
  try {
    return JSON.parse(await readFile(path.join(sesDir(id), "meta.json"), "utf-8"));
  } catch {
    return null;
  }
}

/** Runs a restart left queued/running: error them. Production only (dev shares the data dir). A read never writes. */
async function reconcileInterrupted(): Promise<void> {
  for (const id of await sessionIds()) {
    if (active.has(id)) continue;
    const meta = await readMeta(id);
    if (!meta || (meta.status !== "queued" && meta.status !== "running")) continue;
    if (meta.remote) continue; // a plug-in engine's run: its own sweep decides
    const t = taskFor(ENHANCE_TASK, id)?.state;
    if (meta.run && (t === "queued" || t === "running")) {
      active.set(id, meta); // its task waits or runs on: Home lists it, and its result is filed when it comes
      continue;
    }
    setStatus(meta, "error");
    meta.error = "Stopped when the server restarted";
    await persist(meta);
  }
}

const canSee = (meta: Meta, user: SessionUser) =>
  user.role === "admin" || meta.owner === user.username;

async function ownedMeta(id: string, user: SessionUser): Promise<Meta | null> {
  if (!okId(id)) return null;
  const meta = await readMeta(id);
  return meta && canSee(meta, user) ? meta : null;
}

/** Everything the client needs beyond meta: does a result exist, and the wait line while no computer can take the run. */
const publicMeta = (m: Meta) => {
  const t = m.status === "queued" && m.run ? taskFor(ENHANCE_TASK, m.id) : undefined;
  const line = t && taskWaitLine(t);
  return { ...m, hasEnhanced: existsSync(enhancedAudio(m.id)), ...(line ? { line } : {}) };
};

const sessionIds = async () =>
  (await readdir(ENHANCE_DIR, { withFileTypes: true }).catch(() => []))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter(okId);

/* ---- retention (opt-in, mirrors exports) ---- */

async function sweep(): Promise<void> {
  if (!KEEP_DAYS) return;
  const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
  for (const id of await sessionIds()) {
    if (active.has(id)) continue;
    const meta = await readMeta(id);
    if (meta && meta.updatedAt < cutoff) {
      await rm(sesDir(id), { recursive: true, force: true }).catch(() => {});
    }
  }
}
if (KEEP_DAYS > 0) {
  void sweep();
  setInterval(() => void sweep(), 6 * 3600 * 1000).unref();
}
// production only: dev servers share ~/.caption-studio with real sessions
if (env.isProduction) {
  void reconcileInterrupted();
}


/* ---- probes & process helpers ---- */

/**
 * A plug-in engine's convert where this server may not decode: its one input goes to its output as is (a link, no copy),
 * and the engine's own computer decodes it. shortcut: one `-i` and the output last; a step with more inputs fails.
 */
async function handOver(args: string[]): Promise<void> {
  const inputs = args.filter((_, i) => args[i - 1] === "-i");
  if (inputs.length !== 1) throw new Error("This server doesn't process video or sound, and this step needs it.");
  const out = args.at(-1)!;
  await rm(out, { force: true });
  await link(inputs[0]!, out);
}

/** Spawn a command for session `id` (tracked so cancel can kill it),
 *  mapping ffmpeg -progress output onto the [lo, hi] progress slice. Only a plug-in engine calls it (enhanceHost), with
 *  its own commands for its own pass; nothing in this file runs one. */
function runStep(
  id: string,
  meta: Meta,
  cmd: string,
  args: string[],
  progress?: { duration: number; lo: number; hi: number }
): Promise<void> {
  if (cmd === "ffmpeg" && !serverWorks(meta.projectId, meta.owner ?? null)) return handOver(args);
  return new Promise((resolve, reject) => {
    const fullArgs =
      cmd === "ffmpeg"
        ? ["-hide_banner", "-loglevel", "error", "-nostats", "-y", ...args, "-progress", "pipe:1"]
        : args;
    const p = spawn(cmd, fullArgs, { stdio: ["ignore", "pipe", "pipe"] });
    children.set(id, p);
    let err = "";
    let buf = "";
    let lastWrite = 0;
    p.stderr!.on("data", (d) => {
      err += d.toString();
      if (err.length > 4000) err = err.slice(-4000);
    });
    p.stdout!.on("data", (d) => {
      if (!progress) return;
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line.trim());
        if (!m) continue;
        const sec = Number(m[1]) / 1e6; // both variants are microseconds
        const frac = Math.min(sec / Math.max(progress.duration, 0.1), 1);
        meta.progress = Math.min(progress.lo + frac * (progress.hi - progress.lo), progress.hi);
        if (Date.now() - lastWrite > 500) {
          lastWrite = Date.now();
          void jobPersist(meta);
        }
      }
    });
    p.on("close", (code) => {
      children.delete(id);
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(cmd)} exited ${code}: ${err}`));
    });
    p.on("error", (e) => {
      children.delete(id);
      reject(e);
    });
  });
}

/* ---- engines ---- */

const KEY = { nvidia: "NVIDIA_API_KEY", elevenlabs: "ELEVENLABS_API_KEY" } as const;
/** The engine's key for whoever the session belongs to; throws the "add your key" message when none serves them. */
function engineKey(engine: BuiltinEngine, owner: Actor): string {
  const r = keyFor(owner, KEY[engine]);
  if (r.missing) throw new NeedsKey(r.missing);
  return r.key;
}
/** The default engine: a plug-in engine that prefers this account, else NVIDIA for everyone. */
const defaultEngine = (user: SessionUser): Engine => [...engines.values()].find((e) => e.preferred?.(user))?.id ?? "nvidia";

/** Why `user` can't run `engine`, or null. */
function refusal(engine: Engine, user: SessionUser): string | null {
  const plugged = engines.get(engine);
  if (plugged) return plugged.refusal?.(user) ?? null;
  return keyFor(user, KEY[engine as BuiltinEngine]).missing ?? null;
}

/** One NVIDIA Studio Voice piece (a 48 kHz WAV a computer cut) on the owner's key: the cleaned piece back. */
export async function voicePiece(id: string, owner: string | undefined, wav: Buffer): Promise<Buffer> {
  const controller = new AbortController();
  apiCalls.set(id, controller);
  try {
    return await enhancePiece(engineKey("nvidia", owner), wav, controller.signal);
  } catch (e) {
    if (controller.signal.aborted) throw new Error("Cancelled");
    if (e instanceof NvidiaRefused) console.warn(`[nvidia] ${e.message}`);
    throw e;
  } finally {
    apiCalls.delete(id);
  }
}

/* ElevenLabs Voice Isolator */

const EL_EXT: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
};

/**
 * One call to the Voice Isolator on the owner's key: the WAV a computer cut goes up, the cleaned audio comes back
 * with its extension. Registered in `apiCalls` so cancel() aborts the fetch.
 */
export async function isolate(id: string, owner: string | undefined, audio: Buffer): Promise<{ ext: string; audio: Buffer }> {
  const key = engineKey("elevenlabs", owner);
  const form = new FormData();
  form.append("audio", new Blob([audio], { type: "audio/wav" }), "audio.wav");

  const controller = new AbortController();
  apiCalls.set(id, controller);
  let res: Response;
  try {
    res = await fetch("https://api.elevenlabs.io/v1/audio-isolation", {
      method: "POST",
      headers: { "xi-api-key": key },
      body: form,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60 * 1000)]),
    });
  } catch (e) {
    if (controller.signal.aborted) throw new Error("Cancelled");
    throw e instanceof Error ? e : new Error(String(e));
  } finally {
    apiCalls.delete(id);
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    if (isOutOfCredits(res.status, detail)) {
      console.warn(`[elevenlabs] out of credits (${res.status}): ${detail}`);
      creditOut("ELEVENLABS_API_KEY", key, "Voice isolation");
      throw new Error(outOfCreditsMessage("Audio enhancement"));
    }
    if (res.status === 401) {
      throw new Error("ElevenLabs did not accept the key. Check it in Settings → API keys.");
    }
    if (res.status === 429) {
      throw new Error("Too many requests to ElevenLabs. Retry in a minute.");
    }
    throw new Error(`ElevenLabs error ${res.status}: ${detail || "no details"}`);
  }
  creditBack("ELEVENLABS_API_KEY", key);
  return { ext: EL_EXT[(res.headers.get("content-type") || "").split(";")[0].trim()] || "mp3", audio: Buffer.from(await res.arrayBuffer()) };
}

/* ---- pipeline ---- */

/**
 * The computer task's ask: from pass `step` on, through the built-in engines; `source`: make the levelled original too;
 * `finish`: only the last steps, on the sound a plug-in engine's run left (finishInput).
 */
export type EnhanceInput = { run: string; chain: Engine[]; step: number; source: boolean; finish?: true };
/** What it found and made; `next`: a plug-in engine's pass comes next (its input is pass.wav, or the upload). */
export type EnhanceMade = { duration: number; hasVideo: boolean; next?: number; videoOutExt?: "mp4" | "mkv" };
export const builtinEngine = (e: string): boolean => (ENGINES as readonly string[]).includes(e);

/** Queues the run; true when it is queued, false when it parked as needs_key. */
function enqueue(meta: Meta, user: SessionUser): boolean {
  meta.progress = 0;
  meta.error = undefined;
  meta.chain = meta.chain?.length ? meta.chain : [isEngine(meta.engine) ? meta.engine : "nvidia"];
  meta.step = 0;
  // a pass whose engine has no key for this user parks the session; it runs once they add one and run again
  const missing = meta.chain.map((e) => refusal(e, user)).find(Boolean);
  if (missing) {
    setStatus(meta, "needs_key");
    meta.error = missing;
    return false;
  }
  setStatus(meta, "queued");
  cancelled.delete(meta.id);
  meta.remote = undefined;
  startStep(meta);
  return true;
}

/**
 * The current pass: a plug-in engine's (it hands the result back itself), or the computer task from this pass on. A
 * plug-in engine starts at once, even first: its computer waits for no other task, and the length, the picture check and
 * the levelled original come with the run's last steps (finish).
 */
function startStep(meta: Meta): void {
  const plugged = engines.get(meta.chain![meta.step ?? 0]);
  if (plugged) {
    void plugged.start(enhanceHost, meta).catch(async (e) => {
      if (active.get(meta.id) !== meta) return;
      setStatus(meta, "error");
      meta.error = e instanceof Error ? e.message : String(e);
      meta.remote = undefined;
      await jobPersist(meta);
    });
    return;
  }
  startRun(meta, { chain: meta.chain!, step: meta.step ?? 0, source: !existsSync(sourceAudio(meta.id)) });
}

/** Starts the session's computer task; while it waits the session is queued, its page showing the wait line. */
function startRun(meta: Meta, ask: Omit<EnhanceInput, "run">): void {
  const run = randomUUID();
  meta.run = run;
  active.set(meta.id, meta);
  void persist(meta);
  void startTask<EnhanceInput, EnhanceMade>(ENHANCE_TASK, meta.id, meta.owner ?? "", meta.projectId ?? null, { run, ...ask }).then(
    async (got) => {
      if (got.state !== "queued" || meta.run !== run) return;
      setStatus(meta, "queued"); // a plug-in engine's run comes here running
      await jobPersist(meta); // the page hears the wait line
    },
    (e) => enhanceFailed(meta.id, run, e instanceof Error ? e.message : String(e)), // a failed run already said so
  );
}

/** The session while run `run` is its run under way, else null (deleted, cancelled, or a newer run started). */
async function under(id: string, run: string): Promise<Meta | null> {
  const meta = await readMeta(id);
  return meta && meta.run === run && (meta.status === "queued" || meta.status === "running") ? meta : null;
}

/** A progress note from the task; the first moves the session to running. */
export async function enhanceProgress(id: string, run: string, p: number): Promise<void> {
  const meta = await under(id, run);
  if (!meta || !(p >= 0 && p <= 1)) return;
  setStatus(meta, "running");
  meta.progress = Math.max(meta.progress, Math.min(p, 0.99));
  active.set(id, meta);
  await jobPersist(meta);
}

/** The task's result, on the server: its files moved in and the session done, or the plug-in engine's pass started. */
export async function enhanceFiled(id: string, run: string, made: EnhanceMade, files: Record<string, string>): Promise<void> {
  const meta = await under(id, run);
  if (!meta) return;
  if (made.duration) meta.duration = made.duration;
  meta.hasVideo = made.hasVideo;
  if (files["source.m4a"]) await keep(files["source.m4a"], sourceAudio(id));
  meta.run = undefined;
  active.delete(id);
  if (made.next !== undefined) {
    if (files["pass.wav"]) await keep(files["pass.wav"], passOut(id, made.next - 1));
    meta.step = made.next;
    await persist(meta);
    // after this task is marked done: a start of the session's next task while this one is held would be ignored
    setImmediate(() => startStep(meta));
    return;
  }
  await keep(files["enhanced.m4a"]!, enhancedAudio(id));
  if (made.videoOutExt) await keep(files[`enhanced-video.${made.videoOutExt}`]!, enhancedVideo(id, made.videoOutExt));
  meta.videoOutExt = made.videoOutExt;
  setStatus(meta, "done");
  meta.progress = 1;
  await rm(finishInput(id), { force: true });
  await jobPersist(meta);
}

/** The task failed for good: the session shows why, or waits for a key that went missing meanwhile. */
export async function enhanceFailed(id: string, run: string, error: string): Promise<void> {
  const meta = await under(id, run);
  if (!meta) return;
  const missing = (meta.chain ?? []).filter(builtinEngine).map((e) => keyFor(meta.owner, KEY[e as BuiltinEngine]).missing).find(Boolean);
  setStatus(meta, missing ? "needs_key" : "error");
  meta.error = missing ?? error;
  meta.run = undefined;
  active.delete(id);
  await rm(finishInput(id), { force: true });
  await jobPersist(meta);
}

/** What the current pass works on: the upload, or the pass before's output. */
const stepInput = (meta: Meta) => (meta.step ? passOut(meta.id, meta.step - 1) : originalPath(meta.id));

/** The progress range of pass `step` of `n` (the last 16 % are loudness and the remux). */
export const band = (step: number, n: number): [number, number] => [0.08 + (step * 0.74) / n, 0.08 + ((step + 1) * 0.74) / n];

/** The clean sound a plug-in engine's run left, kept here for the task's last steps. */
export const finishInput = (id: string) => path.join(sesDir(id), "finish-in");

/**
 * The last steps of a plug-in engine's run: loudness to -15 LUFS and AAC (every engine's voice at one level), then the
 * video remux, made by the enhance task (work/tasks/enhance.ts, its finish mode) like a built-in run's; its result is
 * filed by enhanceFiled. `clean` is taken over at once (the engine may remove its own files when this returns). `alive`
 * = the run wasn't cancelled meanwhile.
 */
async function finish(id: string, meta: Meta, clean: string, _duration: number, alive: () => boolean): Promise<void> {
  if (!alive()) return;
  await rename(clean, finishInput(id));
  startRun(meta, { chain: meta.chain ?? [], step: meta.chain?.length ?? 0, source: !existsSync(sourceAudio(id)), finish: true });
}

/** Kill a queued/running job, the Mac's included (files stay). */
export function cancel(id: string): void {
  active.delete(id); // a late result checks the run before it is filed
  away.delete(id);
  cancelled.add(id);
  dropTask(ENHANCE_TASK, id); // a computer that holds it lets go at its next beat
  children.get(id)?.kill("SIGKILL");
  children.delete(id);
  apiCalls.get(id)?.abort();
  apiCalls.delete(id);
}

/* ---- streaming helper (same buffered-slice pattern as the project
   video route — Chrome's media stack stalls on piped web streams) ---- */

async function streamFile(
  c: { req: { header: (h: string) => string | undefined } },
  p: string,
  type: string
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

/** A new session's meta: its length, whether it has a picture and the levelled original for the A/B come with the run (work/tasks/enhance.ts). */
const newMeta = (id: string, name: string, user: SessionUser, projectId: string | null | undefined, chain: Engine[], bytes: number): Meta => ({
  id,
  name,
  owner: user.username,
  ...(projectId ? { projectId } : {}),
  hasVideo: false,
  duration: 0,
  bytes,
  status: "ready",
  engine: chain[0],
  chain,
  progress: 0,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

/** The engines `user` can run now (the built-in ones with a key, a plug-in's that doesn't refuse them). */
export const usableEngines = (user: SessionUser): string[] => allEngines().filter((e) => !refusal(e, user));

/**
 * A session made from a file on this server (the AI Editor's voice, api/editor/voice-mix.ts), run at once on `engine`: the
 * file is linked in, never copied (a hard link where the disk allows, so a cache copy cleared later stays readable). Listed
 * in the person's Audio Enhancer like an upload. Returns its id.
 */
export async function enhanceFile(user: SessionUser, name: string, file: string, engine: Engine, projectId?: string): Promise<string> {
  if (!isEngine(engine)) throw new Error(`Engine is one of ${allEngines().join(", ")}`);
  const id = randomUUID();
  await mkdir(sesDir(id), { recursive: true });
  await link(file, originalPath(id)).catch(() => symlink(path.resolve(file), originalPath(id)));
  const meta = newMeta(id, name.slice(0, 120), user, projectId, [engine], (await stat(file)).size);
  if (enqueue(meta, user)) bumpUsage(user.username, { enhanceRuns: 1 });
  await persist(meta);
  return id;
}

/** Where session `id` stands, and its levelled original and result once done (both at LOUDNESS, lined up from the file's start). */
export async function enhanceResult(id: string): Promise<{ status: EnhanceStatus | "gone"; createdAt?: number; error?: string; original?: string; enhanced?: string }> {
  const meta = okId(id) ? await readMeta(id) : null;
  if (!meta) return { status: "gone" };
  const done = meta.status === "done" && existsSync(enhancedAudio(id)) && existsSync(sourceAudio(id));
  return { status: meta.status, createdAt: meta.createdAt, ...(meta.error ? { error: meta.error } : {}), ...(done ? { original: sourceAudio(id), enhanced: enhancedAudio(id) } : {}) };
}

/* ---- routes (mounted at /api/enhance) ---- */

/* engine availability — registered before /:id so "availability" never
   matches as an id */
enhanceApp.get("/availability", async (c) => {
  const user = c.get("user");
  const why: Record<string, string | undefined> = {
    nvidia: refusal("nvidia", user) ?? undefined,
    elevenlabs: refusal("elevenlabs", user) ?? undefined,
  };
  const plugged: Record<string, unknown> = {};
  for (const e of engines.values()) {
    plugged[e.id] = !refusal(e.id, user);
    why[e.id] = refusal(e.id, user) ?? undefined;
    Object.assign(plugged, await e.availability?.(user));
  }
  return c.json({
    nvidia: !refusal("nvidia", user),
    elevenlabs: !refusal("elevenlabs", user),
    ...plugged,
    why,
    default: defaultEngine(user),
    admin: user.role === "admin", // a second pass
  });
});

/* own sessions in this workspace, newest first (admins also keep ownerless legacy ones) */
enhanceApp.get("/", async (c) => {
  const user = c.get("user");
  const keep = await inCurrentWorkspace(user);
  const metas = (await Promise.all((await sessionIds()).map(readMeta))).filter(
    (m): m is Meta =>
      !!m && (m.owner === user.username || (user.role === "admin" && !m.owner)) && (!keep || keep(m.projectId))
  );
  metas.sort((a, b) => b.createdAt - a.createdAt);
  return c.json(metas.map(publicMeta));
});

/** The run's passes (?engine=, default per user; admins ?then= a second) or why not. */
function pickChain(c: Context<{ Variables: AuthVars }>): Engine[] | { error: string } {
  const user = c.get("user");
  const [q, then] = [c.req.query("engine"), c.req.query("then") || undefined];
  for (const e of [q, then]) if (e !== undefined && !isEngine(e)) return { error: `Engine is one of ${allEngines().join(", ")}` };
  const chain = [(q as Engine | undefined) ?? defaultEngine(user), ...(then ? [then as Engine] : [])];
  if (then && user.role !== "admin") return { error: "A second pass is for admins." };
  if (then && then === chain[0]) return { error: "The second pass needs another engine." };
  return chain;
}

/* upload: raw audio/video body → session, enhanced immediately */
enhanceApp.post("/", async (c) => {
  const user = c.get("user");
  const chain = pickChain(c);
  if (!Array.isArray(chain)) return c.json(chain, 400);
  const body = c.req.raw.body;
  if (!body) return c.json({ error: "No file body" }, 400);
  const name = (c.req.query("name") || "untitled").slice(0, 120);
  const id = randomUUID();
  const dir = sesDir(id);
  const projectId = await currentWorkspaceId(user);
  try {
    await mkdir(dir, { recursive: true });
    await pipeline(Readable.fromWeb(body as never), createWriteStream(originalPath(id)));
    const st = await stat(originalPath(id));
    if (!st.size) throw new Error("Empty file");
    const meta = newMeta(id, name, user, projectId, chain, st.size);
    // enhanced in the same go — no separate "run" click
    const queued = enqueue(meta, user);
    await persist(meta);
    if (queued) bumpUsage(user.username, { enhanceRuns: 1 });
    return c.json(publicMeta(meta));
  } catch (e) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

enhanceApp.get("/:id", async (c) => {
  const meta = await ownedMeta(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  return c.json(publicMeta(meta));
});

/* re-run (after an error or a cancel), with ?engine= another engine */
enhanceApp.post("/:id/run", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const meta = await ownedMeta(id, user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  if (meta.status === "queued" || meta.status === "running") {
    return c.json({ error: "Enhancement already in progress" }, 409);
  }
  const chain = pickChain(c);
  if (!Array.isArray(chain)) return c.json(chain, 400);
  meta.engine = chain[0];
  meta.chain = chain;
  const queued = enqueue(meta, user);
  await persist(meta);
  if (queued) bumpUsage(user.username, { enhanceRuns: 1 });
  return c.json(publicMeta(meta));
});

/* A/B playback: original or enhanced audio, range-aware */
enhanceApp.get("/:id/play", async (c) => {
  const id = c.req.param("id");
  const meta = await ownedMeta(id, c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  const p = c.req.query("which") === "enhanced" ? enhancedAudio(id) : sourceAudio(id);
  if (!existsSync(p)) return c.json({ error: "Not ready" }, 409);
  return streamFile(c, p, "audio/mp4");
});

/* the strength picked on the page (the result's share against the original) */
enhanceApp.put("/:id/mix", async (c) => {
  const meta = await ownedMeta(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  const mix = Number(((await c.req.json().catch(() => null)) as { mix?: unknown } | null)?.mix);
  if (!(mix >= 0 && mix <= 1)) return c.json({ error: "mix is 0..1" }, 400);
  meta.mix = Math.round(mix * 20) / 20;
  await persist(meta);
  // made now, so the download at this strength is usually ready by the time it is pressed
  const pct = Math.round(meta.mix * 100);
  if (pct < 100 && meta.status === "done" && existsSync(enhancedAudio(meta.id)) && !fresh(meta.id, blendAudio(meta.id, pct))) {
    void startBlend(meta, pct).catch((e) => console.warn(`[enhance] blend ${meta.id}:`, e instanceof Error ? e.message : e));
  }
  return c.json(publicMeta(meta));
});

/** The blend task (work/tasks/enhance.ts): the original and the result at `pct` % result, levelled; with `ext`, the video too. */
export const BLEND_TASK = "enhance-blend";
/** `made`: the result's time, so a blend of a result a newer run replaced is not filed. */
export type BlendInput = { id: string; pct: number; ext?: "mp4" | "mkv"; made: number };

/** A blend made after the result it blends (made once per result). */
function fresh(id: string, p: string): boolean {
  const made = statSync(p, { throwIfNoEntry: false });
  return !!made && made.mtimeMs >= statSync(enhancedAudio(id)).mtimeMs;
}

/** Starts the blend at `pct` (and its video in `ext`) on a computer, or here where the server may make it. */
async function startBlend(meta: Meta, pct: number, ext?: "mp4" | "mkv") {
  // shortcut: each strength picked while no computer is online waits as its own task; drop the older ones if that piles up
  const input: BlendInput = { id: meta.id, pct, ...(ext ? { ext } : {}), made: statSync(enhancedAudio(meta.id)).mtimeMs };
  const ref = `${meta.id}:${pct}:${ext ?? "m4a"}`;
  const got = await startTask<BlendInput, null>(BLEND_TASK, ref, meta.owner ?? "", meta.projectId ?? null, input);
  // the same blend being made here already (the strength was just picked): its end is this one's
  for (let n = 0; got.state === "queued" && taskFor(BLEND_TASK, ref)?.held_by === "server" && taskFor(BLEND_TASK, ref)?.state === "running" && n < 600; n++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return got.state === "queued" && taskFor(BLEND_TASK, ref)?.state === "done" ? { state: "done" as const, result: null } : got;
}

/** The blend task's files, on the server: kept as the download at that strength, unless the result changed meanwhile. */
export async function enhanceBlended(input: BlendInput, files: Record<string, string>): Promise<void> {
  if (statSync(enhancedAudio(input.id), { throwIfNoEntry: false })?.mtimeMs !== input.made) return;
  await keep(files["blend.m4a"]!, blendAudio(input.id, input.pct));
  if (input.ext) await keep(files[`blend-video.${input.ext}`]!, blendVideo(input.id, input.pct, input.ext));
}

/* download the result, at the strength picked (?mix=, else the kept one) */
enhanceApp.get("/:id/download", async (c) => {
  const id = c.req.param("id");
  const meta = await ownedMeta(id, c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  const base = meta.name.replace(/\.[^.]+$/, "").replace(/[^\w.\- ]+/g, "").trim() || "enhanced";
  const wantVideo = c.req.query("kind") === "video";
  const q = c.req.query("mix");
  const mix = q === undefined ? (meta.mix ?? 1) : Number(q);
  if (!(mix >= 0 && mix <= 1)) return c.json({ error: "mix is 0..1" }, 400);
  const pct = Math.round(mix * 20) * 5;
  // ?ready=1: the page asks first, and gets 202 with the wait line while the blend is being made (the file is not sent)
  const ready = c.req.query("ready") === "1";
  if (pct < 100) {
    if (meta.status !== "done" || !existsSync(enhancedAudio(id))) return c.json({ error: "Not ready" }, 409);
    if (wantVideo && !meta.hasVideo) return c.json({ error: "This file has no video" }, 409);
    const video = wantVideo ? (meta.videoOutExt ?? "mp4") : undefined;
    const p = video ? blendVideo(id, pct, video) : blendAudio(id, pct);
    if (!fresh(id, p)) {
      try {
        const got = await startBlend(meta, pct, video);
        if (got.state === "queued") return c.json({ ready: false, ...(got.line ? { line: got.line } : {}) }, 202);
      } catch (e) {
        return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
      }
    }
    if (ready) return c.json({ ready: true });
    const ext = video ?? "m4a";
    const type = !video ? "audio/mp4" : video === "mp4" ? "video/mp4" : "video/x-matroska";
    const st = await stat(p);
    return new Response(Readable.toWeb(createReadStream(p)) as unknown as ReadableStream, {
      headers: {
        "Content-Type": type,
        "Content-Length": String(st.size),
        "Content-Disposition": `attachment; filename="${base}-enhanced-${pct}.${ext}"`,
      },
    });
  }
  if (wantVideo) {
    if (!meta.videoOutExt || !existsSync(enhancedVideo(id, meta.videoOutExt))) {
      return c.json({ error: "No enhanced video for this file" }, 409);
    }
    if (ready) return c.json({ ready: true });
    const p = enhancedVideo(id, meta.videoOutExt);
    const st = await stat(p);
    return new Response(
      Readable.toWeb(createReadStream(p)) as unknown as ReadableStream,
      {
        headers: {
          "Content-Type": meta.videoOutExt === "mp4" ? "video/mp4" : "video/x-matroska",
          "Content-Length": String(st.size),
          "Content-Disposition": `attachment; filename="${base}-enhanced.${meta.videoOutExt}"`,
        },
      }
    );
  }
  const p = enhancedAudio(id);
  if (!existsSync(p)) return c.json({ error: "Not ready" }, 409);
  if (ready) return c.json({ ready: true });
  const st = await stat(p);
  return new Response(
    Readable.toWeb(createReadStream(p)) as unknown as ReadableStream,
    {
      headers: {
        "Content-Type": "audio/mp4",
        "Content-Length": String(st.size),
        "Content-Disposition": `attachment; filename="${base}-enhanced.m4a"`,
      },
    }
  );
});

/* stop a queued/running job but keep the session (and any previous
   result — .part outputs never touched the real files); a job the Mac
   holds is let go, its late answer refused */
enhanceApp.post("/:id/cancel", async (c) => {
  const id = c.req.param("id");
  const meta = await ownedMeta(id, c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  if (meta.status === "queued" || meta.status === "running") {
    cancel(id);
    setStatus(meta, existsSync(enhancedAudio(id)) ? "done" : "ready");
    meta.progress = 0;
    meta.error = undefined;
    await persist(meta);
  }
  return c.json(publicMeta(meta));
});

/* cancel a running job / delete the whole session */
enhanceApp.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const meta = await ownedMeta(id, c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  cancel(id);
  await rm(sesDir(id), { recursive: true, force: true });
  return c.json({ ok: true });
});

/** What a plug-in engine may use from this module: its passes take their input and hand each result back through these. */
export type EnhanceHost = {
  readMeta: typeof readMeta;
  sessionIds: typeof sessionIds;
  persist: typeof persist;
  setStatus: typeof setStatus;
  finish: typeof finish;
  startStep: typeof startStep;
  band: typeof band;
  stepInput: typeof stepInput;
  passOut: typeof passOut;
  runStep: typeof runStep;
  sesDir: typeof sesDir;
  active: typeof active;
  cancelled: typeof cancelled;
  streamFile: typeof streamFile;
  /** The sample rate the engines take (NVIDIA's). */
  sampleRate: number;
};
export const enhanceHost: EnhanceHost = {
  readMeta, sessionIds, persist, setStatus, finish, startStep, band, stepInput, passOut, runStep, sesDir, active, cancelled,
  streamFile, sampleRate: NV_SR,
};
