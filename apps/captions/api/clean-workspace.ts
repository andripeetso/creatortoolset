import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import type { AuthVars } from "./auth";
import type { CleanSource, CleanVersion } from "../contracts/clean-workspace";
import { env } from "./lib/env";
import {
  createCleanCopy,
  md5,
  metadataItems,
  probe,
  TYPES,
  videoDimensions,
} from "./lib/clean-media";
import { measureFingerprints } from "./lib/clean-fingerprints";
import { LatestDrafts, type DraftTicket } from "./lib/clean-drafts";
import { cleanExportOptions, editOptionsSchema } from "../contracts/clean-edit";
import { renderEdit, renderEditFrame, validateEdit } from "./lib/clean-edit";

import { quickScore } from "./lib/clean-score";
import { detectCuts } from "./lib/clean-cuts";
import {
  acceptCleanerClip,
  captionClipForCleaner,
  linkOrCopy,
} from "./projects";
import { remapCaptionData } from "./lib/clean-caption-map";
import { createCleanBatchApp } from "./clean-batch";
import { cleanupAudit, inspectMetadata } from "./lib/clean-inspection";
import { timelineDuration } from "../contracts/clean-timeline";
import { phashPerSecond } from "./library/fingerprint";
import { similarTo, similarToPosted, type ClipSpeech } from "./library/similar";
import { NeedsKey, transcribeFile } from "./library/transcribe";

export const cleanWorkspaceApp = new Hono<{ Variables: AuthVars }>();
const ROOT = path.join(env.dataDir, "clean", "sources");
const KEEP_MS = 60 * 60_000;
// a session goes an hour after its last operation
const expired = (source: StoredSource) => source.expiresAt <= Date.now();
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const busy = new Set<string>();
const drafts = new LatestDrafts();
const scores = new LatestDrafts();
const semanticScores = new LatestDrafts();
const sourceBusy = (id: string) =>
  busy.has(id) || busy.has(`score:${id}`) || busy.has(`sscd:${id}`);
function draftTicket(c: Context): DraftTicket {
  const client = c.req.header("X-Clean-Client");
  const revision = c.req.header("X-Clean-Revision");
  if (!client && !revision) return { client: randomUUID(), revision: 1 };
  if (
    !client ||
    !UUID.test(client) ||
    !revision ||
    !/^\d+$/.test(revision) ||
    !Number.isSafeInteger(Number(revision)) ||
    Number(revision) < 1
  )
    throw new HTTPException(400, { message: "Invalid draft request." });
  return { client, revision: Number(revision) };
}
interface StoredSource extends CleanSource {
  owner: string;
  captionData?: Record<string, unknown>;
  transfers?: Record<string, { projectId: string; clipId: string }>;
}
const folder = (id: string) => path.join(ROOT, id);
export const originalPath = (source: CleanSource) =>
  path.join(folder(source.id), `original.${source.ext}`);
const versionPath = (source: CleanSource, id: string) =>
  path.join(folder(source.id), `${id}.${source.ext}`);
const publicSource = (source: StoredSource): CleanSource => ({
  id: source.id,
  name: source.name,
  ext: source.ext,
  bytes: source.bytes,
  duration: source.duration,
  width: source.width,
  height: source.height,
  metadata: source.metadata,
  inspection: source.inspection,
  md5: source.md5,
  expiresAt: source.expiresAt,
  versions: source.versions,
  ...(source.captionOrigin ? { captionOrigin: source.captionOrigin } : {}),
});
const optionsSchema = z
  .object({ stripMetadata: z.boolean(), unique: z.boolean() })
  .strict();

cleanWorkspaceApp.onError((error, c) => {
  if (error.name === "AbortError")
    return c.json({ error: "Replaced by a newer adjustment." }, 409);
  if (error instanceof HTTPException)
    return c.json({ error: error.message }, error.status);
  return c.json(
    {
      error:
        error.message ||
        "Could not finish this operation. Your original is still available.",
    },
    500,
  );
});

async function readSource(id: string): Promise<StoredSource | null> {
  if (!UUID.test(id)) return null;
  try {
    return JSON.parse(
      await readFile(path.join(folder(id), "session.json"), "utf8"),
    ) as StoredSource;
  } catch {
    return null;
  }
}

