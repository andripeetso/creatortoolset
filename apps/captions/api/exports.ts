import { Hono } from "hono";
import { track } from "./lib/telemetry";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { ZipFile } from "yazl";
import type { CaptionRenderSpec } from "../src/lib/types";
import type { AuthVars } from "./auth";
import { emitEvent } from "./lib/events";
import { env } from "./lib/env";
import { ensureProjectOriginal, projectOriginalExists, readProjectClip } from "./media-store";
import { saveToLibrary } from "./library/routes";
import { addToFinals, belowHd, type FinalsOutcome } from "./library/finals";
import { ensureLibrary } from "./library/access";
import { type SessionUser, bumpUsage, canSee, mayChange } from "./users";
import type { ExportStatus } from "../contracts/exports";
import { type Moves, canMove, move } from "./lib/transition";
import { announceSoon } from "./lib/announce-soon";
import { currentWorkspaceId, inCurrentWorkspace } from "./lib/workspace-scope";
import { dropTask, keep, startTask, taskFor, taskWaitLine } from "./work/tasks";
import type { ExportInput } from "./work/tasks/export";
import { okId } from "./lib/ids";

/** The computer task kind that renders an export (work/tasks/export.ts). */
const EXPORT_TASK = "export";

/**
 * Background export jobs. POST creates a job and returns immediately; the
 * render runs as a computer task (work/tasks/export.ts) on one of the owner's
 * computers, or here where the server may, while the client polls for
 * progress. Finished files live under $DATA_DIR/exports/<id>/ so they
 * stay downloadable after a reload — or after the tab was closed
 * mid-render — until their owner removes them (Settings → Storage). Nothing is
 * removed for its age.
 */
export const exportsApp = new Hono<{ Variables: AuthVars }>();

const EXPORTS_DIR = path.join(env.dataDir, "exports");
const MAX_CONCURRENT = Math.max(1, Number(process.env.EXPORT_CONCURRENCY || 1));

const jobDir = (id: string) => path.join(EXPORTS_DIR, id);
const outPath = (job: Job) => path.join(jobDir(job.id), `out.${job.ext}`);
const projectOriginal = (id: string, clipId?: string) =>
  clipId
    ? path.join(env.dataDir, "projects", id, "clips", clipId, "original")
    : path.join(env.dataDir, "projects", id, "original"); // legacy single-clip layout

type JobStatus = ExportStatus;
/** A job renders from queued to running, then ends done or error; nothing leaves those. */
export const EXPORT_MOVES: Moves<ExportStatus> = {
  queued: ["running", "error"],
  running: ["done", "error"],
  done: [],
  error: [],
};

interface JobParams {
  projectId?: string;
  clipId?: string;
  width?: number;
  height?: number;
  fps?: number;
  duration: number;
  crf?: number;
  /** burn only: the second of the source whose frame becomes frame 0 (the cover a platform shows) */
  coverAt?: number;
  /** burn only: send the render to the owner's Finals when it is done */
  finals?: boolean;
  finalsLabel?: string;
  /** started from the assistant's chat (the captions_export tool): the chat hears how it ended (tellChat) */
  chat?: boolean;
  /** The workspace of the Caption Studio project it was made from (lib/workspace-scope.ts); none: the first brand's. */
  workspace?: string;
}

interface Job {
  id: string;
  kind: "burn" | "overlay";
  /**
   * native: libass renders the client-built ASS in the encoder — no browser,
   * faster than realtime. wysiwyg: headless Chromium screenshots the
   * DOM render surface per frame (pixel-exact, slower, needs Chromium).
   */
  engine: "native" | "wysiwyg";
  format: string; // h264 | h265 | mov | webm | png
  ext: string; // mp4 | mov | webm | zip
  filename: string; // download name shown to the user
  status: JobStatus;
  progress: number; // 0..1
  /** what a running job is doing besides rendering (the first export's browser download) */
  note?: string;
  error?: string;
  bytes?: number;
  createdAt: number;
  finishedAt?: number;
  owner?: string; // account username; absent on pre-account jobs
  /** One-click Send to Finals: where it is (the tray shows it; a closed tab doesn't matter). */
  finals?: { status: "waiting" | "sending" | "sent" | "refused" | "error"; pieceId?: string; error?: string };
  params: JobParams;
}


