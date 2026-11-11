import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AuthVars } from "./auth";
import { captionLayoutApp } from "./caption-layout";
import { announceSoon } from "./lib/announce-soon";
import { DEVICE_AUDIO, deviceTranscribes, transcribeOnDevice } from "./lib/device-transcribe";
import { ffmpeg } from "./library/media/run";
import { captioning, clipReadyToEdit, clipSourceFile, projectsApp } from "./projects";
import { cloudTranscribeBlock, transcribeApp, userMayCloudTranscribe } from "./transcribe";
import type { SessionUser } from "./users";
import { DEFAULT_STYLE, type CaptionStyle, type Cue, type Word } from "../src/lib/types";
import { waveformPeaks } from "../src/lib/waveform-peaks";

/**
 * Captions for a project nobody has open: a video sent to Caption Studio from the assistant's chat ("caption this").
 * On the page, Transcribe runs in the browser; here the server does the same steps through the site's own routes, as
 * the person, so the project then holds what the page would have saved: the audio at 16 kHz mono to
 * POST /api/transcribe (their own key), else this computer's own model when the server is on it; the words through
 * POST /api/captions/auto (the page's script check, Match cadence and layout); saved with PUT /api/projects/:id/sync
 * at the revision that was read. When it ends, the card the assistant left ends and the chat says so (workEnded).
 * ponytail: one job in memory, the whole audio in memory (350 MB an hour): a restart drops it, and the person
 * presses Transcribe on the page. Keep jobs on disk when long recordings are sent this way.
 */

/** The engines' names as a project keeps them (src/lib/transcribe.ts: CLOUD_MODEL_ID, and MODELS[0], which is device-transcribe.ts's model). */
const MODEL = { cloud: "cloud/deepgram", device: "Xenova/whisper-base" } as const;
type Engine = keyof typeof MODEL;
const RATE = 16000;

/**
 * What transcribes for this person, as the page picks it for someone who never chose an engine: the cloud route
 * when it serves them, else this computer's own model when the server is on it (a locked account stays locked, as in
 * Video Notes); or the route's own words for why nothing can.
 */
export function captionEngine(user: SessionUser): { engine: Engine } | { refused: string } {
  const refused = cloudTranscribeBlock(user);
  if (!refused) return { engine: "cloud" };
  return userMayCloudTranscribe(user) && deviceTranscribes() ? { engine: "device" } : { refused };
}

type Clip = {
  id: string; name: string; duration?: number; srcWidth?: number; srcHeight?: number; srcFps?: number;
  style?: Partial<CaptionStyle>; words?: Word[]; cues?: Cue[]; posSegments?: unknown[]; texts?: unknown[]; done?: boolean;
};
type Project = { name: string; revision: number; fps: number | null; autoCadence: boolean | null; script: string; clips: Clip[] };
type Laid = { words?: Word[]; cues: Cue[]; cadenceApplied?: boolean; cadenceFit?: unknown };
type Refusal = { error?: string; code?: string };

/** The site's own routes as the person, as the page calls them (library/activity.ts reads one route the same way). */
function routesAs(user: SessionUser) {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use(async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route("/api/projects", projectsApp);
  app.route("/api/transcribe", transcribeApp);
  app.route("/api/captions", captionLayoutApp);
  return async <T>(route: string, method = "GET", body?: unknown): Promise<{ ok: boolean; body: T & Refusal }> => {
    const raw = body instanceof Uint8Array;
    const r = await app.request(route, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": raw ? "audio/wav" : "application/json" }, body: raw ? body : JSON.stringify(body) }),
    });
    return { ok: r.ok, body: (await r.json().catch(() => ({}))) as T & Refusal };
  };
}

