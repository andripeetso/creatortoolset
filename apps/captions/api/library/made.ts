import { hostsProxies, MADE_KINDS, SOUNDS, WATCH_MODELS, type LibraryMade, type LibraryUnreadable, type MadeKind } from "../../contracts/library";
import { DRIVERS } from "../../contracts/providers";
import { aiFor, anthropicParams, onApiKey } from "../ai-complete";
import { PICTURE_MODEL } from "../lib/device-picture";
import { deviceOf, isOnline, listDevices } from "../lib/devices";
import { pluginDeviceJobs } from "../lib/plugin";
import { libraryWorkspace, serverWorks } from "../work/server-work";
import { libraryRole } from "./access";
import { jobVersions } from "./blur-mirror";
import { BLUR_SQL, keepsOnlyOriginals, libraryDb, librarySetting, libraryUploadStored } from "./db";
import { FINISHED } from "./query";
import { DESCRIBE_LABEL, whoFor } from "./describe";
import { makeCost, makeMinutes } from "./estimate";
import { embedRoute, modelFor } from "./embed";
import { enqueueJob } from "./jobs";
import { wantsProxy } from "./media/proxy";
import type { ProbeSummary } from "./media/probe";
import { wakePictures } from "./pictures";
import { FIRST_LOOK, hasLines, LOOK_LABEL, LOOK_MIN_S, MAC_WAITS, queueLook, RELOOK_WAITS } from "./shots";
import { libraryWatchModel, ON_GEMINI, REFUSED } from "./timeline";
import { transcribeRoute } from "./transcribe";
import { mayLeave } from "./upload-gate";
import { leaveToComputers } from "./worker";

/**
 * What a library has made for its files, kind by kind (Settings → Media Library and the library's Status view), and
 * "Make for the missing": the one way the files already in a library get a kind they lack. Nothing here runs unasked;
 * the switches make for new files only (db.ts SINCE), and a file that has a kind is never queued for it (jobs.ts HAVE).
 */

const MUSIC = `EXISTS (SELECT 1 FROM asset_tags t WHERE t.asset_id = a.id AND t.tag IN (${Object.values(SOUNDS)
  .map((x) => `'${x.tag}'`)
  .join(", ")}))`;
const has = (table: string, more = "") => `EXISTS (SELECT 1 FROM ${table} x WHERE x.version_id = v.id${more})`;
const derived = (kind: string, more = "") => has("derivatives", ` AND x.kind = '${kind}'${more}`);
/** A video that gets shot descriptions (shots.ts lookable). */
const LOOKABLE = `a.kind = 'video' AND (a.roll = 'b' OR (a.roll = 'a' AND IFNULL(json_extract(l.settings, '$.lookTalking'), 0)))
  AND IFNULL(json_extract(v.probe, '$.duration'), 0) > ${LOOK_MIN_S}`;
const LINES = has("stretches", " AND x.text != ''");
/** Only a file this server holds: a file kept on a Mac has its pictures, waveform and fingerprint sent by that Mac. */
const HERE = "v.source_key NOT LIKE 'mac:%'";

/** SQL: `job` is queued or running for the version `v`. */
function open(job?: string): string {
  return job ? `EXISTS (SELECT 1 FROM jobs j WHERE j.version_id IN ${jobVersions(job)} AND j.kind = '${job}' AND j.state IN ('queued', 'running'))` : "0";
}
/** SQL: the version's `job` failed (Retry queues it again, routes.ts). */
const failedJob = (job?: string) => (job ? `EXISTS (SELECT 1 FROM jobs j WHERE j.version_id IN ${jobVersions(job)} AND j.kind = '${job}' AND j.state = 'failed')` : "0");
/** SQL: the version's `job` was stopped (Retry queues it again): neither failed nor missing. */
const stoppedJob = (job?: string) => (job ? `EXISTS (SELECT 1 FROM jobs j WHERE j.version_id IN ${jobVersions(job)} AND j.kind = '${job}' AND j.state = 'stopped')` : "0");
/** A file in the library when Make for the missing was pressed for `kind` (search by picture, timelines: their catch-ups make them). */
// a timeline's press is judged by the version watched, a blurred copy's original (timeline.ts PRESSED): a clip blurred after the press is covered
const pressed = (kind: "pictures" | "timeline") =>
  `${kind === "timeline" ? `(SELECT MIN(w.created_at) FROM asset_versions w WHERE w.id IN ${jobVersions("look")})` : "v.created_at"} <= IFNULL(json_extract(l.settings, '$.${kind}Asked'), -1)`;
