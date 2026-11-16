import { Hono, type Context } from "hono";
import { turnVersion } from "./turn";
import { existsSync } from "node:fs";
import path from "node:path";
import type { AuthVars } from "../auth";
import type { AssetDetail, SearchHit, SearchQuery, StretchLines } from "../../contracts/library";
import { deviceEmbedStatus } from "../lib/device-embed";
import { env, hostedMode } from "../lib/env";
import type { SessionUser } from "../users";
import { keyParts } from "./storage/types";
import { deviceStatus } from "../lib/device-transcribe";
import { libraryRole, mayWrite, versionSource } from "./access";
import { libraryDb } from "./db";
import { hitKey, meaningGettingReady, rrf, semanticHits } from "./embed";
import { enqueueJob, prepareFirst } from "./jobs";
import { CARD, FINISHED, ftsQuery, indexAsset, parseSearch, toCard, type CardRow } from "./query";
import { filterClauses } from "./query";
import { readerOf, viewerOf, visibleCards } from "./routes";
import { assetRef, canSee, facetClauses } from "./sources";
import { segmentsOf } from "./transcribe";
import { ratedLine } from "./look";
import { MAX_SIGNAL_FRAMES, parseSignal, setUserLine, storeLines, stretchesOf, takeSignal, type StretchLine } from "./stretches";
// the studio plug-in reads it from here (it lived here before stretches.ts)
export { parseSignal } from "./stretches";

/**
 * Search, one asset in full, re-running jobs, and opening a clip in Caption Studio (tasks/media-library-plan.md,
 * sections 6, 7 and 10). Mounted at /api/library next to routes.ts. Search reads titles, tags and descriptions
 * (search_assets), what is said in the clips (search_segments) and their shot descriptions (search_stretches): a
 * segment or shot hit carries its second, so the preview opens there. Only the current version of assets out of the trash is searched. Outsiders get 404 everywhere.
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
    ...filterClauses(query),
  ];
}

/** Asset hits first (title weighs most), then the lines said in clips, then the shots seen in them, each with the second it starts at. */
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
  const seen = db()
    .prepare(
      `SELECT ${CARD}, (SELECT st.a FROM stretches st WHERE st.version_id = s.version_id AND st.seg = s.seg LIMIT 1) AS at,
         snippet(search_stretches, 2, '', '', '…', 16) AS snippet
       FROM search_stretches s JOIN asset_versions v ON v.id = s.version_id JOIN assets a ON a.current_version_id = v.id
       WHERE search_stretches MATCH ? AND a.library_id = ? AND a.trashed_at IS NULL${fsql}
       ORDER BY bm25(search_stretches) LIMIT ?`,
    )
    .all(fts, libraryId, ...fparams, limit) as unknown as (CardRow & { at: number | null; snippet: string })[];
  return [
    ...assets.map((r) => ({ asset: toCard(r) })),
    ...said.map((r) => ({ asset: toCard(r), seconds: startOf(r.version_id, r.seg), snippet: r.snippet })),
    ...seen.map((r) => ({ asset: toCard(r), seconds: r.at ?? 0, snippet: r.snippet })),
  ];
}

/**
 * Where the clip's file is on this computer, for its Copy path and Show in Finder: the admin only. A clip read in place
 * from a footage folder: that file. A clip kept on this server's own disk: the stored copy, only when the server is the
 * Mac app's own on this Mac (CT_LOCAL=1, never hosted), so a path is never given for a disk the viewer can't open.
 */
export function sourcePathFor(libraryId: string, versionId: string, user: Pick<SessionUser, "role"> | undefined): string | undefined {
  if (user?.role !== "admin") return undefined;
  const v = db()
    .prepare("SELECT v.source_key, v.source_path, v.mac_path, l.storage_kind FROM asset_versions v JOIN assets a ON a.id = v.asset_id JOIN libraries l ON l.id = a.library_id WHERE v.id = ? AND a.library_id = ?")
    .get(versionId, libraryId) as { source_key: string; source_path: string | null; mac_path: string | null; storage_kind: string } | undefined;
  if (!v) return undefined;
  // a file indexed on a Mac: its path there (Show in Finder finds it on that Mac)
  if (v.source_path || v.mac_path) return v.source_path ?? v.mac_path!;
  if (v.storage_kind !== "local" || process.env.CT_LOCAL !== "1" || process.platform !== "darwin" || hostedMode()) return undefined;
  const file = path.join(env.dataDir, "library", "blobs", ...keyParts(v.source_key)); // the local store's layout (storage/local.ts)
  return existsSync(file) ? file : undefined;
}

