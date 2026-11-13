import { Hono } from "hono";
import type { AuthVars } from "./auth";
import type { SessionUser } from "./users";
import { bumpUsage } from "./users";
import { isOutOfCredits, outOfCreditsMessage } from "./credits";
import { keyFor } from "./my-keys";
import { captioning } from "./projects";

/**
 * Optional cloud transcription via Deepgram nova-3, on the key that serves the caller (my-keys.ts keyFor: their own
 * key from Settings → API keys, or the server's for the platform admin). The client then offers a "Cloud" engine in the model picker (better
 * accuracy + native word timestamps, no model download); without a key it says which one to add. On-device Whisper
 * remains available either way.
 */
export const transcribeApp = new Hono<{ Variables: AuthVars }>();

export const userMayCloudTranscribe = (u: AuthVars["user"]) =>
  u.role === "admin" || u.cloud;

const mayUseCloud = userMayCloudTranscribe;

/** Why `user` can't transcribe in the cloud right now (locked, or no key serves them), or null. */
export function cloudTranscribeBlock(user: AuthVars["user"]): string | null {
  if (!mayUseCloud(user)) return "Cloud transcription is locked for your account";
  return keyFor(user, "DEEPGRAM_API_KEY").missing ?? null;
}

transcribeApp.get("/available", (c) => {
  const user = c.get("user");
  const missing = keyFor(user, "DEEPGRAM_API_KEY").missing;
  return c.json({ available: !missing, allowed: mayUseCloud(user), ...(missing ? { why: missing } : {}) });
});

interface DgWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  confidence?: number;
}

interface DgUtterance {
  start: number;
  end: number;
}

/**
 * Long-file reliability: nova-3's VAD intermittently drops whole regions
 * (most often the intro) on multi-minute files, while short slices of
 * the same audio transcribe perfectly every time. So long audio goes
 * through as overlapping 45s windows — each request behaves like the
 * reliable "section" pass — and the overlaps are merged at the midpoint.
 */
const CHUNK_S = 45;
const OVERLAP_S = 2;

function parseWav(
  buf: Uint8Array,
): { sampleRate: number; pcm: Uint8Array } | null {
  if (buf.length < 44) return null;
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (v.getUint32(0, false) !== 0x52494646) return null; // "RIFF"
  let off = 12;
  let sampleRate = 16000;
  while (off + 8 <= buf.length) {
    const id = v.getUint32(off, false);
    const size = v.getUint32(off + 4, true);
    if (id === 0x666d5420 && size >= 16)
      sampleRate = v.getUint32(off + 12, true); // "fmt "
    if (id === 0x64617461) {
      // "data"
      const start = off + 8;
      return {
        sampleRate,
        pcm: buf.subarray(start, start + Math.min(size, buf.length - start)),
      };
    }
    off += 8 + size + (size % 2);
  }
  return null;
}

