import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { env } from "../lib/env";
import { libraryChanged } from "./access";
import { emitEvent } from "../lib/events";
import { blobs, libraryDb, librarySetting, libraryUpload, proxiesInCloud } from "./db";
import { describeSlot, describeVersion } from "./describe";
import { canEmbed, embedRoute, embedVersion, startEmbedCatchUp } from "./embed";
import { fingerprint } from "./fingerprint";
import { claimJob, defer, enqueueJob, extendLease, finishJob, firstClips, parkJob, requeueExpired, takingClips, type JobRow } from "./jobs";
import { isInside, musicFolders } from "../lib/storage";
import { isThisMachine } from "../lib/devices";
import { ModelNotReady } from "../lib/device-transcribe";
import { ComputerOff } from "../lib/computer-transcribe";
import { AiProviderError } from "../ai-complete";
import { MacClaudeError, wakeEditorPolls } from "../lib/mac-claude";
import { limitLine } from "../../contracts/plans";
import { SOUNDS } from "../../contracts/library";
import { makeProxy, needsProxy, wantsProxy } from "./media/proxy";
import { makeSprite } from "./media/sprite";
import { looksLikeSong, probe, type ProbeSummary } from "./media/probe";
import { placeUnplaced } from "./media/probe";
import { makeThumb } from "./media/thumb";
import { makeWave } from "./media/wave";
import { NeedsKey, transcribeVersion, versionRoute } from "./transcribe";
import { sortAfter, sortRoll, sortUnsorted } from "./roll";
import { lookFromSheets, lookVersion, MAC_WAITS, needLookRoute, queueLook } from "./shots";
import { takeMacSheets } from "./mac-look";
import { organizeOnProbe } from "./organize";
import { dropMacFrames, macFrames } from "./on-mac";

/**
 * The library's worker (tasks/media-library-plan.md, section 5): the queue runs in lanes (LANES), several at once where
 * the work is someone else's computer (a transcription service, the person's AI). probe runs first and queues thumb,
 * wave, when the browser cannot play the file proxy, and for a video its strip of frames (sprite, from the proxy when
 * there is one). A version is `ready` once its probe and its derivatives (thumb
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
 * Jobs at once, per lane. Pictures: one, apart from the files, so a card's picture never waits for a proxy that already
 * started (its ffmpeg runs in a line of its own, media/run.ts). Files: one, since ffmpeg has its own server-wide limit. Transcripts: a key's
 * service takes many, and on this computer they never overlap anyway (device-transcribe.ts). AI: the Mac relay runs
 * two library calls at once per computer (background slots, mac-claude.ts) and queues the rest; an API key takes all six.
 * Shot descriptions: one video at a time, apart from the descriptions, so a long video's calls never hold a clip's
 * description back. Its picture read takes the one ffmpeg slot in one go, a twentieth of a proxy's time or less: a
 * 20-minute 720p file in 8 to 48 s (the computer idle to busy; 59 s for 1080p at 60 fps), a real 45-minute one in 41 s
 * (171 s on one thread). Its sheets are runs of under 2 s each (7.8 s a sheet on a heavy 720p file), so other work
 * gets the slot in between.
 * ponytail: fixed sizes; per-key rate limits (429s back off and retry) would say how far an API key can go; a 3-hour
 * original holds the slot about 9 minutes: read it in pieces if that ever holds a proxy up
 */
export const LANES = [
  { name: "pictures", kinds: ["probe", "thumb", "wave"], size: 1 },
  { name: "files", kinds: ["proxy", "sprite", "fingerprint"], size: 1 },
  { name: "transcripts", kinds: ["transcribe"], size: 4 },
  { name: "ai", kinds: ["describe", "embed"], size: 6 },
  { name: "looks", kinds: ["look"], size: 1 },
] as const;

/** A card's own steps: they run before anything else, in any library. */
export const PICTURES: string[] = [...LANES[0].kinds];

/** Extras: a failure leaves the version playable. Only the files it is shown with fail it. */
const EXTRA = new Set(["transcribe", "describe", "look", "fingerprint", "embed", "sprite"]);
/** The steps that ask the person's AI: a usage limit or a Mac that is off holds them, never fails them. */
const ON_AI = ["describe", "look"];