/** SQL: version `v` has a timeline row (`more` narrows it), its own or, a blurred copy, its original's: the watch runs there and lands there first (blur-mirror.ts). */
const watched = (more: string) => `EXISTS (SELECT 1 FROM timelines x WHERE x.version_id IN ${jobVersions("look")}${more})`;

/**
 * Per kind: the job that makes it (none: a catch-up does), the files that can have it, what having it is, which of the
 * missing this server can queue, and what counts as on its way (default: its job queued or running).
 */
const SPEC: Record<MadeKind, { job?: string; of: string; have: string; can?: string; open?: string }> = {
  thumb: { job: "thumb", of: "a.kind IN ('video', 'image')", have: derived("thumb"), can: HERE },
  sprite: { job: "sprite", of: `a.kind = 'video' AND NOT ${MUSIC}`, have: derived("sprite"), can: HERE },
  wave: { job: "wave", of: "a.kind IN ('video', 'audio')", have: derived("wave"), can: HERE },
  fingerprint: { job: "fingerprint", of: `a.kind = 'video' AND NOT ${MUSIC}`, have: derived("fingerprint"), can: HERE },
  // Face Blur's copies (no job here: a Mac makes each, editor-steps/blur-faces). Has it: a blurred copy, or a no that was
  // decided (kept as filmed, its folder's rule, or gone over with no face found). On its way: marked yes, its copy not
  // in yet. Missing: nobody answered for it. Either Blur faces is off (the switch then asks about these), or it was left
  // as it was when Blur faces went on (blur_note skipped), which Make marks yes (routes.ts POST …/made/blur)
  blur: {
    of: "a.kind IN ('video', 'image')",
    have: `(v.blurred_of IS NOT NULL OR EXISTS (SELECT 1 FROM asset_versions b WHERE b.asset_id = a.id AND b.blurred_of IN (v.sha256, v.full_sha256))
      OR (${BLUR_SQL} = 'no' AND IFNULL(a.blur_note, '') != 'skipped' AND NOT (a.blur IS NULL AND json_extract(l.settings, '$.blurFaces') IS NOT 1
        AND NOT EXISTS (SELECT 1 FROM collection_items fi JOIN collections fc ON fc.id = fi.collection_id WHERE fi.asset_id = a.id AND fc.blur = 'no'))))`,
    open: `${BLUR_SQL} = 'yes'`,
  },
  proxy: { job: "proxy", of: "a.kind = 'video'", have: derived("proxy") },
  // a video indexed on a Mac: its probe has no sound codec (on-mac.ts), and it gets a transcript all the same
  transcribe: {
    job: "transcribe",
    of: `(a.kind = 'video' OR a.kind = 'audio') AND (json_extract(v.probe, '$.acodec') IS NOT NULL OR (a.kind = 'video' AND v.source_key LIKE 'mac:%')) AND NOT ${MUSIC}
      AND NOT (a.roll = 'b' AND json_extract(l.settings, '$.transcribeBroll') IS 0)`,
    have: has("transcripts"),
  },
  describe: { job: "describe", of: `a.kind IN ('video', 'image') AND NOT ${MUSIC}`, have: has("descriptions") },
  embed: { job: "embed", of: `(${has("transcripts")} OR ${has("descriptions")})`, have: has("embeddings") },
  pictures: {
    of: `a.kind IN ('video', 'image') AND ${derived("thumb", " AND x.storage_key IS NOT NULL")}`,
    have: has("pictures", ` AND x.seg = -1 AND x.model = '${PICTURE_MODEL}'`),
    open: pressed("pictures"),
  },
  // a look that ran and wrote no line counts as made: pressed again it would only spend again
  look: { job: "look", of: LOOKABLE, have: `(${LINES} OR EXISTS (SELECT 1 FROM jobs x WHERE x.version_id IN ${jobVersions("look")} AND x.kind = 'look' AND x.state = 'done'))` },
  // on its way: its look running, or pressed for with no watch since (one that failed after the press is missing again).
  // One whose look failed is failed, not on its way: the sweep takes only a look that is done (timeline.ts sweepWatch)
  // a clip Gemini turned down is settled (timeline.ts REFUSED): skipped, never missing, or Make would only be turned down again
  timeline: {
    job: "look",
    of: `${LOOKABLE} AND ${LINES} AND NOT (${watched(` AND x.error LIKE '${REFUSED}%'`)} AND ${ON_GEMINI})`,
    have: watched(" AND x.error IS NULL"),
    open: `(${open("look")} OR (${pressed("timeline")} AND NOT ${watched(" AND x.at >= json_extract(l.settings, '$.timelineAsked')")} AND NOT ${failedJob("look")}))`,
  },
  // sorted by itself (sound-kind.ts): a tag the person (or Gemini, hearing talk) turned down is never given again, so settled
  sound: {
    of: "a.kind = 'audio'",
    have: `(${MUSIC} OR EXISTS (SELECT 1 FROM tag_rejections r WHERE r.asset_id = a.id AND r.tag IN (${Object.values(SOUNDS)
      .map((x) => `'${x.tag}'`)
      .join(", ")})))`,
  },
  // sorted by itself (roll.ts): raw videos only, finished work has none
  roll: { of: `a.kind = 'video' AND NOT ${FINISHED}`, have: "a.roll IS NOT NULL" },
};

