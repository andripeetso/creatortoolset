import type { DatabaseSync } from "node:sqlite";
import { asTurn } from "./turn";
import { proxySize, type AssetCard, type AssetKind, type AssetPage, type LibrarySort, type SearchQuery } from "../../contracts/library";
import type { ProbeSummary } from "./media/probe";
import { inReview } from "./trash";
import { facetClauses } from "./sources";
import { deviceOf } from "../lib/devices";
import { libraryProxyQuality } from "./db";
import { placeWordOf } from "../../contracts/places";
import { folderStatesFor } from "./places";
import { GONE_ON_COMPUTER_SQL, ON_COMPUTER_SQL, whereIsMany } from "./whereis";

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
  "name-za": { key: "a.title COLLATE NOCASE", desc: true, text: true },
  longest: { key: `COALESCE(NULLIF(${LENGTH}, 0), -1)`, desc: true },
  shortest: { key: `COALESCE(NULLIF(${LENGTH}, 0), 1e15)`, desc: false },
  filmed: { key: "COALESCE(json_extract(v.probe, '$.capturedAt'), a.created_at)", desc: true },
  "filmed-old": { key: "COALESCE(json_extract(v.probe, '$.capturedAt'), a.created_at)", desc: false },
  biggest: { key: "v.bytes", desc: true },
  smallest: { key: "v.bytes", desc: false },
  kind: { key: "a.kind", desc: false, text: true },
  "kind-za": { key: "a.kind", desc: true, text: true },
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

/**
 * Reads the query string of GET /assets. Unknown kinds are dropped; limit is clamped to 1..200. A computer is kept only
 * when it is `username`'s own.
 */