const sourceWrites = new Map<string, Promise<void>>();
export async function saveSource(source: StoredSource, touchOnly = false) {
  const previous = sourceWrites.get(source.id) ?? Promise.resolve();
  const task = previous
    .catch(() => undefined)
    .then(async () => {
      const current = touchOnly ? await readSource(source.id) : source;
      if (!current)
        throw new HTTPException(404, {
          message: "This video session is no longer available.",
        });
      current.expiresAt = Date.now() + KEEP_MS;
      const temp = path.join(folder(source.id), "session.json.tmp");
      await writeFile(temp, JSON.stringify(current), { mode: 0o600 });
      await rename(temp, path.join(folder(source.id), "session.json"));
    });
  sourceWrites.set(source.id, task);
  try {
    await task;
  } finally {
    if (sourceWrites.get(source.id) === task) sourceWrites.delete(source.id);
  }
}

export async function ownedSource(
  c: Context<{ Variables: AuthVars }>,
  id = c.req.param("id") || "",
) {
  const source = await readSource(id);
  const user = c.get("user");
  if (!source || (source.owner !== user.username && user.role !== "admin")) {
    throw new HTTPException(404, {
      message:
        "This video session is no longer available. Upload the video again.",
    });
  }
  if (expired(source) && !sourceBusy(source.id)) {
    await rm(folder(source.id), { recursive: true, force: true });
    throw new HTTPException(410, {
      message: "This video session expired. Upload the video again.",
    });
  }
  return source;
}

function reserveSources(ids: string[]) {
  if (ids.some((value) => busy.has(value)))
    throw new HTTPException(409, {
      message:
        "This video is already being processed. Wait for the current run to finish.",
    });
  ids.forEach((value) => busy.add(value));
  // Idempotent: a batch releases early before publishing its end state, then again in its finally block.
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    ids.forEach((value) => busy.delete(value));
  };
}
async function exclusively<T>(id: string | string[], work: () => Promise<T>) {
  const release = reserveSources(Array.isArray(id) ? id : [id]);
  try {
    return await work();
  } finally {
    release();
  }
}

async function sweepSources() {
  for (const entry of await readdir(ROOT, { withFileTypes: true }).catch(
    () => [],
  )) {
    if (
      !entry.isDirectory() ||
      !UUID.test(entry.name) ||
      sourceBusy(entry.name)
    )
      continue;
    const source = await readSource(entry.name);
    const modified = (await stat(folder(entry.name)).catch(() => null))
      ?.mtimeMs;
    if (
      (source && expired(source)) ||
      (!source && modified && modified < Date.now() - KEEP_MS)
    ) {
      await rm(folder(entry.name), { recursive: true, force: true });
    }
  }
}

// Keep retained originals and versions short-lived even when no new upload arrives.
const cleanup = setInterval(() => {
  void sweepSources().catch(() => undefined);
}, 60_000);
cleanup.unref();
(
  import.meta as ImportMeta & { hot?: { dispose: (fn: () => void) => void } }
).hot?.dispose(() => clearInterval(cleanup));

cleanWorkspaceApp.post("/", async (c) => {
  const name = (c.req.query("name") || "video.mp4").slice(0, 120);
  const ext = path.extname(name).slice(1).toLowerCase();
  if (!TYPES[ext])
    return c.json(
      { error: "Choose an MP4, MOV, M4V, MKV or WebM video." },
      400,
    );
  const body = c.req.raw.body;
  if (!body) return c.json({ error: "No video body." }, 400);
  await sweepSources();
  const id = randomUUID();
  return exclusively(id, async () => {
    const dir = folder(id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `original.${ext}`);
    try {
      await pipeline(
        Readable.fromWeb(body as never),
        createWriteStream(file, { mode: 0o600 }),
      );
      const info = await probe(file);
      const video = info.streams?.find(
        (s) => s.codec_type === "video" && !s.disposition?.attached_pic,
      );
      if (!video) throw new Error("The file does not contain a video track.");
      const duration = Number(info.format?.duration);
      const source: StoredSource = {
        id,
        owner: c.get("user").username,
        name,
        ext,
        bytes: (await stat(file)).size,
        duration: Number.isFinite(duration) && duration > 0 ? duration : null,
        width: videoDimensions(info).width || null,
        height: videoDimensions(info).height || null,
        metadata: metadataItems(info),
        inspection: await inspectMetadata(file, undefined, info),
        md5: await md5(file),
        versions: [],
        expiresAt: 0,
      };
      await saveSource(source);
      return c.json(publicSource(source), 201);
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Could not upload this video.",
        },
        400,
      );
    }
  });
});

