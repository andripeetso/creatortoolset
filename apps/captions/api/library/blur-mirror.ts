import type { DatabaseSync } from "node:sqlite";

/**
 * A blurred copy (Face Blur's render, `asset_versions.blurred_of` = its original's SHA-256) is the same footage as its
 * original: same sound, same shots. Every analysis runs on the original, where the AI sees the faces as filmed, and the
 * copy takes the results over (owner, 2026-11-24): nothing is transcribed, described or watched twice. Only what shows
 * the blur is made from the copy itself (its card picture, strip and proxy).
 */

/** The analysis jobs a blurred copy never runs: queued on its original instead (jobs.ts enqueueJob). */
export const ON_ORIGINAL: ReadonlySet<string> = new Set(["transcribe", "describe", "look", "embed", "fingerprint"]);

/** The original a blurred copy was made from: an older version of the same clip with that SHA-256. Undefined otherwise. */
export function originalOf(db: DatabaseSync, versionId: string): string | undefined {
  return (
    db
      .prepare(
        `SELECT o.id FROM asset_versions b JOIN asset_versions o ON o.asset_id = b.asset_id AND o.id != b.id AND o.blurred_of IS NULL
          AND (o.full_sha256 = b.blurred_of OR o.sha256 = b.blurred_of)
         WHERE b.id = ? AND b.blurred_of IS NOT NULL LIMIT 1`,
      )
      .get(versionId) as { id: string } | undefined
  )?.id;
}

// each analysis: its rows by version, the search index filled with it, the job whose result it is. `ai`: the rows a new
// result replaces (what the person wrote stays); `keep`: copied once, never replaced (their notes from edits)
const PARTS: { table: string; where?: string; ai?: string; keep?: true; fts?: { table: string; cols: string[] }; job?: string }[] = [
  { table: "transcripts", fts: { table: "search_segments", cols: ["seg", "text"] }, job: "transcribe" },
  { table: "descriptions", ai: "source = 'ai'", job: "describe" },
  { table: "embeddings", job: "embed" },
  { table: "stretches", ai: "source = 'ai'", job: "look" },
  { table: "stretch_notes", keep: true },
  { table: "timelines", where: "error IS NULL", fts: { table: "search_timeline", cols: ["a", "text"] } },
  { table: "pictures" },
  { table: "derivatives", where: "kind = 'fingerprint'", job: "fingerprint" },
  { table: "derivatives", where: "kind = 'wave'" },
];

