import { useEffect, useRef, useState } from "react";
import { SPEECH_CODE, type SpeechReason, type VoiceView } from "../../contracts/voice";
import { CLOUD_MODEL_ID, MODELS, detectDevice, storedEngine, transcribeAudio } from "./transcribe";
import { interimWords } from "./voice-interim";

/**
 * Talk instead of type (the assistant's mic). While the person talks, the words so far show in the dock (interim): the
 * server's engine for the mic writes the audio so far (POST /api/transcribe/live), or Whisper in the browser when the
 * server has none and none was chosen. At stop the whole recording is written down once (POST /api/transcribe/mic,
 * or the browser) and replaces the interim words. The words go into the message box, never straight out: you read them
 * before you send.
 */

export type VoicePhase = "idle" | "recording" | "writing";

/** A line the dock shows, with the Settings page that fixes it when there is one. */
export interface VoiceFault {
  line: string;
  next?: { label: string; to: string };
}

/** Writing down failed for a reason the server named (422 SPEECH): the dock shows its fault. */
export class SpeechFault extends Error {
  readonly fault: VoiceFault;
  constructor(fault: VoiceFault) {
    super(fault.line);
    this.fault = fault;
  }
}

/** Where the next step for a reason is: a key (Settings → API keys) or the engine and model (Settings → AI → Voice). */
export function speechNextStep(reason: SpeechReason): { label: string; to: string } {
  return reason === "missing-key" || reason === "rejected-key"
    ? { label: "Open API keys", to: "/settings/keys" }
    : { label: "Open Voice settings", to: "/settings/voice" };
}

const REASON_LINE: Record<SpeechReason, string> = {
  "missing-key": "Needs a speech key",
  "rejected-key": "The speech key was refused",
  "rate-limit": "Speech is rate-limited for now",
  "model-unavailable": "Needs a speech model",
  "computer-off": "Your computers are off",
  unavailable: "Could not write down the recording",
};

/** The fault a server answer names: its own line, else the reason's, and the next step for that reason. */
export function speechFault(body: { error?: string; reason?: string }): VoiceFault {
  const reason = (body.reason ?? "unavailable") as SpeechReason;
  const known = reason in REASON_LINE ? reason : "unavailable";
  return { line: body.error || REASON_LINE[known], next: speechNextStep(known) };
}

/** Longest message you can speak in one go. */
const MAX_S = 120;
/** How often the words so far are written down while the person talks. */
const INTERIM_EVERY_MS = 2000;
/** Bars in the live mic meter. */
export const BARS = 28;
const quiet = () => Array<number>(BARS).fill(0);

/** Any recording → 16 kHz mono samples (what both engines take). decodeAudioData resamples to the context's rate. */
async function toPcm16k(blob: Blob): Promise<Float32Array> {
  const audio = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(await blob.arrayBuffer());
  return audio.getChannelData(0);
}

/** The browser's own model for speech (the one Caption Studio picked, else the first). */
const browserModel = () => {
  const engine = storedEngine();
  return engine && engine !== CLOUD_MODEL_ID ? engine : MODELS[0].id;
};

/** Whether this browser can run the speech model at all. */
const browserCanWrite = () => typeof WebAssembly !== "undefined" && typeof Worker !== "undefined";

/**
 * The words, and `note` when another engine than the chosen one wrote them (the person's computers couldn't): the
 * server's own note, or why its computers didn't when the browser wrote it. `signal` cancels the write: a cancelled
 * request throws, and a browser run is stopped.
 */
export async function writeDown(recording: Blob, onProgress: (p: number) => void, signal?: AbortSignal): Promise<{ text: string; note?: string }> {
  const res = await fetch("/api/transcribe/mic", { method: "POST", headers: { "Content-Type": recording.type || "application/octet-stream" }, body: recording, signal });
  if (res.ok) return (await res.json()) as { text: string; note?: string };
  const e = (await res.json().catch(() => ({}))) as { error?: string; code?: string; reason?: string; chosen?: boolean; why?: string };
  if (e.code === SPEECH_CODE) throw new SpeechFault(speechFault(e));
  // an engine the person picked that can't run says what it needs; only Automatic falls back to the browser's model
  if (e.code === "NEEDS_KEY" && e.chosen) throw new SpeechFault(speechFault({ error: e.error, reason: "missing-key" }));
  if ((e.code !== "NEEDS_KEY" && e.code !== "CLOUD_LOCKED") || e.chosen) throw new Error(e.error || "Could not transcribe");
  // no engine on the server for this account: the browser's model
  const job = transcribeAudio(await toPcm16k(recording), browserModel(), null, await detectDevice(), { onLoadProgress: onProgress });
  signal?.addEventListener("abort", () => job.cancel(), { once: true });
  const words = await job.promise;
  const text = words
    .map((w) => w.text.trim())
    .filter(Boolean)
    .join(" ");
  return e.why ? { text, note: `${e.why}: written in the browser` } : { text };
}

/** The words so far from the server's engine for the mic (interim: no fallback, no paid engine). */
async function liveWords(recording: Blob, signal: AbortSignal): Promise<string | null> {
  const res = await fetch("/api/transcribe/live", { method: "POST", headers: { "Content-Type": recording.type || "application/octet-stream" }, body: recording, signal });
  if (!res.ok) return null;
  return ((await res.json()) as { text?: string }).text ?? null;
}

