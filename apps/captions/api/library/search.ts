import { Hono, type Context } from "hono";
import type { AuthVars } from "../auth";
import type { AssetDetail, SearchHit, SearchQuery } from "../../contracts/library";
import { deviceEmbedStatus } from "../lib/device-embed";
import { deviceStatus } from "../lib/device-transcribe";
import { libraryRole, mayWrite, versionSource } from "./access";
import { libraryDb } from "./db";
import { hitKey, meaningGettingReady, rrf, semanticHits } from "./embed";
import { enqueueJob } from "./jobs";
import { CARD, ftsQuery, indexAsset, parseSearch, toCard, type CardRow } from "./query";
import { viewerOf, visibleCards } from "./routes";
import { assetRef, canSee, facetClauses } from "./sources";
import { segmentsOf } from "./transcribe";

/**
 * Search, one asset in full, re-running jobs, and opening a clip in Caption Studio (tasks/media-library-plan.md,
 * sections 6, 7 and 10). Mounted at /api/library next to routes.ts. Search reads titles, tags and descriptions
 * (search_assets) and what is said in the clips (search_segments): a segment hit carries its second, so the preview
 * opens there. Only the current version of assets out of the trash is searched. Outsiders get 404 everywhere.
 */

export const searchApp = new Hono<{ Variables: AuthVars }>();
type Ctx = Context<{ Variables: AuthVars }>;

const db = () => libraryDb();
const notFound = (c: Ctx) => c.json({ error: "Not found", code: "not_found" }, 404);
const LIMIT = 50;

type Clause = { sql: string; params: (string | number)[] };

/** What narrows a search, as the asset list narrows its page: a folder, kinds, and the plug-in facets (sources.ts). */
export function searchClauses(query: SearchQuery): Clause[] {
  return [
    ...(query.collectionId ? [{ sql: "a.id IN (SELECT asset_id FROM collection_items WHERE collection_id = ?)", params: [query.collectionId] }] : []),
    ...(query.kind?.length ? [{ sql: `a.kind IN (${query.kind.map(() => "?").join(",")})`, params: query.kind }] : []),
    ...facetClauses(query.facets ?? {}),
  ];
}

/** Asset hits first (title weighs most), then the lines said in clips, each with the second it starts at. */
export function searchLibrary(libraryId: string, q: string, limit = LIMIT, fx: Clause[] = []): SearchHit[] {
  const fts = ftsQuery(q);
  if (!fts) return [];
  const fsql = fx.map((f) => ` AND ${f.sql}`).join("");
  const fparams = fx.flatMap((f) => f.params);
  const assets = db()
    .prepare(
      `SELECT ${CARD} FROM search_assets s JOIN assets a ON a.id = s.asset_id JOIN asset_versions v ON v.id = a.current_version_id
       WHERE search_assets MATCH ? AND a.library_id = ? AND a.trashed_at IS NULL${fsql}
       ORDER BY bm25(search_assets, 0, 0, 5, 2, 1) LIMIT ?`,
    )
    .all(fts, libraryId, ...fparams, limit) as unknown as CardRow[];
  const said = db()
    .prepare(
      `SELECT ${CARD}, s.seg AS seg, snippet(search_segments, 2, '', '', '…', 16) AS snippet
       FROM search_segments s JOIN asset_versions v ON v.id = s.version_id JOIN assets a ON a.current_version_id = v.id
       WHERE search_segments MATCH ? AND a.library_id = ? AND a.trashed_at IS NULL${fsql}
       ORDER BY bm25(search_segments) LIMIT ?`,
    )
    .all(fts, libraryId, ...fparams, limit) as unknown as (CardRow & { seg: number; snippet: string })[];
  const segs = new Map<string, ReturnType<typeof segmentsOf>>();
  const startOf = (versionId: string, seg: number) => {
    if (!segs.has(versionId)) segs.set(versionId, segmentsOf(db(), versionId));
    return segs.get(versionId)![seg]?.start ?? 0;
  };
  return [
    ...assets.map((r) => ({ asset: toCard(r) })),
    ...said.map((r) => ({ asset: toCard(r), seconds: startOf(r.version_id, r.seg), snippet: r.snippet })),
  ];
}