cleanWorkspaceApp.post("/from-captions", async (c) => {
  const parsed = z
    .object({
      projectId: z.string().regex(UUID),
      clipId: z.string().regex(UUID),
    })
    .strict()
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json({ error: "Choose a saved Caption Studio clip." }, 400);
  const clip = await captionClipForCleaner(
    parsed.data.projectId,
    parsed.data.clipId,
    c.get("user"),
  );
  const id = randomUUID();
  return exclusively(id, async () => {
    await mkdir(folder(id), { recursive: true, mode: 0o700 });
    try {
      const info = await probe(clip.file);
      // Container sniffing is independent of the project's extensionless source path.
      const format = info.format?.format_name ?? "";
      const ext = /webm|matroska/.test(format)
        ? "mkv"
        : /mov|mp4/.test(format)
          ? "mp4"
          : path.extname(clip.name).slice(1).toLowerCase();
      if (!TYPES[ext])
        throw new HTTPException(400, {
          message: "This source container cannot be opened in Cleaner.",
        });
      const source: StoredSource = {
        id,
        owner: c.get("user").username,
        name: clip.name,
        ext,
        bytes: (await stat(clip.file)).size,
        duration: Number(info.format?.duration),
        ...videoDimensions(info),
        metadata: metadataItems(info),
        inspection: await inspectMetadata(clip.file, undefined, info),
        md5: await md5(clip.file),
        versions: [],
        expiresAt: 0,
        captionOrigin: clip.origin,
        captionData: clip.data,
      };
      await linkOrCopy(clip.file, originalPath(source));
      await saveSource(source);
      return c.json(publicSource(source), 201);
    } catch (error) {
      await rm(folder(id), { recursive: true, force: true });
      throw error;
    }
  });
});

cleanWorkspaceApp.route(
  "/batch",
  createCleanBatchApp({
    root: path.join(env.dataDir, "clean", "batches"),
    source: ownedSource,
    input: originalPath,
    reserve: reserveSources,
    stop: (id) =>
      Promise.all([
        drafts.stop(id),
        scores.stop(id),
        semanticScores.stop(id),
      ]).then(() => undefined),
    touch: (source) => saveSource(source as StoredSource, true),
  }),
);
cleanWorkspaceApp.get("/:id", async (c) => {
  const source = await ownedSource(c);
  if (!source.inspection)
    source.inspection = await inspectMetadata(originalPath(source));
  return c.json(publicSource(source));
});

// Read the two immutable uploads directly. No render or retained comparison copy.
cleanWorkspaceApp.post("/:id/compare", async (c) => {
  const parsed = z
    .object({ otherId: z.string().regex(UUID) })
    .strict()
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json({ error: "Choose a second uploaded video to compare." }, 400);
  const before = await ownedSource(c);
  const after = await ownedSource(c, parsed.data.otherId);
  if (before.id === after.id)
    return c.json({ error: "Choose two different uploads to compare." }, 400);
  return exclusively([before.id, after.id], async () => {
    // A delete could have completed between the ownership checks and the lock.
    const [left, right] = await Promise.all([
      ownedSource(c, before.id),
      ownedSource(c, after.id),
    ]);
    const fingerprints = await measureFingerprints(
      originalPath(left),
      originalPath(right),
    );
    await Promise.all([saveSource(left), saveSource(right)]);
    return c.json({
      beforeId: left.id,
      afterId: right.id,
      measuredAt: Date.now(),
      fingerprints,
    });
  });
});

// Duplicate check: this upload's pictures against the videos in the caller's Media Library (library/similar.ts),
// and against the caller's own posted reels (`posted`, from the connected accounts' logins).
cleanWorkspaceApp.post("/:id/duplicates", async (c) => {
  const source = await ownedSource(c);
  const hashes = await exclusively(source.id, () =>
    phashPerSecond(originalPath(source)),
  );
  await saveSource(source, true);
  const username = c.get("user").username;
  const speech = await clipSpeech(source, username);
  return c.json({ ...similarTo(username, hashes), posted: similarToPosted(username, hashes, speech) });
});

