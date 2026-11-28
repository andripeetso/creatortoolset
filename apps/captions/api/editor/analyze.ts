import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Sentence } from "../../contracts/editor";
import { languageCode } from "../../contracts/voice";
import { LoudnessMeter } from "../../src/lib/nle/loudness";
import { ffmpegCommand } from "../ffmpeg-runtime";
import { deviceStatus } from "../lib/device-transcribe";
import { env } from "../lib/env";
import { libraryDb } from "../library/db";
import { enqueueJob, prepareFirst } from "../library/jobs";
import { ffmpegSlot } from "../library/media/run";
import type { ProbeSummary } from "../library/media/probe";
import { askVersionIn, editorKey, editorRoute, heardForEditor, versionRoute, wordsOf, type TimedWord } from "../library/transcribe";
import { eyelineOf } from "./eyeline";
import { measurable } from "./media";
import { allBroll, isMusic } from "./plan";
import { ownerOf, readStep, saveStep, type EditMeta } from "./store";
import { videoLanguages } from "../lib/video-languages";
import { matchPair, pairsToTry, rollsOf, voiceChannel, type PairMatch, type PairSource } from "./sync";
import type { StepContext } from "./worker";
import { gateOf, onComputer } from "../work/on-computer";

/**
 * The AI Editor's analyze step: every source's words (the library's transcript, fillers and false starts kept) split
 * into sentences numbered across the footage in recording order, and each source's loudness at 100 reads a second,
 * cached by version for the cut, and its eye line where this computer finds one (eyeline.ts). A source with no words yet queues the library's `transcribe` as the edit's creator,
 * on their key, and the step waits. A song is never transcribed, and an edit that is planned anyway (asked for, or all
 * its footage is B-roll: plan.ts) waits on no transcript: it takes the words there are. Footage where nobody speaks is
 * not refused: the script step plans it.
 */

/**
 * The step waits on other work: the worker puts it back in the queue after `seconds`, the attempt not counted. `line`
 * says what it waits for, beside the step ("Waiting for the Media Library: 3 of 12 files").
 */
export class Waiting extends Error {
  constructor(
    readonly seconds = 30,
    readonly line?: string,
  ) {
    super("Waiting");
  }
}

/** Said when the footage has no words: it is planned from the brief (plan.ts), never refused. */
export const NO_SPEECH = "No speech found in the footage: it is cut to the song or the brief";

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

/**
 * RMS loudness 0..1 of the first audio stream, ENERGY_PER_SECOND reads a second. A two-channel recorder file reads
 * its voice channel alone (sync.voiceChannel), never the mix of two mics. Runs in the server's ffmpeg limit.
 */