const scratch = () => process.env.LIBRARY_SCRATCH_DIR || path.join(env.dataDir, "library", "scratch");

interface VersionRow {
  id: string;
  library_id: string;
  kind: string;
  title: string;
  source_key: string;
  source_path: string | null;
  probe: string | null;
  mac_path: string | null;
  from_path: string | null;
}

/** Seconds a describe or a look should wait before it tries again, or 0 when its error is a real failure. */
function waitFor(e: unknown): number {
  const under = e instanceof AiProviderError && e.cause ? e.cause : e;
  if (under instanceof MacClaudeError && under.kind === "limit") return 15 * 60;
  if (under instanceof MacClaudeError && under.kind === "unclaimed") return 5 * 60;
  return e instanceof AiProviderError && e.code === "RATE_LIMIT" ? 60 : 0;
}

const MODEL_RETRY_S = 60;
/** What the clip says while its transcript waits for the speech model (shown in its panel). */
export const MODEL_WAITS = "The speech model's download stopped: it tries again in a minute.";

/** How a description held for the plan's limit is known (limitLine's words, contracts/plans.ts). */
export const LIMIT_LIKE = "%limit is reached%";

const isLimit = (e: unknown) => {
  const under = e instanceof AiProviderError && e.cause ? e.cause : e;
  return under instanceof MacClaudeError && under.kind === "limit";
};

/**
 * The plan's limit is reached: every description and shot description queued for the same account waits with it,
 * saying why (the progress bar shows it, estimate.ts), instead of each one asking the closed plan. The first to run
 * after `until` asks again.
 */
export function holdForLimit(db: ReturnType<typeof libraryDb>, actor: string | null, why: string, until: number): void {
  db.prepare("UPDATE jobs SET error = ?, run_after = MAX(run_after, ?) WHERE kind IN ('describe', 'look') AND state = 'queued' AND actor IS ?").run(why, until, actor);
}

const marks = (a: readonly unknown[]) => a.map(() => "?").join(",");

/**
 * The job a lane of `kinds` runs next (the order above). A picture that waits for its retry holds nothing back. A
 * description waits while its clip's transcript is still to come, since it reads what is said.
 * ponytail: sorts every queued job of the lane's kinds per claim; fine to tens of thousands, an index on (state, kind) past that
 */
export function nextJob(db: ReturnType<typeof libraryDb>, now: number, kinds: readonly string[], skip: readonly number[] = []): number | null {
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
      `SELECT id FROM jobs j WHERE state = 'queued' AND run_after <= ? AND kind IN (${marks(kinds)}) AND id NOT IN (${marks(skip)})
         AND (kind IN (${marks(PICTURES)}) OR library_id NOT IN (${marks(held)}))
         AND NOT (kind = 'describe' AND EXISTS (SELECT 1 FROM jobs t WHERE t.version_id = j.version_id AND t.kind = 'transcribe' AND t.state IN ('queued', 'running')))
       ORDER BY kind IN (${marks(PICTURES)}) DESC, version_id IN (${marks(first)}) DESC, CASE kind ${kinds.map((_, i) => `WHEN ? THEN ${i}`).join(" ")} END, id LIMIT 1`,
    )
    .get(now, ...kinds, ...skip, ...PICTURES, ...held, ...PICTURES, ...first, ...kinds) as { id: number } | undefined;
  return row?.id ?? null;
}

/** A description got through: the plan answers again, so the ones held for its limit are work again (estimate.ts progress). */
export function releaseLimit(db: ReturnType<typeof libraryDb>, actor: string | null): void {
  db.prepare("UPDATE jobs SET error = NULL WHERE kind IN ('describe', 'look') AND state = 'queued' AND actor IS ? AND error LIKE ?").run(actor, LIMIT_LIKE);
}