/** One asset as a member of its library sees it: versions, transcript, folders, and its current version's jobs. */
export function assetDetail(libraryId: string, assetId: string): AssetDetail | null {
  const row = db()
    .prepare(`SELECT ${CARD} FROM assets a JOIN asset_versions v ON v.id = a.current_version_id WHERE a.id = ? AND a.library_id = ?`)
    .get(assetId, libraryId) as CardRow | undefined;
  if (!row) return null;
  const versions = db()
    .prepare("SELECT id, n, bytes, created_at AS createdAt, created_by AS createdBy, state FROM asset_versions WHERE asset_id = ? ORDER BY n DESC")
    .all(assetId) as unknown as AssetDetail["versions"];
  const collections = db()
    .prepare("SELECT c.id, c.name FROM collection_items i JOIN collections c ON c.id = i.collection_id WHERE i.asset_id = ? ORDER BY c.name")
    .all(assetId) as { id: string; name: string }[];
  const jobs = (
    db().prepare("SELECT kind, state, error FROM jobs WHERE version_id = ? ORDER BY id").all(row.version_id) as {
      kind: string;
      state: AssetDetail["jobs"][number]["state"];
      error: string | null;
    }[]
  ).map((j) => {
    // a transcript or a search entry being made on this computer says what it is doing (a model's first download, listening)
    const status = j.kind === "transcribe" ? deviceStatus : j.kind === "embed" ? deviceEmbedStatus : null;
    const error = status && j.state === "running" ? status(row.version_id) : j.error;
    return { kind: j.kind, state: j.state, ...(error ? { error } : {}) };
  });
  const t = db().prepare("SELECT provider FROM transcripts WHERE version_id = ?").get(row.version_id) as { provider: string } | undefined;
  return {
    ...toCard(row),
    versions,
    collections,
    jobs,
    ...(t ? { transcript: { provider: t.provider, segments: segmentsOf(db(), row.version_id) } } : {}),
  };
}

// GET /api/library/:id/search?q&collectionId&kind&f.<key> → SearchHit[], best first: full text, fused with the chunks
// close in meaning when semantic search is on. Hits the viewer may not see are left out. While search by meaning is
// still getting ready (its model fetched the first time), the hits are by words and X-Search-Meaning says getting-ready.
searchApp.get("/:id/search", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  const viewer = viewerOf(user.username, libraryId);
  if (!viewer) return notFound(c);
  const q = (c.req.query("q") ?? "").trim().slice(0, 200);
  if (!q) return c.json({ error: "Type something to search for", code: "invalid" }, 400);
  const where = searchClauses(parseSearch(c.req.query()));
  const text = searchLibrary(libraryId, q, LIMIT, where);
  const meaning = await semanticHits(libraryId, q, user.username, where).catch(() => null);
  const hits = meaning ? rrf([text, meaning], hitKey).slice(0, 2 * LIMIT) : text;
  if (!meaning && meaningGettingReady(libraryId, user.username)) c.header("X-Search-Meaning", "getting-ready");
  const seen = await visibleCards(viewer, libraryId, hits.map((h) => h.asset));
  const shown = new Set(seen.map((a) => a.id));
  return c.json(hits.filter((h) => shown.has(h.asset.id)));
});

// GET /api/library/:id/assets/:assetId → AssetDetail (404 for a viewer the policies refuse)
searchApp.get("/:id/assets/:assetId", async (c) => {
  const libraryId = c.req.param("id");
  const viewer = viewerOf(c.get("user").username, libraryId);
  if (!viewer) return notFound(c);
  const detail = assetDetail(libraryId, c.req.param("assetId"));
  if (!detail || !(await canSee(viewer, assetRef(libraryId, detail.id, detail.versionId)))) return notFound(c);
  return c.json(detail);
});

const RERUN = new Set(["transcribe", "describe", "fingerprint", "embed"]);

// POST /api/library/:id/assets/:assetId/jobs { kinds } → queued again, with the caller as the actor (their key)
searchApp.post("/:id/assets/:assetId/jobs", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  const role = libraryRole(user.username, libraryId);
  const a = role
    ? (db().prepare("SELECT created_by, current_version_id FROM assets WHERE id = ? AND library_id = ? AND trashed_at IS NULL").get(c.req.param("assetId"), libraryId) as
        | { created_by: string; current_version_id: string | null }
        | undefined)
    : undefined;
  if (!a?.current_version_id || !(await mayWrite(user.username, libraryId, c.req.param("assetId"), a.current_version_id))) return notFound(c);
  const body = (await c.req.json().catch(() => null)) as { kinds?: unknown } | null;
  const kinds = Array.isArray(body?.kinds) ? body.kinds.filter((k): k is string => typeof k === "string" && RERUN.has(k)) : [];
  if (!kinds.length) return c.json({ error: `Nothing to run: kinds may be ${[...RERUN].join(", ")}`, code: "invalid" }, 400);
  // asked for by name: a done job runs again too (a fresh description, new vectors)
  for (const k of kinds) enqueueJob(db(), libraryId, a.current_version_id, k, user.username, true);
  return c.json({ ok: true });
});

