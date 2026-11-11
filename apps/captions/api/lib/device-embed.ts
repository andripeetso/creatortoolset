import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { ffmpegSlot } from "../library/media/run";
import { beforeSpeechModel, modelLibrary, modelsDir, speechModelInUse } from "./device-transcribe";

/**
 * Search by meaning on the person's own computer, for a server with no OpenAI key: a small sentence model run by the
 * server itself, only where it also transcribes by itself (device-transcribe.ts deviceTranscribes; a hosted server
 * keeps asking for the key). It was trained on 50 languages, Estonian among them, and a query in one language finds a
 * clip described in another. A key, when there is one, goes first (library/embed.ts embedRoute).
 */

export const DEVICE_EMBED_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const MODEL_MB = 136;
export const GETTING_SEARCH_MODEL = `Getting the search model ready (${MODEL_MB} MB, only the first time)`;
/** Texts per run: a long transcript goes in parts, so a run never holds hundreds of them at once. */
const BATCH = 16;
/** Loaded, the model holds about 0.6 GB (measured): given back after this long without a run, or before a transcript. */
const IDLE_MS = 2 * 60_000;

/** The loaded model, as the library gives it: called with texts, closed when it is given back. */
type Extractor = ((texts: string[], options: { pooling: "mean"; normalize: boolean }) => Promise<{ data: Float32Array; dims: number[] }>) & {
  dispose(): Promise<unknown>;
};

let model: Promise<Extractor> | null = null;
// runs one after another, so the model is never given back in the middle of one
let line: Promise<unknown> = Promise.resolve();
let idle: NodeJS.Timeout | undefined;
let current: { key: string; text: string } | null = null;

/** What the run for `key` (a library version) is doing, in words for its owner, while the model is fetched; else undefined. */
export const deviceEmbedStatus = (key: string): string | undefined => (current?.key === key ? current.text : undefined);

async function loadModel(say: (text: string) => void): Promise<Extractor> {
  const { pipeline } = await modelLibrary();
  const kept = existsSync(path.join(modelsDir(), DEVICE_EMBED_MODEL, "onnx", "model_quantized.onnx"));
  if (!kept) say(GETTING_SEARCH_MODEL);
  let shown = 0;
  const m = await pipeline("feature-extraction", DEVICE_EMBED_MODEL, {
    dtype: "q8",
    progress_callback: (p: { status: string; progress?: number }) => {
      const pct = p.status === "progress_total" ? Math.floor(p.progress ?? 0) : 0;
      if (!kept && pct >= shown + 5 && pct < 100) say(`${GETTING_SEARCH_MODEL} · ${(shown = pct)}%`);
    },
  });
  return m as unknown as Extractor;
}

/** Gives the model back once the runs already in line are over. */
function giveBack(): Promise<void> {
  clearTimeout(idle);
  const done = line.then(async () => {
    const m = model;
    model = null;
    await m?.then((x) => x.dispose()).catch(() => {});
  });
  line = done;
  return done;
}
beforeSpeechModel(giveBack);

function run(texts: string[], key: string, load: typeof loadModel, search: boolean): Promise<Float32Array[]> {
  const r = line.then(async () => {
    // a search never loads this model beside the speech model: the caller then searches by words alone
    if (search && speechModelInUse()) throw new Error("This computer is making a transcript");
    clearTimeout(idle);
    try {
      model ??= load((text) => void (current = { key, text }));
      const m = await model.catch(async (e) => {
        model = null;
        console.warn("[search] the search model did not load:", e);
        await rm(path.join(modelsDir(), DEVICE_EMBED_MODEL), { recursive: true, force: true }); // a bad copy would fail every later run
        throw new Error(`Search by meaning could not get its model ready. It downloads once (${MODEL_MB} MB): check the internet connection, then try again.`);
      });
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        const t = await m(texts.slice(i, i + BATCH), { pooling: "mean", normalize: true });
        const d = t.dims[1]!;
        for (let k = 0; k * d < t.data.length; k++) out.push(t.data.slice(k * d, (k + 1) * d));
      }
      return out;
    } finally {
      current = null;
      idle = setTimeout(() => void giveBack(), IDLE_MS);
      idle.unref();
    }
  });
  line = r.catch(() => {});
  return r;
}

/**
 * Vectors for `texts`, in order, made on this computer, one run at a time. A clip's (`job`; its key names the run for
 * deviceEmbedStatus) waits its turn in the line every ffmpeg and transcript runs in (ffmpegSlot), so it is one heavy
 * job at a time; a search's runs at once, and throws while a transcript is being made.
 */
export function embedOnDevice(texts: string[], job?: { key: string }, load = loadModel): Promise<Float32Array[]> {
  return job ? ffmpegSlot(() => run(texts, job.key, load, false)) : run(texts, "", load, true);
}