/** One asset as a member of its library sees it: versions, transcript, folders, and its current version's jobs. `user`: the admin also gets sourcePath. */
export function assetDetail(libraryId: string, assetId: string, user?: Pick<SessionUser, "role">): AssetDetail | null {
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
  const shots = stretchesOf(db(), row.version_id)
    .filter((s) => s.text)
    .map((s) => ({ seg: s.seg, a: s.a, b: s.b, text: s.text, source: s.source }));
  return {
    ...toCard(row),
    versions,
    collections,
    jobs,
    ...(t ? { transcript: { provider: t.provider, segments: segmentsOf(db(), row.version_id) } } : {}),
    ...(shots.length ? { shots } : {}),
    ...((p) => (p ? { sourcePath: p } : {}))(sourcePathFor(libraryId, row.version_id, user)),
  };
}

// GET /api/library/:id/search?q&collectionId&kind&f.<key> → SearchHit[], best first: full text, fused with the chunks
// close in meaning when semantic search is on. Hits the viewer may not see are left out. While search by meaning is
// still getting ready (its model fetched the first time), the hits are by words and X-Search-Meaning says getting-ready.
searchApp.get("/:id/search", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  const viewer = await readerOf(user.username, libraryId);
  if (!viewer) return notFound(c);
  const q = (c.req.query("q") ?? "").trim().slice(0, 200);
  if (!q) return c.json({ error: "Type something to search for", code: "invalid" }, 400);
  const query = parseSearch(c.req.query());
  const { roll } = query;
  // footage only, by text and by meaning (query.ts FINISHED)
  const where = [...searchClauses(query), { sql: `NOT ${FINISHED}`, params: [] }];
  const text = searchLibrary(libraryId, q, LIMIT, where);
  const meaning = await semanticHits(libraryId, q, user.username, where).catch(() => null);
  const hits = meaning ? rrf([text, meaning], hitKey).slice(0, 2 * LIMIT) : text;
  if (!meaning && meaningGettingReady(libraryId, user.username)) c.header("X-Search-Meaning", "getting-ready");
  const seen = await visibleCards(viewer, libraryId, hits.map((h) => h.asset));
  const shown = new Set(seen.map((a) => a.id));
  return c.json(hits.filter((h) => shown.has(h.asset.id) && (!roll || h.asset.roll === roll))); // ponytail: narrowed after the top hits
});

// GET /api/library/:id/tags → { tags: [{ tag, count }] }: every tag on a clip in the library (not in the trash), most used
// first, for the tag filter and the clip window's suggestions.
// ponytail: counted over the whole library, not per viewer's policies; a plug-in that hides clips hides the whole library
searchApp.get("/:id/tags", async (c) => {
  const libraryId = c.req.param("id");
  if (!(await readerOf(c.get("user").username, libraryId))) return notFound(c);
  const tags = db()
    .prepare(
      `SELECT t.tag, COUNT(*) AS count FROM asset_tags t JOIN assets a ON a.id = t.asset_id
       WHERE a.library_id = ? AND a.trashed_at IS NULL AND NOT ${FINISHED} GROUP BY t.tag ORDER BY count DESC, t.tag LIMIT 500`,
    )
    .all(libraryId) as { tag: string; count: number }[];
  return c.json({ tags });
});

// GET /api/library/:id/places → { places: [{ place, count }] }: the countries clips were filmed in, most clips first, for
// the Where filter. ponytail: the whole library, as /tags above
searchApp.get("/:id/places", async (c) => {
  const libraryId = c.req.param("id");
  if (!(await readerOf(c.get("user").username, libraryId))) return notFound(c);
  const places = db()
    .prepare(
      `SELECT json_extract(v.probe, '$.country') AS place, COUNT(*) AS count FROM assets a JOIN asset_versions v ON v.id = a.current_version_id
       WHERE a.library_id = ? AND a.trashed_at IS NULL AND NOT ${FINISHED} AND place != '' GROUP BY place ORDER BY count DESC, place`,
    )
    .all(libraryId) as { place: string; count: number }[];
  return c.json({ places });
});

