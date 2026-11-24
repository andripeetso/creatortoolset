import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import type { AuthVars } from "../auth";
import type { AssetKind, Collection, Piece, PieceItem, Posting, SearchQuery } from "../../contracts/library";
import type { LibraryViewer } from "../../contracts/library-source";
import { env } from "../lib/env";
import { sendFile } from "../lib/send-file";
import { storedZip } from "../lib/workshop/deliveries";
import { notifyLibraryChanges } from "../lib/events";
import { sweepPlayCopies } from "../lib/play-copies";
import { isFinal } from "./finals";
import { pushFinalCopy } from "./routes";
import { libraryRole, mayWrite } from "./access";
import { readerOf } from "./reader";
import { mayKeepAsFilmed, mayLeave, mayServe, type Received } from "./upload-gate";
import { blobs, libraryDb } from "./db";
import { frameAt, frameWaits, whenFramed, type FrameInput } from "../lib/clip-frame";
import { externalCanSee, externalRefById } from "./refs";
import { FINISHED, KINDS } from "./query";
import { assetRef, canSee } from "./sources";
import { fileRoll, rollFolder, rollOf, sortRoll } from "./roll";
import { workspaceIdOf } from "./describe";
import { workspaceContext } from "../lib/workshop/context";
import { canJudge, isSorting, LABEL as SMART_LABEL, ruleOf, sortFolder, suggestWays } from "./smart";

/**
 * Folders and collections (tasks/media-library-plan.md, sections 2, 7 and 9). One table: a folder is a collection with
 * a parent. A manual collection holds asset ids; a smart one keeps a saved SearchQuery and runs it on every read.
 * Only the library's owner writes: collections, their items and pieces. A grant (grants.ts) lets an account see one
 * collection, not change it. Outsiders and granted accounts get 404.
 * Pieces (migration 6, the bottom of this file) sit beside them: a group of versions with one winner, for Finals.
 */

export const collectionApp = new Hono<{ Variables: AuthVars }>();
collectionApp.use("*", notifyLibraryChanges);
type Ctx = Context<{ Variables: AuthVars }>;

interface Row {
  id: string;
  library_id: string;
  parent_id: string | null;
  name: string;
  kind: "manual" | "smart";
  query: string | null;
  created_by: string;
  position?: number | null;
  rule?: string | null;
  shoot?: string | null;
  blur?: string | null;
}

const db = () => libraryDb();
const notFound = (c: Ctx) => c.json({ error: "Not found", code: "not_found" }, 404);
const rowIn = (libraryId: string, cid: string) =>
  db().prepare("SELECT * FROM collections WHERE id = ? AND library_id = ?").get(cid, libraryId) as Row | undefined;
const nameOf = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 80) : "");

