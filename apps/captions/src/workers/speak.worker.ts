/// <reference lib="webworker" />
import { env } from "@huggingface/transformers";
import { KokoroTTS, TextSplitterStream } from "kokoro-js";

/**
 * The assistant's read-aloud voice (lib/read-aloud.ts): Kokoro, a small open speech model (~90 MB, downloaded once
 * through the app's model proxy and kept in the browser cache) that runs here, on the user's computer. A reply is
 * spoken sentence by sentence, so the first one plays while the rest are still being made.
 */

env.allowLocalModels = false;
env.remoteHost = `${self.location.origin}/api/hf`;

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const VOICE = "af_heart";

type InMsg = { type: "speak"; id: number; text: string } | { type: "stop" };

const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

let tts: Promise<KokoroTTS> | null = null;
const load = () =>
  (tts ??= KokoroTTS.from_pretrained(MODEL, {
    dtype: "q8",
    device: "wasm",
    progress_callback: (p) => {
      if (p.status === "progress" && typeof p.progress === "number") post({ type: "load-progress", progress: p.progress / 100 });
    },
  }).catch((e) => {
    tts = null; // a failed download can be tried again next time
    throw e;
  }));

/** The newest reply wins: an older one still being made stops between sentences. */
let current = 0;

self.onmessage = async (ev: MessageEvent<InMsg>) => {
  if (ev.data.type === "stop") {
    current = -1;
    return;
  }
  const { id, text } = ev.data;
  current = id;
  try {
    const model = await load();
    post({ type: "ready", id });
    if (!text) return; // just getting ready (the switch was turned on)
    // a closed splitter: given a plain string, kokoro-js 1.2.1 never closes its own and the last sentence never comes
    const sentences = new TextSplitterStream();
    sentences.push(text);
    sentences.close();
    for await (const { audio } of model.stream(sentences, { voice: VOICE })) {
      if (current !== id) return;
      const samples = audio.audio as Float32Array;
      post({ type: "audio", id, samples, rate: audio.sampling_rate }, [samples.buffer]);
    }
    post({ type: "end", id });
  } catch (e) {
    post({ type: "error", id, message: e instanceof Error ? e.message : String(e) });
  }
};
