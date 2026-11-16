import type { DatabaseSync } from "node:sqlite";
import { asTurn } from "./turn";
import type { AssetCard, AssetKind, AssetPage, LibrarySort, SearchQuery } from "../../contracts/library";
import type { ProbeSummary } from "./media/probe";
import { inReview } from "./trash";
import { facetClauses } from "./sources";
import { deviceOf } from "../lib/devices";

/**
 * Asset listing for the library (tasks/media-library-plan.md, sections 6 and 8): one SQL statement from a
 * SearchQuery, keyset-paged on (created_at, id), newest first. Full text goes through search_assets (FTS5), where
 * every word is a quoted prefix, so no user text can break the MATCH syntax.
 */

export const DEFAULT_LIMIT = 60;
export const MAX_LIMIT = 200;
export const KINDS: AssetKind[] = ["video", "image", "audio", "doc"];

/**
 * Each order as one SQL key and its direction; the id breaks ties in the same direction, and the cursor carries the key
 * and the id of a page's last row. The same expression orders and pages, so a page never skips or repeats a clip.
 * A clip with no length (a picture, a document, one not read yet) is last both ways; Filmed falls back to when it was added.
 * ponytail: Name is SQLite's NOCASE ("clip 10" before "clip 2"); a numeric-aware collation if people number their clips
 */
const LENGTH = "json_extract(v.probe, '$.duration')";
export const SORTS: Record<LibrarySort, { key: string; desc: boolean; text?: true }> = {
  new: { key: "a.created_at", desc: true },
  old: { key: "a.created_at", desc: false },
  name: { key: "a.title COLLATE NOCASE", desc: false, text: true },
  longest: { key: `COALESCE(NULLIF(${LENGTH}, 0), -1)`, desc: true },
  shortest: { key: `COALESCE(NULLIF(${LENGTH}, 0), 1e15)`, desc: false },
  filmed: { key: "COALESCE(json_extract(v.probe, '$.capturedAt'), a.created_at)", desc: true },
};

/** FTS5 query: each word quoted as a prefix match, words ANDed. Null when there are no words. */
export function ftsQuery(q: string): string | null {
  const words = q.split(/\s+/).filter(Boolean).slice(0, 12);
  return words.length ? words.map((w) => `"${w.replace(/"/g, '""')}"*`).join(" ") : null;
}

/** The description people see: a human's wins over the AI's. `source || char(31) || text`, split by toCard. */
const SHOWN = (version: string) =>
  `(SELECT source || char(31) || text FROM descriptions dd WHERE dd.version_id = ${version} ORDER BY dd.source = 'user' DESC LIMIT 1)`;

/**
 * Finished work, which never has a roll (roll.ts): a file saved as finished (filed_roll 'none': an export, a Review video,
 * review.ts toLibrary) or an asset with a version in a Finals piece. The library's own pages are footage: the listing,
 * search, tag and place counts and folder counts leave it out; Review and Finals show it, and reads by id still find it.
 */
export const FINISHED = `(a.filed_roll IS 'none' OR EXISTS (SELECT 1 FROM piece_items fp JOIN asset_versions fv ON fv.id = fp.version_id WHERE fv.asset_id = a.id))`;

/** Rewrites an asset's search row (FTS5 has no upsert): its title, tags and the shown description of its current version. */
export function indexAsset(db: DatabaseSync, assetId: string): void {
  const a = db.prepare(`SELECT library_id, title, ${SHOWN("assets.current_version_id")} AS description FROM assets WHERE id = ?`).get(assetId) as
    | { library_id: string; title: string; description: string | null }
    | undefined;
  if (!a) return;
  const tags = (db.prepare("SELECT tag FROM asset_tags WHERE asset_id = ?").all(assetId) as { tag: string }[])
    .map((r) => r.tag)
    .join(" ");
  db.prepare("DELETE FROM search_assets WHERE asset_id = ?").run(assetId);
  db.prepare("INSERT INTO search_assets (asset_id, library_id, title, tags, description) VALUES (?, ?, ?, ?, ?)").run(
    assetId,
    a.library_id,
    a.title,
    tags,
    a.description ? describedAs(a.description).text : "",
  );
}

