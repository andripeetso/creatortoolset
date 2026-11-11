import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { env } from "../lib/env";
import { libraryChanged } from "./access";
import { blobs, libraryDb, librarySetting } from "./db";
import { describeSlot, describeVersion } from "./describe";
import { canEmbed, embedRoute, embedVersion, startEmbedCatchUp } from "./embed";
import { fingerprint } from "./fingerprint";
import { claimJob, defer, enqueueJob, extendLease, finishJob, firstClips, parkJob, requeueExpired, takingClips, type JobRow } from "./jobs";
import { isInside, musicFolders } from "../lib/storage";
import { isThisMachine } from "../lib/devices";
import { AiProviderError } from "../ai-complete";
import { MacClaudeError } from "../lib/mac-claude";
import { limitLine } from "../../contracts/plans";
import { makeProxy, needsProxy } from "./media/proxy";
import { probe, type ProbeSummary } from "./media/probe";
import { makeThumb } from "./media/thumb";
import { makeWave } from "./media/wave";
import { NeedsKey, transcribeRoute, transcribeVersion } from "./transcribe";
import { sortAfter, sortUnsorted } from "./roll";

/**
 * The library's worker (tasks/media-library-plan.md, section 5): the queue runs in lanes (LANES), several at once where
 * the work is someone else's computer (a transcription service, the person's AI). probe runs first and queues thumb,
 * wave and, when the browser cannot play the file, proxy. A version is `ready` once its probe and its derivatives (thumb
 * for video, wave) exist. Derivatives are written to scratch, then moved into the blob store.
 *
 * The order is what a person sees (nextJob): every clip in, a picture for each, then the slow steps. A lane takes its
 * kinds in the order LANES lists them (all lighter copies before the duplicate checks), oldest first within a kind; a
 * library's slow steps wait while one of its pictures can run or its watch folders are handing clips over; a clip the
 * person opened (prepareFirst) goes before the others, its picture among the pictures and its slow steps after them.
 */

const IDLE_MS = 2000;
const LEASE_S = 300;

/**
 * Jobs at once, per lane. Files: one, since ffmpeg has its own server-wide limit (media/run.ts). Transcripts: a key's
 * service takes many, and on this computer they never overlap anyway (device-transcribe.ts). AI: the Mac relay runs
 * two library calls at once per computer (background slots, mac-claude.ts) and queues the rest; an API key takes all six.
 * ponytail: fixed sizes; per-key rate limits (429s back off and retry) would say how far an API key can go
 */
export const LANES = [
  { name: "files", kinds: ["probe", "thumb", "wave", "proxy", "fingerprint"], size: 1 },
  { name: "transcripts", kinds: ["transcribe"], size: 4 },
  { name: "ai", kinds: ["describe", "embed"], size: 6 },
] as const;

/** A card's own steps: they run before anything else, in any library. */
export const PICTURES = ["probe", "thumb", "wave"];

/** Extras: a failure leaves the version playable. Only the files it is shown with fail it. */
const EXTRA = new Set(["transcribe", "describe", "fingerprint", "embed"]);

const scratch = () => process.env.LIBRARY_SCRATCH_DIR || path.join(env.dataDir, "library", "scratch");

interface VersionRow {
  id: string;
  library_id: string;
  source_key: string;
  source_path: string | null;
  probe: string | null;
}

/** Seconds a describe should wait before it tries again, or 0 when its error is a real failure. */
function waitFor(e: unknown): number {
  const under = e instanceof AiProviderError && e.cause ? e.cause : e;
  if (under instanceof MacClaudeError && under.kind === "limit") return 15 * 60;
  if (under instanceof MacClaudeError && under.kind === "unclaimed") return 5 * 60;
  return e instanceof AiProviderError && e.code === "RATE_LIMIT" ? 60 : 0;
}

/** How a description held for the plan's limit is known (limitLine's words, contracts/plans.ts). */
export const LIMIT_LIKE = "%limit is reached%";

