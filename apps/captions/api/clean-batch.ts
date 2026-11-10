import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";
import type { AuthVars } from "./auth";
import type { CleanSource } from "../contracts/clean-workspace";
import { batchRequestSchema, type CleanBatch } from "../contracts/clean-batch";
import { cleanExportOptions } from "../contracts/clean-edit";
import { renderEdit } from "./lib/clean-edit";
import { md5 } from "./lib/clean-media";
import { cleanupAudit, inspectMetadata } from "./lib/clean-inspection";
import { announceSoon } from "./lib/announce-soon";

type Ctx = Context<{ Variables: AuthVars }>;
const KEEP_MS = 60 * 60_000;
const MAX_BATCH_BYTES = 10 * 1024 ** 3;
interface Job {
  public: CleanBatch;
  owner: string;
  dir: string;
  controller: AbortController;
  task: Promise<void>;
  downloads: number;
}
export function createCleanBatchApp(deps: {
  root: string;
  source: (c: Ctx, id: string) => Promise<CleanSource>;
  input: (source: CleanSource) => string;
  touch: (source: CleanSource) => Promise<void>;
  stop: (id: string) => Promise<void>;
  reserve: (ids: string[]) => () => void;
}) {
  const app = new Hono<{ Variables: AuthVars }>();
  const jobs = new Map<string, Job>();
  const active = (j: Job) =>
    j.public.state === "processing" || j.public.state === "packing";
  const owned = (c: Ctx, allowExpired = false) => {
    const job = jobs.get(c.req.param("jobId") ?? "");
    if (
      !job ||
      (job.owner !== c.get("user").username && c.get("user").role !== "admin")
    )
      throw new HTTPException(404, {
        message: "This batch is no longer available.",
      });
    if (!allowExpired && job.public.expiresAt <= Date.now() && !active(job))
      throw new HTTPException(410, {
        message: "This batch expired. Create a new export.",
      });
    return job;
  };
  const remove = async (job: Job) => {
    if (job.downloads)
      throw new HTTPException(409, {
        message:
          "Wait for the ZIP download to finish before clearing this batch.",
      });
    job.controller.abort();
    await job.task;
    await rm(job.dir, { recursive: true, force: true });
    jobs.delete(job.public.id);
  };
  const sweep = async () => {
    for (const job of jobs.values())
      if (!active(job) && !job.downloads && job.public.expiresAt <= Date.now())
        await remove(job);
    // A restart drops the in-memory job index; old temporary directories still expire.
    for (const entry of await readdir(deps.root, { withFileTypes: true }).catch(
      () => [],
    )) {
      if (
        !entry.isDirectory() ||
        !/^[0-9a-f-]{36}$/.test(entry.name) ||
        jobs.has(entry.name)
      )
        continue;
      const dir = path.join(deps.root, entry.name);
      const modified = (await stat(dir).catch(() => null))?.mtimeMs;
      if (modified && modified < Date.now() - KEEP_MS)
        await rm(dir, { recursive: true, force: true });
    }
  };
  const timer = setInterval(() => {
    void sweep().catch(() => undefined);
  }, 60_000);
  timer.unref();
  (
    import.meta as ImportMeta & { hot?: { dispose: (fn: () => void) => void } }
  ).hot?.dispose(() => {
    clearInterval(timer);
    jobs.forEach((job) => job.controller.abort());
  });

  app.get("/", async (c) => {
    await sweep();
    return c.json(
      [...jobs.values()].find((j) => j.owner === c.get("user").username)
        ?.public ?? null,
    );
  });
  app.post("/", async (c) => {
    await sweep();
    const parsed = batchRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json(
        {
          error:
            "Choose 1–20 different uploaded videos and valid export settings.",
        },
        400,
      );
    const sources = await Promise.all(
      parsed.data.items.map((i) => deps.source(c, i.sourceId)),
    );
    if (
      sources.reduce((sum, source) => sum + source.bytes, 0) > MAX_BATCH_BYTES
    )
      return c.json(
        {
          error:
            "A batch can contain up to 10 GB of uploaded videos. Split this selection into smaller batches.",
        },
        400,
      );
    await Promise.all(sources.map((s) => deps.stop(s.id)));
    const owner = c.get("user").username;
    // No await between capacity check, reservation and registration: concurrent requests cannot overbook.
    if ([...jobs.values()].some((j) => j.owner === owner))
      return c.json(
        { error: "Download or clear your existing batch first." },
        409,
      );
    if ([...jobs.values()].filter(active).length >= 2 || jobs.size >= 20)
      return c.json({ error: "Batch export is busy. Try again shortly." }, 429);
    const release = deps.reserve(sources.map((s) => s.id));
    const id = randomUUID();
    const job: Job = {
      public: {
        id,
        state: "processing",
        completed: 0,
        total: sources.length,
        results: [],
        expiresAt: Date.now() + KEEP_MS,
      },
      owner,
      dir: path.join(deps.root, id),
      controller: new AbortController(),
      task: Promise.resolve(),
      downloads: 0,
    };
    jobs.set(id, job);
    job.task = (async () => {
      const signal = job.controller.signal;
      const deadline = setTimeout(() => job.controller.abort(), 30 * 60_000);
      deadline.unref();
      try {
        // Recheck after taking locks in case a delete completed during authorization.
        await Promise.all(sources.map((s) => deps.source(c, s.id)));
        await mkdir(job.dir, { recursive: true, mode: 0o700 });
        for (let i = 0; i < sources.length; i++) {
          signal.throwIfAborted();
          const source = sources[i],
            input = deps.input(source);
          const options = cleanExportOptions(parsed.data.items[i].options);
          job.public.currentName = source.name;
          const base =
            source.name
              .replace(/\.[^.]+$/, "")
              .replace(/[^\w. -]+/g, "")
              .replace(/^\.+/, "")
              .trim()
              .slice(0, 80) || "video";
          const filename = `${String(i + 1).padStart(2, "0")}-${base}-clean.mp4`;
          const output = path.join(job.dir, filename);
          const before = await inspectMetadata(input, signal);
          await renderEdit(input, output, options, signal);
          const audit = cleanupAudit(
            before,
            await inspectMetadata(output, signal),
            options.cleanup,
          );
          job.public.results.push({
            sourceId: source.id,
            filename,
            options,
            audit,
            bytes: (await stat(output)).size,
            md5: await md5(output, signal),
          });
          if (
            job.public.results.reduce((sum, result) => sum + result.bytes, 0) >
            2 * MAX_BATCH_BYTES
          )
            throw new Error(
              "Rendered batch exceeds 20 GB. Export fewer or shorter videos together.",
            );
          job.public.completed++;
          announceSoon(owner, "clean");
          await deps.touch(source);
        }
        signal.throwIfAborted();
        job.public.state = "packing";
        delete job.public.currentName;
        announceSoon(owner, "clean");
        const report = {
          version: 1,
          scope:
            "Native tags plus known XMP/C2PA boxes in MP4/MOV/M4V container headers. C2PA signatures, codec payloads, external sidecars and remote credentials are not validated or inspected. Private metadata values are omitted.",
          files: job.public.results,
        };
        await writeFile(
          path.join(job.dir, "cleanup-report.json"),
          JSON.stringify(report, null, 2),
          { mode: 0o600 },
        );
        const entries = [
          ...job.public.results.map((result) => ({
            name: result.filename,
            bytes: result.bytes,
          })),
          {
            name: "cleanup-report.json",
            bytes: (await stat(path.join(job.dir, "cleanup-report.json"))).size,
          },
        ];
        const zip = new ZipFile();
        const zipStream = zip.outputStream as Readable;
        zip.on("error", (error) => zipStream.destroy(error));
        // Own lazy file streams so cancellation closes the current input as well as the ZIP output.
        const readers = new Set<ReturnType<typeof createReadStream>>();
        const stopReaders = () => readers.forEach((r) => r.destroy());
        signal.addEventListener("abort", stopReaders, { once: true });
        const zipped = pipeline(
          zipStream,
          createWriteStream(path.join(job.dir, "videos.zip"), { mode: 0o600 }),
          { signal },
        );
        try {
          for (const { name, bytes } of entries) {
            zip.addReadStreamLazy(
              name,
              {
                compress: false,
                size: bytes,
                mtime: new Date("2000-01-01T00:00:00Z"),
                mode: 0o100600,
              },
              (callback) => {
                if (signal.aborted)
                  return callback(new Error("Batch cancelled."), null!);
                const reader = createReadStream(path.join(job.dir, name));
                reader.once("error", (error) => zipStream.destroy(error));
                readers.add(reader);
                reader.once("close", () => readers.delete(reader));
                callback(null, reader);
              },
            );
          }
          zip.end();
          await zipped;
        } catch (error) {
          zipStream.destroy();
          await zipped.catch(() => undefined);
          throw error;
        } finally {
          signal.removeEventListener("abort", stopReaders);
          stopReaders();
        }
        signal.throwIfAborted();
        await Promise.all(
          [
            ...job.public.results.map((r) => r.filename),
            "cleanup-report.json",
          ].map((name) => rm(path.join(job.dir, name), { force: true })),
        );
        job.public.bytes = (await stat(path.join(job.dir, "videos.zip"))).size;
        job.public.expiresAt = Date.now() + KEEP_MS;
        // Release source locks before the terminal state is visible, so a client that sees "ready" can act on the sources at once.
        release();
        job.public.state = "ready";
      } catch (error) {
        // Remove temporary files and release source locks before publishing "failed" or "cancelled": pollers that see the state must find nothing left behind.
        await rm(job.dir, { recursive: true, force: true }).catch(
          () => undefined,
        );
        release();
        job.public.state = signal.aborted ? "cancelled" : "failed";
        job.public.error = signal.aborted
          ? "Batch cancelled. Originals are unchanged."
          : error instanceof Error
            ? error.message
            : "Batch export failed.";
      } finally {
        clearTimeout(deadline);
        release();
        announceSoon(owner, "clean"); // ready, failed or cancelled
      }
    })();
    return c.json(job.public, 202);
  });
  app.get("/:jobId", (c) => c.json(owned(c).public));
  app.delete("/:jobId", async (c) => {
    await remove(owned(c, true));
    return c.json({ deleted: true });
  });
  app.get("/:jobId/download", async (c) => {
    const job = owned(c);
    if (job.public.state !== "ready")
      return c.json({ error: "This batch is not ready to download." }, 409);
    c.req.raw.signal.throwIfAborted();
    const reader = createReadStream(path.join(job.dir, "videos.zip"));
    job.downloads++;
    const stop = () => reader.destroy();
    c.req.raw.signal.addEventListener("abort", stop, { once: true });
    reader.once("close", () => {
      job.downloads--;
      c.req.raw.signal.removeEventListener("abort", stop);
    });
    return new Response(Readable.toWeb(reader) as ReadableStream, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(job.public.bytes),
        "Content-Disposition": 'attachment; filename="cleaned-videos.zip"',
        "Cache-Control": "private, no-store",
      },
    });
  });
  return app;
}
