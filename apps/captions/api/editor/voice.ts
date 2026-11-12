import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono, type Context } from "hono";
import type { MadeVoice, Voice, VoicesView } from "../../contracts/editor";
import type { AuthVars } from "../auth";
import { isOutOfCredits } from "../credits";
import { ensureLibrary } from "../library/access";
import { libraryDb } from "../library/db";
import { saveToLibrary } from "../library/routes";
import { mainSource } from "../library/sources";
import { keyFor } from "../my-keys";
import { change, read } from "./styles";

/**
 * A voice made from text, for a video with nothing filmed: the script is spoken by one of the person's ElevenLabs
 * voices (their own key, their own credits) and saved in their Media Library as a recording. That recording is a take
 * like any other: an edit made from it has no picture of its own, so its whole picture comes from B-roll (broll.ts).
 * Mounted at /api/editor/voice, before /:id.
 *   GET  /   → VoicesView (the account's voices, its own first, and the one used last)
 *   POST /   { text, voice?: id or name, name? } → MadeVoice; `voice` left out = the one used last
 */

const API = "https://api.elevenlabs.io";
/** The longest text spoken in one go: about six minutes of speech, under what every ElevenLabs model takes in one request. */
export const MAX_VOICE_CHARS = 5000;
/** A voice the account made (or cloned), not one ElevenLabs gives everyone. */
const OWN = new Set(["cloned", "generated", "professional"]);

/** What went wrong, as the person reads it; `status` is the answer's. */
export class VoiceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 402 | 502 = 400,
  ) {
    super(message);
  }
}

