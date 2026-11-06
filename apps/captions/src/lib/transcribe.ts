import type { Word } from "./types";

/** Server-proxied Deepgram engine — offered when the server has a key. */
export const CLOUD_MODEL_ID = "cloud/deepgram";
export const CLOUD_MODEL = {
  id: CLOUD_MODEL_ID,
  label: "Cloud · Deepgram nova-3 (best, instant)",
  webgpuOnly: false,
};

export interface CloudStatus {
  available: boolean; // server has a Deepgram key
  allowed: boolean; // this account may use it (admin, or unlocked by admin)
}

let cloudCache: CloudStatus | null = null;
export async function cloudStatus(): Promise<CloudStatus> {
  if (cloudCache !== null) return cloudCache;
  try {
    const r = await fetch("/api/transcribe/available");
    const d = await r.json();
    cloudCache = {
      available: d.available === true,
      allowed: d.allowed === true,
    };
  } catch {
    cloudCache = { available: false, allowed: false };
  }
  return cloudCache;
}

/** Encode 16 kHz mono float PCM as a 16-bit WAV blob. */
export function pcmToWav(pcm: Float32Array, sampleRate = 16000): Blob {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + pcm.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

/** `name` (the video's file name) labels guest runs in Admin → Guests. */
export async function transcribeCloud(pcm: Float32Array, name = ""): Promise<Word[]> {
  const res = await fetch("/api/transcribe", {
    method: "POST",
    headers: { "Content-Type": "audio/wav", "X-File-Name": encodeURIComponent(name) },
    body: pcmToWav(pcm),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: "" }));
    throw new Error(e.error || `Cloud transcription failed (${res.status})`);
  }
  const { words } = (await res.json()) as {
    words: {
      text: string;
      start: number;
      end: number;
      confidence?: number;
      utterance?: number;
    }[];
  };
  return words.map((w, i) => ({
    id: i,
    text: w.text,
    start: w.start,
    end: w.end,
    timing: "aligned" as const,
    ...(typeof w.confidence === "number" ? { confidence: w.confidence } : {}),
    ...(typeof w.utterance === "number" ? { utterance: w.utterance } : {}),
  }));
}

export const MODELS = [
  {
    id: "Xenova/whisper-base.en",
    label: "Local · Base · English (recommended) (~145 MB)",
    webgpuOnly: false,
  },
  {
    id: "Xenova/whisper-tiny.en",
    label: "Local · Tiny · English (fastest) (~75 MB)",
    webgpuOnly: false,
  },
  {
    id: "Xenova/whisper-small.en",
    label: "Local · Small · English (best quality) (~470 MB)",
    webgpuOnly: true,
  },
  {
    id: "Xenova/whisper-base",
    label: "Local · Base · Multilingual (auto-detect) (~145 MB)",
    webgpuOnly: false,
  },
];

/**
 * The user's engine choice, persisted across reloads and new projects.
 * Absent until they explicitly pick one — the app then defaults to cloud
 * when the account may use it (see Player), else the first local model.
 */
const ENGINE_KEY = "cap-engine";

export function storedEngine(): string | null {
  try {
    const saved = localStorage.getItem(ENGINE_KEY);
    const known = [CLOUD_MODEL_ID, ...MODELS.map((m) => m.id)];
    return saved && known.includes(saved) ? saved : null;
  } catch {
    return null; // storage unavailable (privacy mode)
  }
}

export function persistEngine(m: string): void {
  try {
    localStorage.setItem(ENGINE_KEY, m);
  } catch {
    // storage unavailable — the choice still applies for this session
  }
}

export async function detectDevice(): Promise<"webgpu" | "wasm"> {
  try {
    if (typeof navigator === "undefined" || !("gpu" in navigator))
      return "wasm";
    const gpu = (
      navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }
    ).gpu;
    if (!gpu) return "wasm";
    const adapter = await Promise.race([
      gpu.requestAdapter(),
      new Promise<null>((r) => setTimeout(() => r(null), 3000)),
    ]);
    return adapter ? "webgpu" : "wasm";
  } catch {
    return "wasm";
  }
}

export interface TranscribeCallbacks {
  onLoadProgress?: (progress: number, detail: string) => void;
  onTranscribeStart?: () => void;
}

export function transcribeAudio(
  pcm: Float32Array,
  model: string,
  language: string | null,
  device: "webgpu" | "wasm",
  cb: TranscribeCallbacks,
): { promise: Promise<Word[]>; cancel: () => void } {
  const worker = new Worker(
    new URL("../workers/transcribe.worker.ts", import.meta.url),
    { type: "module" },
  );

  const promise = new Promise<Word[]>((resolve, reject) => {
    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === "load-progress") {
        cb.onLoadProgress?.(m.progress, m.detail);
      } else if (m.type === "transcribe-start") {
        cb.onTranscribeStart?.();
      } else if (m.type === "done") {
        worker.terminate();
        const words: Word[] = m.words.map(
          (w: { text: string; start: number; end: number }, i: number) => ({
            id: i,
            text: w.text,
            start: w.start,
            end: w.end,
            timing: "approximate" as const,
          }),
        );
        resolve(words);
      } else if (m.type === "error") {
        worker.terminate();
        reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "Transcription worker failed"));
    };
  });

  const pcmCopy = pcm.slice();
  worker.postMessage(
    { type: "transcribe", pcm: pcmCopy, model, language, device },
    [pcmCopy.buffer],
  );

  return { promise, cancel: () => worker.terminate() };
}