const isLimit = (e: unknown) => {
  const under = e instanceof AiProviderError && e.cause ? e.cause : e;
  return under instanceof MacClaudeError && under.kind === "limit";
};

/**
 * The plan's limit is reached: every description queued for the same account waits with it, saying why (the progress
 * bar shows it, estimate.ts), instead of each one asking the closed plan. The first to run after `until` asks again.
 */
export function holdForLimit(db: ReturnType<typeof libraryDb>, actor: string | null, why: string, until: number): void {
  db.prepare("UPDATE jobs SET error = ?, run_after = MAX(run_after, ?) WHERE kind = 'describe' AND state = 'queued' AND actor IS ?").run(why, until, actor);
}

const marks = (a: readonly unknown[]) => a.map(() => "?").join(",");

/**
 * The job a lane of `kinds` runs next (the order above). A picture that waits for its retry holds nothing back. A
 * description waits while its clip's transcript is still to come, since it reads what is said.
 * ponytail: sorts every queued job of the lane's kinds per claim; fine to tens of thousands, an index on (state, kind) past that
 */
export function nextJob(db: ReturnType<typeof libraryDb>, now: number, kinds: readonly string[]): number | null {
  const held = [
    ...takingClips,
    ...(db
      .prepare(`SELECT DISTINCT library_id FROM jobs WHERE kind IN (${marks(PICTURES)}) AND (state = 'running' OR (state = 'queued' AND run_after <= ?))`)
      .all(...PICTURES, now) as { library_id: string }[]).map((r) => r.library_id),
  ];
  const first = firstClips();
  // an opened clip's own picture goes before the other pictures, and its slow steps (a 4K proxy takes as long as many
  // pictures) before the other slow steps: never before another clip's picture
  const row = db
    .prepare(
      `SELECT id FROM jobs j WHERE state = 'queued' AND run_after <= ? AND kind IN (${marks(kinds)})
         AND (kind IN (${marks(PICTURES)}) OR library_id NOT IN (${marks(held)}))
         AND NOT (kind = 'describe' AND EXISTS (SELECT 1 FROM jobs t WHERE t.version_id = j.version_id AND t.kind = 'transcribe' AND t.state IN ('queued', 'running')))
       ORDER BY kind IN (${marks(PICTURES)}) DESC, version_id IN (${marks(first)}) DESC, CASE kind ${kinds.map((_, i) => `WHEN ? THEN ${i}`).join(" ")} END, id LIMIT 1`,
    )
    .get(now, ...kinds, ...PICTURES, ...held, ...PICTURES, ...first, ...kinds) as { id: number } | undefined;
  return row?.id ?? null;
}

/** A description got through: the plan answers again, so the ones held for its limit are work again (estimate.ts progress). */
export function releaseLimit(db: ReturnType<typeof libraryDb>, actor: string | null): void {
  db.prepare("UPDATE jobs SET error = NULL WHERE kind = 'describe' AND state = 'queued' AND actor IS ? AND error LIKE ?").run(actor, LIMIT_LIKE);
}

// this computer's transcripts and search entries run one at a time (lib/device-transcribe.ts, lib/device-embed.ts: the
// one line every ffmpeg runs in): the next is claimed when the one before ends, so a clip is "running" (its card and the
// step line say Transcribing, Adding to search) only while it really is
// ponytail: one such job first in its lane holds back a key's job behind it (another account's)
let onDevice = 0;
const onThisComputer = (db: ReturnType<typeof libraryDb>, id: number) => {
  const j = db.prepare("SELECT kind, actor FROM jobs WHERE id = ?").get(id) as { kind: string; actor: string | null };
  try {
    if (j.kind === "transcribe") return transcribeRoute(j.actor).provider === "device";
    if (j.kind === "embed") return "device" in embedRoute(j.actor);
  } catch {
    // no route: it parks as needs_key when it runs
  }
  return false;
};

