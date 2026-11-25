import { MADE_KINDS, SOUNDS, WATCH_MODELS, type LibraryMade, type MadeKind } from "../../contracts/library";
import { DRIVERS } from "../../contracts/providers";
import { aiFor, anthropicParams, onApiKey } from "../ai-complete";
import { PICTURE_MODEL } from "../lib/device-picture";
import { deviceOf, isOnline, listDevices } from "../lib/devices";
import { libraryWorkspace, serverWorks } from "../work/server-work";
import { keepsOnlyOriginals, libraryDb } from "./db";
import { FINISHED } from "./query";
import { DESCRIBE_LABEL, whoFor } from "./describe";
import { makeCost, makeMinutes } from "./estimate";
import { embedRoute, modelFor } from "./embed";
import { enqueueJob } from "./jobs";
import { wantsProxy } from "./media/proxy";
import type { ProbeSummary } from "./media/probe";
import { wakePictures } from "./pictures";
import { LOOK_LABEL, LOOK_MIN_S, queueLook } from "./shots";
import { libraryWatchModel } from "./timeline";
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
  return job ? `EXISTS (SELECT 1 FROM jobs j WHERE j.version_id = v.id AND j.kind = '${job}' AND j.state IN ('queued', 'running'))` : "0";
}
/** SQL: the version's `job` failed (Retry queues it again, routes.ts). */
const failedJob = (job?: string) => (job ? `EXISTS (SELECT 1 FROM jobs j WHERE j.version_id = v.id AND j.kind = '${job}' AND j.state = 'failed')` : "0");
/** SQL: the version's `job` was stopped (Retry queues it again): neither failed nor missing. */
const stoppedJob = (job?: string) => (job ? `EXISTS (SELECT 1 FROM jobs j WHERE j.version_id = v.id AND j.kind = '${job}' AND j.state = 'stopped')` : "0");
/** A file in the library when Make for the missing was pressed for `kind` (search by picture, timelines: their catch-ups make them). */
const pressed = (kind: "pictures" | "timeline") => `v.created_at <= IFNULL(json_extract(l.settings, '$.${kind}Asked'), -1)`;

/**
 * Per kind: the job that makes it (none: a catch-up does), the files that can have it, what having it is, which of the
 * missing this server can queue, and what counts as on its way (default: its job queued or running).
 */
const SPEC: Record<MadeKind, { job?: string; of: string; have: string; can?: string; open?: string }> = {
  thumb: { job: "thumb", of: "a.kind IN ('video', 'image')", have: derived("thumb"), can: HERE },
  sprite: { job: "sprite", of: `a.kind = 'video' AND NOT ${MUSIC}`, have: derived("sprite"), can: HERE },
  wave: { job: "wave", of: "a.kind IN ('video', 'audio')", have: derived("wave"), can: HERE },
  fingerprint: { job: "fingerprint", of: `a.kind = 'video' AND NOT ${MUSIC}`, have: derived("fingerprint"), can: HERE },
  proxy: { job: "proxy", of: "a.kind = 'video'", have: derived("proxy") },
  // a video indexed on a Mac: its probe has no sound codec (on-mac.ts), and it gets a transcript all the same
  transcribe: {
    job: "transcribe",
    of: `(a.kind = 'video' OR a.kind = 'audio') AND (json_extract(v.probe, '$.acodec') IS NOT NULL OR (a.kind = 'video' AND v.source_key LIKE 'mac:%')) AND NOT ${MUSIC}`,
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
  look: { job: "look", of: LOOKABLE, have: `(${LINES} OR ${has("jobs", " AND x.kind = 'look' AND x.state = 'done'")})` },
  // on its way: its look running, or pressed for with no watch since (one that failed after the press is missing again)
  timeline: {
    job: "look",
    of: `${LOOKABLE} AND ${LINES}`,
    have: has("timelines", " AND x.error IS NULL"),
    open: `(${open("look")} OR (${pressed("timeline")} AND NOT ${has("timelines", " AND x.at >= json_extract(l.settings, '$.timelineAsked')")}))`,
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
  // a timeline's job is its look's: a failed look is that kind's to retry, not this one's
  const failed = kind === "timeline" ? "0" : failedJob(s.job);
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
  return rows.filter((r) => wantsProxy(JSON.parse(r.probe) as ProbeSummary, { cloud: false, on: true }) && (r.source_key.startsWith("mac:") || mayLeave(libraryId, { versionId: r.id }).ok));
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
      ...(await makeCost(libraryId, username, kind, n, seconds)),
      ...engineOf(libraryId, kind, username),
      ...(n ? { minutes: await makeMinutes(libraryId, username, kind, n, seconds) } : {}),
      ...(skipped ? { skipped: { n: skipped, why: skip!.why } } : {}),
      ...(n && (kind === "transcribe" || kind === "describe") ? { broll: brollOf(libraryId, kind, username) } : {}),
    });
  }
  return out;
}

