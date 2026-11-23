import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sessionOf, type AuthVars } from "./auth";
import { captionLayoutApp } from "./caption-layout";
import { announceSoon } from "./lib/announce-soon";
import { env } from "./lib/env";
import { inCurrentWorkspace } from "./lib/workspace-scope";
import { deviceTranscribes, transcribeOnDevice } from "./lib/device-transcribe";
import { captioning, clipReadyToEdit, clipSourceFile, projectsApp } from "./projects";
import { captionsComputer, cloudTranscribeBlock, transcribeApp, userMayCloudTranscribe } from "./transcribe";
import { LOCAL_USER, findUser, type SessionUser } from "./users";
import { dropTask, startTask, taskFor } from "./work/tasks";
import type { Sound, SoundInput } from "./work/tasks/caption-studio";
import { storedStyle } from "../src/lib/export-request";
import { inRanges } from "../src/lib/nle/captions";
import type { CaptionStyle, Cue, Word } from "../src/lib/types";

/**
 * Captions for a project nobody has open: a video sent to Caption Studio from the assistant's chat ("caption this").
 * On the page, Transcribe runs in the browser; here the server does the same steps through the site's own routes, as
 * the person, so the project then holds what the page would have saved: the sound, cut at 16 kHz mono by a computer
 * task (on This Mac, or one of the person's computers: work/tasks/caption-studio.ts), heard through
 * POST /api/transcribe (their own key), else this computer's own model when the server is on it; the words through
 * POST /api/captions/auto (the page's script check, Match cadence and layout); saved with PUT /api/projects/:id/sync
 * at the revision that was read. When it ends, the card the assistant left ends and the chat says so (workEnded).
 * The project can be opened meanwhile: GET /api/projects/:id carries `captioning`, the page shows that instead of
 * Transcribe (and the transcribe route refuses a run for it), and takes the captions when they are saved.
 * The sound task is kept on disk and waits for a computer with the wait line; the chat's card keeps running while it
 * does, a restart included.
 */

/** The engines' names as a project keeps them (src/lib/transcribe.ts: CLOUD_MODEL_ID, and MODELS[0], which is device-transcribe.ts's model). */
const MODEL = { cloud: "cloud/deepgram", device: "Xenova/whisper-base" } as const;
type Engine = keyof typeof MODEL;

/**
 * What transcribes for this person, as the page picks it for someone who never chose an engine: the cloud route
 * when it serves them (their key, or their own computers: api/transcribe.ts captionsComputer), else this computer's own
 * model when the server is on it (a locked account stays locked, as in Video Notes); or the route's own words for why
 * nothing can.
 */
export function captionEngine(user: SessionUser): { engine: Engine } | { refused: string } {
  const refused = cloudTranscribeBlock(user);
  if (!refused || captionsComputer(user)) return { engine: "cloud" };
  return userMayCloudTranscribe(user) && deviceTranscribes() ? { engine: "device" } : { refused };
}