/** The words so far from the browser's model, run on the audio so far; a new pass stops the one before it. */
async function browserLiveWords(recording: Blob, signal: AbortSignal): Promise<string | null> {
  const pcm = await toPcm16k(recording);
  const device = await detectDevice();
  if (signal.aborted) return null;
  const job = transcribeAudio(pcm, browserModel(), null, device, {});
  signal.addEventListener("abort", () => job.cancel(), { once: true });
  return (await job.promise)
    .map((w) => w.text.trim())
    .filter(Boolean)
    .join(" ");
}

type WriteRoute = { via: "server"; live: boolean } | { via: "browser" } | { fault: VoiceFault };

/**
 * Who writes the words for the mic, before anything records: the server's engine (`live`: it is a local one, so words
 * can come while talking), else the browser's model when the server has none and the person chose none, else what
 * they need (Settings → AI → Voice, or a key).
 */
async function writeRoute(): Promise<WriteRoute> {
  const prefs = (await fetch("/api/voice-prefs")
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)) as VoiceView | null;
  const mic = prefs?.resolved.find((r) => r.use === "mic");
  if (!prefs || !mic) return { via: "server", live: false };
  if (!("needs" in mic)) return { via: "server", live: mic.engine === "local" };
  const chosen = (prefs.stt.per.mic ?? prefs.stt.default).engine !== "auto";
  if (chosen || !browserCanWrite()) return { fault: { line: mic.needs, next: speechNextStep(mic.key ? "missing-key" : "model-unavailable") } };
  return { via: "browser" };
}

export function useVoiceInput(onText: (text: string) => void) {
  const [phase, setPhase] = useState<VoicePhase>("idle");
  /** The mic's level (0–1) over the last moments, oldest first: the live bars. */
  const [bars, setBars] = useState<number[]>(quiet);
  const [seconds, setSeconds] = useState(0);
  /** The words heard so far while recording; the final text replaces them at stop. */
  const [interim, setInterim] = useState("");
  /** First-time model download, 0–1; null when there's nothing to download. */
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<VoiceFault | null>(null);
  const control = useRef<{ stop: () => void; cancel: () => void } | null>(null);
  const textTo = useRef(onText);
  useEffect(() => {
    textTo.current = onText;
  });

  // leaving the page mid-recording lets go of the mic
  useEffect(() => () => control.current?.cancel(), []);

  const start = async () => {
    if (control.current) return;
    // held from the first tap, before the browser has given the mic: a second tap while it asks starts nothing more,
    // and leaving the page then lets go of the mic as soon as it comes
    let cancelled = false;
    control.current = { stop: () => {}, cancel: () => void (cancelled = true) };
    setError(null);
    const route = await writeRoute();
    if (cancelled || "fault" in route) {
      control.current = null;
      if ("fault" in route) setError(route.fault);
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      control.current = null;
      const inApp = document.documentElement.classList.contains("mac-app");
      setError({
        line:
          e instanceof DOMException && e.name === "NotFoundError"
            ? "No microphone found."
            : inApp
              ? "Mic blocked. Turn it on in System Settings → Microphone."
              : "Mic blocked. Allow it from the address bar.",
      });
      return;
    }
    if (cancelled) {
      stream.getTracks().forEach((t) => t.stop());
      control.current = null;
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
    const limit = setTimeout(() => recorder.state === "recording" && recorder.stop(), MAX_S * 1000);
    // the audio so far, as one recording: the first chunk carries the container's header
    const soFar = () => new Blob(chunks, { type: recorder.mimeType });
    const live =
      route.via === "browser"
        ? interimWords((sig) => browserLiveWords(soFar(), sig), setInterim, INTERIM_EVERY_MS)
        : route.live
          ? interimWords((sig) => liveWords(soFar(), sig), setInterim, INTERIM_EVERY_MS)
          : null;
    const halt = () => {
      live?.stop();
      setInterim("");
    };
    control.current = {
      stop: () => {
        halt();
        if (recorder.state === "recording") recorder.stop();
      },
      cancel: () => {
        cancelled = true;
        halt();
        if (recorder.state === "recording") recorder.stop();
      },
    };
    recorder.start(1000);
    setPhase("recording");

    await stopped;
    clearTimeout(limit);
    cancelAnimationFrame(raf);
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
    halt();
    setBars(quiet());
    setSeconds(0);
    if (cancelled) {
      control.current = null;
      return setPhase("idle");
    }

    // writing down can be cancelled too: the request is aborted and a late answer is dropped
    const abort = new AbortController();
    control.current = {
      stop: () => {},
      cancel: () => {
        cancelled = true;
        abort.abort();
      },
    };
    setPhase("writing");
    try {
      const { text } = await writeDown(new Blob(chunks, { type: recorder.mimeType }), setProgress, abort.signal);
      if (!cancelled) {
        if (text) textTo.current(text);
        setError(text ? null : { line: "Didn't catch anything. Try again a little closer to the mic." });
      }
    } catch (e) {
      if (!cancelled) setError(e instanceof SpeechFault ? e.fault : { line: e instanceof Error ? e.message : "Could not transcribe" });
    } finally {
      control.current = null;
      setProgress(null);
      setPhase("idle");
    }
  };

  return {
    phase,
    bars,
    seconds,
    interim,
    progress,
    error,
    clearError: () => setError(null),
    /** Mic button: start, or stop and write it down. */
    toggle: () => (control.current ? control.current.stop() : void start()),
    /** Stops a recording without writing it, or drops a write in progress. */
    cancel: () => control.current?.cancel(),
  };
}
