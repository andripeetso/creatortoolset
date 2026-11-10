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
 */

/** Caption Studio's first model (src/lib/transcribe.ts MODELS[0]), so one download serves both: it hears every language. */
const MODEL = "Xenova/whisper-base";
const MODEL_MB = 291;
export const GETTING_MODEL = `Getting the speech model ready (${MODEL_MB} MB, only the first time)`;
export const LISTENING = "Listening to your video";
/** Kept with the person's data, never beside the server's own files (the library's default), which are part of a signed app. */
const modelsDir = () => path.join(env.dataDir, "models");

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

async function loadModel(say: (text: string) => void): Promise<Transcriber> {
  const { pipeline, env: lib } = await import("@huggingface/transformers");
  lib.cacheDir = modelsDir();
  lib.allowLocalModels = false;
  // through this server's own model route, without the network hop: its mirror fallback, and a model Caption Studio
  // already fetched is copied from that route's files instead of downloaded again
  lib.remoteHost = "http://server/api/hf/";
  lib.fetch = (async (url: string | URL | Request, init?: RequestInit) => hfApp.request(new URL(String(url)).pathname, init)) as typeof fetch;
  const kept = existsSync(path.join(lib.cacheDir, MODEL, "onnx", "decoder_model_merged.onnx"));
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
        const out = await model(pcm, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: "word", ...(language ? { language, task: "transcribe" } : {}) });
        return { words: wordsOf(out.chunks ?? [], pcm.length / 16000), language };
      } finally {
        await model.dispose(); // about 2 GB while it runs: given back between jobs
      }
    } finally {
      current = null;
    }
  });
}