/** The files of a media kind a kind never makes, and why in a few words (the rest of `of` is in SPEC). */
const SKIP: Partial<Record<MadeKind, { of: string; why: string }>> = {
  transcribe: { of: "a.kind IN ('video', 'audio')", why: "no sound, or music" },
  look: { of: "a.kind = 'video'", why: `shorter than ${LOOK_MIN_S} s, or talking takes` },
  embed: { of: "a.kind IN ('video', 'audio', 'image')", why: "no transcript or description yet" },
  timeline: { of: LOOKABLE, why: "no shot descriptions yet" },
};

/** Of `kind`'s missing files, the B-roll ones (videos nobody talks in: roll.ts). */
function brollOf(libraryId: string, kind: MadeKind, username: string): number {
  const s = specOf(kind, username);
  return (libraryDb().prepare(`SELECT COUNT(*) AS n ${LIVE} AND ${s.of} AND NOT ${s.have} AND NOT ${s.open} AND NOT ${s.failed} AND a.roll = 'b'`).get(libraryId) as { n: number }).n;
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
        return { engine: "FFmpeg and PDQ picture hashes", where: videoWhere(libraryId, username) };
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
export function stopQueued(libraryId: string, kind: MadeKind, username: string): number {
  if (MADE_KINDS.find((k) => k.kind === kind)?.ready) return 0;
  const db = libraryDb();
  if (kind === "pictures" || kind === "timeline") {
    const n = (db.prepare(`SELECT COUNT(*) AS n ${LIVE} AND ${SPEC[kind].of} AND NOT ${specOf(kind, username).have} AND ${pressed(kind)}`).get(libraryId) as { n: number }).n;
    // a timeline's job is its look's: those stay, shot descriptions of their own
    db.prepare(`UPDATE libraries SET settings = json_remove(settings, '$.${kind}Asked') WHERE id = ?`).run(libraryId);
    return n;
  }
  const job = SPEC[kind].job;
  if (!job) return 0;
  // kept as stopped, not deleted: a file with no job row is new to the sweeps (shots.ts sweepLook) and queued again
  return Number(db.prepare(`UPDATE jobs SET state = 'stopped', error = NULL WHERE library_id = ? AND kind = ? AND state = 'queued'`).run(libraryId, job).changes);
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
      `SELECT j.id, j.state, j.held_by, j.error, j.actor ${LIVE.replace("WHERE", `JOIN jobs j ON j.version_id = v.id AND j.kind = '${s.job}' AND j.state IN ('queued', 'running') WHERE`)} AND ${s.of} AND NOT ${s.have} ORDER BY j.id LIMIT 500`,
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

/** Retry: the failed and stopped jobs of `kind` in the library queued again as whoever queued them (a failed file that has it is marked done, jobs.ts). */
export function retryFailed(libraryId: string, kind: string): number {
  const db = libraryDb();
  const rows = db
    .prepare(
      `SELECT j.version_id, j.actor FROM jobs j JOIN assets a ON a.current_version_id = j.version_id
       WHERE j.library_id = ? AND j.kind = ? AND j.state = 'failed' AND a.trashed_at IS NULL AND a.left_hidden_at IS NULL`,
    )
    .all(libraryId, kind) as { version_id: string; actor: string | null }[];
  for (const r of rows) enqueueJob(db, libraryId, r.version_id, kind, r.actor);
  // and the stopped ones (stopQueued): queued again as they were, its actor kept
  const stopped = db
    .prepare(
      `UPDATE jobs SET state = 'queued', attempts = 0, run_after = 0, lease_until = NULL, error = NULL
       WHERE library_id = ? AND kind = ? AND state = 'stopped' AND version_id IN (SELECT current_version_id FROM assets WHERE trashed_at IS NULL AND left_hidden_at IS NULL)`,
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
