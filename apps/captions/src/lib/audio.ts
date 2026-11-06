import type { DecodedAudio } from "./audio-decode";

export type AudioPreparationProgress = (
  progress: number,
  detail: string,
) => void;

/**
 * Prepare audio in a dedicated worker. File/Blob structured cloning keeps the
 * source bytes shared with the worker, and the completed PCM buffers transfer
 * back without copying. Terminating on abort prevents an old project from
 * continuing to consume CPU after the user starts another one.
 */
export function extractAudio(
  file: File,
  onProgress?: AudioPreparationProgress,
  signal?: AbortSignal,
): Promise<DecodedAudio> {
  const startedAt = Date.now();
  const log = (message: string) =>
    console.log(`[cap-audio] +${Date.now() - startedAt}ms ${message}`);
  log(
    `extract start file="${file.name}" bytes=${file.size} heapMB=${heapUsedMB()}`,
  );
  const worker = new Worker(
    new URL("../workers/audio.worker.ts", import.meta.url),
    { type: "module", name: "caption-audio-preparation" },
  );
  log("worker spawned");

  return new Promise<DecodedAudio>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      fn();
    };
    const abort = () => {
      log("abort requested");
      finish(() =>
        reject(new DOMException("Audio preparation canceled", "AbortError")),
      );
    };

    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event) => {
      const message = event.data;
      if (message?.type === "progress") {
        onProgress?.(message.progress, message.detail);
      } else if (message?.type === "done") {
        log(
          `worker done duration=${message.duration} pcmBytes=${message.pcm?.byteLength ?? 0} heapMB=${heapUsedMB()}`,
        );
        finish(() =>
          resolve({
            pcm: message.pcm,
            peaks: message.peaks,
            duration: message.duration,
          }),
        );
      } else if (message?.type === "error") {
        log(`worker reported error: ${message.message}`);
        finish(() => reject(new Error(message.message)));
      }
    };
    worker.onerror = (event) => {
      log(`worker.onerror: ${event.message || "unknown"}`);
      finish(() =>
        reject(new Error(event.message || "Audio preparation worker failed")),
      );
    };
    worker.postMessage({ type: "decode", file });
  });
}

function heapUsedMB(): number {
  const memory = (
    performance as unknown as { memory?: { usedJSHeapSize: number } }
  ).memory;
  return memory ? Math.round(memory.usedJSHeapSize / 1048576) : -1;
}