/** Client-facing shape (params stay server-side, but for the project a render was made from). */
function publicJob(j: Job): Omit<Job, "params"> & { projectId?: string } {
  const pub: Partial<Job> & { projectId?: string } = { ...j, projectId: j.params.projectId };
  // a render waiting for one of the owner's computers says so (R6), in the line the tray shows
  const task = j.status === "queued" || j.status === "running" ? taskFor(EXPORT_TASK, j.id) : undefined;
  const wait = task && taskWaitLine(task);
  if (wait) pub.note = wait;
  delete pub.params;
  return pub as Omit<Job, "params">;
}

/** Why a render failed, as one plain sentence: what the encoder or the frame browser printed stays in the job, for the log and the page's tray. */
const FAILURES: Array<[RegExp, string]> = [
  [/^Source video is not on the server/, "The video is no longer on the server"],
  [/^Interrupted by a server restart/, "The server restarted while it was rendering, so it has to be exported again"],
  [/^(Downloading the export browser failed|The export browser is not installed|Caption renderer is missing)/, "The browser that draws the captions could not be started"],
];
export const exportFailure = (error = ""): string => FAILURES.find(([known]) => known.test(error))?.[1] ?? "The video could not be rendered";

/**
 * A render the assistant started (captions_export) has ended: its card ends, and the chat says so once with the
 * file's link (api/assistant.ts workEnded). A render started on the page says nothing there. `stopped`: someone
 * cancelled it, so the card ends and nothing is said.
 */
async function tellChat(job: Job, stopped = false): Promise<void> {
  if (!job.params.chat || !job.owner) return;
  const file = `“${job.filename}”`;
  const finals = job.finals?.status === "sent" ? " It is in Finals too." : job.finals?.error ? ` It was not put in Finals: ${job.finals.error.replace(/\.$/, "")}.` : "";
  const why = exportFailure(job.error);
  const end = stopped
    ? { status: "stopped" as const, detail: "Stopped" }
    : job.status === "done"
      ? { status: "done" as const, detail: job.finals?.status === "sent" ? "Ready, and in Finals" : "Ready to download", say: `${file} is ready: [Download it](/api/exports/${job.id}/file).${finals}` }
      : { status: "failed" as const, detail: why, say: `${file} was not exported: ${why}.` };
  // loaded here, not at the top: assistant.ts reaches this file through its own imports
  const { workEnded } = await import("./assistant");
  const tell = () => workEnded(job.owner!, `export:${job.id}`, end);
  // a render that fails at once can end before the tool's answer has left its card: told once more
  if (!tell()) setTimeout(tell, 2000).unref();
}
const chatHears = (job: Job, stopped = false) => void tellChat(job, stopped).catch((e: unknown) => console.error("[exports] the chat was not told:", e));
// a render's card runs while it renders (assistant.ts sweepWork); a removed one stopped. Loaded late, as tellChat does.
void import("./assistant").then(({ checkWork }) => checkWork("export", async (id) => {
  await loaded;
  const job = jobs.get(id.slice("export:".length));
  if (!job) return { status: "stopped", detail: "Stopped" };
  if (job.status === "queued" || job.status === "running") return null;
  return job.status === "done" ? { status: "done", detail: "Ready to download" } : { status: "failed", detail: exportFailure(job.error) };
}));

const jobs = new Map<string, Job>();
/** An account's renders still to finish, for Home's list and the menu bar (api/activity.ts). */
export const activeExports = async (user: SessionUser) => {
  const here = await inCurrentWorkspace(user);
  return [...jobs.values()].filter((j) => j.owner === user.username && (j.status === "queued" || j.status === "running") && (!here || here(j.params.workspace))).map((j) => ({ id: j.id, filename: j.filename, status: j.status, progress: j.progress, projectId: j.params.projectId }));
};

/** The Caption Studio project's owner and workspace (its meta.json); null when it can't be read. */
async function projectMeta(projectId: string): Promise<{ owner?: unknown; projectId?: unknown } | null> {
  try {
    return JSON.parse(await readFile(path.join(env.dataDir, "projects", projectId, "meta.json"), "utf-8"));
  } catch {
    return null;
  }
}
const workspaceOf = (meta: { projectId?: unknown } | null) => (typeof meta?.projectId === "string" ? meta.projectId : undefined);