/** The library's files now: current versions read, out of the trash, not hidden. */
const LIVE = `FROM assets a JOIN asset_versions v ON v.id = a.current_version_id JOIN libraries l ON l.id = a.library_id
  WHERE a.library_id = ? AND a.trashed_at IS NULL AND a.left_hidden_at IS NULL AND v.probe IS NOT NULL AND v.state NOT IN ('failed', 'missing')`;

/** `kind`'s spec for `username`: search by meaning counts only vectors of the model their route makes now (a search compares only those). */
function specOf(kind: MadeKind, username: string) {
  const s = SPEC[kind];
  const model = kind === "embed" ? modelFor(username) : null;
  // a timeline's job is its look's. A look that failed on a clip with its lines (it ran again for the timeline) shows
  // nowhere else, Shot descriptions reads made: failed here, and Retry queues the look (routes.ts). Stopped is the look's own
  const failed = failedJob(s.job);
  const stopped = kind === "timeline" ? "0" : stoppedJob(s.job);
  return { ...s, have: model ? has("embeddings", ` AND x.model = '${model.replace(/'/g, "''")}'`) : s.have, open: s.open ?? open(s.job), failed, stopped };
}

interface Missing {
  id: string;
  seconds: number;
}

/** The files missing `kind` that this server can queue it for. A proxy only where one is wanted (media/proxy.ts) and may be kept. */
function missingOf(libraryId: string, kind: MadeKind, username: string): Missing[] {
  const s = specOf(kind, username);
  const rows = libraryDb()
    .prepare(
      `SELECT v.id, v.probe, v.source_key, IFNULL(json_extract(v.probe, '$.duration'), 0) AS seconds ${LIVE} AND ${s.of} AND NOT ${s.have} AND NOT ${s.open} AND NOT ${s.failed} AND NOT ${s.stopped}${s.can ? ` AND ${s.can}` : ""}`,
    )
    .all(libraryId) as { id: string; probe: string; source_key: string; seconds: number }[];
  if (kind !== "proxy") return rows;
  if (keepsOnlyOriginals(libraryId)) return [];
  // where Upload sends proxies every video wants one (the team's copy); else only what plays badly as it is. Never of an
  // original waiting for its blur: its proxy is made from its blurred copy (mayLeave)
  const hosted = hostsProxies(libraryUploadStored(libraryId));
  return rows.filter((r) => wantsProxy(JSON.parse(r.probe) as ProbeSummary, { cloud: hosted, on: true }) && mayLeave(libraryId, { versionId: r.id }).ok);
}