export function wavWrap(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const v = new DataView(out.buffer);
  const wstr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  wstr(0, "RIFF");
  v.setUint32(4, 36 + pcm.length, true);
  wstr(8, "WAVE");
  wstr(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  wstr(36, "data");
  v.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

/**
 * punctuate, not smart_format: smart_format's number formatting sometimes
 * swallows the word after a number — on a real reel "these eighteen
 * months" came back as "these 18," with "months" gone. punctuate gives
 * the same words, punctuation and capitals, with numbers spelled out.
 */
const DG_URL = "https://api.deepgram.com/v1/listen?model=nova-3&punctuate=true&utterances=true";

/**
 * Asked in English first; a window English hears next to nothing of (under `SPARSE_WPS` words a second) is asked again
 * with the language detected, and keeps whichever heard more. Estonian asked as English came back as no words at all;
 * detection alone called a quiet English clip Spanish, so it is never the first ask.
 */
export const SPARSE_WPS = 0.5;

type Heard = { words: Word[]; language: string } | { error: string; status: number };

/** `fillers`: keep "um", "uh". The language is the one heard ("en" unless detection heard more). */
async function deepgramWords(key: string, audio: Uint8Array | ArrayBuffer, fillers = false): Promise<Heard> {
  const english = await deepgramAsk(key, audio, fillers, false);
  if ("error" in english) return english;
  const wav = parseWav(new Uint8Array(audio));
  const seconds = wav ? wav.pcm.length / (wav.sampleRate * 2) : Math.max(0, audio.byteLength - 44) / 32000;
  if (english.words.length >= seconds * SPARSE_WPS) return english;
  const other = await deepgramAsk(key, audio, fillers, true);
  return "error" in other || other.words.length <= english.words.length ? english : other;
}

async function deepgramAsk(key: string, audio: Uint8Array | ArrayBuffer, fillers: boolean, detect: boolean): Promise<Heard> {
  const url = DG_URL + (detect ? "&detect_language=true" : "&language=en") + (fillers ? "&filler_words=true" : "");
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Token ${key}`,
      "Content-Type": "audio/wav",
    },
    body: audio,
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    if (isOutOfCredits(resp.status, detail)) {
      console.warn(`[deepgram] out of credits (${resp.status}): ${detail.slice(0, 200)}`);
      return {
        error: outOfCreditsMessage("Cloud transcription"),
        status: 502,
      };
    }
    return {
      error: `Deepgram ${resp.status}: ${detail.slice(0, 200)}`,
      status: 502,
    };
  }
  const data = (await resp.json()) as {
    err_code?: string;
    err_msg?: string;
    results?: {
      channels?: { alternatives?: { words?: DgWord[] }[]; detected_language?: string }[];
      utterances?: DgUtterance[];
    };
  };
  // Deepgram can report errors with a 200 status — surface them
  if (data.err_code) {
    const detail = `${data.err_code} ${data.err_msg || ""}`;
    if (isOutOfCredits(200, detail)) {
      console.warn(`[deepgram] out of credits: ${detail.slice(0, 200)}`);
      return {
        error: outOfCreditsMessage("Cloud transcription"),
        status: 502,
      };
    }
    return { error: `Deepgram: ${data.err_msg || data.err_code}`, status: 502 };
  }
  return {
    words: alignDeepgramWords(
      data.results?.channels?.[0]?.alternatives?.[0]?.words ?? [],
      data.results?.utterances,
    ),
    language: (detect && data.results?.channels?.[0]?.detected_language) || "en",
  };
}

type Word = {
  text: string;
  start: number;
  end: number;
  confidence?: number;
  utterance?: number;
  timing?: "aligned";
};

type TranscriptionResult =
  | { words: Word[]; language: string }
  | { error: string; status: 402 | 502 };

function fromDg(w: DgWord, start: number, end: number, utterance?: number): Word {
  const out: Word = {
    text: w.punctuated_word ?? w.word,
    start,
    end,
    timing: "aligned",
  };
  if (typeof w.confidence === "number" && Number.isFinite(w.confidence)) {
    out.confidence = w.confidence;
  }
  if (typeof utterance === "number") out.utterance = utterance;
  return out;
}

/** Attach each word to the utterance that contains its midpoint. */
export function alignDeepgramWords(
  raw: DgWord[],
  utterances: DgUtterance[] | undefined,
  timeOffset = 0,
  utteranceOffset = 0,
): Word[] {
  const utts = utterances ?? [];
  return raw.map((w) => {
    const mid = (w.start + w.end) / 2;
    let utterance: number | undefined;
    for (let i = 0; i < utts.length; i++) {
      if (mid >= utts[i].start - 0.02 && mid <= utts[i].end + 0.02) {
        utterance = i + utteranceOffset;
        break;
      }
    }
    return fromDg(w, w.start + timeOffset, w.end + timeOffset, utterance);
  });
}

/**
 * Join the overlapping 45 s windows into one word list. Each window owns
 * the words that start between its cut and the next window's cut (the
 * overlap midpoints), so a word heard by both windows is kept once —
 * the two copies' timestamps differ slightly, so matching them by time
 * alone left doubled words ("So So for for") at every seam.
 */
export function mergeOverlappingWindows(
  windows: { offsetS: number; words: Word[] }[],
): Word[] {
  const cutAt = (k: number) =>
    k === 0 ? -Infinity : windows[k].offsetS + OVERLAP_S / 2;
  const out: Word[] = [];
  for (let k = 0; k < windows.length; k++) {
    const { offsetS, words } = windows[k];
    const from = cutAt(k);
    const to = k + 1 < windows.length ? cutAt(k + 1) : Infinity;
    for (const w of words) {
      const start = w.start + offsetS;
      if (start < from || start >= to) continue;
      out.push({
        ...w,
        start,
        end: w.end + offsetS,
        ...(typeof w.utterance === "number"
          ? { utterance: w.utterance + k * 1000 }
          : {}),
      });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** `fillers`: keep filler words (the Media Library, for the AI Editor's cuts); Caption Studio leaves them out. */
export async function transcribeWav(
  audio: Uint8Array | ArrayBuffer,
  user: SessionUser,
  { fillers = false }: { fillers?: boolean } = {},
): Promise<TranscriptionResult> {
  const route = keyFor(user, "DEEPGRAM_API_KEY");
  if (route.missing) return { error: route.missing, status: 402 };
  const wav = parseWav(new Uint8Array(audio));
  const bytesPerSec = wav ? wav.sampleRate * 2 : 32000;
  const durationS = wav ? wav.pcm.length / bytesPerSec : 0;

  // long file → overlapping windows (see note above); short → one shot
  let words: Word[] = [];
  let language = "en";
  if (wav && durationS > CHUNK_S + OVERLAP_S) {
    const stepS = CHUNK_S - OVERLAP_S;
    const stepBytes = Math.floor(stepS * bytesPerSec) & ~1;
    const chunkBytes = Math.ceil(CHUNK_S * bytesPerSec) & ~1;
    const chunks: { offsetS: number; pcm: Uint8Array }[] = [];
    for (let off = 0; off < wav.pcm.length; off += stepBytes) {
      chunks.push({
        offsetS: off / bytesPerSec,
        pcm: wav.pcm.subarray(off, Math.min(off + chunkBytes, wav.pcm.length)),
      });
    }
    const results = await Promise.all(
      chunks.map((ch) => deepgramWords(route.key, wavWrap(ch.pcm, wav.sampleRate), fillers)),
    );
    const heard: { words: Word[]; language: string }[] = [];
    for (const r of results) {
      if ("error" in r) return { error: r.error, status: 502 };
      heard.push(r);
    }
    words = mergeOverlappingWindows(chunks.map((ch, k) => ({ offsetS: ch.offsetS, words: heard[k].words })));
    // the file's language: the one most of its words were heard in
    const count = new Map<string, number>();
    for (const h of heard) count.set(h.language, (count.get(h.language) ?? 0) + h.words.length);
    language = [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "en";
  } else {
    const r = await deepgramWords(route.key, audio, fillers);
    if ("error" in r) return { error: r.error, status: 502 };
    words = r.words;
    language = r.language;
  }

  // usage: audio length ≈ last word end; fall back to the WAV byte
  // length (16 kHz mono 16-bit) for silent clips
  const seconds = Math.round(
    words.length
      ? words[words.length - 1].end
      : Math.max(0, audio.byteLength - 44) / 32000,
  );
  bumpUsage(user.username, { cloudRuns: 1, cloudSeconds: seconds });
  return { words, language };
}

transcribeApp.post("/", async (c) => {
  const user = c.get("user");
  // the page says which project it transcribes for: one the server is captioning by itself (captions-job.ts, whose
  // own request names none) gets no second transcript, paid for a second time
  if (captioning.has(c.req.query("project") ?? "")) {
    return c.json({ error: "This project's captions are already being made: they show here when they are ready", code: "CAPTIONING" }, 409);
  }
  const accessError = cloudTranscribeBlock(user);
  if (accessError) {
    const locked = !mayUseCloud(user);
    return c.json({ error: accessError, code: locked ? "CLOUD_LOCKED" : "NEEDS_KEY" }, locked ? 403 : 402);
  }
  const audio = await c.req.arrayBuffer();
  if (!audio.byteLength) return c.json({ error: "No audio" }, 400);
  const result = await transcribeWav(audio, user);
  if ("error" in result) return c.json({ error: result.error }, result.status);
  return c.json(result);
});