/** A call to ElevenLabs on `key`; an answer that is not ok becomes a sentence. */
async function call(key: string, url: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${API}${url}`, { ...init, headers: { "xi-api-key": key, ...init.headers }, signal: AbortSignal.timeout(5 * 60_000) });
  } catch (e) {
    throw new VoiceError(`ElevenLabs did not answer (${e instanceof Error ? e.message : String(e)}): try again.`, 502);
  }
  if (res.ok) return res;
  const body = (await res.text().catch(() => "")).slice(0, 600);
  // { detail: { status, message } }, or FastAPI's { detail: [{ msg }] }
  const said = (() => {
    try {
      const d = (JSON.parse(body) as { detail?: unknown }).detail;
      const one = Array.isArray(d) ? d[0] : d;
      return typeof one === "string" ? one : String((one as { message?: unknown; msg?: unknown })?.message ?? (one as { msg?: unknown })?.msg ?? "");
    } catch {
      return "";
    }
  })();
  if (isOutOfCredits(res.status, body)) throw new VoiceError("Your ElevenLabs account is out of credits: add credits at elevenlabs.io, then try again.", 402);
  if (res.status === 401) throw new VoiceError(`ElevenLabs refused the key${said ? ` (${said})` : ""}: check it in Settings → API keys. A key limited to some features needs Text to Speech and Voices.`);
  if (res.status === 429) throw new VoiceError("ElevenLabs is busy: try again in a minute.", 502);
  throw new VoiceError(`ElevenLabs answered ${res.status}${said ? `: ${said}` : ""}`, 502);
}

/** The key the voice runs on: the person's own (the server's only for its admin), or the sentence that says where to add it. */
function keyOf(user: AuthVars["user"]): string {
  const r = keyFor(user, "ELEVENLABS_API_KEY");
  if (r.missing) throw new VoiceError(r.missing);
  return r.key;
}

/**
 * The account's voices, its own first.
 * ponytail: the first 100 (one page); follow next_page_token, or pass a search, when someone has more.
 */
export async function voicesOf(key: string): Promise<Voice[]> {
  const res = await call(key, "/v2/voices?page_size=100&include_total_count=false");
  const { voices = [] } = (await res.json()) as { voices?: { voice_id: string; name?: string; category?: string; preview_url?: string | null }[] };
  return voices
    .map((v) => ({ id: v.voice_id, name: v.name || v.voice_id, own: OWN.has(v.category ?? ""), ...(v.preview_url ? { preview: v.preview_url } : {}) }))
    .sort((a, b) => Number(b.own) - Number(a.own));
}

/** The voice the person used last, by id. */
export const lastVoice = (username: string): string | null => read(username).voice ?? null;

/** The voice `wanted` names (an id, or a name in any case), or the one used last; else what there is to choose from, as a sentence. */
function pickVoice(voices: Voice[], wanted: string, last: string | null): Voice {
  const w = wanted.trim().toLowerCase();
  const found = w ? voices.find((v) => v.id.toLowerCase() === w) ?? voices.find((v) => v.name.toLowerCase() === w) : voices.find((v) => v.id === last);
  if (found) return found;
  if (!voices.length) throw new VoiceError("This ElevenLabs account has no voices: add one at elevenlabs.io.");
  const names = voices.slice(0, 20).map((v) => (v.own ? `${v.name} (your own)` : v.name));
  throw new VoiceError(`${w ? `No voice called “${wanted.trim()}”.` : "Which voice?"} Give voice: ${names.join(", ")}${voices.length > 20 ? ", and more in ElevenLabs" : ""}.`);
}

/** Speaks `text` in `voice` and saves the recording in the person's Media Library. */
export async function makeVoice(user: AuthVars["user"], input: { text: string; voice?: string; name?: string }): Promise<MadeVoice> {
  // where a plug-in's source is the Media Library, the storage library is never shown: nothing goes where nobody looks
  const main = mainSource();
  if (main) throw new VoiceError(`On this server the Media Library is the ${main.label}, and a voice made here has no place in it yet.`);
  const text = input.text.trim();
  if (!text) throw new VoiceError("Give the text the voice says.");
  if (text.length > MAX_VOICE_CHARS) throw new VoiceError(`The text is ${text.length.toLocaleString("en-US")} characters, and one voice recording takes up to ${MAX_VOICE_CHARS.toLocaleString("en-US")}: shorten it, or make it in parts.`);
  const key = keyOf(user);
  const voice = pickVoice(await voicesOf(key), input.voice ?? "", lastVoice(user.username));
  // the model is ElevenLabs' own default, and so is the format: an MP3 every plan may ask for
  const res = await call(key, `/v1/text-to-speech/${encodeURIComponent(voice.id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  const dir = await mkdtemp(path.join(tmpdir(), "ct-voice-"));
  try {
    const title = (input.name?.trim() || `Voice: ${text.replace(/\s+/g, " ").split(" ").slice(0, 7).join(" ")}`).replace(/[/\\]/g, " ").slice(0, 100);
    const file = path.join(dir, "voice.mp3");
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
    ensureLibrary(user.username);
    const saved = await saveToLibrary(user.username, file, `${title}.mp3`, [], undefined, true);
    if (!saved) throw new VoiceError("This account has no Media Library it may add to.");
    if ("error" in saved) throw new VoiceError(saved.error, 502);
    const assetId = "duplicateOf" in saved ? saved.duplicateOf : saved.assetId;
    const a = libraryDb().prepare("SELECT library_id, current_version_id FROM assets WHERE id = ?").get(assetId) as { library_id: string; current_version_id: string };
    change(user.username, (f) => void (f.voice = voice.id));
    return { versionId: a.current_version_id, assetId, libraryId: a.library_id, name: title, voice: { id: voice.id, name: voice.name } };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const voiceApp = new Hono<{ Variables: AuthVars }>();
type C = Context<{ Variables: AuthVars }>;

/** The answer, or a VoiceError as its sentence and status. */
const answer = async (c: C, run: () => Promise<object>) => {
  try {
    return c.json(await run());
  } catch (e) {
    if (e instanceof VoiceError) return c.json({ error: e.message }, e.status);
    throw e;
  }
};

voiceApp.get("/", (c) =>
  answer(c, async () => {
    const user = c.get("user");
    const voices = await voicesOf(keyOf(user));
    const last = lastVoice(user.username);
    return { voices, last: voices.some((v) => v.id === last) ? last : null } satisfies VoicesView;
  }),
);

voiceApp.post("/", (c) =>
  answer(c, async () => {
    const b = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === "string" ? v : "");
    return makeVoice(c.get("user"), { text: s(b.text), voice: s(b.voice), name: s(b.name) });
  }),
);