type Clip = {
  id: string; name: string; duration?: number; srcWidth?: number; srcHeight?: number; srcFps?: number;
  style?: Partial<CaptionStyle>; words?: Word[]; originalWords?: Word[]; cues?: Cue[]; posSegments?: unknown[]; texts?: unknown[]; done?: boolean;
  /** an Editor update's new material (api/editor/captions.ts), seconds: only the words heard there are added to its captions */
  fill?: [number, number][];
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

/**
 * Starts the captions of a clip: its editing copy first (the transcript never runs beside its encode), then its sound
 * cut by the "caption-sound" computer task (work/tasks/caption-studio.ts), here on This Mac or on one of the person's
 * computers; captionsHeard hears and saves the words when the sound comes. What failed is said in one line.
 */
async function caption(user: SessionUser, projectId: string, clipId: string, engine: Engine, workspace?: string): Promise<void> {
  // what the encoder said goes to the log, not the chat
  const quiet = (e: unknown) => {
    console.warn(`[captions] ${projectId}: no editing copy:`, e);
    return false as const;
  };
  if (!(await clipReadyToEdit(projectId, clipId, user).catch(quiet))) throw new Error("This file could not be read as a video");
  // the stored source back on the server's disk when it was kept elsewhere (serving, not processing)
  if (!(await clipSourceFile(projectId, clipId))) throw new Error("Source video is not on the server");
  if (stopped.has(projectId)) return; // stopped while its editing copy was made: its sound is not cut
  const r = await routesAs(user)<Project>(`/api/projects/${projectId}`);
  const seconds = r.body.clips?.find((c) => c.id === clipId)?.duration ?? 0;
  await startTask<SoundInput, Sound>("caption-sound", projectId, user.username, workspace ?? null, { project: projectId, clip: clipId, cloud: engine === "cloud", seconds, name: r.body.name ?? "" });
}

/**
 * The sound of a clip came (caption-sound's apply, on the server): its words heard on the person's key, laid out and
 * saved, and the chat told. How many lines the clip now has (the person's own, when they made them on the page
 * meanwhile: theirs stay), and `note` when another engine than theirs wrote them (their computers were off).
 */
export async function captionsHeard(actor: string, input: SoundInput, sound: Sound, files: Record<string, string>): Promise<void> {
  const user = !env.appSecret ? LOCAL_USER : ((u) => u && sessionOf(u))(findUser(actor));
  const job = user ? hear(user, input, sound, files) : Promise.reject(new Error("The account is gone"));
  // a refusal or a save that failed is the job's end, said once: the sound is not cut again for it
  await job.then((r) => end(input.project, r, input.name, actor), (e: unknown) => end(input.project, e, input.name, actor));
}

async function hear(user: SessionUser, input: SoundInput, sound: Sound, files: Record<string, string>): Promise<{ lines: number; note?: string }> {
  const { project: projectId, clip: clipId } = input;
  captioning.set(projectId, "transcribing");
  const call = routesAs(user);
  const ask = async <T>(route: string, method?: string, body?: unknown) => {
    const r = await call<T>(route, method, body);
    if (!r.ok) throw new Error(r.body.error || "The server could not make the captions");
    return r.body;
  };
  // the words as the page keeps each engine's: the cloud's come timed, this computer's are approximate
  let engine: Engine = input.cloud ? "cloud" : "device";
  let note: string | undefined;
  let heard: Omit<Word, "id">[] | undefined;
  if (engine === "cloud") {
    const r = await call<{ words: Omit<Word, "id">[]; note?: string; why?: string }>("/api/transcribe", "POST", await readFile(files["audio.wav"]!));
    // their computers could not and no key serves them: this computer's own model when the server is on it, as before
    if (!r.ok && r.body.code === "USE_BROWSER" && deviceTranscribes() && files["audio.f32"]) {
      engine = "device";
      note = `${r.body.why}: written on this computer`;
    } else if (!r.ok) {
      throw new Error(r.body.code === "USE_BROWSER" ? `${r.body.why}. On the project's page, Transcribe runs in the browser` : r.body.error || "The server could not transcribe it");
    } else {
      heard = r.body.words;
      note = r.body.note;
    }
  }
  if (!heard && !files["audio.f32"]) throw new Error("This computer's own speech model is not on this server");
  heard ??= (await transcribeOnDevice(files["audio.f32"]!, projectId)).words.map((w) => ({ ...w, timing: "approximate" as const }));
  const words: Word[] = heard.map((w, i) => ({ ...w, id: i + 1 }));

  for (let again = false; ; again = true) {
    const p = await ask<Project>(`/api/projects/${projectId}`);
    const clip = p.clips.find((c) => c.id === clipId);
    if (!clip) throw new Error("The clip is not in the project any more");
    const fill = clip.fill?.length ? clip.fill : null;
    if (!fill && (clip.words?.length || clip.cues?.length)) return { lines: clip.cues?.length || clip.words!.length };
    // the look a project opens with on the page
    const style = storedStyle(clip.style);
    const auto = p.autoCadence ?? true;
    // an Editor update: the new material's words, numbered after his, laid out on their own and added to his lines
    const top = Math.max(0, ...(clip.words ?? []).map((w) => w.id));
    const fresh = fill ? words.filter((w) => inRanges((w.start + w.end) / 2, fill)).map((w, i) => ({ ...w, id: top + i + 1 })) : words;
    const frame = { words: fresh, style, width: clip.srcWidth || 1920, height: clip.srcHeight || 1080 };
    const laid: Laid = !fresh.length ? { cues: [] } : await ask<Laid>(`/api/captions/${auto ? "auto" : "layout"}`, "POST", { ...frame, script: p.script });
    const byStart = <T extends { start: number }>(a: T[], b: T[]) => [...a, ...b].sort((x, y) => x.start - y.start);
    const cues = fill ? byStart(clip.cues ?? [], laid.cues).map((c, i) => ({ ...c, id: i + 1 })) : laid.cues;
    const seconds = clip.duration || sound.seconds;
    // the snapshot the page sends after a transcript lands (src/lib/persist.ts saveClip)
    if (stopped.has(projectId)) throw STOPPED; // stopped while it was heard: nothing is saved
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
          words: fill ? byStart(clip.words ?? [], laid.words ?? fresh) : laid.words ?? words,
          originalWords: fill ? byStart(clip.originalWords ?? [], fresh) : words,
          cues,
          posSegments: clip.posSegments ?? [],
          texts: clip.texts ?? [],
          cadenceApplied: laid.cadenceApplied ?? false,
          cadenceFit: laid.cadenceFit ?? null,
          cadenceDirty: false,
          done: clip.done ?? false,
          peaks: sound.peaks,
        },
      },
    });
    if (saved.ok) return { lines: cues.length, note };
    // the page saved in between: read it again once (their captions, if that is what they saved, stay)
    if (saved.body.code !== "REVISION_CONFLICT" || again) throw new Error(saved.body.error || "The captions could not be saved");
  }
}