/** The upload's words for the posted reels' voice check. Kept in the upload's folder (never sent to the browser); a failure is not kept. */
async function clipSpeech(source: StoredSource, username: string): Promise<ClipSpeech> {
  const file = path.join(folder(source.id), "speech.json");
  try {
    return { words: JSON.parse(await readFile(file, "utf8")) };
  } catch {
    // not transcribed yet
  }
  try {
    const { words } = await transcribeFile(originalPath(source), username, path.join(env.dataDir, "clean", "scratch"));
    await writeFile(file, JSON.stringify(words));
    return { words };
  } catch (e) {
    return {
      why: e instanceof NeedsKey
        ? "Pictures only: add your Deepgram key in Settings → My API keys to compare voices too."
        : "Pictures only: this upload's speech could not be transcribed.",
    };
  }
}

cleanWorkspaceApp.post("/:id/versions", async (c) => {
  const initial = await ownedSource(c);
  const parsed = optionsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json(
      { error: "Choose metadata removal and unique hash as true or false." },
      400,
    );
  const options = parsed.data;
  if (options.unique && ["mkv", "webm"].includes(initial.ext)) {
    return c.json(
      { error: "Unique file hash is available for MP4, MOV and M4V." },
      400,
    );
  }
  return exclusively(initial.id, async () => {
    const source = (await readSource(initial.id))!;
    const id = randomUUID();
    const file = versionPath(source, id);
    try {
      await createCleanCopy(originalPath(source), file, options);
      const version: CleanVersion = {
        id,
        number: source.versions.length + 1,
        createdAt: Date.now(),
        options,
        bytes: (await stat(file)).size,
        metadata: metadataItems(await probe(file)),
        md5: await md5(file),
      };
      source.versions.push(version);
      await saveSource(source);
      return c.json(publicSource(source), 201);
    } catch (error) {
      await rm(file, { force: true });
      throw error;
    }
  });
});

cleanWorkspaceApp.post("/:id/versions/:versionId/measure", async (c) => {
  const initial = await ownedSource(c);
  return exclusively(initial.id, async () => {
    const source = (await readSource(initial.id))!;
    const version = source.versions.find(
      (v) => v.id === c.req.param("versionId"),
    );
    if (!version)
      throw new HTTPException(404, {
        message: "This version is no longer available.",
      });
    version.fingerprints = await measureFingerprints(
      originalPath(source),
      versionPath(source, version.id),
    );
    await saveSource(source);
    return c.json(publicSource(source));
  });
});

cleanWorkspaceApp.post("/:id/draft/cancel", async (c) => {
  const source = await ownedSource(c);
  drafts.cancel(source.id, draftTicket(c));
  return c.body(null, 204);
});

