import { randomUUID } from "node:crypto";
import { rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import type { AuthVars } from "./auth";
import type { SessionUser } from "./users";
import { bumpUsage } from "./users";
import { isOutOfCredits, outOfCreditsMessage } from "./credits";
import { keyFor } from "./my-keys";
import { env } from "./lib/env";
import { readVoicePrefs, speechFor } from "./lib/speech";
import { NeedsKey, transcribeFile } from "./library/transcribe";
import { CAPTION_LIMITS, ComputerBusy, ComputerOff, transcribeOnComputer } from "./lib/computer-transcribe";
import { STT_MODELS } from "../contracts/voice";
import type { TranscribeResult } from "../contracts/devices";
import { captioning } from "./projects";

/**
 * Optional cloud transcription via Deepgram nova-3, on the key that serves the caller (my-keys.ts keyFor: their own
 * key from Settings → API keys, or the server's for the platform admin). The client then offers a "Cloud" engine in the model picker (better
 * accuracy + native word timestamps, no model download); without a key it says which one to add. On-device Whisper
 * remains available either way. When the person's captions run on their own computers (Settings → AI → Voice), the same
 * route asks those first (captionsComputer).
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

/**
 * The model on the person's own computers their captions run on (Settings → AI → Voice, speechFor "captions"), or null:
 * the engines captions used before (their Deepgram key, else the browser's model).
 */
export function captionsComputer(user: AuthVars["user"]): { model: string; languages: string[] } | null {
  if (!mayUseCloud(user)) return null;
  const s = speechFor(user, "captions");
  return !("needs" in s) && s.engine === "local" && s.on === "computers" ? { model: s.model, languages: s.languages } : null;
}

/**
 * The words from the person's own computers (lib/computer-transcribe.ts, the road Media Library transcripts take), or
 * why not in a few words for the note the page shows when another engine wrote them.
 */
async function wordsFromComputer(owner: string, pc: { model: string; languages: string[] }, audio: ArrayBuffer): Promise<TranscribeResult | { why: string }> {
  const scratch = path.join(env.dataDir, "library", "scratch");
  await mkdir(scratch, { recursive: true });
  const file = path.join(scratch, `captions-${randomUUID()}.wav`);
  await writeFile(file, new Uint8Array(audio));
  try {
    return await transcribeOnComputer(owner, pc.model, pc.languages, file, CAPTION_LIMITS);
  } catch (e) {
    console.warn(`[transcribe] captions for ${owner} not from their computers: ${e instanceof Error ? e.message : e}`);
    return { why: e instanceof ComputerOff ? "Your computers are off" : e instanceof ComputerBusy ? "Your computers are busy" : "Your computers could not do it" };
  } finally {
    await rm(file, { force: true });
  }
}

/** `computers`: the captions run on the person's own computers, this model's name (the page's engine label). */
transcribeApp.get("/available", (c) => {
  const user = c.get("user");
  const missing = keyFor(user, "DEEPGRAM_API_KEY").missing;
  const pc = captionsComputer(user);
  const computers = pc && (STT_MODELS.find((m) => m.id === pc.model)?.name ?? pc.model);
  return c.json({ available: !missing || !!pc, allowed: mayUseCloud(user), ...(computers ? { computers } : missing ? { why: missing } : {}) });
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
 * Asked first in the person's language (Settings → AI → Voice: their one language, else English when it is one of theirs
 * or none is set, else detected); a window that ask hears next to nothing of (under `SPARSE_WPS` words a second) is asked
 * again with the language detected, and keeps whichever heard more. Estonian asked as English came back as no words at
 * all; detection alone called a quiet English clip Spanish, so it is not the first ask while English may be spoken.
 */
export const SPARSE_WPS = 0.5;

type Heard = { words: Word[]; language: string } | { error: string; status: number };

/** The first ask for these languages: a code, or "detect". */
export const firstAsk = (languages: string[]): string =>
  languages.length === 1 ? languages[0] : !languages.length || languages.includes("en") ? "en" : "detect";

/** `fillers`: keep "um", "uh". The language is the one heard. */
async function deepgramWords(key: string, audio: Uint8Array | ArrayBuffer, fillers = false, languages: string[] = []): Promise<Heard> {
  const ask = firstAsk(languages);
  const first = await deepgramAsk(key, audio, fillers, ask);
  if ("error" in first || ask === "detect") return first;
  const wav = parseWav(new Uint8Array(audio));
  const seconds = wav ? wav.pcm.length / (wav.sampleRate * 2) : Math.max(0, audio.byteLength - 44) / 32000;
  if (first.words.length >= seconds * SPARSE_WPS) return first;
  const other = await deepgramAsk(key, audio, fillers, "detect");
  return "error" in other || other.words.length <= first.words.length ? first : other;
}

async function deepgramAsk(key: string, audio: Uint8Array | ArrayBuffer, fillers: boolean, ask: string): Promise<Heard> {
  const detect = ask === "detect";
  const url = DG_URL + (detect ? "&detect_language=true" : `&language=${ask}`) + (fillers ? "&filler_words=true" : "");
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
    language: detect ? data.results?.channels?.[0]?.detected_language || "en" : ask,
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
  { fillers = false, languages }: { fillers?: boolean; languages?: string[] } = {},
): Promise<TranscriptionResult> {
  const langs = languages?.length ? languages : readVoicePrefs(user.username).languages;
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
      chunks.map((ch) => deepgramWords(route.key, wavWrap(ch.pcm, wav.sampleRate), fillers, langs)),
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
    const r = await deepgramWords(route.key, audio, fillers, langs);
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
  const pc = captionsComputer(user);
  const accessError = pc ? null : cloudTranscribeBlock(user);
  if (accessError) {
    const locked = !mayUseCloud(user);
    return c.json({ error: accessError, code: locked ? "CLOUD_LOCKED" : "NEEDS_KEY" }, locked ? 403 : 402);
  }
  const audio = await c.req.arrayBuffer();
  if (!audio.byteLength) return c.json({ error: "No audio" }, 400);
  // on their own computers; when those can't, their Deepgram key, else the page's own model (USE_BROWSER), said quietly
  let note: string | undefined;
  if (pc) {
    const r = await wordsFromComputer(user.username, pc, audio);
    if (!("why" in r)) return c.json({ words: r.words, language: r.language ?? pc.languages[0] ?? null });
    if (cloudTranscribeBlock(user)) return c.json({ error: r.why, code: "USE_BROWSER", why: r.why }, 503);
    note = `${r.why}: written by Deepgram`;
  }
  const result = await transcribeWav(audio, user);
  if ("error" in result) return c.json({ error: result.error }, result.status);
  return c.json(note ? { ...result, note } : result);
});

/** Longest recording the mic takes: two minutes are 3.8 MB as the browser's WAV, under 1 MB as the phone's AAC. */
const MIC_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Talking to the assistant (the web dock's mic and the phone's): a short recording in any format ffmpeg reads (WAV, the
 * phone's m4a) → `{ text, language }`, written down by the engine the person chose for `mic` (Settings → AI → Voice,
 * speechFor) in their languages. With no engine it answers NEEDS_KEY and what to add. The text is never sent anywhere
 * from here: it goes into the message box.
 */
transcribeApp.post("/mic", async (c) => {
  const user = c.get("user");
  const s = speechFor(user, "mic");
  if ("needs" in s) {
    // `chosen`: the person picked this engine (Settings → AI → Voice), so a page says what it needs instead of
    // quietly writing it down another way; on Automatic it may still use a model in the browser
    const prefs = readVoicePrefs(user.username);
    const chosen = (prefs.stt.per.mic ?? prefs.stt.default).engine !== "auto";
    return c.json({ error: s.needs, code: "NEEDS_KEY", chosen }, 402);
  }
  if (s.engine !== "local" && !mayUseCloud(user)) return c.json({ error: "Cloud transcription is locked for your account", code: "CLOUD_LOCKED" }, 403);
  if (Number(c.req.header("content-length") ?? 0) > MIC_MAX_BYTES) return c.json({ error: "That recording is too long" }, 413);
  const audio = new Uint8Array(await c.req.arrayBuffer());
  if (!audio.byteLength) return c.json({ error: "No audio" }, 400);
  if (audio.byteLength > MIC_MAX_BYTES) return c.json({ error: "That recording is too long" }, 413);
  const scratch = path.join(env.dataDir, "library", "scratch");
  await mkdir(scratch, { recursive: true });
  const src = path.join(scratch, `mic-${randomUUID()}`);
  await writeFile(src, audio);
  try {
    const t = await transcribeFile(src, user.username, scratch, src, { use: "mic", fillers: false, soon: true });
    return c.json({ text: t.segments.map((seg) => seg.text).join(" ").trim(), language: t.language });
  } catch (e) {
    if (e instanceof NeedsKey) return c.json({ error: e.message, code: "NEEDS_KEY" }, 402);
    return c.json({ error: e instanceof Error ? e.message : "Couldn't write that down" }, 502);
  } finally {
    await rm(src, { force: true });
  }
});