/** A smart collection's saved query: the search fields only, so no paging, trash or collection inside it. */
export function savedQuery(raw: unknown): SearchQuery {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const kind = Array.isArray(r.kind) ? r.kind.filter((k): k is AssetKind => KINDS.includes(k as AssetKind)) : [];
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const q = typeof r.q === "string" ? r.q.trim().slice(0, 200) : "";
  const tag = typeof r.tag === "string" ? r.tag.slice(0, 80) : "";
  const from = num(r.from);
  const to = num(r.to);
  return {
    ...(q ? { q } : {}),
    ...(kind.length ? { kind } : {}),
    ...(tag ? { tag } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(r.roll === "a" || r.roll === "b" ? { roll: r.roll } : {}),
    ...(Array.isArray(r.tags) ? { tags: r.tags.filter((t): t is string => typeof t === "string").map((t) => t.slice(0, 80)).slice(0, 20) } : {}),
    ...(num(r.filmedFrom) !== undefined ? { filmedFrom: num(r.filmedFrom) } : {}),
    ...(num(r.filmedTo) !== undefined ? { filmedTo: num(r.filmedTo) } : {}),
    ...(typeof r.place === "string" && /^[A-Z]{2}$/.test(r.place) ? { place: r.place } : {}),
    ...(r.orientation === "vertical" || r.orientation === "horizontal" ? { orientation: r.orientation } : {}),
    ...(r.unfiled === true ? { unfiled: true } : {}),
  };
}

/**
 * A listing narrowed to a collection. A manual one filters by membership (buildAssetQuery); a smart one runs its saved
 * query, and filters on the request narrow it. Null: the collection is not in this library.
 */
export function expandCollection(libraryId: string, query: SearchQuery): SearchQuery | null {
  if (!query.collectionId) return query;
  const col = rowIn(libraryId, query.collectionId);
  if (!col) return null;
  return col.kind === "smart" ? { ...savedQuery(JSON.parse(col.query ?? "{}")), ...query, collectionId: undefined } : query;
}

const toCollection = (r: Row, count?: number, covers?: string[], sounds?: string[]): Collection => ({
  id: r.id,
  name: r.name,
  parentId: r.parent_id,
  kind: r.kind,
  createdBy: r.created_by,
  ...(r.kind === "smart" ? { query: savedQuery(JSON.parse(r.query ?? "{}")) } : {}),
  ...(r.rule ? { rule: r.rule, ...(isSorting(r.id) ? { sorting: true } : {}) } : {}),
  ...(r.blur === "no" ? { blur: "no" as const } : {}),
  ...(count !== undefined ? { count } : {}),
  ...(covers?.length ? { covers } : {}),
  ...(sounds?.length ? { sounds } : {}),
});

/** The ids of the folders `start` (SQL giving folder ids) names and every folder inside them, at any depth. */
const under = (start: string) =>
  `(WITH RECURSIVE sub(id) AS (${start} UNION SELECT k.id FROM collections k JOIN sub ON k.parent_id = sub.id) SELECT id FROM sub)`;

/** The clips the A-roll or B-roll folder holds: filed as its roll, or in a folder inside it (owner, 2026-11-22: its
 * count is all of them). Params: the roll, the library id, the roll. */
const IN_ROLL = `(a.roll = ? OR a.id IN (SELECT asset_id FROM collection_items WHERE collection_id IN ${under(
  "SELECT id FROM collections WHERE library_id = ? AND kind = 'smart' AND json_extract(query, '$.roll') = ? AND (SELECT COUNT(*) FROM json_each(query)) = 1",
)}))`;

// GET /api/library/:id/collections → every folder and collection, flat; the client nests them by parentId. A folder's
// card shows up to four pictures of its clips (the media route checks each viewer, as it does for the grid)
collectionApp.get("/:id/collections", async (c) => {
  const libraryId = c.req.param("id");
  if (!(await readerOf(c.get("user").username, libraryId))) return notFound(c);
  const rows = db()
    .prepare(
      // a folder counts the clips in the folders inside it too (owner, 2026-11-22: "A-roll should show the total count")
      `SELECT c.*, (SELECT COUNT(DISTINCT i.asset_id) FROM collection_items i JOIN assets a ON a.id = i.asset_id
          WHERE i.collection_id IN ${under("SELECT c.id")}
            AND a.trashed_at IS NULL AND a.left_hidden_at IS NULL AND NOT ${FINISHED}) AS n
       FROM collections c WHERE c.library_id = ? ORDER BY c.position IS NULL, c.position, c.created_at, c.id`,
    )
    .all(libraryId) as unknown as (Row & { n: number })[];
  const pictures = db().prepare(
    `SELECT DISTINCT a.current_version_id AS v FROM collection_items i JOIN assets a ON a.id = i.asset_id
     WHERE i.collection_id IN ${under("SELECT ?")}
       AND a.trashed_at IS NULL AND a.left_hidden_at IS NULL AND NOT ${FINISHED}
       AND EXISTS (SELECT 1 FROM derivatives d WHERE d.version_id = a.current_version_id AND d.kind = 'thumb')
     ORDER BY i.collection_id <> ?, i.position, i.asset_id LIMIT 4`,
  );
  // a folder of songs or sounds has no pictures: its card names a few of them instead
  const soundRows = db().prepare(
    `SELECT a.title FROM collection_items i JOIN assets a ON a.id = i.asset_id
     WHERE i.collection_id = ? AND a.trashed_at IS NULL AND a.left_hidden_at IS NULL AND a.kind = 'audio' ORDER BY i.position, i.asset_id LIMIT 3`,
  );
  // the A-roll and B-roll folders list their roll: their count and pictures are the roll's and their folders'
  const rollCount = db().prepare(`SELECT COUNT(*) AS n FROM assets a WHERE a.library_id = ? AND ${IN_ROLL} AND a.trashed_at IS NULL AND a.left_hidden_at IS NULL AND NOT ${FINISHED}`);
  const rollPictures = db().prepare(
    `SELECT a.current_version_id AS v FROM assets a WHERE a.library_id = ? AND ${IN_ROLL} AND a.trashed_at IS NULL AND a.left_hidden_at IS NULL AND NOT ${FINISHED}
       AND EXISTS (SELECT 1 FROM derivatives d WHERE d.version_id = a.current_version_id AND d.kind = 'thumb')
     ORDER BY a.created_at DESC, a.id LIMIT 4`,
  );
  const thumbs = (vs: { v: string }[]) => vs.map((p) => `/api/library/media/${p.v}/thumb`);
  return c.json({
    collections: rows.map((r) => {
      if (r.kind === "manual") {
        const covers = thumbs(pictures.all(r.id, r.id) as { v: string }[]);
        return toCollection(r, r.n, covers, covers.length ? undefined : (soundRows.all(r.id) as { title: string }[]).map((x) => x.title));
      }
      const roll = rollOf(r.query);
      if (!roll) return toCollection(r);
      return toCollection(r, (rollCount.get(libraryId, roll, libraryId, roll) as { n: number }).n, thumbs(rollPictures.all(libraryId, roll, libraryId, roll) as { v: string }[]));
    }),
  });
});

// is `cid` the same as `parent` or somewhere above it? (a folder can't move inside itself)
function isAbove(parent: string | null, cid: string): boolean {
  for (let p = parent; p !== null; ) {
    if (p === cid) return true;
    p = (db().prepare("SELECT parent_id FROM collections WHERE id = ?").get(p) as { parent_id: string | null } | undefined)?.parent_id ?? null;
  }
  return false;
}

/** The context of the workspace the library is in (describe.ts workspaceOf), "" when it has no clip to read it from yet. */
async function libraryWorkspace(libraryId: string): Promise<string> {
  const v = db().prepare("SELECT current_version_id AS v FROM assets WHERE library_id = ? AND current_version_id IS NOT NULL LIMIT 1").get(libraryId) as { v: string } | undefined;
  const ws = v ? await workspaceIdOf(db(), v.v) : undefined;
  return ws ? workspaceContext(ws, 6000) : "";
}

const NO_JUDGE = "Smart folders need an AI to sort with: add one in Settings → AI, or a TypeSafe Jev key in Settings → Keys";

/** A smart folder's rule was saved: the library is sorted against it in the background, as `user`. */
const startSort = (libraryId: string, folderId: string, user: Parameters<typeof sortFolder>[2]) =>
  void sortFolder(libraryId, folderId, user, libraryWorkspace(libraryId)).catch((e) => console.error(`[library] ${SMART_LABEL}: ${e instanceof Error ? e.message : e}`));

// POST /api/library/:id/collections/suggest → { ways, about }: Reorganize, two or three ways to sort the library into
// smart folders, each folder with its rule and how many clips would go in it (smart.ts). Nothing is made here
collectionApp.post("/:id/collections/suggest", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  if (!libraryRole(user.username, libraryId)) return notFound(c);
  try {
    return c.json(await suggestWays(libraryId, user, await libraryWorkspace(libraryId)));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e), code: "conflict" }, 409);
  }
});