// this computer's transcripts and search entries run one at a time (lib/device-transcribe.ts, lib/device-embed.ts: the
// one line every ffmpeg runs in): the next is claimed when the one before ends, so a clip is "running" (its card and the
// step line say Transcribing, Adding to search) only while it really is
// ponytail: one such job first in its lane holds back a key's job behind it (another account's)
let onDevice = 0;
const onThisComputer = (db: ReturnType<typeof libraryDb>, id: number) => {
  const j = db.prepare("SELECT kind, actor, version_id FROM jobs WHERE id = ?").get(id) as { kind: string; actor: string | null; version_id: string };
  try {
    if (j.kind === "transcribe") return versionRoute(j.actor, j.version_id).provider === "device";
    if (j.kind === "embed") return "device" in embedRoute(j.actor);
  } catch {
    // no route: it parks as needs_key when it runs
  }
  return false;
};

const running = new Set<number>();

/**
 * The library jobs one of the uploader's own computers takes (api/work/library-package.ts sets `test`): this server's
 * loop leaves them alone while one can. Unset (a server without the work road), the server runs every job as before.
 */
export const leaveToComputers: { kinds: readonly string[]; test?: (job: JobRow) => boolean } = { kinds: [] };

/** The queued jobs of `kinds` this server leaves to a computer now. */
function leftToComputers(db: ReturnType<typeof libraryDb>, now: number, kinds: readonly string[]): number[] {
  const test = leaveToComputers.test;
  const on = kinds.filter((k) => leaveToComputers.kinds.includes(k));
  if (!test || !on.length) return [];
  // ponytail: each waiting job placed again per tick; fine to hundreds queued, cache per tick past that
  return (db.prepare(`SELECT * FROM jobs WHERE state = 'queued' AND run_after <= ? AND kind IN (${marks(on)}) ORDER BY id LIMIT 500`).all(now, ...on) as unknown as JobRow[])
    .filter(test)
    .map((j) => j.id);
}

/** The app is stopping (an update, Quit): the jobs this server runs go back in the queue at once, the try not counted. */
export function releaseRunningJobs(now = Date.now()): void {
  for (const id of running) defer(libraryDb(), id, 0, now);
}

