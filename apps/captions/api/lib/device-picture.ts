import { existsSync } from "node:fs";
import path from "node:path";
import { ffmpegSlot } from "../library/media/run";
import { beforeSpeechModel, deviceTranscribes, modelLibrary, modelsDir, speechModelInUse } from "./device-transcribe";
import { hostedMode } from "./env";

/**
 * Search by picture: an image–text model (SigLIP 2) run by the server itself turns each shot's picture into a vector
 * and a typed search into one in the same space, so a search finds what the footage shows, not only its words. Where
 * the server runs on the person's own computer (deviceTranscribes), and on a server whose admin turns it on
 * (LIBRARY_PICTURES=1); never on a hosted server, whose processor every account shares: an hour of footage has some
 * 880 shots, and two cores of a busy desktop processor took about 2 minutes for them (0.13 s a shot, 1.2 GB held;
 * measured on 2 hours of public-domain films), minutes of a shared server per hour of every account's footage. There
 * the person's own computers make them (work/pictures.ts) and the server reads only typed searches with the text side
 * alone: about 270 MB on disk, 710 MB held while searches come (given back 2 minutes after the last), loaded in 3.4 s and
 * 18 ms a search on two cores of a busy desktop processor (measured). The pictures go in at PICTURE_PX square; the text model reads
 * up to 64 tokens. Vision and text are two models, loaded on their own and given back when idle or before a transcript.
 */

export const PICTURE_MODEL = "onnx-community/siglip2-base-patch16-224-ONNX";
export const PICTURE_PX = 224;
// the picture side at full precision: its 8-bit copy missed a third of the shots a search wanted (measured)
const VISION = { dtype: "fp32", file: "vision_model.onnx" } as const;
const TEXT = { dtype: "q8", file: "text_model_quantized.onnx" } as const;
export const PICTURE_MODEL_MB = 655;
/** The length of a picture vector. */
export const PICTURE_DIM = 768;
const BATCH = 8;
const IDLE_MS = 2 * 60_000;

/** Whether this server makes picture vectors (see above). */
export const picturesHere = (): boolean => !hostedMode() && (deviceTranscribes() || process.env.LIBRARY_PICTURES === "1");

const kept = (...f: string[]) => existsSync(path.join(modelsDir(), PICTURE_MODEL, ...f));
/** Whether the model is on this computer (fetched once by the first library job, kept with the person's data). */
export const pictureModelKept = (): boolean => kept("onnx", VISION.file) && pictureTextKept();
/** Whether the text side is on this computer: all a search needs. */
export const pictureTextKept = (): boolean => kept("onnx", TEXT.file) && kept("tokenizer.json");

type Out = { pooler_output: { data: Float32Array; dims: number[] } };
type Model = ((inputs: Record<string, unknown>) => Promise<Out>) & { dispose(): Promise<unknown> };
type Tokenize = ((texts: string[], o: Record<string, unknown>) => Record<string, unknown>) & { encode(text: string, o: { add_special_tokens: boolean }): number[] };

let vision: Promise<Model> | null = null;
let text: Promise<{ model: Model; tokenize: Tokenize }> | null = null;
/** The text side is in memory; when it last failed to load or fetch. */
let textUp = false;
let textFailed = 0;
let line: Promise<unknown> = Promise.resolve();
let idle: NodeJS.Timeout | undefined;

/** Gives both models back once the runs already in line are over. */
function giveBack(): Promise<void> {
  clearTimeout(idle);
  const done = line.then(async () => {
    const [v, t] = [vision, text];
    vision = text = null;
    textUp = false;
    await Promise.all([v?.then((m) => m.dispose()), t?.then((m) => m.model.dispose())].map((p) => p?.catch(() => {})));
  });
  line = done;
  return done;
}
beforeSpeechModel(giveBack);

function inLine<T>(run: () => Promise<T>, search: boolean): Promise<T> {
  const r = line.then(async () => {
    // a search never loads a model beside the speech model: the caller then searches by words alone
    if (search && speechModelInUse()) throw new Error("This computer is making a transcript");
    clearTimeout(idle);
    try {
      return await run();
    } finally {
      idle = setTimeout(() => void giveBack(), IDLE_MS);
      idle.unref();
    }
  });
  line = r.catch(() => {});
  return r;
}

/** Each row of `data` (rows of `dims[1]`) as a vector of length 1. */
function rows({ data, dims }: Out["pooler_output"]): Float32Array[] {
  const d = dims[1]!;
  return Array.from({ length: data.length / d }, (_, k) => {
    const v = data.slice(k * d, (k + 1) * d);
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  });
}