// GET /api/library/:id/assets/:assetId → AssetDetail (404 for a viewer the policies refuse)
searchApp.get("/:id/assets/:assetId", async (c) => {
  const libraryId = c.req.param("id");
  const viewer = await readerOf(c.get("user").username, libraryId);
  if (!viewer) return notFound(c);
  const detail = assetDetail(libraryId, c.req.param("assetId"), c.get("user"));
  if (!detail || !(await canSee(viewer, assetRef(libraryId, detail.id, detail.versionId)))) return notFound(c);
  if (detail.state === "processing") prepareFirst(detail.versionId); // opened while it is prepared: it goes first (worker.ts)
  return c.json(detail);
});

// a look on one clip, asked for by name: never a whole library's (bulk.ts has no look)
const RERUN = new Set(["transcribe", "describe", "look", "fingerprint", "embed"]);

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

// PATCH /api/library/:id/assets/:assetId { title?, tags?, description?, turn? }: the uploader or the owner.
// `turn`: clockwise degrees to show the clip upright (0, 90, 180, 270; turn.ts), set on its current version.
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
  const b = (await c.req.json().catch(() => null)) as { title?: unknown; tags?: unknown; aiTags?: unknown; description?: unknown; turn?: unknown } | null;
  const title = typeof b?.title === "string" ? b.title.trim().slice(0, 160) : undefined;
  const tags = Array.isArray(b?.tags)
    ? [...new Set(b.tags.filter((t): t is string => typeof t === "string").map((t) => t.trim().slice(0, 80)).filter(Boolean))].slice(0, 50)
    : undefined;
  // a tag the AI gave, put back by an undo, stays the AI's
  const aiTags = new Set(Array.isArray(b?.aiTags) ? b.aiTags.filter((t): t is string => typeof t === "string") : []);
  const description = typeof b?.description === "string" ? b.description.trim().slice(0, 4000) : undefined;
  const turn = typeof b?.turn === "number" && Number.isFinite(b.turn) ? b.turn : undefined;
  if (title === "" || (title === undefined && tags === undefined && description === undefined && turn === undefined))
    return c.json({ error: "Send a title, tags, a description or a turn", code: "invalid" }, 400);
  const d = db();
  if (turn !== undefined) await turnVersion(d, a.current_version_id, turn);
  d.exec("BEGIN");
  try {
    if (title) d.prepare("UPDATE assets SET title = ? WHERE id = ?").run(title, assetId);
    if (tags) {
      d.prepare(`DELETE FROM asset_tags WHERE asset_id = ? AND tag NOT IN (SELECT value FROM json_each(?))`).run(assetId, JSON.stringify(tags));
      const add = d.prepare("INSERT OR IGNORE INTO asset_tags (asset_id, tag, source) VALUES (?, ?, ?)");
      for (const t of tags) add.run(assetId, t, aiTags.has(t) ? "ai" : "user");
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
  return c.json(assetDetail(libraryId, assetId, user));
});

// PATCH /api/library/:id/assets/:assetId/shots/:seg { text } → AssetDetail: the person's own line for one shot of the
// current version, which wins over the AI's; empty removes it and the AI's shows again. Who may edit the clip may edit it.
searchApp.patch("/:id/assets/:assetId/shots/:seg", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  const assetId = c.req.param("assetId");
  const a = libraryRole(user.username, libraryId)
    ? (db().prepare("SELECT current_version_id FROM assets WHERE id = ? AND library_id = ? AND trashed_at IS NULL").get(assetId, libraryId) as { current_version_id: string | null } | undefined)
    : undefined;
  if (!a?.current_version_id || !(await mayWrite(user.username, libraryId, assetId, a.current_version_id))) return notFound(c);
  const seg = Number(c.req.param("seg"));
  const b = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
  if (!Number.isSafeInteger(seg) || seg < 0 || typeof b?.text !== "string") return c.json({ error: "Send the line's text", code: "invalid" }, 400);
  if (!setUserLine(db(), a.current_version_id, seg, b.text)) return notFound(c);
  return c.json(assetDetail(libraryId, assetId, user));
});