/** Transcribes the clip and saves its captions: how many lines it now has (the person's own, when they made them on the page meanwhile: theirs stay). */
async function caption(user: SessionUser, projectId: string, clipId: string, engine: Engine): Promise<number> {
  const call = routesAs(user);
  const ask = async <T>(route: string, method?: string, body?: unknown) => {
    const r = await call<T>(route, method, body);
    if (!r.ok) throw new Error(r.body.error || `${route} could not answer`);
    return r.body;
  };
  // the editing copy first: the transcript never runs beside its encode
  if (!(await clipReadyToEdit(projectId, clipId, user))) throw new Error("Its editing copy could not be made");
  captioning.set(projectId, "transcribing");
  const src = await clipSourceFile(projectId, clipId);
  if (!src) throw new Error("Source video is not on the server");
  const dir = await mkdtemp(path.join(tmpdir(), "capjob-"));
  try {
    // one cut: the samples (the waveform, and this computer's model), and for the cloud the WAV the browser would post
    const samples = path.join(dir, "audio.f32");
    const wav = path.join(dir, "audio.wav");
    await ffmpeg(["-i", src, ...DEVICE_AUDIO, samples, ...(engine === "cloud" ? ["-vn", "-ac", "1", "-ar", String(RATE), "-f", "wav", wav] : [])]).catch((e: Error) => {
      throw /does not contain any stream/.test(e.message) ? new Error("This file has no audio track") : e;
    });
    const b = await readFile(samples);
    const n = b.byteLength >> 2;
    const pcm = b.byteOffset % 4 ? new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + n * 4)) : new Float32Array(b.buffer, b.byteOffset, n);
    // the words as the page keeps each engine's: the cloud's come timed, this computer's are approximate
    const heard: Omit<Word, "id">[] =
      engine === "cloud"
        ? (await ask<{ words: Omit<Word, "id">[] }>("/api/transcribe", "POST", await readFile(wav))).words
        : (await transcribeOnDevice(samples, projectId)).words.map((w) => ({ ...w, timing: "approximate" as const }));
    const words: Word[] = heard.map((w, i) => ({ ...w, id: i + 1 }));

    for (let again = false; ; again = true) {
      const p = await ask<Project>(`/api/projects/${projectId}`);
      const clip = p.clips.find((c) => c.id === clipId);
      if (!clip) throw new Error("The clip is not in the project any more");
      if (clip.words?.length || clip.cues?.length) return clip.cues?.length || clip.words!.length;
      // the look a project opens with on the page (src/lib/persist.ts clipSlotFromServer)
      const style = { ...DEFAULT_STYLE, ...(clip.style ?? {}), fitBox: true, lowercase: clip.style?.lowercase ?? false };
      const auto = p.autoCadence ?? true;
      const frame = { words, style, width: clip.srcWidth || 1920, height: clip.srcHeight || 1080 };
      const laid: Laid = !words.length ? { cues: [] } : await ask<Laid>(`/api/captions/${auto ? "auto" : "layout"}`, "POST", { ...frame, script: p.script });
      const seconds = clip.duration || pcm.length / RATE;
      // the snapshot the page sends after a transcript lands (src/lib/persist.ts saveClip)
      const saved = await call(`/api/projects/${projectId}/sync`, "PUT", {
        baseRevision: p.revision,
        mutationId: randomUUID(),
        snapshot: {
          name: p.name,
          fps: p.fps ?? p.clips[0]?.srcFps ?? 30,
          model: MODEL[engine],
          autoCadence: auto,
          script: p.script,
          clipOrder: p.clips.map((c) => c.id),
          clip: {
            id: clipId,
            name: clip.name,
            duration: seconds,
            style,
            words: laid.words ?? words,
            originalWords: words,
            cues: laid.cues,
            posSegments: clip.posSegments ?? [],
            texts: clip.texts ?? [],
            cadenceApplied: laid.cadenceApplied ?? false,
            cadenceFit: laid.cadenceFit ?? null,
            cadenceDirty: false,
            done: clip.done ?? false,
            peaks: Array.from(waveformPeaks(pcm, seconds), (v) => Math.round(v * 1000) / 1000),
          },
        },
      });
      if (saved.ok) {
        announceSoon(user.username, "projects");
        return laid.cues.length;
      }
      // the page saved in between: read it again once (their captions, if that is what they saved, stay)
      if (saved.body.code !== "REVISION_CONFLICT" || again) throw new Error(saved.body.error || "The captions could not be saved");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Starts the captions for a project just made from a file; the chat hears how it ended. `name` is the project's. */
export function captionInBackground(user: SessionUser, projectId: string, clipId: string, name: string, engine: Engine): void {
  captioning.set(projectId, "preparing");
  void caption(user, projectId, clipId, engine)
    .then(
      (lines) =>
        lines
          ? { status: "done" as const, detail: "Captions are ready", say: `The captions for “${name}” are ready.`, choices: ["Show me", "What do they say?"] }
          : { status: "done" as const, detail: "No words were heard", say: `No words were heard in “${name}”, so it has no captions.`, choices: ["Show me"] },
      (e: unknown) => {
        const why = (e instanceof Error ? e.message : String(e)).replace(/\.$/, "");
        console.warn(`[captions] ${projectId} was not captioned: ${why}`);
        return { status: "failed" as const, detail: why, say: `The captions for “${name}” were not made: ${why}.`, choices: ["Show me"] };
      },
    )
    .then(async (end) => {
      captioning.delete(projectId);
      // loaded here, not at the top: assistant.ts loads this file through assistant-files.ts
      (await import("./assistant")).workEnded(user.username, `captions:${projectId}`, end);
    })
    .catch((e: unknown) => console.error("[captions] the chat was not told:", e));
}
