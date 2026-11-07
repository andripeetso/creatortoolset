import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Sentence } from "../../contracts/editor";
import { ffmpegCommand } from "../ffmpeg-runtime";
import { env } from "../lib/env";
import { blobs, libraryDb } from "../library/db";
import { enqueueJob } from "../library/jobs";
import { ffmpegSlot } from "../library/media/run";
import type { ProbeSummary } from "../library/media/probe";
import { transcribeRoute, wordsOf, type TimedWord } from "../library/transcribe";
import { saveStep } from "./store";
import type { StepContext } from "./worker";

/**
 * The AI Editor's analyze step: every source's words (the library's transcript, fillers and false starts kept) split
 * into sentences numbered across the footage in recording order, and each source's loudness at 100 reads a second,
 * cached by version for the cut. A source with no words yet queues the library's `transcribe` as the edit's creator,
 * on their key, and the step waits.
 */

/** The step waits on other work: the worker puts it back in the queue after `seconds`, the attempt not counted. */
export class Waiting extends Error {
  constructor(readonly seconds = 30) {
    super("Waiting");
  }
}

/** A pause this long (seconds) ends a sentence, as does a word ending in . ? or ! */
export const SENTENCE_GAP_S = 0.7;
export const ENERGY_PER_SECOND = 100;
const RATE = 8000;
const PER_READ = RATE / ENERGY_PER_SECOND;

/** One source's words as sentences, numbered from `first`. */
export function sentencesOf(words: TimedWord[], src: string, first: number): Sentence[] {
  const out: Sentence[] = [];
  let w0 = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const next = words[i + 1];
    if (next && next.s - w.e < SENTENCE_GAP_S && !/[.?!]["')\]]*$/.test(w.w)) continue;
    out.push({
      n: first + out.length,
      src,
      text: words.slice(w0, i + 1).map((x) => x.w).join(" "),
      s: words[w0]!.s,
      e: w.e,
      w0,
      w1: i,
    });
    w0 = i + 1;
  }
  return out;
}

// ponytail: kept by version id, never purged (about 1.4 MB an hour of footage); drop it with the version when that matters
export const energyFile = (versionId: string) => path.join(env.dataDir, "editor", "cache", `${versionId}.energy.f32`);

/** RMS loudness 0..1 of the first audio stream, ENERGY_PER_SECOND reads a second. Runs in the server's ffmpeg limit. */
export function readEnergy(src: string, signal?: AbortSignal): Promise<Float32Array> {
  return ffmpegSlot(
    () =>
      new Promise((resolve, reject) => {
        const p = spawn(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", src, "-vn", "-ac", "1", "-ar", String(RATE), "-f", "s16le", "pipe:1"], {
          signal,
        });
        const out: number[] = [];
        let carry = Buffer.alloc(0);
        let sum = 0;
        let count = 0;
        let err = "";
        p.stdout.on("data", (d: Buffer) => {
          const buf = Buffer.concat([carry, d]);
          const whole = buf.length - (buf.length % 2);
          for (let i = 0; i < whole; i += 2) {
            const x = buf.readInt16LE(i) / 32768;
            sum += x * x;
            if (++count === PER_READ) {
              out.push(Math.sqrt(sum / count));
              sum = 0;
              count = 0;
            }
          }
          carry = buf.subarray(whole);
        });
        p.stderr.on("data", (d) => (err = (err + d.toString()).slice(-2000)));
        p.on("error", reject);
        p.on("close", (code) => {
          if (code !== 0) return reject(new Error(err.trim() || `ffmpeg exited ${code}`));
          if (count) out.push(Math.sqrt(sum / count));
          resolve(Float32Array.from(out));
        });
      }),
  );
}

/** A version's energy from the cache, read once and kept (it depends only on the file). */
export async function energyOf(versionId: string, src: () => Promise<string>, signal?: AbortSignal): Promise<Float32Array> {
  const file = energyFile(versionId);
  try {
    const b = await readFile(file);
    return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  } catch {
    /* not cached yet */
  }
  const e = await readEnergy(await src(), signal);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.part`, e);
  await rename(`${file}.part`, file);
  return e;
}

interface SourceRow {
  id: string;
  library_id: string;
  source_key: string;
  probe: string | null;
  state: string;
  title: string;
}

export async function analyzeStep({ edit, signal }: StepContext): Promise<void> {
  const db = libraryDb();
  const rows = edit.sources.map(
    (id) =>
      db
        .prepare(
          `SELECT v.id, a.library_id, v.source_key, v.probe, v.state, a.title FROM asset_versions v
           JOIN assets a ON a.id = v.asset_id WHERE v.id = ?`,
        )
        .get(id) as unknown as SourceRow,
  );
  const notes: string[] = [];
  const ready: { row: SourceRow; probe: ProbeSummary; words: TimedWord[] }[] = [];
  let wait = false;
  for (const row of rows) {
    const probe = JSON.parse(row.probe ?? "null") as ProbeSummary | null;
    if (!probe) {
      if (row.state === "failed") throw new Error(`“${row.title}” could not be read by the library`);
      wait = true; // the library probes it first, then queues its transcript
      continue;
    }
    if (!probe.acodec) {
      notes.push(`“${row.title}” has no sound: left out`);
      continue;
    }
    const words = wordsOf(db, row.id);
    if (words) {
      ready.push({ row, probe, words });
      continue;
    }
    const job = db.prepare("SELECT state, error, actor FROM jobs WHERE version_id = ? AND kind = 'transcribe'").get(row.id) as
      | { state: string; error: string | null; actor: string | null }
      | undefined;
    if (job?.state === "queued" || job?.state === "running") wait = true;
    else if (job?.state === "failed") throw new Error(`Transcribing “${row.title}” failed (${job.error ?? "no reason given"}): retry it in the Media Library`);
    else {
      // parked for the creator: still no key throws NeedsKey with what to add; a key added since queues it again
      if (job?.state === "needs_key" && job.actor === edit.createdBy) transcribeRoute(edit.createdBy);
      // none yet, done before word timings were kept, or parked for someone else: transcribe as the edit's creator
      enqueueJob(db, row.library_id, row.id, "transcribe", edit.createdBy, true);
      wait = true;
    }
  }
  if (wait) throw new Waiting();

  ready.sort((a, b) => (a.probe.capturedAt ?? Infinity) - (b.probe.capturedAt ?? Infinity) || a.row.title.localeCompare(b.row.title));
  const sentences: Sentence[] = [];
  for (const { row, words } of ready) {
    if (signal.aborted) return;
    await energyOf(row.id, () => blobs.localCopy(row.source_key), signal);
    sentences.push(...sentencesOf(words, row.id, sentences.length + 1));
  }
  if (!sentences.length) throw new Error("No speech found in the footage");
  await saveStep(edit.id, "analysis", { sentences, notes });
}