/** Runs one queued job (of `kinds`, when given), if there is one. Returns false when there is none. */
export async function tick(now = Date.now(), kinds: readonly string[] = LANES.flatMap((l) => l.kinds)): Promise<boolean> {
  const db = libraryDb();
  requeueExpired(db, now);
  const id = nextJob(db, now, kinds);
  const device = id !== null && onThisComputer(db, id);
  if (device && onDevice > 0) return false;
  const job = id === null ? null : claimJob(db, LEASE_S, now, "jobs", kinds, id);
  if (!job) return false;
  if (device) onDevice++;
  // on a connected AI, two descriptions at a time: the others wait in the queue (describe.ts describeSlot)
  const release = job.kind === "describe" ? describeSlot(job.actor) : () => {};
  if (!release) {
    defer(db, job.id, 10, now);
    return false;
  }
  // a slow step starts: the open pages say which clip it is on (a picture is over before they would ask)
  if (!PICTURES.includes(job.kind)) libraryChanged(job.library_id);
  // a job waiting its turn (the Mac's AI, this computer's transcriber) keeps its lease, so no second copy starts
  const beat = setInterval(() => extendLease(db, job.id, LEASE_S), 60_000);
  beat.unref();
  try {
    await run(job);
    finishJob(db, job.id, true, undefined, Math.max(now, Date.now())); // its end, so done_at - started_at is how long it took
    if (job.kind === "describe") releaseLimit(db, job.actor);
  } catch (e) {
    if (e instanceof NeedsKey) {
      parkJob(db, job.id, e.message);
      return true;
    }
    // a description that met the plan's usage limit, a rate limit or a Mac that is off waits for it, never fails: a
    // big drop would otherwise end in hundreds of failed cards
    const wait = job.kind === "describe" ? waitFor(e) : 0;
    if (wait) {
      defer(db, job.id, wait);
      if (isLimit(e)) holdForLimit(db, job.actor, limitLine((e as Error).message), Date.now() + wait * 1000);
      return true;
    }
    finishJob(db, job.id, false, e instanceof Error ? e.message : String(e), Math.max(now, Date.now()));
    const after = db.prepare("SELECT state FROM jobs WHERE id = ?").get(job.id) as { state: string };
    if (after.state === "failed" && !EXTRA.has(job.kind)) db.prepare("UPDATE asset_versions SET state = 'failed' WHERE id = ?").run(job.version_id);
  } finally {
    if (device) onDevice--;
    clearInterval(beat);
    release();
    sortAfter(job); // A-roll or B-roll, again with what this job added (roll.ts)
    libraryChanged(job.library_id); // a picture, a transcript or the card's state: the open pages refetch
  }
  return true;
}

/** Starts every lane's loops; the returned function stops them after their current jobs. */
export function startLibraryWorker(): () => void {
  let stopped = false;
  const stopCatchUp = startEmbedCatchUp();
  void sortUnsorted(); // clips from before A-roll and B-roll, from what they already have
  for (const lane of LANES)
    for (let i = 0; i < lane.size; i++) {
      const loop = async () => {
        let busy = false;
        try {
          busy = await tick(Date.now(), lane.kinds);
        } catch (e) {
          console.error("[library] worker:", e);
        }
        if (!stopped) setTimeout(loop, busy ? 0 : IDLE_MS).unref();
      };
      void loop();
    }
  return () => {
    stopped = true;
    stopCatchUp();
  };
}

