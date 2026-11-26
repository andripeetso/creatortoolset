import { randomUUID } from "node:crypto";
import { rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { Hono, type Context } from "hono";
import type { AuthVars } from "./auth";
import type { SessionUser } from "./users";
import { bumpUsage } from "./users";
import { creditBack, creditOut, isOutOfCredits } from "./credits";
import { recordService } from "./lib/service-usage";
import { keyFor } from "./my-keys";
import { env } from "./lib/env";
import { SpeechFailure, providerReason, readVoicePrefs, reasonOf, speechFor } from "./lib/speech";
import { deviceTranscribes } from "./lib/device-transcribe";
import { speechCorrector, termsOf } from "./lib/speech-words";
import { videoLanguages } from "./lib/video-languages";
import { currentWorkspaceId } from "./lib/workspace-scope";
import { NeedsKey, transcribeFile, type Route } from "./library/transcribe";
import { CAPTION_LIMITS, ComputerBusy, ComputerOff, EDITOR_LIMITS, transcribeOnComputer } from "./lib/computer-transcribe";
import { SPEECH_CODE, STT_MODELS, speechReasonLine, type SpeechReason } from "../contracts/voice";
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

/** A speech failure as the contract sends it (contracts/voice.ts SPEECH_REASONS): 422 `{ error, code: "SPEECH", reason, engine? }`. */
const speechFail = (c: Context, reason: SpeechReason, engine?: string) =>
  c.json({ error: speechReasonLine(reason, engine), code: SPEECH_CODE, reason, ...(engine ? { engine } : {}) }, 422);

/** Why `user` can't transcribe in the cloud right now (locked, or no key serves them), or null. */
export function cloudTranscribeBlock(user: AuthVars["user"]): string | null {
  if (!mayUseCloud(user)) return "Transcription is locked for this account";
  return keyFor(user, "DEEPGRAM_API_KEY").missing ?? null;
}

/**
 * The model on the person's own computers their captions run on (Settings → AI → Voice, speechFor "captions"), or null:
 * the engines captions used before (their Deepgram key, else the browser's model). `languages`: the workspace's
 * (hereLanguages); none: the person's own list.
 */
export function captionsComputer(user: AuthVars["user"], languages?: string[]): { model: string; languages: string[] } | null {
  if (!mayUseCloud(user)) return null;
  const s = speechFor(user, "captions", languages);
  return !("needs" in s) && s.engine === "local" && s.on === "computers" ? { model: s.model, languages: s.languages } : null;
}

/** What `owner`'s words are rewritten to, in what an engine wrote (speechCorrector): once, where its answer comes back. */
const fixWords = <T extends TranscribeResult>(r: T, owner: string): T => {
  const fix = speechCorrector(readVoicePrefs(owner).words);
  return { ...r, words: r.words.map((w) => ({ ...w, text: fix(w.text) })) };
};

/** Why the person's computers did not write it, in a few words (the note a page shows). */
const computersWhy = (e: unknown) =>
  e instanceof ComputerOff ? "Your computers are off" : e instanceof ComputerBusy ? "Your computers are busy" : "Your computers could not do it";

/**
 * The words from `owner`'s own computers (lib/computer-transcribe.ts, the road Media Library transcripts take), or
 * why not in a few words for the note the page shows when another engine wrote them.
 */
async function wordsFromComputer(
  owner: string, pc: { model: string; languages: string[] }, audio: ArrayBuffer | Uint8Array,
  what: "captions" | "editor" = "captions",
): Promise<TranscribeResult | { why: string }> {
  const scratch = path.join(env.dataDir, "library", "scratch");
  await mkdir(scratch, { recursive: true });
  const file = path.join(scratch, `${what}-${randomUUID()}.wav`);
  await writeFile(file, new Uint8Array(audio));
  try {
    const r = await transcribeOnComputer(owner, pc.model, pc.languages, file, what === "editor" ? EDITOR_LIMITS : CAPTION_LIMITS, termsOf(readVoicePrefs(owner).words));
    return fixWords(r, owner);
  } catch (e) {
    console.warn(`[transcribe] ${what} for ${owner} not from their computers: ${e instanceof Error ? e.message : e}`);
    return { why: computersWhy(e) };
  } finally {
    await rm(file, { force: true });
  }
}

/**
 * One window of an AI Editor edit's sound (a WAV, 16 kHz mono 16-bit) heard on the computers of `owner`, the account
 * that started the edit, as its Voice settings say for the edit's `languages` (speechFor "editor": Parakeet, English
 * alone). Never anyone else's computers: the caller passes the owner it read from the stored edit, not a name it was
 * sent. `{ why }` when they can't: the worker has Deepgram write that window.
 */
export async function editorWordsFromComputer(owner: string, languages: string[] | undefined, audio: ArrayBuffer | Uint8Array): Promise<TranscribeResult | { why: string }> {
  const s = speechFor(owner, "editor", languages);
  if ("needs" in s || s.engine !== "local" || s.on !== "computers") return { why: "Not set to run on your computers" };
  return wordsFromComputer(owner, s, audio, "editor");
}

/** The languages of the videos of the workspace this request works in; undefined: the person's own list (lib/video-languages.ts). */
const hereLanguages = async (user: AuthVars["user"]) => videoLanguages(user.username, await currentWorkspaceId(user));

/** `computers`: the captions run on the person's own computers, this model's name (the page's engine label). */
transcribeApp.get("/available", async (c) => {
  const user = c.get("user");
  const missing = keyFor(user, "DEEPGRAM_API_KEY").missing;
  const pc = captionsComputer(user, await hereLanguages(user));
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

/** `error`: what the provider said (logged, never shown); `reason`: what the person is told (speech.ts). */
type Heard = { words: Word[]; language: string } | { error: string; reason: SpeechReason };

/** The first ask for these languages: a code, or "detect". */
export const firstAsk = (languages: string[]): string =>
  languages.length === 1 ? languages[0] : !languages.length || languages.includes("en") ? "en" : "detect";

/** `fillers`: keep "um", "uh". The language is the one heard. `terms`: the person's words, listened for (keyterm). */
async function deepgramWords(key: string, audio: Uint8Array | ArrayBuffer, fillers = false, languages: string[] = [], terms: string[] = []): Promise<Heard> {
  const ask = firstAsk(languages);
  const first = await deepgramAsk(key, audio, fillers, ask, terms);
  if ("error" in first || ask === "detect") return first;
  const wav = parseWav(new Uint8Array(audio));
  const seconds = wav ? wav.pcm.length / (wav.sampleRate * 2) : Math.max(0, audio.byteLength - 44) / 32000;
  if (first.words.length >= seconds * SPARSE_WPS) return first;
  const other = await deepgramAsk(key, audio, fillers, "detect", terms);
  return "error" in other || other.words.length <= first.words.length ? first : other;
}

async function deepgramAsk(key: string, audio: Uint8Array | ArrayBuffer, fillers: boolean, ask: string, terms: string[] = []): Promise<Heard> {
  const detect = ask === "detect";
  const url = DG_URL + (detect ? "&detect_language=true" : `&language=${ask}`) + (fillers ? "&filler_words=true" : "")
    + terms.map((t) => `&keyterm=${encodeURIComponent(t)}`).join("");
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
    if (isOutOfCredits(resp.status, detail)) creditOut("DEEPGRAM_API_KEY", key, "Captions and transcripts");
    return { error: `Deepgram ${resp.status}: ${detail.slice(0, 200)}`, reason: providerReason(resp.status, detail) };
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
    if (isOutOfCredits(200, detail)) creditOut("DEEPGRAM_API_KEY", key, "Captions and transcripts");
    return { error: `Deepgram: ${detail}`, reason: isOutOfCredits(200, detail) ? "rate-limit" : "unavailable" };
  }
  creditBack("DEEPGRAM_API_KEY", key);
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

type TranscriptionResult = { words: Word[]; language: string } | { error: string; reason: SpeechReason };

/** Deepgram's failure: logged in full, told as its sentence (never the provider's own text). */
const failed = (r: { error: string; reason: SpeechReason }): TranscriptionResult => {
  console.warn(`[transcribe] ${r.error}`);
  return { error: speechReasonLine(r.reason, "deepgram"), reason: r.reason };
};

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

/** `fillers`: keep filler words (the Media Library, for the AI Editor's cuts); Caption Studio leaves them out. `languages`: the workspace's or the edit's; none: the person's own list. `label`: what it is for, in the key's usage. */
export async function transcribeWav(
  audio: Uint8Array | ArrayBuffer,
  user: SessionUser,
  { fillers = false, languages, label = "Caption Studio: captions" }: { fillers?: boolean; languages?: string[]; label?: string } = {},
): Promise<TranscriptionResult> {
  const prefs = readVoicePrefs(user.username);
  const langs = languages?.length ? languages : prefs.languages;
  const terms = termsOf(prefs.words);
  const route = keyFor(user, "DEEPGRAM_API_KEY");
  if (route.missing) return { error: speechReasonLine("missing-key", "deepgram"), reason: "missing-key" };
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
      chunks.map((ch) => deepgramWords(route.key, wavWrap(ch.pcm, wav.sampleRate), fillers, langs, terms)),
    );
    const heard: { words: Word[]; language: string }[] = [];
    for (const r of results) {
      if ("error" in r) return failed(r);
      heard.push(r);
    }
    words = mergeOverlappingWindows(chunks.map((ch, k) => ({ offsetS: ch.offsetS, words: heard[k].words })));
    // the file's language: the one most of its words were heard in
    const count = new Map<string, number>();
    for (const h of heard) count.set(h.language, (count.get(h.language) ?? 0) + h.words.length);
    language = [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "en";
  } else {
    const r = await deepgramWords(route.key, audio, fillers, langs, terms);
    if ("error" in r) return failed(r);
    words = r.words;
    language = r.language;
  }
  const fix = speechCorrector(prefs.words);
  words = words.map((w) => ({ ...w, text: fix(w.text) }));

  // usage: audio length ≈ last word end; fall back to the WAV byte
  // length (16 kHz mono 16-bit) for silent clips
  const seconds = Math.round(
    words.length
      ? words[words.length - 1].end
      : Math.max(0, audio.byteLength - 44) / 32000,
  );
  bumpUsage(user.username, { cloudRuns: 1, cloudSeconds: seconds });
  void recordService({ service: "DEEPGRAM_API_KEY", key: route.key, actor: user.username, label, units: (durationS || seconds) / 60, unit: "audio minutes" });
  return { words, language };
}

transcribeApp.post("/", async (c) => {
  const user = c.get("user");
  // the page says which project it transcribes for: one the server is captioning by itself (captions-job.ts, whose
  // own request names none) gets no second transcript, paid for a second time
  if (captioning.has(c.req.query("project") ?? "")) {
    return c.json({ error: "This project's captions are already being made", code: "CAPTIONING" }, 409);
  }
  // a workspace's videos are heard in its own language (Settings → Workspace → Details)
  const languages = await hereLanguages(user);
  const pc = captionsComputer(user, languages);
  const accessError = pc ? null : cloudTranscribeBlock(user);
  if (accessError) return mayUseCloud(user) ? speechFail(c, "missing-key", "deepgram") : c.json({ error: accessError, code: "CLOUD_LOCKED" }, 403);
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
  const result = await transcribeWav(audio, user, { languages });
  if ("error" in result) return speechFail(c, result.reason, "deepgram");
  return c.json(note ? { ...result, note } : result);
});

/**
 * What writes the mic down when the person's own computers can't: This Mac's own model when this server is This Mac
 * (lib/device-transcribe.ts), else the first key the person added (Deepgram, then OpenAI); null when there is none. A
 * server that is not This Mac never writes a recording with its own model.
 */
function micFallback(user: AuthVars["user"]): { route: Route; by: string } | null {
  if (deviceTranscribes()) return { route: { provider: "device" }, by: "written by this server's model" };
  if (!mayUseCloud(user)) return null;
  for (const e of ["deepgram", "openai"] as const) {
    const k = keyFor(user, e === "deepgram" ? "DEEPGRAM_API_KEY" : "OPENAI_API_KEY");
    if (!k.missing) return { route: { provider: e, key: k.key }, by: `written by ${e === "deepgram" ? "Deepgram" : "OpenAI"}` };
  }
  return null;
}

/** Longest recording the mic takes: two minutes are 3.8 MB as the browser's WAV, under 1 MB as the phone's AAC. */
const MIC_MAX_BYTES = 10 * 1024 * 1024;

/** A short recording in the request body into a scratch file (the mic's and the live words'), or the answer refusing it. */
export async function micUpload(c: Context, max: number): Promise<{ src: string; scratch: string } | Response> {
  if (Number(c.req.header("content-length") ?? 0) > max) return c.json({ error: "That recording is too long" }, 413);
  const audio = new Uint8Array(await c.req.arrayBuffer());
  if (!audio.byteLength) return c.json({ error: "No audio" }, 400);
  if (audio.byteLength > max) return c.json({ error: "That recording is too long" }, 413);
  const scratch = path.join(env.dataDir, "library", "scratch");
  await mkdir(scratch, { recursive: true });
  const src = path.join(scratch, `mic-${randomUUID()}`);
  await writeFile(src, audio);
  return { src, scratch };
}

/**
 * Talking to the assistant (the web dock's mic and the phone's): a short recording in any common sound format (WAV, the
 * phone's m4a) → `{ text, language, engine }`, written down by the engine the person chose for `mic` (Settings → AI →
 * Voice, speechFor) in their languages. Auto is their computers or This Mac's model first, then a key they added. On
 * their own computers, when those can't (off, busy, slow, failing: MIC_LIMITS) it is written another way (micFallback)
 * with a `note` saying so. A failure answers 422 SPEECH with its reason (speechFail). The text is never sent anywhere
 * from here: it goes into the message box.
 */
transcribeApp.post("/mic", async (c) => {
  const user = c.get("user");
  const s = speechFor(user, "mic");
  // no engine: the key to add, or a computer with a speech model to turn on
  if ("needs" in s) return "key" in s && s.key ? speechFail(c, "missing-key") : speechFail(c, "computer-off", "local");
  if (s.engine !== "local" && !mayUseCloud(user)) return c.json({ error: "Transcription is locked for this account", code: "CLOUD_LOCKED" }, 403);
  const up = await micUpload(c, MIC_MAX_BYTES);
  if (up instanceof Response) return up;
  const { src, scratch } = up;
  const said = (t: Awaited<ReturnType<typeof transcribeFile>>, note?: string) =>
    c.json({ text: t.segments.map((seg) => seg.text).join(" ").trim(), language: t.language, engine: t.provider, ...(note ? { note } : {}) });
  try {
    if (s.engine === "local" && s.on === "computers") {
      try {
        return said(await transcribeFile(src, user.username, scratch, src, { use: "mic", fillers: false, soon: true }));
      } catch (e) {
        console.warn(`[transcribe] mic for ${user.username} not from their computers: ${e instanceof Error ? e.message : e}`);
        const other = micFallback(user);
        if (!other) return speechFail(c, reasonOf(e), "local");
        return said(await transcribeFile(src, user.username, scratch, src, { use: "mic", fillers: false, soon: true, route: other.route }), `${computersWhy(e)}: ${other.by}`);
      }
    }
    return said(await transcribeFile(src, user.username, scratch, src, { use: "mic", fillers: false, soon: true }));
  } catch (e) {
    if (e instanceof NeedsKey) return speechFail(c, "missing-key");
    if (e instanceof SpeechFailure) return speechFail(c, e.reason, e.engine);
    console.warn(`[transcribe] mic for ${user.username} failed: ${e instanceof Error ? e.message : e}`);
    return speechFail(c, reasonOf(e), s.engine);
  } finally {
    await rm(src, { force: true });
  }
});
