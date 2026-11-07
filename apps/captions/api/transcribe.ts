import { Hono } from "hono";
import type { AuthVars } from "./auth";
import type { SessionUser } from "./users";
import { bumpUsage } from "./users";
import { isOutOfCredits, outOfCreditsMessage } from "./credits";
import { keyFor } from "./my-keys";
import { addSpend } from "./lib/workspaces";
import { GUEST_CLIP_S, GUEST_OUT_OF_CREDITS, logGuestRun, takeGuest } from "./guest";

/**
 * Optional cloud transcription via Deepgram nova-3, on the key that serves the caller (my-keys.ts keyFor: their own
 * key from Settings → My API keys; the server's for the platform admin, a member on an API budget, billed to them,
 * or guests when an admin switched that on). The client then offers a "Cloud" engine in the model picker (better
 * accuracy + native word timestamps, no model download); without a key it says which one to add. On-device Whisper
 * remains available either way.
 */
export const transcribeApp = new Hono<{ Variables: AuthVars }>();

export const userMayCloudTranscribe = (u: AuthVars["user"]) =>
  u.role === "admin" || u.cloud;

const mayUseCloud = (u: AuthVars["user"]) =>
  userMayCloudTranscribe(u) || u.role === "guest";

// ponytail: one flat, rounded-up rate per minute of audio for a budget member's transcripts (Deepgram here, the
// OpenAI-compatible path in library/transcribe.ts); set it from your provider's price sheet
export const transcribeUsdPerMinute = () => Number(process.env.LIBRARY_TRANSCRIBE_USD_PER_MIN) || 0.01;

/** Why `user` can't transcribe in the cloud right now (locked, or no key serves them), or null. */
export function cloudTranscribeBlock(user: AuthVars["user"]): string | null {
  if (!mayUseCloud(user)) {
    return user.role === "guest"
      ? "Cloud transcription is not available in guest mode — sign in with an account"
      : "Cloud transcription is locked for your account — ask the admin";
  }
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

function wavWrap(pcm: Uint8Array, sampleRate: number): Uint8Array {
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
const DG_URL =
  "https://api.deepgram.com/v1/listen?model=nova-3&punctuate=true&utterances=true&language=en";

/** `optOut`: Deepgram keeps nothing past the request (guests; costs ~2× the listed rate). */
async function deepgramWords(
  key: string,
  audio: Uint8Array | ArrayBuffer,
  optOut = false,
): Promise<{ words: Word[] } | { error: string; status: number }> {
  const resp = await fetch(optOut ? `${DG_URL}&mip_opt_out=true` : DG_URL, {
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
      channels?: { alternatives?: { words?: DgWord[] }[] }[];
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
  | { words: Word[] }
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

export async function transcribeWav(
  audio: Uint8Array | ArrayBuffer,
  user: SessionUser,
): Promise<TranscriptionResult> {
  const route = keyFor(user, "DEEPGRAM_API_KEY");
  if (route.missing) return { error: route.missing, status: 402 };
  // guests' audio is strangers' audio: out of Deepgram's model training
  const optOut = user.role === "guest";
  const wav = parseWav(new Uint8Array(audio));
  const bytesPerSec = wav ? wav.sampleRate * 2 : 32000;
  const durationS = wav ? wav.pcm.length / bytesPerSec : 0;

  // long file → overlapping windows (see note above); short → one shot
  let words: Word[] = [];
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
      chunks.map((ch) => deepgramWords(route.key, wavWrap(ch.pcm, wav.sampleRate), optOut)),
    );
    for (const r of results) {
      if ("error" in r) return { error: r.error, status: 502 };
    }
    words = mergeOverlappingWindows(
      chunks.map((ch, k) => ({
        offsetS: ch.offsetS,
        words: (results[k] as { words: Word[] }).words,
      })),
    );
  } else {
    const r = await deepgramWords(route.key, audio, optOut);
    if ("error" in r) return { error: r.error, status: 502 };
    words = r.words;
  }

  // usage: audio length ≈ last word end; fall back to the WAV byte
  // length (16 kHz mono 16-bit) for silent clips
  const seconds = Math.round(
    words.length
      ? words[words.length - 1].end
      : Math.max(0, audio.byteLength - 44) / 32000,
  );
  bumpUsage(user.username, { cloudRuns: 1, cloudSeconds: seconds });
  // billed by the audio's length, as the provider bills it
  if (route.bill) addSpend(route.bill, ((durationS || seconds) / 60) * transcribeUsdPerMinute());
  return { words };
}

/** The request body, or null once it passes `max` bytes (the rest is never read). */
async function bodyUpTo(req: Request, max: number): Promise<Uint8Array | null> {
  if (Number(req.headers.get("content-length")) > max) return null;
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = (await reader?.read()) ?? { done: true, value: undefined };
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      void reader!.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

transcribeApp.post("/", async (c) => {
  const user = c.get("user");
  const accessError = cloudTranscribeBlock(user);
  if (accessError) {
    const locked = !mayUseCloud(user);
    return c.json({ error: accessError, code: locked ? "CLOUD_LOCKED" : "NEEDS_KEY" }, locked ? 403 : 402);
  }
  const guest = user.role === "guest";
  // guests: the client sends 16 kHz mono 16-bit, so bytes cap the clip —
  // read no further than that (this route has no body limit, see boot.ts)
  const audio = guest
    ? await bodyUpTo(c.req.raw, GUEST_CLIP_S * 32000 + 1024)
    : await c.req.arrayBuffer();
  if (!audio) {
    return c.json(
      { error: "Guest mode transcribes videos up to 3 minutes — sign in with an account for longer ones", code: "GUEST_LIMIT" },
      413,
    );
  }
  if (!audio.byteLength) return c.json({ error: "No audio" }, 400);
  const wav = parseWav(new Uint8Array(audio));
  const seconds = wav
    ? wav.pcm.length / (wav.sampleRate * 2)
    : Math.max(0, audio.byteLength - 44) / 32000;
  if (guest) {
    const refusal = takeGuest(user, "seconds", Math.ceil(seconds));
    if (refusal) return c.json({ error: refusal, code: "GUEST_LIMIT" }, 429);
  }
  const result = await transcribeWav(audio, user);
  if ("error" in result) {
    const empty = guest && result.error === outOfCreditsMessage("Cloud transcription");
    return c.json({ error: empty ? GUEST_OUT_OF_CREDITS : result.error }, result.status);
  }
  if (guest) {
    let file = "";
    try {
      file = decodeURIComponent(c.req.header("x-file-name") ?? "").slice(0, 200);
    } catch {
      /* a malformed name stays blank */
    }
    void logGuestRun({
      at: Date.now(),
      guest: user.username,
      file,
      seconds: Math.round(seconds),
      text: result.words.map((w) => w.text).join(" "),
    });
  }
  return c.json(result);
});