async function run(job: JobRow): Promise<void> {
  const db = libraryDb();
  const v = db
    .prepare(
      `SELECT v.id, a.library_id, v.source_key, v.source_path, v.probe FROM asset_versions v
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
  // the version's lighter copy when it has one (a 4K original's 720p proxy), else the original
  const lighter = async () => {
    const k = (db.prepare("SELECT storage_key FROM derivatives WHERE version_id = ? AND kind = 'proxy'").get(v.id) as { storage_key: string | null } | undefined)?.storage_key;
    return k ? blobs.localCopy(k) : src;
  };
  let p = JSON.parse(v.probe ?? "null") as ProbeSummary | null;

  if (job.kind === "probe") {
    p = await probe(src);
    db.prepare("UPDATE asset_versions SET probe = ? WHERE id = ?").run(JSON.stringify(p), v.id);
    // a file from the account's music folders is music: a thumbnail and a waveform, no transcript, no description,
    // no search by meaning (each would spend their AI or keys on a song nobody asked about)
    const music = !!v.source_path && isInside(v.source_path, await musicFolders(env.dataDir, job.actor, isThisMachine));
    // a song's album art is a picture, not video: its thumbnail, no duplicate check and no description
    const video = !!p.vcodec && !p.cover;
    if (p.vcodec) enqueueJob(db, v.library_id, v.id, "thumb", job.actor);
    enqueueJob(db, v.library_id, v.id, "wave", job.actor);
    if (needsProxy(p) && librarySetting(v.library_id, "proxy")) enqueueJob(db, v.library_id, v.id, "proxy", job.actor);
    if (p.acodec && !music) enqueueJob(db, v.library_id, v.id, "transcribe", job.actor);
    if (video && !music) enqueueJob(db, v.library_id, v.id, "fingerprint", job.actor);
    // after transcribe in the queue, so the description reads what is said
    if (video && !music && librarySetting(v.library_id, "describe")) enqueueJob(db, v.library_id, v.id, "describe", job.actor);
  } else if (!p) {
    throw new Error("Not probed yet");
  } else if (job.kind === "thumb") {
    const file = out("jpg");
    await makeThumb(src, file, p.duration, !!p.cover);
    await keep("thumb", file, `${base}/thumb.jpg`);
  } else if (job.kind === "wave") {
    const file = out("json");
    await makeWave(src, file, !!p.acodec);
    await keep("wave", file, `${base}/wave.json`);
  } else if (job.kind === "proxy") {
    const file = out("mp4");
    await makeProxy(src, file, !!p.cover || !p.vcodec);
    await keep("proxy", file, `${base}/proxy.mp4`);
  } else if (job.kind === "transcribe" || job.kind === "describe") {
    // the sound from the original (cut from a 4K clip in 0.2 s at most, and the lighter copy's is re-encoded); the
    // frames from the lighter copy, the same pictures in 0.3 to 0.5 s where the original took 1 to 5.5 s
    if (job.kind === "transcribe") await transcribeVersion(db, v.id, src, job.actor, dir);
    else await describeVersion(db, v.id, await lighter(), p.duration, job.actor, dir);
    // new words to search by meaning: embed (again) when the library has semantic search on and the actor a route for it
    if (librarySetting(v.library_id, "embed") && canEmbed(job.actor)) enqueueJob(db, v.library_id, v.id, "embed", job.actor, true);
  } else if (job.kind === "fingerprint") {
    // the lighter copy's frames hash as the original's do (within 6 bits of the 10 a match allows, fingerprint.test.ts)
    // and decode many times faster: 0.3 to 2 s a 4K clip, where its original took 1.4 to 91 s
    const f = JSON.stringify(await fingerprint(await lighter(), p.duration, dir));
    db.prepare("INSERT OR REPLACE INTO derivatives (version_id, kind, inline, bytes) VALUES (?, 'fingerprint', ?, ?)").run(v.id, f, Buffer.byteLength(f));
  } else if (job.kind === "embed") {
    await embedVersion(db, v.id, job.actor);
  } else {
    throw new Error(`No worker for ${job.kind}`);
  }

  // ready: probed, and the derivatives the probe asked for are there (audio has no thumb)
  const want = ["wave", ...(p.vcodec ? ["thumb"] : [])];
  const have = new Set((db.prepare("SELECT kind FROM derivatives WHERE version_id = ?").all(v.id) as { kind: string }[]).map((h) => h.kind));
  if (want.every((k) => have.has(k))) db.prepare("UPDATE asset_versions SET state = 'ready' WHERE id = ?").run(v.id);
}