/** The sound could not be cut (caption-sound failed for good): the job's end. */
export const captionsFailed = (actor: string, input: SoundInput, error: string): void => end(input.project, new Error(error), input.name, actor);

/** Who each running job is for and its project's name, for Home (api/activity.ts). */
const started = new Map<string, { owner: string; name: string; workspace?: string }>();
/** Projects whose captioning was stopped: a late end of that job (its sound, a failure) is not said. Cleared by a new start. */
const stopped = new Set<string>();
const STOPPED = new Error("Stopped");

/**
 * Stop (POST /api/projects/:id/captioning/stop): the job ends as stopped and its sound task is dropped (a computer that
 * holds it loses it at its next beat). The project and its clip stay; Transcribe on its page starts it again. Nothing
 * running: nothing changes.
 */
export function stopCaptioning(username: string, projectId: string, name: string): void {
  const t = taskFor("caption-sound", projectId);
  if (!started.has(projectId) && !captioning.has(projectId) && t?.state !== "queued" && t?.state !== "running") return;
  dropTask("caption-sound", projectId);
  end(projectId, STOPPED, name, username);
  stopped.add(projectId);
}
// a transcription's card runs while it is captioned here (assistant.ts sweepWork), or while its sound task waits for a
// computer or runs on one (a restart keeps that)
void import("./assistant").then(({ checkWork }) => checkWork("captions", (id) => {
  const projectId = id.slice("captions:".length);
  const t = taskFor("caption-sound", projectId);
  return captioning.has(projectId) || started.has(projectId) || t?.state === "queued" || t?.state === "running" ? null : { status: "stopped", detail: "Stopped" };
}));
/** Caption jobs a restart of the server would drop: a deploy waits for 0 (/api/health). */
export const captionJobsAtRisk = (): number => started.size;
/** The person's jobs in the workspace the request works in. */
export async function captioningWork(user: SessionUser) {
  const here = await inCurrentWorkspace(user);
  return [...started].filter(([, j]) => j.owner === user.username && (!here || here(j.workspace))).map(([id, j]) => ({ id, name: j.name }));
}

/** Starts the captions for a project just made from a file; the chat hears how it ended. `name` and `workspace` are the project's. */
export function captionInBackground(user: SessionUser, projectId: string, clipId: string, name: string, engine: Engine, workspace?: string): void {
  stopped.delete(projectId);
  captioning.set(projectId, "preparing");
  started.set(projectId, { owner: user.username, name, workspace });
  announceSoon(user.username, "projects"); // Home's chip (api/activity.ts captioningWork)
  void caption(user, projectId, clipId, engine, workspace).catch((e: unknown) => end(projectId, e));
}

/**
 * The job for `projectId` ended (its captions saved, or the error that stopped it): no longer "being captioned", then
 * the chat told. Said once: a second end finds no running card (workEnded).
 */
function end(projectId: string, outcome: { lines: number; note?: string } | unknown, title?: string, actor?: string): void {
  if (stopped.has(projectId)) return; // its Stop said the end already
  const name = started.get(projectId)?.name ?? title ?? "";
  const owner = started.get(projectId)?.owner ?? actor;
  const done = typeof outcome === "object" && outcome !== null && "lines" in outcome ? (outcome as { lines: number; note?: string }) : undefined;
  // one plain sentence for the card and the chat
  const why = done ? "" : (outcome instanceof Error ? outcome.message : String(outcome)).split("\n")[0]!.slice(0, 200).replace(/\.$/, "");
  if (!done && outcome !== STOPPED) console.warn(`[captions] ${projectId} was not captioned: ${why}`);
  const ended = outcome === STOPPED
    ? { status: "stopped" as const, detail: "Stopped", say: `The captions for “${name}” were stopped.` }
    : done
    ? done.lines
      ? { status: "done" as const, detail: done.note ?? "Captions are ready", say: `The captions for “${name}” are ready.`, choices: ["What do they say?"] }
      : { status: "done" as const, detail: "No words were heard", say: `No words were heard in “${name}”, so it has no captions.` }
    : { status: "failed" as const, detail: why, say: `The captions for “${name}” were not made: ${why}.` };
  // first no longer "being captioned", then told: a page that has the project open reads it again on this notice,
  // takes the captions and offers Transcribe again (also when none were made)
  captioning.delete(projectId);
  started.delete(projectId);
  if (!owner) return;
  announceSoon(owner, "projects");
  // loaded here, not at the top: assistant.ts loads this file through assistant-files.ts
  void import("./assistant")
    .then(({ workEnded }) => {
      const tell = () => workEnded(owner, `captions:${projectId}`, { ...ended, href: `/captions?project=${projectId}` });
      // a job that ends at once (a file that is no video) can end before use_file's answer has left its card: told once more
      if (!tell()) setTimeout(tell, 2000).unref();
    })
    .catch((e: unknown) => console.error("[captions] the chat was not told:", e));
}