export async function readEnergy(src: string, signal?: AbortSignal): Promise<Float32Array> {
  const channel = await voiceChannel(src, signal);
  const mono = channel === null ? ["-ac", "1"] : ["-af", `pan=mono|c0=c${channel}`];
  return ffmpegSlot(
    () =>
      new Promise((resolve, reject) => {
        const p = spawn(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", src, "-vn", ...mono, "-ar", String(RATE), "-f", "s16le", "pipe:1"], {
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

/**
 * The editor's Normalize and Lower Under Voice measure (src/lib/nle/loudness.ts): a version's sound decoded whole at
 * 48 kHz in stereo (a mono file as dual mono, as it plays and renders) through the player's own BS.1770 meter, each
 * 400 ms block's energy, 10 a second. Run only by the nle-loudness computer task (work/tasks/loudness.ts), which
 * mayRunHere places; kept per version in the editor cache, as the energy is.
 */
export const LOUDNESS_TASK = "nle-loudness";
export const loudFile = (versionId: string) => path.join(env.dataDir, "editor", "cache", `${versionId}.loud.f32`);
const LOUD_RATE = 48000;

/** A version's measured blocks from the cache, or null when it was never measured. */
export async function readLoud(versionId: string): Promise<Float32Array | null> {
  try {
    const b = await readFile(loudFile(versionId));
    return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  } catch {
    return null;
  }
}

/** Each 400 ms block's energy of `src`'s first sound stream. */
export function measureLoud(src: string, signal?: AbortSignal): Promise<Float32Array> {
  return ffmpegSlot(
    () =>
      new Promise((resolve, reject) => {
        const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", src, "-vn", "-map", "0:a:0", "-ac", "2", "-ar", String(LOUD_RATE), "-f", "f32le", "pipe:1"];
        const p = spawn(ffmpegCommand(), args, { signal });
        const meter = new LoudnessMeter(LOUD_RATE, 2, { truePeak: false });
        const blocks: number[] = [];
        meter.onBlock = (e) => blocks.push(e);
        let carry = Buffer.alloc(0);
        let err = "";
        p.stdout.on("data", (d: Buffer) => {
          const buf = carry.length ? Buffer.concat([carry, d]) : d;
          const frames = Math.floor(buf.length / 8);
          const l = new Float32Array(frames), r = new Float32Array(frames);
          for (let i = 0; i < frames; i++) (l[i] = buf.readFloatLE(i * 8)), (r[i] = buf.readFloatLE(i * 8 + 4));
          meter.process([l, r]);
          carry = Buffer.from(buf.subarray(frames * 8));
        });
        p.stderr.on("data", (d) => (err = (err + d.toString()).slice(-2000)));
        p.on("error", reject);
        p.on("close", (code) => (code === 0 ? resolve(Float32Array.from(blocks)) : reject(new Error(err.trim() || `ffmpeg exited ${code}`))));
      }),
  );
}

/** Keeps a version's measured blocks in the cache. */
export async function keepLoud(versionId: string, blocks: ArrayLike<number>): Promise<void> {
  const f = loudFile(versionId);
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(`${f}.part`, Float32Array.from(blocks));
  await rename(`${f}.part`, f);
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

/** Versions heard again in an edit's own languages ("<version>|<languages>"): each is asked once, not on every look. */
const askedAgain = new Set<string>();

/**
 * A version transcribed on another engine than the AI Editor row's own choice now gives (editorRoute): the key it is
 * heard again by (once: heardForEditor), or null. The row on "Same as default": null, the transcript stays.
 */
function editorWantsAgain(db: ReturnType<typeof libraryDb>, versionId: string, by: string, languages?: string[]): string | null {
  const want = editorRoute(by, languages);
  if (!want) return null;
  const t = db.prepare("SELECT provider, model FROM transcripts WHERE version_id = ?").get(versionId) as { provider: string; model: string | null } | undefined;
  if (t?.provider === want.provider && (want.provider !== "computer" || t.model === want.model)) return null;
  return editorKey(versionId, want);
}

/** What the analyze gate hands the step's work: the sources ready to read, and what it noted of the rest. */
export interface AnalyzeGate {
  planned: boolean;
  notes: string[];
  ready: { row: SourceRow; probe: ProbeSummary; words: TimedWord[] }[];
}

export async function analyzeStep(ctx: StepContext): Promise<void> {
  // on a computer the server ran the gate when it handed the step over (work/on-computer.ts)
  await analyzeWork(ctx, onComputer.on ? gateOf<AnalyzeGate>() : await analyzeGate(ctx));
}

/**
 * The analyze step's gate: what the server's library and its memory say about each source (probe, transcripts, the
 * transcripts it queues and waits for). Throws Waiting while one is not ready. Runs on the server only, also for a step a
 * computer takes (its claim runs it).
 */
export async function analyzeGate({ edit, job }: Pick<StepContext, "edit" | "job">): Promise<AnalyzeGate> {
  const db = libraryDb();
  // transcripts the edit waits for are heard on the keys of whoever asked for this run (a teammate's next version: theirs)
  const asker = job.actor ?? edit.createdBy;
  const rows = edit.sources.map(
    (id) =>
      db
        .prepare(
          `SELECT v.id, a.library_id, v.source_key, v.probe, v.state, a.title FROM asset_versions v
           JOIN assets a ON a.id = v.asset_id WHERE v.id = ?`,
        )
        .get(id) as unknown as SourceRow,
  );
  // the edit's own language, else its workspace's (Settings → Workspace → Details); neither: the asker's own list
  const explicitLang = !!edit.languages?.length;
  const spoken = explicitLang ? edit.languages : await videoLanguages(ownerOf(edit), edit.projectId);
  const notes: string[] = [];
  const planned = !!edit.plan || allBroll(edit);
  const ready: { row: SourceRow; probe: ProbeSummary; words: TimedWord[] }[] = [];
  let wait = false;
  let waitingOn: string | undefined;
  const transcribeState = db.prepare("SELECT state, error, actor FROM jobs WHERE version_id = ? AND kind = 'transcribe'");
  const waitTranscribe = (row: SourceRow, alwaysQueue: boolean): boolean => {
    const t = transcribeState.get(row.id) as { state: string; error: string | null; actor: string | null } | undefined;
    if (t?.state === "queued" || t?.state === "running") {
      wait = true;
      waitingOn = deviceStatus(row.id) ?? waitingOn;
      return true;
    }
    if (t?.state === "failed") throw new Error(`Could not transcribe “${row.title}” (${t.error ?? "no reason given"}): retry it in the Media Library`);
    if (t?.state === "needs_key" || alwaysQueue) {
      // parked for the creator: still no key throws NeedsKey with what to add; a key added since queues it again
      if (t?.state === "needs_key" && t.actor === asker) versionRoute(asker, row.id);
      enqueueJob(db, row.library_id, row.id, "transcribe", asker, true);
      prepareFirst(row.id);
      wait = true;
      return true;
    }
    return false;
  };
  for (const row of rows) {
    const probe = JSON.parse(row.probe ?? "null") as ProbeSummary | null;
    if (!probe) {
      // a file the library could not read is left out and named; the cut is made from the rest
      if (row.state === "failed") notes.push(`“${row.title}” could not be read by the Media Library: left out`);
      // the library probes it first, then queues its transcript; a planned edit told to cut now goes without it
      else if (!(planned && edit.now)) wait = true;
      continue;
    }
    // a song is what the edit is cut to, not words (plan.ts)
    if (row.id === edit.song || isMusic(row.id)) continue;
    if (!probe.acodec) {
      notes.push(`“${row.title}” has no sound: left out`);
      continue;
    }
    if (planned) {
      const words = wordsOf(db, row.id);
      if (words?.length) ready.push({ row, probe, words });
      continue;
    }
    const languages = spoken;
    askVersionIn.set(row.id, { by: asker, ...(languages ? { languages } : {}) });
    const words = wordsOf(db, row.id);
    const storedLang = words
      ? languageCode((db.prepare("SELECT language FROM transcripts WHERE version_id = ?").get(row.id) as { language: string | null } | undefined)?.language)
      : null;
    // a take heard as silence is heard once more in `languages`; a non-empty transcript is only re-transcribed for language mismatch when the edit explicitly named its languages
    if (words && languages && (!words.length || (explicitLang && storedLang !== null && !languages.includes(storedLang)))) {
      const again = `${row.id}|${languages.join(",")}`;
      if (!askedAgain.has(again)) {
        askedAgain.add(again);
        enqueueJob(db, row.library_id, row.id, "transcribe", asker, true);
        prepareFirst(row.id);
        wait = true;
        continue;
      }
      if (waitTranscribe(row, false)) continue;
    }
    // one made on another engine than the AI Editor row's own choice is heard once more by that engine; it becomes
    // the clip's library transcript too (transcribeVersion)
    const redo = words ? editorWantsAgain(db, row.id, asker, languages) : null;
    if (redo) {
      if (!heardForEditor.has(redo)) {
        heardForEditor.add(redo);
        enqueueJob(db, row.library_id, row.id, "transcribe", asker, true);
        prepareFirst(row.id);
        wait = true;
        continue;
      }
      if (waitTranscribe(row, false)) continue;
    }
    if (words) {
      askVersionIn.delete(row.id);
      ready.push({ row, probe, words });
      continue;
    }
    prepareFirst(row.id); // the edit waits on its transcript: before the library's other clips
    waitTranscribe(row, true);
  }
  // a transcript being made on this computer: the step says what it is doing while it waits (the worker clears it when the step is done)
  if (wait && waitingOn) db.prepare("UPDATE edit_jobs SET error = ? WHERE id = ?").run(waitingOn, job.id);
  if (wait) throw new Waiting();
  return { planned, notes, ready };
}

/** The analyze step's work after its gate: sentences, loudness and eye line of the ready sources, saved as the analysis. */
async function analyzeWork({ edit, signal }: StepContext, { planned, notes, ready }: AnalyzeGate): Promise<void> {
  ready.sort((a, b) => (a.probe.capturedAt ?? Infinity) - (b.probe.capturedAt ?? Infinity) || a.row.title.localeCompare(b.row.title));
  // a separate mic and a second camera of one take: found by their sound (sync.ts), their own words no takes of their own
  const pairs = planned ? {} : await pairUp(ready, readStep(edit.id, "analysis")?.pairs ?? {}, signal);
  const { rolls, under } = rollsOf(ready.map((r) => pairSource(r.row.id, r.probe)), pairs);
  if (signal.aborted) return;
  const title = (id: string) => ready.find((r) => r.row.id === id)?.row.title ?? id;
  for (const [cam, r] of Object.entries(rolls)) {
    if (r.mic) notes.push(`“${title(r.mic.id)}” is the sound of “${title(cam)}”: it plays under its picture`);
    for (const a of r.angles ?? []) notes.push(`“${title(a.id)}” is a second camera on “${title(cam)}”: every other line plays on it`);
  }
  const sentences: Sentence[] = [];
  const eyeline: Record<string, number> = {};
  for (const { row, probe, words } of ready) {
    if (signal.aborted) return;
    if (!under.has(row.id)) sentences.push(...sentencesOf(words, row.id, sentences.length + 1));
    if (planned) continue; // the cut's loudness and eye line are for cutting around speech
    await energyOf(row.id, () => measurable(row.id, row.source_key), signal);
    const turned = probe.rotation === 90 || probe.rotation === 270;
    const dims = { w: turned ? probe.height : probe.width, h: turned ? probe.width : probe.height, duration: probe.duration };
    const y = probe.vcodec ? await eyelineOf(row.id, () => measurable(row.id, row.source_key), dims, signal) : null;
    if (y !== null) eyeline[row.id] = y;
  }
  if (!sentences.length && !planned)
    notes.push(edit.languages?.length ? NO_SPEECH : `${NO_SPEECH}. If someone does speak in it, pick the language on the edit and run it again`);
  await saveStep(edit.id, "analysis", { sentences, notes, ...(Object.keys(eyeline).length ? { eyeline } : {}), ...(Object.keys(rolls).length ? { rolls } : {}), ...(Object.keys(pairs).length ? { pairs } : {}) });
}

/** A source as pairing reads it (sync.ts PairSource). */
export const pairSource = (id: string, probe: ProbeSummary): PairSource => ({ id, picture: !!probe.vcodec && !probe.cover, duration: probe.duration, ...(probe.capturedAt !== undefined ? { capturedAt: probe.capturedAt } : {}) });

/**
 * Every pair of the ready sources worth comparing by sound, compared (sync.ts pairsToTry): `kept`, the last analysis's,
 * are not compared again. Kept in the analysis, so a run on a computer brings them back with it.
 */
async function pairUp(ready: AnalyzeGate["ready"], kept: Record<string, PairMatch | null>, signal: AbortSignal): Promise<Record<string, PairMatch | null>> {
  const file = (id: string) => measurable(id, ready.find((r) => r.row.id === id)!.row.source_key);
  const out: Record<string, PairMatch | null> = {};
  for (const [a, b] of pairsToTry(ready.map((r) => pairSource(r.row.id, r.probe)))) {
    const key = `${a}~${b}`;
    if (key in kept) out[key] = kept[key]!;
    if (key in kept || signal.aborted) continue;
    // a pair that can't be compared now (a file not on this computer) is left for the next run, the cut made without it
    const m = await matchPair(await file(a), await file(b), signal).then((x) => ({ x }), () => null);
    if (m) out[key] = m.x;
  }
  return out;
}

/** The pairs of an edit's sources still to compare by sound (none in its analysis yet): engine.ts places analyze on a computer for them. */
export function pairsLeft(edit: Pick<EditMeta, "id" | "sources" | "song">): [string, string][] {
  const done = readStep(edit.id, "analysis")?.pairs ?? {};
  const read = libraryDb().prepare("SELECT probe FROM asset_versions WHERE id = ?");
  const srcs = edit.sources.filter((id) => id !== edit.song && !isMusic(id)).flatMap((id) => {
    const p = JSON.parse((read.get(id) as { probe: string | null } | undefined)?.probe ?? "null") as ProbeSummary | null;
    return p?.acodec ? [pairSource(id, p)] : [];
  });
  return pairsToTry(srcs).filter(([a, b]) => !(`${a}~${b}` in done));
}
