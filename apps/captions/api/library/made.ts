import { MADE_KINDS, SOUNDS, type LibraryMade, type MadeKind } from "../../contracts/library";
import { PICTURE_MODEL } from "../lib/device-picture";
import { keepsOnlyOriginals, libraryDb } from "./db";
import { makeCost } from "./estimate";
import { enqueueJob } from "./jobs";
import { wantsProxy } from "./media/proxy";
import type { ProbeSummary } from "./media/probe";
import { wakePictures } from "./pictures";
import { LOOK_MIN_S } from "./shots";
import { mayLeave } from "./upload-gate";

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

/** Per kind: the job that makes it (none: a catch-up does), the files that can have it, what having it is, and which of the missing this server can queue. */
const SPEC: Record<MadeKind, { job?: string; of: string; have: string; can?: string }> = {
  thumb: { job: "thumb", of: "a.kind IN ('video', 'image')", have: derived("thumb"), can: HERE },
  sprite: { job: "sprite", of: `a.kind = 'video' AND NOT ${MUSIC}`, have: derived("sprite"), can: HERE },
  wave: { job: "wave", of: "a.kind IN ('video', 'audio')", have: derived("wave"), can: HERE },
  fingerprint: { job: "fingerprint", of: `a.kind = 'video' AND NOT ${MUSIC}`, have: derived("fingerprint"), can: HERE },
  proxy: { job: "proxy", of: "a.kind = 'video'", have: derived("proxy") },
  transcribe: { job: "transcribe", of: `a.kind IN ('video', 'audio') AND json_extract(v.probe, '$.acodec') IS NOT NULL AND NOT ${MUSIC}`, have: has("transcripts") },
  describe: { job: "describe", of: `a.kind IN ('video', 'image') AND NOT ${MUSIC}`, have: has("descriptions") },
  embed: { job: "embed", of: `(${has("transcripts")} OR ${has("descriptions")})`, have: has("embeddings") },
  pictures: { of: `a.kind IN ('video', 'image') AND ${derived("thumb", " AND x.storage_key IS NOT NULL")}`, have: has("pictures", ` AND x.seg = -1 AND x.model = '${PICTURE_MODEL}'`) },
  look: { job: "look", of: LOOKABLE, have: LINES },
  timeline: { job: "look", of: `${LOOKABLE} AND ${LINES}`, have: has("timelines", " AND x.error IS NULL") },
};

/** The library's files now: current versions read, out of the trash, not hidden. */
const LIVE = `FROM assets a JOIN asset_versions v ON v.id = a.current_version_id JOIN libraries l ON l.id = a.library_id
  WHERE a.library_id = ? AND a.trashed_at IS NULL AND a.left_hidden_at IS NULL AND v.probe IS NOT NULL AND v.state NOT IN ('failed', 'missing')`;
const open = (job?: string) => (job ? `EXISTS (SELECT 1 FROM jobs j WHERE j.version_id = v.id AND j.kind = '${job}' AND j.state IN ('queued', 'running'))` : "0");

interface Missing {
  id: string;
  seconds: number;
}

/** The files missing `kind` that this server can queue it for. A proxy only where one is wanted (media/proxy.ts) and may be kept. */
function missingOf(libraryId: string, kind: MadeKind): Missing[] {
  const s = SPEC[kind];
  const rows = libraryDb()
    .prepare(
      `SELECT v.id, v.probe, v.source_key, IFNULL(json_extract(v.probe, '$.duration'), 0) AS seconds ${LIVE} AND ${s.of} AND NOT ${s.have} AND NOT ${open(s.job)}${s.can ? ` AND ${s.can}` : ""}`,
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
    const s = SPEC[kind];
    const r = db
      .prepare(
        `SELECT IFNULL(SUM(have), 0) AS have, IFNULL(SUM(NOT have AND open), 0) AS queued, IFNULL(SUM(NOT have AND NOT open AND can), 0) AS missing,
           IFNULL(AVG(CASE WHEN NOT have AND NOT open AND can THEN seconds END), 0) AS seconds
         FROM (SELECT ${s.have} AS have, ${open(s.job)} AS open, ${s.can ?? "1"} AS can, IFNULL(json_extract(v.probe, '$.duration'), 0) AS seconds ${LIVE} AND ${s.of})`,
      )
      .get(libraryId) as { have: number; queued: number; missing: number; seconds: number };
    // a proxy is missing only where one is wanted: the rows read once more, filtered as the worker would
    const missing = kind === "proxy" ? missingOf(libraryId, kind) : null;
    const n = missing ? missing.length : r.missing;
    const seconds = missing ? missing.reduce((t, m) => t + m.seconds, 0) / Math.max(1, n) : r.seconds;
    out.push({ kind, have: r.have, missing: n, queued: r.queued, ...(await makeCost(libraryId, username, kind, n, seconds)) });
  }
  return out;
}

/**
 * Make for the missing: `kind` for every file of the library that lacks it, as `username` (their AI and keys). A job kind
 * is queued per file; search by picture and timelines are made by their catch-ups, which take every file in the library
 * at this moment from now on (`picturesAsked`, `timelineAsked`). Returns how many files.
 */
export function makeMissing(libraryId: string, kind: MadeKind, username: string, now = Date.now()): number {
  const db = libraryDb();
  const files = missingOf(libraryId, kind);
  if (kind === "pictures" || kind === "timeline") {
    db.prepare(`UPDATE libraries SET settings = json_set(settings, '$.${kind}Asked', ?) WHERE id = ?`).run(now, libraryId);
    if (kind === "pictures") wakePictures();
    return files.length;
  }
  // asked for by name: a done job whose output is not there (removed since) runs again too
  for (const f of files) enqueueJob(db, libraryId, f.id, SPEC[kind].job!, username, true);
  return files.length;
}

/** Retry: the failed jobs of `kind` in the library queued again as whoever queued them (a file that has it is marked done, jobs.ts). */
export function retryFailed(libraryId: string, kind: string): number {
  const db = libraryDb();
  const rows = db
    .prepare(
      `SELECT j.version_id, j.actor FROM jobs j JOIN assets a ON a.current_version_id = j.version_id
       WHERE j.library_id = ? AND j.kind = ? AND j.state = 'failed' AND a.trashed_at IS NULL AND a.left_hidden_at IS NULL`,
    )
    .all(libraryId, kind) as { version_id: string; actor: string | null }[];
  for (const r of rows) enqueueJob(db, libraryId, r.version_id, kind, r.actor);
  return rows.length;
}
