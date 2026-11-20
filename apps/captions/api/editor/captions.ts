import { createHash } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { TOOL_NAMES } from "../../contracts/tools";
import type { AuthVars } from "../auth";
import { captionEngine, captionInBackground } from "../captions-job";
import { exportFailure, exportsApp } from "../exports";
import { probe } from "../library/media/probe";
import { addEditedClip, clipWithCaptions, createProjectFromFile, projectsApp } from "../projects";
import { mayChange, mayUse, type SessionUser } from "../users";
import { renderSpecOf, storedRenderData, type StoredClip } from "../../src/lib/export-request";
import { remapCaptions, type CaptionData, type From } from "../../src/lib/nle/captions";

/**
 * The Editor's captions are Caption Studio's (lib/nle/captions.ts). A cut's render, a file on this server, becomes a
 * Caption Studio clip by Caption Studio's own paths: a new project heard by its own captioning (what the chat's "caption
 * this" runs: its computer tasks cut the sound where they run, the words are heard as captionEngine says), or, for a
 * newer cut, a new clip in his project with his captions moved through the edit, where only new material is heard.
 * The render is linked, never copied off the server. The page that has the render (the studio's draft view, the
 * public editor's) calls it with the file.
 */

export interface CaptionsLink { project: string; clip: string; captioning: boolean; note?: string }

const refuse = (status: ContentfulStatusCode, message: string) => new HTTPException(status, { message });

/** The captions of the cut `to` (its A1, timeline `fps`) from its render `file`; with `old`, moved from those. */
export async function captionsFromRender(user: SessionUser, o: {
  file: string;
  /** the project's name (the edit's) */
  name: string;
  /** the edit's workspace: the project is made in it, and an older one must be in it */
  workspace?: string;
  fps: number;
  to: From[];
  /** a source's frames per timeline frame (1 when unknown) */
  rate?: (src: string) => number;
  old?: { project: string; clip: string; from: From[] };
}): Promise<CaptionsLink> {
  if (!mayUse(user, "captions")) throw refuse(403, `${TOOL_NAMES.captions} isn't switched on for your account`);
  if (!mayChange(user, "captions")) throw refuse(403, `${TOOL_NAMES.captions} is read-only for your account`);
  const info = await probe(o.file).catch(() => null);
  if (!info?.duration) throw refuse(409, "This cut's render could not be read");
  const route = captionEngine(user);
  const notHeard = (why: string) => `Not transcribed: ${why}. In ${TOOL_NAMES.captions}, Transcribe runs in the browser and needs no key.`;

  if (!o.old) {
    const made = await createProjectFromFile({ owner: user.username, name: o.name, clipName: o.name, file: o.file, duration: info.duration, later: true, workspace: o.workspace });
    if ("refused" in route) return { project: made.projectId, clip: made.clipId, captioning: false, note: notHeard(route.refused) };
    captionInBackground(user, made.projectId, made.clipId, o.name, route.engine, o.workspace);
    return { project: made.projectId, clip: made.clipId, captioning: true };
  }

  // his clip, read under the project's lock (404: not his); a project of another workspace is not this edit's
  const was = await clipWithCaptions(o.old.project, o.old.clip, user);
  if ((was.workspace ?? undefined) !== (o.workspace ?? undefined)) throw refuse(404, "Caption Studio project not found");
  const moved = remapCaptions(was.data as CaptionData, o.old.from, o.to, o.fps, o.rate);
  const hear = moved.fill.length > 0 && !("refused" in route);
  const made = await addEditedClip({
    user,
    file: o.file,
    name: was.name,
    duration: info.duration,
    width: info.width,
    height: info.height,
    // fill: what captions-job.ts hears and adds; only while it is being heard
    data: { ...moved.data, ...(hear ? { fill: moved.fill } : {}) },
    // the same update twice adds one clip
    transferId: `editor-captions:${createHash("sha256").update(JSON.stringify([o.old, o.to])).digest("hex").slice(0, 32)}`,
    origin: was.origin,
    scenes: 0,
  });
  if (hear) captionInBackground(user, made.projectId, made.clipId, was.name, (route as { engine: "cloud" | "device" }).engine, o.workspace);
  return {
    project: made.projectId,
    clip: made.clipId,
    captioning: hear,
    ...(moved.fill.length && "refused" in route ? { note: notHeard(route.refused) } : {}),
  };
}

/** Caption Studio's own routes, as `user` (the page's calls, made by the server). */
function as(user: SessionUser) {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use(async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route("/api/projects", projectsApp);
  app.route("/api/exports", exportsApp);
  return (route: string, init?: { method: string; body: unknown }) =>
    app.request(route, init ? { method: init.method, headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) } : undefined);
}

type Project = { id: string; name: string; fps: number | null; captioning?: string; clips: (StoredClip & { id: string; srcFps?: number })[] };
type Export = { id: string; status: "queued" | "running" | "done" | "error"; error?: string; note?: string };
/** The overlay export started for a render (`key`: the job that renders), by its key. */
const overlays = new Map<string, string>();

/**
 * Burn-in: Caption Studio's captions of a clip as a transparent video, drawn by Caption Studio's own renderer (an
 * overlay export: its exact engine, CaptionRenderSurface frames, ProRes with alpha, run where its computer tasks run),
 * for an engine to lay over its render. Started once per `key`; `wait` while it is drawn, then the response with the
 * file, or why it could not be made.
 */
export async function captionsOverlay(user: SessionUser, key: string, project: string, clip: string, fps: number):
  Promise<{ wait: string } | { error: string } | { file: Response }> {
  const call = as(user);
  let id = overlays.get(key);
  if (!id) {
    const r = await call(`/api/projects/${encodeURIComponent(project)}`);
    if (!r.ok) return { error: "The captions' Caption Studio project is not there any more" };
    const p = (await r.json()) as Project;
    if (p.captioning) return { wait: "Waiting for the captions to be transcribed" };
    const c = p.clips.find((x) => x.id === clip);
    if (!c) return { error: "The captions' clip is not in its Caption Studio project any more" };
    const d = storedRenderData(c);
    if (!d.width || !d.height || !d.duration) return { wait: "Waiting for Caption Studio to read the clip" };
    // the request the assistant's captions_export sends, as an overlay: the frames drawn by the server's own renderer
    const made = await call("/api/exports", { method: "POST", body: {
      kind: "overlay", format: "mov", engine: "wysiwyg", name: `${p.name} captions`, projectId: p.id,
      duration: d.duration, width: d.width, height: d.height, fps, renderSpec: renderSpecOf(d),
    } });
    const job = (await made.json()) as Export & { error?: string };
    if (!made.ok) return { error: job.error || "Caption Studio could not start drawing the captions" };
    overlays.set(key, (id = job.id));
  }
  const r = await call(`/api/exports/${id}`);
  const job = r.ok ? ((await r.json()) as Export) : null;
  if (!job) {
    overlays.delete(key);
    return { error: "The captions' overlay was removed" };
  }
  if (job.status === "error") {
    overlays.delete(key);
    return { error: exportFailure(job.error) };
  }
  if (job.status !== "done") return { wait: job.note || "Drawing the captions" };
  const file = await call(`/api/exports/${id}/file`);
  return file.ok ? { file } : { error: "The captions' overlay has expired" };
}