/**
 * A version another computer reads (the studio's worker, a Mac with the file), for the two routes below: the caller
 * must be allowed to change the clip. Null: not found for them.
 */
async function writableVersion(c: Ctx): Promise<{ versionId: string; duration: number } | null> {
  const user = c.get("user");
  const libraryId = c.req.param("id") ?? "";
  const versionId = c.req.param("versionId") ?? "";
  const v = libraryRole(user.username, libraryId)
    ? (db()
        .prepare("SELECT a.id AS asset_id, a.kind, v.probe FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ? AND a.library_id = ? AND a.trashed_at IS NULL")
        .get(versionId, libraryId) as { asset_id: string; kind: string; probe: string | null } | undefined)
    : undefined;
  if (!v || v.kind !== "video" || !(await mayWrite(user.username, libraryId, v.asset_id, versionId))) return null;
  return { versionId, duration: Number((JSON.parse(v.probe ?? "null") as { duration?: number } | null)?.duration) || 0 };
}

// POST /api/library/:id/versions/:versionId/picture PictureSignal → { stretches: [{ seg, a, b, motion }] }: a video's
// picture read on another computer (look.ts readPicture's numbers). The server finds the stretches the way it does for
// a file it reads itself (shotsOf), stores them with no line yet (the AI's earlier rows go; the person's own lines
// stay) and answers with them, so the other computer makes the sheets and the lines (…/stretches).
searchApp.post("/:id/versions/:versionId/picture", async (c) => {
  const v = await writableVersion(c);
  if (!v) return notFound(c);
  const x = parseSignal(await c.req.json().catch(() => null));
  if (typeof x === "string") return c.json({ error: x, code: "invalid" }, 400);
  return c.json({ stretches: takeSignal(db(), v.versionId, v.duration, x) });
});

// POST /api/library/:id/versions/:versionId/stretches StretchLines → { saved }: the lines another computer's look wrote
// for the stretches …/picture answered with, under the context stamp it was given. Each is checked and capped as the
// server's own (look.ts ratedLine); a line for a stretch the version doesn't have is left out.
searchApp.post("/:id/versions/:versionId/stretches", async (c) => {
  const v = await writableVersion(c);
  if (!v) return notFound(c);
  const b = (await c.req.json().catch(() => null)) as Partial<StretchLines> | null;
  if (typeof b?.stamp !== "string" || !/^[\w.-]{1,64}$/.test(b.stamp)) return c.json({ error: "Send the stamp the lines were written under", code: "invalid" }, 400);
  if (!Array.isArray(b.lines) || b.lines.length > MAX_SIGNAL_FRAMES) return c.json({ error: "Send the lines", code: "invalid" }, 400);
  const lines: StretchLine[] = [];
  for (const l of b.lines as unknown[]) {
    const o = (l ?? {}) as Record<string, unknown>;
    const line = ratedLine(o);
    if (!line || !Number.isSafeInteger(o.seg) || (o.seg as number) < 0) continue;
    const ph = typeof o.ph === "string" && /^[0-9a-f]{16}$/i.test(o.ph) ? o.ph.toLowerCase() : undefined;
    lines.push({ seg: o.seg as number, ...line, ...(ph ? { ph } : {}) });
  }
  return c.json({ saved: storeLines(db(), v.versionId, b.stamp, lines) });
});

const opening = new Map<string, Promise<string>>();

// POST /api/library/:id/assets/:assetId/captions → { projectId }: a new Caption Studio project on the current version
// ponytail: a new project on every open; remember one per (version, account) when people open the same clip often
searchApp.post("/:id/assets/:assetId/captions", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  const viewer = viewerOf(user.username, libraryId); // the owner's: a Caption Studio project reads the clip's file as its own
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
      const [{ createProjectFromFile }, { currentWorkspaceId }] = await Promise.all([import("../projects"), import("../lib/workspace-scope")]);
      const created = await createProjectFromFile({
        owner: user.username,
        name: row.title,
        clipName: row.title,
        file,
        duration: Number((JSON.parse(row.probe ?? "{}") as { duration?: number }).duration) || 0,
        libraryVersionId: row.version_id,
        // ponytail: the window's workspace; inherit the clip's own once Media Library items carry one
        workspace: await currentWorkspaceId(user),
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