/** Every kind's counts in `libraryId`, with its cost for `username`: one query per kind (two for proxies). */
export async function libraryMade(libraryId: string, username: string): Promise<LibraryMade[]> {
  const db = libraryDb();
  const out: LibraryMade[] = [];
  for (const { kind } of MADE_KINDS) {
    const s = specOf(kind, username);
    const r = db
      .prepare(
        `SELECT IFNULL(SUM(have), 0) AS have, IFNULL(SUM(NOT have AND open), 0) AS queued, IFNULL(SUM(NOT have AND NOT open AND failed), 0) AS failed,
           IFNULL(SUM(NOT have AND NOT open AND NOT failed AND stopped), 0) AS stopped,
           IFNULL(SUM(NOT have AND NOT open AND NOT failed AND NOT stopped AND can), 0) AS missing,
           IFNULL(AVG(CASE WHEN NOT have AND NOT open AND NOT failed AND NOT stopped AND can THEN seconds END), 0) AS seconds
         FROM (SELECT ${s.have} AS have, ${s.open} AS open, ${s.failed} AS failed, ${s.stopped} AS stopped, ${s.can ?? "1"} AS can, IFNULL(json_extract(v.probe, '$.duration'), 0) AS seconds ${LIVE} AND ${s.of})`,
      )
      .get(libraryId) as { have: number; queued: number; failed: number; stopped: number; missing: number; seconds: number };
    const skip = SKIP[kind];
    const skipped = skip ? (db.prepare(`SELECT COUNT(*) AS n ${LIVE} AND ${skip.of} AND NOT (${s.of})`).get(libraryId) as { n: number }).n : 0;
    // a proxy is missing only where one is wanted: the rows read once more, filtered as the worker would
    const missing = kind === "proxy" ? missingOf(libraryId, kind, username) : null;
    const n = missing ? missing.length : r.missing;
    const seconds = missing ? missing.reduce((t, m) => t + m.seconds, 0) / Math.max(1, n) : r.seconds;
    out.push({
      kind,
      have: r.have,
      missing: n,
      queued: r.queued,
      ...(r.failed ? { failed: r.failed } : {}),
      ...(r.stopped ? { stopped: r.stopped } : {}),
      ...(r.queued && s.job ? waitOf(libraryId, kind, username) : {}),
      ...(r.queued && kind === "blur" ? blurWait(libraryId, username) : {}),
      ...(await makeCost(libraryId, username, kind, n, seconds)),
      ...engineOf(libraryId, kind, username),
      ...(n ? { minutes: await makeMinutes(libraryId, username, kind, n, seconds) } : {}),
      ...(skipped ? { skipped: { n: skipped, why: kind === "transcribe" && !librarySetting(libraryId, "transcribeBroll") ? "no sound, music, or B-roll" : skip!.why } } : {}),
      ...((n || r.queued) && (kind === "transcribe" || kind === "describe") ? { broll: brollOf(libraryId, kind, username) } : {}),
    });
  }
  return out;
}

/**
 * Why the files marked Blur faces wait, as the slot that covers them says (lib/plugin.ts preparing): switched off, no AI
 * provider. Where it is changed only for the library's owner: the switch and the provider are theirs, and anyone else
 * would open their own.
 */
function blurWait(libraryId: string, username: string): Pick<LibraryMade, "why" | "href"> {
  const w = pluginDeviceJobs().flatMap((j) => j.preparing?.(libraryId) ?? []).find((p) => p.waiting && p.why);
  return w ? { why: w.why, ...(w.href && libraryRole(username, libraryId) === "owner" ? { href: w.href } : {}) } : {};
}