// POST /api/library/:id/collections { name, parentId?, kind?: manual | smart, query?, rule? } → 201 Collection (any member)
collectionApp.post("/:id/collections", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  if (!libraryRole(user.username, libraryId)) return notFound(c);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const name = nameOf(body?.name);
  if (!name) return c.json({ error: "A name is needed", code: "invalid" }, 400);
  const parent = typeof body?.parentId === "string" ? body.parentId : null;
  if (parent && !rowIn(libraryId, parent)) return notFound(c);
  const kind = body?.kind === "smart" ? "smart" : "manual";
  const query = kind === "smart" ? JSON.stringify(savedQuery(body?.query)) : null;
  // a rule (smart.ts) is a plain folder's: a saved search fills itself
  const rule = kind === "manual" ? ruleOf(body?.rule) : null;
  if (rule && !canJudge(user)) return c.json({ error: NO_JUDGE, code: "needs_key" }, 409);
  const id = `col_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  db()
    .prepare("INSERT INTO collections (id, library_id, parent_id, name, kind, query, created_at, created_by, rule) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, libraryId, parent, name, kind, query, Date.now(), user.username, rule);
  if (rule) startSort(libraryId, id, user);
  return c.json(toCollection({ id, library_id: libraryId, parent_id: parent, name, kind, query, created_by: user.username, rule }, kind === "manual" ? 0 : undefined), 201);
});

// PATCH /api/library/:id/collections/:cid { name?, parentId?, rule? } → rename, move, or a plain folder's rule (smart.ts:
// a string sorts the library into it again; null stops, and the clips the AI filed there leave it)
collectionApp.patch("/:id/collections/:cid", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  const role = libraryRole(user.username, libraryId);
  const row = role ? rowIn(libraryId, c.req.param("cid")) : undefined;
  if (!role || !row) return notFound(c);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const name = body?.name === undefined ? row.name : nameOf(body.name);
  if (!name) return c.json({ error: "A name is needed", code: "invalid" }, 400);
  let parent = row.parent_id;
  if (body?.parentId !== undefined) {
    parent = typeof body.parentId === "string" ? body.parentId : null;
    if (parent && !rowIn(libraryId, parent)) return notFound(c);
    if (isAbove(parent, row.id)) return c.json({ error: "A folder can't go inside itself", code: "conflict" }, 409);
  }
  let rule = row.rule ?? null;
  if (body?.rule !== undefined) {
    if (row.kind !== "manual" || rollFolder(db(), libraryId, row.id)) return c.json({ error: "Only a plain folder can have a rule", code: "conflict" }, 409);
    rule = ruleOf(body.rule);
    if (rule && !canJudge(user)) return c.json({ error: NO_JUDGE, code: "needs_key" }, 409);
  }
  // Blur faces off for the folder: its clips are kept as filmed (the owner's or an admin's call, as for one file)
  let blur = row.blur ?? null;
  if (body?.blur !== undefined) {
    if (body.blur !== "no" && body.blur !== null) return c.json({ error: "blur is no or null", code: "invalid" }, 400);
    if (!mayKeepAsFilmed(user.username, libraryId)) return notFound(c);
    blur = body.blur;
  }
  db().prepare("UPDATE collections SET name = ?, parent_id = ?, rule = ?, blur = ? WHERE id = ?").run(name, parent, rule, blur, row.id);
  if (body?.rule !== undefined && rule !== (row.rule ?? null)) startSort(libraryId, row.id, user);
  return c.json(toCollection({ ...row, name, parent_id: parent, rule, blur }));
});

// PUT /api/library/:id/collections/order { ids } → the folders in this order (the tabs dragged into place; owner only).
// Ids from another library are left out; folders not named keep their place after these
collectionApp.put("/:id/collections/order", async (c) => {
  const libraryId = c.req.param("id");
  if (!libraryRole(c.get("user").username, libraryId)) return notFound(c);
  const body = (await c.req.json().catch(() => null)) as { ids?: unknown } | null;
  if (!Array.isArray(body?.ids) || !body.ids.every((x) => typeof x === "string")) return c.json({ error: "ids are needed", code: "invalid" }, 400);
  const set = db().prepare("UPDATE collections SET position = ? WHERE id = ? AND library_id = ?");
  inTx(() => (body.ids as string[]).forEach((id, i) => set.run(i, id, libraryId)));
  return c.json({ ok: true });
});

// DELETE /api/library/:id/collections/:cid → gone, its items kept in the library, its folders move up one level. What it
// was is kept a little while for POST .../restore (the page's Undo).
collectionApp.delete("/:id/collections/:cid", (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  const role = libraryRole(user.username, libraryId);
  const row = role ? rowIn(libraryId, c.req.param("cid")) : undefined;
  if (!role || !row) return notFound(c);
  const d = db();
  d.exec("BEGIN");
  try {
    const kept: Deleted = {
      row: d.prepare("SELECT * FROM collections WHERE id = ?").get(row.id) as Record<string, string | number | null>,
      items: d.prepare("SELECT * FROM collection_items WHERE collection_id = ?").all(row.id) as Record<string, string | number | null>[],
      grants: d.prepare("SELECT * FROM library_grants WHERE collection_id = ?").all(row.id) as Record<string, string | number | null>[],
      children: (d.prepare("SELECT id FROM collections WHERE parent_id = ?").all(row.id) as { id: string }[]).map((r) => r.id),
      pieces: (d.prepare("SELECT id FROM pieces WHERE collection_id = ?").all(row.id) as { id: string }[]).map((r) => r.id),
      at: Date.now(),
    };
    d.prepare("UPDATE collections SET parent_id = ? WHERE parent_id = ?").run(row.parent_id, row.id);
    d.prepare("DELETE FROM collection_items WHERE collection_id = ?").run(row.id);
    d.prepare("DELETE FROM collections WHERE id = ?").run(row.id);
    d.exec("COMMIT");
    for (const [id, k] of deleted) if (Date.now() - k.at > RESTORE_MS) deleted.delete(id);
    deleted.set(row.id, kept);
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
  return c.json({ ok: true });
});

/** A folder deleted moments ago, as it was: put back by POST .../restore. */
interface Deleted {
  row: Record<string, string | number | null>;
  items: Record<string, string | number | null>[];
  grants: Record<string, string | number | null>[];
  children: string[];
  pieces: string[];
  at: number;
}
// ponytail: in memory, so a restart forgets them; the Undo that reads it lasts seconds
const deleted = new Map<string, Deleted>();
const RESTORE_MS = 10 * 60_000;

const insertRow = (d: ReturnType<typeof db>, table: string, r: Record<string, string | number | null>) => {
  const cols = Object.keys(r);
  d.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...Object.values(r));
};

// POST /api/library/:id/collections/:cid/restore → the folder deleted moments ago back as it was: its id (links and
// shares to it work again), its clips still in the library, its folders that have not moved since, its grants
collectionApp.post("/:id/collections/:cid/restore", (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  const kept = deleted.get(c.req.param("cid"));
  if (!libraryRole(user.username, libraryId) || !kept || kept.row.library_id !== libraryId || Date.now() - kept.at > RESTORE_MS) return notFound(c);
  const d = db();
  // a parent deleted since then: it comes back at the top
  const parent = kept.row.parent_id && rowIn(libraryId, String(kept.row.parent_id)) ? kept.row.parent_id : null;
  d.exec("BEGIN");
  try {
    insertRow(d, "collections", { ...kept.row, parent_id: parent });
    const live = d.prepare("SELECT 1 FROM assets WHERE id = ? AND library_id = ?");
    for (const i of kept.items) if (live.get(i.asset_id, libraryId)) insertRow(d, "collection_items", i);
    for (const g of kept.grants) insertRow(d, "library_grants", g);
    const back = d.prepare("UPDATE collections SET parent_id = ? WHERE id = ? AND library_id = ? AND parent_id IS ?");
    for (const id of kept.children) back.run(kept.row.id, id, libraryId, parent);
    const piece = d.prepare("UPDATE pieces SET collection_id = ? WHERE id = ? AND collection_id IS NULL");
    for (const id of kept.pieces) piece.run(kept.row.id, id);
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
  deleted.delete(String(kept.row.id));
  return c.json(toCollection(rowIn(libraryId, String(kept.row.id))!));
});

// GET /api/library/:id/counts → { a, b, image, video }: the clips sorted A-roll and B-roll, the photos and the videos, for the tabs.
// ponytail: counted over the whole library, as /tags is, not per viewer's policies
collectionApp.get("/:id/counts", (c) => {
  const libraryId = c.req.param("id");
  if (!libraryRole(c.get("user").username, libraryId)) return notFound(c);
  const r = db()
    .prepare(
      `SELECT SUM(${IN_ROLL} AND NOT ${FINISHED}) AS a, SUM(${IN_ROLL} AND NOT ${FINISHED}) AS b, SUM(a.kind = 'image' AND NOT ${FINISHED}) AS image,
              SUM(a.kind = 'video' AND NOT ${FINISHED}) AS video
       FROM assets a WHERE a.library_id = ? AND a.trashed_at IS NULL AND a.left_hidden_at IS NULL`,
    )
    .get("a", libraryId, "a", "b", libraryId, "b", libraryId) as { a: number | null; b: number | null; image: number | null; video: number | null };
  return c.json({ a: r.a ?? 0, b: r.b ?? 0, image: r.image ?? 0, video: r.video ?? 0 });
});

// POST / DELETE /api/library/:id/collections/:cid/items { assetIds } → add or remove (manual collections; on an A-roll or
// B-roll folder: filed as that roll, or filed as nothing again)
collectionApp.post("/:id/collections/:cid/items", (c) => changeItems(c, true));
collectionApp.delete("/:id/collections/:cid/items", (c) => changeItems(c, false));

/** The most clips one request puts in a folder or takes out. */
export const FOLDER_ITEMS_MAX = 5000;

async function changeItems(c: Ctx, add: boolean) {
  const user = c.get("user");
  const libraryId = c.req.param("id") ?? "";
  if (!libraryRole(user.username, libraryId)) return notFound(c);
  const row = rowIn(libraryId, c.req.param("cid") ?? "");
  if (!row) return notFound(c);
  const roll = rollFolder(db(), libraryId, row.id);
  if (row.kind !== "manual" && !roll) return c.json({ error: "Clips cannot be moved into a saved search", code: "conflict" }, 409);
  const body = (await c.req.json().catch(() => null)) as { assetIds?: unknown } | null;
  const asked = Array.isArray(body?.assetIds) ? body.assetIds.filter((x): x is string => typeof x === "string") : [];
  if (!asked.length) return c.json({ error: "No assets given", code: "invalid" }, 400);
  // all of them or none: a longer list is refused out loud, never cut short
  if (asked.length > FOLDER_ITEMS_MAX) return c.json({ error: `At most ${FOLDER_ITEMS_MAX} clips at a time`, code: "invalid" }, 400);
  // only the assets the policies let this account change; the rest are skipped, as trashed or foreign ones are
  const ids = await writableAssets(user.username, libraryId, asked);
  const d = db();
  if (roll) {
    // the A-roll folder lists the clips sorted or filed as A-roll: a clip put in it is filed so (roll.ts)
    const video = d.prepare("SELECT 1 FROM assets WHERE id = ? AND library_id = ? AND trashed_at IS NULL AND left_hidden_at IS NULL AND kind = 'video'");
    const filed = ids.filter((id) => video.get(id, libraryId));
    if (!add) {
      // taken back out (the page's Undo): filed as nothing, and the sort decides again from what the clip has
      const current = d.prepare("SELECT current_version_id AS v FROM assets WHERE id = ? AND filed_roll = ?");
      let removed = 0;
      for (const id of filed) {
        const was = current.get(id, roll) as { v: string } | undefined;
        if (!was) continue;
        d.prepare("UPDATE assets SET filed_roll = NULL, roll = NULL WHERE id = ?").run(id);
        sortRoll(d, was.v);
        removed++;
      }
      return c.json({ removed });
    }
    // finished work, Review's videos and what is not a video are skipped (fileRoll): only the ones filed are counted
    const now = d.prepare("SELECT 1 FROM assets WHERE id = ? AND filed_roll = ?");
    let added = 0;
    for (const id of filed) {
      fileRoll(d, id, roll);
      if (now.get(id, roll)) added++;
    }
    return c.json({ added });
  }
  if (!add) {
    const del = d.prepare("DELETE FROM collection_items WHERE collection_id = ? AND asset_id = ?");
    // taken out of a smart folder or a shoot's folder by hand: never filed there again (smart.ts, shoots.ts)
    const out = d.prepare("INSERT OR IGNORE INTO folder_out (collection_id, asset_id) VALUES (?, ?)");
    let removed = 0;
    for (const id of ids) {
      const n = del.run(row.id, id).changes as number;
      if (n && (row.rule || row.shoot)) out.run(row.id, id);
      removed += n;
    }
    return c.json({ removed });
  }
  // put in by hand: the person's, whatever the rule says
  const mine = d.prepare("UPDATE collection_items SET by_ai = 0 WHERE collection_id = ? AND asset_id = ?");
  const back = d.prepare("DELETE FROM folder_out WHERE collection_id = ? AND asset_id = ?");
  // added at the end, in the order given; trashed or foreign assets are skipped
  const ok = d.prepare("SELECT 1 FROM assets WHERE id = ? AND library_id = ? AND trashed_at IS NULL AND left_hidden_at IS NULL");
  const ins = d.prepare("INSERT OR IGNORE INTO collection_items (collection_id, asset_id, position, added_by) VALUES (?, ?, ?, ?)");
  let pos = (d.prepare("SELECT COALESCE(MAX(position), 0) AS p FROM collection_items WHERE collection_id = ?").get(row.id) as { p: number }).p;
  let added = 0;
  for (const id of ids) {
    if (!ok.get(id, libraryId)) continue;
    pos += 1;
    added += ins.run(row.id, id, pos, user.username).changes as number;
    mine.run(row.id, id);
    back.run(row.id, id);
  }
  return c.json({ added });
}

/*
 * Pieces (schema migration 6). A piece's items are versions of this library (a trashed one is left out of the read);
 * an item with an external ref has no version and is only written by its source. Postings and the post description
 * belong to the item. Access is the same as for folders: any account the library is its own.
 */

interface PieceRow {
  id: string;
  library_id: string;
  collection_id: string | null;
  label: string;
  created_by: string;
  cover_key: string | null;
  cover_version_id: string | null;
  cover_at: number | null;
  trashed_at?: number | null;
  /** merged into another piece: JSON { into, items } for Undo (unmerge) */
  merged?: string | null;
}
interface ItemRow {
  id: string;
  piece_id: string;
  version_id: string | null;
  external_ref: string | null;
  label: string | null;
  position: number;
  winner: number;
  post_description: string | null;
}
interface PostingRow {
  id: number;
  platform: string;
  url: string | null;
  posted_at: number;
  created_by: string;
}

const POST_LIMIT = 2200; // Instagram's caption limit: the longest post description kept
const pieceIn = (libraryId: string, pid: string) =>
  db().prepare("SELECT * FROM pieces WHERE id = ? AND library_id = ?").get(pid, libraryId) as PieceRow | undefined;
const itemIn = (pieceId: string, iid: string) =>
  db().prepare("SELECT * FROM piece_items WHERE id = ? AND piece_id = ?").get(iid, pieceId) as ItemRow | undefined;
const itemLabel = (v: unknown) => nameOf(v) || null;

/**
 * A piece the account may change: its library role, and the policies let it see every item (an item it may not see,
 * or an item with no version to check, refuses the whole piece). Every piece write goes through here.
 */
async function writablePiece(username: string, libraryId: string, pid: string): Promise<PieceRow | undefined> {
  if (!libraryRole(username, libraryId)) return undefined;
  const piece = pieceIn(libraryId, pid);
  if (!piece) return undefined;
  const items = db()
    .prepare(
      `SELECT i.version_id AS version_id, v.asset_id AS asset_id FROM piece_items i
       LEFT JOIN asset_versions v ON v.id = i.version_id WHERE i.piece_id = ?`,
    )
    .all(piece.id) as { version_id: string | null; asset_id: string | null }[];
  for (const i of items) {
    if (!i.version_id || !i.asset_id || !(await mayWrite(username, libraryId, i.asset_id, i.version_id))) return undefined;
  }
  return piece;
}

/** The ids of the library's assets the account may change: the policies see each one's current version. */
async function writableAssets(username: string, libraryId: string, ids: string[]): Promise<string[]> {
  const current = db().prepare("SELECT current_version_id AS version_id FROM assets WHERE id = ? AND library_id = ?");
  const out: string[] = [];
  for (const id of ids) {
    const cur = current.get(id, libraryId) as { version_id: string | null } | undefined;
    if (cur?.version_id && (await mayWrite(username, libraryId, id, cur.version_id))) out.push(id);
  }
  return out;
}

/** Runs `fn` as one transaction: its writes all land, or none do. */
function inTx(fn: () => void): void {
  const d = db();
  d.exec("BEGIN");
  try {
    fn();
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

/** Back to the automatic cover: the picked frame's row and its file go. */
async function dropCover(piece: PieceRow): Promise<PieceRow> {
  db().prepare("UPDATE pieces SET cover_key = NULL, cover_version_id = NULL, cover_at = NULL WHERE id = ?").run(piece.id);
  if (piece.cover_key) await blobs.delete(piece.cover_key).catch(() => {});
  return { ...piece, cover_key: null, cover_version_id: null, cover_at: null };
}

/** A piece as the API returns it: its live items in position order, each with its postings. */
function pieceOf(p: PieceRow): Piece {
  const items = db()
    .prepare(
      `SELECT i.* FROM piece_items i
         LEFT JOIN asset_versions v ON v.id = i.version_id
         LEFT JOIN assets a ON a.id = v.asset_id
       WHERE i.piece_id = ? AND (a.trashed_at IS NULL AND a.left_hidden_at IS NULL OR a.id IS NULL)
       ORDER BY i.position, i.id`,
    )
    .all(p.id) as unknown as ItemRow[];
  const postingsOf = db().prepare("SELECT id, platform, url, posted_at, created_by FROM postings WHERE piece_item_id = ? ORDER BY posted_at, id");
  return {
    id: p.id,
    label: p.label,
    collectionId: p.collection_id,
    createdBy: p.created_by,
    coverUrl: p.cover_at ? `/api/library/${p.library_id}/pieces/${p.id}/cover?v=${p.cover_at}` : null,
    items: items.map(
      (i): PieceItem => ({
        id: i.id,
        label: i.label,
        position: i.position,
        winner: i.winner === 1,
        versionId: i.version_id,
        externalRef: i.external_ref,
        postDescription: i.post_description,
        postings: (postingsOf.all(i.id) as unknown as PostingRow[]).map(
          (r): Posting => ({ id: r.id, platform: r.platform, url: r.url, postedAt: r.posted_at, createdBy: r.created_by }),
        ),
      }),
    ),
    ...(p.merged ? { merged: mergedOf(p.merged) } : {}),
  };
}

function mergedOf(json: string): Piece["merged"] {
  const was = JSON.parse(json) as Merged;
  const into = db().prepare("SELECT label FROM pieces WHERE id = ?").get(was.into) as { label: string } | undefined;
  return { into: into?.label ?? "", versions: was.items.length };
}

/**
 * A piece with only the items the viewer may see (sources.ts). An external ref is seen through its source's policy
 * (refs.ts), so it is left out until the source is registered with one.
 */
async function visibleItems(viewer: LibraryViewer, libraryId: string, p: Piece): Promise<Piece> {
  const items: PieceItem[] = [];
  for (const i of p.items) {
    if (i.externalRef) {
      const ref = externalRefById(i.externalRef);
      if (ref && (await externalCanSee(viewer, ref, libraryId))) items.push(i);
      continue;
    }
    const asset = i.versionId
      ? (db().prepare("SELECT a.id AS id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(i.versionId) as { id: string } | undefined)
      : undefined;
    if (asset && i.versionId && (await canSee(viewer, assetRef(libraryId, asset.id, i.versionId)))) items.push(i);
  }
  return { ...p, items };
}

// GET /api/library/:id/pieces[?collectionId=] → the library's pieces, or one collection's (Finals is one of these). A piece
// whose items the viewer may not see at all is left out, and so are the items they may not see.
collectionApp.get("/:id/pieces", async (c) => {
  const libraryId = c.req.param("id");
  const viewer = await readerOf(c.get("user").username, libraryId);
  if (!viewer) return notFound(c);
  const cid = c.req.query("collectionId") ?? null;
  const rows = db()
    .prepare("SELECT * FROM pieces WHERE library_id = ? AND (? IS NULL OR collection_id = ?) AND ((trashed_at IS NOT NULL) = ?) ORDER BY created_at, id")
    .all(libraryId, cid, cid, c.req.query("trash") === "1" ? 1 : 0) as unknown as PieceRow[];
  const pieces: Piece[] = [];
  for (const p of rows.map(pieceOf)) {
    const seen = await visibleItems(viewer, libraryId, p);
    if (seen.items.length || !p.items.length) pieces.push(seen);
  }
  return c.json({ pieces });
});

// POST /api/library/:id/pieces { label, collectionId? } → 201 Piece
collectionApp.post("/:id/pieces", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  if (!libraryRole(user.username, libraryId)) return notFound(c);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const label = nameOf(body?.label);
  if (!label) return c.json({ error: "A label is needed", code: "invalid" }, 400);
  const collectionId = typeof body?.collectionId === "string" ? body.collectionId : null;
  if (collectionId && !rowIn(libraryId, collectionId)) return notFound(c);
  const id = `pce_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  db()
    .prepare("INSERT INTO pieces (id, library_id, collection_id, label, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, libraryId, collectionId, label, user.username, Date.now());
  return c.json(
    pieceOf({ id, library_id: libraryId, collection_id: collectionId, label, created_by: user.username, cover_key: null, cover_version_id: null, cover_at: null }),
    201,
  );
});

