import { create } from "zustand";

/**
 * "Read replies aloud" for the assistant: each new reply is spoken. The voice is Kokoro, a small open speech model
 * that runs in the browser (workers/speak.worker.ts; ~90 MB, downloaded the first time, then cached). Where it
 * can't run, the computer's own voice reads instead. An add-on, off by default: switched on per browser in
 * Settings → General (localStorage), never from the dock.
 */

// a new key: everyone who had the dock's old speaker switch on starts off again
const KEY = "ct-assistant:read-aloud";

const stored = (): boolean => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};

type ReadAloud = {
  on: boolean;
  /** Speaking right now (the speaker in the header moves). */
  speaking: boolean;
  /** First-time voice download, 0–1; null when there's nothing to download. */
  loading: number | null;
  toggle: () => void;
};

export const useReadAloud = create<ReadAloud>((set, get) => ({
  on: stored(),
  speaking: false,
  loading: null,
  toggle: () => {
    const on = !get().on;
    try {
      localStorage.setItem(KEY, on ? "1" : "0");
    } catch {
      /* the switch still applies on this page */
    }
    if (on) {
      unlockAudio();
      warmUp();
    } else stopSpeaking();
    set({ on });
  },
}));

export const canSpeak = (): boolean => typeof window !== "undefined" && (typeof Worker !== "undefined" || "speechSynthesis" in window);

/** The reply as it sounds: no markdown marks, links read as their words, code and tables skipped. */
export function spoken(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*\|.*\|\s*$/gm, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[*_`#>~]+/g, "")
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/* ---- Kokoro in a worker, its sentences played back to back ---- */

let worker: Worker | null = null;
let audio: AudioContext | null = null;
let nextId = 0;
let playing = 0;
/** When the next sentence starts on the audio clock. */
let cursor = 0;
let sources: AudioBufferSourceNode[] = [];
/** The last reply the worker has made every sentence of. */
let finished = -1;
/** What's being read, for the computer's voice to take over if Kokoro fails. */
let pendingText = "";
/** Kokoro failed to load here: the computer's voice reads from now on. */
let kokoroBroken = false;

/** Browsers only let a page make sound after a click: call this from one (the switch, Send). */
export function unlockAudio(): void {
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") void audio.resume();
  } catch {
    /* no Web Audio: the computer's voice still works */
  }
}

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("../workers/speak.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (ev) => {
    const m = ev.data as { type: string; id: number; progress?: number; samples?: Float32Array; rate?: number; message?: string; text?: string };
    if (m.type === "load-progress") useReadAloud.setState({ loading: m.progress ?? 0 });
    else if (m.type === "ready") useReadAloud.setState({ loading: null });
    else if (m.id !== playing) return;
    else if (m.type === "audio" && m.samples && audio) {
      const buf = audio.createBuffer(1, m.samples.length, m.rate ?? 24000);
      buf.copyToChannel(m.samples as Float32Array<ArrayBuffer>, 0);
      const src = audio.createBufferSource();
      src.buffer = buf;
      src.connect(audio.destination);
      cursor = Math.max(cursor, audio.currentTime + 0.05);
      src.start(cursor);
      cursor += buf.duration;
      sources.push(src);
      useReadAloud.setState({ speaking: true });
      src.onended = () => {
        sources = sources.filter((s) => s !== src);
        if (!sources.length && finished === m.id) useReadAloud.setState({ speaking: false });
      };
    } else if (m.type === "end") {
      finished = m.id;
      if (!sources.length) useReadAloud.setState({ speaking: false });
    } else if (m.type === "error") {
      console.warn("[read aloud] the local voice failed, using the computer's own:", m.message);
      kokoroBroken = true;
      useReadAloud.setState({ loading: null });
      systemSpeak(pendingText);
    }
  };
  return worker;
}

/** Turning it on starts the download, so the first reply doesn't wait for it. */
function warmUp(): void {
  if (!kokoroBroken && audio) getWorker().postMessage({ type: "speak", id: ++nextId, text: "" });
}

export function speak(text: string): void {
  const words = spoken(text);
  if (!words) return;
  stopSpeaking();
  if (kokoroBroken || !audio || typeof Worker === "undefined") return systemSpeak(words);
  pendingText = words;
  playing = ++nextId;
  getWorker().postMessage({ type: "speak", id: playing, text: words });
}

export function stopSpeaking(): void {
  playing = -1;
  worker?.postMessage({ type: "stop" });
  for (const s of sources) {
    try {
      s.stop();
    } catch {
      /* already ended */
    }
  }
  sources = [];
  cursor = 0;
  if (typeof window !== "undefined" && "speechSynthesis" in window) speechSynthesis.cancel();
  useReadAloud.setState({ speaking: false });
}

/* ---- the computer's own voice, where Kokoro can't run ---- */

/** The nicest local voice in the page's language: the system's enhanced or natural voices first. */
function bestVoice(): SpeechSynthesisVoice | undefined {
  const lang = (navigator.language || "en").slice(0, 2);
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith(lang));
  const rank = (v: SpeechSynthesisVoice) =>
    (/premium|enhanced|natural|neural/i.test(v.name) ? 4 : 0) + (/google/i.test(v.name) ? 2 : 0) + (v.localService ? 1 : 0);
  return voices.sort((a, b) => rank(b) - rank(a))[0];
}

function systemSpeak(words: string): void {
  if (!words || !("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(words);
  const voice = bestVoice();
  if (voice) u.voice = voice;
  u.onstart = () => useReadAloud.setState({ speaking: true });
  u.onend = u.onerror = () => useReadAloud.setState({ speaking: false });
  speechSynthesis.speak(u);
}