/** The files of a media kind a kind never makes, and why in a few words (the rest of `of` is in SPEC). */
const SKIP: Partial<Record<MadeKind, { of: string; why: string }>> = {
  transcribe: { of: "a.kind IN ('video', 'audio')", why: "no sound, or music" },
  look: { of: "a.kind = 'video'", why: `shorter than ${LOOK_MIN_S} s, or talking takes` },
  embed: { of: "a.kind IN ('video', 'audio', 'image')", why: "no transcript or description yet" },
  timeline: { of: LOOKABLE, why: "no shot descriptions yet, or refused by Gemini" },
};

/** Of `kind`'s missing and queued files, the B-roll ones (videos nobody talks in: roll.ts). */
function brollOf(libraryId: string, kind: MadeKind, username: string): number {
  const s = specOf(kind, username);
  return (libraryDb().prepare(`SELECT COUNT(*) AS n ${LIVE} AND ${s.of} AND NOT ${s.have} AND NOT ${s.failed} AND a.roll = 'b'`).get(libraryId) as { n: number }).n;
}

/** `username`'s computers online that claimed library work here (library-package.ts takesLibrary; imported, it would load before the worker). */
function computersWhere(username: string): string {
  const names = listDevices((x) => x.owner === username && isOnline(x.id) && !!x.work?.libraryAt).map((x) => x.name);
  return names.length ? names.join(" or ") : "one of your computers, once one is online";
}

/** Where `username`'s video work runs now: this server, else their computers. */
const videoWhere = (libraryId: string, username: string): string => (serverWorks(libraryWorkspace(libraryId), username) ? "this server" : computersWhere(username));

/** What makes `kind` on `username`'s settings now, and where: the same choices the worker makes. Empty when nothing can (makeCost says what it needs). */
export function engineOf(libraryId: string, kind: MadeKind, username: string): Pick<LibraryMade, "engine" | "where"> {
  try {
    switch (kind) {
      case "thumb":
      case "sprite":
      case "wave":
      case "proxy":
        return { engine: "FFmpeg", where: videoWhere(libraryId, username) };
      case "fingerprint":
        return { engine: "FFmpeg picture hashes", where: videoWhere(libraryId, username) };
      case "blur":
        return { engine: "Face Blur", where: "the Mac that has each file" };
      case "transcribe": {
        const r = transcribeRoute(username);
        if (r.provider === "deepgram") return { engine: "Deepgram nova-3", where: "Deepgram" };
        if (r.provider === "openai") return { engine: `OpenAI ${process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1"}`, where: "OpenAI" };
        if (r.provider === "device") return { engine: "the speech model on this server", where: "this server" };
        return "model" in r ? { engine: r.model, where: computersWhere(username) } : { engine: "the speech model on this server", where: "this server" };
      }
      case "describe":
      case "look": {
        const label = kind === "look" ? LOOK_LABEL : DESCRIBE_LABEL;
        const r = onApiKey(username, "library", label) ?? aiFor(whoFor(username), "library", label);
        if (r.off) return {};
        const p = r.mac?.provider;
        if (p) return { engine: [DRIVERS.find((d) => d.id === p.driver)?.label ?? p.driver, p.model].filter(Boolean).join(" "), where: "the AI provider sign-in" };
        if (r.localModel) return { engine: r.localModel.model, where: "your model server" };
        return { engine: anthropicParams(undefined, r.model).model, where: r.bill ? "the team's Anthropic budget" : "your Anthropic key" };
      }
      case "embed": {
        const r = embedRoute(username);
        return "device" in r ? { engine: "the search model on this server", where: "this server" } : { engine: `OpenAI ${r.model}`, where: "OpenAI" };
      }
      case "pictures":
        return { engine: "SigLIP 2 picture model", where: videoWhere(libraryId, username) };
      case "timeline": {
        const m = libraryWatchModel(libraryDb(), libraryId);
        return { engine: WATCH_MODELS.find((x) => x.value === m)?.label ?? m, where: m === "antigravity" ? "your Antigravity sign-in" : "your Gemini key" };
      }
      case "sound":
        return { engine: "the file's name, folders and length", where: "this server" };
      case "roll":
        return { engine: "the transcript's speech and the clip's length", where: "this server" };
    }
  } catch {
    // no route (a key missing): makeCost's `needs` says it
  }
  return {};
}