// PATCH /api/library/:id/pieces/:pid { label?, collectionId? } → the piece
collectionApp.patch("/:id/pieces/:pid", async (c) => {
  const libraryId = c.req.param("id");
  const row = await writablePiece(c.get("user").username, libraryId, c.req.param("pid"));
  if (!row) return notFound(c);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const label = body?.label === undefined ? row.label : nameOf(body.label);
  if (!label) return c.json({ error: "A label is needed", code: "invalid" }, 400);
  let collectionId = row.collection_id;
  if (body?.collectionId !== undefined) {
    collectionId = typeof body.collectionId === "string" ? body.collectionId : null;
    if (collectionId && !rowIn(libraryId, collectionId)) return notFound(c);
  }
  db().prepare("UPDATE pieces SET label = ?, collection_id = ? WHERE id = ?").run(label, collectionId, row.id);
  return c.json(pieceOf({ ...row, label, collection_id: collectionId }));
});

// POST /api/library/:id/pieces/:pid/trash → the piece goes to the trash (GET …/pieces?trash=1 lists it); restore takes it back.
// Its versions stay in the library either way.
collectionApp.post("/:id/pieces/:pid/trash", (c) => setPieceTrashed(c, true));
collectionApp.post("/:id/pieces/:pid/restore", (c) => setPieceTrashed(c, false));

