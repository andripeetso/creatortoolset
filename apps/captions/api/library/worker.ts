import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { env } from "../lib/env";
import { blobs, libraryDb } from "./db";
import { claimJob, enqueueJob, finishJob, parkJob, requeueExpired, type JobRow } from "./jobs";
import { makeProxy, needsProxy } from "./media/proxy";
import { probe, type ProbeSummary } from "./media/probe";
import { makeThumb } from "./media/thumb";
import { makeWave } from "./media/wave";
import { NeedsKey, transcribeVersion } from "./transcribe";

/**
 * The library's worker (tasks/media-library-plan.md, section 5): one job at a time, in the order the queue gives.
 * probe runs first and queues thumb, wave and, when the browser cannot play the file, proxy. A version is `ready`
 * once its probe and its derivatives (thumb for video, wave) exist. Derivatives are written to scratch, then moved
 * into the blob store.
 */

// ponytail: one job at a time for the whole server; the plan's per-kind limits come when a second job matters
const IDLE_MS = 2000;

const scratch = () => process.env.LIBRARY_SCRATCH_DIR || path.join(env.dataDir, "library", "scratch");

interface VersionRow {
  id: string;
  library_id: string;
  source_key: string;
  probe: string | null;
}

/** Runs one queued job, if there is one. Returns false when the queue is empty. */
export async function tick(now = Date.now()): Promise<boolean> {
  const db = libraryDb();
  requeueExpired(db, now);
  const job = claimJob(db, 300, now);
  if (!job) return false;
  try {
    await run(job);
    finishJob(db, job.id, true, undefined, now);
  } catch (e) {
    if (e instanceof NeedsKey) {
      parkJob(db, job.id, e.message);
      return true;
    }
    finishJob(db, job.id, false, e instanceof Error ? e.message : String(e), now);
    const after = db.prepare("SELECT state FROM jobs WHERE id = ?").get(job.id) as { state: string };
    // a failed transcript leaves the version playable; only the files it is shown with fail it
    if (after.state === "failed" && job.kind !== "transcribe") db.prepare("UPDATE asset_versions SET state = 'failed' WHERE id = ?").run(job.version_id);
  }
  return true;
}

/** Starts the loop; the returned function stops it after the current job. */
export function startLibraryWorker(): () => void {
  let stopped = false;
  const loop = async () => {
    let busy = false;
    try {
      busy = await tick();
    } catch (e) {
      console.error("[library] worker:", e);
    }
    if (!stopped) setTimeout(loop, busy ? 0 : IDLE_MS).unref();
  };
  void loop();
  return () => {
    stopped = true;
  };
}

async function run(job: JobRow): Promise<void> {
  const db = libraryDb();
  const v = db
    .prepare(
      `SELECT v.id, a.library_id, v.source_key, v.probe FROM asset_versions v
       JOIN assets a ON a.id = v.asset_id WHERE v.id = ?`,
    )
    .get(job.version_id ?? "") as VersionRow | undefined;
  if (!v) throw new Error("The version is gone");
  const src = await blobs.localCopy(v.source_key);
  const dir = scratch();
  await mkdir(dir, { recursive: true });
  const out = (ext: string) => path.join(dir, `${job.kind}-${randomUUID()}.${ext}`);
  const keep = async (kind: "thumb" | "wave" | "proxy", file: string, key: string) => {
    const { bytes } = await blobs.put(key, file);
    db.prepare("INSERT OR REPLACE INTO derivatives (version_id, kind, storage_key, bytes) VALUES (?, ?, ?, ?)").run(v.id, kind, key, bytes);
  };
  const base = `libraries/${v.library_id}/v/${v.id}`;
  let p = JSON.parse(v.probe ?? "null") as ProbeSummary | null;

  if (job.kind === "probe") {
    p = await probe(src);
    db.prepare("UPDATE asset_versions SET probe = ? WHERE id = ?").run(JSON.stringify(p), v.id);
    if (p.vcodec) enqueueJob(db, v.library_id, v.id, "thumb", job.actor);
    enqueueJob(db, v.library_id, v.id, "wave", job.actor);
    if (needsProxy(p)) enqueueJob(db, v.library_id, v.id, "proxy", job.actor);
    if (p.acodec) enqueueJob(db, v.library_id, v.id, "transcribe", job.actor);
  } else if (!p) {
    throw new Error("Not probed yet");
  } else if (job.kind === "thumb") {
    const file = out("jpg");
    await makeThumb(src, file, p.duration);
    await keep("thumb", file, `${base}/thumb.jpg`);
  } else if (job.kind === "wave") {
    const file = out("json");
    await makeWave(src, file, !!p.acodec);
    await keep("wave", file, `${base}/wave.json`);
  } else if (job.kind === "proxy") {
    const file = out("mp4");
    await makeProxy(src, file);
    await keep("proxy", file, `${base}/proxy.mp4`);
  } else if (job.kind === "transcribe") {
    await transcribeVersion(db, v.id, src, p.duration, job.actor, dir);
  } else {
    throw new Error(`No worker for ${job.kind}`);
  }

  // ready: probed, and the derivatives the probe asked for are there (audio has no thumb)
  const want = ["wave", ...(p.vcodec ? ["thumb"] : [])];
  const have = new Set((db.prepare("SELECT kind FROM derivatives WHERE version_id = ?").all(v.id) as { kind: string }[]).map((h) => h.kind));
  if (want.every((k) => have.has(k))) db.prepare("UPDATE asset_versions SET state = 'ready' WHERE id = ?").run(v.id);
}