/** Reads the query string of GET /assets. Unknown kinds are dropped; limit is clamped to 1..200. */
export function parseSearch(p: Record<string, string | undefined>): SearchQuery {
  const num = (v: string | undefined) => (v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const kind = (p.kind ?? "").split(",").filter((k): k is AssetKind => KINDS.includes(k as AssetKind));
  const limit = num(p.limit);
  // plug-in facets: f.<key>=a,b (values only ever compared by the facet's own SQL)
  const picked = Object.fromEntries(
    Object.entries(p)
      .filter(([k]) => k.startsWith("f."))
      .map(([k, v]) => [k.slice(2, 80), (v ?? "").split(",").map((s) => s.slice(0, 80)).filter(Boolean).slice(0, 20)] as const)
      .filter(([, vs]) => vs.length),
  );
  return {
    ...(p.q?.trim() ? { q: p.q.trim().slice(0, 200) } : {}),
    ...(kind.length ? { kind } : {}),
    ...(p.tag ? { tags: [...new Set(p.tag.split(",").map((t) => t.trim().slice(0, 80)).filter(Boolean))].slice(0, 20) } : {}),
    ...(num(p.filmedFrom) !== undefined ? { filmedFrom: num(p.filmedFrom) } : {}),
    ...(num(p.filmedTo) !== undefined ? { filmedTo: num(p.filmedTo) } : {}),
    ...(p.place && /^[A-Z]{2}$/.test(p.place) ? { place: p.place } : {}),
    ...(num(p.from) !== undefined ? { from: num(p.from) } : {}),
    ...(num(p.to) !== undefined ? { to: num(p.to) } : {}),
    ...(p.cursor ? { cursor: p.cursor } : {}),
    ...(p.collectionId ? { collectionId: p.collectionId.slice(0, 64) } : {}),
    ...(p.trashed === "1" ? { trashed: true } : {}),
    ...(p.unfiled === "1" ? { unfiled: true } : {}),
    ...(p.roll === "a" || p.roll === "b" ? { roll: p.roll } : {}),
    ...(p.versions ? { versions: p.versions.split(",").filter(Boolean).slice(0, MAX_LIMIT) } : {}),
    ...(Object.keys(picked).length ? { facets: picked } : {}),
    ...(p.sort && p.sort in SORTS ? { sort: p.sort as LibrarySort } : {}),
    limit: Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit ?? DEFAULT_LIMIT))),
  };
}

export const CARD = `a.id AS id, a.library_id AS library_id, a.kind AS kind, a.title AS title, a.created_at AS created_at,
  a.trashed_at AS trashed_at, v.id AS version_id, v.n AS version_n, v.state AS state, v.probe AS probe,
  EXISTS (SELECT 1 FROM derivatives d WHERE d.version_id = v.id AND d.kind = 'thumb') AS has_thumb,
  EXISTS (SELECT 1 FROM derivatives d WHERE d.version_id = v.id AND d.kind = 'sprite') AS has_sprite,
  (SELECT group_concat(tag, char(31)) FROM asset_tags t WHERE t.asset_id = a.id) AS tags,
  (SELECT group_concat(tag, char(31)) FROM asset_tags t WHERE t.asset_id = a.id AND t.source = 'ai') AS ai_tags,
  ${SHOWN("v.id")} AS description, CASE WHEN ${FINISHED} THEN NULL ELSE a.roll END AS roll, ${FINISHED} AS finished, v.source_path IS NOT NULL OR v.mac_path IS NOT NULL AS in_place, v.mac_path AS mac_path, v.mac_device AS mac_device,
  (SELECT j.kind || char(31) || j.state FROM jobs j WHERE j.version_id = v.id AND j.state IN ('queued', 'running')
    ORDER BY j.state = 'running' DESC, instr('probe thumb wave proxy sprite fingerprint transcribe describe embed', j.kind) LIMIT 1) AS preparing,
  CASE WHEN v.state = 'failed' THEN (SELECT j.kind || char(31) || IFNULL(j.error, '') FROM jobs j WHERE j.version_id = v.id AND j.state = 'failed'
    AND j.kind IN ('probe', 'thumb', 'wave', 'proxy') LIMIT 1) END AS failed`;

export interface CardRow {
  id: string;
  library_id: string;
  kind: AssetKind;
  title: string;
  created_at: number;
  trashed_at: number | null;
  version_id: string;
  version_n: number;
  state: AssetCard["state"];
  probe: string | null;
  has_thumb: number;
  has_sprite?: number;
  tags: string | null;
  ai_tags: string | null;
  description: string | null;
  preparing?: string | null;
  failed?: string | null;
  roll: AssetCard["roll"] | null;
  finished: number;
  in_place: number;
  mac_path?: string | null;
  mac_device?: string | null;
  /** the row's value in the listing's order (buildAssetQuery), for the next page's cursor */
  sort_key?: string | number | null;
}

