import { afterEach, describe, expect, it, vi } from "vitest";
import { FIRST_JOB_MODEL, MODELS, STALL_MS, transcribeAudio } from "./transcribe";

describe("on-device models", () => {
  it("keeps the ids a saved engine choice points at, in the order the default is read from", () => {
    expect(MODELS.map((m) => m.id)).toEqual([
      "Xenova/whisper-base.en",
      "Xenova/whisper-tiny.en",
      "Xenova/whisper-small.en",
      "Xenova/whisper-base",
    ]);
  });

  it("says each model's real download in its label", () => {
    // encoder_model.onnx + decoder_model_merged.onnx as published, in MB (10^6 bytes)
    const published: Record<string, number> = {
      "Xenova/whisper-base.en": 82.5 + 208.6,
      "Xenova/whisper-tiny.en": 32.9 + 118.6,
      "Xenova/whisper-small.en": 352.8 + 615.4,
      "Xenova/whisper-base": 82.5 + 208.6,
    };
    for (const m of MODELS) {
      expect(m.mb).toBe(Math.round(published[m.id]));
      expect(m.label).toContain(`(${m.mb} MB)`);
    }
  });

  it("starts a first job on a listed model that hears every language", () => {
    expect(MODELS.some((m) => m.id === FIRST_JOB_MODEL)).toBe(true);
    expect(FIRST_JOB_MODEL).not.toMatch(/\.en$/);
  });
});

describe("a graphics-card run that goes quiet", () => {
  class FakeWorker {
    static last: FakeWorker;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: unknown = null;
    terminate = vi.fn();
    postMessage = vi.fn();
    constructor() {
      FakeWorker.last = this;
    }
    says(data: unknown) {
      this.onmessage?.({ data });
    }
  }
  const run = (device: "webgpu" | "wasm") => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", FakeWorker);
    const { promise } = transcribeAudio(new Float32Array(16), FIRST_JOB_MODEL, null, device, {});
    const settled = vi.fn();
    promise.then(
      (words) => settled("words", words.length),
      (e: Error) => settled("failed", e.message),
    );
    return { worker: FakeWorker.last, settled };
  };
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("is stopped and fails, so the caller can run it on the processor", async () => {
    const { worker, settled } = run("webgpu");
    worker.says({ type: "load-progress", progress: 1 });
    await vi.advanceTimersByTimeAsync(STALL_MS * 3); // a slow download is not a stall
    expect(settled).not.toHaveBeenCalled();
    worker.says({ type: "transcribe-start" });
    await vi.advanceTimersByTimeAsync(STALL_MS - 1);
    worker.says({ type: "alive" }); // each word starts the wait again
    await vi.advanceTimersByTimeAsync(STALL_MS - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledWith("failed", "The graphics card stopped answering");
    expect(worker.terminate).toHaveBeenCalled();
  });

  it("is left alone once the words are in", async () => {
    const { worker, settled } = run("webgpu");
    worker.says({ type: "transcribe-start" });
    worker.says({ type: "done", words: [{ text: "hello", start: 0, end: 0.5 }] });
    await vi.advanceTimersByTimeAsync(STALL_MS * 2);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledWith("words", 1);
  });

  it("never stops a run on the processor, which has nothing to fall back to", async () => {
    const { worker, settled } = run("wasm");
    worker.says({ type: "transcribe-start" });
    await vi.advanceTimersByTimeAsync(STALL_MS * 10);
    expect(settled).not.toHaveBeenCalled();
    expect(worker.terminate).not.toHaveBeenCalled();
  });
});