const colsOf = (db: DatabaseSync, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

/**
 * Copies `from`'s analysis to the blurred copy `to`: each part the copy has none of, or every part when `replace` (a
 * result made again on the original). The copy's jobs for what it now has read done. True when its description changed.
 */
export function mirrorTo(db: DatabaseSync, from: string, to: string, replace = false, now = Date.now()): boolean {
  let described = false;
  let shots = false;
  db.exec("SAVEPOINT blur_mirror");
  try {
    for (const p of PARTS) {
      const where = p.where ? ` AND ${p.where}` : "";
      if (!db.prepare(`SELECT 1 FROM ${p.table} WHERE version_id = ?${where} LIMIT 1`).get(from)) continue;
      const has = !!db.prepare(`SELECT 1 FROM ${p.table} WHERE version_id = ?${where} LIMIT 1`).get(to);
      if (has && (!replace || p.keep)) continue;
      // a result made again replaces the copy's made rows only; the first copy takes the person's too
      const rows = `${where}${has && p.ai ? ` AND ${p.ai}` : ""}`;
      if (has) {
        db.prepare(`DELETE FROM ${p.table} WHERE version_id = ?${rows}`).run(to);
        if (p.fts) db.prepare(`DELETE FROM ${p.fts.table} WHERE version_id = ?`).run(to);
      }
      const cols = colsOf(db, p.table).filter((c) => c !== "version_id");
      db.prepare(`INSERT OR REPLACE INTO ${p.table} (version_id, ${cols.join(", ")}) SELECT ?, ${cols.join(", ")} FROM ${p.table} WHERE version_id = ?${rows}`).run(to, from);
      if (p.fts) db.prepare(`INSERT INTO ${p.fts.table} (version_id, ${p.fts.cols.join(", ")}) SELECT ?, ${p.fts.cols.join(", ")} FROM ${p.fts.table} WHERE version_id = ?`).run(to, from);
      if (p.job)
        db.prepare(
          `UPDATE jobs SET state = 'done', error = NULL, lease_until = NULL, done_at = ? WHERE version_id = ? AND kind = ? AND state IN ('queued', 'failed', 'needs_key', 'stopped')`,
        ).run(now, to, p.job);
      if (p.table === "descriptions") described = true;
      if (p.table === "stretches") shots = true;
    }
    // the level and cut finder the shots were read at, so no sweep reads them again for a level that differs
    db.prepare(
      `UPDATE asset_versions SET look_level = IFNULL(look_level, (SELECT look_level FROM asset_versions WHERE id = ?)), cuts_by = IFNULL(cuts_by, (SELECT cuts_by FROM asset_versions WHERE id = ?)) WHERE id = ?`,
    ).run(from, from, to);
    db.exec("RELEASE blur_mirror");
  } catch (e) {
    db.exec("ROLLBACK TO blur_mirror");
    db.exec("RELEASE blur_mirror");
    throw e;
  }
  if (described || shots) reindex(db, to, described, shots);
  return described;
}

/** A job done on an original: its blurred copies take the new result (jobs.ts finishJob). */
export function mirrorFromOriginal(db: DatabaseSync, versionId: string): void {
  const copies = db
    .prepare(
      `SELECT b.id FROM asset_versions o JOIN asset_versions b ON b.asset_id = o.asset_id AND b.id != o.id
        AND b.blurred_of IS NOT NULL AND (b.blurred_of = o.full_sha256 OR b.blurred_of = o.sha256)
       WHERE o.id = ? AND o.blurred_of IS NULL`,
    )
    .all(versionId) as { id: string }[];
  for (const c of copies) mirrorTo(db, versionId, c.id, true);
}

// each blurred copy with its original (originalOf, for every copy at once)
const PAIRS = `SELECT b.id AS copy, o.id AS original FROM asset_versions b JOIN asset_versions o ON o.asset_id = b.asset_id AND o.id != b.id
  AND o.blurred_of IS NULL AND (o.full_sha256 = b.blurred_of OR o.sha256 = b.blurred_of) WHERE b.blurred_of IS NOT NULL`;

/**
 * Every blurred copy takes what its original has and it lacks: each minute, for what lands later (a timeline). One query
 * per part finds the pairs short of it, so a library of a thousand pairs with nothing new reads nine queries, not thousands.
 */
export function mirrorBlurred(db: DatabaseSync): number {
  const short = new Map<string, string>();
  for (const p of PARTS) {
    const where = p.where ? ` AND ${p.where}` : "";
    const rows = db
      .prepare(
        `SELECT copy, original FROM (${PAIRS}) WHERE EXISTS (SELECT 1 FROM ${p.table} WHERE version_id = original${where})
           AND NOT EXISTS (SELECT 1 FROM ${p.table} WHERE version_id = copy${where})`,
      )
      .all() as { copy: string; original: string }[];
    for (const r of rows) short.set(r.copy, r.original);
  }
  for (const [copy, original] of short) mirrorTo(db, original, copy);
  return short.size;
}

// the clip's search row reads the description of its current version (query.ts indexAsset), and a shot's row the line
// shown, the person's where they wrote one (stretches.ts indexStretches). Loaded when used: those modules reach most of
// the library's, and this one is read by the job queue itself
function reindex(db: DatabaseSync, versionId: string, described: boolean, shots: boolean): void {
  const a = db.prepare("SELECT asset_id FROM asset_versions WHERE id = ?").get(versionId) as { asset_id: string } | undefined;
  if (described && a) void import("./query").then(({ indexAsset }) => indexAsset(db, a.asset_id)).catch((e) => console.warn("[library] blurred copy search row:", e));
  if (shots) void import("./stretches").then(({ indexStretches }) => indexStretches(db, versionId)).catch((e) => console.warn("[library] blurred copy shots search:", e));
}