for (const action of ["score", "sscd"] as const) {
  const lane = action === "score" ? scores : semanticScores;
  cleanWorkspaceApp.post(`/:id/${action}/cancel`, async (c) => {
    const source = await ownedSource(c);
    lane.cancel(source.id, draftTicket(c));
    return c.body(null, 204);
  });
  cleanWorkspaceApp.post(`/:id/${action}`, async (c) => {
    const source = await ownedSource(c);
    const parsed = editOptionsSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success || !source.width || !source.height || !source.duration)
      return c.json(
        { error: "Invalid score settings or source duration." },
        400,
      );
    const info = {
      width: source.width,
      height: source.height,
      duration: source.duration,
    };
    return lane.run(source.id, draftTicket(c), c.req.raw.signal, (signal) =>
      exclusively(`${action}:${source.id}`, async () => {
        await saveSource(source, true);
        return c.json(
          await quickScore(
            originalPath(source),
            parsed.data,
            info,
            signal,
            action,
          ),
        );
      }),
    );
  });
}
cleanWorkspaceApp.post("/:id/cuts", async (c) => {
  const source = await ownedSource(c);
  const parsed = z
    .object({ threshold: z.number().min(0.05).max(0.8).default(0.3) })
    .strict()
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success || !source.duration)
    return c.json({ error: "Invalid scene detection settings." }, 400);
  return drafts.run(source.id, draftTicket(c), c.req.raw.signal, (signal) =>
    exclusively(source.id, async () =>
      c.json(
        await detectCuts(
          originalPath(source),
          source.duration!,
          parsed.data.threshold,
          signal,
        ),
      ),
    ),
  );
});
cleanWorkspaceApp.post("/:id/to-captions", async (c) => {
  const initial = await ownedSource(c);
  const parsed = editOptionsSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success)
    return c.json({ error: "Invalid editing settings." }, 400);
  await drafts.stop(initial.id);
  return exclusively(initial.id, async () => {
    const source = (await readSource(initial.id))!;
    const options = cleanExportOptions(parsed.data);
    const key = createHash("sha256")
      .update(JSON.stringify(options))
      .digest("hex");
    if (source.transfers?.[key]) return c.json(source.transfers[key]);
    const dir = await mkdtemp(path.join(folder(source.id), ".edit-"));
    try {
      const file = path.join(dir, "edited.mp4");
      const info = await validateEdit(
        originalPath(source),
        options,
        c.req.raw.signal,
      );
      await renderEdit(
        originalPath(source),
        file,
        options,
        c.req.raw.signal,
        info,
      );
      const dimensions = videoDimensions(await probe(file));
      const result = await acceptCleanerClip({
        user: c.get("user"),
        file,
        name: source.name.replace(/\.[^.]+$/, "") + " · Cleaner.mp4",
        duration: timelineDuration(info.timeline),
        ...dimensions,
        data: remapCaptionData(
          source.captionData ?? {},
          info.timeline,
          options.adjustments.speed,
        ),
        transferId: source.id + ":" + key,
        origin: source.captionOrigin,
        scenes: info.timeline.length,
      });
      source.transfers = { ...source.transfers, [key]: result };
      await saveSource(source);
      return c.json(result, 201);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// Draft operations never append to version history. Only one temporary render
// exists during an operation; measured outputs and frames are deleted immediately.
cleanWorkspaceApp.post("/:id/frame", async (c) => {
  const source = await ownedSource(c);
  const parsed = z
    .object({
      options: editOptionsSchema,
      seconds: z.number().min(0).max(86400),
    })
    .strict()
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json({ error: "Invalid preview settings." }, 400);
  return drafts.run(source.id, draftTicket(c), c.req.raw.signal, (signal) =>
    exclusively(source.id, async () => {
      const dir = await mkdtemp(path.join(folder(source.id), ".edit-"));
      try {
        const file = path.join(dir, "frame.png");
        await renderEditFrame(
          originalPath(source),
          file,
          parsed.data.options,
          parsed.data.seconds,
          signal,
        );
        await saveSource((await readSource(source.id))!);
        return new Response(new Uint8Array(await readFile(file)), {
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "private, no-store",
          },
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }),
  );
});

for (const action of ["measure", "audit", "export"] as const) {
  cleanWorkspaceApp.post(`/:id/${action}`, async (c) => {
    const initial = await ownedSource(c);
    const parsed = editOptionsSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json({ error: "Invalid editing settings." }, 400);
    const render = (signal: AbortSignal) =>
      exclusively(initial.id, async () => {
        const source = (await readSource(initial.id))!;
        const options = cleanExportOptions(parsed.data);
        let validated;
        try {
          validated = await validateEdit(originalPath(source), options, signal);
        } catch (error) {
          signal.throwIfAborted();
          return c.json(
            { error: error instanceof Error ? error.message : "Invalid edit." },
            400,
          );
        }
        const dir = await mkdtemp(path.join(folder(source.id), ".edit-"));
        const file = path.join(dir, "edited.mp4");
        let streamed = false;
        try {
          await renderEdit(
            originalPath(source),
            file,
            options,
            signal,
            validated,
          );
          const bytes = (await stat(file)).size;
          await saveSource(source);
          if (action === "measure" || action === "audit") {
            const info = await probe(file, signal);
            const audit = cleanupAudit(
              source.inspection ??
                (await inspectMetadata(originalPath(source), signal)),
              await inspectMetadata(file, signal, info),
              options.cleanup,
            );
            if (action === "audit") return c.json({ options, audit });
            return c.json({
              options,
              measuredAt: Date.now(),
              audit,
              bytes,
              md5: await md5(file),
              metadata: metadataItems(info),
              ...videoDimensions(info),
              duration: Number(info.format?.duration),
              fingerprints: await measureFingerprints(
                originalPath(source),
                file,
                {
                  start: options.adjustments.start,
                  speed: options.adjustments.speed,
                  timeline: validated.timeline,
                },
                signal,
                path.join(folder(source.id), "baseline.tmk"),
              ),
            });
          }
          const name =
            source.name
              .replace(/\.[^.]+$/, "")
              .replace(/[^\w.\- ]+/g, "")
              .trim() || "video";
          if (c.req.raw.signal.aborted) throw new Error("Download cancelled.");
          const stream = createReadStream(file);
          const abort = () => stream.destroy();
          c.req.raw.signal.addEventListener("abort", abort, { once: true });
          const clear = () => {
            c.req.raw.signal.removeEventListener("abort", abort);
            void rm(dir, { recursive: true, force: true }).catch(
              () => undefined,
            );
          };
          stream.once("close", clear);
          streamed = true;
          return new Response(
            Readable.toWeb(stream) as unknown as ReadableStream,
            {
              headers: {
                "Content-Type": "video/mp4",
                "Content-Length": String(bytes),
                "Content-Disposition": `attachment; filename="${name}-edited.mp4"`,
                "Cache-Control": "private, no-store",
              },
            },
          );
        } finally {
          if (!streamed) await rm(dir, { recursive: true, force: true });
        }
      });
    if (action !== "export")
      return drafts.run(initial.id, draftTicket(c), c.req.raw.signal, render);
    await drafts.stop(initial.id);
    return render(c.req.raw.signal);
  });
}

/** Range-aware streaming for browser previews; download is a separate explicit action. */
async function sendVideo(
  c: Context<{ Variables: AuthVars }>,
  source: CleanSource,
  version?: CleanVersion,
) {
  const file = version ? versionPath(source, version.id) : originalPath(source);
  const info = await stat(file).catch(() => null);
  if (!info)
    throw new HTTPException(404, {
      message: "This video is no longer available.",
    });
  const download = c.req.query("download") === "1";
  const headers: Record<string, string> = {
    "Content-Type": TYPES[source.ext],
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
  };
  if (download) {
    const base =
      source.name
        .replace(/\.[^.]+$/, "")
        .replace(/[^\w.\- ]+/g, "")
        .trim() || "video";
    headers["Content-Disposition"] =
      `attachment; filename="${base}-${version ? `v${version.number}` : "original"}.${source.ext}"`;
  }
  let start = 0;
  let end = info.size - 1;
  const range = !download && c.req.header("range");
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2]))
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${info.size}` },
      });
    if (match[1]) {
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
    } else {
      start = Math.max(0, info.size - Number(match[2]));
    }
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      start >= info.size
    ) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${info.size}` },
      });
    }
    // open ranges only: Apple's player rejects a closed range answered shorter
    if (match[1] && !match[2]) end = Math.min(end, start + 8 * 1024 * 1024 - 1);
    headers["Content-Range"] = `bytes ${start}-${end}/${info.size}`;
  }
  headers["Content-Length"] = String(end - start + 1);
  return new Response(
    c.req.method === "HEAD"
      ? null
      : (Readable.toWeb(
          createReadStream(file, { start, end }),
        ) as ReadableStream),
    { status: range ? 206 : 200, headers },
  );
}

cleanWorkspaceApp.get("/:id/media", async (c) =>
  sendVideo(c, await ownedSource(c)),
);
cleanWorkspaceApp.get("/:id/versions/:versionId/media", async (c) => {
  const source = await ownedSource(c);
  const version = source.versions.find(
    (v) => v.id === c.req.param("versionId"),
  );
  if (!version)
    return c.json({ error: "This version is no longer available." }, 404);
  return sendVideo(c, source, version);
});

cleanWorkspaceApp.delete("/:id", async (c) => {
  const source = await ownedSource(c);
  await Promise.all([
    scores.stop(source.id),
    semanticScores.stop(source.id),
    drafts.stop(source.id),
  ]);
  return exclusively(source.id, async () => {
    await rm(folder(source.id), { recursive: true, force: true });
    return c.json({ deleted: true });
  });
});
