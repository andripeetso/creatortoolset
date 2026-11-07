import type { SimilarMatch } from "../../contracts/library";
import { workspaceOf } from "../lib/workspaces";
import { libraryRole } from "./access";
import { libraryDb } from "./db";
import type { Fingerprint } from "./fingerprint";
import { enqueueJob } from "./jobs";

/**
 * The duplicate check (tasks/media-library-plan.md, section 10): which videos in the caller's libraries share
 * pictures with a clip, by the per-second pHashes of the `fingerprint` derivative. A second of the clip matches when
 * some second of the other video is within MAX_BITS of it; `overlap` is the share of the clip's seconds that match.
 * The Video Cleaner calls similarTo with a file that is not in the library; similar(versionId) is the same for a
 * library version.
 */

const MAX_BITS = 10; // fingerprint.test.ts measured about 3 for a re-encode, about 31 for another video
const MIN_OVERLAP = 0.3;
const TOP = 10;

/** A hex pHash as two 32-bit halves, so a comparison is two XORs and two bit counts. */
const halves = (h: string): [number, number] => [parseInt(h.slice(0, 8), 16), parseInt(h.slice(8, 16), 16)];
const bits = (x: number) => {
  let n = 0;
  for (; x; x &= x - 1) n++;
  return n;
};

export interface SimilarResult {
  matches: SimilarMatch[];
  checked: number; // versions compared
  pending: number; // versions still without a fingerprint (queued now)
}

/** `phashes` (one per second) against every fingerprinted current version in the caller's workspace's libraries. */
export function similarTo(username: string, phashes: string[], exclude?: string): SimilarResult {
  const w = workspaceOf(username);
  if (!w || !phashes.length) return { matches: [], checked: 0, pending: 0 };
  const d = libraryDb();
  const rows = d
    .prepare(
      `SELECT a.id AS asset_id, a.library_id, a.title, v.id AS version_id, f.inline FROM assets a
       JOIN libraries l ON l.id = a.library_id JOIN asset_versions v ON v.id = a.current_version_id
       LEFT JOIN derivatives f ON f.version_id = v.id AND f.kind = 'fingerprint'
       WHERE l.workspace_id = ? AND a.trashed_at IS NULL AND a.kind = 'video' AND v.state = 'ready'`,
    )
    .all(w.id) as { asset_id: string; library_id: string; title: string; version_id: string; inline: string | null }[];
  const query = phashes.map(halves);
  const matches: SimilarMatch[] = [];
  let pending = 0;
  let checked = 0;
  // ponytail: every second against every second, O(clip × library); a BK-tree or LSH index when libraries reach thousands of hours
  for (const r of rows) {
    if (r.version_id === exclude) continue;
    if (!r.inline) {
      // computed once, then stored: the worker fingerprints it as the uploader
      enqueueJob(d, r.library_id, r.version_id, "fingerprint", (d.prepare("SELECT created_by FROM asset_versions WHERE id = ?").get(r.version_id) as { created_by: string }).created_by);
      pending++;
      continue;
    }
    const theirs = (JSON.parse(r.inline) as Fingerprint).phash.map(halves);
    if (!theirs.length) continue;
    checked++;
    let hit = 0;
    for (const [qa, qb] of query) if (theirs.some(([a, b]) => bits((qa ^ a) >>> 0) + bits((qb ^ b) >>> 0) <= MAX_BITS)) hit++;
    const overlap = hit / query.length;
    if (overlap >= MIN_OVERLAP) {
      matches.push({ assetId: r.asset_id, libraryId: r.library_id, versionId: r.version_id, title: r.title, thumbUrl: `/api/library/media/${r.version_id}/thumb`, overlap });
    }
  }
  matches.sort((a, b) => b.overlap - a.overlap);
  return { matches: matches.slice(0, TOP), checked, pending };
}

/** A library version against the rest of its workspace's libraries. Null when it has no fingerprint yet. */
export function similar(username: string, versionId: string): SimilarResult | null {
  const f = libraryDb()
    .prepare(
      `SELECT a.library_id, f.inline FROM derivatives f JOIN asset_versions v ON v.id = f.version_id JOIN assets a ON a.id = v.asset_id
       WHERE f.version_id = ? AND f.kind = 'fingerprint'`,
    )
    .get(versionId) as { library_id: string; inline: string | null } | undefined;
  if (!f?.inline || !libraryRole(username, f.library_id)) return null;
  return similarTo(username, (JSON.parse(f.inline) as Fingerprint).phash, versionId);
}