/**
 * Cancel: `kind`'s jobs still queued in the library end as stopped (one running finishes; Retry queues them); a press of Make for
 * the missing timelines or pictures is taken back. Never a kind a file needs to be ready (it would stay processing).
 * Returns how many files.
 */
export function stopQueued(libraryId: string, kind: MadeKind, username: string, now = Date.now()): number {
  if (MADE_KINDS.find((k) => k.kind === kind)?.ready) return 0;
  const db = libraryDb();
  if (kind === "pictures" || kind === "timeline") {
    const n = (db.prepare(`SELECT COUNT(*) AS n ${LIVE} AND ${SPEC[kind].of} AND NOT ${specOf(kind, username).have} AND ${pressed(kind)}`).get(libraryId) as { n: number }).n;
    db.prepare(`UPDATE libraries SET settings = json_remove(settings, '$.${kind}Asked') WHERE id = ?`).run(libraryId);
    if (kind === "timeline") {
      // what waits now is left to Make for the missing: the sweep and a finished look take only a look that starts after
      // this (timeline.ts SINCE_STOP), or it would queue them all again the moment this stopped them. A clip's first look still brings its timeline
      db.prepare(`UPDATE libraries SET settings = json_set(settings, '$.timelineStopped', ?) WHERE id = ?`).run(now, libraryId);
      // a timeline's job is its look's: one that waits to run again only for the timeline goes back to done, its lines are
      // there (one a Mac is reading finishes, and is asked for no watch). A clip's first look is shot descriptions' own
      db.prepare(`UPDATE jobs SET state = 'done', error = NULL, lease_until = NULL WHERE library_id = ? AND ${RELOOK_WAITS}`).run(libraryId, MAC_WAITS);
    }
    return n;
  }
  const job = SPEC[kind].job;
  if (!job) return 0;
  // kept as stopped, not deleted: a file with no job row is new to the sweeps (shots.ts sweepLook) and queued again.
  // A look that runs again for its timeline is the timelines' to cancel: stopped, the sweep would never take it again
  return Number(
    db.prepare(`UPDATE jobs SET state = 'stopped', error = NULL WHERE library_id = ? AND kind = ? AND state = 'queued'${job === "look" ? ` AND ${FIRST_LOOK}` : ""}`).run(libraryId, job).changes,
  );
}

/**
 * Transcripts for B-roll turned off: the B-roll transcripts still queued end as stopped, as Cancel leaves them (Retry, or
 * Include B-roll then Retry, queues them again). Returns how many files.
 * shortcut: a job row doesn't say whether it was picked by hand, so hand-picked B-roll queued before the switch stops too.
 */
export function stopBroll(libraryId: string): number {
  return Number(
    libraryDb()
      .prepare(
        `UPDATE jobs SET state = 'stopped', error = NULL WHERE library_id = ? AND kind = 'transcribe' AND state = 'queued'
           AND version_id IN (SELECT v.id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE a.library_id = ? AND a.roll = 'b')`,
      )
      .run(libraryId, libraryId).changes,
  );
}

/**
 * Why `kind`'s queued files in the library wait, from the computers' status (work/waits.ts): the first wait the person
 * can change or a computer offline, else the computer making them or taking them next. Only `username`'s own
 * computers are named (another person's never are, as in estimate.ts).
 */
export function waitOf(libraryId: string, kind: MadeKind, username: string): Pick<LibraryMade, "why" | "href" | "by"> {
  const s = specOf(kind, username);
  const jobs = libraryDb()
    .prepare(
      `SELECT j.id, j.state, j.held_by, j.error, j.actor ${LIVE.replace("WHERE", `JOIN jobs j ON j.version_id IN ${jobVersions(s.job!)} AND j.kind = '${s.job}' AND j.state IN ('queued', 'running') WHERE`)} AND ${s.of} AND NOT ${s.have} ORDER BY j.id LIMIT 500`,
    )
    .all(libraryId) as { id: number; state: string; held_by: string | null; error: string | null; actor: string | null }[];
  let snap: ReturnType<NonNullable<typeof leaveToComputers.status>> | undefined;
  try {
    snap = leaveToComputers.status?.(libraryId);
  } catch {
    // no status: the jobs' own lines say it
  }
  const mine = (id: string | null | undefined) => (id ? deviceOf(id) : undefined)?.owner === username;
  const name = (id: string) => deviceOf(id)?.name;
  let by: string | undefined;
  for (const j of jobs) {
    if (j.state === "running") {
      if (!by && j.held_by && mine(j.held_by)) by = name(j.held_by);
      continue;
    }
    const c = snap?.byJob.get(j.id);
    if (c && c.wait !== "queued" && c.reason) return c.actor === username ? { why: c.reason, ...(c.href ? { href: c.href } : {}) } : {};
    if (c?.device && !by && mine(c.device)) by = name(c.device);
    if (!c && j.error && j.actor === username && !by) return { why: j.error };
  }
  return by ? { by } : {};
}