async function setPieceTrashed(c: Ctx, trash: boolean) {
  const libraryId = c.req.param("id") ?? "";
  const row = await writablePiece(c.get("user").username, libraryId, c.req.param("pid") ?? "");
  if (!row) return notFound(c);
  if (!trash && row.merged) return unmerge(c, row);
  db().prepare("UPDATE pieces SET trashed_at = ? WHERE id = ?").run(trash ? Date.now() : null, row.id);
  // its versions' playback copies go at once, unless still a Final in another piece (lib/play-copies.ts)
  if (trash) {
    const items = db().prepare("SELECT version_id FROM piece_items WHERE piece_id = ? AND version_id IS NOT NULL").all(row.id) as { version_id: string }[];
    void sweepPlayCopies(items.map((i) => `library/${i.version_id}/`)).catch(() => {});
  }
  return c.json(pieceOf({ ...row, trashed_at: trash ? Date.now() : null }));
}

// POST /api/library/:id/pieces/:pid/merge { from } → Piece: the piece `from` joins this one. Its items move over (this
// piece keeps its label, winner and cover) and `from` waits in the trash, out of its list, with where each item was, so
// unmerge can take it back; the trash purge removes it. A version both pieces hold refuses the merge (409), so no
// posting is lost in the move.
collectionApp.post("/:id/pieces/:pid/merge", async (c) => {
  const libraryId = c.req.param("id");
  const user = c.get("user").username;
  const target = await writablePiece(user, libraryId, c.req.param("pid"));
  const body = (await c.req.json().catch(() => null)) as { from?: unknown } | null;
  const fromId = typeof body?.from === "string" ? body.from : "";
  const from = fromId && fromId !== c.req.param("pid") ? await writablePiece(user, libraryId, fromId) : undefined;
  if (!target || !from) return notFound(c);
  const both = db()
    .prepare("SELECT 1 FROM piece_items a JOIN piece_items b ON b.version_id = a.version_id WHERE a.piece_id = ? AND b.piece_id = ? AND a.version_id IS NOT NULL")
    .get(from.id, target.id);
  if (both) return c.json({ error: "A version is in both pieces: remove it from one first", code: "conflict" }, 409);
  inTx(() => {
    const items = db().prepare("SELECT id, position, winner FROM piece_items WHERE piece_id = ?").all(from.id);
    const top = (db().prepare("SELECT COALESCE(MAX(position), 0) AS p FROM piece_items WHERE piece_id = ?").get(target.id) as { p: number }).p;
    db().prepare("UPDATE piece_items SET piece_id = ?, position = position + ?, winner = 0 WHERE piece_id = ?").run(target.id, top, from.id);
    db().prepare("UPDATE pieces SET trashed_at = ?, merged = ? WHERE id = ?").run(Date.now(), JSON.stringify({ into: target.id, items }), from.id);
  });
  return c.json(pieceOf(target));
});