/** PICTURE_PX² RGB pictures (rgb24, as ffmpeg writes them) as the model's input: channels first, -1…1. */
export function pixelValues(pictures: Uint8Array[]): Float32Array {
  const n = PICTURE_PX * PICTURE_PX;
  const out = new Float32Array(pictures.length * 3 * n);
  pictures.forEach((p, k) => {
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) out[(k * 3 + c) * n + i] = p[i * 3 + c]! / 127.5 - 1;
  });
  return out;
}

/**
 * Vectors for `pictures` (PICTURE_PX² rgb24 each), in order. A library job's: it waits its turn in the line every ffmpeg
 * and transcript runs in, so it is one heavy job at a time. The first run fetches the model, with its text side where
 * this server searches too (`withText`; a computer making them for a server only makes them).
 */
export function embedPictures(pictures: Uint8Array[], withText = true): Promise<Float32Array[]> {
  return ffmpegSlot(() =>
    inLine(async () => {
      const lib = await modelLibrary();
      vision ??= lib.SiglipVisionModel.from_pretrained(PICTURE_MODEL, { dtype: VISION.dtype }) as unknown as Promise<Model>;
      // a fetch that failed is fetched again next time
      const m = await vision.catch((e) => {
        vision = null;
        throw e;
      });
      // the text side is fetched with it, so a search finds the model here (it never waits for a download)
      if (withText && !pictureModelKept()) await textModel();
      const out: Float32Array[] = [];
      for (let i = 0; i < pictures.length; i += BATCH) {
        const batch = pictures.slice(i, i + BATCH);
        const pixel_values = new lib.Tensor("float32", pixelValues(batch), [batch.length, 3, PICTURE_PX, PICTURE_PX]);
        out.push(...rows((await m({ pixel_values })).pooler_output));
      }
      return out;
    }, false),
  );
}

/** The text side, loaded once (fetched the first time); a load that failed is tried again next time. */
function textModel() {
  text ??= (async () => {
    const lib = await modelLibrary();
    const [model, tokenizer] = await Promise.all([lib.SiglipTextModel.from_pretrained(PICTURE_MODEL, { dtype: TEXT.dtype }), lib.AutoTokenizer.from_pretrained(PICTURE_MODEL)]);
    textUp = true;
    return { model: model as unknown as Model, tokenize: tokenizer as unknown as Tokenize };
  })();
  return text.catch((e) => {
    text = null;
    textFailed = Date.now();
    throw e;
  });
}

/**
 * Whether a typed search's vector is made at once: "ready" when the text side is in memory; else it starts loading it
 * (fetched the first time) and says "loading", so the search goes without pictures and asks again soon, never waiting.
 * "failed": its last load failed under 10 minutes ago.
 */
export function pictureText(): "ready" | "loading" | "failed" {
  if (textUp) return "ready";
  if (Date.now() - textFailed < 10 * 60_000) return "failed";
  void inLine(textModel, true).catch(() => {});
  return "loading";
}

/** Vectors for typed `texts` in the pictures' space, at once (a search's). Throws when the model is not here yet or a transcript is being made. */
export function embedPictureQuery(texts: string[]): Promise<Float32Array[]> {
  if (!pictureTextKept()) return Promise.reject(new Error("The picture model is not on this computer yet"));
  return inLine(async () => {
    const t = await textModel();
    // the model was trained on lower case, padded to 64 tokens
    return rows((await t.model(t.tokenize(texts.map((s) => s.toLowerCase()), { padding: "max_length", max_length: 64, truncation: true }))).pooler_output);
  }, true);
}

/**
 * Whether typed `text` reads as English, the one language the model reads well (of 25 searches, the shot wanted came
 * first for 23 in English and 3 in Estonian; 24 for the Estonian ones written in English by an AI): only letters a to z, and three in four of its words whole words of the model's own vocabulary
 * (an English word mostly is, an Estonian one comes in pieces). Measured on the 31 searches in both: every English one
 * passes, 30 of the 31 Estonian ones don't ("siga" is a word in Spanish).
 */
export async function readsAsEnglish(text: string): Promise<boolean> {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (!words.length || words.some((w) => /[^a-z]/.test(w))) return false;
  const t = await inLine(textModel, true);
  return words.filter((w) => t.tokenize.encode(w, { add_special_tokens: false }).length === 1).length >= 0.75 * words.length;
}