/** Runs one queued job (of `kinds`, when given), if there is one. Returns false when there is none. */
export async function tick(now = Date.now(), kinds: readonly string[] = LANES.flatMap((l) => l.kinds)): Promise<boolean> {
  const db = libraryDb();
  requeueExpired(db, now);
  const id = nextJob(db, now, kinds, leftToComputers(db, now, kinds));
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
  running.add(job.id);
  // a slow step starts: the open pages say which clip it is on (a picture is over before they would ask)
  if (!PICTURES.includes(job.kind)) libraryChanged(job.library_id);
  // a job waiting its turn (the Mac's AI, this computer's transcriber) keeps its lease, so no second copy starts
  const beat = setInterval(() => extendLease(db, job.id, LEASE_S), 60_000);
  beat.unref();
  try {
    await run(job);
    finishJob(db, job.id, true, undefined, Math.max(now, Date.now())); // its end, so done_at - started_at is how long it took
    if (ON_AI.includes(job.kind)) releaseLimit(db, job.actor);
  } catch (e) {
    if (e instanceof NeedsKey) {
      parkJob(db, job.id, e.message);
      return true;
    }
    // a description that met the plan's usage limit, a rate limit or a Mac that is off waits for it, never fails: a
    // big drop would otherwise end in hundreds of failed cards
    // a transcript whose speech model did not download (a weak connection) waits a minute and tries again, saying why:
    // the clip did not fail, and what came in whole is kept (lib/device-transcribe.ts)
    // one made on the person's computer waits for one with its model to be on, saying so
    const wait = ON_AI.includes(job.kind) ? waitFor(e) : e instanceof ModelNotReady || e instanceof ComputerOff ? MODEL_RETRY_S : 0;
    if (wait) {
      defer(db, job.id, wait);
      if (isLimit(e)) holdForLimit(db, job.actor, limitLine((e as Error).message), Date.now() + wait * 1000);
      if (e instanceof ModelNotReady || e instanceof ComputerOff) db.prepare("UPDATE jobs SET error = ? WHERE id = ?").run(e instanceof ComputerOff ? e.message : MODEL_WAITS, job.id);
      return true;
    }
    finishJob(db, job.id, false, e instanceof Error ? e.message : String(e), Math.max(now, Date.now()));
    const after = db.prepare("SELECT state FROM jobs WHERE id = ?").get(job.id) as { state: string };
    if (after.state === "failed" && !EXTRA.has(job.kind)) db.prepare("UPDATE asset_versions SET state = 'failed' WHERE id = ?").run(job.version_id);
  } finally {
    running.delete(job.id);
    if (device) onDevice--;
    clearInterval(beat);
    release();
    await dropOriginal(job.version_id ?? "").catch((e: unknown) => console.error("[library] dropping an original:", e));
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
  void placeUnplaced(); // clips from before the country was kept, from their location tag
  for (const lane of LANES)
    for (let i = 0; i < lane.size; i++) {
      const loop = async () => {
        let busy = false;
        try {
          busy = await tick(Date.now(), lane.kinds);
          if (!busy && lane.name === "files") busy = await backfillSprite();
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

/**
 * A video from before strips of frames gets one, once, while the files lane has nothing else to do. It runs here, not
 * through the queue: it never counts as preparing (the library's progress, a card's step), never goes before a new
 * clip's work, and the open pages are not told (the strip shows on the next list). A failure is kept as a failed sprite
 * job, so it is not tried again. Music is never checked for duplicates, so a video with that check is not music. A
 * library in a bucket backfills only from its proxies: its originals would each be a download.
 * ponytail: one clip per idle turn of the lane, newest first; a new upload's probe waits for one strip at most
 */
export async function backfillSprite(): Promise<boolean> {
  const db = libraryDb();
  const v = db
    .prepare(
      `SELECT v.id, a.library_id FROM assets a JOIN asset_versions v ON v.id = a.current_version_id JOIN libraries l ON l.id = a.library_id
       WHERE a.kind = 'video' AND a.trashed_at IS NULL AND v.state = 'ready'
         AND (l.storage_kind = 'local' OR EXISTS (SELECT 1 FROM derivatives x WHERE x.version_id = v.id AND x.kind = 'proxy'))
         AND EXISTS (SELECT 1 FROM jobs f WHERE f.version_id = v.id AND f.kind = 'fingerprint')
         AND NOT EXISTS (SELECT 1 FROM derivatives d WHERE d.version_id = v.id AND d.kind = 'sprite')
         AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.version_id = v.id AND j.kind = 'sprite')
       ORDER BY a.created_at DESC, a.id DESC LIMIT 1`,
    )
    .get() as { id: string; library_id: string } | undefined;
  if (!v) return false;
  const job: JobRow = { id: 0, library_id: v.library_id, version_id: v.id, kind: "sprite", state: "running", attempts: 1, run_after: 0, lease_until: null, actor: null, error: null };
  try {
    await run(job);
  } catch (e) {
    db.prepare("INSERT OR IGNORE INTO jobs (library_id, version_id, kind, state, attempts, error) VALUES (?, ?, 'sprite', 'failed', 1, ?)").run(
      v.library_id,
      v.id,
      e instanceof Error ? e.message : String(e),
    );
  }
  return true;
}

/** The steps that read a version's original (the rest read its proxy once there is one, run's lighter). */
const READS_ORIGINAL = ["probe", "thumb", "wave", "proxy", "transcribe"];

/**
 * A video uploaded from a Mac to a library whose upload is "proxies": once its proxy is made and no step that reads the
 * original is queued or running, the original is deleted from the library's store. The version keeps its place on the
 * Mac (mac_path, mac_device: shown as on that Mac, downloads say so) and its source becomes the proxy, so every reader
 * of the source (playback, the AI Editor, Caption Studio, the steps here) reads the proxy from then on. Pictures and
 * sounds have no proxy: they stay as uploaded. True when it dropped one.
 */
export async function dropOriginal(versionId: string): Promise<boolean> {
  const db = libraryDb();
  const v = db
    .prepare(
      `SELECT v.source_key, a.library_id, d.storage_key AS proxy FROM asset_versions v JOIN assets a ON a.id = v.asset_id
         JOIN derivatives d ON d.version_id = v.id AND d.kind = 'proxy' AND d.storage_key IS NOT NULL
       WHERE v.id = ? AND a.kind = 'video' AND v.from_path IS NOT NULL AND v.mac_path IS NULL AND v.source_path IS NULL
         AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.version_id = v.id AND j.kind IN (${marks(READS_ORIGINAL)}) AND j.state IN ('queued', 'running'))`,
    )
    .get(versionId, ...READS_ORIGINAL) as { source_key: string; library_id: string; proxy: string } | undefined;
  if (!v || v.source_key === v.proxy || libraryUpload(v.library_id) !== "proxies") return false;
  // the rows first: a delete that fails leaves an unread file behind, never a version pointing at nothing
  db.prepare("UPDATE asset_versions SET source_key = ?, mac_path = from_path, mac_device = from_device WHERE id = ?").run(v.proxy, versionId);
  await blobs.delete(v.source_key);
  return true;
}

/**
 * What a probed version gets queued (the probe step, and api/library/derived.ts once a computer sent its probe): only
 * what it does not have yet. A picture, a waveform, a proxy, a strip or a fingerprint a computer made and sent with the
 * upload is never made again here.
 */
export async function afterProbe(db: ReturnType<typeof libraryDb>, v: Pick<VersionRow, "id" | "library_id" | "kind" | "title" | "source_path" | "from_path">, p: ProbeSummary, actor: string | null): Promise<void> {
  const have = new Set((db.prepare("SELECT kind FROM derivatives WHERE version_id = ?").all(v.id) as { kind: string }[]).map((h) => h.kind));
  const want = (kind: string) => !have.has(kind) && enqueueJob(db, v.library_id, v.id, kind, actor);
  // a file from the account's music folders, or one added as a song or a sound effect (its tag, routes.ts SOUNDS), is
  // music: a thumbnail and a waveform, no transcript, no description, no search by meaning (each would spend their AI
  // or keys on a song nobody asked about)
  let music =
    (!!v.source_path && isInside(v.source_path, await musicFolders(env.dataDir, actor, isThisMachine))) ||
    !!db.prepare(`SELECT 1 FROM asset_tags t JOIN asset_versions av ON av.asset_id = t.asset_id WHERE av.id = ? AND t.source = 'user' AND t.tag IN (${Object.values(SOUNDS).map((s) => `'${s.tag}'`).join(", ")})`).get(v.id);
  // a song nobody said was one (dropped, downloaded): known by its tags or its name, tagged music by the app
  const song = !music && v.kind !== "image" && looksLikeSong(v.title, p);
  if (song) db.prepare("INSERT OR IGNORE INTO asset_tags (asset_id, tag, source) SELECT asset_id, ?, 'ai' FROM asset_versions WHERE id = ?").run(SOUNDS.music.tag, v.id);
  music ||= song;
  // a song's album art is a picture, not video: its thumbnail, no duplicate check and no description
  const video = !!p.vcodec && !p.cover;
  if (p.vcodec) want("thumb");
  want("wave");
  // a photo is probed as a one-frame video but shows as itself: no proxy
  // a video uploaded to a library that keeps only proxies gets one whatever the proxy switch says: it is all that stays
  const onlyProxy = v.kind === "video" && !!v.from_path && libraryUpload(v.library_id) === "proxies";
  if (v.kind !== "image" && wantsProxy(p, { cloud: proxiesInCloud(v.library_id) || onlyProxy, on: librarySetting(v.library_id, "proxy") })) want("proxy");
  if (p.acodec && !music) enqueueJob(db, v.library_id, v.id, "transcribe", actor);
  // the duplicate check compares videos only (similar.ts): a photo's fingerprint would never be read
  if (video && !music && v.kind !== "image") want("fingerprint");
  // a photo is probed as a one-frame video: only a video asset gets a strip
  if (video && !music && v.kind === "video") want("sprite");
  // after transcribe in the queue, so the description reads what is said
  if (video && !music && librarySetting(v.library_id, "describe")) enqueueJob(db, v.library_id, v.id, "describe", actor);
  // plug-ins that work on what comes in (Face Blur's automatic covers): not for music
  if (!music && actor) emitEvent("library.version.probed", { libraryId: v.library_id, versionId: v.id, owner: actor });
  // a library the AI organizes: a sound or a picture goes to its folder now (a video when it is described)
  organizeOnProbe(db, v.id, p.duration, song);
}

/** Whether the AI described the version before. */
const described = (versionId: string) => !!libraryDb().prepare("SELECT 1 FROM descriptions WHERE version_id = ? AND source = 'ai'").get(versionId);

async function run(job: JobRow): Promise<void> {
  const db = libraryDb();
  const v = db
    .prepare(
      `SELECT v.id, a.library_id, a.kind, a.title, v.source_key, v.source_path, v.probe, v.mac_path, v.from_path FROM asset_versions v
       JOIN assets a ON a.id = v.asset_id WHERE v.id = ?`,
    )
    .get(job.version_id ?? "") as VersionRow | undefined;
  if (!v) throw new Error("The version is gone");
  // a file indexed where it is on a Mac (on-mac.ts): this server never has it, so only the steps that read what the Mac
  // sent run here (the description from its stills, search by meaning from words). One uploaded to a library that keeps
  // only proxies reads its proxy, which is its source once the original is gone (dropOriginal)
  if (v.source_key.startsWith("mac:")) {
    if (job.kind === "embed") return embedVersion(db, v.id, job.actor);
    // its picture is read on that Mac (mac-look.ts): the sheets it sent are looked at here once and dropped; until it
    // sends them the look waits for it, never fails. No AI to ask: it waits for that, and the Mac reads nothing
    if (job.kind === "look") {
      needLookRoute(job.actor);
      const sheets = takeMacSheets(v.id);
      if (sheets) return void (await lookFromSheets(db, v.id, job.actor, sheets));
      void wakeEditorPolls(); // the Mac's long poll hears of it at once
      throw new NeedsKey(MAC_WAITS);
    }
    if (job.kind !== "describe") throw new Error(`The file is on a Mac (${v.mac_path}), not on this server`);
    const p = JSON.parse(v.probe ?? "null") as ProbeSummary | null;
    const frames = await macFrames(v.id);
    if (!frames.length) throw new Error("The stills from the Mac are gone: add the file again from the Mac app");
    const fresh = !described(v.id);
    await describeVersion(db, v.id, "", p?.duration ?? 0, job.actor, scratch(), frames);
    await dropMacFrames(v.id);
    if (fresh && sortRoll(db, v.id)) queueLook(db, v.id, job.actor);
    if (librarySetting(v.library_id, "embed") && canEmbed(job.actor)) enqueueJob(db, v.library_id, v.id, "embed", job.actor, true);
    return;
  }
  // the original, fetched only by a step that reads it (from a bucket it is a download; a step with a lighter copy reads that)
  let original: Promise<string> | undefined;
  const src = () => (original ??= blobs.localCopy(v.source_key));
  const dir = scratch();
  await mkdir(dir, { recursive: true });
  const out = (ext: string) => path.join(dir, `${job.kind}-${randomUUID()}.${ext}`);
  const keep = async (kind: "thumb" | "wave" | "proxy" | "sprite", file: string, key: string) => {
    const { bytes } = await blobs.put(key, file);
    db.prepare("INSERT OR REPLACE INTO derivatives (version_id, kind, storage_key, bytes) VALUES (?, ?, ?, ?)").run(v.id, kind, key, bytes);
  };
  const base = `libraries/${v.library_id}/v/${v.id}`;
  // the version's lighter copy when it has one (a 4K original's 720p proxy), else the original; a proxy in the cloud of
  // a clip that plays as it is would be a download of what is on this disk already, so that reads the original, and its
  // proxy only when the original is not on this server (kept on the user's computer, a drive unplugged)
  let p = JSON.parse(v.probe ?? "null") as ProbeSummary | null;
  const proxyKey = () => (db.prepare("SELECT storage_key FROM derivatives WHERE version_id = ? AND kind = 'proxy'").get(v.id) as { storage_key: string | null } | undefined)?.storage_key;
  const lighter = async () => {
    const k = proxyKey();
    if (p && proxiesInCloud(v.library_id) && !needsProxy(p))
      return src().catch((e: unknown) => {
        if (!k) throw e;
        return blobs.localCopy(k);
      });
    return k ? blobs.localCopy(k) : src();
  };

  if (job.kind === "probe") {
    // a probe again (a rescan) keeps the clip's own turn: the file never says it
    const turn = p?.turn;
    p = { ...(await probe(await src())), ...(turn ? { turn } : {}) };
    db.prepare("UPDATE asset_versions SET probe = ? WHERE id = ?").run(JSON.stringify(p), v.id);
    await afterProbe(db, v, p, job.actor);
  } else if (!p) {
    throw new Error("Not probed yet");
  } else if (job.kind === "thumb") {
    const file = out("jpg");
    await makeThumb(await src(), file, p.duration, !!p.cover, p.turn);
    await keep("thumb", file, `${base}/thumb.jpg`);
  } else if (job.kind === "wave") {
    const file = out("json");
    await makeWave(await src(), file, !!p.acodec);
    await keep("wave", file, `${base}/wave.json`);
  } else if (job.kind === "proxy") {
    const file = out("mp4");
    await makeProxy(await src(), file, !!p.cover || !p.vcodec);
    await keep("proxy", file, `${base}/proxy.mp4`);
  } else if (job.kind === "sprite") {
    // after the proxies in the lane: a 4K original's frames come from its 720p copy
    const file = out("jpg");
    await makeSprite(await lighter(), file, p.duration, p.turn);
    await keep("sprite", file, `${base}/sprite.jpg`);
  } else if (job.kind === "transcribe" || job.kind === "describe") {
    // the lighter copy, as every reader that only measures a clip (editor/media.ts measurable): the proxy keeps every
    // sound track and ffmpeg picks the same one from it as from the original (proxy.ts), at the same times; the original
    // when there is no proxy yet. The frames from it too: the same pictures in 0.3 to 0.5 s where the original took 1 to 5.5 s
    if (job.kind === "transcribe") await transcribeVersion(db, v.id, await lighter(), job.actor, dir);
    else {
      const fresh = !described(v.id);
      await describeVersion(db, v.id, await lighter(), p.duration, job.actor, dir);
      // a clip described for the first time gets its shot descriptions; one described before (Describe again, a whole
      // library sorted into folders) gets them only when an edit or the person asks: never a sweep of a library
      if (fresh && sortRoll(db, v.id)) queueLook(db, v.id, job.actor);
    }
    // new words to search by meaning: embed (again) when the library has semantic search on and the actor a route for it
    if (librarySetting(v.library_id, "embed") && canEmbed(job.actor)) enqueueJob(db, v.library_id, v.id, "embed", job.actor, true);
  } else if (job.kind === "fingerprint") {
    // the lighter copy's frames hash as the original's do (within 6 bits of the 10 a match allows, fingerprint.test.ts)
    // and decode many times faster: 0.3 to 2 s a 4K clip, where its original took 1.4 to 91 s
    const f = JSON.stringify(await fingerprint(await lighter(), p.duration, dir));
    db.prepare("INSERT OR REPLACE INTO derivatives (version_id, kind, inline, bytes) VALUES (?, 'fingerprint', ?, ?)").run(v.id, f, Buffer.byteLength(f));
  } else if (job.kind === "embed") {
    await embedVersion(db, v.id, job.actor);
  } else if (job.kind === "look") {
    // the file the description read (the proxy when there is one), so it shows the AI nothing the description didn't
    await lookVersion(db, v.id, lighter, p, job.actor, dir);
  } else {
    throw new Error(`No worker for ${job.kind}`);
  }

  markReady(db, v.id, p);
}

/** Ready: probed, and the derivatives the probe asked for are there (audio has no thumb). */
export function markReady(db: ReturnType<typeof libraryDb>, versionId: string, p: ProbeSummary): void {
  const want = ["wave", ...(p.vcodec ? ["thumb"] : [])];
  const have = new Set((db.prepare("SELECT kind FROM derivatives WHERE version_id = ?").all(versionId) as { kind: string }[]).map((h) => h.kind));
  if (want.every((k) => have.has(k))) db.prepare("UPDATE asset_versions SET state = 'ready' WHERE id = ?").run(versionId);
}
