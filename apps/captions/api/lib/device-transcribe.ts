import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { spokenLanguage } from "../../src/workers/spoken-language";
import { hfApp } from "../hfproxy";
import { ffmpegSlot } from "../library/media/run";
import { env, hostedMode } from "./env";

/**
 * Transcripts made on the person's own computer, for the tools that otherwise need a transcription key: the model
 * Caption Studio runs in the browser, run by the server itself. Only a server on its owner's computer does this
 * (the desktop app's own server, CT_LOCAL=1, and never a hosted one): a hosted server keeps asking for a key. A
 * key, when there is one, always goes first (library/transcribe.ts transcribeRoute): this is slower and free.
 * The model tidies speech: said twice, written once. So its words are checked against the sound, and what it left
 * out is heard again (relisten).
 */

/** Caption Studio's first model (src/lib/transcribe.ts MODELS[0]), so one download serves both: it hears every language. */
const MODEL = "Xenova/whisper-base";
const MODEL_MB = 291;
export const GETTING_MODEL = `Getting the speech model ready (${MODEL_MB} MB, only the first time)`;
export const LISTENING = "Listening to your video";
/** Kept with the person's data, never beside the server's own files (the library's default), which are part of a signed app. */
export const modelsDir = () => path.join(env.dataDir, "models");

/** What a caller's ffmpeg writes for `transcribeOnDevice`: 16 kHz mono 32-bit float samples, no header. */
export const DEVICE_AUDIO = ["-vn", "-ac", "1", "-ar", "16000", "-f", "f32le"];

/** Whether this server transcribes by itself: one person's own computer, never a hosted server. */
export const deviceTranscribes = (): boolean => process.env.CT_LOCAL === "1" && !hostedMode();

export interface DeviceWord {
  text: string;
  start: number;
  end: number;
}

type Chunk = { text: string; timestamp: [number, number | null] };
/** The loaded model, as the library gives it: called with samples, closed when the run is over. */
type Transcriber = ((pcm: Float32Array, options: Record<string, unknown>) => Promise<{ chunks?: Chunk[] }>) & { dispose(): Promise<unknown> };

// the one run in progress (they never overlap, see transcribeOnDevice) and what it is doing, for whoever shows it
let current: { key: string; text: string } | null = null;

/** What the transcript `key` names (a library version, a clip) is doing right now, in words for its owner; undefined when it is not running here. */
export const deviceStatus = (key: string): string | undefined => (current?.key === key ? current.text : undefined);

// the speech model and search by meaning's (device-embed.ts) never sit in memory side by side: together they took
// 2.9 GB against 2.1 GB for the speech model alone (measured), so the other one is given back before a transcript
let speaking = false;
let freeOther: () => Promise<void> = async () => {};
/** Whether the speech model is in memory now. */
export const speechModelInUse = (): boolean => speaking;
/** `free` gives the other model back (and waits for a run of it to end): called before the speech model loads. */
export const beforeSpeechModel = (free: () => Promise<void>): void => void (freeOther = free);

const half = (c: Chunk) => Math.floor(c.timestamp[0] / 30);
const noLength = (c: Chunk) => (c.timestamp[1] ?? c.timestamp[0]) - c.timestamp[0] <= 0.05;

/**
 * The model's words with their times, in order: a word with no end gets a quarter second, as in Caption Studio.
 * Over music, noise or silence the model makes words up, and those it cannot place: so a word put after the audio's
 * end (`seconds`) is left out, and so is a half minute where most words have no length (measured: 9 in 10 of the
 * made-up ones, 1 in 20 at most in speech).
 * ponytail: a stray word or two over plain noise still gets through; listen for a voice first if B-roll transcripts matter.
 */
export function wordsOf(chunks: Chunk[], seconds = Infinity): DeviceWord[] {
  const heard = chunks.filter((c) => c.text.trim() && c.timestamp[0] < seconds);
  const count = new Map<number, { all: number; unplaced: number }>();
  for (const c of heard) {
    const n = count.get(half(c)) ?? { all: 0, unplaced: 0 };
    count.set(half(c), { all: n.all + 1, unplaced: n.unplaced + (noLength(c) ? 1 : 0) });
  }
  return heard
    .filter((c) => count.get(half(c))!.unplaced * 2 <= count.get(half(c))!.all)
    .map((c) => ({ text: c.text.trim(), start: Math.max(0, c.timestamp[0]), end: Math.max(c.timestamp[0] + 0.05, c.timestamp[1] ?? c.timestamp[0] + 0.25) }))
    .sort((x, y) => x.start - y.start); // where two 30 s windows meet, a word can come back a moment early
}