// PATCH /api/library/:id/assets/:assetId { title?, tags?, description? }: the uploader or the owner.
// `tags` is the whole list people see: a tag left out goes (the AI's too), a new one is theirs. `description` is the
// human one, shown over the AI's; empty removes it and the AI's shows again.
// ponytail: a changed description is not re-embedded until the next transcribe or describe; Retry embed does it now
searchApp.patch("/:id/assets/:assetId", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  const role = libraryRole(user.username, libraryId);
  const assetId = c.req.param("assetId");
  const a = role
    ? (db().prepare("SELECT created_by, current_version_id FROM assets WHERE id = ? AND library_id = ? AND trashed_at IS NULL").get(assetId, libraryId) as
        | { created_by: string; current_version_id: string | null }
        | undefined)
    : undefined;
  if (!a?.current_version_id || !(await mayWrite(user.username, libraryId, assetId, a.current_version_id))) return notFound(c);
  const b = (await c.req.json().catch(() => null)) as { title?: unknown; tags?: unknown; description?: unknown } | null;
  const title = typeof b?.title === "string" ? b.title.trim().slice(0, 160) : undefined;
  const tags = Array.isArray(b?.tags)
    ? [...new Set(b.tags.filter((t): t is string => typeof t === "string").map((t) => t.trim().slice(0, 80)).filter(Boolean))].slice(0, 50)
    : undefined;
  const description = typeof b?.description === "string" ? b.description.trim().slice(0, 4000) : undefined;
  if (title === "" || (title === undefined && tags === undefined && description === undefined))
    return c.json({ error: "Send a title, tags or a description", code: "invalid" }, 400);
  const d = db();
  d.exec("BEGIN");
  try {
    if (title) d.prepare("UPDATE assets SET title = ? WHERE id = ?").run(title, assetId);
    if (tags) {
      d.prepare(`DELETE FROM asset_tags WHERE asset_id = ? AND tag NOT IN (SELECT value FROM json_each(?))`).run(assetId, JSON.stringify(tags));
      const add = d.prepare("INSERT OR IGNORE INTO asset_tags (asset_id, tag, source) VALUES (?, ?, 'user')");
      for (const t of tags) add.run(assetId, t);
    }
    if (description) {
      d.prepare("INSERT OR REPLACE INTO descriptions (version_id, source, text, provider, created_at) VALUES (?, 'user', ?, NULL, ?)").run(
        a.current_version_id,
        description,
        Date.now(),
      );
    } else if (description === "") d.prepare("DELETE FROM descriptions WHERE version_id = ? AND source = 'user'").run(a.current_version_id);
    indexAsset(d, assetId);
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
  return c.json(assetDetail(libraryId, assetId));
});

const opening = new Map<string, Promise<string>>();

// POST /api/library/:id/assets/:assetId/captions → { projectId }: a new Caption Studio project on the current version
// ponytail: a new project on every open; remember one per (version, account) when people open the same clip often
searchApp.post("/:id/assets/:assetId/captions", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  const viewer = viewerOf(user.username, libraryId);
  if (!viewer) return notFound(c);
  const row = db()
    .prepare(
      `SELECT a.title, a.kind, v.id AS version_id, v.probe FROM assets a JOIN asset_versions v ON v.id = a.current_version_id
       WHERE a.id = ? AND a.library_id = ? AND a.trashed_at IS NULL`,
    )
    .get(c.req.param("assetId"), libraryId) as { title: string; kind: string; version_id: string; probe: string | null } | undefined;
  if (!row) return notFound(c);
  if (!(await canSee(viewer, assetRef(libraryId, c.req.param("assetId"), row.version_id)))) return notFound(c);
  if (row.kind !== "video") return c.json({ error: "Caption Studio opens videos", code: "conflict" }, 409);
  const file = await versionSource(user.username, row.version_id);
  if (!file) return c.json({ error: "The file is not ready", code: "conflict" }, 409);
  const key = `${row.version_id}/${user.username}`;
  let job = opening.get(key);
  if (!job) {
    job = (async () => {
      const { createProjectFromFile } = await import("../projects");
      const created = await createProjectFromFile({
        owner: user.username,
        name: row.title,
        clipName: row.title,
        file,
        duration: Number((JSON.parse(row.probe ?? "{}") as { duration?: number }).duration) || 0,
        libraryVersionId: row.version_id,
      });
      return created.projectId;
    })().finally(() => opening.delete(key));
    opening.set(key, job);
  }
  try {
    return c.json({ projectId: await job });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e), code: "conflict" }, 500);
  }
});
