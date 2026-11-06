/// <reference lib="webworker" />
import { pipeline, env } from "@huggingface/transformers";

env.allowLocalModels = false;
// Fetch model weights through the app's same-origin proxy — works even
// where huggingface.co is unreachable, and lets the browser cache them.
env.remoteHost = `${self.location.origin}/api/hf`;

export interface WorkerWord {
  text: string;
  start: number;
  end: number;
}

type InMsg = {
  type: "transcribe";
  pcm: Float32Array;
  model: string;
  language: string | null;
  device: "webgpu" | "wasm";
};

const post = (msg: unknown, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

async function createTranscriber(model: string, device: "webgpu" | "wasm") {
  // fp32 everywhere: the q8 whisper decoders on HF trip a MatMulNBits
  // scale bug in current onnxruntime (web & node), and fp16 variants
  // are not published for the Xenova exports we use.
  const dtypes: unknown[] = [
    { encoder_model: "fp32", decoder_model_merged: "fp32" },
    "fp32",
  ];

  let lastErr: unknown = null;
  for (const dtype of dtypes) {
    try {
      const t = await pipeline("automatic-speech-recognition", model, {
        device,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dtype: dtype as any,
        progress_callback: (p: {
          status: string;
          file?: string;
          progress?: number;
        }) => {
          if (p.status === "progress" && typeof p.progress === "number") {
            post({
              type: "load-progress",
              progress: p.progress / 100,
              detail: p.file ?? "model",
            });
          }
        },
      });
      return t;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

self.onmessage = async (ev: MessageEvent<InMsg>) => {
  const { pcm, model, language, device } = ev.data;
  try {
    post({ type: "load-progress", progress: 0, detail: "initializing" });
    const transcriber = await createTranscriber(model, device);

    post({ type: "transcribe-start" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: any = await transcriber(pcm, {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: "word",
      ...(language ? { language, task: "transcribe" } : {}),
    });

    const words: WorkerWord[] = [];
    const chunks: { text: string; timestamp: [number, number | null] }[] =
      out?.chunks ?? [];
    for (const c of chunks) {
      const text = c.text.trim();
      if (!text) continue;
      const [s, e] = c.timestamp;
      words.push({
        text,
        start: Math.max(0, s),
        end: Math.max(s + 0.05, e ?? s + 0.25),
      });
    }
    post({ type: "done", words });
  } catch (e) {
    post({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }
};