/**
 * What the second listen goes by: seconds, and loudness as a share of the loud level where words were heard (the AI
 * Editor's cut uses the same share). Measured on 33 recordings full of retakes, all from one shoot (one voice, one
 * microphone, one room: 15 minutes, 2,032 words by a second transcriber): the first listen left out 244 of them and
 * the second listen 122, with 25 more words that are not in the second transcript (misheard ones). That stays at 120
 * to 124 for a threshold of 0.1 to 0.2, a pause of 0.15 to 0.3 and an opening of 0.3 to 0.6; a long word of 1.5 gives
 * 135. 23 of the 33 came out exactly as the first listen wrote them. Re-measure on real recordings before changing.
 */
export const RELISTEN = {
  threshold: 0.15,
  /** quiet this long ends a stretch of speech */
  pauseS: 0.2,
  /** a stretch of speech that opens with this much before its first word has words missing */
  openingS: 0.4,
  /** a word that holds more speech than this holds other words too */
  longS: 1,
  /** a stretch is heard with this much of the quiet around it */
  padS: 0.15,
};
const RATE = 16000;
const READS = 100;

/** Loudness READS times a second, as a share of the 90th percentile of the reads inside `words`. */
function loudness(pcm: Float32Array, words: DeviceWord[]): Float32Array {
  const per = RATE / READS;
  const e = new Float32Array(Math.floor(pcm.length / per));
  for (let i = 0; i < e.length; i++) {
    let sum = 0;
    for (let k = i * per; k < (i + 1) * per; k++) sum += pcm[k]! * pcm[k]!;
    e[i] = Math.sqrt(sum / per);
  }
  const spoken = Float32Array.from(words.flatMap((w) => [...e.subarray(Math.round(w.start * READS), Math.round(w.end * READS))])).sort();
  const level = spoken[Math.floor(spoken.length * 0.9)] || 1;
  return e.map((x) => x / level);
}

/**
 * The first listen checked against the sound, and what it left out heard again. The model writes a phrase that was
 * said twice once, and drops a false start or an attempt the speaker gave up; its word times then give it away: the
 * speech after a pause opens with no word of its own (the word before runs on across the pause), or one word holds
 * seconds of speech. Each such stretch is heard again alone (`hear`: its words, in the recording's seconds), where the
 * model has nothing else to write, and the words the first listen does not have there are added; the word that ran on
 * into it ends at the pause. Everything else stays as the model wrote it, and so does speech before its first word.
 * ponytail: a repeat with no pause that hides in a word under longS, and words the model mishears when it hears a
 * stretch alone, stay as they are; a larger model is the next step, not more rules here. Over music with a speaker
 * on top there are no pauses to go by, so only the long words are heard again.
 */
export async function relisten(first: DeviceWord[], pcm: Float32Array, hear: (from: number, to: number) => Promise<DeviceWord[]>, c = RELISTEN): Promise<DeviceWord[]> {
  const e = loudness(pcm, first);
  // the stretches of speech [from, to): loud reads, with the pauses under pauseS between them
  const speech: [number, number][] = [];
  let from = -1;
  let last = -1;
  for (let i = 0; i <= e.length; i++) {
    if (i < e.length && e[i]! >= c.threshold) {
      if (from < 0) from = i;
      last = i;
    } else if (from >= 0 && (i === e.length || i - last >= c.pauseS * READS)) {
      speech.push([from / READS, (last + 1) / READS]);
      from = -1;
    }
  }
  const held = (w: DeviceWord) => e.subarray(Math.round(w.start * READS), Math.round(w.end * READS)).filter((x) => x >= c.threshold).length / READS;
  // half the words hold seconds of sound: the model is not following a speaker (music, noise), and there is nothing to check
  if (first.map(held).sort((x, y) => x - y)[first.length >> 1]! > c.longS) return first;
  const words = first.map((w) => ({ ...w }));
  const again: { from: number; to: number; holder?: DeviceWord }[] = [];
  speech.forEach(([a, b], k) => {
    // a stretch that follows speech the model wrote words for, and that one of its words reaches or follows
    const pause = speech[k - 1]?.[1] ?? 0;
    if (!words.some((w) => w.start < pause) || !words.some((w) => w.end > a)) return;
    // its own first word starts in it, or in the pause before it
    const opens = words.find((w) => w.start >= pause && w.start < b)?.start ?? b;
    if (opens - a < c.openingS) return;
    again.push({ from: a, to: b });
    // the word that ran on into it ends at that pause
    for (const w of words) if (w.start < pause && w.end > a) w.end = Math.max(pause, w.start + 0.05);
  });
  for (const w of words) if (held(w) > c.longS) again.push({ from: w.start, to: w.end, holder: w });
  for (const { from, to, holder } of again) {
    // a stretch between pauses is heard with some of the quiet around it (half the pause at most); a long word's span as it is
    const k = speech.findIndex(([a]) => a === from);
    const lead = holder ? 0 : Math.min(c.padS, (from - (speech[k - 1]?.[1] ?? 0)) / 2);
    const tail = holder ? 0 : Math.min(c.padS, ((speech[k + 1]?.[0] ?? Infinity) - to) / 2);
    // a word that starts after the stretch is made up; in a long word's span, the first quarter second is the word itself
    const got = (await hear(from - lead, to + tail)).filter((w) => w.start < to && (!holder || w.start >= holder.start + 0.25));
    if (holder && got[0]) holder.end = Math.min(holder.end, got[0].start);
    // a word is there already when a word of the first listen shares half of the shorter one's time with it
    const there = (w: DeviceWord) => words.some((x) => (Math.min(w.end, x.end) - Math.max(w.start, x.start)) * 2 >= Math.min(w.end - w.start, x.end - x.start));
    const missing = got.filter((w) => !there(w));
    words.push(...missing.map((w) => ({ ...w, end: Math.min(w.end, Math.max(to, w.start + 0.05)) })));
  }
  return words.sort((x, y) => x.start - y.start);
}