type Merged = { into: string; items: { id: string; position: number; winner: number }[] };

// Restore of a merged piece (Undo, or the Finals trash): it comes out of the trash, and each of its items still in the
// piece it joined goes back with its old place and winner.
async function unmerge(c: Ctx, from: PieceRow) {
  const was = JSON.parse(from.merged!) as Merged;
  const target = await writablePiece(c.get("user").username, from.library_id, was.into);
  if (!target) return notFound(c);
  inTx(() => {
    const back = db().prepare("UPDATE piece_items SET piece_id = ?, position = ?, winner = ? WHERE id = ? AND piece_id = ?");
    for (const i of was.items) back.run(from.id, i.position, i.winner, i.id, target.id);
    db().prepare("UPDATE pieces SET trashed_at = NULL, merged = NULL WHERE id = ?").run(from.id);
  });
  return c.json(pieceOf({ ...from, trashed_at: null, merged: null }));
}

// POST /api/library/:id/pieces/:pid/items/:iid/split → 201 Piece: the item leaves for a piece of its own (named as the item,
// in the same collection). Its postings go with it; the piece it left keeps the rest.
collectionApp.post("/:id/pieces/:pid/items/:iid/split", async (c) => {
  const libraryId = c.req.param("id");
  const user = c.get("user").username;
  const piece = await writablePiece(user, libraryId, c.req.param("pid"));
  const item = piece ? itemIn(piece.id, c.req.param("iid")) : undefined;
  if (!piece || !item) return notFound(c);
  if (piece.cover_version_id && piece.cover_version_id === item.version_id) await dropCover(piece);
  const id = `pce_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  inTx(() => {
    db()
      .prepare("INSERT INTO pieces (id, library_id, collection_id, label, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, libraryId, piece.collection_id, item.label || piece.label, user, Date.now());
    db().prepare("UPDATE piece_items SET piece_id = ?, position = 1, winner = 0 WHERE id = ?").run(id, item.id);
  });
  return c.json(pieceOf(db().prepare("SELECT * FROM pieces WHERE id = ?").get(id) as unknown as PieceRow), 201);
});

// DELETE /api/library/:id/pieces/:pid → gone with its items and postings; the versions stay in the library
collectionApp.delete("/:id/pieces/:pid", async (c) => {
  const libraryId = c.req.param("id");
  const row = await writablePiece(c.get("user").username, libraryId, c.req.param("pid"));
  if (!row) return notFound(c);
  db().prepare("DELETE FROM pieces WHERE id = ?").run(row.id);
  if (row.cover_key) await blobs.delete(row.cover_key).catch(() => {});
  void sweepPlayCopies(["library/"]).catch(() => {}); // its versions' playback copies, unless still Finals in another piece
  return c.json({ ok: true });
});

// POST /api/library/:id/pieces/:pid/items { versionId, label? } → 201 Piece. Added last; the version must be live here.
collectionApp.post("/:id/pieces/:pid/items", async (c) => {
  const libraryId = c.req.param("id");
  const piece = await writablePiece(c.get("user").username, libraryId, c.req.param("pid"));
  if (!piece) return notFound(c);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const versionId = typeof body?.versionId === "string" ? body.versionId : "";
  const live = versionId
    ? (db()
        .prepare("SELECT a.id AS asset_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ? AND a.library_id = ? AND a.trashed_at IS NULL AND a.left_hidden_at IS NULL")
        .get(versionId, libraryId) as { asset_id: string } | undefined)
    : undefined;
  if (!live || !(await mayWrite(c.get("user").username, libraryId, live.asset_id, versionId))) return notFound(c);
  if (db().prepare("SELECT 1 FROM piece_items WHERE piece_id = ? AND version_id = ?").get(piece.id, versionId)) {
    return c.json({ error: "That version is already in this piece", code: "conflict" }, 409);
  }
  const last = (db().prepare("SELECT COALESCE(MAX(position), 0) AS p FROM piece_items WHERE piece_id = ?").get(piece.id) as { p: number }).p;
  db()
    .prepare("INSERT INTO piece_items (id, piece_id, version_id, label, position) VALUES (?, ?, ?, ?, ?)")
    .run(`pci_${randomUUID().replace(/-/g, "").slice(0, 16)}`, piece.id, versionId, itemLabel(body?.label), last + 1);
  if (isFinal(versionId)) void pushFinalCopy(versionId).catch(() => {});
  return c.json(pieceOf(piece), 201);
});

// PATCH /api/library/:id/pieces/:pid/items/:iid { label?, position?, winner?, postDescription? } → the piece.
// Setting winner clears the winner the piece had: one winner at most.
collectionApp.patch("/:id/pieces/:pid/items/:iid", async (c) => {
  const libraryId = c.req.param("id");
  const piece = await writablePiece(c.get("user").username, libraryId, c.req.param("pid"));
  const item = piece ? itemIn(piece.id, c.req.param("iid")) : undefined;
  if (!piece || !item) return notFound(c);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const label = body?.label === undefined ? item.label : itemLabel(body.label);
  const position = typeof body?.position === "number" && Number.isFinite(body.position) ? body.position : item.position;
  const winner = typeof body?.winner === "boolean" ? body.winner : item.winner === 1;
  const post =
    body?.postDescription === undefined
      ? item.post_description
      : typeof body.postDescription === "string" && body.postDescription.trim()
        ? body.postDescription.slice(0, POST_LIMIT)
        : null;
  inTx(() => {
    if (winner) db().prepare("UPDATE piece_items SET winner = 0 WHERE piece_id = ? AND winner = 1").run(piece.id);
    db()
      .prepare("UPDATE piece_items SET label = ?, position = ?, winner = ?, post_description = ? WHERE id = ?")
      .run(label, position, winner ? 1 : 0, post, item.id);
  });
  return c.json(pieceOf(piece));
});

// DELETE /api/library/:id/pieces/:pid/items/:iid → the piece; its postings go with it
collectionApp.delete("/:id/pieces/:pid/items/:iid", async (c) => {
  const libraryId = c.req.param("id");
  const piece = await writablePiece(c.get("user").username, libraryId, c.req.param("pid"));
  const item = piece ? itemIn(piece.id, c.req.param("iid")) : undefined;
  if (!piece || !item) return notFound(c);
  // the picked cover is a frame of this version: without the version, the cover goes back to automatic
  const next = piece.cover_version_id && piece.cover_version_id === item.version_id ? await dropCover(piece) : piece;
  db().prepare("DELETE FROM piece_items WHERE id = ?").run(item.id);
  if (item.version_id) void sweepPlayCopies([`library/${item.version_id}/`]).catch(() => {});
  return c.json(pieceOf(next));
});

// POST /api/library/:id/pieces/:pid/items/:iid/postings { platform, url? } → 201 Piece: one more place the item went
collectionApp.post("/:id/pieces/:pid/items/:iid/postings", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  const piece = await writablePiece(user.username, libraryId, c.req.param("pid"));
  const item = piece ? itemIn(piece.id, c.req.param("iid")) : undefined;
  if (!piece || !item) return notFound(c);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const platform = nameOf(body?.platform);
  if (!platform) return c.json({ error: "A platform is needed", code: "invalid" }, 400);
  const url = typeof body?.url === "string" && body.url.trim() ? body.url.trim().slice(0, 500) : null;
  if (url && !/^https?:\/\//.test(url)) return c.json({ error: "A posting link starts with http:// or https://", code: "invalid" }, 400);
  db()
    .prepare("INSERT INTO postings (piece_item_id, platform, url, posted_at, created_by) VALUES (?, ?, ?, ?, ?)")
    .run(item.id, platform, url, Date.now(), user.username);
  return c.json(pieceOf(piece), 201);
});

// DELETE /api/library/:id/pieces/:pid/items/:iid/postings/:n → the piece; takes out one posting by its id
collectionApp.delete("/:id/pieces/:pid/items/:iid/postings/:n", async (c) => {
  const libraryId = c.req.param("id");
  const piece = await writablePiece(c.get("user").username, libraryId, c.req.param("pid"));
  const item = piece ? itemIn(piece.id, c.req.param("iid")) : undefined;
  if (!piece || !item) return notFound(c);
  db().prepare("DELETE FROM postings WHERE piece_item_id = ? AND id = ?").run(item.id, Number(c.req.param("n")));
  return c.json(pieceOf(piece));
});

// GET /api/library/:id/pieces/:pid → one piece with the items the viewer may see, and `writable` (every item is theirs to
// change). A piece with items, none of them visible, is 404, as it is in the list.
collectionApp.get("/:id/pieces/:pid", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  const viewer = await readerOf(user.username, libraryId);
  const row = viewer ? pieceIn(libraryId, c.req.param("pid")) : undefined;
  if (!viewer || !row) return notFound(c);
  const all = pieceOf(row);
  const seen = await visibleItems(viewer, libraryId, all);
  if (!seen.items.length && all.items.length) return notFound(c);
  const waits = frameWaits(`cover:${row.id}`);
  return c.json({ ...seen, writable: !!(await writablePiece(user.username, libraryId, row.id)), ...(waits ? { coverWaits: waits } : {}) });
});

const EXT_OF: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "video/x-matroska": ".mkv",
  "video/x-msvideo": ".avi",
  "audio/mp4": ".m4a",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/ogg": ".ogg",
  "audio/flac": ".flac",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

// GET /api/library/:id/pieces/:pid/zip → the versions the viewer may see, in drag order, as one ZIP of their source files
// (Save all). Visibility is the piece read's: a version the viewer may not see is left out, and a piece none of whose
// versions they may see is 404. Stored, not compressed, like the Workshop's ZIP.
collectionApp.get("/:id/pieces/:pid/zip", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  const viewer = await readerOf(user.username, libraryId);
  const row = viewer ? pieceIn(libraryId, c.req.param("pid")) : undefined;
  if (!viewer || !row) return notFound(c);
  const all = pieceOf(row);
  const seen = await visibleItems(viewer, libraryId, all);
  if (!seen.items.length && all.items.length) return notFound(c);
  try {
    const files: { path: string; name: string }[] = [];
    let refused: Received | undefined;
    for (const [n, item] of seen.items.entries()) {
      if (!item.versionId) continue; // an external ref has no file in this library
      const v = db()
        .prepare("SELECT v.source_key, v.source_path, v.mime, a.title, a.library_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?")
        .get(item.versionId) as { source_key: string; source_path: string | null; mime: string | null; title: string; library_id: string } | undefined;
      if (!v) continue;
      // under Upload none the server gives no original (decision 6): the zip carries the others and names the refusal
      const gate = await mayServe({ id: v.library_id, versionId: item.versionId }, "original");
      if (!gate.ok) {
        refused ??= gate;
        continue;
      }
      const base = (item.label || v.title).replace(/[^\w.-]+/g, "_").slice(0, 80) || "version";
      const ext = path.extname(v.source_path ?? "") || EXT_OF[v.mime ?? ""] || "";
      files.push({ path: await blobs.localCopy(v.source_key), name: `${String(n + 1).padStart(2, "0")}-${base}${ext}` });
    }
    if (refused && !refused.ok) return c.json(refused.body, refused.status);
    if (!files.length) return c.json({ error: "No versions to save", code: "conflict" }, 409);
    const zip = await storedZip(files);
    const name = `${row.label.replace(/[^\w.-]+/g, "_").slice(0, 80) || "finals"}.zip`;
    return new Response(Readable.toWeb(zip.body) as never, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(zip.size),
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e), code: "conflict" }, 409);
  }
});

// POST /api/library/:id/pieces/:pid/cover { versionId, t? } → the piece. The frame at t seconds of one of its versions (a
// still is its own picture) becomes the cover on the Finals list, in place of the automatic one.
collectionApp.post("/:id/pieces/:pid/cover", async (c) => {
  const libraryId = c.req.param("id");
  const piece = await writablePiece(c.get("user").username, libraryId, c.req.param("pid"));
  if (!piece) return notFound(c);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const versionId = typeof body?.versionId === "string" ? body.versionId : "";
  const t = body?.t === undefined ? 0 : body.t;
  if (typeof t !== "number" || !Number.isFinite(t) || t < 0) return c.json({ error: "A frame time is needed", code: "invalid" }, 400);
  // the version must be an item of this piece, live in the library; the proxy (playable) when there is one
  const v = db()
    .prepare(
      `SELECT v.source_key, v.mac_path, v.mac_device, a.kind, d.storage_key AS proxy FROM piece_items i
         JOIN asset_versions v ON v.id = i.version_id
         JOIN assets a ON a.id = v.asset_id
         LEFT JOIN derivatives d ON d.version_id = v.id AND d.kind = 'proxy'
       WHERE i.piece_id = ? AND i.version_id = ? AND a.trashed_at IS NULL AND a.left_hidden_at IS NULL`,
    )
    .get(piece.id, versionId) as { source_key: string; mac_path: string | null; mac_device: string | null; kind: AssetKind; proxy: string | null } | undefined;
  if (!v) return notFound(c);
  // Blur faces: a cover is a picture of the clip, kept and shown on the Finals list and its links
  const left = mayLeave(libraryId, { versionId });
  if (!left.ok) return c.json(left.body, left.status);
  const dir = path.join(process.env.LIBRARY_SCRATCH_DIR || path.join(env.dataDir, "library", "scratch"));
  await mkdir(dir, { recursive: true });
  const out = path.join(dir, `cover-${randomUUID()}.jpg`);
  // the server's copy when it has one; else the computer that holds the original makes the frame
  const src = await blobs.localCopy(v.proxy ?? v.source_key).catch(() => undefined);
  const mac = !v.proxy && v.mac_path ? { paths: { src: v.mac_path }, device: v.mac_device ?? undefined } : {};
  try {
    const got = await frameAt(`cover:${piece.id}`, c.get("user").username, (await workspaceIdOf(db(), versionId)) ?? null, {
      files: { src }, ...mac, atMs: t * 1000, still: v.kind !== "video", vf: "scale=480:-2", q: 4, to: out, then: "finals-cover", data: { piece: piece.id, versionId },
    });
    // it waits for a computer: the cover is set when the frame comes (whenFramed below)
    if ("wait" in got) return c.json({ ...pieceOf(piece), coverWaits: got.wait }, 202);
  } catch {
    await rm(out, { force: true });
    return c.json({ error: "There is no picture at that time", code: "invalid" }, 400);
  }
  const now = await writablePiece(c.get("user").username, libraryId, piece.id);
  return now ? c.json(pieceOf(now)) : notFound(c);
});

/** The picked frame, wherever it was made: stored as the piece's cover, the one before it removed. */
whenFramed("finals-cover", async (input: FrameInput) => {
  const { piece: id, versionId } = input.data as { piece: string; versionId: string };
  try {
    const piece = db().prepare("SELECT * FROM pieces WHERE id = ?").get(id) as PieceRow | undefined;
    if (!piece) return;
    const stamp = Date.now();
    const key = `libraries/${piece.library_id}/pieces/${piece.id}/cover-${stamp}.jpg`;
    await blobs.put(key, input.to, { contentType: "image/jpeg" });
    db().prepare("UPDATE pieces SET cover_key = ?, cover_version_id = ?, cover_at = ? WHERE id = ?").run(key, versionId, stamp, piece.id);
    if (piece.cover_key) await blobs.delete(piece.cover_key).catch(() => {});
  } finally {
    await rm(input.to, { force: true });
  }
});

// DELETE /api/library/:id/pieces/:pid/cover → the piece, back to the automatic cover
collectionApp.delete("/:id/pieces/:pid/cover", async (c) => {
  const piece = await writablePiece(c.get("user").username, c.req.param("id"), c.req.param("pid"));
  if (!piece) return notFound(c);
  return c.json(pieceOf(await dropCover(piece)));
});

// GET /api/library/:id/pieces/:pid/cover → the picked frame. It is footage, so the version it came from decides who sees it
// (a trashed version has no cover); the stamp in the URL makes a new pick a new address.
collectionApp.get("/:id/pieces/:pid/cover", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  const viewer = await readerOf(user.username, libraryId);
  const row = viewer ? pieceIn(libraryId, c.req.param("pid")) : undefined;
  if (!viewer || !row?.cover_key || !row.cover_version_id) return notFound(c);
  const v = db()
    .prepare("SELECT a.id AS asset_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ? AND a.trashed_at IS NULL AND a.left_hidden_at IS NULL")
    .get(row.cover_version_id) as { asset_id: string } | undefined;
  if (!v || !(await canSee(viewer, assetRef(libraryId, v.asset_id, row.cover_version_id)))) return notFound(c);
  // Blur faces: a cover cut from a clip not blurred (picked before it was on) stays stored and is not shown
  const left = mayLeave(libraryId, { versionId: row.cover_version_id });
  if (!left.ok) return c.json(left.body, left.status);
  try {
    const at = await blobs.locate(row.cover_key, 900, { contentType: "image/jpeg" });
    return at.kind === "url" ? c.redirect(at.url, 302) : await sendFile(c, at.path, "image/jpeg");
  } catch {
    return c.json({ error: "Not ready", code: "conflict" }, 409);
  }
});
