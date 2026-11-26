import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { rename, rm } from "node:fs/promises";
import path from "node:path";
import { ffmpegCommand } from "../../ffmpeg-runtime";

/** The abort signal of the job a call runs for (withSignal): every process spawnKillable starts under it dies with it. */
const jobSignal = new AsyncLocalStorage<AbortSignal>();
/** Runs `work` with `signal` as its job's: a process it starts (ffmpeg, ffprobe) is killed when the signal aborts. */
export const withSignal = <T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> => jobSignal.run(signal, work);

/** The processes spawnKillable started that are still alive. */
const alive = new Set<ChildProcessWithoutNullStreams>();
const KILL_AFTER_MS = 5000;

/**
 * spawn() for a media process: when the job's signal (withSignal) aborts, it gets SIGTERM, then SIGKILL after 5 s.
 * Throws at once when the signal already aborted, so a job taken back between two steps starts no next one.
 */
export function spawnKillable(cmd: string, args: string[]): ChildProcessWithoutNullStreams {
  const signal = jobSignal.getStore();
  signal?.throwIfAborted();
  const p = spawn(cmd, args);
  alive.add(p);
  const kill = () => {
    p.kill("SIGTERM");
    setTimeout(() => p.exitCode === null && p.signalCode === null && p.kill("SIGKILL"), KILL_AFTER_MS).unref();
  };
  signal?.addEventListener("abort", kill, { once: true });
  p.once("close", () => {
    alive.delete(p);
    signal?.removeEventListener("abort", kill);
  });
  return p;
}

/** Kills every process spawnKillable started that is still alive, at once (this process is about to exit). */
export function killProcesses(): void {
  for (const p of alive) p.kill("SIGKILL");
}

/** Waits until every process spawnKillable started has ended, or `ms` passed; true when none is left. */
export async function processesGone(ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; alive.size && Date.now() < end; ) await new Promise((r) => setTimeout(r, 50));
  return alive.size === 0;
}

// One ffmpeg at a time server-wide (FFMPEG_CONCURRENCY, default 1): the library and the AI Editor both run through here.
let running = 0;
const waiting: (() => void)[] = [];
const limit = () => Math.max(1, Number(process.env.FFMPEG_CONCURRENCY) || 1);
// a few seconds' work a person waits to see has a line of its own, one at a time: a long run that already started (a
// 46-minute clip's transcript on this computer, a 4K proxy) held the one slot for minutes and every card waited for its picture
let quick = 0;
const quickWaiting: (() => void)[] = [];

/**
 * Runs `work` (one ffmpeg process) in the server-wide limit; for a caller that spawns ffmpeg itself to read its output.
 * `soon`: a few seconds' work a person waits to see (a clip's picture) runs in its own line of one, never behind a long run.
 */
export async function ffmpegSlot<T>(work: () => Promise<T>, soon = false): Promise<T> {
  if (soon) {
    if (quick < 1) quick++;
    else await new Promise<void>((r) => quickWaiting.push(r));
    try {
      return await work();
    } finally {
      const next = quickWaiting.shift();
      if (next) next();
      else quick--;
    }
  }
  if (running < limit()) running++;
  else await new Promise<void>((r) => waiting.push(r)); // the releasing run hands its slot over: `running` stays counted
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
}

/** One ffmpeg run; stderr's tail is the error. Callers pass the arguments after the global flags. */
export function ffmpeg(args: string[], soon = false): Promise<void> {
  return ffmpegSlot(() => run(args), soon);
}

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawnKillable(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args]);
    let err = "";
    p.stderr.on("data", (d) => (err = (err + d.toString()).slice(-2000)));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `ffmpeg exited ${code}`))));
  });
}

/** Writes a derivative under its final name only when complete: a temp file, then a rename over the old one. */
export async function atomically(out: string, write: (tmp: string) => Promise<void>): Promise<void> {
  const tmp = `${out}.part${path.extname(out)}`; // the extension keeps ffmpeg's muxer guess right
  try {
    await write(tmp);
    await rename(tmp, out);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** ffmpeg writes `out` through a temp file (see atomically). `args` are the inputs and options, without the output. */
export function ffmpegTo(out: string, args: string[], soon = false): Promise<void> {
  return atomically(out, (tmp) => ffmpeg([...args, tmp], soon));
}

/** A JSON file written whole or not at all. Its temp name is its own: two writers of one file at once (two computers'
 *  results for one edit, api/work/result.ts) never rename each other's temp away. */
export { writeJsonAtomic } from "../../lib/write-json";
