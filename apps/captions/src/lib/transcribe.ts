import type { Word } from "./types";

/** Server-proxied Deepgram engine, on the account's own key (Settings → API keys) or the server's when it serves them. */
export const CLOUD_MODEL_ID = "cloud/deepgram";
export const CLOUD_MODEL = {
  id: CLOUD_MODEL_ID,
  label: "Cloud · Deepgram nova-3 (best, instant)",
  webgpuOnly: false,
};

export interface CloudStatus {
  available: boolean; // a Deepgram key serves this account
  allowed: boolean; // this account may use it (admin, or unlocked by admin)
  why?: string; // when not available: the key to add
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
      ...(typeof d.why === "string" ? { why: d.why } : {}),
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

/**
 * The on-device models. `mb` is what the browser really downloads the first time: the encoder and the merged decoder
 * at full precision (the worker's dtype), summed from the published file sizes.
 */
const local = (id: string, name: string, mb: number, webgpuOnly = false) => ({
  id,
  label: `Local · ${name} (${mb} MB)`,
  mb,
  webgpuOnly,
});
export const MODELS = [
  // first = the default with no saved choice and no cloud: it hears every language, and it is the first job's model,
  // so a second job downloads nothing more
  local("Xenova/whisper-base", "Base · Any language (recommended)", 291),
  local("Xenova/whisper-base.en", "Base · English", 291),
  local("Xenova/whisper-tiny.en", "Tiny · English (fastest)", 152),
  local("Xenova/whisper-small.en", "Small · English (best quality)", 968, true),
];

/** A first job's model (`captionThisVideo`): nothing says which language she speaks, so the one that hears them all. */
export const FIRST_JOB_MODEL = MODELS[0].id;

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
  onLoadProgress?: (progress: number) => void;
  onTranscribeStart?: () => void;
}

/**
 * A graphics-card run that has started and then says nothing for this long has stalled: seen in WebKit, where such a
 * run sometimes never returns. It is stopped and fails, and the caller runs it again on the processor.
 */
export const STALL_MS = 60_000;

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

  let quiet: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<Word[]>((resolve, reject) => {
    worker.onmessage = (ev) => {
      const m = ev.data;
      clearTimeout(quiet);
      // the worker reports each word it writes ("alive"), so silence after the start is a stall, not a long video
      if (device === "webgpu" && (m.type === "transcribe-start" || m.type === "alive")) {
        quiet = setTimeout(() => {
          worker.terminate();
          reject(new Error("The graphics card stopped answering"));
        }, STALL_MS);
      }
      if (m.type === "load-progress") {
        cb.onLoadProgress?.(m.progress);
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

  return {
    promise,
    cancel: () => {
      clearTimeout(quiet);
      worker.terminate();
    },
  };
}