/** When a clip was filmed (its probe's capturedAt), else when it was added. Through `a` only: search by meaning has no `v`. */
const FILMED = "COALESCE((SELECT json_extract(fv.probe, '$.capturedAt') FROM asset_versions fv WHERE fv.id = a.current_version_id), a.created_at)";

/** Filmed in this country: the current version's probe (media/probe.ts countryOf). */
const PLACE = "(SELECT json_extract(pv.probe, '$.country') FROM asset_versions pv WHERE pv.id = a.current_version_id) = ?";

/** The library's own filters as SQL on `a`, for the list and for search (search.ts): every tag picked, when it was filmed. */
export function filterClauses(query: SearchQuery): { sql: string; params: (string | number)[] }[] {
  return [
    ...(query.tags ?? []).map((t) => ({ sql: "a.id IN (SELECT asset_id FROM asset_tags WHERE tag = ?)", params: [t] })),
    ...(query.filmedFrom !== undefined ? [{ sql: `${FILMED} >= ?`, params: [query.filmedFrom] }] : []),
    ...(query.filmedTo !== undefined ? [{ sql: `${FILMED} < ?`, params: [query.filmedTo] }] : []),
    ...(query.place ? [{ sql: PLACE, params: [query.place] }] : []),
  ];
}

/** The SQL for one page of a library's assets, with `limit + 1` rows so the caller knows there is a next page. */
export function buildAssetQuery(libraryId: string, query: SearchQuery = {}): { sql: string; params: (string | number)[]; limit: number } {
  const where = ["a.library_id = ?", query.trashed ? "a.trashed_at IS NOT NULL" : "a.trashed_at IS NULL"];
  const params: (string | number)[] = [libraryId];
  const fts = query.q ? ftsQuery(query.q) : null;
  if (fts) {
    where.push("a.id IN (SELECT asset_id FROM search_assets WHERE search_assets MATCH ?)");
    params.push(fts);
  }
  if (query.kind?.length) {
    where.push(`a.kind IN (${query.kind.map(() => "?").join(",")})`);
    params.push(...query.kind);
  }
  if (query.tag) {
    where.push("a.id IN (SELECT asset_id FROM asset_tags WHERE tag = ?)");
    params.push(query.tag);
  }
  if (query.from !== undefined) {
    where.push("a.created_at >= ?");
    params.push(query.from);
  }
  if (query.to !== undefined) {
    where.push("a.created_at < ?");
    params.push(query.to);
  }
  if (query.roll) {
    where.push(`a.roll = ? AND NOT ${FINISHED}`);
    params.push(query.roll);
  }
  // footage only (owner, 2026-11-15: "the conversions and finals I don't want to appear in the media library"),
  // except a read of named versions (Review, Finals, the AI Editor)
  if (!query.versions?.length) where.push(`NOT ${FINISHED}`);
  if (query.versions?.length) {
    where.push(`v.id IN (${query.versions.map(() => "?").join(",")})`);
    params.push(...query.versions);
  }
  if (query.collectionId) {
    where.push("a.id IN (SELECT asset_id FROM collection_items WHERE collection_id = ?)");
    params.push(query.collectionId);
  }
  if (query.unfiled) {
    // a folder is a plain collection; Finals (finals.ts) and a saved search's old item rows are not
    where.push(`a.id NOT IN (SELECT fi.asset_id FROM collection_items fi JOIN collections fc ON fc.id = fi.collection_id
      WHERE fc.kind = 'manual' AND NOT (fc.parent_id IS NULL AND fc.name = 'Finals'))`);
  }
  for (const f of facetClauses(query.facets ?? {})) {
    where.push(f.sql);
    params.push(...f.params);
  }
  for (const f of filterClauses(query)) {
    where.push(f.sql);
    params.push(...f.params);
  }
  const order = SORTS[query.sort ?? "new"] ?? SORTS.new;
  const at = query.cursor ? cursorOf(query.cursor, !!order.text) : null;
  if (at) {
    const cmp = order.desc ? "<" : ">";
    where.push(`((${order.key}) ${cmp} ? OR ((${order.key}) = ? AND a.id ${cmp} ?))`);
    params.push(at.key, at.key, at.id);
  }
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT)));
  params.push(limit + 1);
  const dir = order.desc ? "DESC" : "ASC";
  const sql = `SELECT ${CARD}, ${order.key} AS sort_key FROM assets a JOIN asset_versions v ON v.id = a.current_version_id
    WHERE ${where.join(" AND ")} ORDER BY ${order.key} ${dir}, a.id ${dir} LIMIT ?`;
  return { sql, params, limit };
}