export function parseSearch(p: Record<string, string | undefined>, username?: string): SearchQuery {
  const device = p.device && username && deviceOf(p.device)?.owner === username ? p.device : undefined;
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
    ...(device ? { device, ...(p.here === "1" ? { here: true as const } : {}), ...(p.missing === "1" ? { missing: true as const } : {}) } : {}),
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

export const CARD = `a.id AS id, a.library_id AS library_id, a.kind AS kind, a.title AS title, a.created_at AS created_at, v.bytes AS bytes,
  a.trashed_at AS trashed_at, v.id AS version_id, v.n AS version_n, v.state AS state, v.probe AS probe,
  EXISTS (SELECT 1 FROM derivatives d WHERE d.version_id = v.id AND d.kind = 'thumb') AS has_thumb,
  EXISTS (SELECT 1 FROM derivatives d WHERE d.version_id = v.id AND d.kind = 'sprite') AS has_sprite,
  (SELECT d.cell_w || 'x' || d.cell_h FROM derivatives d WHERE d.version_id = v.id AND d.kind = 'sprite') AS sprite_cell,
  (SELECT group_concat(tag, char(31)) FROM asset_tags t WHERE t.asset_id = a.id) AS tags,
  (SELECT group_concat(tag, char(31)) FROM asset_tags t WHERE t.asset_id = a.id AND t.source = 'ai') AS ai_tags,
  ${SHOWN("v.id")} AS description, CASE WHEN ${FINISHED} THEN NULL ELSE a.roll END AS roll, ${FINISHED} AS finished, COALESCE(v.source_path, v.mac_path, v.from_path) IS NOT NULL AS in_place, v.mac_path AS mac_path, v.mac_device AS mac_device,
  (SELECT j.kind || char(31) || j.state FROM jobs j WHERE j.version_id = v.id AND j.state IN ('queued', 'running')
    ORDER BY j.state = 'running' DESC, instr('probe thumb wave proxy sprite fingerprint transcribe describe look embed', j.kind) LIMIT 1) AS preparing,
  CASE WHEN v.state = 'failed' THEN (SELECT j.kind || char(31) || IFNULL(j.error, '') FROM jobs j WHERE j.version_id = v.id AND j.state = 'failed'
    AND j.kind IN ('probe', 'thumb', 'wave', 'proxy') LIMIT 1) END AS failed`;

export interface CardRow {
  id: string;
  library_id: string;
  kind: AssetKind;
  title: string;
  created_at: number;
  bytes?: number | null;
  trashed_at: number | null;
  version_id: string;
  version_n: number;
  state: AssetCard["state"];
  probe: string | null;
  has_thumb: number;
  has_sprite?: number;
  /** the strip's frame size as "WxH" (media/sprite.ts noteStrip), null for an old strip */
  sprite_cell?: string | null;
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

/** Where the current version is, from the place rows only (whereis.ts): `v.id` read as `a.current_version_id`, since search by meaning has no `v`. */
const atCurrent = (sql: string) => sql.replaceAll("= v.id", "= a.current_version_id");

/** On this computer: its proxy in the computer's cache (a 'proxy' place row, from its work claims), or its original verified or found there. */
const HERE = `(EXISTS (SELECT 1 FROM version_places xp WHERE xp.version_id = a.current_version_id AND xp.device = ? AND xp.kind = 'proxy' AND xp.state IN ('verified','found'))
  OR ${atCurrent(ON_COMPUTER_SQL)})`;

/** Missing there: that computer listed the file's folder whole and the file was not in it. A row not checked yet (a drive
 *  away, a folder not found, a row from before) or no row at all is "Not checked yet", never missing. */
const MISSING = atCurrent(GONE_ON_COMPUTER_SQL);

/** The library's own filters as SQL on `a`, for the list and for search (search.ts): every tag picked, when it was filmed. */
export function filterClauses(query: SearchQuery): { sql: string; params: (string | number)[] }[] {
  return [
    ...(query.here && query.device ? [{ sql: HERE, params: [query.device, query.device] }] : []),
    ...(query.missing && query.device ? [{ sql: MISSING, params: [query.device, query.device] }] : []),
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
    // nor a clip the A-roll or B-roll folder lists: it is filed there, the top level would show it twice
    where.push(`NOT (a.roll IS NOT NULL AND EXISTS (SELECT 1 FROM collections rc WHERE rc.library_id = a.library_id AND rc.kind = 'smart'
      AND json_extract(rc.query, '$.roll') = a.roll AND (SELECT COUNT(*) FROM json_each(rc.query)) = 1))`);
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

const query = (q: Record<string, string | number | undefined>) => {
  const s = Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join("&");
  return s ? `?${s}` : "";
};

/** A row as the browser sees it. The probe is read field by field: GPS and other tags never leave the server. */
export function toCard(r: CardRow): AssetCard {
  const p = (r.probe ? JSON.parse(r.probe) : {}) as Partial<ProbeSummary>;
  const split = (s: string | null) => (s ? s.split("\x1f") : []);
  const review = inReview(r.id);
  const turn = asTurn(p.turn);
  // the shape as it is watched: the file's own rotation tag (a phone filmed or recorded on its side), then the turn
  const side = (((p.rotation ?? 0) + turn) / 90) % 2 === 1;
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
    // a strip made again in the clip's shape has a new address too (its frame size), so no window keeps the old one
    ...(r.has_sprite ? { spriteUrl: `/api/library/media/${r.version_id}/sprite${query({ t: turn || undefined, s: r.sprite_cell ?? undefined })}` } : {}),
    tags: split(r.tags),
    aiTags: split(r.ai_tags),
    ...(r.description ? { description: describedAs(r.description) } : {}),
    state: r.state,
    ...(p.capturedAt ? { capturedAt: p.capturedAt } : {}),
    ...(r.created_at ? { addedAt: r.created_at } : {}),
    ...(r.bytes ? { bytes: r.bytes } : {}),
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

/**
 * Marks the cards with where they are (whereis.ts, the one reader): `placeWord` seen from `device` (the asker's own
 * computer, parseSearch; none: any of the person's), for a clip some computer has a place row for; and `here` when it is
 * on that computer (its proxy cached there, or its original verified or found there).
 */
export async function markHere(db: DatabaseSync, cards: AssetCard[], device?: string): Promise<AssetCard[]> {
  if (!cards.length) return cards;
  const ids = cards.map((c) => c.versionId);
  const where = whereIsMany(ids, await folderStatesFor(ids));
  const here = device
    ? new Set(
        (db.prepare(`SELECT a.current_version_id AS id FROM assets a WHERE a.current_version_id IN (SELECT value FROM json_each(?)) AND ${HERE}`)
          .all(JSON.stringify(ids), device, device) as { id: string }[]).map((r) => r.id),
      )
    : new Set<string>();
  const proxies = proxiesOf(db, ids, device);
  return cards.map((c) => {
    const w = where.get(c.versionId);
    const placed = w?.computers.some((x) => x.original) ? { placeWord: placeWordOf(w, device) } : {};
    const proxy = proxies.get(c.versionId);
    return { ...c, ...placed, ...(here.has(c.versionId) ? { here: true as const } : {}), ...(proxy ? { proxy } : {}) };
  });
}

/**
 * The videos' proxies that can play (AssetCard.proxy): one the server stores, one in computer `device`'s cache (its
 * 'proxy' place row, from its work claims). The size from the upright source and the library's Proxy quality.
 * shortcut: the quality now, not the one it was made at; keep the proxy's own probe if a change of quality shows wrong sizes.
 */
function proxiesOf(db: DatabaseSync, ids: string[], device?: string): Map<string, NonNullable<AssetCard["proxy"]>> {
  const rows = db
    .prepare(
      `SELECT v.id, v.probe, a.library_id,
         EXISTS (SELECT 1 FROM derivatives x WHERE x.version_id = v.id AND x.kind = 'proxy' AND x.storage_key IS NOT NULL) AS server,
         EXISTS (SELECT 1 FROM version_places p WHERE p.version_id = v.id AND p.kind = 'proxy' AND p.device = ? AND p.state IN ('verified','found')) AS cached
       FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id IN (SELECT value FROM json_each(?)) AND a.kind = 'video'`,
    )
    .all(device ?? "", JSON.stringify(ids)) as { id: string; probe: string | null; library_id: string; server: number; cached: number }[];
  const out = new Map<string, NonNullable<AssetCard["proxy"]>>();
  for (const r of rows) {
    const p = (r.probe ? JSON.parse(r.probe) : {}) as Partial<ProbeSummary>;
    if ((!r.server && !r.cached) || !p.width || !p.height) continue;
    // the proxy is drawn upright by the file's own rotation (ffmpeg turns it on decode); the library's turn is the player's
    const [w, h] = (p.rotation ?? 0) % 180 ? [p.height, p.width] : [p.width, p.height];
    out.set(r.id, { ...proxySize(w, h, libraryProxyQuality(r.library_id)), ...(r.server ? { server: true as const } : {}), ...(r.cached ? { cached: true as const } : {}) });
  }
  return out;
}

/** One page: items, plus the cursor when more follow. */
export function pageOf(rows: CardRow[], limit: number): AssetPage {
  const items = rows.slice(0, limit).map(toCard);
  const last = rows[limit - 1];
  return rows.length > limit && last ? { items, next: cursorFor(last) } : { items };
}
