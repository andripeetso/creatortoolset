import type { DatabaseSync } from "node:sqlite";
import type { AssetCard, AssetKind, AssetPage, SearchQuery } from "../../contracts/library";
import type { ProbeSummary } from "./media/probe";

/**
 * Asset listing for the library (tasks/media-library-plan.md, sections 6 and 8): one SQL statement from a
 * SearchQuery, keyset-paged on (created_at, id), newest first. Full text goes through search_assets (FTS5), where
 * every word is a quoted prefix, so no user text can break the MATCH syntax.
 */

export const DEFAULT_LIMIT = 60;
export const MAX_LIMIT = 200;
const KINDS: AssetKind[] = ["video", "image", "audio", "doc"];

/** FTS5 query: each word quoted as a prefix match, words ANDed. Null when there are no words. */
export function ftsQuery(q: string): string | null {
  const words = q.split(/\s+/).filter(Boolean).slice(0, 12);
  return words.length ? words.map((w) => `"${w.replace(/"/g, '""')}"*`).join(" ") : null;
}

/** Rewrites an asset's search row (FTS5 has no upsert): its title and tags. Description joins in S8. */
export function indexAsset(db: DatabaseSync, assetId: string): void {
  const a = db.prepare("SELECT library_id, title FROM assets WHERE id = ?").get(assetId) as
    | { library_id: string; title: string }
    | undefined;
  if (!a) return;
  const tags = (db.prepare("SELECT tag FROM asset_tags WHERE asset_id = ?").all(assetId) as { tag: string }[])
    .map((r) => r.tag)
    .join(" ");
  db.prepare("DELETE FROM search_assets WHERE asset_id = ?").run(assetId);
  db.prepare("INSERT INTO search_assets (asset_id, library_id, title, tags, description) VALUES (?, ?, ?, ?, '')").run(
    assetId,
    a.library_id,
    a.title,
    tags,
  );
}

/** Reads the query string of GET /assets. Unknown kinds are dropped; limit is clamped to 1..200. */
export function parseSearch(p: Record<string, string | undefined>): SearchQuery {
  const num = (v: string | undefined) => (v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const kind = (p.kind ?? "").split(",").filter((k): k is AssetKind => KINDS.includes(k as AssetKind));
  const limit = num(p.limit);
  return {
    ...(p.q?.trim() ? { q: p.q.trim().slice(0, 200) } : {}),
    ...(kind.length ? { kind } : {}),
    ...(p.tag ? { tag: p.tag.slice(0, 80) } : {}),
    ...(num(p.from) !== undefined ? { from: num(p.from) } : {}),
    ...(num(p.to) !== undefined ? { to: num(p.to) } : {}),
    ...(p.cursor ? { cursor: p.cursor } : {}),
    limit: Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit ?? DEFAULT_LIMIT))),
  };
}

const CARD = `a.id AS id, a.library_id AS library_id, a.kind AS kind, a.title AS title, a.created_at AS created_at,
  v.id AS version_id, v.n AS version_n, v.state AS state, v.probe AS probe,
  EXISTS (SELECT 1 FROM derivatives d WHERE d.version_id = v.id AND d.kind = 'thumb') AS has_thumb,
  (SELECT group_concat(tag, char(31)) FROM asset_tags t WHERE t.asset_id = a.id) AS tags,
  (SELECT group_concat(tag, char(31)) FROM asset_tags t WHERE t.asset_id = a.id AND t.source = 'ai') AS ai_tags`;

export interface CardRow {
  id: string;
  library_id: string;
  kind: AssetKind;
  title: string;
  created_at: number;
  version_id: string;
  version_n: number;
  state: AssetCard["state"];
  probe: string | null;
  has_thumb: number;
  tags: string | null;
  ai_tags: string | null;
}

/** The SQL for one page of a library's assets, with `limit + 1` rows so the caller knows there is a next page. */
export function buildAssetQuery(libraryId: string, query: SearchQuery = {}): { sql: string; params: (string | number)[]; limit: number } {
  const where = ["a.library_id = ?", "a.trashed_at IS NULL"];
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
  const at = query.cursor ? cursorOf(query.cursor) : null;
  if (at) {
    where.push("(a.created_at < ? OR (a.created_at = ? AND a.id < ?))");
    params.push(at.createdAt, at.createdAt, at.id);
  }
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT)));
  params.push(limit + 1);
  const sql = `SELECT ${CARD} FROM assets a JOIN asset_versions v ON v.id = a.current_version_id
    WHERE ${where.join(" AND ")} ORDER BY a.created_at DESC, a.id DESC LIMIT ?`;
  return { sql, params, limit };
}

/** Cursor = "<created_at>:<id>" of the last row on a page. Ids never contain a colon. */
export const cursorFor = (r: { created_at: number; id: string }) => `${r.created_at}:${r.id}`;
function cursorOf(c: string): { createdAt: number; id: string } | null {
  const i = c.indexOf(":");
  const createdAt = Number(c.slice(0, i));
  return i > 0 && Number.isFinite(createdAt) ? { createdAt, id: c.slice(i + 1) } : null;
}

/** A row as the browser sees it. The probe is read field by field: GPS and other tags never leave the server. */
export function toCard(r: CardRow): AssetCard {
  const p = (r.probe ? JSON.parse(r.probe) : {}) as Partial<ProbeSummary>;
  const split = (s: string | null) => (s ? s.split("\x1f") : []);
  return {
    id: r.id,
    libraryId: r.library_id,
    kind: r.kind,
    title: r.title,
    versionId: r.version_id,
    versionN: r.version_n,
    ...(p.duration ? { durationS: p.duration } : {}),
    ...(p.width ? { width: p.width, height: p.height } : {}),
    ...(r.has_thumb ? { thumbUrl: `/api/library/media/${r.version_id}/thumb` } : {}),
    tags: split(r.tags),
    aiTags: split(r.ai_tags),
    state: r.state,
    ...(p.capturedAt ? { capturedAt: p.capturedAt } : {}),
  };
}

/** One page: items, plus the cursor when more follow. */
export function pageOf(rows: CardRow[], limit: number): AssetPage {
  const items = rows.slice(0, limit).map(toCard);
  const last = rows[limit - 1];
  return rows.length > limit && last ? { items, next: cursorFor(last) } : { items };
}