/** Cursor = "<sort value>:<id>" of the last row on a page (the value is created_at when newest first). Ids never contain a
 *  colon, so the last colon splits it: a name may have one. */
export const cursorFor = (r: { created_at: number; id: string; sort_key?: string | number | null }) => `${r.sort_key ?? r.created_at}:${r.id}`;
function cursorOf(c: string, text: boolean): { key: string | number; id: string } | null {
  const i = c.lastIndexOf(":");
  if (i < 0) return null;
  const key = text ? c.slice(0, i) : Number(c.slice(0, i));
  return text || (i > 0 && Number.isFinite(key)) ? { key, id: c.slice(i + 1) } : null;
}

/** Where a Mac-held file is, for its card: the drive's name for one under /Volumes, else the Mac's name. */
export function macPlace(macPath: string, device: string | null): string {
  const m = /^\/Volumes\/([^/]+)\//.exec(macPath);
  if (m) return m[1]!;
  return (device && deviceOf(device)?.name) || "Mac";
}

/** A row as the browser sees it. The probe is read field by field: GPS and other tags never leave the server. */
export function toCard(r: CardRow): AssetCard {
  const p = (r.probe ? JSON.parse(r.probe) : {}) as Partial<ProbeSummary>;
  const split = (s: string | null) => (s ? s.split("\x1f") : []);
  const review = inReview(r.id);
  const turn = asTurn(p.turn);
  const side = turn === 90 || turn === 270;
  return {
    id: r.id,
    libraryId: r.library_id,
    kind: r.kind,
    title: r.title,
    versionId: r.version_id,
    versionN: r.version_n,
    ...(p.duration ? { durationS: p.duration } : {}),
    ...(p.width ? (side ? { width: p.height, height: p.width } : { width: p.width, height: p.height }) : {}),
    ...(turn ? { turn } : {}),
    // a turned clip's pictures were made again: a new address, so no window shows the one it kept
    ...(r.has_thumb ? { thumbUrl: `/api/library/media/${r.version_id}/thumb${turn ? `?t=${turn}` : ""}` } : {}),
    ...(r.has_sprite ? { spriteUrl: `/api/library/media/${r.version_id}/sprite${turn ? `?t=${turn}` : ""}` } : {}),
    tags: split(r.tags),
    aiTags: split(r.ai_tags),
    ...(r.description ? { description: describedAs(r.description) } : {}),
    state: r.state,
    ...(p.capturedAt ? { capturedAt: p.capturedAt } : {}),
    ...(p.country ? { place: p.country } : {}),
    ...(r.trashed_at ? { trashedAt: r.trashed_at } : {}),
    ...(r.roll && !review ? { roll: r.roll } : {}),
    ...(r.finished || review ? { finished: true as const } : {}),
    ...(r.in_place ? { onComputer: true as const } : {}),
    ...(r.mac_path ? { onMac: macPlace(r.mac_path, r.mac_device ?? null) } : {}),
    ...(review ? { review: true as const } : {}), // ponytail: two stats a card; a column when pages get big
    ...(r.preparing ? { preparing: { step: r.preparing.split("\x1f")[0] as NonNullable<AssetCard["preparing"]>["step"], running: r.preparing.endsWith("running") } } : {}),
    ...(r.failed ? { failed: { step: r.failed.split("\x1f")[0] as NonNullable<AssetCard["failed"]>["step"], error: r.failed.split("\x1f")[1] ?? "" } } : {}),
  };
}

const describedAs = (s: string): NonNullable<AssetCard["description"]> => {
  const i = s.indexOf("\x1f");
  return { source: s.slice(0, i) === "user" ? "user" : "ai", text: s.slice(i + 1) };
};

/** One page: items, plus the cursor when more follow. */
export function pageOf(rows: CardRow[], limit: number): AssetPage {
  const items = rows.slice(0, limit).map(toCard);
  const last = rows[limit - 1];
  return rows.length > limit && last ? { items, next: cursorFor(last) } : { items };
}