async function persist(job: Job): Promise<void> {
  try {
    await writeFile(path.join(jobDir(job.id), "job.json"), JSON.stringify(job));
  } catch {
    /* dir may already be deleted (cancel) */
  }
}

/** A render's save: the owner's open screens follow it (at most about once a second, the last save always). */
async function jobPersist(job: Job): Promise<void> {
  await persist(job);
  announceSoon(job.owner, "exports");
}

/** Renders read at boot as done with a send to Finals that never ended: the restart cut it off (resumeFinalsSends). */
const cutOff: Job[] = [];
const onItsWay = (finals: Job["finals"]) => finals?.status === "waiting" || finals?.status === "sending";

/** Load persisted jobs once at boot; renders a restart cut off → error, but one its computer task still holds (it outlives a restart). */
const loaded = (async () => {
  await mkdir(EXPORTS_DIR, { recursive: true }).catch(() => {});
  let ids: string[] = [];
  try {
    ids = (await readdir(EXPORTS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter(okId);
  } catch {
    return;
  }
  for (const id of ids) {
    try {
      const job: Job = JSON.parse(
        await readFile(path.join(jobDir(id), "job.json"), "utf-8"),
      );
      const task = taskFor(EXPORT_TASK, id)?.state;
      if ((job.status === "queued" || job.status === "running") && task !== "queued" && task !== "running") {
        job.status = move(EXPORT_MOVES, job.status, "error", "export job");
        job.error = "Interrupted by a server restart — export again.";
        job.finishedAt = Date.now();
        if (job.finals?.status === "waiting") job.finals = undefined; // it never got to Finals: nothing is on its way there
        await persist(job);
        chatHears(job);
      } else if (job.status === "done" && onItsWay(job.finals)) cutOff.push(job);
      // jobs persisted before the engine field existed are DOM renders
      if (!job.engine) job.engine = "wysiwyg";
      jobs.set(id, job);
    } catch {
      await rm(jobDir(id), { recursive: true, force: true }).catch(() => {});
    }
  }
})();

/** Cancel a job if still rendering and remove its files. */
async function removeJob(id: string): Promise<void> {
  const job = jobs.get(id);
  if (job && (job.status === "queued" || job.status === "running")) chatHears(job, true);
  jobs.delete(id); // runJob checks this before writing results
  const qi = queue.indexOf(id);
  if (qi >= 0) queue.splice(qi, 1);
  dropTask(EXPORT_TASK, id); // a computer that renders it stops at its next beat; the server's own run at its next progress
  await rm(jobDir(id), { recursive: true, force: true }).catch(() => {});
}

/** Deleting a project also deletes every export made from it. */
export async function deleteExportsForProject(
  projectId: string,
): Promise<void> {
  await loaded;
  for (const job of [...jobs.values()]) {
    if (job.params.projectId === projectId) await removeJob(job.id);
  }
}

// a render on its way to Finals is still being read: it stays until that ends
const finishedOf = (owner: string) =>
  [...jobs.values()].filter((j) => j.owner === owner && j.status !== "queued" && j.status !== "running" && !onItsWay(j.finals));
/** The folders of an account's finished renders (Settings → Storage counts them). */
export async function finishedExportDirs(owner: string): Promise<string[]> {
  await loaded;
  return finishedOf(owner).map((j) => jobDir(j.id));
}
/** Empty on Settings → Storage: the finished renders in `dirs` go, if they are still this account's and finished. */
export async function removeFinishedExports(owner: string, dirs: string[]): Promise<void> {
  await loaded;
  for (const job of finishedOf(owner)) if (dirs.includes(jobDir(job.id))) await removeJob(job.id);
}


/* ---- render queue (renders here are CPU-bound: run a few at most, EXPORT_CONCURRENCY) ---- */

const queue: string[] = [];
let running = 0;
/** Renders a restart of the server would end (they come back as failed): a deploy waits for 0 (/api/health). */
export const exportsAtRisk = (): number => running + queue.length;

function pump(): void {
  while (running < MAX_CONCURRENT && queue.length > 0) {
    const id = queue.shift()!;
    const job = jobs.get(id);
    if (!job) continue;
    running++;
    void runJob(job)
      .catch(() => {})
      .finally(() => {
        running--;
        pump();
      });
  }
}

/** The task's inputs where its kind serves them (work/tasks/export.ts): the clip as a link to its original, the ASS or the frame spec beside the job. */
const sourceLink = (id: string) => path.join(jobDir(id), "source");

const inputOf = (job: Job): ExportInput => ({
  id: job.id,
  kind: job.kind,
  engine: job.engine,
  format: job.format,
  ext: job.ext,
  filename: job.filename,
  width: job.params.width,
  height: job.params.height,
  fps: job.params.fps,
  duration: job.params.duration,
  crf: job.params.crf,
  ...(job.params.coverAt !== undefined ? { coverAt: job.params.coverAt } : {}),
});

/**
 * Starts the render as a computer task (work/tasks/export.ts): run here now where mayRunHere says the server may (This
 * Mac, or its video work on and no computer of the owner can take it), else queued for one of the owner's computers,
 * waiting with one line while none can. Whichever renders it, its progress moves the job and its apply finishes it.
 */
async function runJob(job: Job): Promise<void> {
  try {
    const { projectId, clipId } = job.params;
    if (job.kind === "burn") {
      const src = await ensureProjectOriginal(projectId!, clipId!, projectOriginal(projectId!, clipId));
      if (!src) throw new Error("Source video is not on the server");
      await rm(sourceLink(job.id), { force: true });
      await symlink(src, sourceLink(job.id));
    }
    if (!jobs.has(job.id)) return; // removed while its original was fetched
    const got = await startTask<ExportInput, null>(EXPORT_TASK, job.id, job.owner ?? "", job.params.workspace ?? null, inputOf(job));
    if (got.state === "queued") announceSoon(job.owner, "exports"); // its wait line (publicJob)
  } catch (e) {
    await exportFailed(job.id, e instanceof Error ? e.message : String(e));
  }
}

/** The render's progress, from whichever machine renders it (its `progress` call): `stop` when the job was removed. */
export async function exportProgress(id: string, body: unknown): Promise<{ stop?: true }> {
  await loaded;
  const job = jobs.get(id);
  if (!job || (job.status !== "queued" && job.status !== "running")) return { stop: true };
  const b = (body ?? {}) as { progress?: unknown; note?: unknown };
  if (job.status === "queued") job.status = move(EXPORT_MOVES, job.status, "running", "export job");
  if (typeof b.progress === "number" && Number.isFinite(b.progress)) job.progress = Math.min(Math.max(b.progress, 0), 0.99);
  if (typeof b.note === "string") job.note = b.note.slice(0, 200);
  else if (b.note === null) delete job.note;
  await jobPersist(job);
  return {};
}

/** The rendered file came (the task's apply, on the server): kept as the job's file, then Finals and the chat. */
export async function exportRendered(id: string, file: string): Promise<void> {
  await loaded;
  const job = jobs.get(id);
  if (!job || (job.status !== "queued" && job.status !== "running")) return; // removed or ended meanwhile
  await keep(file, outPath(job));
  const st = await stat(outPath(job));
  if (!jobs.has(job.id)) return; // removed while the file was kept
  if (job.status === "queued") job.status = move(EXPORT_MOVES, job.status, "running", "export job");
  job.status = move(EXPORT_MOVES, job.status, "done", "export job");
  job.progress = 1;
  track("export", { ok: true, kind: job.kind, format: job.format, engine: job.engine, seconds: Math.round((Date.now() - job.createdAt) / 1000), mb: Math.round(st.size / 1e6) });
  job.bytes = st.size;
  job.finishedAt = Date.now();
  delete job.note;
  for (const f of ["render.json", "captions.ass", "source"]) await rm(path.join(jobDir(id), f), { force: true }).catch(() => {});
  await jobPersist(job);
  // success only: an error, a cancel and the restart recovery (which marks jobs as failed) do not emit
  emitEvent("export.finished", { id: job.id, owner: job.owner, kind: job.kind, format: job.format, bytes: st.size });
  if (job.params.finals && job.owner) await sendToFinals(job);
  chatHears(job);
}

/** The render failed for good (the task's three tries, or at once on the server): the job shows why. */
export async function exportFailed(id: string, error: string): Promise<void> {
  await loaded;
  const job = jobs.get(id);
  // cancelled: its dir is gone, don't resurrect it; a job already done keeps its file
  if (!job || !canMove(EXPORT_MOVES, job.status, "error")) return;
  job.status = move(EXPORT_MOVES, job.status, "error", "export job");
  job.error = error;
  track("export", { ok: false, kind: job.kind, format: job.format, engine: job.engine, seconds: Math.round((Date.now() - job.createdAt) / 1000) });
  job.finishedAt = Date.now();
  delete job.note;
  if (job.finals?.status === "waiting") job.finals = undefined; // it never got to Finals: nothing is on its way there
  await rm(sourceLink(id), { force: true }).catch(() => {});
  await jobPersist(job);
  if (job.params.chat) console.warn(`[exports] ${job.id} failed: ${job.error}`);
  chatHears(job);
}

/** One-click Send to Finals: the finished render goes into the owner's library and its Finals piece. Never throws; the outcome is on the job. */
async function sendToFinals(job: Job): Promise<void> {
  if (job.finals?.status === "sending") return; // one send at a time: the older Save to Content can ask while the job's own send runs
  job.finals = { status: "sending" };
  let out: FinalsOutcome;
  try {
    out = await addToFinals(
      {
        owner: job.owner!,
        // the Finals of the workspace the render was made in ("": the account's first library, as before workspaces)
        libraryId: (await ensureLibrary(job.owner!, job.params.workspace ?? "")) ?? "",
        label: job.params.finalsLabel ?? job.filename,
        item: null,
        kind: "export",
        width: job.params.width ?? 0,
        height: job.params.height ?? 0,
      },
      { file: outPath(job), filename: job.filename, export: job.id },
    );
  } catch (e) {
    out = { ok: false, code: "failed", error: e instanceof Error ? e.message : String(e) };
  }
  // waiting: on its way to a computer that is offline, it goes into its Finals piece once it is there
  job.finals = out.ok
    ? { status: "sent", pieceId: out.pieceId }
    : { status: out.code === "refused" ? "refused" : out.code === "waiting" ? "waiting" : "error", error: out.error };
  await jobPersist(job);
}

/** A final that waited for an offline computer is in its Finals piece now (work/tasks/library-save.ts): the job's
 *  Finals state says so, and the tray follows (jobPersist announces it). */
export async function finalsLanded(id: string, pieceId: string): Promise<void> {
  await loaded;
  const job = jobs.get(id);
  if (!job || job.finals?.status !== "waiting") return;
  job.finals = { status: "sent", pieceId };
  await jobPersist(job);
}

/**
 * After a restart (boot.ts, once the plug-ins and their Finals guards are loaded): a finished render whose send to
 * Finals was cut off is sent again, once, and its chat hears the end it never got. Finals knows a file by its hash
 * (addToFinals), so one that had arrived is linked again, never filed twice. Not part of the load: nothing waits for it.
 */
export async function resumeFinalsSends(): Promise<void> {
  await loaded;
  for (const job of cutOff.splice(0)) {
    if (!jobs.has(job.id)) continue; // deleted since
    // in a deploy's reload the process before this one may have ended the send itself, after this one read the job
    const now = await readFile(path.join(jobDir(job.id), "job.json"), "utf-8").then((t) => (JSON.parse(t) as Job).finals, () => job.finals);
    if (onItsWay(now)) {
      job.finals = { status: "waiting" };
      await sendToFinals(job);
    } else {
      job.finals = now;
      announceSoon(job.owner, "exports");
    }
    chatHears(job);
  }
}

/* ---- routes ---- */

interface CreateBody {
  kind: "burn" | "overlay";
  engine?: "native" | "wysiwyg";
  renderSpec?: CaptionRenderSpec;
  /** Client-built ASS document (required for the native engine). */
  ass?: string;
  format: string;
  name?: string;
  duration: number;
  projectId?: string;
  clipId?: string;
  crf?: number;
  width?: number;
  height?: number;
  fps?: number;
  /** burn only: the second of the source whose frame becomes frame 0 */
  coverAt?: number;
  /** burn only: send the render to the owner's Finals when it is done */
  finals?: boolean;
  /** burn only: the assistant's tool started it, so the chat is told how it ended */
  chat?: boolean;
}

const OVERLAY_FORMATS: Record<string, string> = {
  mov: "mov",
  webm: "webm",
  png: "zip",
};

function sanitizeName(name: unknown): string {
  if (typeof name !== "string") return "captions";
  const clean = name
    .replace(/[^\w.\- ]+/g, "")
    .trim()
    .slice(0, 80);
  return clean || "captions";
}

function validRenderSpec(
  value: unknown,
  width: number,
  height: number,
): value is CaptionRenderSpec {
  if (!value || typeof value !== "object") return false;
  const spec = value as Partial<CaptionRenderSpec>;
  if (
    spec.width !== width ||
    spec.height !== height ||
    !Array.isArray(spec.cues) ||
    !Array.isArray(spec.posSegments) ||
    !Array.isArray(spec.texts) ||
    !spec.style ||
    typeof spec.style !== "object"
  ) {
    return false;
  }
  if (spec.cues.length > 100_000 || spec.texts.length > 10_000) return false;
  return spec.cues.every(
    (cue) =>
      Number.isFinite(cue?.start) &&
      Number.isFinite(cue?.end) &&
      Array.isArray(cue?.words) &&
      cue.words.every(
        (word) =>
          typeof word?.text === "string" &&
          word.text.length <= 10_000 &&
          Number.isFinite(word.start) &&
          Number.isFinite(word.end),
      ),
  );
}

exportsApp.post("/", async (c) => {
  await loaded;
  let body: CreateBody;
  try {
    body = await c.req.json<CreateBody>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const { kind, format } = body;
  const duration = Number(body.duration);
  if (!(duration > 0 && duration <= 3600)) {
    return c.json({ error: "Invalid duration" }, 400);
  }
  const W = Math.round(Number(body.width));
  const H = Math.round(Number(body.height));
  const FPS = Number(body.fps);
  if (!(W >= 16 && W <= 4096 && H >= 16 && H <= 4096)) {
    return c.json({ error: "Invalid resolution" }, 400);
  }
  if (!(FPS >= 1 && FPS <= 120)) {
    return c.json({ error: "Invalid fps" }, 400);
  }
  const engine = body.engine === "wysiwyg" ? "wysiwyg" : "native";
  if (engine === "native") {
    if (
      typeof body.ass !== "string" ||
      !body.ass.length ||
      body.ass.length > 5_000_000
    ) {
      return c.json({ error: "Invalid ASS payload" }, 400);
    }
  } else if (!validRenderSpec(body.renderSpec, W, H)) {
    return c.json(
      {
        error:
          "Invalid visual render payload — reload the editor and export again.",
      },
      400,
    );
  }
  const base = sanitizeName(body.name);
  const coverAt = body.coverAt === undefined || body.coverAt === null ? undefined : Number(body.coverAt);
  if (coverAt !== undefined && !(coverAt >= 0 && coverAt < duration)) return c.json({ error: "Invalid cover frame" }, 400);
  // Finals is 1080p or more, checked here and again on the file's size when it is in
  if (body.finals && kind === "burn" && belowHd(W, H)) return c.json({ error: belowHd(W, H) }, 409);

  let job: Job;
  if (kind === "burn") {
    if (format !== "h264" && format !== "h265") {
      return c.json({ error: "Unsupported format" }, 400);
    }
    const projectId = body.projectId ?? "";
    if (!okId(projectId)) return c.json({ error: "Invalid project" }, 400);
    const clipId = body.clipId ?? "";
    if (!okId(clipId)) return c.json({ error: "Invalid clip" }, 400);
    const user = c.get("user");
    const meta = await projectMeta(projectId);
    // unreadable meta → not yours
    if (user.role !== "admin" && meta?.owner !== user.username)
      return c.json({ error: "Invalid project" }, 400);
    if (
      !(await projectOriginalExists(
        projectId,
        clipId,
        projectOriginal(projectId, clipId),
      ))
    ) {
      return c.json(
        { error: "Source video is not on the server", code: "NO_ORIGINAL" },
        409,
      );
    }
    job = {
      id: randomUUID(),
      kind,
      engine,
      format,
      ext: "mp4",
      filename: `${base}-captioned.mp4`,
      status: "queued",
      progress: 0,
      createdAt: Date.now(),
      params: {
        projectId,
        clipId,
        width: W,
        height: H,
        fps: FPS,
        duration,
        crf: body.crf,
        ...(coverAt !== undefined ? { coverAt } : {}),
        ...(body.finals ? { finals: true, finalsLabel: base } : {}),
        ...(body.chat ? { chat: true } : {}),
        // the project's workspace, not the window's: a render belongs where its project is
        workspace: workspaceOf(meta),
      },
    };
  } else if (kind === "overlay") {
    const ext = OVERLAY_FORMATS[format];
    if (!ext) return c.json({ error: "Unsupported format" }, 400);
    job = {
      id: randomUUID(),
      kind,
      engine,
      format,
      ext,
      filename: `${base}-captions-alpha.${ext === "zip" ? "png.zip" : ext}`,
      status: "queued",
      progress: 0,
      createdAt: Date.now(),
      params: {
        width: W,
        height: H,
        fps: FPS,
        duration,
        // overlay renders don't read project files, but tagging the source
        // project lets project deletion clean these up too
        projectId: okId(body.projectId ?? "") ? body.projectId : undefined,
        workspace: okId(body.projectId ?? "")
          ? workspaceOf(await projectMeta(body.projectId!))
          : await currentWorkspaceId(c.get("user")),
      },
    };
  } else {
    return c.json({ error: "Unknown export kind" }, 400);
  }

  try {
    job.owner = c.get("user")?.username;
    if (job.params.finals) job.finals = { status: "waiting" };
    if (job.owner) bumpUsage(job.owner, { renders: 1 });
    await mkdir(jobDir(job.id), { recursive: true });
    if (engine === "native") {
      await writeFile(
        path.join(jobDir(job.id), "captions.ass"),
        body.ass!,
        "utf-8",
      );
    } else {
      await writeFile(
        path.join(jobDir(job.id), "render.json"),
        JSON.stringify(body.renderSpec),
        "utf-8",
      );
    }
    jobs.set(job.id, job);
    await persist(job);
    queue.push(job.id);
    pump();
    return c.json(publicJob(job));
  } catch (e) {
    jobs.delete(job.id);
    await rm(jobDir(job.id), { recursive: true, force: true }).catch(() => {});
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

/* own jobs, newest first — the client tray polls this. Personal like
   the project list: admins keep only ownerless legacy jobs, not other
   users' (by-id routes still allow admin access). */
exportsApp.get("/", async (c) => {
  await loaded;
  const user = c.get("user");
  const here = await inCurrentWorkspace(user);
  const all = [...jobs.values()]
    .filter(
      (j) =>
        (j.owner === user.username || (user.role === "admin" && !j.owner)) &&
        (!here || here(j.params.workspace)),
    )
    .sort((a, b) => b.createdAt - a.createdAt);
  return c.json(all.map(publicJob));
});

/* several finished exports as one ZIP. Stored, not compressed (videos don't shrink), streamed
   as it is written; entries carry each export's own file name. */
exportsApp.get("/zip", async (c) => {
  await loaded;
  const user = c.get("user");
  const ready = (c.req.query("ids") ?? "")
    .split(",")
    .map((id) => jobs.get(id))
    .filter((j): j is Job => !!j && canSee(j, user) && j.status === "done" && existsSync(outPath(j)));
  if (!ready.length) return c.json({ error: "Nothing to download" }, 404);
  const name = (c.req.query("name") || "exports").replace(/[^\w.-]+/g, "_").slice(0, 80);
  const zip = new ZipFile();
  const used = new Set<string>();
  for (const j of ready) {
    let entry = j.filename;
    for (let k = 2; used.has(entry); k++) entry = j.filename.replace(/(\.[^.]+)?$/, `-${k}$1`);
    used.add(entry);
    zip.addFile(outPath(j), entry, { compress: false });
  }
  zip.end();
  return new Response(Readable.toWeb(zip.outputStream as Readable) as unknown as ReadableStream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${name}.zip"`,
    },
  });
});

exportsApp.get("/:id", async (c) => {
  await loaded;
  const job = jobs.get(c.req.param("id"));
  if (!job || !canSee(job, c.get("user")))
    return c.json({ error: "Not found" }, 404);
  return c.json(publicJob(job));
});

/* download a finished export (works across reloads / new tabs) */
exportsApp.get("/:id/file", async (c) => {
  await loaded;
  const job = jobs.get(c.req.param("id"));
  if (!job || !canSee(job, c.get("user")))
    return c.json({ error: "Not found" }, 404);
  if (job.status !== "done") return c.json({ error: "Not ready" }, 409);
  const p = outPath(job);
  if (!existsSync(p)) return c.json({ error: "File expired" }, 410);
  const st = await stat(p);
  const type =
    job.ext === "mp4"
      ? "video/mp4"
      : job.ext === "mov"
        ? "video/quicktime"
        : job.ext === "webm"
          ? "video/webm"
          : "application/zip";
  return new Response(
    Readable.toWeb(createReadStream(p)) as unknown as ReadableStream,
    {
      headers: {
        "Content-Type": type,
        "Content-Length": String(st.size),
        "Content-Disposition": `attachment; filename="${job.filename}"`,
      },
    },
  );
});

/* a finished export into the Media Library ({ libraryId? }: else the workspace's first): a new asset, made from the
   library version its clip came from (derived_from) */
exportsApp.post("/:id/library", async (c) => {
  await loaded;
  const user = c.get("user");
  const job = jobs.get(c.req.param("id"));
  if (!job || !canSee(job, user)) return c.json({ error: "Not found" }, 404);
  if (job.status !== "done") return c.json({ error: "Not ready" }, 409);
  if (user.role !== "admin" && user.off.includes("media")) return c.json({ error: "Not found" }, 404); // as boot.ts TOOL_GATES
  if (!mayChange(user, "media")) return c.json({ error: "Media Library is read-only for your account", code: "READ_ONLY" }, 403);
  if (job.ext === "zip") return c.json({ error: "A PNG sequence cannot be sent to the Media Library" }, 400);
  const p = outPath(job);
  if (!existsSync(p)) return c.json({ error: "File expired" }, 410);
  const body = (await c.req.json().catch(() => null)) as { libraryId?: unknown } | null;
  const clip = job.params.projectId && job.params.clipId ? await readProjectClip(job.params.projectId, job.params.clipId) : null;
  const saved = await saveToLibrary(
    user.username,
    p,
    job.filename,
    clip?.libraryVersionId ? [clip.libraryVersionId] : [],
    typeof body?.libraryId === "string" ? body.libraryId : undefined,
  );
  if (!saved) return c.json({ error: "Needs a Media Library", code: "not_found" }, 404);
  if ("error" in saved) return c.json(saved, 507);
  // Upload none and their computer offline: it lands in their Final exports folder once it is back
  if ("waiting" in saved) return c.json(saved, 202);
  return c.json(saved);
});

/* Save to Content, an older path kept for older clients: a finished captioned export goes to
   Finals, exactly as a Send to Finals does (sendToFinals). Never below 1080p. */
exportsApp.post("/:id/content", async (c) => {
  await loaded;
  const user = c.get("user");
  const job = jobs.get(c.req.param("id"));
  if (!job || !canSee(job, user)) return c.json({ error: "Not found" }, 404);
  if (user.role !== "admin") return c.json({ error: "Only an admin can send an export to Finals" }, 403);
  if (job.kind !== "burn" || job.status !== "done" || !job.owner) return c.json({ error: "Only a finished export with captions can be sent to Finals" }, 409);
  if (!existsSync(outPath(job))) return c.json({ error: "File expired" }, 410);
  const small = belowHd(job.params.width, job.params.height);
  if (small) return c.json({ error: small }, 409);
  await sendToFinals(job);
  return c.json({ finals: job.finals }, job.finals?.status === "sent" ? 201 : 409);
});

/* Stop: a queued or running job ends (Home's Activity); a finished one is left as it is */
exportsApp.post("/:id/stop", async (c) => {
  await loaded;
  const job = jobs.get(c.req.param("id"));
  if (!job || !canSee(job, c.get("user"))) return c.json({ error: "Not found" }, 404);
  if (job.status === "queued" || job.status === "running") await removeJob(job.id);
  return c.json({ ok: true });
});

/* cancel a running job, or delete a finished one */
exportsApp.delete("/:id", async (c) => {
  await loaded;
  const id = c.req.param("id");
  const job = jobs.get(id);
  if (!job || !canSee(job, c.get("user")))
    return c.json({ error: "Not found" }, 404);
  await removeJob(id);
  return c.json({ ok: true });
});