/** The model library, keeping its models in the person's data (modelsDir) and fetching them through this server. */
export async function modelLibrary() {
  const lib = await import("@huggingface/transformers");
  lib.env.cacheDir = modelsDir();
  lib.env.allowLocalModels = false;
  // through this server's own model route, without the network hop: its mirror fallback, and a model Caption Studio
  // already fetched is copied from that route's files instead of downloaded again
  lib.env.remoteHost = "http://server/api/hf/";
  lib.env.fetch = (async (url: string | URL | Request, init?: RequestInit) => hfApp.request(new URL(String(url)).pathname, init)) as typeof fetch;
  return lib;
}

async function loadModel(say: (text: string) => void): Promise<Transcriber> {
  const { pipeline } = await modelLibrary();
  const kept = existsSync(path.join(modelsDir(), MODEL, "onnx", "decoder_model_merged.onnx"));
  if (!kept) say(GETTING_MODEL);
  let shown = 0;
  const t = await pipeline("automatic-speech-recognition", MODEL, {
    // full precision, as in the browser: the smaller decoders trip a bug in the runtime (src/workers/transcribe.worker.ts)
    dtype: "fp32",
    progress_callback: (p: { status: string; progress?: number }) => {
      const pct = p.status === "progress_total" ? Math.floor(p.progress ?? 0) : 0;
      if (!kept && pct >= shown + 5 && pct < 100) say(`${GETTING_MODEL} · ${(shown = pct)}%`);
    },
  });
  return t as unknown as Transcriber;
}

/**
 * The words said in `pcmFile` (DEVICE_AUDIO samples) with their times, and the language heard. One run at a time for
 * the whole server, in the same line as every library and AI Editor ffmpeg (ffmpegSlot), so a transcript never runs
 * beside another heavy job: the caller cuts the audio first, then calls this. `key` names the run for deviceStatus.
 * ponytail: the whole file's samples are held in memory (230 MB an hour) and a run can't be stopped half way;
 * read and transcribe it in parts when hours-long footage or a Stop button needs it.
 */
export function transcribeOnDevice(pcmFile: string, key: string, load = loadModel): Promise<{ words: DeviceWord[]; language: string | null }> {
  return ffmpegSlot(async () => {
    const say = (text: string) => void (current = { key, text });
    speaking = true;
    await freeOther();
    try {
      const model = await load(say).catch(async (e) => {
        console.warn("[transcribe] the speech model did not load:", e);
        await rm(path.join(modelsDir(), MODEL), { recursive: true, force: true }); // a bad copy would fail every later run: the next try fetches it again
        throw new Error(`The speech model could not be made ready. It downloads once (${MODEL_MB} MB): check the internet connection, then try again.`);
      });
      try {
        say(LISTENING);
        const b = await readFile(pcmFile);
        const n = b.byteLength >> 2;
        const pcm = b.byteOffset % 4 ? new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + n * 4)) : new Float32Array(b.buffer, b.byteOffset, n);
        // the language is heard, never assumed: left alone the model takes everything for English
        const language = await spokenLanguage(model, pcm);
        const options = { chunk_length_s: 30, stride_length_s: 5, return_timestamps: "word", ...(language ? { language, task: "transcribe" } : {}) };
        const hear = async (from: number, to: number) => {
          const out = await model(pcm.subarray(Math.round(from * RATE), Math.round(to * RATE)), options);
          return wordsOf(out.chunks ?? [], to - from).map((w) => ({ text: w.text, start: w.start + from, end: w.end + from }));
        };
        return { words: await relisten(await hear(0, pcm.length / RATE), pcm, hear), language };
      } finally {
        await model.dispose(); // about 2 GB while it runs: given back between jobs
      }
    } finally {
      current = null;
      speaking = false;
    }
  });
}