/**
 * Make for the missing: `kind` for every file of the library that lacks it, as `username` (their AI and keys). A job kind
 * is queued per file; search by picture and timelines are made by their catch-ups, which take every file in the library
 * at this moment from now on (`picturesAsked`, `timelineAsked`). Returns how many files.
 */
export function makeMissing(libraryId: string, kind: MadeKind, username: string, now = Date.now()): number {
  if (kind === "blur") return 0; // no job of its own: the route marks the files and asks Face Blur (routes.ts)
  const db = libraryDb();
  const files = missingOf(libraryId, kind, username);
  if (kind === "pictures" || kind === "timeline") {
    db.prepare(`UPDATE libraries SET settings = json_set(settings, '$.${kind}Asked', ?) WHERE id = ?`).run(now, libraryId);
    if (kind === "pictures") wakePictures();
    return files.length;
  }
  // asked for by name: a done job whose output is not there (removed since) runs again too. A look goes through queueLook,
  // which keeps a talking take to Max, whatever the switch says
  for (const f of files) {
    if (kind === "look") queueLook(db, f.id, username, true, true);
    else enqueueJob(db, libraryId, f.id, SPEC[kind].job!, username, true);
  }
  return files.length;
}

// a job's clip (a) and that clip's current version (v), each by its key: one row per job
const CLIP_OF_JOB = "JOIN asset_versions jv ON jv.id = j.version_id JOIN assets a ON a.id = jv.asset_id JOIN asset_versions v ON v.id = a.current_version_id";

/**
 * Retry: the failed and stopped jobs of `kind` in the library queued again as whoever queued them (a failed file that has
 * it is marked done, jobs.ts). One with nobody named (the server's own backfill, worker.ts) goes to whoever added the file:
 * with no name no computer may take it, and it waited for good.
 */
export function retryFailed(libraryId: string, kind: string, again = false): number {
  const db = libraryDb();
  // `again` (Retry on the timelines): only a look of a clip that has its lines, never a clip's first, failed or stopped
  const rows = db
    .prepare(
      `SELECT j.version_id, IFNULL(j.actor, jv.created_by) AS actor FROM jobs j ${CLIP_OF_JOB}
       WHERE j.library_id = ? AND j.kind = ? AND j.state = 'failed' AND j.version_id IN ${jobVersions(kind)} AND a.trashed_at IS NULL AND a.left_hidden_at IS NULL${again ? ` AND ${hasLines("j")}` : ""}`,
    )
    .all(libraryId, kind) as { version_id: string; actor: string | null }[];
  for (const r of rows) enqueueJob(db, libraryId, r.version_id, kind, r.actor);
  // and the stopped ones (stopQueued): queued again as they were, its actor kept
  const stopped = db
    .prepare(
      `UPDATE jobs SET state = 'queued', attempts = 0, run_after = 0, lease_until = NULL, error = NULL
       WHERE library_id = ? AND kind = ? AND state = 'stopped'${again ? ` AND ${hasLines()}` : ""} AND EXISTS (SELECT 1 FROM jobs j ${CLIP_OF_JOB}
         WHERE j.id = jobs.id AND a.trashed_at IS NULL AND a.left_hidden_at IS NULL AND j.version_id IN ${jobVersions(kind)})`,
    )
    .run(libraryId, kind).changes;
  return rows.length + Number(stopped);
}

