import { rm } from "node:fs/promises";
import { Hono } from "hono";
import type { AuthVars } from "./auth";
import { speechFor } from "./lib/speech";
import { transcribeFile } from "./library/transcribe";
import { micUpload } from "./transcribe";
import { SPEECH_CODE } from "../contracts/voice";

/**
 * Words while the person is still talking (the dock's mic, no key): the audio recorded so far, written down by the same
 * engine the mic uses (speechFor "mic") with the mic's short limits (`soon`: MIC_LIMITS). Interim only: nothing here
 * falls back to another engine, and a failed pass answers no words, since the final pass (POST /api/transcribe/mic)
 * says why. A paid engine (Deepgram, OpenAI) is never asked for interim words: each pass would bill the whole recording
 * again, so it answers `skipped`.
 */
export const transcribeLiveApp = new Hono<{ Variables: AuthVars }>();

/** The audio so far, in what the browser records (webm or mp4): a few seconds of mic are a few hundred KB. */
const LIVE_MAX_BYTES = 4 * 1024 * 1024;

transcribeLiveApp.post("/", async (c) => {
  const user = c.get("user");
  const s = speechFor(user, "mic");
  if ("needs" in s) return c.json({ error: s.needs, code: SPEECH_CODE, reason: s.key ? "missing-key" : "model-unavailable" }, 422);
  if (s.engine !== "local") return c.json({ text: "", interim: true, skipped: true });
  const up = await micUpload(c, LIVE_MAX_BYTES);
  if (up instanceof Response) return up;
  const { src, scratch } = up;
  try {
    const t = await transcribeFile(src, user.username, scratch, src, { use: "mic", fillers: false, soon: true });
    return c.json({ text: t.segments.map((seg) => seg.text.trim()).filter(Boolean).join(" "), interim: true });
  } catch (e) {
    console.warn(`[transcribe] live for ${user.username} gave no words: ${e instanceof Error ? e.message : e}`);
    return c.json({ text: "", interim: true });
  } finally {
    await rm(src, { force: true });
  }
});
