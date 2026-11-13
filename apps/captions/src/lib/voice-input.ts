import { useEffect, useRef, useState } from "react";
import { CLOUD_MODEL_ID, MODELS, detectDevice, storedEngine, transcribeAudio } from "./transcribe";

/**
 * Talk instead of type (the assistant's mic). Records with the browser, then the server writes it down with the engine
 * chosen for talking to the assistant (Settings → AI → Voice; POST /api/transcribe/mic). When the server has none for
 * this account, Whisper in the browser does it (free, private; the model downloads once and stays cached). The words go
 * into the message box, never straight out: you read them before you send.
 */

export type VoicePhase = "idle" | "recording" | "writing";

/** Longest message you can speak in one go. */
const MAX_S = 120;
/** Bars in the live mic meter. */
export const BARS = 28;
const quiet = () => Array<number>(BARS).fill(0);

/** Any recording → 16 kHz mono samples (what both engines take). decodeAudioData resamples to the context's rate. */
async function toPcm16k(blob: Blob): Promise<Float32Array> {
  const audio = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(await blob.arrayBuffer());
  return audio.getChannelData(0);
}

async function writeDown(recording: Blob, onProgress: (p: number) => void): Promise<string> {
  const res = await fetch("/api/transcribe/mic", { method: "POST", headers: { "Content-Type": recording.type || "application/octet-stream" }, body: recording });
  if (res.ok) return ((await res.json()) as { text: string }).text;
  const e = (await res.json().catch(() => ({}))) as { error?: string; code?: string; chosen?: boolean };
  // an engine the person picked that can't run says so; only Automatic falls back to the browser's model
  if ((e.code !== "NEEDS_KEY" && e.code !== "CLOUD_LOCKED") || e.chosen) throw new Error(e.error || `Couldn't write that down (${res.status})`);
  // no engine on the server for this account: the captions' local model, else the first
  const engine = storedEngine();
  // ponytail: a new worker loads the model (from the browser cache) on every message; keep one alive if that's slow
  const words = await transcribeAudio(await toPcm16k(recording), engine && engine !== CLOUD_MODEL_ID ? engine : MODELS[0].id, null, await detectDevice(), {
    onLoadProgress: (p) => onProgress(p),
  }).promise;
  return words
    .map((w) => w.text.trim())
    .filter(Boolean)
    .join(" ");
}

export function useVoiceInput(onText: (text: string) => void) {
  const [phase, setPhase] = useState<VoicePhase>("idle");
  /** The mic's level (0–1) over the last moments, oldest first: the live bars. */
  const [bars, setBars] = useState<number[]>(quiet);
  const [seconds, setSeconds] = useState(0);
  /** First-time model download, 0–1; null when there's nothing to download. */
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const control = useRef<{ stop: () => void; cancel: () => void } | null>(null);
  const textTo = useRef(onText);
  useEffect(() => {
    textTo.current = onText;
  });

  // leaving the page mid-recording lets go of the mic
  useEffect(() => () => control.current?.cancel(), []);

  const start = async () => {
    if (control.current) return;
    setError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      const inApp = document.documentElement.classList.contains("mac-app");
      setError(
        e instanceof DOMException && e.name === "NotFoundError"
          ? "No microphone found."
          : inApp
            ? "Mic blocked. Turn it on in System Settings → Microphone."
            : "Mic blocked. Allow it from the address bar.",
      );
      return;
    }
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    let raf = 0;
    let frame = 0;
    const t0 = performance.now();
    const meter = () => {
      // every other frame is plenty for the bars
      if (frame++ % 2 === 0) {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const v of samples) sum += ((v - 128) / 128) ** 2;
        const level = Math.min(1, Math.sqrt(sum / samples.length) * 5);
        setBars((b) => [...b.slice(1), level]);
        setSeconds(Math.floor((performance.now() - t0) / 1000));
      }
      raf = requestAnimationFrame(meter);
    };
    meter();

    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    const stopped = new Promise<void>((r) => (recorder.onstop = () => r()));
    let cancelled = false;
    const limit = setTimeout(() => recorder.state === "recording" && recorder.stop(), MAX_S * 1000);
    control.current = {
      stop: () => recorder.state === "recording" && recorder.stop(),
      cancel: () => {
        cancelled = true;
        if (recorder.state === "recording") recorder.stop();
      },
    };
    recorder.start();
    setPhase("recording");

    await stopped;
    clearTimeout(limit);
    cancelAnimationFrame(raf);
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
    control.current = null;
    setBars(quiet());
    setSeconds(0);
    if (cancelled) return setPhase("idle");

    setPhase("writing");
    try {
      const text = await writeDown(new Blob(chunks, { type: recorder.mimeType }), setProgress);
      if (text) textTo.current(text);
      else setError("Didn't catch anything. Try again a little closer to the mic.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't write that down");
    }
    setProgress(null);
    setPhase("idle");
  };

  return {
    phase,
    bars,
    seconds,
    progress,
    error,
    clearError: () => setError(null),
    /** Mic button: start, or stop and write it down. */
    toggle: () => (control.current ? control.current.stop() : void start()),
    cancel: () => control.current?.cancel(),
  };
}