/**
 * The jobs that failed only because a photo's card picture came out empty (media/thumb.ts seeked into a
 * one-frame file, so the encoder wrote nothing and the rename failed) are queued again; once they land the clip is ready.
 * Asked by a computer that reads photos with no seek (work/routes.ts): an older one would fail them again. Only a try
 * from before the fixed Mac app was out (0.26.0): one that failed after it fails for another reason, and sending it
 * again at every server start put it back on the Preparing bar after each deploy.
 */
export const STILLS_FIXED_AT = Date.parse("2026-11-24T22:00:00Z");
export function retryEmptyPictures(): number {
  const db = libraryDb();
  const rows = db
    .prepare("SELECT library_id, version_id, kind, actor FROM jobs WHERE state = 'failed' AND error LIKE '%ENOENT%.jpg.part.jpg%' AND IFNULL(started_at, 0) < ?")
    .all(STILLS_FIXED_AT) as { library_id: string; version_id: string; kind: string; actor: string | null }[];
  for (const r of rows) enqueueJob(db, r.library_id, r.version_id, r.kind, r.actor);
  return rows.length;
}

/**
 * A card picture or strip that failed in the last week, queued once more when a computer that does library work connects
 * (work/routes.ts, once per computer per server start): one read while its disk was away, or by an older app, gets its
 * picture with no Retry. The week counts from when the file came in, not from its last try (each try restamps started_at),
 * so a file that still fails after a week is left failed and never comes back at every start.
 */
export const PICTURE_RETRY_DAYS = 7;
export function retryFailedPictures(now = Date.now()): number {
  const db = libraryDb();
  const rows = db
    .prepare(
      `SELECT j.library_id, j.version_id, j.kind, IFNULL(j.actor, v.created_by) AS actor FROM jobs j JOIN assets a ON a.current_version_id = j.version_id
       JOIN asset_versions v ON v.id = j.version_id
       WHERE j.kind IN ('thumb', 'sprite') AND j.state = 'failed' AND v.created_at > ?
         AND a.trashed_at IS NULL AND a.left_hidden_at IS NULL`,
    )
    .all(now - PICTURE_RETRY_DAYS * 86_400_000) as { library_id: string; version_id: string; kind: string; actor: string | null }[];
  for (const r of rows) enqueueJob(db, r.library_id, r.version_id, r.kind, r.actor);
  return rows.length;
}

// the files Library status counts as unreadable (estimate.ts libraryStatus): a live clip whose current version failed
const UNREADABLE = `FROM assets a JOIN asset_versions v ON v.id = a.current_version_id
  WHERE a.library_id = ? AND a.trashed_at IS NULL AND v.state = 'failed'`;

/** Library status's Unreadable list: each file with the step that failed last and its error, by title. */
export function unreadableOf(libraryId: string, limit = 500): LibraryUnreadable[] {
  return libraryDb()
    .prepare(
      `SELECT a.id, a.title, IFNULL(j.kind, 'probe') AS step, IFNULL(j.error, '') AS error ${UNREADABLE.replace("WHERE", `LEFT JOIN jobs j ON j.id = (SELECT id FROM jobs WHERE version_id = v.id AND state = 'failed' ORDER BY id DESC LIMIT 1) WHERE`)}
       ORDER BY a.title LIMIT ?`,
    )
    .all(libraryId, limit) as LibraryUnreadable[];
}

/** Retry on Library status's Unreadable: every failed step of those files queued again; the file is ready once they land. */
export function retryUnreadable(libraryId: string): number {
  const db = libraryDb();
  const rows = db
    .prepare(`SELECT j.version_id, j.kind, j.actor FROM jobs j WHERE j.state = 'failed' AND j.version_id IN (SELECT v.id ${UNREADABLE})`)
    .all(libraryId) as { version_id: string; kind: string; actor: string | null }[];
  for (const r of rows) enqueueJob(db, libraryId, r.version_id, r.kind, r.actor);
  return new Set(rows.map((r) => r.version_id)).size;
}
